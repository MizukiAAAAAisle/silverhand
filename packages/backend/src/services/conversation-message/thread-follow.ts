// Thread reply-cluster follow/unfollow aggregate (§5/§6). Owns the durable
// follower rows and their history backfill: the voluntary follow/unfollow/state
// surface AND the auto-follow effects the send path applies INSIDE its
// transaction (`applyThreadFollowEffects`), so a follower is never registered
// without its catch-up inbox rows. The facade constructs one of these and
// delegates its public thread-follow methods to it verbatim.
//
// Persistence discipline (#task:1981): this aggregate holds NO raw DB and no
// concrete repo. Everything it does inside a transaction takes an explicit
// `MessageTxScope`; the callback-free voluntary surface uses the narrow
// read / direct-write ports. It never opens a transaction of its own except
// through the injected UnitOfWork.
import type {
  MessageDto,
  Reference,
  ThreadFollowerSource,
} from '@silverhand/shared';
import type {
  MessageTxScope,
  MessageUnitOfWork,
  ThreadFollowDirectWritePort,
  ThreadFollowReadPort,
} from './ports.js';
import {
  TargetError,
  type SendMessageActor,
  type ThreadDeliveryPlan,
  type ThreadDeliveryRecipient,
} from './contracts.js';

export interface ThreadFollowManagerDeps {
  uow: MessageUnitOfWork;
  read: ThreadFollowReadPort;
  directWrite: ThreadFollowDirectWritePort;
}

/** Normalize a message id (root or any reply) to its canonical thread root.
 *  Takes the lookup as a parameter so the in-transaction and out-of-transaction
 *  callers share one rule while reading through their own connection. */
function resolveThreadRoot(
  getMessage: (conversationId: string, messageId: string) => MessageDto | null,
  conversationId: string,
  rootMessageId: string,
): string {
  const root = getMessage(conversationId, rootMessageId);
  if (!root) {
    throw new TargetError(
      'reply_target_not_found',
      'thread root message not found in conversation',
    );
  }
  return root.thread_root_id ?? root.id;
}

export class ThreadFollowManager {
  private readonly uow: MessageUnitOfWork;
  private readonly read: ThreadFollowReadPort;
  private readonly directWrite: ThreadFollowDirectWritePort;

  constructor(deps: ThreadFollowManagerDeps) {
    this.uow = deps.uow;
    this.read = deps.read;
    this.directWrite = deps.directWrite;
  }

