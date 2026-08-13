/**
 * #task:1677 — workspace-delete cascade complexity falsifier.
 *
 * Deleting a workspace is ONE row delete that fans out through FK
 * actions. For every parent row the cascade touches, SQLite runs an
 * internal `child_col = ?` probe on each referencing child table; a
 * child column with no leftmost-prefix index turns that probe into a
 * full table scan, so a SMALL workspace's delete is amplified by
 * GLOBAL table sizes (production incident #task:1674: 2 conversations /
 * 156 messages took 14.3s on disk; 9.9ms once indexed). Migration v61
 * adds the missing child-FK indexes.
 *
 * Verdict layering (review boundary, 2026-07-27):
 *   1. STRUCTURE carries the complexity verdict — every child key on
 *      the cascade path must have a NON-PARTIAL leftmost index, and
 *      the FK-shaped probe's query plan must not be a table SCAN.
 *      Machine-independent; fails deterministically if v61's coverage
 *      regresses (e.g. a future table rebuild drops an index).
 *   2. WALL-CLOCK is only a loose regression cap on the end-to-end
 *      delete: in-memory SQLite is fast enough that even the UNINDEXED
 *      cascade at this fixture scale measures ~320ms (calibrated at
 *      v60), so tight timing could never separate the complexity
 *      classes without CI flake.
 */
import { describe, expect, it } from 'vitest';
import { performance } from 'node:perf_hooks';
import { openTestDb } from './utils/db.js';

const BULK_MESSAGES = 30_000;
const BULK_INBOX_ROWS = 60_000;
const BULK_NOTIFICATIONS = 20_000;
/** Loose regression cap only — the structural assertions carry the
 *  complexity verdict. Indexed reality at this scale is single-digit ms. */
const DELETE_BUDGET_MS = 1_500;

/** Every child FK key on the workspace-delete cascade tree that v61
 *  covers (table, child column). Must stay in sync with migration v61. */
const CASCADE_CHILD_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['messages', 'thread_root_id'],
  ['conversation_inboxes', 'message_id'],
  ['notifications', 'workspace_id'],
  ['notifications', 'source_workspace_id'],
  ['notifications', 'message_id'],
  ['notifications', 'source_message_id'],
  ['saved_messages', 'conversation_id'],
  ['saved_messages', 'message_id'],
  ['conversation_reads', 'thread_root_id'],
  ['conversation_stream_heads', 'conversation_id'],
  ['conversation_stream_heads', 'thread_root_id'],
  ['thread_followers', 'conversation_id'],
];

