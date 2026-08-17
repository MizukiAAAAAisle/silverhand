import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrations } from '@silverhand/shared/db/migrations';

/**
 * v81 `saved_messages_drop_workspace_id` (#task:2050, F2).
 *
 * The migration drops the denormalized `saved_messages.workspace_id` — an
 * UNCONSTRAINABLE duplicate of `conversations.workspace_id` (SQLite has no
 * cross-table CHECK) that forced Saved to be workspace-only. The drop is safe
 * ONLY if the duplicate never drifted, so the migration SQL-proves that premise
 * in its precondition and aborts loudly otherwise. #task:2050 falsifier 4 stated
 * that premise as an assumption; these are the behavior tests that prove it
 * rather than assume it:
 *
 *   1. a single row whose `workspace_id` disagrees with its conversation's aborts
 *      the migration BEFORE any DDL/DML — no half-rebuilt table, ledger not
 *      advanced;
 *   2. with the premise holding, the rebuild drops only the column + its now-dead
 *      index, preserves every surviving row byte-for-byte, and leaves FKs intact;
 *      and — the reason the column had to go — a `direct_pair` (workspace-less)
 *      save becomes expressible only AFTER the drop.
 */

function openDbThrough(maxVersion: number): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec(`CREATE TABLE _migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL
  )`);
  for (const migration of migrations) {
    if (migration.version > maxVersion) break;
    const apply = () => {
      migration.precondition?.(db as never);
      db.exec(migration.up);
      db.prepare('INSERT INTO _migrations VALUES (?, ?, 0)')
        .run(migration.version, migration.name);
    };
    if (migration.foreignKeyEscape) {
      db.pragma('legacy_alter_table = ON');
      try {
        db.transaction(apply)();
      } finally {
        db.pragma('legacy_alter_table = OFF');
      }
    } else {
      db.transaction(apply)();
    }
  }
  return db;
}

function applyV81(db: Database.Database): void {
  const migration = migrations.find(candidate => candidate.version === 81)!;
  const apply = () => {
    migration.precondition?.(db as never);
    db.exec(migration.up);
    db.prepare('INSERT INTO _migrations VALUES (?, ?, 0)')
      .run(migration.version, migration.name);
  };
  // Mirror the real runner's foreignKeyEscape handling so the RENAME does not
  // rewrite references in sibling tables (foreign_keys is already OFF here).
  if (migration.foreignKeyEscape) {
    db.pragma('legacy_alter_table = ON');
    try {
      db.transaction(apply)();
    } finally {
      db.pragma('legacy_alter_table = OFF');
    }
  } else {
    db.transaction(apply)();
  }
}

function schema(db: Database.Database): unknown[] {
  return db.prepare(
    `SELECT type, name, tbl_name, sql
       FROM sqlite_master
      WHERE sql IS NOT NULL
      ORDER BY type, name`,
  ).all();
}

function savedColumns(db: Database.Database): string[] {
  return (
    db.prepare(`PRAGMA table_xinfo('saved_messages')`).all() as Array<{ name: string }>
  ).map(row => row.name);
}

/** Principals + two workspace-placed channels and one human<->human pair, all
 *  valid FK targets so `foreign_key_check` is clean after the rebuild. */
function seedGraph(db: Database.Database): void {
  db.exec(`
    INSERT INTO users (id, name, display_name, created_at, updated_at)
    VALUES
      ('u-1', 'saved-one', 'One', 0, 0),
      ('u-2', 'saved-two', 'Two', 0, 0);
    INSERT INTO workspaces
      (id, name, name_key, description, workspace_kind, owner_agent_id,
       archived_at, created_at, updated_at)
    VALUES
      ('w-1', 'Eng', 'eng', NULL, 'regular', NULL, NULL, 0, 0),
      ('w-2', 'Ops', 'ops', NULL, 'regular', NULL, NULL, 0, 0);
    INSERT INTO conversations
      (id, workspace_id, inbox_agent_id, placement_kind, roster_policy,
       endpoint_a_kind, endpoint_a_id, endpoint_b_kind, endpoint_b_id,
       title, title_key, status, visibility, created_at, updated_at)
    VALUES
      ('c-1', 'w-1', NULL, 'workspace', 'open',
       NULL, NULL, NULL, NULL, 'general', 'general', 'idle', 'public', 1, 1),
      ('c-2', 'w-1', NULL, 'workspace', 'open',
       NULL, NULL, NULL, NULL, 'random', 'random', 'idle', 'public', 2, 2),
      ('c-pair', NULL, NULL, 'direct_pair', 'fixed',
       'human', 'u-1', 'human', 'u-2', 'Pair', NULL, 'idle', 'private', 3, 3);
    INSERT INTO messages
      (id, conversation_id, from_kind, from_user_id, content, seq, created_at)
    VALUES
      ('m-1', 'c-1', 'user', 'u-1', 'in c-1', 1, 10),
      ('m-2', 'c-2', 'user', 'u-2', 'in c-2', 2, 20),
      ('m-pair', 'c-pair', 'user', 'u-1', 'in a DM', 3, 30);
  `);
}

