import { randomUUID } from 'node:crypto';
import { extractMessageReferences } from '@silverhand/shared/reference-markdown';
import { directPairIsReadOnlyForSurvivor } from '@silverhand/shared';
import type {
  AttachmentRefInput,
  AttachmentSnapshot,
  ConversationDto,
  MessageDto,
  MessageEventPayload,
  MessageProjections,
} from '@silverhand/shared';
import type { BackendLogger } from '../context.js';
import type { AgentRuntimeHost } from '../runtime/agent-runtime-host.js';
import type { ScopeEventBus } from '../ws/scope-event-bus.js';
import { assertActorConversationMatch } from '../auth/principal.js';
import { writeMentionCcCopies } from '../application/mention-cc.js';
import { collectUnresolvedReferences } from '../application/reference-addressing.js';
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
  MessageStaleError,
  freshnessGuardScope,
  type ConversationMessageServiceOptions,
  type ResolveStaleMessageInput,
  type SendMessageActor,
  type SendMessageDestination,
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
  MessageStaleError,
  FreshnessGuardInvariantError,
  freshnessGuardScope,
} from './conversation-message/contracts.js';
export type {
  ConversationErrorCode,
  ActorErrorCode,
  TargetErrorCode,
  PolicyErrorCode,
  AttachmentErrorCode,
  SendMessageActor,
  SendMessageDestination,
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
  private readonly directLineTargetFor: (
    userId: string,
    agentHandle: string,
  ) => string | null;

  constructor(opts: ConversationMessageServiceOptions) {
    this.uow = opts.uow;
    this.runtimeHost = opts.runtimeHost;
    this.events = opts.events;
    this.logger = opts.logger;
    this.directLineTargetFor = opts.directLineTargetFor;
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
    const destination = input.destination;
    if (!policy.allowForeignStream && destination.kind === 'stream') {
      throw new PolicyError(
        'target_not_allowed_for_user',
        'user messages cannot address another conversation',
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
    // #task:2072 — WHICH of the addressed agents this author may open a direct
    // line to, resolved at the same boundary and for the same reason as
    // `references` above: it is not a fact of the send transaction (the verdict
    // reads authorization state, and the transaction's scope carries no
    // authorization capability by construction), and asking it once here keeps the
    // mention CC's destination gate out of per-door knowledge.
    //
    // Empty unless this actor's policy carries a CC — the only consumer — so no
    // authorization read happens on a send that cannot use one. The actor kind is
    // narrowed rather than assumed: `ccMentions` is a user-only policy today, and
    // an agent actor has no user id to ask about.
    const ccAuthorUserId = input.actor.kind === 'user' ? input.actor.userId : null;
    const ccDirectLineAgentIds = new Set<string>(
      policy.ccMentions && ccAuthorUserId !== null
        ? references.flatMap(ref => {
            if (ref.kind !== 'agent') return [];
            const agentId = this.directLineTargetFor(ccAuthorUserId, ref.handle);
            return agentId === null ? [] : [agentId];
          })
        : [],
    );

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
        // The TARGET is what the send has to be authorized against, and it is
        // read HERE rather than trusted from the resolver's snapshot: a resolved
        // target is a coordinate, not a capability token (#task:2021 P4-4), so
        // the row and every fact the gate reads from it come from this
        // transaction. A row that vanished in the gap answers the same 404 the
        // resolver answers for an address that names nothing — "unknown" and
        // "gone" are one outcome, by design.
        const targetConversation =
          destination.kind === 'stream'
          && destination.stream.conversationId !== sourceConversation.id
            ? this.requireConversation(tx, destination.stream.conversationId)
            : sourceConversation;
        this.assertPostAuthority(tx, targetConversation, input.actor);
        const threadRootId = this.resolveThreadRootForDestination(
          tx,
          targetConversation.id,
          destination,
        );
        const attachmentRefs = input.attachmentRefs ?? [];
        const snapshots = this.resolveAttachmentSnapshots(
          tx,
          targetConversation,
          attachmentRefs,
        );
        // The freshness guard (#task:2095) lives in the insert helper: it is a
        // per-RuntimeScope existence check, and a miss throws MessageStaleError
        // from INSIDE this transaction. `bypassedFreshness` is the sole surviving
        // "skip" fact (`--anyway`), for the post-commit observability line.
        const { message, bypassedFreshness } =
          this.insertMessageWithFreshnessIfApplicable({
            tx,
            input,
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
        // Mention CC, IN THIS TRANSACTION (v71 §5, #task:2014). It was a
        // post-commit `void ccMentionsBestEffort(...)`: a crash in the gap
        // committed the human's message and lost the copy permanently, with
        // nothing said to anyone. The copy, its durable delivery row and the
        // author's `mention_external` notification are all facts the domain
        // cannot afford to lose, so they commit or roll back WITH the message
        // that caused them — and since #task:2072 the copy's DESTINATION is
        // minted here too, so an allocated direct pair can never outlive a
        // rolled-back copy. What it returns is the report the post-commit half
        // needs (wake / WS frames / announcements / skip log) — no effect ran
        // here.
        //
        // `sourceConversation`, not the target: the CC answers "who did this
        // message address that cannot see the channel it was written in", and a
        // user send never addresses a foreign stream (`allowForeignStream:
        // false`), so the two are the same conversation on this path anyway.
        const mentionCc = policy.ccMentions
          ? writeMentionCcCopies(tx, {
              message,
              sourceConversation,
              references,
              directLineAgentIds: ccDirectLineAgentIds,
            })
          : null;
        // What the author addressed and this send could not reach (#task:2021
        // P4-5-b). Computed AFTER the two mechanisms that can reach a referenced
        // principal have run — the follower rows above and the CC copies just
        // written — because it reports on their outcome; it decides nothing and
        // writes nothing itself. Judged against the TARGET conversation, which is
        // where the message landed and therefore what "addressed" can mean.
        const unresolvedReferences = collectUnresolvedReferences(tx, {
          references,
          targetConversationId: targetConversation.id,
          ccReachedAgentIds: new Set(
            (mentionCc?.copies ?? []).map(copy => copy.agentId),
          ),
        });
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
          mentionCc,
          // Main-line recipients only; thread replies deliver via
          // `threadDelivery` (follower-gated), not the conversation-wide fan-out.
          //
          // The set is the target's LIVE AGENT PARTICIPANTS — the placement
          // authority conjoined with a live `agents` row (#task:2021 P4-5), not
          // the `conversation_agents` listing this replaced: a `direct_pair`
          // has no roster rows, so a committed DM message
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
          unresolvedReferences,
          bypassedFreshness,
          projections,
        };
      });
    } catch (err) {
      if (err instanceof MessageStaleError) {
        // Rethrow the SAME instance (never re-`new` here): the guard minted
        // `staleEventId` inside the transaction (a pure value, no persisted
        // sink), so re-constructing it out here would move the mint back
        // outside the tx and reintroduce the two-class shape (#task:2095 F7).
        //
        // This WARN is the surviving observability carrier (§3): "wear is
        // visible = read the log". It joins `logStaleResolution` via
        // `staleEventId`. Its content is re-derived for the new model — there is
        // no seq pair to report; what answers "why stale" is the RuntimeScope
        // arm (`scope`), the rejected send's target conversation + stream, and
        // whether this rejection immediately followed a claimed resolution
        // (`priorStaleResolutionReason` = the only observable shape of the §6
        // "guard ground to noise" failure mode). `undeliveredCount` (F13) is a
        // rejection-path diagnostic only — a structural upper bound (predicate
        // includes in_flight), which is exactly why it lives here and not on the
        // signal-only 409.
        this.logger.warn(
          {
            staleEventId: err.staleEventId,
            scope: err.scope,
            targetConversationId: err.targetConversationId,
            threadRootId: err.threadRootId,
            undeliveredCount: err.undeliveredCount,
            actorId: input.actor.kind === 'agent' ? input.actor.agentId : input.actor.userId,
            priorStaleEventId: input.staleEventId ?? null,
            priorStaleResolutionReason: input.staleResolutionReason ?? null,
          },
          'conversation-message-service: freshness guard rejected send (runtime has undelivered input)',
        );
        throw err;
      }
      throw err;
    }

    if (txResult.bypassedFreshness) {
      this.logger.warn(
        {
          sourceConversationId: txResult.sourceConversation.id,
          targetConversationId: txResult.targetConversation.id,
          actorKind: input.actor.kind,
          actorId: input.actor.kind === 'agent' ? input.actor.agentId : input.actor.userId,
        },
        'conversation-message-service: freshness guard bypassed (--anyway)',
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
        destination: destination.kind,
        contentBytes: input.content.length,
        recipientCount:
          txResult.threadDelivery?.recipients.length
          ?? txResult.recipients.length,
        threadReply: txResult.threadDelivery !== null,
      },
      'conversation-message-service: message inserted',
    );

    // The author addressed someone this send could not reach. Logged at WARN and
    // per send (not per reference), because it is an ANOMALY someone may have to
    // explain after the fact — "I told the agent and nothing happened" — and the
    // default level on a running install is `warn`, so an `info` line would not
    // be on disk when that question is asked. This is a SUPPLEMENT to the
    // author's own answer (both send routes return the tokens), never the
    // substitute for it: a log is not feedback to the person who typed the name.
    // Only the author's own tokens are recorded: no reason, and nothing about who
    // does exist (see `application/reference-addressing.ts`).
    if (txResult.unresolvedReferences.length > 0) {
      this.logger.warn(
        {
          event: 'send.references_unresolved',
          sourceConversationId: txResult.sourceConversation.id,
          targetConversationId: txResult.targetConversation.id,
          messageId: txResult.message.id,
          actorKind: input.actor.kind,
          actorId:
            input.actor.kind === 'agent' ? input.actor.agentId : input.actor.userId,
          unresolved: txResult.unresolvedReferences.map(ref => ({
            kind: ref.kind,
            handle: ref.handle,
          })),
        },
        'conversation-message-service: references addressed nobody in the target',
      );
    }

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
    // shape.
    const result: SendMessageResult = {
      committed,
      targetConversationId: txResult.targetConversation.id,
      // A SIBLING of `committed`, never a field inside it: `committed` is
      // published to the whole conversation, and who the author failed to
      // address is theirs alone (#task:2021 P4-5-b).
      unresolvedReferences: txResult.unresolvedReferences,
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
    // started session would wake without a message to process.
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
    targetConversationId: string;
    threadRootId: string | null;
    snapshots: AttachmentSnapshot[];
  }): {
    message: MessageDto;
    bypassedFreshness: boolean;
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

    // F8 (#task:2095): a human has no runtime, and therefore no rows in
    // `conversation_inboxes` — that table is the AGENT delivery domain. There is
    // no consumption position for a human to be behind, so a human send never
    // reaches the guard and never 409s. (This is the old `null`-reason branch
    // under an honest rationale: the previous "users carry no per-stream cursor"
    // was a fact about the retired model, not a reason in this one.)
    if (input.actor.kind !== 'agent') {
      return {
        message: tx.messages.insertForConversation(base),
        bypassedFreshness: false,
      };
    }
    // `--anyway`: the explicit escape hatch (§3). It skips the guard entirely —
    // the send lands even while the runtime still holds undelivered input — and
    // is recorded as `bypassedFreshness` for the post-commit observability line.
    if (input.freshnessBypass) {
      return {
        message: tx.messages.insertForConversation(base),
        bypassedFreshness: true,
      };
    }

    // Freshness guard (#task:2095). Freshness is a property of the RUNTIME's
    // field of view, not of a stream: this send is stale iff the runtime still
    // has an undelivered inbox row in its delivery scope. The scope arm is the
    // agent's `session_scope` (the RuntimeScope discriminant); the set it asks
    // about is a SUPERSET of the set that runtime can drain: the guard predicate
    // (`delivered_at IS NULL AND failed_at IS NULL`, in-flight rows INCLUDED) is
    // broader than `pendingOriginsForRuntime`, which additionally requires
    // `in_flight_owner IS NULL`. So guard ⊇ drain, and the difference is EXACTLY
    // the in-flight set — the one accepted residual: a runtime whose only
    // undelivered rows are in-flight reads stale here yet can drain nothing,
    // until those leases settle (delivery ack) or are swept
    // (`outbound-event-fanout.ts:1283-1289`, start/disconnect, no time expiry).
    // Draining makes MOST stale sends fresh, but NOT that window — do NOT read
    // this as "guard scope ≡ drain scope"; it is a strict superset. The
    // conversation arm keys on `input.conversationId`, the SOURCE conversation
    // this runtime is bound to (its focus / drain scope), NOT the send target.
    // The read is boolean existence, never a seq comparison, so it is immune to
    // rowid reuse.
    //
    // A miss throws MessageStaleError from INSIDE this transaction, with the
    // `staleEventId` minted right here — a pure value with no persisted sink, so
    // the service catch can rethrow the SAME instance without re-minting (F7).
    //
    // The scope arm comes from the runtime's own `session_scope`. A missing row
    // is NOT silently widened to the broad 'agent' arm — that direction is
    // unsafe (the round-1 F1 latch, an undrainable deadlock), so it is thrown as
    // an invariant violation via `freshnessGuardScope` (see its doc + the
    // pure-function test that pins the unreachable arm).
    const scope = freshnessGuardScope(
      tx.agents.get(input.actor.agentId),
      input.actor.agentId,
    );
    const hasUndelivered =
      scope === 'conversation'
        ? tx.inboxes.hasUndeliveredForPair(input.conversationId, input.actor.agentId)
        : tx.inboxes.hasUndeliveredForAgent(input.actor.agentId);
    if (hasUndelivered) {
      // Reject-path only (F13): one COUNT with the SAME predicate as the guard
      // (in_flight rows included), carried on the error for the "rejected send"
      // WARN and nowhere else. Never on the hot path — the boolean EXISTS above
      // already decided — and never projected onto the 409.
      const undeliveredCount =
        scope === 'conversation'
          ? tx.inboxes.countQueuedForPair(input.conversationId, input.actor.agentId)
          : tx.inboxes.countQueuedForAgent(input.actor.agentId);
      throw new MessageStaleError(
        params.targetConversationId,
        randomUUID(),
        scope,
        params.threadRootId,
        undeliveredCount,
      );
    }
    return {
      message: tx.messages.insertForConversation(base),
      bypassedFreshness: false,
    };
  }

  /** Read a conversation the caller already named, inside the send transaction.
   *  Absence is `conversation_not_found` — the same 404 an address that names
   *  nothing gets, so a target that disappeared in the gap between resolution
   *  and this write is not distinguishable from one that never existed. */
  private requireConversation(
    tx: MessageTxScope,
    conversationId: string,
  ): ConversationDto {
    const conversation = tx.conversations.get(conversationId);
    if (!conversation) {
      throw new ConversationError(
        'conversation_not_found',
        'conversation not found',
      );
    }
    return conversation;
  }

  /**
   * Which STREAM of the target conversation this send lands in: `null` for the
   * main line, else the reply cluster's root message id.
   *
   * The two arms answer it by different authorities, on purpose (#task:2021
   * P4-4). An address arrives with its cluster ALREADY VALIDATED as a root by
   * `resolveDeliveryTarget` — mid-cluster ids are refused there rather than
   * normalized, because an agent copies a target it was GIVEN and a silently
   * re-cut coordinate would put its words in a stream it did not name. The human
   * door has the opposite problem: a person clicks "reply" on whatever message is
   * in front of them, so any message in the cluster stands for the cluster and is
   * normalized here.
   *
   * The `stream` arm re-reads nothing: `thread_root_id` and a message's
   * conversation are both write-once, so there is no gap for the resolver's read
   * to have gone stale in.
   */
  private resolveThreadRootForDestination(
    tx: MessageTxScope,
    targetConversationId: string,
    destination: SendMessageDestination,
  ): string | null {
    if (destination.kind === 'stream') return destination.stream.threadRootId;
    if (destination.kind === 'own_main_line') return null;
    const replied = tx.messages.getInConversation(
      targetConversationId,
      destination.messageId,
    );
    if (!replied) {
      throw new TargetError(
        'reply_target_not_found',
        'target message not found in target conversation',
      );
    }
    return replied.thread_root_id ?? replied.id;
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
   * and a `direct_pair` has no roster rows by construction (§4.2),
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
   * EVERY ACTOR KIND, through the same authority. The human arm used
   * to stop at the route, and that was not a smaller version of this gate but a
   * different one: `canPostToConversation` answers before the transaction opens,
   * so a person removed from the channel — or from the workspace — in the gap
   * still wrote, and a direct service caller was never gated at all. The human
   * rule's extra hop (`conversation_users` seat AND `workspace_users` membership,
   * v25) is not a reason to leave it there; it is a reason for the SCOPE to expose
   * the placement authority's human face, which it now does.
   *
   * AND UNCONDITIONALLY, which is why this takes no `SendMessagePolicy`.
   * Participation was briefly a policy field that both arms set to `true`;
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