describe('#task:1677 — workspace delete cascade stays indexed', () => {
  it('every cascade child key has a non-partial leftmost index and its FK probe plan is a SEARCH, not a SCAN', () => {
    const { db } = openTestDb();
    for (const [table, column] of CASCADE_CHILD_KEYS) {
      // Structural pin: a NON-PARTIAL index whose FIRST column is the
      // child key. Partial indexes are excluded on purpose — FK
      // enforcement probes are internal statements and coverage must
      // not depend on partial-predicate implication.
      const indexes = db
        .prepare(`SELECT name, [partial] FROM pragma_index_list(?)`)
        .all(table) as Array<{ name: string; partial: number }>;
      const covering = indexes.filter(ix => {
        if (ix.partial) return false;
        const first = db
          .prepare(`SELECT name FROM pragma_index_info(?) WHERE seqno = 0`)
          .get(ix.name) as { name: string } | undefined;
        return first?.name === column;
      });
      expect(covering.length, `${table}.${column} needs a non-partial leftmost index`).toBeGreaterThan(0);

      // Plan pin: the exact probe shape FK enforcement issues must use
      // an index. EXPLAIN QUERY PLAN reports `SCAN <table>` for a full
      // scan and `SEARCH <table> USING ...` for an index probe.
      const plan = db
        .prepare(`EXPLAIN QUERY PLAN SELECT 1 FROM ${table} WHERE ${column} = ?`)
        .all('probe') as Array<{ detail: string }>;
      const detail = plan.map(r => r.detail).join(' | ');
      expect(detail, `${table}.${column} probe plan`).toContain('SEARCH');
      expect(detail, `${table}.${column} probe plan`).not.toMatch(/^SCAN /);
    }
    db.close();
  });

  it('deleting a small workspace is not amplified by unrelated global table sizes', () => {
    const { db, localHostId } = openTestDb();
    const now = Date.now();

    const insertAgent = db.prepare(
      `INSERT INTO agents (id, name, runtime, host_id, created_at, updated_at, created_by_user_id)
       VALUES (?, ?, 'claude', ?, ?, ?, 'local')`,
    );
    const insertWorkspace = db.prepare(
      `INSERT INTO workspaces (id, name, workspace_kind, owner_user_id, created_at, updated_at)
       VALUES (?, ?, 'regular', 'local', ?, ?)`,
    );
    const insertConversation = db.prepare(
      `INSERT INTO conversations (id, workspace_id, placement_kind, roster_policy, title, status, created_at, updated_at)
       VALUES (?, ?, 'workspace', 'open', ?, 'active', ?, ?)`,
    );
    const insertMessage = db.prepare(
      `INSERT INTO messages (id, conversation_id, from_kind, from_user_id, content, seq, created_at, thread_root_id)
       VALUES (?, ?, 'user', 'local', ?, ?, ?, ?)`,
    );
    const insertInbox = db.prepare(
      `INSERT INTO conversation_inboxes (conversation_id, agent_id, message_id, created_at)
       VALUES (?, ?, ?, ?)`,
    );
    const insertNotification = db.prepare(
      `INSERT INTO notifications (id, kind, user_id, workspace_id, conversation_id, message_id, source_workspace_id, source_conversation_id, source_message_id, created_at)
       VALUES (?, 'mention', 'local', ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertStreamHead = db.prepare(
      `INSERT INTO conversation_stream_heads (conversation_id, thread_root_id, latest_seq)
       VALUES (?, ?, ?)`,
    );
    const insertRead = db.prepare(
      `INSERT INTO conversation_reads (user_id, conversation_id, thread_root_id, last_read_seq, read_at)
       VALUES ('local', ?, ?, ?, ?)`,
    );
    const insertSaved = db.prepare(
      `INSERT INTO saved_messages (id, message_id, conversation_id, workspace_id, saved_at, user_id)
       VALUES (?, ?, ?, ?, ?, 'local')`,
    );
    const insertFollower = db.prepare(
      `INSERT INTO thread_followers (thread_root_id, conversation_id, principal_kind, principal_id, followed_at, source)
       VALUES (?, ?, 'human', 'local', ?, 'manual')`,
    );

    db.transaction(() => {
      insertAgent.run('agent-bulk', 'bulk-agent', localHostId, now, now);
      insertAgent.run('agent-bulk-2', 'bulk-agent-2', localHostId, now, now);

      // ── Unrelated GLOBAL bulk: the amplification substrate ─────────
      insertWorkspace.run('ws-bulk', 'bulk', now, now);
      insertConversation.run('conv-bulk', 'ws-bulk', 'bulk', now, now);
      for (let i = 0; i < BULK_MESSAGES; i += 1) {
        insertMessage.run(`m-bulk-${i}`, 'conv-bulk', 'x', i + 1, now, null);
      }
      for (let i = 0; i < BULK_INBOX_ROWS; i += 1) {
        // (conversation_id, agent_id, message_id) is UNIQUE — spread the
        // rows across two agents so every pair is distinct.
        insertInbox.run(
          'conv-bulk',
          i < BULK_MESSAGES ? 'agent-bulk' : 'agent-bulk-2',
          `m-bulk-${i % BULK_MESSAGES}`,
          now,
        );
      }
      for (let i = 0; i < BULK_NOTIFICATIONS; i += 1) {
        insertNotification.run(
          `n-bulk-${i}`,
          'ws-bulk',
          'conv-bulk',
          `m-bulk-${i % BULK_MESSAGES}`,
          'ws-bulk',
          'conv-bulk',
          `m-bulk-${(i + 7) % BULK_MESSAGES}`,
          now,
        );
      }
      // Moderate unrelated volume in the remaining child tables.
      insertStreamHead.run('conv-bulk', null, BULK_MESSAGES);
      insertRead.run('conv-bulk', null, BULK_MESSAGES, now);
      for (let i = 0; i < 2_000; i += 1) {
        insertRead.run('conv-bulk', `m-bulk-${i}`, i, now);
        insertSaved.run(`s-bulk-${i}`, `m-bulk-${i}`, 'conv-bulk', 'ws-bulk', now);
        insertFollower.run(`m-bulk-${i}`, 'conv-bulk', now + i);
      }

      // ── Small TARGET workspace (dalaran-shaped) ────────────────────
      insertWorkspace.run('ws-target', 'target', now, now);
      for (const conv of ['conv-t1', 'conv-t2']) {
        insertConversation.run(conv, 'ws-target', conv, now, now);
        for (let i = 0; i < 30; i += 1) {
          const id = `${conv}-m${i}`;
          // A third of the target messages are thread replies so the
          // messages.thread_root_id self-cascade actually fires.
          const root = i % 3 === 2 ? `${conv}-m${i - 1}` : null;
          insertMessage.run(id, conv, 'x', i + 1, now, root);
          insertInbox.run(conv, 'agent-bulk', id, now);
        }
        insertStreamHead.run(conv, null, 30);
        insertStreamHead.run(conv, `${conv}-m0`, 30);
        insertRead.run(conv, null, 30, now);
        insertRead.run(conv, `${conv}-m0`, 30, now);
        insertSaved.run(`s-${conv}`, `${conv}-m0`, conv, 'ws-target', now);
        insertFollower.run(`${conv}-m0`, conv, now);
        insertNotification.run(
          `n-${conv}`, 'ws-target', conv, `${conv}-m0`, 'ws-target', conv, `${conv}-m1`, now,
        );
      }
      // SET NULL witness: a notification that SURVIVES the delete (it
      // belongs to the bulk workspace) but references a target message —
      // exactly the row shape the notifications.message_id scan visits.
      insertNotification.run(
        'n-witness', 'ws-bulk', 'conv-bulk', 'conv-t1-m0', 'ws-target', 'conv-t1', 'conv-t1-m1', now,
      );
    })();

    const bulkCounts = {
      messages: db.prepare(`SELECT COUNT(*) c FROM messages WHERE conversation_id = 'conv-bulk'`).get() as { c: number },
      inbox: db.prepare(`SELECT COUNT(*) c FROM conversation_inboxes WHERE conversation_id = 'conv-bulk'`).get() as { c: number },
      notifications: db.prepare(`SELECT COUNT(*) c FROM notifications WHERE workspace_id = 'ws-bulk'`).get() as { c: number },
    };
    expect(bulkCounts.messages.c).toBe(BULK_MESSAGES);
    expect(bulkCounts.inbox.c).toBe(BULK_INBOX_ROWS);

    // ── The measured operation: production's exact single-row delete ──
    const started = performance.now();
    db.prepare(`DELETE FROM workspaces WHERE id = ? AND workspace_kind = 'regular'`).run('ws-target');
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(DELETE_BUDGET_MS);

    // Cascade correctness: the target tree is gone…
    for (const [table, where] of [
      ['conversations', `workspace_id = 'ws-target'`],
      ['messages', `conversation_id IN ('conv-t1','conv-t2')`],
      ['conversation_inboxes', `conversation_id IN ('conv-t1','conv-t2')`],
      ['notifications', `workspace_id = 'ws-target'`],
      ['conversation_stream_heads', `conversation_id IN ('conv-t1','conv-t2')`],
      ['conversation_reads', `conversation_id IN ('conv-t1','conv-t2')`],
      ['saved_messages', `workspace_id = 'ws-target'`],
      ['thread_followers', `conversation_id IN ('conv-t1','conv-t2')`],
    ] as const) {
      const row = db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE ${where}`).get() as { c: number };
      expect(row.c, table).toBe(0);
    }

    // …the unrelated global rows are untouched…
    expect((db.prepare(`SELECT COUNT(*) c FROM messages WHERE conversation_id = 'conv-bulk'`).get() as { c: number }).c).toBe(BULK_MESSAGES);
    expect((db.prepare(`SELECT COUNT(*) c FROM conversation_inboxes WHERE conversation_id = 'conv-bulk'`).get() as { c: number }).c).toBe(BULK_INBOX_ROWS);
    expect((db.prepare(`SELECT COUNT(*) c FROM notifications WHERE workspace_id = 'ws-bulk'`).get() as { c: number }).c).toBe(bulkCounts.notifications.c);

    // …and SET NULL fired instead of deleting the surviving witness.
    const witness = db
      .prepare(`SELECT message_id, source_workspace_id, source_conversation_id, source_message_id FROM notifications WHERE id = 'n-witness'`)
      .get() as { message_id: string | null; source_workspace_id: string | null; source_conversation_id: string | null; source_message_id: string | null };
    expect(witness).toEqual({
      message_id: null,
      source_workspace_id: null,
      source_conversation_id: null,
      source_message_id: null,
    });

    db.close();
  });
});