describe('v81 saved_messages workspace_id drop', () => {
  it('aborts before any DDL/DML when a row\'s workspace_id disagrees with its conversation', () => {
    const db = openDbThrough(80);
    seedGraph(db);
    // sm-drift is workspace-placed in c-1 (workspace w-1) but carries w-2 — the
    // exact drift the drop would silently discard. sm-ok is consistent, so the
    // abort is proven to key off the divergent row, not merely "any row exists".
    db.exec(`
      INSERT INTO saved_messages (id, user_id, message_id, conversation_id, workspace_id, saved_at)
      VALUES
        ('sm-ok',    'u-1', 'm-1', 'c-1', 'w-1', 100),
        ('sm-drift', 'u-2', 'm-2', 'c-2', 'w-2', 200);
    `);
    const beforeSchema = schema(db);
    const beforeRows = db.prepare(
      `SELECT * FROM saved_messages ORDER BY id`,
    ).all();

    let failure: Error | undefined;
    try {
      applyV81(db);
    } catch (error) {
      failure = error as Error;
    }
    expect(failure?.message).toMatch(/v81: 1 saved_messages row\(s\) have a workspace_id/);
    expect(failure?.message).toMatch(/disagrees/);
    // Nothing moved: the column, the rows and the ledger are untouched.
    expect(savedColumns(db)).toContain('workspace_id');
    expect(schema(db)).toEqual(beforeSchema);
    expect(db.prepare(`SELECT * FROM saved_messages ORDER BY id`).all()).toEqual(beforeRows);
    expect(db.prepare('SELECT 1 FROM _migrations WHERE version = 81').get()).toBeUndefined();
    db.close();
  });

  it('drops only the column + its dead index, preserves every row, and unblocks the DM arm', () => {
    const db = openDbThrough(80);
    seedGraph(db);
    // Every v80 row is workspace-placed (workspace_id was NOT NULL, so a DM save
    // could not exist) and consistent with its conversation.
    db.exec(`
      INSERT INTO saved_messages (id, user_id, message_id, conversation_id, workspace_id, saved_at)
      VALUES
        ('sm-1', 'u-1', 'm-1', 'c-1', 'w-1', 100),
        ('sm-2', 'u-2', 'm-2', 'c-2', 'w-1', 200);
    `);
    const beforeSurviving = db.prepare(
      `SELECT id, message_id, conversation_id, saved_at, user_id
         FROM saved_messages ORDER BY id`,
    ).all();

    applyV81(db);

    // The column is gone; every other column and every row survives verbatim.
    expect(savedColumns(db)).not.toContain('workspace_id');
    expect(savedColumns(db).sort()).toEqual(
      ['conversation_id', 'id', 'message_id', 'saved_at', 'user_id'],
    );
    expect(db.prepare(
      `SELECT id, message_id, conversation_id, saved_at, user_id
         FROM saved_messages ORDER BY id`,
    ).all()).toEqual(beforeSurviving);

    // Only the now-dead workspace index is dropped; the read/uniqueness indexes
    // the repo actually drives are recreated.
    const savedIndexes = (db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'saved_messages'
        AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    ).all() as Array<{ name: string }>).map(r => r.name);
    expect(savedIndexes).not.toContain('idx_saved_messages_workspace');
    expect(savedIndexes).toEqual([
      'idx_saved_messages_conversation',
      'idx_saved_messages_message',
      'idx_saved_messages_user_saved_at',
      'uniq_saved_messages_user_message',
    ]);
    expect(db.pragma('foreign_key_check')).toEqual([]);

    // The reason the column had to go: a workspace-less `direct_pair` save is now
    // expressible. Under the old NOT NULL `workspace_id` it was not.
    db.prepare(
      `INSERT INTO saved_messages (id, user_id, message_id, conversation_id, saved_at)
       VALUES ('sm-dm', 'u-1', 'm-pair', 'c-pair', 300)`,
    ).run();
    const dm = db.prepare(
      `SELECT conversation_id FROM saved_messages WHERE id = 'sm-dm'`,
    ).get() as { conversation_id: string };
    expect(dm.conversation_id).toBe('c-pair');
    db.close();
  });
});
