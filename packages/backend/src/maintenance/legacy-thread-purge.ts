// Legacy isolated-thread fossil purge — repeatable, auditable, proof-bearing
// DB cleanup device (#task:1303 phase 1).
//
// Context: the Workspace→Channel→Thread cutover moved "thread" from an
// independent `conversations.kind='thread'` conversation to a reply-cluster
// (`messages.thread_root_id`). The `kind='thread'` producer is retired, so
// those rows are read-only fossils. shiki confirmed the (month-old) data is
// disposable → this device hard-deletes the fossils + their referencing rows.
//
// Design (delete-order + lock-boundary reviewed by Cindy):
//  - Materialize two id sets ONCE (`legacy_convo`, `legacy_msg`) into temp
//    tables; every statement operates only on those sets — no fuzzy re-derived
//    predicates that could drift between inventory / apply / proof.
//  - APPLY runs the WHOLE lifecycle — materialize → inventory → guard →
//    canonical baseline → deletes → post-proof — inside ONE `BEGIN IMMEDIATE`
//    transaction. The write lock is taken up front so no concurrent writer can
//    slip a new legacy row or reply-cluster row between the baseline and the
//    delete (which would invalidate the proof). DRY-RUN takes no lock and is a
//    pure read path (the caller should also open the connection read-only).
//  - We do not rely on `PRAGMA foreign_keys` cascade (may be off in a raw
//    connection), and we DELETE the SET-NULL referrers (notifications) rather
//    than leaving dangling null rows.
//  - Hard guard BEFORE any delete: no NON-legacy row may carry a
//    `thread_root_id` pointing into `legacy_msg`. `messages.thread_root_id` is
//    `ON DELETE CASCADE`, so a stray external reference would cascade-delete a
//    live reply-cluster message — abort instead.
//  - Post-proof INSIDE the transaction: `kind='thread'` count == 0, every
//    referencing table has zero residual rows into the legacy set, and the
//    canonical reply-cluster row count is unchanged. Any failed assertion
//    throws → the whole transaction rolls back.
import type { Database as Db } from 'better-sqlite3';

/** Raised when a pre-delete guard or post-delete proof fails. On apply this
 *  propagates out of the transaction so better-sqlite3 rolls it back. */
export class LegacyThreadPurgeAbort extends Error {
  constructor(
    message: string,
    readonly detail: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'LegacyThreadPurgeAbort';
  }
}

export interface PurgeInventory {
  /** `conversations.kind='thread'` rows to delete. */
  legacyConversations: number;
  /** messages living inside those conversations. */
  legacyMessages: number;
  /** Rows to delete (or null, for `attachments.source_conversation_id`) per
   *  referencing table, keyed by a human label. */
  perTable: Record<string, number>;
}

export interface PurgeGuard {
  ok: boolean;
  /** Per table: NON-legacy rows whose `thread_root_id` points into the legacy
   *  message set. All MUST be 0 — otherwise deleting a fossil message would
   *  cascade into a live reply-cluster. */
  externalThreadRootRefs: Record<string, number>;
  /** Attachments physically living in a legacy conversation (`channel_id`).
   *  Expected 0; non-zero aborts so a human decides (delete body vs migrate). */
  legacyChannelAttachments: number;
}

export interface PurgeProof {
  /** MUST be 0 after apply. */
  remainingLegacyConversations: number;
  /** Per referencing table: residual rows still pointing at the legacy set.
   *  All MUST be 0. */
  orphans: Record<string, number>;
  /** Canonical reply-cluster rows (thread_root_id set, in a non-legacy
   *  conversation) before and after — MUST be equal. */
  canonicalReplyClusterBefore: number;
  canonicalReplyClusterAfter: number;
}

export interface PurgeReport {
  applied: boolean;
  inventory: PurgeInventory;
  guard: PurgeGuard;
  /** Present only when `apply` was true and the transaction committed. */
  proof?: PurgeProof;
}

