import type { Database as Db } from 'better-sqlite3';
import type { MessageRow } from '@silverhand/shared';

/**
 * Queues messages destined for an agent that was not reachable when the
 * message was posted. Drained on spawn and at safe delivery boundaries.
 */

/** Per-delivery semantics (§6.2). `turn`: the agent was @mentioned /
 *  explicitly targeted and should consider responding. `observe`: the agent
 *  is a thread follower; the message enters its context but does not demand a
 *  response. Decided at delivery creation, persisted, never re-derived. */
export type InboxDeliveryKind = 'turn' | 'observe';

export interface PendingConversationInboxItem {
  inboxId: number;
  message: MessageRow;
  deliveryKind: InboxDeliveryKind;
}

export interface ClaimedConversationInboxItem extends PendingConversationInboxItem {
  inFlightOwner: string;
}

type JoinedRow = MessageRow & { inbox_id: number; delivery_kind: string | null };
type DeliveryRow = {
  id: number;
  delivered_at: number | null;
};

/** Pre-v44 rows and plain main-line deliveries store NULL → read as 'turn',
 *  preserving the legacy behavior where every delivered message is
 *  response-eligible. */
function coalesceDeliveryKind(raw: string | null): InboxDeliveryKind {
  return raw === 'observe' ? 'observe' : 'turn';
}

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
    deliveryKind: InboxDeliveryKind = 'turn',
  ): ConversationDeliveryRecord {
    return this.ensureDelivery(conversationId, agentId, messageId, deliveryKind);
  }

  ensureDelivery(
    conversationId: string,
    agentId: string,
    messageId: string,
    deliveryKind: InboxDeliveryKind = 'turn',
  ): ConversationDeliveryRecord {
    this.db
      .prepare(
        `INSERT INTO conversation_inboxes
         (conversation_id, agent_id, message_id, delivered_at, delivery_kind, created_at)
         VALUES (?, ?, ?, NULL, ?, ?)
         ON CONFLICT(conversation_id, agent_id, message_id) DO NOTHING`,
      )
      .run(conversationId, agentId, messageId, deliveryKind, Date.now());
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
        `SELECT i.id AS inbox_id, i.delivery_kind, m.*
         FROM conversation_inboxes i
         JOIN messages m ON m.id = i.message_id
         WHERE i.conversation_id = ?
           AND i.agent_id = ?
           AND i.delivered_at IS NULL
           AND i.failed_at IS NULL
           AND i.in_flight_owner IS NULL
         ORDER BY i.id ASC`,
      )
      .all(conversationId, agentId);
    return rows.map(({ inbox_id, delivery_kind, ...message }) => ({
      inboxId: inbox_id,
      message,
      deliveryKind: coalesceDeliveryKind(delivery_kind),
    }));
  }

  markDelivered(inboxIds: number[]): void {
    if (inboxIds.length === 0) return;
    const now = Date.now();
    const stmt = this.db.prepare(
      `UPDATE conversation_inboxes
          SET delivered_at = ?,
              in_flight_owner = NULL,
              in_flight_at = NULL
        WHERE id = ?`,
    );
    const tx = this.db.transaction((ids: number[]) => {
      for (const id of ids) stmt.run(now, id);
    });
    tx(inboxIds);
  }

  claimPending(
    conversationId: string,
    agentId: string,
    inFlightOwner: string,
  ): ClaimedConversationInboxItem[] {
    const now = Date.now();
    // `in_flight_at` is written for rotation/reconnect diagnostics and a
    // future stale in-flight watchdog. Current replay correctness is owned by
    // the per-connection `in_flight_owner` lease plus disconnect sweep.
    const select = this.db.prepare<[string, string], JoinedRow>(
      `SELECT i.id AS inbox_id, i.delivery_kind, m.*
         FROM conversation_inboxes i
         JOIN messages m ON m.id = i.message_id
        WHERE i.conversation_id = ?
          AND i.agent_id = ?
          AND i.delivered_at IS NULL
          AND i.failed_at IS NULL
          AND i.in_flight_owner IS NULL
        ORDER BY i.id ASC`,
    );
    const update = this.db.prepare(
      `UPDATE conversation_inboxes
          SET in_flight_owner = ?,
              in_flight_at = ?
        WHERE id = ?
          AND delivered_at IS NULL
          AND failed_at IS NULL
          AND in_flight_owner IS NULL`,
    );
    return this.db.transaction(() => {
      const rows = select.all(conversationId, agentId);
      const claimed: ClaimedConversationInboxItem[] = [];
      for (const { inbox_id, delivery_kind, ...message } of rows) {
        const changed = update.run(inFlightOwner, now, inbox_id).changes;
        if (changed === 0) continue;
        claimed.push({
          inboxId: inbox_id,
          message,
          deliveryKind: coalesceDeliveryKind(delivery_kind),
          inFlightOwner,
        });
      }
      return claimed;
    }).exclusive();
  }

  rollbackInFlight(
    inboxIds: readonly number[],
    inFlightOwner: string,
  ): void {
    if (inboxIds.length === 0) return;
    const stmt = this.db.prepare(
      `UPDATE conversation_inboxes
          SET in_flight_owner = NULL,
              in_flight_at = NULL
        WHERE id = ?
          AND in_flight_owner = ?
          AND delivered_at IS NULL
          AND failed_at IS NULL`,
    );
    const tx = this.db.transaction((ids: readonly number[]) => {
      for (const id of ids) stmt.run(id, inFlightOwner);
    });
    tx.exclusive(inboxIds);
  }

  rollbackInFlightAnyOwner(inboxIds: readonly number[]): void {
    if (inboxIds.length === 0) return;
    const stmt = this.db.prepare(
      `UPDATE conversation_inboxes
          SET in_flight_owner = NULL,
              in_flight_at = NULL
        WHERE id = ?
          AND delivered_at IS NULL
          AND failed_at IS NULL`,
    );
    const tx = this.db.transaction((ids: readonly number[]) => {
      for (const id of ids) stmt.run(id);
    });
    tx.exclusive(inboxIds);
  }

  rollbackInFlightForOwner(inFlightOwner: string): void {
    this.db.prepare(
      `UPDATE conversation_inboxes
          SET in_flight_owner = NULL,
              in_flight_at = NULL
        WHERE in_flight_owner = ?
          AND delivered_at IS NULL
          AND failed_at IS NULL`,
    ).run(inFlightOwner);
  }

  listInFlightForOwner(inFlightOwner: string): ConversationDeliveryRecord[] {
    const rows = this.db
      .prepare<[string], DeliveryRow>(
        `SELECT id, delivered_at
           FROM conversation_inboxes
          WHERE in_flight_owner = ?
            AND delivered_at IS NULL
            AND failed_at IS NULL
          ORDER BY id ASC`,
      )
      .all(inFlightOwner);
    return rows.map(row => ({
      inboxId: row.id,
      deliveredAt: row.delivered_at,
    }));
  }

  countPendingForAgent(agentId: string): number {
    const row = this.db
      .prepare<[string], { c: number }>(
        `SELECT COUNT(*) AS c
         FROM conversation_inboxes
         WHERE agent_id = ?
           AND delivered_at IS NULL
           AND failed_at IS NULL
           AND in_flight_owner IS NULL`,
      )
      .get(agentId);
    return row?.c ?? 0;
  }

  /**
   * D4.b P1-2 idempotency helper: number of inbox rows currently
   * claimed (`in_flight_owner` non-null) for a given (conv, agent)
   * pair, regardless of which connection owns the claim. Used by
   * `OutboundRuntimeEventFanout.startDeliveryBacked` to detect the
   * race window between auto-drain claiming a pending row and the
   * explicit `runtimeHost.start` call landing — both want to start
   * the runtime, but only one needs to dispatch `runtime_start`.
   */
  countInFlightForPair(conversationId: string, agentId: string): number {
    const row = this.db
      .prepare<[string, string], { c: number }>(
        `SELECT COUNT(*) AS c
           FROM conversation_inboxes
          WHERE conversation_id = ?
            AND agent_id = ?
            AND in_flight_owner IS NOT NULL
            AND delivered_at IS NULL
            AND failed_at IS NULL`,
      )
      .get(conversationId, agentId);
    return row?.c ?? 0;
  }

  hasUndeliveredForPair(conversationId: string, agentId: string): boolean {
    const row = this.db
      .prepare<[string, string], { one: 1 }>(
        `SELECT 1 AS one
           FROM conversation_inboxes
          WHERE conversation_id = ?
            AND agent_id = ?
            AND delivered_at IS NULL
            AND failed_at IS NULL
          LIMIT 1`,
      )
      .get(conversationId, agentId);
    return row !== undefined;
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
