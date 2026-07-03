// Types, error taxonomy, policy table, and small pure helpers shared across
// the conversation-message send aggregate (`ConversationMessageService`) and
// its collaborators (`ThreadFollowManager`, `MessageDeliveryCoordinator`).
//
// This module holds only declarations — no behavior, no `this`. The facade
// re-exports the previously-public names (error classes + input/result types)
// so external importers keep importing from `conversation-message-service.js`.
import type { Database as Db } from 'better-sqlite3';
import type {
  AgentRunTerminalReason,
  AgentSendStaleResolutionReason,
  ConversationDto,
  LegacySendMessageTarget,
  MessageDto,
  MessageProjections,
  SendMessageTarget,
} from '@silverhand/shared';
import type { BackendLogger } from '../../context.js';
import type { AgentRuntimeHost } from '../../runtime/agent-runtime-host.js';
import type { AgentRepo } from '../../repos/agent-repo.js';
import type { ConversationRepo } from '../../repos/conversation-repo.js';
import type { ConversationInboxRepo } from '../../repos/conversation-inbox-repo.js';
import type { MessageRepo } from '../../repos/message-repo.js';
import type { NotificationRepo } from '../../repos/notification-repo.js';
import type { ThreadFollowerRepo } from '../../repos/thread-follower-repo.js';
import type { UserRepo } from '../../repos/user-repo.js';
import type { WorkspaceRepo } from '../../repos/workspace-repo.js';
import type { AttachmentService } from '../attachment-service.js';
import type { ScopeEventBus } from '../../ws/scope-event-bus.js';
import type {
  AgentPrincipal,
  UserPrincipal,
} from '../../auth/principal.js';

export type SendMessageActor =
  | UserPrincipal
  | AgentPrincipal;

export interface SendMessageInput {
  conversationId: string;
  actor: SendMessageActor;
  content: string;
  attachmentIds?: string[];
  /** Public send destination. Omitted means the current channel main line. */
  target?: SendMessageTarget;
  /** @deprecated Compatibility alias for old agent/runtime callers. New
   *  callers must pass `target: { kind: 'thread', message_id }`. */
  legacyReplyToMessageId?: string;
  /** Daemon's assertion of which per-stream boundary `seenUpToSeq` was
   *  read against (`'main'` or `thread:<rootMessageId>`). When present it
   *  is cross-checked against the stream the backend resolves from `target`;
   *  a mismatch hard-rejects (§6.4). */
  assertedStreamKey?: string;
  seenUpToSeq?: number;
  staleEventId?: string;
  staleResolutionReason?: AgentSendStaleResolutionReason;
  freshnessBypass?: boolean;
  /** Human composer `Send as task`: atomically promote this message into
   *  an open todo task in the send transaction (one canonical row that is
   *  both message and task anchor). Only the human send route plumbs this;
   *  the agent route has its own schema and uses `create_tasks` instead. */
  asTask?: boolean;
}

export interface SendMessageResult {
  message: MessageDto;
  targetConversationId: string;
}

export type NormalizedMessageTarget =
  | { kind: 'channel' }
  | { kind: 'thread'; messageId: string }
  | { kind: 'legacy'; target: LegacySendMessageTarget };

export interface ResolveStaleMessageInput {
  conversationId: string;
  actor: AgentPrincipal;
  staleEventId: string;
  resolutionReason: 'obsolete';
}

export interface SendMessagePolicy {
  requireSenderMembership: boolean;
  allowTarget: boolean;
  distributeExcludeSender: boolean;
  /**
   * Default auto-start behavior for the actor. The runtime decision in
   * `sendMessage` overrides this for agent cross-target sends — see the
   * `shouldAutoStartIdle` derivation. Agents sending to their own
   * conversation (`target = self`) keep this `false` so in-channel
   * back-and-forth does not ping-pong every idle member; agents sending
   * across conversations (`target = parent` or `target = <thread_id>`)
   * always auto-start the target's idle members so the receiving session
   * can take over the work.
   */
  autoStartIdleRecipients: boolean;
  ccMentions: boolean;
  resolveRun: boolean;
}

