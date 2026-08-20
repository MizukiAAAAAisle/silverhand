import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrations } from '@silverhand/shared/db/migrations';
import { runMigrations } from '../src/db.js';

/**
 * v87 `messages_drop_v60_task_residue` (#task:2083).
 *
 * v60 turned a task from "a `messages` row wearing task_* columns" into the
 * first-class `tasks` aggregate and backfilled every carrier into it, reusing
 * the anchor message's id as `tasks.id`. The columns have been dead ever since —
 * no reader, no writer — but they were still physically present, which is the
 * state a future reader accidentally resurrects. v87 removes them.
 *
 * The removal is IRREVERSIBLE (a plain DROP COLUMN, no rebuild), so its safety
 * cannot rest on "we believe nothing needs them". These tests hold it to the
 * three claims the migration actually makes:
 *
 *   1. the precondition proves PER CARRIER that the canonical task exists, and a
 *      single orphan aborts before any DDL/DML — no half-dropped table, ledger
 *      not advanced;
 *   2. with the premise holding, exactly the 4 dead indexes and 12 dead columns
 *      disappear, every surviving column and row is byte-identical, the live
 *      `cc_source_message_id` neighbour and the thread triggers keep working, and
 *      `foreign_key_check` stays clean; and
 *   3. end-to-end from a REAL v59 carrier: the same row that v60 copied into
 *      `tasks` still carries its whole definition there after v87, which is what
 *      makes dropping the original lossless rather than merely tidy; and
 *   4. re-opening an already-migrated database is a no-op — which is not
 *      cosmetic here: the precondition NAMES `messages.task_number`, so a runner
 *      that re-evaluated an applied migration's hook would die with `no such
 *      column` on every boot after the upgrade.
 *
 * Native SQL is unavoidable here (see the db-boundary ledger entry): the
 * pre-migration state is the columns this migration deletes, so it is
 * unrepresentable through repositories — `MessageRow` no longer declares them.
 */

