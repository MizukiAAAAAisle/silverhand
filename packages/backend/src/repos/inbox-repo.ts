import type { Database as Db } from 'better-sqlite3';
import type { MessageRow } from '@silverhand/shared';

/**
 * `agent_inboxes` queues messages destined for an agent that wasn't
 * reachable when the message was posted (asleep, mid-tool-chain, etc).
 * Drained on spawn (§3.1 "C 档") and at safe boundaries for gated
 * deliveries (§3.1 gated steering, Phase 3E).
 */

export interface PendingInboxItem {
  inboxId: number;
  message: MessageRow;
}

type JoinedRow = MessageRow & { inbox_id: number };

export class InboxRepo {
  constructor(private readonly db: Db) {}

  /** Append a message to one agent's inbox in one session. */
  enqueue(sessionId: string, agentId: string, messageId: string): void {
    this.db
      .prepare(
        `INSERT INTO agent_inboxes
         (session_id, agent_id, message_id, delivered_at, created_at)
         VALUES (?, ?, ?, NULL, ?)`,
      )
      .run(sessionId, agentId, messageId, Date.now());
  }

  /** Pending = `delivered_at IS NULL`, ordered by enqueue time.
   *  Joined with messages so the caller has the full content. */
  listPending(sessionId: string, agentId: string): PendingInboxItem[] {
    const rows = this.db
      .prepare<[string, string], JoinedRow>(
        `SELECT i.id AS inbox_id, m.*
         FROM agent_inboxes i
         JOIN messages m ON m.id = i.message_id
         WHERE i.session_id = ? AND i.agent_id = ? AND i.delivered_at IS NULL
         ORDER BY i.id ASC`,
      )
      .all(sessionId, agentId);
    return rows.map(({ inbox_id, ...message }) => ({
      inboxId: inbox_id,
      message,
    }));
  }

  markDelivered(inboxIds: number[]): void {
    if (inboxIds.length === 0) return;
    const now = Date.now();
    const stmt = this.db.prepare(
      `UPDATE agent_inboxes SET delivered_at = ? WHERE id = ?`,
    );
    const tx = this.db.transaction((ids: number[]) => {
      for (const id of ids) stmt.run(now, id);
    });
    tx(inboxIds);
  }

  /** Total pending across every session for one agent. Used by the
   *  agent delete-impact preview so the user knows how many queued
   *  deliveries will be discarded along with the agent. */
  countPendingForAgent(agentId: string): number {
    const row = this.db
      .prepare<[string], { c: number }>(
        `SELECT COUNT(*) AS c FROM agent_inboxes
         WHERE agent_id = ? AND delivered_at IS NULL`,
      )
      .get(agentId);
    return row?.c ?? 0;
  }
}
