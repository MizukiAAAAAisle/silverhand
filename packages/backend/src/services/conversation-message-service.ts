import type { Database as Db } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type {
  AgentRunTerminalReason,
  AgentSendStaleResolutionReason,
  ConversationDto,
  LegacySendMessageTarget,
  MessageSendTarget,
  MessageDto,
  SendMessageTarget,
} from '@silverhand/shared';
import { extractMentions } from '@silverhand/shared';
import type { BackendLogger } from '../context.js';
import type { AgentRuntimeHost } from '../runtime/agent-runtime-host.js';
import { ccMentionsFromUserMessage } from '../mention-cc.js';
import type { AgentRepo } from '../repos/agent-repo.js';
import type { ConversationRepo } from '../repos/conversation-repo.js';
import type { ConversationInboxRepo } from '../repos/conversation-inbox-repo.js';
import type { MessageRepo } from '../repos/message-repo.js';
import type { NotificationRepo } from '../repos/notification-repo.js';
import type {
  ThreadFollowerRepo,
  ThreadFollowerSource,
} from '../repos/thread-follower-repo.js';
import type { UserRepo } from '../repos/user-repo.js';
import type { WorkspaceRepo } from '../repos/workspace-repo.js';
import type { AttachmentService } from './attachment-service.js';
import type { ScopeEventBus } from '../ws/scope-event-bus.js';
import {
  conversationViewerUserIds,
  publishUnreadUpdatedToConversationViewers,
} from '../viewer-scope.js';
import {
  assertActorConversationMatch,
  type AgentPrincipal,
  type UserPrincipal,
} from '../auth/principal.js';

/**
 * ConversationMessageService is the single owner of send-message business
 * side effects. Routes translate auth and input shapes, then call this
 * service; they must not replicate attachment validation, message insert,
 * realtime publish, unread invalidation, thread refresh, run resolution,
 * mention CC, agent delivery, or auto-start behavior.
 *
 * Contract:
 * - User callers cannot target parent/child conversations; reject before
 *   target resolution so the service is not a target-existence oracle.
 * - Agent callers must be members of their source conversation.
 * - Attachment snapshots are validated against the effective target
 *   conversation's owner channel.
 * - Attachment validation plus seq allocation plus message insert happen in
 *   one DB transaction.
 * - Message/unread/thread events and agent run resolution happen after commit
 *   and before any best-effort delivery/start work.
 */

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

type NormalizedMessageTarget =
  | { kind: 'channel' }
  | { kind: 'thread'; messageId: string }
  | { kind: 'legacy'; target: LegacySendMessageTarget };

export interface ResolveStaleMessageInput {
  conversationId: string;
  actor: AgentPrincipal;
  staleEventId: string;
  resolutionReason: 'obsolete';
}