// Tables that reference a conversation and are physically owned by it (delete
// every row whose conversation is legacy).
const CONVERSATION_OWNED = [
  'conversation_agents',
  'conversation_users',
  'conversation_events',
  'channel_attention_preferences',
] as const;

// Predicate fragments over the materialized temp sets. Shared verbatim by
// inventory / delete / proof so the three phases can never drift.
const IN_CONVO = `conversation_id IN (SELECT id FROM legacy_convo)`;
const SRC_CONVO = `source_conversation_id IN (SELECT id FROM legacy_convo)`;
const ROOT_IN_MSG = `thread_root_id IN (SELECT id FROM legacy_msg)`;
const MSG_IN_MSG = `message_id IN (SELECT id FROM legacy_msg)`;
const SRC_MSG = `source_message_id IN (SELECT id FROM legacy_msg)`;
const CHANNEL_IN_CONVO = `channel_id IN (SELECT id FROM legacy_convo)`;
const NOTIF_HIT = `${IN_CONVO} OR ${SRC_CONVO} OR ${MSG_IN_MSG} OR ${SRC_MSG}`;
// Canonical reply-cluster: thread_root_id set, in a conversation NOT being
// deleted. This count is the invariant the purge must not move.
const CANONICAL_SQL = `SELECT count(*) FROM messages
   WHERE thread_root_id IS NOT NULL
     AND conversation_id NOT IN (SELECT id FROM legacy_convo)`;

function pluckCount(db: Db, sql: string): number {
  return (db.prepare(sql).pluck().get() as number | undefined) ?? 0;
}

function materialize(db: Db): void {
  db.exec(`
    DROP TABLE IF EXISTS temp.legacy_convo;
    DROP TABLE IF EXISTS temp.legacy_msg;
    CREATE TEMP TABLE legacy_convo AS
      SELECT id FROM conversations WHERE kind='thread';
    CREATE TEMP TABLE legacy_msg AS
      SELECT id FROM messages
       WHERE conversation_id IN (SELECT id FROM legacy_convo);
    CREATE INDEX temp.idx_legacy_convo ON legacy_convo(id);
    CREATE INDEX temp.idx_legacy_msg ON legacy_msg(id);
  `);
}

function dropTemp(db: Db): void {
  db.exec(`
    DROP TABLE IF EXISTS temp.legacy_convo;
    DROP TABLE IF EXISTS temp.legacy_msg;
  `);
}

function computeInventory(db: Db): PurgeInventory {
  const legacyConversations = pluckCount(db, `SELECT count(*) FROM legacy_convo`);
  const legacyMessages = pluckCount(db, `SELECT count(*) FROM legacy_msg`);
  const perTable: Record<string, number> = {
    message_reactions: pluckCount(db, `SELECT count(*) FROM message_reactions WHERE ${MSG_IN_MSG}`),
    notifications: pluckCount(db, `SELECT count(*) FROM notifications WHERE ${NOTIF_HIT}`),
    saved_messages: pluckCount(db, `SELECT count(*) FROM saved_messages WHERE ${IN_CONVO} OR ${MSG_IN_MSG}`),
    conversation_inboxes: pluckCount(db, `SELECT count(*) FROM conversation_inboxes WHERE ${IN_CONVO} OR ${MSG_IN_MSG}`),
    thread_followers: pluckCount(db, `SELECT count(*) FROM thread_followers WHERE ${IN_CONVO} OR ${ROOT_IN_MSG}`),
    conversation_stream_heads: pluckCount(db, `SELECT count(*) FROM conversation_stream_heads WHERE ${IN_CONVO} OR ${ROOT_IN_MSG}`),
    conversation_reads: pluckCount(db, `SELECT count(*) FROM conversation_reads WHERE ${IN_CONVO} OR ${ROOT_IN_MSG}`),
    'attachments(delete channel_id)': pluckCount(db, `SELECT count(*) FROM attachments WHERE ${CHANNEL_IN_CONVO}`),
    'attachments(null source_conversation_id)': pluckCount(db, `SELECT count(*) FROM attachments WHERE ${SRC_CONVO}`),
    messages: legacyMessages,
    conversations: legacyConversations,
  };
  for (const t of CONVERSATION_OWNED) {
    perTable[t] = pluckCount(db, `SELECT count(*) FROM ${t} WHERE ${IN_CONVO}`);
  }
  return { legacyConversations, legacyMessages, perTable };
}

