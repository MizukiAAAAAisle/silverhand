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

export interface ConversationInboxSettlement {
  conversationId: string;
  agentId: string;
  inFlightOwner: string;
  inboxIds: readonly number[];
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

  /** Every origin conversation with pending custody for one AgentSlot.
   * Ordered by first inbox id so reconnect replay preserves global arrival
   * order across targets without treating Board/workspace as authority. */
  listPendingConversationIdsForAgent(agentId: string): string[] {
    return this.db
      .prepare<[string], { conversation_id: string }>(
        `SELECT conversation_id
           FROM conversation_inboxes
          WHERE agent_id = ?
            AND delivered_at IS NULL
            AND failed_at IS NULL
            AND in_flight_owner IS NULL
          GROUP BY conversation_id
          ORDER BY MIN(id) ASC`,
      )
      .all(agentId)
      .map(row => row.conversation_id);
  }

  settleDelivered(settlement: ConversationInboxSettlement): boolean {
    return this.settle(settlement, 'delivered');
  }

  settleUndelivered(settlement: ConversationInboxSettlement): boolean {
    return this.settle(settlement, 'pending');
  }

  private settle(
    settlement: ConversationInboxSettlement,
    disposition: 'delivered' | 'pending',
  ): boolean {
    const inboxIds = [...settlement.inboxIds];
    if (inboxIds.length === 0 || new Set(inboxIds).size !== inboxIds.length) {
      return false;
    }
    const now = Date.now();
    const owns = this.db.prepare(
      `SELECT 1
         FROM conversation_inboxes
        WHERE id = ?
          AND conversation_id = ?
          AND agent_id = ?
          AND in_flight_owner = ?
          AND delivered_at IS NULL
          AND failed_at IS NULL`,
    );
    const delivered = this.db.prepare(
      `UPDATE conversation_inboxes
          SET delivered_at = ?, in_flight_owner = NULL, in_flight_at = NULL
        WHERE id = ? AND conversation_id = ? AND agent_id = ?
          AND in_flight_owner = ? AND delivered_at IS NULL AND failed_at IS NULL`,
    );
    const pending = this.db.prepare(
      `UPDATE conversation_inboxes
          SET in_flight_owner = NULL, in_flight_at = NULL
        WHERE id = ? AND conversation_id = ? AND agent_id = ?
          AND in_flight_owner = ? AND delivered_at IS NULL AND failed_at IS NULL`,
    );
    const tx = this.db.transaction(() => {
      for (const id of inboxIds) {
        if (!owns.get(
          id,
          settlement.conversationId,
          settlement.agentId,
          settlement.inFlightOwner,
        )) return false;
      }
      for (const id of inboxIds) {
        const args = [
          id,
          settlement.conversationId,
          settlement.agentId,
          settlement.inFlightOwner,
        ] as const;
        const changes = disposition === 'delivered'
          ? delivered.run(now, ...args).changes
          : pending.run(...args).changes;
        if (changes !== 1) {
          throw new Error('conversation inbox settlement lost custody inside transaction');
        }
      }
      return true;
    });
    return tx.exclusive();
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

  /** Return every in-flight delivery for an agent to pending custody. */
  rollbackInFlightForAgent(agentId: string): string[] {
    return this.db.transaction(() => {
      const rows = this.db
        .prepare<[string], { conversation_id: string }>(
          `SELECT DISTINCT conversation_id
             FROM conversation_inboxes
            WHERE agent_id = ?
              AND in_flight_owner IS NOT NULL
              AND delivered_at IS NULL
              AND failed_at IS NULL`,
        )
        .all(agentId);
      this.db
        .prepare(
          `UPDATE conversation_inboxes
              SET in_flight_owner = NULL,
                  in_flight_at = NULL
            WHERE agent_id = ?
              AND in_flight_owner IS NOT NULL
              AND delivered_at IS NULL
              AND failed_at IS NULL`,
        )
        .run(agentId);
      return rows.map(row => row.conversation_id);
    }).exclusive();
  }

  rollbackInFlightForPairExceptOwner(
    conversationId: string,
    agentId: string,
    currentOwner: string,
  ): number {
    const result = this.db.prepare(
      `UPDATE conversation_inboxes
          SET in_flight_owner = NULL,
              in_flight_at = NULL
        WHERE conversation_id = ?
          AND agent_id = ?
          AND in_flight_owner IS NOT NULL
          AND in_flight_owner != ?
          AND delivered_at IS NULL
          AND failed_at IS NULL`,
    ).run(conversationId, agentId, currentOwner);
    return result.changes;
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

  countQueuedForAgent(agentId: string): number {
    const row = this.db
      .prepare<[string], { c: number }>(
        `SELECT COUNT(*) AS c
           FROM conversation_inboxes
          WHERE agent_id = ?
            AND delivered_at IS NULL
            AND failed_at IS NULL`,
      )
      .get(agentId);
    return row?.c ?? 0;
  }

  countQueuedForPair(conversationId: string, agentId: string): number {
    const row = this.db
      .prepare<[string, string], { c: number }>(
        `SELECT COUNT(*) AS c
           FROM conversation_inboxes
          WHERE conversation_id = ? AND agent_id = ?
            AND delivered_at IS NULL
            AND failed_at IS NULL`,
      )
      .get(conversationId, agentId);
    return row?.c ?? 0;
  }

  /** Pending pairs created during a transition, excluding historical backlog. */
  listPendingConversationIdsForAgentSince(
    agentId: string,
    createdAtOrAfter: number,
  ): string[] {
    const rows = this.db
      .prepare<[string, number], { conversation_id: string }>(
        `SELECT DISTINCT conversation_id
           FROM conversation_inboxes
          WHERE agent_id = ?
            AND delivered_at IS NULL
            AND failed_at IS NULL
            AND created_at >= ?
          ORDER BY conversation_id ASC`,
      )
      .all(agentId, createdAtOrAfter);
    return rows.map(row => row.conversation_id);
  }

  /**
   * D4.b P1-2 idempotency helper: number of inbox rows currently
   * claimed by the live connection for a given (conv, agent) pair.
   * Claims from old connection ids are stale leases; they must not
   * make a later explicit start look successful.
   */
  countInFlightForPairOwner(
    conversationId: string,
    agentId: string,
    inFlightOwner: string,
  ): number {
    const row = this.db
      .prepare<[string, string, string], { c: number }>(
        `SELECT COUNT(*) AS c
           FROM conversation_inboxes
          WHERE conversation_id = ?
            AND agent_id = ?
            AND in_flight_owner = ?
            AND delivered_at IS NULL
            AND failed_at IS NULL`,
      )
      .get(conversationId, agentId, inFlightOwner);
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

  /** Agent-scope freshness guard (#task:2095): does this agent-runtime have
   *  ANY undelivered inbox row across ALL its conversations/streams? Boolean
   *  existence, never a seq comparison — immune to rowid reuse. Mirrors
   *  {@link hasUndeliveredForPair} for the `RuntimeScope.kind === 'agent'`
   *  arm. Its predicate (`delivered_at IS NULL AND failed_at IS NULL`,
   *  in-flight rows INCLUDED) is DELIBERATELY BROADER than the drain side:
   *  `listPending` / `listPendingConversationIdsForAgent` (what the delivery
   *  side's `pendingOriginsForRuntime` and stale-receive pull) additionally
   *  require `in_flight_owner IS NULL`. So guard ⊇ drain, and the difference is
   *  EXACTLY the in-flight set — which is the one residual window this design
   *  accepts (the worst-case single self-healing 409): a runtime whose only
   *  undelivered rows are in-flight reads stale here yet drains nothing, until
   *  those leases settle (delivery ack) or are swept
   *  (`outbound-event-fanout.ts:1283-1289`, start/disconnect, no time expiry).
   *  Do NOT read this as "guard scope ≡ drain scope"; it is a strict superset. */
  hasUndeliveredForAgent(agentId: string): boolean {
    const row = this.db
      .prepare<[string], { one: 1 }>(
        `SELECT 1 AS one
           FROM conversation_inboxes
          WHERE agent_id = ?
            AND delivered_at IS NULL
            AND failed_at IS NULL
          LIMIT 1`,
      )
      .get(agentId);
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
