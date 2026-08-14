import { randomUUID } from 'node:crypto';
import { extractMessageReferences } from '@silverhand/shared/reference-markdown';
import { directPairIsReadOnlyForSurvivor } from '@silverhand/shared';
import type {
  AttachmentRefInput,
  AttachmentSnapshot,
  ConversationDto,
  LegacySendMessageTarget,
  MessageDto,
  MessageEventPayload,
  MessageProjections,
} from '@silverhand/shared';
import type { BackendLogger } from '../context.js';
import type { AgentRuntimeHost } from '../runtime/agent-runtime-host.js';
import type { ScopeEventBus } from '../ws/scope-event-bus.js';
import { assertActorConversationMatch } from '../auth/principal.js';
import { writeMentionCcCopies } from '../application/mention-cc.js';
import { resolveSnapshotsFromSources } from './attachment/snapshot-resolution.js';
import type { MessageTxScope, MessageUnitOfWork } from './conversation-message/ports.js';
import {
  POLICIES,
  REPLIED,
  ConversationError,
  TargetError,
  PolicyError,
  AttachmentError,
  ActorError,
  MessageFreshnessError,
  MessageFreshnessGuardError,
  type ConversationMessageServiceOptions,
  type NormalizedMessageTarget,
  type ResolveStaleMessageInput,
  type SendMessageActor,
  type SendMessageInput,
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
} from './conversation-message/contracts.js';

/**
 * ConversationMessageService is the single owner of send-message business
 * side effects. Routes translate auth and input shapes, then call this
 * service; they must not replicate attachment validation, message insert,
 * realtime publish, unread invalidation, thread refresh, run resolution,
 * mention CC, agent delivery, or auto-start behavior.
 *
 * Contract:
 * - User callers cannot cross-target another conversation; reject before
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
 *
 * Persistence discipline (#task:1981): this aggregate holds NO raw DB and no
 * concrete repo. It owns exactly one persistence capability — the injected
 * `MessageUnitOfWork` — and every read/write it performs inside a transaction
 * comes from the `MessageTxScope` that `atomically` hands its callback, which
 * is passed explicitly down to each in-transaction helper. Post-commit effects
 * live on the delivery coordinator, whose effect ports are unreachable from the
 * scope, so a transaction callback structurally cannot publish.
 */
export class ConversationMessageService {
  private readonly uow: MessageUnitOfWork;
  private readonly runtimeHost: AgentRuntimeHost;
  private readonly events: ScopeEventBus;
  private readonly logger: BackendLogger;
  private readonly threadFollow: ThreadFollowManager;
  private readonly delivery: MessageDeliveryCoordinator;