function computeGuard(db: Db): PurgeGuard {
  const externalRef = (table: string): number =>
    pluckCount(
      db,
      `SELECT count(*) FROM ${table}
        WHERE ${ROOT_IN_MSG}
          AND conversation_id NOT IN (SELECT id FROM legacy_convo)`,
    );
  const externalThreadRootRefs: Record<string, number> = {
    messages: externalRef('messages'),
    thread_followers: externalRef('thread_followers'),
    conversation_reads: externalRef('conversation_reads'),
    conversation_stream_heads: externalRef('conversation_stream_heads'),
  };
  const legacyChannelAttachments = pluckCount(
    db,
    `SELECT count(*) FROM attachments WHERE ${CHANNEL_IN_CONVO}`,
  );
  const ok =
    Object.values(externalThreadRootRefs).every((n) => n === 0) &&
    legacyChannelAttachments === 0;
  return { ok, externalThreadRootRefs, legacyChannelAttachments };
}

function doDeletes(db: Db): void {
  const run = (sql: string): void => {
    db.prepare(sql).run();
  };
  // Leaf message references first, then conversation-owned rows, then the
  // messages, then the conversations themselves.
  run(`DELETE FROM message_reactions WHERE ${MSG_IN_MSG}`);
  run(`DELETE FROM notifications WHERE ${NOTIF_HIT}`);
  run(`DELETE FROM saved_messages WHERE ${IN_CONVO} OR ${MSG_IN_MSG}`);
  run(`DELETE FROM conversation_inboxes WHERE ${IN_CONVO} OR ${MSG_IN_MSG}`);
  run(`DELETE FROM thread_followers WHERE ${IN_CONVO} OR ${ROOT_IN_MSG}`);
  run(`DELETE FROM conversation_stream_heads WHERE ${IN_CONVO} OR ${ROOT_IN_MSG}`);
  run(`DELETE FROM conversation_reads WHERE ${IN_CONVO} OR ${ROOT_IN_MSG}`);
  for (const t of CONVERSATION_OWNED) {
    run(`DELETE FROM ${t} WHERE ${IN_CONVO}`);
  }
  // Attachments living elsewhere but sourced from a legacy conversation: keep
  // the body, drop the dangling source pointer.
  run(`UPDATE attachments SET source_conversation_id=NULL WHERE ${SRC_CONVO}`);
  // Attachments physically in a legacy conversation (guard asserts 0, kept for
  // completeness / future data shapes).
  run(`DELETE FROM attachments WHERE ${CHANNEL_IN_CONVO}`);
  run(`DELETE FROM messages WHERE ${IN_CONVO}`);
  run(`DELETE FROM conversations WHERE id IN (SELECT id FROM legacy_convo)`);
}