export const POLICIES: Record<SendMessageActor['kind'], SendMessagePolicy> = {
  user: {
    requireSenderMembership: false,
    allowTarget: false,
    distributeExcludeSender: false,
    autoStartIdleRecipients: true,
    ccMentions: true,
    resolveRun: false,
  },
  agent: {
    requireSenderMembership: true,
    allowTarget: true,
    distributeExcludeSender: true,
    // Same-target (self) baseline: no auto-start. Cross-target sends are
    // promoted to auto-start at runtime in `sendMessage`.
    autoStartIdleRecipients: false,
    ccMentions: false,
    resolveRun: true,
  },
};

export type ConversationErrorCode =
  | 'conversation_not_found'
  | 'conversation_closed'
  | 'conversation_archived';

export class ConversationError extends Error {
  constructor(
    public readonly code: ConversationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ConversationError';
  }
}

export type ActorErrorCode =
  | 'agent_not_found'
  | 'agent_not_member_of_conversation';

export class ActorError extends Error {
  constructor(
    public readonly code: ActorErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ActorError';
  }
}

export type TargetErrorCode =
  | 'no_parent'
  | 'thread_not_found'
  | 'thread_not_child'
  | 'legacy_thread_target_deprecated'
  | 'target_closed'
  | 'target_archived'
  | 'target_conflict'
  | 'reply_target_not_found'
  | 'stream_key_mismatch'
  | 'legacy_thread_read_only';

export class TargetError extends Error {
  constructor(
    public readonly code: TargetErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TargetError';
  }
}

export type PolicyErrorCode = 'target_not_allowed_for_user';

export class PolicyError extends Error {
  constructor(
    public readonly code: PolicyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PolicyError';
  }
}

export type AttachmentErrorCode =
  | 'attachment_owner_unresolved'
  | 'attachment_outside_channel';

export class AttachmentError extends Error {
  constructor(
    public readonly code: AttachmentErrorCode,
    message: string,
    public readonly attachmentId?: string,
  ) {
    super(message);
    this.name = 'AttachmentError';
  }
}

export class MessageFreshnessError extends Error {
  readonly code = 'message_stale' as const;

  constructor(
    public readonly conversationId: string,
    public readonly seenUpToSeq: number,
    public readonly currentSeq: number,
    public readonly newerMessages: MessageDto[],
    public readonly staleEventId: string,
    /** Target stream the CAS was scoped to (NULL = main line). The
     *  `newerMessages` list is drawn from this stream only. */
    public readonly threadRootId: string | null = null,
  ) {
    super(
      `message is stale: conversation advanced from seq ${seenUpToSeq} ` +
        `to ${currentSeq} before send`,
    );
    this.name = 'MessageFreshnessError';
  }
}

export class MessageFreshnessGuardError extends Error {
  constructor(
    public readonly conversationId: string,
    public readonly seenUpToSeq: number,
    public readonly currentSeq: number,
    public readonly threadRootId: string | null,
  ) {
    super(
      `message is stale: conversation advanced from seq ${seenUpToSeq} ` +
        `to ${currentSeq} before send`,
    );
    this.name = 'MessageFreshnessGuardError';
  }
}

export interface ConversationMessageServiceOptions {
  db: Db;
  conversations: ConversationRepo;
  conversationInboxes: ConversationInboxRepo;
  messages: MessageRepo;
  threadFollowers: ThreadFollowerRepo;
  agents: AgentRepo;
  users: UserRepo;
  notifications: NotificationRepo;
  workspaces: WorkspaceRepo;
  attachmentService: AttachmentService;
  runtimeHost: AgentRuntimeHost;
  events: ScopeEventBus;
  logger: BackendLogger;
  /** Task-context collaborator for `Send as task`. Narrow role interface
   *  (not the whole TaskService) so this service depends on the open-task
   *  creation capability, not the task bounded context's internals. */
  sendAsTaskWriter: SendAsTaskWriter;
}

