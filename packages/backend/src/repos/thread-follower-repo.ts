import type { Database as Db } from 'better-sqlite3';
import type {
  ThreadFollowerRow,
  ThreadFollowerSource,
} from '@silverhand/shared';
import { agentParticipatesCorrelated } from './conversation-placement-sql.js';

/**
 * Thread followers are a delivery/notification subscription, NOT a
 * permission. `follower ⊆ live participant of the parent conversation` is
 * enforced at query time (see
 * {@link ThreadFollowerRepo.listFollowerAgentIdsParticipating}), never as a table
 * invariant — the follower table is not authoritative, the PLACEMENT is
 * (agent-scoped-session-v1 §4.2). See docs/thread-reply-cluster-v1.md §4.1/§5/§9.
 *
 * A thread is identified by its root message id; replies carry
 * `messages.thread_root_id = <root id>` (the root itself has NULL).
 */

export interface ThreadFollowerUpsert {
  threadRootId: string;
  conversationId: string;
  principalKind: 'human' | 'agent';
  principalId: string;
  source: ThreadFollowerSource;
}

export class ThreadFollowerRepo {
  constructor(private readonly db: Db) {}

  /**
   * Idempotent follow registration. `source` records the INITIAL entry
   * point and is immutable: an existing row keeps its original
   * `source`/`followed_at` (`ON CONFLICT DO NOTHING`), so a later mention
   * never rewrites a `manual` follow's provenance (§5).
   *
   * Returns whether a NEW row was inserted — the caller uses this to drive
   * one-time historical catch-up backfill for a principal that is becoming
   * a follower now (§6.1). A repeat follow returns `inserted: false` and
   * must not re-backfill.
   */
  upsert(params: ThreadFollowerUpsert): { inserted: boolean } {
    const changes = this.db
      .prepare(
        `INSERT INTO thread_followers
           (thread_root_id, conversation_id, principal_kind, principal_id,
            followed_at, source)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(thread_root_id, principal_kind, principal_id)
           DO NOTHING`,
      )
      .run(
        params.threadRootId,
        params.conversationId,
        params.principalKind,
        params.principalId,
        Date.now(),
        params.source,
      ).changes;
    return { inserted: changes === 1 };
  }

  /** Remove a follower row (voluntary unfollow, §5). Idempotent — returns
   *  whether a row was actually deleted. A later mention/reply re-follows
   *  via {@link upsert} (auto-follow is idempotent over unfollow state). */
  remove(
    threadRootId: string,
    principalKind: 'human' | 'agent',
    principalId: string,
  ): { removed: boolean } {
    const changes = this.db
      .prepare(
        `DELETE FROM thread_followers
          WHERE thread_root_id = ?
            AND principal_kind = ?
            AND principal_id = ?`,
      )
      .run(threadRootId, principalKind, principalId).changes;
    return { removed: changes === 1 };
  }

  isFollower(
    threadRootId: string,
    principalKind: 'human' | 'agent',
    principalId: string,
  ): boolean {
    const row = this.db
      .prepare<[string, string, string], { one: 1 }>(
        `SELECT 1 AS one
           FROM thread_followers
          WHERE thread_root_id = ?
            AND principal_kind = ?
            AND principal_id = ?
          LIMIT 1`,
      )
      .get(threadRootId, principalKind, principalId);
    return row !== undefined;
  }

  listFollowers(threadRootId: string): ThreadFollowerRow[] {
    return this.db
      .prepare<[string], ThreadFollowerRow>(
        `SELECT * FROM thread_followers
          WHERE thread_root_id = ?
          ORDER BY followed_at ASC`,
      )
      .all(threadRootId);
  }

  /**
   * Agent followers that are CURRENT PARTICIPANTS of the thread's conversation —
   * the delivery/notification read of the follower table (invariant 7): a
   * principal whose follower row lingers after it lost participation is excluded,
   * so a revoked seat cannot keep receiving replies on the strength of an old
   * follower row.
   *
   * The gate is `agentParticipatesCorrelated`, the ONE placement authority read in
   * its correlated form — not the `JOIN conversation_agents` this replaced
   * (#task:2021 P4-5). The roster join answered only the workspace arm, so on a
   * `direct_pair` / `agent_inbox` thread it returned ZERO followers and a reply
   * delivered to nobody; and because both principal kinds now ask the same
   * authority (an agent through this correlated form, a human through the point
   * form in `followUser`), "follower ⊆ live participant" is one sentence about
   * placement rather than two roster-shaped approximations.
   *
   * `JOIN agents a` is the LIVENESS conjunct and is load-bearing for the same
   * reason as in `listParticipantAgentIds`: participation survives an endpoint
   * tombstone on purpose, delivery must not.
   *
   * IDS ONLY. Every caller (the send's delivery plan, the thread-follower read
   * surface) read `agent_id` and nothing else; the seat columns this used to
   * project do not exist for a rosterless participant.
   */
  listFollowerAgentIdsParticipating(threadRootId: string): string[] {
    return this.db
      .prepare<[string], { agent_id: string }>(
        `SELECT tf.principal_id AS agent_id
           FROM thread_followers tf
           JOIN conversations c ON c.id = tf.conversation_id
           JOIN agents a ON a.id = tf.principal_id
          WHERE tf.thread_root_id = ?
            AND tf.principal_kind = 'agent'
            AND ${agentParticipatesCorrelated('c', 'a.id')}
          ORDER BY tf.followed_at ASC`,
      )
      .all(threadRootId)
      .map(r => r.agent_id);
  }
}