function computeProof(db: Db, canonicalReplyClusterBefore: number): PurgeProof {
  const orphans: Record<string, number> = {
    message_reactions: pluckCount(db, `SELECT count(*) FROM message_reactions WHERE ${MSG_IN_MSG}`),
    notifications: pluckCount(db, `SELECT count(*) FROM notifications WHERE ${NOTIF_HIT}`),
    saved_messages: pluckCount(db, `SELECT count(*) FROM saved_messages WHERE ${IN_CONVO} OR ${MSG_IN_MSG}`),
    conversation_inboxes: pluckCount(db, `SELECT count(*) FROM conversation_inboxes WHERE ${IN_CONVO} OR ${MSG_IN_MSG}`),
    thread_followers: pluckCount(db, `SELECT count(*) FROM thread_followers WHERE ${IN_CONVO} OR ${ROOT_IN_MSG}`),
    conversation_stream_heads: pluckCount(db, `SELECT count(*) FROM conversation_stream_heads WHERE ${IN_CONVO} OR ${ROOT_IN_MSG}`),
    conversation_reads: pluckCount(db, `SELECT count(*) FROM conversation_reads WHERE ${IN_CONVO} OR ${ROOT_IN_MSG}`),
    attachments_source: pluckCount(db, `SELECT count(*) FROM attachments WHERE ${SRC_CONVO}`),
    attachments_channel: pluckCount(db, `SELECT count(*) FROM attachments WHERE ${CHANNEL_IN_CONVO}`),
    messages: pluckCount(db, `SELECT count(*) FROM messages WHERE ${IN_CONVO}`),
  };
  for (const t of CONVERSATION_OWNED) {
    orphans[t] = pluckCount(db, `SELECT count(*) FROM ${t} WHERE ${IN_CONVO}`);
  }
  return {
    remainingLegacyConversations: pluckCount(
      db,
      `SELECT count(*) FROM conversations WHERE kind='thread'`,
    ),
    orphans,
    canonicalReplyClusterBefore,
    canonicalReplyClusterAfter: pluckCount(db, CANONICAL_SQL),
  };
}

/**
 * Run the legacy-thread purge. With `apply: false` (default) this is a pure
 * read path — the caller should also open the connection read-only for a
 * physical no-write guarantee. With `apply: true` the entire lifecycle
 * (materialize → inventory → guard → baseline → deletes → post-proof) runs
 * inside one `BEGIN IMMEDIATE` transaction; any failed guard/proof throws and
 * rolls the whole thing back.
 *
 * The caller owns opening the DB, backups, and connection-level pragmas.
 */
export function runLegacyThreadPurge(db: Db, opts: { apply: boolean }): PurgeReport {
  if (!opts.apply) {
    try {
      materialize(db);
      return {
        applied: false,
        inventory: computeInventory(db),
        guard: computeGuard(db),
      };
    } finally {
      dropTemp(db);
    }
  }

  let out: PurgeReport | undefined;
  const tx = db.transaction(() => {
    materialize(db);
    const inventory = computeInventory(db);
    const guard = computeGuard(db);
    if (!guard.ok) {
      throw new LegacyThreadPurgeAbort('pre-delete guard failed', { guard });
    }
    const canonicalBefore = pluckCount(db, CANONICAL_SQL);
    doDeletes(db);
    const proof = computeProof(db, canonicalBefore);

    if (proof.remainingLegacyConversations !== 0) {
      throw new LegacyThreadPurgeAbort('post-proof: legacy conversations remain', { proof });
    }
    const orphanHit = Object.entries(proof.orphans).filter(([, n]) => n !== 0);
    if (orphanHit.length > 0) {
      throw new LegacyThreadPurgeAbort('post-proof: orphan references remain', {
        orphans: Object.fromEntries(orphanHit),
      });
    }
    if (proof.canonicalReplyClusterAfter !== proof.canonicalReplyClusterBefore) {
      throw new LegacyThreadPurgeAbort('post-proof: canonical reply-cluster count changed', {
        before: proof.canonicalReplyClusterBefore,
        after: proof.canonicalReplyClusterAfter,
      });
    }
    out = { applied: true, inventory, guard, proof };
  });
  // BEGIN IMMEDIATE: take the write lock up front so a concurrently-writing app
  // surfaces as an immediate SQLITE_BUSY (fail-loud) rather than a partial run
  // or a stale-baseline proof.
  try {
    tx.immediate();
  } finally {
    dropTemp(db);
  }
  return out!;
}