interface SendMessagePolicy {
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

const POLICIES: Record<SendMessageActor['kind'], SendMessagePolicy> = {
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

class MessageFreshnessGuardError extends Error {
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
type ThreadDeliveryKind = 'turn' | 'observe';

interface ThreadDeliveryRecipient {
  agentId: string;
  kind: ThreadDeliveryKind;
}

interface ThreadDeliveryPlan {
  threadRootId: string;
  /** Follower agents that are current channel members, EXCLUDING the
   *  reply sender. Computed inside the send transaction after auto-follow
   *  upserts so newly-followed agents are included. */
  recipients: ThreadDeliveryRecipient[];
}

interface SendMessageTxResult {
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
}

const REPLIED: AgentRunTerminalReason = 'replied';
const MENTION_EXCERPT_LIMIT = 160;
const START_FAILURE_ERROR_LIMIT = 240;
const STALE_MESSAGE_LIMIT = 10;

function excerpt(s: string): string {
  const compact = s.replace(/\s+/g, ' ').trim();
  return compact.length <= MENTION_EXCERPT_LIMIT
    ? compact
    : `${compact.slice(0, MENTION_EXCERPT_LIMIT - 1)}…`;
}

function nonEmptyName(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function describeStartFailure(err: unknown): string {
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

export class ConversationMessageService {
  private readonly db: Db;
  private readonly conversations: ConversationRepo;
  private readonly conversationInboxes: ConversationInboxRepo;
  private readonly messages: MessageRepo;
  private readonly threadFollowers: ThreadFollowerRepo;
  private readonly agents: AgentRepo;
  private readonly users: UserRepo;
  private readonly notifications: NotificationRepo;
  private readonly workspaces: WorkspaceRepo;
  private readonly attachmentService: AttachmentService;
  private readonly runtimeHost: AgentRuntimeHost;
  private readonly events: ScopeEventBus;
  private readonly logger: BackendLogger;
  private readonly sendAsTaskWriter: SendAsTaskWriter;

  constructor(opts: ConversationMessageServiceOptions) {
    this.db = opts.db;
    this.conversations = opts.conversations;
    this.conversationInboxes = opts.conversationInboxes;
    this.messages = opts.messages;
    this.threadFollowers = opts.threadFollowers;
    this.agents = opts.agents;
    this.users = opts.users;
    this.notifications = opts.notifications;
    this.workspaces = opts.workspaces;
    this.attachmentService = opts.attachmentService;
    this.runtimeHost = opts.runtimeHost;
    this.events = opts.events;
    this.logger = opts.logger;
    this.sendAsTaskWriter = opts.sendAsTaskWriter;
  }

  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    assertActorConversationMatch(input.actor, input.conversationId);
    const policy = POLICIES[input.actor.kind];
    const target = this.normalizeMessageTarget(input);
    if (!policy.allowTarget && target.kind === 'legacy') {
      throw new PolicyError(
        'target_not_allowed_for_user',
        'user messages cannot target another conversation',
      );
    }

    let txResult: SendMessageTxResult;
    try {
      txResult = this.db.transaction((): SendMessageTxResult => {
        const sourceConversation = this.conversations.get(input.conversationId);
        if (!sourceConversation) {
          throw new ConversationError(
            'conversation_not_found',
            'conversation not found',
          );
        }
        if (sourceConversation.closed_at !== null) {
          throw new ConversationError(
            'conversation_closed',
            'conversation is closed',
          );
        }
        if (sourceConversation.archived_at !== null) {
          throw new ConversationError(
            'conversation_archived',
            'conversation is archived',
          );
        }
        if (sourceConversation.kind === 'thread') {
          throw new TargetError(
            'legacy_thread_read_only',
            'legacy isolated threads are read-only; use message send --reply-to for reply clusters or a channel for isolated work',
          );
        }
        this.validateActor(input.actor, policy, sourceConversation.id);

        const targetConversation = target.kind === 'legacy'
          ? this.resolveLegacyTarget(sourceConversation, target.target)
          : sourceConversation;
        if (targetConversation.kind === 'thread') {
          throw new TargetError(
            'legacy_thread_read_only',
            'legacy isolated threads are read-only; use message send --target thread:<message_id> for reply clusters or a channel for isolated work',
          );
        }
        const threadRootId = this.resolveThreadRootForTarget(
          targetConversation.id,
          target,
        );
        this.assertStreamKeyConsistent(input, threadRootId);
        const attachmentIds = input.attachmentIds ?? [];
        const snapshots = this.resolveAttachmentSnapshots(targetConversation, attachmentIds);
        const { message, skippedFreshnessReason } =
          this.insertMessageWithFreshnessIfApplicable({
            input,
            sourceConversationId: sourceConversation.id,
            targetConversationId: targetConversation.id,
            threadRootId,
            snapshots,
          });
        // `Send as task`: promote the just-inserted row into an open todo
        // task in THIS transaction so message + task anchor are atomic.
        // We patch the returned DTO's task fields so the send response and
        // distribution render the task pill immediately (the row IS the
        // task — no separate task-created system message). The board picks
        // it up via the post-commit `task_changed` event.
        let taskInfo: { taskNumber: number; title: string } | null = null;
        if (input.asTask) {
          taskInfo = this.sendAsTaskWriter.createOpenTaskFromMessageInTxn({
            messageId: message.id,
            taskWorkspaceId: targetConversation.workspace_id,
          });
          message.task_number = taskInfo.taskNumber;
          message.task_status = 'todo';
          message.task_title = taskInfo.title;
          message.task_workspace_id = targetConversation.workspace_id;
          message.task_assignee = null;
          message.task_closed_at = null;
        }
        // Reply-cluster durable semantics (§6): when this send is a thread
        // reply, register auto-followers and backfill prior thread history
        // into newly-followed agents' inboxes — all inside this transaction
        // so we never leave a "followed but not caught up" state (Cindy
        // ruling). Returns the follower-gated delivery plan for the current
        // reply, executed best-effort after commit.
        const threadDelivery =
          threadRootId !== null
            ? this.applyThreadFollowEffects({
                conversationId: targetConversation.id,
                threadRootId,
                message,
                actor: input.actor,
              })
            : null;
        return {
          sourceConversation,
          targetConversation,
          message,
          taskInfo,
          // Main-line recipients only; thread replies deliver via
          // `threadDelivery` (follower-gated), not the channel-wide fan-out.
          recipients:
            threadDelivery === null
              ? this.conversations.listAgents(targetConversation.id)
              : [],
          threadDelivery,
          skippedFreshnessReason,
        };
      })();
    } catch (err) {
      if (err instanceof MessageFreshnessGuardError) {
        const staleEventId = randomUUID();
        const newerMessages = this.messages.listAfterSeqInStream(
          err.conversationId,
          err.threadRootId,
          err.seenUpToSeq,
          STALE_MESSAGE_LIMIT,
        );
        this.logger.warn(
          {
            staleEventId,
            conversationId: err.conversationId,
            actorKind: input.actor.kind,
            actorId: input.actor.kind === 'agent' ? input.actor.agentId : input.actor.userId,
            seenUpToSeq: err.seenUpToSeq,
            currentSeq: err.currentSeq,
            newerMessageCount: newerMessages.length,
            priorStaleEventId: input.staleEventId ?? null,
            priorStaleResolutionReason: input.staleResolutionReason ?? null,
          },
          'conversation-message-service: freshness CAS rejected',
        );
        throw new MessageFreshnessError(
          err.conversationId,
          err.seenUpToSeq,
          err.currentSeq,
          newerMessages,
          staleEventId,
          err.threadRootId,
        );
      }
      throw err;
    }

    if (txResult.skippedFreshnessReason) {
      this.logger.warn(
        {
          sourceConversationId: txResult.sourceConversation.id,
          targetConversationId: txResult.targetConversation.id,
          actorKind: input.actor.kind,
          actorId: input.actor.kind === 'agent' ? input.actor.agentId : input.actor.userId,
          reason: txResult.skippedFreshnessReason,
        },
        'conversation-message-service: freshness CAS skipped',
      );
    }

    // `Send as task` post-commit: surface the new open task on the board /
    // caches via `task_changed`. No system message — the canonical message
    // row is the announcement; the board is its projection.
    if (txResult.taskInfo) {
      this.sendAsTaskWriter.announceOpenTaskCreated({
        conversation: txResult.targetConversation,
        messageId: txResult.message.id,
        taskNumber: txResult.taskInfo.taskNumber,
        title: txResult.taskInfo.title,
      });
    }

    if (input.actor.kind === 'agent' && input.staleEventId) {
      this.logStaleResolution({
        sourceConversationId: txResult.sourceConversation.id,
        targetConversationId: txResult.targetConversation.id,
        agentId: input.actor.agentId,
        staleEventId: input.staleEventId,
        resolutionReason:
          input.staleResolutionReason
          ?? (input.freshnessBypass ? 'force_send' : 'unattributed'),
        outcome: 'message_sent',
        messageId: txResult.message.id,
        messageSeq: txResult.message.seq,
      });
    }

    this.logger.info(
      {
        sourceConversationId: txResult.sourceConversation.id,
        targetConversationId: txResult.targetConversation.id,
        messageId: txResult.message.id,
        actorKind: input.actor.kind,
        actorId: input.actor.kind === 'agent' ? input.actor.agentId : input.actor.userId,
        target,
        contentBytes: input.content.length,
        recipientCount:
          txResult.threadDelivery?.recipients.length
          ?? txResult.recipients.length,
        threadReply: txResult.threadDelivery !== null,
      },
      'conversation-message-service: message inserted',
    );

    this.events.publish(txResult.targetConversation.id, {
      kind: 'message',
      payload: { message: txResult.message },
    });
    this.publishUnreadUpdated(txResult.targetConversation.id);
    this.notifyViewerMentionBestEffort(
      txResult.targetConversation,
      txResult.message,
    );

    if (txResult.targetConversation.parent_conversation_id) {
      this.events.publish(txResult.targetConversation.parent_conversation_id, {
        kind: 'thread_updated',
        payload: {
          parent_conversation_id: txResult.targetConversation.parent_conversation_id,
          thread_id: txResult.targetConversation.id,
        },
      });
    }

    if (policy.resolveRun && input.actor.kind === 'agent') {
      this.runtimeHost.resolveRun(
        txResult.sourceConversation.id,
        input.actor.agentId,
        REPLIED,
      );
    }

    // Cross-target identity flag — controls both delivery sender-exclusion
    // and idle auto-start policies below. Computed once.
    const targetIsCrossConversation =
      txResult.targetConversation.id !== txResult.sourceConversation.id;

    // Delivery sender-exclusion only fires for same-conversation send.
    // Cross-conversation send is a hand-off between *different*
    // (conversation, agent) processes: when Cindy@channel sends to a
    // thread where a separate Cindy@thread session exists, the thread
    // session is the actual recipient and must receive the message in
    // its inbox. Excluding by agent id would deliver to nobody and the
    // started session would wake without a message to process — exactly
    // the bug @Cindy caught on `f28ed08` review.
    const deliveryExcludeAgentId =
      policy.distributeExcludeSender
      && input.actor.kind === 'agent'
      && !targetIsCrossConversation
        ? input.actor.agentId
        : null;
    if (policy.ccMentions) {
      void this.ccMentionsBestEffort(txResult.sourceConversation, txResult.message);
    }

    // Thread reply: follower-gated delivery (§6). Recipients were narrowed
    // to follower ∩ channel-visible inside the transaction (sender already
    // excluded), and prior thread history was backfilled there. Here we
    // only deliver the current reply: `turn` recipients (mentioned) get
    // active delivery (spawn idle / wake ready); `observe` recipients get a
    // durable inbox row only and must NOT start an idle runtime.
    if (txResult.threadDelivery) {
      void this.deliverThreadReplyBestEffort(
        txResult.targetConversation,
        txResult.message,
        txResult.threadDelivery,
      );
      return {
        message: txResult.message,
        targetConversationId: txResult.targetConversation.id,
      };
    }

    void this.deliverBestEffort(
      txResult.targetConversation.id,
      txResult.message.id,
      txResult.recipients,
      deliveryExcludeAgentId,
    );
    // Auto-start policy:
    //  - User send: always (policy.autoStartIdleRecipients = true).
    //  - Agent send to self: never — prevents same-conversation ping-pong
    //    where every reply would wake every other idle member.
    //  - Agent cross-target send (`--target parent` / `<thread_id>`):
    //    always wake the target's idle members. Cross-target send is an
    //    explicit hand-off; if the receiving session is idle, the message
    //    just sits in inbox and "delivery" is a no-op for collaboration
    //    purposes. Cross-conversation traffic does not ping-pong because
    //    target replies stay scoped to the target's own member set.
    //  Wake intentionally does NOT exclude the sender's session in the
    //  target conversation: when Cindy@channel sends to a thread where a
    //  separate Cindy@thread session exists, the thread session must be
    //  woken — they are independent (conversation, agent) processes with
    //  independent context.
    const shouldAutoStartIdle =
      policy.autoStartIdleRecipients
      || (input.actor.kind === 'agent' && targetIsCrossConversation);
    if (shouldAutoStartIdle) {
      void this.startIdleRecipientsBestEffort(
        txResult.targetConversation,
        txResult.message,
        txResult.recipients,
      );
    }

    return {
      message: txResult.message,
      targetConversationId: txResult.targetConversation.id,
    };
  }

  resolveStaleMessage(input: ResolveStaleMessageInput): void {
    assertActorConversationMatch(input.actor, input.conversationId);
    this.logStaleResolution({
      sourceConversationId: input.conversationId,
      targetConversationId: input.conversationId,
      agentId: input.actor.agentId,
      staleEventId: input.staleEventId,
      resolutionReason: input.resolutionReason,
      outcome: 'obsolete',
      messageId: null,
      messageSeq: null,
    });
  }

  private insertMessageWithFreshnessIfApplicable(params: {
    input: SendMessageInput;
    sourceConversationId: string;
    targetConversationId: string;
    threadRootId: string | null;
    snapshots: NonNullable<Parameters<MessageRepo['insertForConversation']>[0]['attachments']>;
  }): { message: MessageDto; skippedFreshnessReason: string | null } {
    const { input } = params;
    const base = {
      conversationId: params.targetConversationId,
      fromKind: input.actor.kind,
      fromUserId: input.actor.kind === 'user' ? input.actor.userId : null,
      fromAgentId: input.actor.kind === 'agent' ? input.actor.agentId : null,
      content: input.content,
      attachments: params.snapshots.length > 0 ? params.snapshots : null,
      threadRootId: params.threadRootId,
    };

    if (input.actor.kind !== 'agent') {
      return {
        message: this.messages.insertForConversation(base),
        skippedFreshnessReason: null,
      };
    }
    if (input.freshnessBypass) {
      return {
        message: this.messages.insertForConversation(base),
        skippedFreshnessReason: 'freshness_bypass_explicit',
      };
    }
    if (params.sourceConversationId !== params.targetConversationId) {
      return {
        message: this.messages.insertForConversation(base),
        skippedFreshnessReason: 'cross_target_send',
      };
    }
    if (input.seenUpToSeq === undefined) {
      return {
        message: this.messages.insertForConversation(base),
        skippedFreshnessReason: 'missing_seen_up_to_seq',
      };
    }

    const result = this.messages.insertForConversationIfFresh({
      ...base,
      seenUpToSeq: input.seenUpToSeq,
    });
    if (result.ok) {
      return { message: result.message, skippedFreshnessReason: null };
    }

    throw new MessageFreshnessGuardError(
      params.targetConversationId,
      input.seenUpToSeq,
      result.currentSeq,
      params.threadRootId,
    );
  }

  private normalizeMessageTarget(input: SendMessageInput): NormalizedMessageTarget {
    if (input.legacyReplyToMessageId !== undefined) {
      if (input.target !== undefined) {
        throw new TargetError(
          'target_conflict',
          'target and legacyReplyToMessageId are mutually exclusive',
        );
      }
      return { kind: 'thread', messageId: input.legacyReplyToMessageId };
    }
    const target = input.target;
    if (target === undefined) return { kind: 'channel' };
    if (typeof target === 'object' && 'kind' in target) {
      return target.kind === 'thread'
        ? { kind: 'thread', messageId: target.message_id }
        : { kind: 'channel' };
    }
    return { kind: 'legacy', target };
  }

  /** Resolve a `target: {kind:'thread'}` message id into its thread root. A
   *  main-line message roots a new thread at that message; an existing reply
   *  joins the same root (no nested threads). Returns null for channel/main
   *  sends. Throws when the target message is not in the conversation. */
  private resolveThreadRootForTarget(
    targetConversationId: string,
    target: NormalizedMessageTarget,
  ): string | null {
    if (target.kind !== 'thread') return null;
    const replied = this.messages.getInConversation(
      targetConversationId,
      target.messageId,
    );
    if (!replied) {
      throw new TargetError(
        'reply_target_not_found',
        'target message not found in target conversation',
      );
    }
    return replied.thread_root_id ?? replied.id;
  }

  /** Cross-check the daemon's asserted `stream_key` against the stream the
   *  backend resolved from `reply_to`. They must agree, otherwise the
   *  daemon picked the wrong per-stream seen boundary and the freshness
   *  CAS would be meaningless (§6.4). A backend contract bug → hard
   *  reject + warn. No-op when the caller did not assert a stream_key. */
  private assertStreamKeyConsistent(
    input: SendMessageInput,
    threadRootId: string | null,
  ): void {
    if (input.assertedStreamKey === undefined) return;
    const canonical = threadRootId ? `thread:${threadRootId}` : 'main';
    if (input.assertedStreamKey === canonical) return;
    this.logger.warn(
      {
        conversationId: input.conversationId,
        actorKind: input.actor.kind,
        target: input.target ?? null,
        legacyReplyToMessageId: input.legacyReplyToMessageId ?? null,
        asserted_stream_key: input.assertedStreamKey,
        resolved_stream_key: canonical,
      },
      'conversation-message-service: stream_key assertion mismatch (rejecting)',
    );
    throw new TargetError(
      'stream_key_mismatch',
      `stream_key assertion ${input.assertedStreamKey} does not match `
        + `resolved stream ${canonical}`,
    );
  }

  private logStaleResolution(args: {
    sourceConversationId: string;
    targetConversationId: string;
    agentId: string;
    staleEventId: string;
    resolutionReason: AgentSendStaleResolutionReason | 'obsolete' | 'unattributed';
    outcome: 'message_sent' | 'obsolete';
    messageId: string | null;
    messageSeq: number | null;
  }): void {
    this.logger.warn(
      {
        sourceConversationId: args.sourceConversationId,
        targetConversationId: args.targetConversationId,
        agentId: args.agentId,
        staleEventId: args.staleEventId,
        resolutionReason: args.resolutionReason,
        outcome: args.outcome,
        messageId: args.messageId,
        messageSeq: args.messageSeq,
      },
      'conversation-message-service: stale send resolution observed',
    );
  }

  private validateActor(
    actor: SendMessageActor,
    policy: SendMessagePolicy,
    sourceConversationId: string,
  ): void {
    if (actor.kind !== 'agent') return;
    if (!this.agents.get(actor.agentId)) {
      throw new ActorError('agent_not_found', 'agent not found');
    }
    if (
      policy.requireSenderMembership
      && !this.conversations.getAgent(sourceConversationId, actor.agentId)
    ) {
      throw new ActorError(
        'agent_not_member_of_conversation',
        'agent is not a member of this conversation',
      );
    }
  }

  private resolveLegacyTarget(
    sourceConversation: NonNullable<ReturnType<ConversationRepo['get']>>,
    target: LegacySendMessageTarget,
  ): NonNullable<ReturnType<ConversationRepo['get']>> {
    if (target === 'self') return sourceConversation;
    if (target === 'parent') {
      if (!sourceConversation.parent_conversation_id) {
        throw new TargetError('no_parent', 'no parent channel');
      }
      const parent = this.conversations.get(sourceConversation.parent_conversation_id);
      if (!parent) {
        throw new TargetError('no_parent', 'parent channel not found');
      }
      if (parent.closed_at !== null) {
        throw new TargetError('target_closed', 'target conversation is closed');
      }
      if (parent.archived_at !== null) {
        throw new TargetError('target_archived', 'target conversation is archived');
      }
      return parent;
    }

    const thread = this.conversations.getThread(target.thread_id);
    if (!thread) {
      throw new TargetError('thread_not_found', 'thread not found');
    }
    if (thread.parent_conversation_id !== sourceConversation.id) {
      throw new TargetError(
        'thread_not_child',
        'target is not a direct thread of current channel',
      );
    }
    if (thread.closed_at !== null) {
      throw new TargetError('target_closed', 'target conversation is closed');
    }
    if (thread.archived_at !== null) {
      throw new TargetError('target_archived', 'target conversation is archived');
    }
    return thread;
  }

  private resolveAttachmentSnapshots(
    targetConversation: NonNullable<ReturnType<ConversationRepo['get']>>,
    attachmentIds: string[],
  ): NonNullable<Parameters<MessageRepo['insertForConversation']>[0]['attachments']> {
    if (attachmentIds.length === 0) return [];
    const ownerChannelId = resolveOwnerChannelId(targetConversation);
    if (!ownerChannelId) {
      throw new AttachmentError(
        'attachment_owner_unresolved',
        'attachment owner channel could not be resolved',
      );
    }
    const resolved = this.attachmentService.resolveSnapshotsForChannel(
      attachmentIds,
      ownerChannelId,
    );
    if (!resolved.ok) {
      throw new AttachmentError(
        'attachment_outside_channel',
        'attachment does not belong to this channel',
        resolved.offendingId,
      );
    }
    return resolved.snapshots;
  }

  /** Publish `unread_updated` to every human member of this conversation. */
  private publishUnreadUpdated(conversationId: string): void {
    publishUnreadUpdatedToConversationViewers(
      this.events,
      this.conversations,
      conversationId,
    );
  }

  private notifyViewerMentionBestEffort(
    conversation: NonNullable<ReturnType<ConversationRepo['get']>>,
    message: MessageDto,
  ): void {
    try {
      const mentionedHandles = new Set(extractMentions(message.content));
      if (mentionedHandles.size === 0) return;

      for (const viewerUserId of conversationViewerUserIds(
        this.conversations,
        conversation.id,
      )) {
        if (message.from_kind === 'user' && message.from_user_id === viewerUserId) {
          continue;
        }
        const viewer = this.users.get(viewerUserId);
        if (!viewer || !mentionedHandles.has(viewer.name)) continue;

        this.notifications.insert({
          kind: 'mention_self',
          userId: viewerUserId,
          workspaceId: conversation.workspace_id,
          conversationId: conversation.id,
          messageId: message.id,
          sourceWorkspaceId: conversation.workspace_id,
          sourceConversationId: conversation.id,
          sourceMessageId: message.id,
          payload: {
            conversation_title: conversation.title,
            trigger_name: this.resolveMessageSenderName(message),
            mentioned_name: viewer.name,
            mention_excerpt: excerpt(message.content),
          },
        });
        this.events.publishToScope(`viewer:${viewerUserId}`, 'notification', {
          kind: 'mention_self',
          conversation_id: conversation.id,
          message_id: message.id,
        });
      }
    } catch (err) {
      this.logger.warn(
        {
          conversationId: conversation.id,
          messageId: message.id,
          err,
        },
        'conversation-message-service: viewer mention notification failed',
      );
    }
  }

  private resolveMessageSenderName(message: MessageDto): string | null {
    if (message.from_kind === 'agent' && message.from_agent_id) {
      const agent = this.agents.get(message.from_agent_id);
      return (
        nonEmptyName(agent?.display_name)
        ?? nonEmptyName(agent?.name)
        ?? message.from_agent_id
      );
    }
    if (message.from_kind === 'user' && message.from_user_id) {
      const user = this.users.get(message.from_user_id);
      return (
        nonEmptyName(user?.display_name)
        ?? nonEmptyName(user?.name)
        ?? message.from_user_id
      );
    }
    return null;
  }

  private async deliverBestEffort(
    conversationId: string,
    messageId: string,
    recipients: ReturnType<ConversationRepo['listAgents']>,
    excludeAgentId: string | null,
  ): Promise<void> {
    const selected = recipients.filter(ca => ca.agent_id !== excludeAgentId);
    const failures: Array<{ agentId: string; err: unknown }> = [];
    await Promise.all(
      selected.map(async ca => {
        try {
          await this.runtimeHost.deliverMessage(
            conversationId,
            ca.agent_id,
            messageId,
          );
        } catch (err) {
          failures.push({ agentId: ca.agent_id, err });
        }
      }),
    );
    if (failures.length === 0) return;
    // Only touch the DB on the failure path — the success path stays read-free.
    const conversation = this.conversations.get(conversationId);
    const message = this.messages.getById(messageId);
    if (conversation && message) {
      for (const { agentId, err } of failures) {
        this.notifyAgentStartFailureBestEffort(conversation, message, agentId, err);
      }
    }
    this.logger.warn(
      { conversationId, messageId, excludeAgentId, failures },
      'conversation-message-service: delivery failed',
    );
  }

  private notifyAgentStartFailureBestEffort(
    conversation: NonNullable<ReturnType<ConversationRepo['get']>>,
    message: MessageDto,
    agentId: string,
    err: unknown,
  ): void {
    if (message.from_kind !== 'user' || !message.from_user_id) return;
    const agent = this.agents.get(agentId);
    const error = describeStartFailure(err);
    try {
      const notification = this.notifications.insert({
        kind: 'agent_start_failed',
        userId: message.from_user_id,
        agentId,
        workspaceId: conversation.workspace_id,
        conversationId: conversation.id,
        messageId: null,
        sourceWorkspaceId: conversation.workspace_id,
        sourceConversationId: conversation.id,
        sourceMessageId: message.id,
        payload: {
          reason: 'runtime_start_failed',
          error,
          agent_name:
            nonEmptyName(agent?.display_name)
            ?? nonEmptyName(agent?.name)
            ?? agentId,
          runtime: agent?.runtime ?? null,
          host_id: agent?.host_id ?? null,
        },
      });
      this.events.publishToScope(`viewer:${message.from_user_id}`, 'notification', {
        kind: 'agent_start_failed',
        id: notification.id,
        conversation_id: conversation.id,
        agent_id: agentId,
      });
    } catch (notifyErr) {
      this.logger.warn(
        {
          conversationId: conversation.id,
          messageId: message.id,
          agentId,
          err: notifyErr,
        },
        'conversation-message-service: agent start failure notification failed',
      );
    }
  }

  /**
   * Reply-cluster auto-follow + history backfill (§5/§6.1). Runs INSIDE the
   * send transaction so a follower is never registered without its catch-up
   * inbox rows (Cindy ruling). Registers as followers of the thread:
   *   - the reply author (`source='reply'`),
   *   - the root message author (`source='target_author'`),
   *   - every @mentioned principal that is a current channel member
   *     (`source='mention'`).
   * For each AGENT principal becoming a follower now (newly-inserted row)
   * that is a current channel member, backfills the thread's prior replies
   * (plus the root) into its inbox. Returns the follower-gated delivery plan
   * for the current reply, executed best-effort after commit.
   */
  /** Voluntary manual follow of a reply cluster (§5 B / §8). The thread is
   *  named by a message id — the root or ANY reply in it; we normalize to the
   *  canonical root (symmetry with the send/read paths). `source='manual'`;
   *  a repeat follow is idempotent and keeps its original source (no
   *  re-backfill). A newly-created follow backfills the cluster's full prior
   *  history into the agent's inbox (§6.1) — `MAX_SAFE_INTEGER` includes every
   *  existing reply since there is no "current reply" to exclude. Runs in one
   *  transaction so the follower row and its backfill commit together. */
  followThread(params: {
    conversationId: string;
    rootMessageId: string;
    agentId: string;
  }): { threadRootId: string; changed: boolean } {
    const threadRootId = this.resolveExistingThreadRoot(
      params.conversationId,
      params.rootMessageId,
    );
    const changed = this.db.transaction(() =>
      this.followAgent(
        params.conversationId,
        threadRootId,
        params.agentId,
        'manual',
        Number.MAX_SAFE_INTEGER,
      ),
    )();
    return { threadRootId, changed };
  }

  /** Voluntary unfollow (§5). Idempotent; deletes the follower row whatever
   *  its original source. A later mention/reply re-follows automatically, so
   *  unfollow never makes `@`-addressing silently fail. Already-delivered
   *  backfill is NOT retracted — unfollow only stops FUTURE delivery. */
  unfollowThread(params: {
    conversationId: string;
    rootMessageId: string;
    agentId: string;
  }): { threadRootId: string; changed: boolean } {
    const threadRootId = this.resolveExistingThreadRoot(
      params.conversationId,
      params.rootMessageId,
    );
    const { removed } = this.threadFollowers.remove(
      threadRootId,
      'agent',
      params.agentId,
    );
    return { threadRootId, changed: removed };
  }

  threadFollowerState(params: {
    conversationId: string;
    rootMessageId: string;
    userId: string;
  }): {
    threadRootId: string;
    viewerFollowing: boolean;
    followerAgentIds: string[];
  } {
    const threadRootId = this.resolveExistingThreadRoot(
      params.conversationId,
      params.rootMessageId,
    );
    return {
      threadRootId,
      viewerFollowing: this.threadFollowers.isFollower(
        threadRootId,
        'human',
        params.userId,
      ),
      followerAgentIds: this.threadFollowers
        .listFollowerAgentsVisible(threadRootId)
        .map(f => f.agent_id),
    };
  }

  followHumanThread(params: {
    conversationId: string;
    rootMessageId: string;
    userId: string;
  }): { threadRootId: string; changed: boolean } {
    const threadRootId = this.resolveExistingThreadRoot(
      params.conversationId,
      params.rootMessageId,
    );
    const { inserted } = this.threadFollowers.upsert({
      threadRootId,
      conversationId: params.conversationId,
      principalKind: 'human',
      principalId: params.userId,
      source: 'manual',
    });
    return { threadRootId, changed: inserted };
  }

  unfollowHumanThread(params: {
    conversationId: string;
    rootMessageId: string;
    userId: string;
  }): { threadRootId: string; changed: boolean } {
    const threadRootId = this.resolveExistingThreadRoot(
      params.conversationId,
      params.rootMessageId,
    );
    const { removed } = this.threadFollowers.remove(
      threadRootId,
      'human',
      params.userId,
    );
    return { threadRootId, changed: removed };
  }

  private resolveExistingThreadRoot(
    conversationId: string,
    rootMessageId: string,
  ): string {
    const root = this.messages.getInConversation(
      conversationId,
      rootMessageId,
    );
    if (!root) {
      const legacyThread = this.conversations.getThread(rootMessageId);
      if (legacyThread) {
        throw new TargetError(
          'legacy_thread_target_deprecated',
          `legacy isolated thread ${legacyThread.id} is read-only; use conversation:${legacyThread.id} for read-only history`,
        );
      }
      throw new TargetError(
        'reply_target_not_found',
        'thread root message not found in conversation',
      );
    }
    return root.thread_root_id ?? root.id;
  }

  private applyThreadFollowEffects(params: {
    conversationId: string;
    threadRootId: string;
    message: MessageDto;
    actor: SendMessageActor;
  }): ThreadDeliveryPlan {
    const { conversationId, threadRootId, message } = params;
    const currentSeq = message.seq;

    // reply author → follower
    this.followMessageAuthor(conversationId, threadRootId, message, 'reply', currentSeq);

    // root message author → follower. Delivery kind no longer has a
    // target-author carve-out: the current thread message follows channel
    // semantics and turns every visible follower agent except the sender.
    const root = this.messages.getInConversation(conversationId, threadRootId);
    if (root) {
      this.followMessageAuthor(
        conversationId,
        threadRootId,
        root,
        'target_author',
        currentSeq,
      );
    }

    // @mentioned channel members → follower. Mention no longer changes
    // delivery kind because current thread messages already turn every
    // visible follower agent; it still creates a follower row for the mention.
    // Non-members are never followed via mention (§4.1: follow is not a
    // membership backdoor); their visibility is filtered at delivery anyway.
    let userMemberIds: Set<string> | null = null;
    for (const handle of new Set(extractMentions(message.content))) {
      const agent = this.agents.getByName(handle);
      if (agent && this.conversations.getAgent(conversationId, agent.id)) {
        this.followAgent(conversationId, threadRootId, agent.id, 'mention', currentSeq);
        continue;
      }
      const user = this.users.getByName(handle);
      if (user) {
        userMemberIds ??= this.conversationUserMemberIds(conversationId);
        if (userMemberIds.has(user.id)) {
          this.threadFollowers.upsert({
            threadRootId,
            conversationId,
            principalKind: 'human',
            principalId: user.id,
            source: 'mention',
          });
        }
      }
    }

    // Current-reply delivery plan: follower agents that are channel-visible,
    // excluding the sender. Current thread messages match channel delivery:
    // every recipient gets a `turn`; `observe` is only used for historical
    // backfill and other non-waking context paths.
    const senderAgentId =
      message.from_kind === 'agent' ? message.from_agent_id : null;
    const recipients: ThreadDeliveryRecipient[] = this.threadFollowers
      .listFollowerAgentsVisible(threadRootId)
      .filter(ca => ca.agent_id !== senderAgentId)
      .map(ca => ({
        agentId: ca.agent_id,
        kind: 'turn',
      }));
    return { threadRootId, recipients };
  }

  /** Follow the author of `msg` (agent or human). Agent authors get history
   *  backfill when newly followed; human authors are recorded as followers
   *  (UI/notification consumer) but have no inbox. Only current channel
   *  members are recorded (follower ⊆ member, enforced again at delivery).
   *  Returns the agent id only when a NEW agent follower row was inserted. */
  private followMessageAuthor(
    conversationId: string,
    threadRootId: string,
    msg: MessageDto,
    source: ThreadFollowerSource,
    currentSeq: number,
  ): string | null {
    if (msg.from_kind === 'agent' && msg.from_agent_id) {
      return this.followAgent(
        conversationId,
        threadRootId,
        msg.from_agent_id,
        source,
        currentSeq,
      )
        ? msg.from_agent_id
        : null;
    } else if (msg.from_kind === 'user' && msg.from_user_id) {
      if (this.conversationUserMemberIds(conversationId).has(msg.from_user_id)) {
        this.threadFollowers.upsert({
          threadRootId,
          conversationId,
          principalKind: 'human',
          principalId: msg.from_user_id,
          source,
        });
      }
    }
    return null;
  }

  /** Upsert an agent follower; if it is newly followed AND a current channel
   *  member, backfill the thread's prior history into its inbox. Non-members
   *  are skipped (follower ⊆ member). Returns whether a NEW follower row was
   *  created (false = already following or not a member → no backfill). */
  private followAgent(
    conversationId: string,
    threadRootId: string,
    agentId: string,
    source: ThreadFollowerSource,
    currentSeq: number,
  ): boolean {
    if (!this.conversations.getAgent(conversationId, agentId)) return false;
    const { inserted } = this.threadFollowers.upsert({
      threadRootId,
      conversationId,
      principalKind: 'agent',
      principalId: agentId,
      source,
    });
    if (inserted) {
      this.backfillThreadHistory(conversationId, threadRootId, agentId, currentSeq);
    }
    return inserted;
  }

  /** Backfill prior thread context — the root (it anchors the thread) plus
   *  all replies with `seq < currentSeq` — into a newly-followed agent's
   *  inbox. Ordered by seq, idempotent on (conversation, agent, message), and
   *  skips the agent's own messages. Runs in the send transaction; the current
   *  reply is delivered separately afterwards so it is never double-enqueued
   *  (§6.1). The catch-up is COMPLETE by design — no cap — so a mid-thread
   *  follower never lands with a hole in the replies nearest the current one. */
  private backfillThreadHistory(
    conversationId: string,
    threadRootId: string,
    agentId: string,
    currentSeq: number,
  ): void {
    const root = this.messages.getInConversation(conversationId, threadRootId);
    if (root && !(root.from_kind === 'agent' && root.from_agent_id === agentId)) {
      this.conversationInboxes.ensureDelivery(conversationId, agentId, root.id, 'observe');
    }
    const replies = this.messages.listStreamBelowSeq(
      conversationId,
      threadRootId,
      currentSeq,
    );
    for (const reply of replies) {
      if (reply.from_kind === 'agent' && reply.from_agent_id === agentId) continue;
      this.conversationInboxes.ensureDelivery(conversationId, agentId, reply.id, 'observe');
    }
  }

  private conversationUserMemberIds(conversationId: string): Set<string> {
    return new Set(
      this.conversations.listUserMembers(conversationId).map(u => u.id),
    );
  }

  /** Deliver the current thread reply to its follower-gated recipients
   *  (post-commit, best-effort). `turn` recipients get active delivery
   *  (spawn idle / wake ready). `observe` recipients get a durable inbox row
   *  only — they must NOT start an idle runtime, so a normal follower is not
   *  woken by every thread reply (§6.2). Pushing an observe reply into an
   *  already-ready runtime's context without a turn needs the `delivery_kind`
   *  envelope and is 段2. */
  private async deliverThreadReplyBestEffort(
    conversation: NonNullable<ReturnType<ConversationRepo['get']>>,
    message: MessageDto,
    plan: ThreadDeliveryPlan,
  ): Promise<void> {
    const failures: Array<{ agentId: string; err: unknown }> = [];
    await Promise.all(
      plan.recipients.map(async r => {
        try {
          if (r.kind === 'turn') {
            await this.runtimeHost.deliverMessage(
              conversation.id,
              r.agentId,
              message.id,
            );
          } else {
            this.conversationInboxes.ensureDelivery(
              conversation.id,
              r.agentId,
              message.id,
              'observe',
            );
          }
        } catch (err) {
          failures.push({ agentId: r.agentId, err });
        }
      }),
    );
    if (failures.length === 0) return;
    for (const { agentId, err } of failures) {
      this.notifyAgentStartFailureBestEffort(conversation, message, agentId, err);
    }
    this.logger.warn(
      { conversationId: conversation.id, messageId: message.id, failures },
      'conversation-message-service: thread reply delivery failed',
    );
  }

  private async ccMentionsBestEffort(
    sourceConversation: NonNullable<ReturnType<ConversationRepo['get']>>,
    message: MessageDto,
  ): Promise<void> {
    const sourceWorkspace = this.workspaces.get(sourceConversation.workspace_id);
    if (!sourceWorkspace) return;
    try {
      await ccMentionsFromUserMessage({
        message,
        sourceConversation,
        sourceWorkspace,
        db: this.db,
        agents: this.agents,
        conversations: this.conversations,
        messages: this.messages,
        notifications: this.notifications,
        runtimeHost: this.runtimeHost,
        logger: this.logger,
        events: this.events,
      });
    } catch (err) {
      this.logger.warn(
        { conversationId: sourceConversation.id, messageId: message.id, err },
        'conversation-message-service: mention cc failed',
      );
    }
  }

  private async startIdleRecipientsBestEffort(
    conversation: NonNullable<ReturnType<ConversationRepo['get']>>,
    message: MessageDto,
    recipients: ReturnType<ConversationRepo['listAgents']>,
  ): Promise<void> {
    await Promise.all(
      recipients
        .filter(ca => ca.status !== 'active' && ca.status !== 'starting')
        .map(async ca => {
          try {
            await this.runtimeHost.start(conversation.id, ca.agent_id);
          } catch (err) {
            this.notifyAgentStartFailureBestEffort(
              conversation,
              message,
              ca.agent_id,
              err,
            );
            this.logger.warn(
              { conversationId: conversation.id, agentId: ca.agent_id, err },
              'conversation-message-service: auto-start on message send failed',
            );
          }
        }),
    );
  }
}

function resolveOwnerChannelId(conversation: {
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
