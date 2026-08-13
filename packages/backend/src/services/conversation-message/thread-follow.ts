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
import { extractMentions } from '@silverhand/shared';
import type { MessageDto, ThreadFollowerSource } from '@silverhand/shared';
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
      followerAgentIds: this.read
        .listFollowerAgentsVisible(threadRootId)
        .map(f => f.agent_id),
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
   *   - every @mentioned principal that is a current channel member
   *     (`source='mention'`).
   * For each AGENT principal becoming a follower now (newly-inserted row)
   * that is a current channel member, backfills the thread's prior replies
   * (plus the root) into its inbox. Returns the follower-gated delivery plan
   * for the current reply, executed best-effort after commit.
   */
  applyThreadFollowEffects(
    tx: MessageTxScope,
    params: {
      conversationId: string;
      threadRootId: string;
      message: MessageDto;
      actor: SendMessageActor;
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

    // @mentioned channel members → follower. Mention no longer changes
    // delivery kind because current thread messages already turn every
    // visible follower agent; it still creates a follower row for the mention.
    // Non-members are never followed via mention (§4.1: follow is not a
    // membership backdoor); their visibility is filtered at delivery anyway.
    let userMemberIds: Set<string> | null = null;
    for (const handle of new Set(extractMentions(message.content))) {
      const agent = tx.agents.getByName(handle);
      if (agent && tx.conversations.getAgent(conversationId, agent.id)) {
        this.followAgent(tx, conversationId, threadRootId, agent.id, 'mention', currentSeq);
        continue;
      }
      const user = tx.users.getByName(handle);
      if (user) {
        userMemberIds ??= this.conversationUserMemberIds(tx, conversationId);
        if (userMemberIds.has(user.id)) {
          tx.threadFollowers.upsert({
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
    // excluding the sender. Read through the TRANSACTION scope — the plan must
    // see the follower rows this method just inserted, which a captured
    // out-of-transaction read would miss on any engine that does not share one
    // connection. Current thread messages match channel delivery: every
    // recipient gets a `turn`; `observe` is only used for historical backfill
    // and other non-waking context paths.
    const senderAgentId =
      message.from_kind === 'agent' ? message.from_agent_id : null;
    const recipients: ThreadDeliveryRecipient[] = tx.threadFollowers
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
      if (this.conversationUserMemberIds(tx, conversationId).has(msg.from_user_id)) {
        tx.threadFollowers.upsert({
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
    tx: MessageTxScope,
    conversationId: string,
    threadRootId: string,
    agentId: string,
    source: ThreadFollowerSource,
    currentSeq: number,
  ): boolean {
    if (!tx.conversations.getAgent(conversationId, agentId)) return false;
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

  private conversationUserMemberIds(
    tx: MessageTxScope,
    conversationId: string,
  ): Set<string> {
    return new Set(tx.conversations.listUserMemberIds(conversationId));
  }
}
