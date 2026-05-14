import type { Database as Db } from 'better-sqlite3';
import type { MessageRow } from '@silverhand/shared';

/**
 * Queues messages destined for an agent that was not reachable when the
 * message was posted. Drained on spawn and at safe delivery boundaries.
 */

export interface PendingConversationInboxItem {
  inboxId: number;
  message: MessageRow;
}

type JoinedRow = MessageRow & { inbox_id: number };
type DeliveryRow = {
  id: number;
  delivered_at: number | null;
};

export interface ConversationDeliveryRecord {
  inboxId: number;
  deliveredAt: number | null;
}

export class ConversationInboxRepo {
  constructor(private readonly db: Db) {}

  enqueue(
    conversationId: string,
    agentId: string,
    messageId: string,
  ): ConversationDeliveryRecord {
    return this.ensureDelivery(conversationId, agentId, messageId);
  }

  ensureDelivery(
    conversationId: string,
    agentId: string,
    messageId: string,
  ): ConversationDeliveryRecord {
    this.db
      .prepare(
        `INSERT INTO conversation_inboxes
         (conversation_id, agent_id, message_id, delivered_at, created_at)
         VALUES (?, ?, ?, NULL, ?)
         ON CONFLICT(conversation_id, agent_id, message_id) DO NOTHING`,
      )
      .run(conversationId, agentId, messageId, Date.now());
    const row = this.deliveryRow(conversationId, agentId, messageId);
    if (!row) throw new Error('conversation inbox delivery lookup failed');
    return { inboxId: row.id, deliveredAt: row.delivered_at };
  }

  listPending(
    conversationId: string,
    agentId: string,
  ): PendingConversationInboxItem[] {
    const rows = this.db
      .prepare<[string, string], JoinedRow>(
        `SELECT i.id AS inbox_id, m.*
         FROM conversation_inboxes i
         JOIN messages m ON m.id = i.message_id
         WHERE i.conversation_id = ?
           AND i.agent_id = ?
           AND i.delivered_at IS NULL
         ORDER BY i.id ASC`,
      )
      .all(conversationId, agentId);
    return rows.map(({ inbox_id, ...message }) => ({
      inboxId: inbox_id,
      message,
    }));
  }

  markDelivered(inboxIds: number[]): void {
    if (inboxIds.length === 0) return;
    const now = Date.now();
    const stmt = this.db.prepare(
      `UPDATE conversation_inboxes SET delivered_at = ? WHERE id = ?`,
    );
    const tx = this.db.transaction((ids: number[]) => {
      for (const id of ids) stmt.run(now, id);
    });
    tx(inboxIds);
  }

  countPendingForAgent(agentId: string): number {
    const row = this.db
      .prepare<[string], { c: number }>(
        `SELECT COUNT(*) AS c
         FROM conversation_inboxes
         WHERE agent_id = ? AND delivered_at IS NULL`,
      )
      .get(agentId);
    return row?.c ?? 0;
  }

  private deliveryRow(
    conversationId: string,
    agentId: string,
    messageId: string,
  ): DeliveryRow | null {
    const row = this.db
      .prepare<[string, string, string], DeliveryRow>(
        `SELECT id, delivered_at
         FROM conversation_inboxes
         WHERE conversation_id = ?
           AND agent_id = ?
           AND message_id = ?`,
      )
      .get(conversationId, agentId, messageId);
    return row ?? null;
  }
}
