import type { Database as Db } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type {
  LegacySendMessageTarget,
  MessageDto,
  MessageEventPayload,
  MessageProjections,
} from '@silverhand/shared';
import type { BackendLogger } from '../context.js';
import type { AgentRuntimeHost } from '../runtime/agent-runtime-host.js';
import type { AgentRepo } from '../repos/agent-repo.js';
import type { ConversationRepo } from '../repos/conversation-repo.js';
import type { MessageRepo } from '../repos/message-repo.js';
import type { AttachmentService } from './attachment-service.js';
import type { ScopeEventBus } from '../ws/scope-event-bus.js';
import { assertActorConversationMatch } from '../auth/principal.js';
import {
  POLICIES,
  REPLIED,
  STALE_MESSAGE_LIMIT,
  ConversationError,
  TargetError,
  PolicyError,
  AttachmentError,
  ActorError,
  MessageFreshnessError,
  MessageFreshnessGuardError,
  resolveOwnerChannelId,
  type ConversationMessageServiceOptions,
  type NormalizedMessageTarget,
  type ResolveStaleMessageInput,
  type SendMessageActor,
  type SendMessageInput,
  type SendMessagePolicy,
  type SendMessageResult,
  type SendMessageTxResult,
} from './conversation-message/contracts.js';
import { ThreadFollowManager } from './conversation-message/thread-follow.js';
import { MessageDeliveryCoordinator } from './conversation-message/delivery.js';
import type { AgentSendStaleResolutionReason } from '@silverhand/shared';

// Re-export the previously-public taxonomy + types so external importers keep
// importing from `conversation-message-service.js` (the split is internal).
export {
  ConversationError,
  ActorError,
  TargetError,
  PolicyError,
  AttachmentError,
  MessageFreshnessError,
} from './conversation-message/contracts.js';
export type {
  ConversationErrorCode,
  ActorErrorCode,
  TargetErrorCode,
  PolicyErrorCode,
  AttachmentErrorCode,
  SendMessageActor,
  SendMessageInput,
  SendMessageResult,
  ResolveStaleMessageInput,
  ConversationMessageServiceOptions,
  SendAsTaskWriter,
} from './conversation-message/contracts.js';

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
 *
 * This class is the send aggregate. Two cohesive concerns are delegated to
 * collaborators constructed here: `ThreadFollowManager` owns reply-cluster
 * follow/unfollow + the in-transaction auto-follow effects, and
 * `MessageDeliveryCoordinator` owns all post-commit best-effort
 * delivery/notification. The send-transaction target/freshness/attachment
 * helpers stay here because they are the aggregate's own internals, not a
 * separate reason to change.
 */
export class ConversationMessageService {
  private readonly db: Db;
  private readonly conversations: ConversationRepo;
  private readonly messages: MessageRepo;
  private readonly agents: AgentRepo;
  private readonly attachmentService: AttachmentService;
  private readonly runtimeHost: AgentRuntimeHost;
  private readonly events: ScopeEventBus;
  private readonly logger: BackendLogger;
  private readonly sendAsTaskWriter: ConversationMessageServiceOptions['sendAsTaskWriter'];
  private readonly threadFollow: ThreadFollowManager;
  private readonly delivery: MessageDeliveryCoordinator;