function applyOne(db: Database.Database, migration: (typeof migrations)[number]): void {
  const apply = () => {
    migration.precondition?.(db as never);
    db.exec(migration.up);
    db.prepare('INSERT INTO _migrations VALUES (?, ?, 0)').run(
      migration.version,
      migration.name,
    );
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

function openDbThrough(maxVersion: number): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec(`CREATE TABLE _migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL
  )`);
  for (const migration of migrations) {
    if (migration.version > maxVersion) break;
    applyOne(db, migration);
  }
  return db;
}

/** Continue an already-open database through `maxVersion` (the ledger is the
 *  cursor), so a v59-seeded file can be walked over the real v60 backfill and on
 *  to v87 exactly as a production upgrade would. */
function upgradeThrough(db: Database.Database, maxVersion: number): void {
  const applied = new Set(
    (db.prepare('SELECT version FROM _migrations').all() as Array<{ version: number }>).map(
      row => row.version,
    ),
  );
  for (const migration of migrations) {
    if (migration.version > maxVersion) break;
    if (applied.has(migration.version)) continue;
    applyOne(db, migration);
  }
}

function applyV87(db: Database.Database): void {
  applyOne(db, migrations.find(candidate => candidate.version === 87)!);
}

function schema(db: Database.Database): unknown[] {
  return db
    .prepare(
      `SELECT type, name, tbl_name, sql
         FROM sqlite_master
        WHERE sql IS NOT NULL
        ORDER BY type, name`,
    )
    .all();
}

function messageColumns(db: Database.Database): string[] {
  return (
    db.prepare(`PRAGMA table_xinfo('messages')`).all() as Array<{ name: string }>
  ).map(row => row.name);
}

function messageIndexes(db: Database.Database): string[] {
  return (
    db
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'index' AND tbl_name = 'messages' AND name NOT LIKE 'sqlite_%'
          ORDER BY name`,
      )
      .all() as Array<{ name: string }>
  ).map(row => row.name);
}

/** The 12 columns v87 deletes and the 4 indexes that must go first. */
const DEAD_COLUMNS = [
  'task_number',
  'task_status',
  'task_assignee_agent_id',
  'task_assignee_user_id',
  'task_title',
  'task_workspace_id',
  'task_closed_at',
  'source_message_id',
  'task_revision',
  'task_last_editor_kind',
  'task_last_editor_id',
  'task_last_edited_at',
];
const DEAD_INDEXES = [
  'idx_messages_source_message_id',
  'idx_messages_task_workspace',
  'idx_messages_task_workspace_closed_at',
  'uniq_messages_task_workspace_number',
];

/** Principals + one workspace channel, so every FK target of the rows below
 *  exists and `foreign_key_check` is meaningful after the drop. */
function seedGraph(db: Database.Database): void {
  db.exec(`
    INSERT INTO users (id, name, display_name, created_at, updated_at)
    VALUES ('u-1', 'residue-one', 'One', 0, 0);
    INSERT INTO hosts (id, kind, name, created_at)
    VALUES ('host-1', 'local', 'host', 0);
    INSERT INTO agents
      (id, name, runtime, host_id, created_at, updated_at, created_by_user_id)
    VALUES ('ag-1', 'residue-agent', 'claude', 'host-1', 0, 0, 'u-1');
    INSERT INTO workspaces
      (id, name, name_key, description, owner_agent_id, archived_at, created_at, updated_at)
    VALUES ('w-1', 'Eng', 'eng', NULL, NULL, NULL, 0, 0);
    INSERT INTO conversations
      (id, workspace_id, placement_kind, roster_policy,
       endpoint_a_kind, endpoint_a_id, endpoint_b_kind, endpoint_b_id,
       title, title_key, status, visibility, created_at, updated_at)
    VALUES ('c-1', 'w-1', 'workspace', 'open',
       NULL, NULL, NULL, NULL, 'general', 'general', 'idle', 'public', 1, 1);
  `);
}

/** A pre-v60 anchor row: the "message IS task" carrier, still wearing all 12
 *  columns because the file has not reached v87 yet. */
function insertCarrier(
  db: Database.Database,
  args: { id: string; taskNumber: number; seq: number },
): void {
  db.prepare(
    `INSERT INTO messages
       (id, conversation_id, from_kind, from_agent_id, content, seq, created_at,
        task_number, task_status, task_assignee_agent_id, task_title,
        task_workspace_id, task_closed_at, source_message_id, task_revision,
        task_last_editor_kind, task_last_editor_id, task_last_edited_at)
     VALUES
       (@id, 'c-1', 'agent', 'ag-1', @content, @seq, 100,
        @task_number, 'in_progress', 'ag-1', @title,
        'w-1', NULL, NULL, 0,
        'agent', 'ag-1', 200)`,
  ).run({
    id: args.id,
    content: `body of task ${args.taskNumber}`,
    seq: args.seq,
    task_number: args.taskNumber,
    title: `Task ${args.taskNumber}`,
  });
}

/** The canonical row v60 would have produced for that carrier (same id). */
function insertCanonicalTask(
  db: Database.Database,
  args: { id: string; taskNumber: number },
): void {
  db.prepare(
    `INSERT INTO tasks
       (id, workspace_id, task_number, conversation_id, title, content, status,
        assignee_agent_id, creator_kind, creator_agent_id, source_message_id,
        created_at, board_key)
     VALUES
       (@id, 'w-1', @task_number, 'c-1', @title, @content, 'in_progress',
        'ag-1', 'agent', 'ag-1', NULL,
        100, 'ws:w-1')`,
  ).run({
    id: args.id,
    task_number: args.taskNumber,
    title: `Task ${args.taskNumber}`,
    content: `body of task ${args.taskNumber}`,
  });
}

describe('v87 messages task-residue drop (#task:2083)', () => {
  it('aborts before any DDL/DML when a carrier has no canonical task', () => {
    const db = openDbThrough(86);
    try {
      seedGraph(db);
      // m-ok is a carrier WITH its canonical task; m-orphan is the same shape
      // without one. Two rows, one offender, so the refusal is proven to key off
      // the missing task rather than "a carrier exists at all".
      insertCarrier(db, { id: 'm-ok', taskNumber: 1, seq: 1 });
      insertCanonicalTask(db, { id: 'm-ok', taskNumber: 1 });
      insertCarrier(db, { id: 'm-orphan', taskNumber: 2, seq: 2 });

      const beforeSchema = schema(db);
      const beforeRows = db.prepare(`SELECT * FROM messages ORDER BY id`).all();

      let failure: Error | undefined;
      try {
        applyV87(db);
      } catch (error) {
        failure = error as Error;
      }
      // Names the offending row — an id is actionable, a count is not.
      expect(failure?.message).toMatch(/v87: 1 message row\(s\) still carry retired task_\*/);
      expect(failure?.message).toContain('m-orphan');
      expect(failure?.message).not.toContain('m-ok');

      // Nothing moved: columns, indexes, rows and the ledger are untouched.
      expect(messageColumns(db)).toEqual(expect.arrayContaining(DEAD_COLUMNS));
      expect(schema(db)).toEqual(beforeSchema);
      expect(db.prepare(`SELECT * FROM messages ORDER BY id`).all()).toEqual(beforeRows);
      expect(db.prepare('SELECT 1 FROM _migrations WHERE version = 87').get()).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('drops exactly the 4 dead indexes and 12 dead columns, preserving every survivor', () => {
    const db = openDbThrough(86);
    try {
      seedGraph(db);
      insertCarrier(db, { id: 'm-task', taskNumber: 7, seq: 1 });
      insertCanonicalTask(db, { id: 'm-task', taskNumber: 7 });
      // An ordinary message and a thread reply, one of them exercising the LIVE
      // `cc_source_message_id` — the column whose name merely ends like the dead
      // `source_message_id`, and whose index must survive.
      db.exec(`
        INSERT INTO messages
          (id, conversation_id, from_kind, from_user_id, content, seq, created_at,
           author_id, author_name, author_display_name)
        VALUES ('m-plain', 'c-1', 'user', 'u-1', 'hello', 2, 300, 'u-1', 'residue-one', 'One');
        INSERT INTO messages
          (id, conversation_id, from_kind, from_user_id, content, seq, created_at,
           thread_root_id, cc_source_message_id)
        VALUES ('m-reply', 'c-1', 'user', 'u-1', 'in thread', 3, 400, 'm-plain', 'm-plain');
      `);

      const survivingColumns = messageColumns(db).filter(
        name => !DEAD_COLUMNS.includes(name),
      );
      const projection = survivingColumns.map(name => `"${name}"`).join(', ');
      const beforeRows = db
        .prepare(`SELECT ${projection} FROM messages ORDER BY id`)
        .all();
      const beforeIndexes = messageIndexes(db);
      expect(beforeIndexes).toEqual(expect.arrayContaining(DEAD_INDEXES));

      applyV87(db);

      // The 12 columns are gone and NOTHING else went with them.
      expect(messageColumns(db)).toEqual(survivingColumns);
      expect(db.prepare(`SELECT ${projection} FROM messages ORDER BY id`).all()).toEqual(
        beforeRows,
      );
      // The 4 dead indexes are gone; every other messages index survives — in
      // particular `idx_messages_cc_dedupe`, on the live neighbour column.
      expect(messageIndexes(db)).toEqual(
        beforeIndexes.filter(name => !DEAD_INDEXES.includes(name)),
      );
      expect(messageIndexes(db)).toContain('idx_messages_cc_dedupe');
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(db.prepare('SELECT 1 FROM _migrations WHERE version = 87').get()).toEqual({ 1: 1 });

      // The write path still works, including the thread-root trigger pair that
      // shares this table (they key off `thread_root_id`, never a task column).
      db.prepare(
        `INSERT INTO messages
           (id, conversation_id, from_kind, from_user_id, content, seq, created_at, thread_root_id)
         VALUES ('m-after', 'c-1', 'user', 'u-1', 'after the drop', 4, 500, 'm-plain')`,
      ).run();
      expect(
        db.prepare(`SELECT thread_root_id FROM messages WHERE id = 'm-after'`).get(),
      ).toEqual({ thread_root_id: 'm-plain' });
      // A reply whose root is itself a reply is still refused by the trigger.
      expect(() =>
        db
          .prepare(
            `INSERT INTO messages
               (id, conversation_id, from_kind, from_user_id, content, seq, created_at, thread_root_id)
             VALUES ('m-nested', 'c-1', 'user', 'u-1', 'nested', 5, 600, 'm-reply')`,
          )
          .run(),
      ).toThrow();
      // And the columns are truly gone from the write surface, not just hidden.
      expect(() =>
        db.prepare(`UPDATE messages SET task_number = 1 WHERE id = 'm-plain'`).run(),
      ).toThrow(/no such column: task_number/);
    } finally {
      db.close();
    }
  });

  it('keeps a real v59 carrier lossless: v60 copies it to tasks, v87 drops the original', () => {
    const db = openDbThrough(59);
    try {
      // A v59-shaped graph. It has to be complete, not a stub: every migration
      // between 60 and 87 runs for real here, and v76 (board_key) refuses a task
      // whose owner conversation cannot yield a board — which is precisely the
      // production invariant this row must satisfy to be worth carrying forward.
      db.exec(`
        INSERT INTO users (id, name, display_name, created_at, updated_at)
        VALUES ('u1', 'legacy-one', 'One', 0, 0);
        INSERT INTO hosts (id, kind, name, created_at)
        VALUES ('h1', 'local', 'host', 0);
        INSERT INTO agents
          (id, name, runtime, host_id, created_at, updated_at, created_by_user_id)
        VALUES ('ag1', 'legacy-agent', 'claude', 'h1', 0, 0, 'u1');
        INSERT INTO workspaces
          (id, name, description, workspace_kind, workspace_path, workspace_host_id,
           owner_agent_id, archived_at, created_at, updated_at)
        VALUES ('w1', 'Eng', NULL, 'regular', '/tmp/eng', 'h1', NULL, NULL, 0, 0);
        INSERT INTO conversations
          (id, workspace_id, workspace_path, kind, title, status, created_at, updated_at)
        VALUES ('c1', 'w1', '/tmp/eng', 'channel', 'general', 'idle', 1, 1);
      `);
      db.prepare(
        `INSERT INTO messages
           (id, conversation_id, from_kind, from_agent_id, content, seq, created_at,
            task_number, task_status, task_title, task_workspace_id, source_message_id,
            task_revision, task_last_editor_kind, task_last_editor_id, task_last_edited_at)
         VALUES
           ('legacy-src', 'c1', 'agent', 'ag1', 'the prompting message', 1, 1000,
            NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`,
      ).run();
      db.prepare(
        `INSERT INTO messages
           (id, conversation_id, from_kind, from_agent_id, content, seq, created_at,
            task_number, task_status, task_title, task_workspace_id, source_message_id,
            task_revision, task_last_editor_kind, task_last_editor_id, task_last_edited_at)
         VALUES
           ('legacy-anchor', 'c1', 'agent', 'ag1', 'body of the legacy task', 2, 2000,
            41, 'in_progress', 'Legacy task', 'w1', 'legacy-src',
            3, 'agent', 'ag1', 2500)`,
      ).run();

      // The REAL upgrade path: v60's backfill, then everything up to and
      // including v87 — no hand-written stand-in for either step.
      upgradeThrough(db, 87);

      expect(messageColumns(db)).toEqual(
        expect.not.arrayContaining(DEAD_COLUMNS),
      );
      // Every field the dropped columns held is readable from the aggregate that
      // now owns it, under the same identity (tasks.id == the anchor message id).
      const task = db.prepare(`SELECT * FROM tasks WHERE id = 'legacy-anchor'`).get() as Record<
        string,
        unknown
      >;
      expect(task).toMatchObject({
        id: 'legacy-anchor',
        task_number: 41,
        status: 'in_progress',
        title: 'Legacy task',
        content: 'body of the legacy task',
        workspace_id: 'w1',
        source_message_id: 'legacy-src',
        last_editor_kind: 'agent',
        last_editor_id: 'ag1',
        last_edited_at: 2500,
      });
      // The anchor message itself is NOT deleted — only its task costume.
      expect(
        db.prepare(`SELECT content FROM messages WHERE id = 'legacy-anchor'`).get(),
      ).toEqual({ content: 'body of the legacy task' });
    } finally {
      db.close();
    }
  });

  it('re-opens an already-migrated database without re-evaluating the precondition', () => {
    const db = new Database(':memory:');
    try {
      // The production runner, twice, exactly as two consecutive boots.
      const first = runMigrations(db);
      expect(first.appliedSteps).toContain(87);
      const afterFirst = schema(db);

      // A post-v87 world with a real task in it: `tasks` is populated while the
      // dropped columns no longer exist. The v87 precondition is written against
      // `messages.task_number`, so this is the shape that would make a
      // re-evaluated hook fail to prepare.
      seedGraph(db);
      insertCanonicalTask(db, { id: 'm-live', taskNumber: 1 });
      const tasksBefore = db.prepare(`SELECT * FROM tasks ORDER BY id`).all();

      const second = runMigrations(db);

      // Nothing was applied the second time, and the schema/rows are identical.
      expect(second.appliedSteps).toEqual([]);
      expect(second.afterStep).toBe(first.afterStep);
      expect(schema(db)).toEqual(afterFirst);
      expect(db.prepare(`SELECT * FROM tasks ORDER BY id`).all()).toEqual(tasksBefore);
      // Applied once, recorded once.
      expect(
        db.prepare('SELECT COUNT(*) AS n FROM _migrations WHERE version = 87').get(),
      ).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  });
});