/**
 * The slice of the task context the send path needs for `Send as task`.
 * `createOpenTaskFromMessageInTxn` runs inside the send transaction (DB
 * write, no own transaction); `announceOpenTaskCreated` is the post-commit
 * event publish. TaskService satisfies this structurally.
 */
export interface SendAsTaskWriter {
  createOpenTaskFromMessageInTxn(args: {
    messageId: string;
    taskWorkspaceId: string;
  }): { taskNumber: number; title: string };
  announceOpenTaskCreated(args: {
    conversation: ConversationDto;
    messageId: string;
    taskNumber: number;
    title: string;
  }): void;
}

/**
 * Per-recipient plan for delivering a thread reply (§6 reply-cluster).
 * Current thread messages align with main-line channel delivery: follower
 * agents that are visible in the channel receive a `turn`, excluding the
 * sender. `observe` is reserved for non-waking context paths such as
 * backfill/pull history.
 */
export type ThreadDeliveryKind = 'turn' | 'observe';

export interface ThreadDeliveryRecipient {
  agentId: string;
  kind: ThreadDeliveryKind;
}

export interface ThreadDeliveryPlan {
  threadRootId: string;
  /** Follower agents that are current channel members, EXCLUDING the
   *  reply sender. Computed inside the send transaction after auto-follow
   *  upserts so newly-followed agents are included. */
  recipients: ThreadDeliveryRecipient[];
}

export interface SendMessageTxResult {
  sourceConversation: NonNullable<ReturnType<ConversationRepo['get']>>;
  targetConversation: NonNullable<ReturnType<ConversationRepo['get']>>;
  message: MessageDto;
  recipients: ReturnType<ConversationRepo['listAgents']>;
  /** Non-null when this send is a thread reply: drives follower-gated
   *  delivery instead of the main-line channel-member fan-out. */
  threadDelivery: ThreadDeliveryPlan | null;
  skippedFreshnessReason: string | null;
  /** Non-null when `asTask` promoted this send into an open todo task;
   *  drives the post-commit `task_changed` announcement. */
  taskInfo: { taskNumber: number; title: string } | null;
  /** S1 (#task:1276) authoritative projection deltas computed IN this
   *  transaction, attached to the post-commit `message` event. Null when the
   *  send touches no derived projection (a main-line, non-reply message). */
  projections: MessageProjections | null;
}

export const REPLIED: AgentRunTerminalReason = 'replied';
export const MENTION_EXCERPT_LIMIT = 160;
export const START_FAILURE_ERROR_LIMIT = 240;
export const STALE_MESSAGE_LIMIT = 10;

export function excerpt(s: string): string {
  const compact = s.replace(/\s+/g, ' ').trim();
  return compact.length <= MENTION_EXCERPT_LIMIT
    ? compact
    : `${compact.slice(0, MENTION_EXCERPT_LIMIT - 1)}…`;
}

export function nonEmptyName(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function describeStartFailure(err: unknown): string {
  const message =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : 'unknown error';
  const compact = message.replace(/\s+/g, ' ').trim() || 'unknown error';
  return compact.length <= START_FAILURE_ERROR_LIMIT
    ? compact
    : `${compact.slice(0, START_FAILURE_ERROR_LIMIT - 1)}…`;
}

export function resolveOwnerChannelId(conversation: {
  id: string;
  kind: string;
  parent_conversation_id: string | null;
}): string | null {
  if (conversation.kind === 'channel' || conversation.kind === 'dm_channel') {
    return conversation.id;
  }
  if (conversation.kind === 'thread') {
    return conversation.parent_conversation_id ?? null;
  }
  return null;
}