  constructor(opts: ConversationMessageServiceOptions) {
    this.db = opts.db;
    this.conversations = opts.conversations;
    this.messages = opts.messages;
    this.agents = opts.agents;
    this.attachmentService = opts.attachmentService;
    this.runtimeHost = opts.runtimeHost;
    this.events = opts.events;
    this.logger = opts.logger;
    this.sendAsTaskWriter = opts.sendAsTaskWriter;
    this.threadFollow = new ThreadFollowManager({
      db: opts.db,
      conversations: opts.conversations,
      conversationInboxes: opts.conversationInboxes,
      messages: opts.messages,
      threadFollowers: opts.threadFollowers,
      agents: opts.agents,
      users: opts.users,
    });
    this.delivery = new MessageDeliveryCoordinator({
      db: opts.db,
      conversations: opts.conversations,
      conversationInboxes: opts.conversationInboxes,
      messages: opts.messages,
      agents: opts.agents,
      users: opts.users,
      notifications: opts.notifications,
      workspaces: opts.workspaces,
      runtimeHost: opts.runtimeHost,
      events: opts.events,
      logger: opts.logger,
    });
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
        this.validateActor(input.actor, policy, sourceConversation.id);

        const targetConversation = target.kind === 'legacy'
          ? this.resolveLegacyTarget(sourceConversation, target.target)
          : sourceConversation;
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
            ? this.threadFollow.applyThreadFollowEffects({
                conversationId: targetConversation.id,
                threadRootId,
                message,
                actor: input.actor,
              })
            : null;
        // S1 (#task:1276) P1+P2: a thread reply changes the root's authoritative
        // reply badge (P1) and its threads-list entry (P2). Both are computed IN
        // THIS TRANSACTION (after the insert, so they INCLUDE this reply — never a
        // future-seq value; Cindy gate #1), as ABSOLUTE values the client merges
        // idempotently. Both mirror `from_kind != 'system'` authority, so live ==
        // replay == cold-open, and both are viewer-invariant → safe on the
        // broadcast `conversation:{id}` frame. Absent for a main-line send.
        let projections: MessageProjections | null = null;
        if (threadRootId !== null) {
          const replyCount =
            this.messages.replyCountsByRoot(targetConversation.id, [
              threadRootId,
            ])[threadRootId] ?? 0;
          // P2 (§5/§6): viewer-invariant threads-list entry (ThreadSummary minus
          // per-viewer viewer_following, plus root_seq keyset tie-break). Null
          // only if the root has no non-system reply → omit; client keeps refetch.
          const listEntry = this.messages.threadListEntryForRoot(
            targetConversation.id,
            threadRootId,
          );
          projections = {
            thread_root_reply_count: {
              root_id: threadRootId,
              reply_count: replyCount,
            },
            ...(listEntry ? { threads_list_entry: { entry: listEntry } } : {}),
          };
        }
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
          projections,
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
      payload: {
        message: txResult.message,
        ...(txResult.projections ? { projections: txResult.projections } : {}),
      } satisfies MessageEventPayload,
    });
    this.delivery.publishUnreadUpdated(txResult.targetConversation.id);
    this.delivery.notifyViewerMentionBestEffort(
      txResult.targetConversation,
      txResult.message,
    );

    if (txResult.targetConversation.parent_conversation_id) {
      this.events.publishSide(txResult.targetConversation.parent_conversation_id, {
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
      void this.delivery.ccMentionsBestEffort(txResult.sourceConversation, txResult.message);
    }

    // Thread reply: follower-gated delivery (§6). Recipients were narrowed
    // to follower ∩ channel-visible inside the transaction (sender already
    // excluded), and prior thread history was backfilled there. Here we
    // only deliver the current reply: `turn` recipients (mentioned) get
    // active delivery (spawn idle / wake ready); `observe` recipients get a
    // durable inbox row only and must NOT start an idle runtime.
    if (txResult.threadDelivery) {
      void this.delivery.deliverThreadReplyBestEffort(
        txResult.targetConversation,
        txResult.message,
        txResult.threadDelivery,
      );
      return {
        message: txResult.message,
        targetConversationId: txResult.targetConversation.id,
      };
    }

    void this.delivery.deliverBestEffort(
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
      void this.delivery.startIdleRecipientsBestEffort(
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

    return target;
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

  // ── Thread reply-cluster follow surface (§5) ───────────────────────────
  // Public API preserved verbatim; the logic lives in `ThreadFollowManager`.

  followThread(params: {
    conversationId: string;
    rootMessageId: string;
    agentId: string;
  }): { threadRootId: string; changed: boolean } {
    return this.threadFollow.followThread(params);
  }

  unfollowThread(params: {
    conversationId: string;
    rootMessageId: string;
    agentId: string;
  }): { threadRootId: string; changed: boolean } {
    return this.threadFollow.unfollowThread(params);
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
    return this.threadFollow.threadFollowerState(params);
  }

  followHumanThread(params: {
    conversationId: string;
    rootMessageId: string;
    userId: string;
  }): { threadRootId: string; changed: boolean } {
    return this.threadFollow.followHumanThread(params);
  }

  unfollowHumanThread(params: {
    conversationId: string;
    rootMessageId: string;
    userId: string;
  }): { threadRootId: string; changed: boolean } {
    return this.threadFollow.unfollowHumanThread(params);
  }
}