  constructor(opts: ConversationMessageServiceOptions) {
    this.uow = opts.uow;
    this.runtimeHost = opts.runtimeHost;
    this.events = opts.events;
    this.logger = opts.logger;
    this.threadFollow = new ThreadFollowManager({
      uow: opts.uow,
      read: opts.threadFollow.read,
      directWrite: opts.threadFollow.directWrite,
    });
    this.delivery = new MessageDeliveryCoordinator({
      read: opts.delivery.read,
      write: opts.delivery.write,
      unreadPublish: opts.unreadPublish,
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

    // #task:2000 (Cindy round-2 MUST FIX 1) — ONE derivation of "who does this
    // message address", at the send's authoritative boundary, handed to every
    // in-send consumer (thread auto-follow inside the transaction, the
    // `mention_self` notification and the cross-channel CC after commit). Each
    // of them takes it as a REQUIRED argument, so a fourth consumer cannot
    // quietly add a fourth parse of the same body.
    //
    // Derived from `input.content` rather than the inserted row because the
    // insert copies it verbatim (`insertMessageWithFreshnessIfApplicable`) —
    // identical bytes, and it keeps a pathological 64KiB Markdown parse OUT of
    // the write transaction instead of holding the write lock across it.
    const references = extractMessageReferences(input.content);

    let txResult: SendMessageTxResult;
    try {
      txResult = this.uow.atomically((tx): SendMessageTxResult => {
        const sourceConversation = tx.conversations.get(input.conversationId);
        if (!sourceConversation) {
          throw new ConversationError(
            'conversation_not_found',
            'conversation not found',
          );
        }
        this.assertPostAuthority(tx, sourceConversation, input.actor);

        const targetConversation = target.kind === 'legacy'
          ? this.resolveLegacyTarget(sourceConversation, target.target)
          : sourceConversation;
        const threadRootId = this.resolveThreadRootForTarget(
          tx,
          targetConversation.id,
          target,
        );
        this.assertStreamKeyConsistent(input, threadRootId);
        const attachmentRefs = input.attachmentRefs ?? [];
        const snapshots = this.resolveAttachmentSnapshots(
          tx,
          targetConversation,
          attachmentRefs,
        );
        // `streamHeadBeforeSend` is the merge prerequisite owed to an agent
        // whose insert skipped the freshness CAS; the insert helper owns both
        // that decision and the pre-insert head read (see its docs).
        const { message, skippedFreshnessReason, streamHeadBeforeSend } =
          this.insertMessageWithFreshnessIfApplicable({
            tx,
            input,
            sourceConversationId: sourceConversation.id,
            targetConversationId: targetConversation.id,
            threadRootId,
            snapshots,
          });
        // Reply-cluster durable semantics (§6): when this send is a thread
        // reply, register auto-followers and backfill prior thread history
        // into newly-followed agents' inboxes — all inside this transaction
        // so we never leave a "followed but not caught up" state (Cindy
        // ruling). Returns the follower-gated delivery plan for the current
        // reply, executed best-effort after commit.
        const threadDelivery =
          threadRootId !== null
            ? this.threadFollow.applyThreadFollowEffects(tx, {
                conversationId: targetConversation.id,
                threadRootId,
                message,
                actor: input.actor,
                references,
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
            tx.messages.replyCountsByRoot(targetConversation.id, [
              threadRootId,
            ])[threadRootId] ?? 0;
          // P2 (§5/§6): viewer-invariant threads-list entry (ThreadSummary minus
          // per-viewer viewer_following, plus root_seq keyset tie-break). Null
          // only if the root has no non-system reply → omit; client keeps refetch.
          const listEntry = tx.messages.threadListEntryForRoot(
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
          // Mention CC, IN THIS TRANSACTION (v71 §5, #task:2014). It was a
          // post-commit `void ccMentionsBestEffort(...)`: a crash in the gap
          // committed the human's message and lost the copy permanently, with
          // nothing said to anyone. The copy, its durable inbox delivery row and
          // the author's `mention_external` notification are all facts the domain
          // cannot afford to lose, so they commit or roll back WITH the message
          // that caused them. What is returned is the report the post-commit half
          // needs (wake / WS frames / skip log) — no effect ran here.
          //
          // `sourceConversation`, not the target: the CC answers "who did this
          // message address that cannot see the channel it was written in", and a
          // user send never has a foreign target (`allowTarget: false`), so the
          // two are the same conversation on this path anyway.
          mentionCc: policy.ccMentions
            ? writeMentionCcCopies(tx, {
                message,
                sourceConversation,
                references,
              })
            : null,
          // Main-line recipients only; thread replies deliver via
          // `threadDelivery` (follower-gated), not the conversation-wide fan-out.
          //
          // The set is the target's LIVE AGENT PARTICIPANTS — the placement
          // authority conjoined with a live `agents` row (#task:2021 P4-5), not
          // the `conversation_agents` listing this replaced: a `direct_pair` /
          // `agent_inbox` has no roster rows, so a committed DM message
          // enumerated ZERO recipients and was delivered to nobody. Enumerated
          // INSIDE this transaction, so the fan-out is the set that held when the
          // gate said yes.
          //
          // `references` is deliberately not consulted here: the main line is a
          // full fan-out and a reference never adds or removes a recipient of it
          // (#task:2000 layer ①). The reply-cluster is the one layer where a
          // reference can widen delivery, via a follower row.
          recipients:
            threadDelivery === null
              ? tx.conversations
                  .listParticipantAgentIds(targetConversation.id)
                  .map(agentId => ({ agentId }))
              : [],
          threadDelivery,
          skippedFreshnessReason,
          streamHeadBeforeSend,
          projections,
        };
      });
    } catch (err) {
      if (err instanceof MessageFreshnessGuardError) {
        const staleEventId = randomUUID();
        // Signal-only stale contract (thread MzSv_f1u0e0xbKmH, shiki
        // seq 1205): the 409 carries NO message bodies — bodies are
        // released exactly once, through the normal inbox/admission face.
        // The agent waits for its queued input (steer = this turn,
        // next-turn-batch = the next boundary), observed advances via
        // admission evidence, then it retries/resolves.
        //
        // Diff-set guarantee for that wait (contract 3): a thread send by
        // a non-follower is CAS-rejected while the prior replies have no
        // inbox rows yet (follow/backfill only runs on the successful
        // retry). Materialize the SAME observe deliveries the backfill
        // would create — idempotent with it — so the signal always has a
        // normal delivery to wait for. Main-line windows already have
        // deliveries (fan-out) or are the agent's own/system rows handled
        // by the universe-alignment rules.
        if (input.actor.kind === 'agent') {
          this.materializeAndDispatchThreadWindow({
            agentId: input.actor.agentId,
            conversationId: err.conversationId,
            threadRootId: err.threadRootId,
            seenUpToSeq: err.seenUpToSeq,
            currentSeq: err.currentSeq,
          });
        }
        this.logger.warn(
          {
            staleEventId,
            conversationId: err.conversationId,
            actorKind: input.actor.kind,
            actorId: input.actor.kind === 'agent' ? input.actor.agentId : input.actor.userId,
            seenUpToSeq: err.seenUpToSeq,
            currentSeq: err.currentSeq,
            priorStaleEventId: input.staleEventId ?? null,
            priorStaleResolutionReason: input.staleResolutionReason ?? null,
          },
          'conversation-message-service: freshness CAS rejected',
        );
        throw new MessageFreshnessError(
          err.conversationId,
          err.seenUpToSeq,
          err.currentSeq,
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

    // The committed-message payload: persisted message + in-transaction
    // absolute projections. Built ONCE here and reused verbatim for both the
    // WS publish (below) and the caller-facing result — the human send route
    // echoes it as the HTTP ACK so ACK and WS echo are structurally identical
    // and converge through one renderer apply seam (#task:1749). Any second,
    // projection-less payload shape would reintroduce the divergence.
    const committed: MessageEventPayload = {
      message: txResult.message,
      ...(txResult.projections ? { projections: txResult.projections } : {}),
    };

    this.events.publish(txResult.targetConversation.id, {
      kind: 'message',
      payload: committed,
    });

    // The caller-facing result reuses the SAME committed payload. Built once
    // here so both send branches (thread-reply / main-line) return an identical
    // shape — `streamHeadBeforeSend` rides uniformly (it is a pre-insert value
    // of the addressed stream, independent of thread vs main-line; the old
    // thread-reply early return dropped it, stranding a freshnessBypass thread
    // reply on its own head — countgame P1).
    const result: SendMessageResult = {
      committed,
      targetConversationId: txResult.targetConversation.id,
      ...(txResult.streamHeadBeforeSend !== null
        ? { streamHeadBeforeSend: txResult.streamHeadBeforeSend }
        : {}),
    };
    // ORDER IS LOAD-BEARING (#task:1870): the mention notification row must be
    // committed BEFORE the unread frames go out, because `publishUnreadUpdated`
    // co-emits the tiered badge and the badge's directed term counts unread
    // `mention_self` rows. Emitting the badge first would ship a value computed
    // without the mention that just arrived — and since the client holds the
    // badge with no refetch, that stale value would persist until some unrelated
    // event happened to arrive, which for a `mentions`/`mute`-tier channel is
    // exactly the case the tier exists to serve.
    this.delivery.notifyViewerMentionBestEffort(
      txResult.targetConversation,
      txResult.message,
      references,
    );
    this.delivery.publishUnreadUpdated(txResult.targetConversation.id);

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
    if (txResult.mentionCc) {
      // The copies are already committed; this drives only what cannot be —
      // the wake, the WS frames, and the skip log the write half returned as
      // data (a log emitted inside a transaction that later rolls back is a lie).
      void this.delivery.dispatchMentionCcBestEffort(txResult.mentionCc);
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
      return result;
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
    //  - Agent cross-target send (`--target thread:<message_id>` reply
    //    cluster): always wake the target's idle members. Cross-target send
    //    is an explicit hand-off; if the receiving session is idle, the
    //    message just sits in inbox and "delivery" is a no-op for
    //    collaboration purposes. Cross-conversation traffic does not
    //    ping-pong because target replies stay scoped to the target's own
    //    member set.
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

    return result;
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
    tx: MessageTxScope;
    input: SendMessageInput;
    sourceConversationId: string;
    targetConversationId: string;
    threadRootId: string | null;
    snapshots: AttachmentSnapshot[];
  }): {
    message: MessageDto;
    skippedFreshnessReason: string | null;
    streamHeadBeforeSend: number | null;
  } {
    const { input, tx } = params;
    const base = {
      conversationId: params.targetConversationId,
      fromKind: input.actor.kind,
      fromUserId: input.actor.kind === 'user' ? input.actor.userId : null,
      fromAgentId: input.actor.kind === 'agent' ? input.actor.agentId : null,
      content: input.content,
      attachments: params.snapshots.length > 0 ? params.snapshots : null,
      threadRootId: params.threadRootId,
    };

    // Every agent send that skips the CAS owes the sender a merge prerequisite:
    // the stream head just BEFORE this row is exactly what the skip stepped
    // over, and the daemon merges its own seq into its watermark once real
    // admission evidence covers that value. Without it the sender is
    // permanently stale on its own head in a quiet stream — nothing ever
    // delivers its own seq back to it (#task:1854 generalises what the
    // `--anyway` path already needed).
    //
    // Deciding "did the CAS run" and reading the head are ONE act, and it
    // lives here: the head must predate the insert while the skip is this
    // function's own branch, so a caller-side copy of the predicate would be a
    // second authority that silently drifts back into self-stale.
    const insertWithoutFreshness = (opts: {
      reason: string;
      prerequisite: boolean;
    }): {
      message: MessageDto;
      skippedFreshnessReason: string;
      streamHeadBeforeSend: number | null;
    } => {
      const streamHeadBeforeSend = opts.prerequisite
        ? tx.messages.streamHeadLatestSeq(
            params.targetConversationId,
            params.threadRootId,
          )
        : null;
      return {
        message: tx.messages.insertForConversation(base),
        skippedFreshnessReason: opts.reason,
        streamHeadBeforeSend,
      };
    };

    if (input.actor.kind !== 'agent') {
      // Users carry no per-stream cursor, so there is nothing to merge into.
      return {
        message: tx.messages.insertForConversation(base),
        skippedFreshnessReason: null,
        streamHeadBeforeSend: null,
      };
    }
    if (input.freshnessBypass) {
      return insertWithoutFreshness({
        reason: 'freshness_bypass_explicit',
        prerequisite: true,
      });
    }
    if (params.sourceConversationId !== params.targetConversationId) {
      // Cross-conversation send: the sender's cursor governs the conversation
      // it is attached to, not this one. Its own seq here belongs to a stream
      // it keeps no cursor for, so there is no watermark to merge into —
      // handing back a prerequisite would only invite the daemon to file
      // foreign seq numbers under its local stream. Unreachable today
      // (`self` is the only scalar target left, so target === source); the
      // branch states the rule for the model, not for a live path.
      return insertWithoutFreshness({
        reason: 'cross_target_send',
        prerequisite: false,
      });
    }
    if (input.seenUpToSeq === undefined) {
      // Loose first touch: the daemon has never observed this stream, so it
      // omitted the CAS fields rather than claim a false `seen`. The send is
      // allowed, and this is the case that most needs the prerequisite.
      return insertWithoutFreshness({
        reason: 'missing_seen_up_to_seq',
        prerequisite: true,
      });
    }

    // Freshness CAS: the port contract binds the adapter to run the seq
    // allocation + per-stream compare-and-set inside ONE nested rollback
    // boundary, so a miss rolls back only the burned seq and leaves this
    // transaction alive to throw the guard error below.
    const result = tx.messages.insertForConversationIfFresh({
      ...base,
      seenUpToSeq: input.seenUpToSeq,
    });
    if (result.ok) {
      // The CAS proved `seen == head`, so the sender already covers everything
      // before its own row: it advances its watermark directly, no merge owed.
      return {
        message: result.message,
        skippedFreshnessReason: null,
        streamHeadBeforeSend: null,
      };
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
    tx: MessageTxScope,
    targetConversationId: string,
    target: NormalizedMessageTarget,
  ): string | null {
    if (target.kind !== 'thread') return null;
    const replied = tx.messages.getInConversation(
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

  /**
   * Signal-only stale support (contract 3): for a THREAD stream, ensure
   * each non-own window message has the same `observe` delivery a later
   * auto-follow backfill would create (idempotent with it —
   * `ensureDelivery` hits the same row), then TRIGGER live delivery so
   * the rows actually move — a mid-turn agent has no future
   * ready_for_drain guarantee, so a bare pending row could sit forever
   * (Cindy C1-gate P1-1). Main-line fan-out already creates deliveries at
   * send time; own messages advance observed at send commit.
   *
   * Custody creation FAILS CLOSED (Cindy C1-gate P1-2): if the rows
   * cannot be materialized, the error propagates and NO message_stale
   * signal is returned — a signal that tells the agent to wait for a
   * delivery that does not exist would be a fabricated promise. The
   * dispatch leg stays best-effort: once the durable rows exist, the
   * normal delivery machinery (reattach replay, next drain) owns
   * recovery, exactly as for any other pending row.
   */
  private materializeAndDispatchThreadWindow(args: {
    agentId: string;
    conversationId: string;
    threadRootId: string | null;
    seenUpToSeq: number;
    currentSeq: number;
  }): void {
    if (args.threadRootId === null) return;
    const threadRootId = args.threadRootId;
    const materialized = this.uow.atomically(tx => {
      const window = tx.messages.listStreamWindowMeta(
        args.conversationId,
        threadRootId,
        args.seenUpToSeq,
        args.currentSeq,
      );
      let count = 0;
      for (const msg of window) {
        const own =
          msg.from_kind === 'agent' && msg.from_agent_id === args.agentId;
        if (own) continue;
        tx.inboxes.ensureDelivery(
          args.conversationId,
          args.agentId,
          msg.id,
          'observe',
        );
        count += 1;
      }
      return count;
    });
    if (materialized === 0) return;
    void this.runtimeHost
      .deliverPending(args.conversationId, args.agentId)
      .catch(err => {
        this.logger.warn(
          {
            conversationId: args.conversationId,
            agentId: args.agentId,
            error_message: (err as Error).message,
          },
          'conversation-message-service: thread window dispatch failed; rows stay pending for the normal drain',
        );
      });
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

  /**
   * MAY THIS SEND HAPPEN? The write gate, as ONE conjunction evaluated INSIDE the
   * write transaction (#task:2021 P4-4 finding (b)):
   *
   *     lifecycle ∧ participation ∧ not-survivor-read-only
   *
   * All three are in here because all three can change between the request's
   * resolution and this commit — the conversation can be archived, the actor
   * removed, the DM's other endpoint deleted — and the request-layer answers
   * (`resolveDeliveryTarget`, `canPostToConversation`) are SHAPING reads, never
   * capability tokens. Splitting them across layers is what let a stale
   * "authorized" survive: two of the three used to be checked here and the third
   * only at the route.
   *
   * PARTICIPATION IS PLACEMENT-BASED, not roster-based. The predicate this
   * replaced was `tx.conversations.getAgent(...)` — a `conversation_agents` row —
   * and `direct_pair` / `agent_inbox` have no roster rows by construction (§4.2),
   * so an agent posting into a new-model DM was refused unconditionally. That was
   * not a policy: it was the roster question being asked about placements whose
   * participants live on the row.
   *
   * ORDER IS PART OF THE CONTRACT. Existence (the caller's `get`) → lifecycle →
   * participation → the DM narrowing. The narrowing goes LAST so only a
   * participant can distinguish "this DM is read-only because your peer is gone"
   * from a plain refusal; and lifecycle stays ahead of participation because that
   * is the pre-existing order, so a legitimate member's closed-channel send keeps
   * reporting the reason it always did.
   *
   * EVERY ACTOR KIND, through the same authority (@Cindy B7). The human arm used
   * to stop at the route, and that was not a smaller version of this gate but a
   * different one: `canPostToConversation` answers before the transaction opens,
   * so a person removed from the channel — or from the workspace — in the gap
   * still wrote, and a direct service caller was never gated at all. The human
   * rule's extra hop (`conversation_users` seat AND `workspace_users` membership,
   * v25) is not a reason to leave it there; it is a reason for the SCOPE to expose
   * the placement authority's human face, which it now does.
   *
   * AND UNCONDITIONALLY, which is why this takes no `SendMessagePolicy` (@Cindy
   * B8). Participation was briefly a policy field that both arms set to `true`;
   * a flag with no legal current value only offers a future reader somewhere to
   * turn a security invariant off. A new actor kind must widen
   * {@link SendMessageActor} and state its arm HERE, in the gate.
   */
  private assertPostAuthority(
    tx: MessageTxScope,
    conversation: ConversationDto,
    actor: SendMessageActor,
  ): void {
    if (conversation.closed_at !== null) {
      throw new ConversationError('conversation_closed', 'conversation is closed');
    }
    if (conversation.archived_at !== null) {
      throw new ConversationError(
        'conversation_archived',
        'conversation is archived',
      );
    }
    if (actor.kind === 'agent') {
      if (!tx.agents.get(actor.agentId)) {
        throw new ActorError('agent_not_found', 'agent not found');
      }
      if (!tx.conversations.isAgentParticipant(conversation.id, actor.agentId)) {
        throw new ActorError(
          'agent_not_participant_of_conversation',
          'agent is not a participant of this conversation',
        );
      }
    }
    if (actor.kind === 'user') {
      // No existence check to mirror `agents.get`: the actor id here is an
      // authenticated principal, and participation is FALSE for an id that names
      // nobody — a missing user cannot hold a seat, be an endpoint, or be a
      // workspace member — so a separate lookup would add a second refusal for a
      // case this one already covers.
      if (!tx.conversations.isUserParticipant(conversation.id, actor.userId)) {
        throw new ActorError(
          'user_not_participant_of_conversation',
          'user is not a participant of this conversation',
        );
      }
    }
    // A property of the CONVERSATION, so it is asked for every actor kind: a
    // human's send into a DM whose agent was deleted is refused by the same fact
    // as the agent's. The rule itself lives in shared, shared with
    // `canPostToConversation`; only the two facts it reads come from this scope.
    const endpoints = tx.conversations.endpointFacts(conversation.id);
    if (
      endpoints !== null
      && directPairIsReadOnlyForSurvivor(endpoints, endpoint =>
        tx.conversations.endpointPrincipalExists(endpoint),
      )
    ) {
      throw new ConversationError(
        'conversation_endpoint_gone',
        'the other endpoint of this direct conversation no longer exists',
      );
    }
  }

  private resolveLegacyTarget(
    sourceConversation: ConversationDto,
    _target: LegacySendMessageTarget,
  ): ConversationDto {
    // `self` (the current conversation) is now the only scalar send
    // target; `parent` was retired with the isolated-thread fossil
    // (#task:1303/2d).
    return sourceConversation;
  }

  /** Validate the sender's attachment refs against the target channel and
   *  stamp the per-reference labels — INSIDE the send transaction, reading the
   *  ownership/label facts through the transaction scope so the check and the
   *  insert see one snapshot. The decision itself is the pure
   *  `resolveSnapshotsFromSources` leaf; this method only maps its refusal to
   *  the service's error taxonomy. */
  private resolveAttachmentSnapshots(
    tx: MessageTxScope,
    targetConversation: ConversationDto,
    attachmentRefs: AttachmentRefInput[],
  ): AttachmentSnapshot[] {
    if (attachmentRefs.length === 0) return [];
    const sources = tx.attachments.listSnapshotSourcesByIds(
      attachmentRefs.map(ref => ref.id),
    );
    const resolved = resolveSnapshotsFromSources(
      attachmentRefs,
      targetConversation.id,
      sources,
    );
    if (!resolved.ok) {
      throw new AttachmentError(
        resolved.reason === 'label_kind_mismatch'
          ? 'attachment_label_kind_mismatch'
          : 'attachment_outside_channel',
        resolved.reason === 'label_kind_mismatch'
          ? 'attachment label kind does not match its content type'
          : 'attachment does not belong to this channel',
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
    const result = this.threadFollow.followHumanThread(params);
    // Following a thread adds its unread replies to the viewer's roll-up
    // (ROLLUP_UNREAD counts followed threads), so the badge must refresh
    // (#task:1404). Only on a real state change — an idempotent re-follow moves
    // nothing. Emits per-viewer authoritative absolutes; non-follower viewers'
    // counts are unchanged, so the #1284 ingestor patches nothing for them.
    if (result.changed) this.delivery.publishUnreadUpdated(params.conversationId);
    return result;
  }

  unfollowHumanThread(params: {
    conversationId: string;
    rootMessageId: string;
    userId: string;
  }): { threadRootId: string; changed: boolean } {
    const result = this.threadFollow.unfollowHumanThread(params);
    // Symmetric to follow: unfollowing drops that thread's unread from the
    // viewer's roll-up, so the badge must decrement (#task:1404). Only on a real
    // removal.
    if (result.changed) this.delivery.publishUnreadUpdated(params.conversationId);
    return result;
  }
}