  /** Voluntary manual follow of a reply cluster (§5 B / §8). The thread is
   *  named by a message id — the root or ANY reply in it; we normalize to the
   *  canonical root (symmetry with the send/read paths). `source='manual'`;
   *  a repeat follow is idempotent and keeps its original source (no
   *  re-backfill). A newly-created follow backfills the cluster's full prior
   *  history into the agent's inbox (§6.1) — `MAX_SAFE_INTEGER` includes every
   *  existing reply since there is no "current reply" to exclude. Runs in one
   *  transaction so the root resolution, the follower row and its backfill all
   *  see and commit the same snapshot. */
  followThread(params: {
    conversationId: string;
    rootMessageId: string;
    agentId: string;
  }): { threadRootId: string; changed: boolean } {
    return this.uow.atomically(tx => {
      const threadRootId = resolveThreadRoot(
        (conversationId, messageId) =>
          tx.messages.getInConversation(conversationId, messageId),
        params.conversationId,
        params.rootMessageId,
      );
      const changed = this.followAgent(
        tx,
        params.conversationId,
        threadRootId,
        params.agentId,
        'manual',
        Number.MAX_SAFE_INTEGER,
      );
      return { threadRootId, changed };
    });
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
    const threadRootId = this.resolveRootOutsideTx(
      params.conversationId,
      params.rootMessageId,
    );
    const { removed } = this.directWrite.remove(
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
    const threadRootId = this.resolveRootOutsideTx(
      params.conversationId,
      params.rootMessageId,
    );
    return {
      threadRootId,
      viewerFollowing: this.read.isFollower(threadRootId, 'human', params.userId),
      followerAgentIds: this.read.listFollowerAgentIdsParticipating(threadRootId),
    };
  }

  followHumanThread(params: {
    conversationId: string;
    rootMessageId: string;
    userId: string;
  }): { threadRootId: string; changed: boolean } {
    const threadRootId = this.resolveRootOutsideTx(
      params.conversationId,
      params.rootMessageId,
    );
    const { inserted } = this.directWrite.upsert({
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
    const threadRootId = this.resolveRootOutsideTx(
      params.conversationId,
      params.rootMessageId,
    );
    const { removed } = this.directWrite.remove(
      threadRootId,
      'human',
      params.userId,
    );
    return { threadRootId, changed: removed };
  }

  private resolveRootOutsideTx(
    conversationId: string,
    rootMessageId: string,
  ): string {
    return resolveThreadRoot(
      (cid, mid) => this.read.getMessageInConversation(cid, mid),
      conversationId,
      rootMessageId,
    );
  }

  /**
   * Reply-cluster auto-follow + history backfill (§5/§6.1). Runs INSIDE the
   * send transaction — the caller passes its scope, and this method never opens
   * one — so a follower is never registered without its catch-up inbox rows
   * (Cindy ruling). Registers as followers of the thread:
   *   - the reply author (`source='reply'`),
   *   - the root message author (`source='target_author'`),
   *   - every @mentioned principal that is a current LIVE PARTICIPANT
   *     (`source='mention'`).
   * For each AGENT principal becoming a follower now (newly-inserted row)
   * that is a current participant, backfills the thread's prior replies
   * (plus the root) into its inbox. Returns the follower-gated delivery plan
   * for the current reply, executed best-effort after commit.
   *
   * EVERY gate below is `follower ⊆ live participant`, asked of the one placement
   * authority (§4.2) for BOTH principal kinds (#task:2021 P4-5, @Cindy boundary
   * 3). They used to be roster questions — `conversation_agents` for an agent,
   * `conversation_users` for a human — which are the participants of the WORKSPACE
   * arm only: on a `direct_pair` / `agent_inbox` thread nothing was ever eligible,
   * not even the endpoint principal replying in its own DM, so no follower row was
   * created and the reply delivered to nobody.
   */
  applyThreadFollowEffects(
    tx: MessageTxScope,
    params: {
      conversationId: string;
      threadRootId: string;
      message: MessageDto;
      actor: SendMessageActor;
      /** The send boundary's single derivation of what this message
       *  addresses (#task:2000, Cindy round-2 MUST FIX 1). Required, not
       *  re-derived here: one send = one parse. */
      references: readonly Reference[];
    },
  ): ThreadDeliveryPlan {
    const { conversationId, threadRootId, message } = params;
    const currentSeq = message.seq;

    // reply author → follower
    this.followMessageAuthor(tx, conversationId, threadRootId, message, 'reply', currentSeq);

    // root message author → follower. Delivery kind no longer has a
    // target-author carve-out: the current thread message follows channel
    // semantics and turns every visible follower agent except the sender.
    const root = tx.messages.getInConversation(conversationId, threadRootId);
    if (root) {
      this.followMessageAuthor(
        tx,
        conversationId,
        threadRootId,
        root,
        'target_author',
        currentSeq,
      );
    }

    // Referenced LIVE PARTICIPANTS → follower. Mention no longer changes
    // delivery kind because current thread messages already turn every
    // participating follower agent; it still creates a follower row for the
    // mention. A referenced principal that does NOT participate is never followed
    // (§4.1: follow is not a membership backdoor) — which is why a reference to
    // someone else's member expands nothing here, while a reference to a live
    // participant of THIS conversation does (the reply-cluster is the one layer
    // where a reference can widen the recipient set, #task:2000 layer ②).
    //
    // The participation gate is NOT restated here: `followAgent` / `followUser`
    // hold it, and every insertion path in this class goes through one of them. A
    // copy of the check at this call site would be a second place to keep it in
    // sync while being impossible to reach with the first one intact — and the
    // reference loop is precisely where a reviewer would look for a bypass, so the
    // one gate has to be somewhere a bypass CANNOT be written.
    //
    // #task:2000: the reference contract decides who is addressed, and the
    // reference's KIND decides which namespace answers for it. The old
    // agent-then-user fallback existed because a bare `@handle` carried no kind
    // and a handle is unique across both tables; a typed pointer states which
    // one it means, so `silverhand://human/x` must not follow an agent `x`.
    for (const ref of params.references) {
      if (ref.kind === 'agent') {
        const agent = tx.agents.getByName(ref.handle);
        if (agent) {
          this.followAgent(tx, conversationId, threadRootId, agent.id, 'mention', currentSeq);
        }
        continue;
      }
      const user = tx.users.getByName(ref.handle);
      if (user) {
        this.followUser(tx, conversationId, threadRootId, user.id, 'mention');
      }
    }

    // Current-reply delivery plan: follower agents that are channel-visible,
    // excluding the sender. Read through the TRANSACTION scope — the plan must
    // see the follower rows this method just inserted, which a captured
    // out-of-transaction read would miss on any engine that does not share one
    // connection. Current thread messages match channel delivery: every
    // recipient gets a `turn`; `observe` is only used for historical backfill
    // and other non-waking context paths.
    const senderAgentId =
      message.from_kind === 'agent' ? message.from_agent_id : null;
    const recipients: ThreadDeliveryRecipient[] = tx.threadFollowers
      .listFollowerAgentIdsParticipating(threadRootId)
      .filter(agentId => agentId !== senderAgentId)
      .map(agentId => ({ agentId, kind: 'turn' }));
    return { threadRootId, recipients };
  }

  /** Follow the author of `msg` (agent or human). Agent authors get history
   *  backfill when newly followed; human authors are recorded as followers
   *  (UI/notification consumer) but have no inbox. Only current LIVE
   *  PARTICIPANTS are recorded (follower ⊆ live participant, enforced again at
   *  delivery). Returns the agent id only when a NEW agent follower row was
   *  inserted. */
  private followMessageAuthor(
    tx: MessageTxScope,
    conversationId: string,
    threadRootId: string,
    msg: MessageDto,
    source: ThreadFollowerSource,
    currentSeq: number,
  ): string | null {
    if (msg.from_kind === 'agent' && msg.from_agent_id) {
      return this.followAgent(
        tx,
        conversationId,
        threadRootId,
        msg.from_agent_id,
        source,
        currentSeq,
      )
        ? msg.from_agent_id
        : null;
    } else if (msg.from_kind === 'user' && msg.from_user_id) {
      this.followUser(tx, conversationId, threadRootId, msg.from_user_id, source);
    }
    return null;
  }

  /** Upsert an agent follower; if it is newly followed AND a current live
   *  participant, backfill the thread's prior history into its inbox.
   *  Non-participants are skipped (follower ⊆ live participant). Returns whether
   *  a NEW follower row was created (false = already following or not a
   *  participant → no backfill). */
  private followAgent(
    tx: MessageTxScope,
    conversationId: string,
    threadRootId: string,
    agentId: string,
    source: ThreadFollowerSource,
    currentSeq: number,
  ): boolean {
    if (!tx.conversations.isAgentParticipant(conversationId, agentId)) return false;
    const { inserted } = tx.threadFollowers.upsert({
      threadRootId,
      conversationId,
      principalKind: 'agent',
      principalId: agentId,
      source,
    });
    if (inserted) {
      this.backfillThreadHistory(tx, conversationId, threadRootId, agentId, currentSeq);
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
    tx: MessageTxScope,
    conversationId: string,
    threadRootId: string,
    agentId: string,
    currentSeq: number,
  ): void {
    const root = tx.messages.getInConversation(conversationId, threadRootId);
    if (root && !(root.from_kind === 'agent' && root.from_agent_id === agentId)) {
      tx.inboxes.ensureDelivery(conversationId, agentId, root.id, 'observe');
    }
    const replies = tx.messages.listStreamBelowSeq(
      conversationId,
      threadRootId,
      currentSeq,
    );
    for (const reply of replies) {
      if (reply.from_kind === 'agent' && reply.from_agent_id === agentId) continue;
      tx.inboxes.ensureDelivery(conversationId, agentId, reply.id, 'observe');
    }
  }

  /** Upsert a HUMAN follower — the human twin of {@link followAgent}, and the
   *  ONE place a human follower row is written, so `follower ⊆ live participant`
   *  is asked once per principal kind rather than at each insertion site.
   *
   *  A point check, not a participant SET: the question is about ONE person, the
   *  authority answers it directly, and the set form (a `listParticipantUserIds`
   *  enumeration, memoized per send) existed only because its predecessor was a
   *  roster listing. There is no backfill twin either — a human has no inbox, so
   *  becoming a follower queues nothing. */
  private followUser(
    tx: MessageTxScope,
    conversationId: string,
    threadRootId: string,
    userId: string,
    source: ThreadFollowerSource,
  ): void {
    if (!tx.conversations.isUserParticipant(conversationId, userId)) return;
    tx.threadFollowers.upsert({
      threadRootId,
      conversationId,
      principalKind: 'human',
      principalId: userId,
      source,
    });
  }
}
