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
  AttachmentRefInput,
  LegacySendMessageTarget,
  MessageDto,
  MessageEventPayload,
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
  /** Attachment references (id + optional compose-time label), already
   *  normalized from the wire union at the route boundary. */
  attachmentRefs?: AttachmentRefInput[];
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
}

export interface SendMessageResult {
  /** The committed-message payload — the persisted message plus the
   *  viewer-invariant absolute projections computed IN the send transaction.
   *  STRUCTURALLY IDENTICAL to the post-commit `message` WS frame
   *  ({@link MessageEventPayload}): the human send route echoes it verbatim so
   *  the HTTP ACK and the WS echo converge through the renderer's single
   *  committed-message apply seam, independent of WS echo timing (#task:1749).
   *  The service builds this object ONCE and reuses it for both the WS publish
   *  and this return — there is no second, projection-less payload shape. */
  committed: MessageEventPayload;
  targetConversationId: string;
  /** Stream head at the moment BEFORE this message was inserted. Set for an
   *  agent send whose insert SKIPPED the freshness CAS — an explicit
   *  `freshnessBypass`, or a loose first touch that carried no
   *  `seenUpToSeq` — because in both cases nothing proved the sender covers
   *  the stream, so the daemon needs a merge prerequisite for its own seq:
   *  once its observed cursor covers everything below this message, the own
   *  seq joins the watermark. Without it, such a send in a quiet stream
   *  leaves the sender permanently stale on its own head (countgame P1,
   *  #task:1854). Absent for a passing CAS (the sender already covers the
   *  stream) and for a cross-conversation send (the sender keeps no cursor
   *  for the target's stream). Carried uniformly for main-line AND
   *  thread-reply sends. */
  streamHeadBeforeSend?: number;
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
   * across conversations (`target = thread:<message_id>`) always
   * auto-start the target's idle members so the receiving session
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
  | 'target_closed'
  | 'target_archived'
  | 'target_conflict'
  | 'reply_target_not_found'
  | 'stream_key_mismatch';

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
  | 'attachment_outside_channel'
  | 'attachment_label_kind_mismatch';

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
    public readonly staleEventId: string,
    /** Target stream the CAS was scoped to (NULL = main line). */
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
  /** S1 (#task:1276) authoritative projection deltas computed IN this
   *  transaction, attached to the post-commit `message` event. Null when the
   *  send touches no derived projection (a main-line, non-reply message). */
  projections: MessageProjections | null;
  streamHeadBeforeSend: number | null;
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
