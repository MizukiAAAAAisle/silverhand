import type { Database as Db } from 'better-sqlite3';
import type {
  ConversationAgentDto,
  ConversationAgentRow,
  ThreadFollowerRow,
  ThreadFollowerSource,
} from '@silverhand/shared';

/**
 * Thread followers are a delivery/notification subscription, NOT a
 * permission. `follower ⊆ parent channel member` is enforced at
 * query time (see {@link ThreadFollowerRepo.listFollowerAgentsVisible}),
 * never as a table invariant — the follower table is not authoritative,
 * channel membership is. See docs/thread-reply-cluster-v1.md §4.1/§5/§9.
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
   * Agent followers that are CURRENTLY channel members. The inner join on
   * `conversation_agents` is the visibility filter (invariant 7): a
   * principal whose follower row lingers after it lost channel membership
   * is excluded, so delivery never reaches a non-member. Shape mirrors
   * {@link import('./conversation-repo.js').ConversationRepo.listAgents}
   * so the send path's delivery/auto-start planning can consume followers
   * and plain channel members uniformly.
   */
  listFollowerAgentsVisible(threadRootId: string): ConversationAgentDto[] {
    return this.db
      .prepare<[string], ConversationAgentRow>(
        `SELECT ca.*
           FROM thread_followers tf
           JOIN conversation_agents ca
             ON ca.conversation_id = tf.conversation_id
            AND ca.agent_id = tf.principal_id
          WHERE tf.thread_root_id = ?
            AND tf.principal_kind = 'agent'
          ORDER BY ca.joined_at ASC`,
      )
      .all(threadRootId)
      .map(r => ({ ...r }));
  }
}
