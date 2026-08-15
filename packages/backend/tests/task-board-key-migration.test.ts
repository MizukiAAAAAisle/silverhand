import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrations } from '@silverhand/shared/db/migrations';

// Migration v76 (task_board_key, #task:2022 P0-f) falsifiers.
//
// v76 rebuilds `tasks` so the numbering namespace becomes a first-class BOARD
// coordinate: `board_key` = 'ws:'||workspace_id | 'pair:'||pair_key, derived
// from the owning conversation's placement and PROVEN at INSERT. These tests
// drive the REAL migration over seeded v75 data and lock the properties whose
// silent failure would corrupt boards or renumber history:
//   1. Legacy rows migrate with ZERO renumbering: (board_key, task_number)
//      resolves row-for-row identically to the old (workspace_id, task_number)
//      business key, and every other column survives byte-for-byte.
//   2. The rebuild keeps referential integrity (foreign_key_check empty) and
//      the board unique index replaces the workspace one.
//   3. Board identity is proven, not trusted: a well-formed FORGED key (a
//      'pair:' key on a workspace task, another workspace's legal 'ws:' key)
//      is rejected; agent_inbox derives NO board and is rejected; the pair
//      arm accepts exactly the conversation's own 'pair:'||pair_key.
//   4. Birth coordinates are immutable (board_key / conversation_id /
//      workspace_id UPDATEs abort) and the arc CHECKs refuse both mismatch
//      directions plus foreign prefixes.
//   5. Numbering is per board: two pairs each start at 1 independently of the
//      workspace board sharing the same numbers.

/** Apply every migration up to and including `maxVersion` onto a fresh
 *  in-memory DB. FK enforcement OFF so we can seed minimal rows. */
function openDbThrough(maxVersion: number): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF');
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      name    TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);
  const insertMigration = db.prepare(
    'INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, 0)',
  );
  for (const m of migrations) {
    if (m.version > maxVersion) break;
    const apply = () => {
      m.precondition?.(db as never);
      db.exec(m.up);
      insertMigration.run(m.version, m.name);
    };
    if (m.foreignKeyEscape) {
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

function applyV76(db: Database.Database): void {
  const v76 = migrations.find(m => m.version === 76)!;
  db.pragma('legacy_alter_table = ON');
  try {
    db.transaction(() => {
      v76.precondition?.(db as never);
      db.exec(v76.up);
      db.prepare('INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, 0)').run(
        v76.version,
        v76.name,
      );
    })();
  } finally {
    db.pragma('legacy_alter_table = OFF');
  }
}

/** Minimal placement-valid conversations (v75 CHECK arcs). */
function seedPlaces(db: Database.Database): void {
  db.exec(`
    -- Endpoint principals first: v73's birth validation requires every
    -- direct_pair endpoint to name an existing principal of its kind.
    INSERT INTO users (id, name, display_name, created_at, updated_at)
    VALUES ('user-1', 'shiki-fixture', 'shiki', 0, 0);
    INSERT INTO hosts (id, kind, name, created_at)
    VALUES ('host-1', 'local', 'fixture host', 0);
    INSERT INTO agents (id, name, runtime, host_id, created_at, updated_at, created_by_user_id)
    VALUES
      ('agent-1', 'alpha-fixture', 'claude', 'host-1', 0, 0, 'user-1'),
      ('agent-2', 'beta-fixture', 'claude', 'host-1', 0, 0, 'user-1');

    INSERT INTO workspaces (id, name, workspace_kind, created_at, updated_at)
    VALUES ('ws-a', 'A', 'regular', 0, 0), ('ws-b', 'B', 'regular', 0, 0);

    INSERT INTO conversations (
      id, workspace_id, placement_kind, roster_policy, title, title_key, status,
      created_at, updated_at
    ) VALUES
      ('conv-a', 'ws-a', 'workspace', 'open', 'chan a', 'chan a', 'idle', 0, 0),
      ('conv-b', 'ws-b', 'workspace', 'open', 'chan b', 'chan b', 'idle', 0, 0);

    INSERT INTO conversations (
      id, inbox_agent_id, placement_kind, roster_policy, title, status,
      created_at, updated_at
    ) VALUES ('conv-inbox', 'agent-1', 'agent_inbox', 'fixed', 'Mentions', 'idle', 0, 0);

    INSERT INTO conversations (
      id, placement_kind, roster_policy, title, status,
      endpoint_a_kind, endpoint_a_id, endpoint_b_kind, endpoint_b_id,
      created_at, updated_at
    ) VALUES
      ('conv-p1', 'direct_pair', 'fixed', '', 'idle', 'agent', 'agent-1', 'agent', 'agent-2', 0, 0),
      ('conv-p2', 'direct_pair', 'fixed', '', 'idle', 'agent', 'agent-1', 'human', 'user-1', 0, 0);
  `);
}

function seedLegacyTask(
  db: Database.Database,
  id: string,
  workspaceId: string,
  conversationId: string,
  n: number,
): void {
  db.prepare(
    `INSERT INTO tasks (
       id, workspace_id, task_number, conversation_id, title, content, status,
       creator_kind, creator_user_id, created_at
     ) VALUES (?, ?, ?, ?, ?, '', 'todo', 'user', 'user-1', ?)`,
  ).run(id, workspaceId, n, conversationId, `task ${n}`, 1000 + n);
}

const pairKeyOf = (db: Database.Database, conversationId: string): string =>
  (db.prepare('SELECT pair_key AS k FROM conversations WHERE id = ?').get(conversationId) as {
    k: string;
  }).k;

function insertPostV76(
  db: Database.Database,
  args: { id: string; ws: string | null; board: string; conv: string; n: number },
): void {
  db.prepare(
    `INSERT INTO tasks (
       id, workspace_id, board_key, task_number, conversation_id, title, content,
       status, creator_kind, creator_user_id, created_at
     ) VALUES (?, ?, ?, ?, ?, 't', '', 'todo', 'user', 'user-1', 0)`,
  ).run(args.id, args.ws, args.board, args.n, args.conv);
}

/** Exact pre-v76 table + data fingerprint. Shared by both precondition
 * falsifiers so their claim is stronger than "board_key is absent": a failed
 * upgrade leaves the old DDL and every task byte-for-byte untouched. */
function legacyTaskState(db: Database.Database): {
  sql: string;
  rows: Record<string, unknown>[];
} {
  const schema = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'")
    .get() as { sql: string };
  const rows = db.prepare('SELECT * FROM tasks ORDER BY id').all() as Record<string, unknown>[];
  return { sql: schema.sql, rows };
}

describe('v76 task_board_key — legacy carry (zero renumbering)', () => {
  it('fails loud before rebuild when a v75 task workspace diverges from its conversation', () => {
    const db = openDbThrough(75);
    seedPlaces(db);
    // v75 permits this half-state: the task claims ws-b while its owner
    // conversation is in ws-a. Freezing either coordinate into board_key
    // would preserve a split authority, so v76 must refuse the upgrade.
    seedLegacyTask(db, 't-divergent', 'ws-b', 'conv-a', 1);
    const before = legacyTaskState(db);

    expect(() => applyV76(db)).toThrow(
      /1 task row\(s\) cannot derive.*t-divergent:workspace_mismatch/s,
    );
    expect(legacyTaskState(db)).toEqual(before);
    expect(before.sql).not.toContain('board_key');
  });

  it('fails loud before any DDL when a real v75 task has no owner conversation', () => {
    const db = openDbThrough(75);
    seedPlaces(db);
    // The harness deliberately keeps FK enforcement off: this is the exact
    // legacy half-state foreignKeyEscape would otherwise hide from both the
    // INNER-JOIN backfill and the final foreign_key_check. Without the LEFT
    // JOIN precondition the row would disappear when tasks is rebuilt.
    seedLegacyTask(db, 't-orphan', 'ws-a', 'missing-conversation', 7);
    const before = legacyTaskState(db);

    expect(() => applyV76(db)).toThrow(
      /1 task row\(s\) cannot derive.*t-orphan:missing_owner/s,
    );
    expect(legacyTaskState(db)).toEqual(before);
    expect(before.sql).not.toContain('board_key');
  });

  it('backfills ws:<workspace_id> row-for-row; every column survives; FK check empty', () => {
    const db = openDbThrough(75);
    seedPlaces(db);
    // Same local numbers on two workspace boards — the collision that proves
    // numbering stays per-board through the rebuild.
    seedLegacyTask(db, 't-a1', 'ws-a', 'conv-a', 1);
    seedLegacyTask(db, 't-a2', 'ws-a', 'conv-a', 2);
    seedLegacyTask(db, 't-b1', 'ws-b', 'conv-b', 1);
    const before = db
      .prepare('SELECT * FROM tasks ORDER BY id')
      .all() as Record<string, unknown>[];

    applyV76(db);

    const after = db
      .prepare('SELECT * FROM tasks ORDER BY id')
      .all() as Record<string, unknown>[];
    expect(after).toHaveLength(before.length);
    for (const [i, row] of after.entries()) {
      const legacy = before[i]!;
      // The new key is the pure function of the old one…
      expect(row.board_key).toBe(`ws:${legacy.workspace_id as string}`);
      // …and EVERY legacy column survives byte-for-byte, numbers included.
      for (const [col, value] of Object.entries(legacy)) {
        expect(row[col], `${row.id as string}.${col}`).toStrictEqual(value);
      }
    }
    // Old business key ↔ new business key resolve to the same rows.
    for (const legacy of before) {
      const viaBoard = db
        .prepare('SELECT id FROM tasks WHERE board_key = ? AND task_number = ?')
        .get(`ws:${legacy.workspace_id as string}`, legacy.task_number) as { id: string };
      expect(viaBoard.id).toBe(legacy.id);
    }
    expect(db.pragma('foreign_key_check')).toEqual([]);
    // The board unique index REPLACED the workspace one (two unique axes over
    // one namespace would be a second authority).
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'tasks'")
      .all()
      .map(r => (r as { name: string }).name);
    expect(indexes).toContain('uniq_tasks_board_number');
    expect(indexes).not.toContain('uniq_tasks_workspace_number');
  });
});

describe('v76 task_board_key — board identity is proven, not trusted', () => {
  function migrated(): Database.Database {
    const db = openDbThrough(76);
    seedPlaces(db);
    return db;
  }

  it('accepts exactly the placement-derived key on both arms', () => {
    const db = migrated();
    insertPostV76(db, { id: 'w1', ws: 'ws-a', board: 'ws:ws-a', conv: 'conv-a', n: 1 });
    const pk = pairKeyOf(db, 'conv-p1');
    insertPostV76(db, { id: 'p1', ws: null, board: `pair:${pk}`, conv: 'conv-p1', n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({ n: 2 });
  });

  it('rejects a WELL-FORMED forged key: pair: on a workspace task, another board’s legal ws: key, and a mismatched pair key', () => {
    const db = migrated();
    const pk1 = pairKeyOf(db, 'conv-p1');
    const pk2 = pairKeyOf(db, 'conv-p2');
    // A shape-valid pair key on a workspace conversation. NOT NULL + prefix
    // CHECK + immutability alone would admit this — only the
    // derivation-equality trigger refuses it (the arc CHECK also objects to
    // the null-ness mismatch, so use workspace_id = NULL to isolate the
    // trigger: arc CHECKs pass, derivation must still refuse).
    expect(() =>
      insertPostV76(db, { id: 'x1', ws: null, board: `pair:${pk1}`, conv: 'conv-a', n: 7 }),
    ).toThrow(/board derived from the conversation placement/);
    // Another workspace's perfectly legal ws: key.
    expect(() =>
      insertPostV76(db, { id: 'x2', ws: 'ws-b', board: 'ws:ws-b', conv: 'conv-a', n: 7 }),
    ).toThrow(/board derived from the conversation placement/);
    // The board key itself is correct for conv-a, but the task separately
    // lies about workspace_id. This is the subtle split the old trigger did
    // not see: numbering would be in A while workspace reads returned B.
    expect(() =>
      insertPostV76(db, { id: 'x2b', ws: 'ws-b', board: 'ws:ws-a', conv: 'conv-a', n: 8 }),
    ).toThrow(/board derived from the conversation placement/);
    // The WRONG pair's key on a pair conversation.
    expect(() =>
      insertPostV76(db, { id: 'x3', ws: null, board: `pair:${pk2}`, conv: 'conv-p1', n: 7 }),
    ).toThrow(/board derived from the conversation placement/);
  });

  it('agent_inbox derives NO board: any insert is refused (the DB-level "inbox has no board" rule)', () => {
    const db = migrated();
    expect(() =>
      insertPostV76(db, { id: 'x4', ws: null, board: 'ws:ws-a', conv: 'conv-inbox', n: 1 }),
    ).toThrow(/CHECK|board derived/);
    expect(() =>
      insertPostV76(db, { id: 'x5', ws: null, board: `pair:${pairKeyOf(db, 'conv-p1')}`, conv: 'conv-inbox', n: 1 }),
    ).toThrow(/board derived from the conversation placement/);
  });

  it('arc CHECKs refuse both mismatch directions and any foreign prefix — independently of the trigger', () => {
    const db = migrated();
    // The BEFORE INSERT derivation trigger fires ahead of table CHECKs, so on
    // the intact schema every illegal row reports the trigger's message —
    // either guard refusing is the shipped contract.
    for (const [id, ws, board, conv] of [
      ['x6', null, 'ws:ws-a', 'conv-a'],
      ['x7', 'ws-a', `pair:${pairKeyOf(db, 'conv-p1')}`, 'conv-p1'],
      ['x8', 'ws-a', 'team:ws-a', 'conv-a'],
      ['x9', null, 'team:ws-a', 'conv-p1'],
    ] as const) {
      expect(() =>
        insertPostV76(db, { id, ws, board, conv, n: 9 }),
      ).toThrow(/CHECK|board derived/);
    }
    // Sacrificial probe: DROP the trigger to prove the arc CHECKs bite on
    // their own (defense in depth is only real if each layer refuses alone).
    db.exec('DROP TRIGGER trg_tasks_board_key_derivation_insert');
    for (const [id, ws, board, conv] of [
      ['y6', null, 'ws:ws-a', 'conv-a'],
      ['y7', 'ws-a', `pair:${pairKeyOf(db, 'conv-p1')}`, 'conv-p1'],
      ['y8', 'ws-a', 'team:ws-a', 'conv-a'],
      ['y9', null, 'team:ws-a', 'conv-p1'],
    ] as const) {
      expect(() =>
        insertPostV76(db, { id, ws, board, conv, n: 9 }),
      ).toThrow(/CHECK/);
    }
  });

  it('birth coordinates are immutable: board_key / conversation_id / workspace_id updates abort', () => {
    const db = migrated();
    insertPostV76(db, { id: 'w1', ws: 'ws-a', board: 'ws:ws-a', conv: 'conv-a', n: 1 });
    for (const set of [
      "board_key = 'ws:ws-b'",
      "conversation_id = 'conv-b'",
      "workspace_id = 'ws-b'",
    ]) {
      expect(() => db.exec(`UPDATE tasks SET ${set} WHERE id = 'w1'`)).toThrow(
        /board coordinates are immutable/,
      );
    }
    // Non-coordinate updates keep working (the workflow columns).
    db.exec("UPDATE tasks SET status = 'in_progress', assignee_agent_id = 'agent-1' WHERE id = 'w1'");
  });

  it('numbering is per board: two pairs and a workspace board each own an independent 1,2,…', () => {
    const db = migrated();
    const pk1 = pairKeyOf(db, 'conv-p1');
    const pk2 = pairKeyOf(db, 'conv-p2');
    insertPostV76(db, { id: 'w1', ws: 'ws-a', board: 'ws:ws-a', conv: 'conv-a', n: 1 });
    insertPostV76(db, { id: 'p1a', ws: null, board: `pair:${pk1}`, conv: 'conv-p1', n: 1 });
    insertPostV76(db, { id: 'p1b', ws: null, board: `pair:${pk1}`, conv: 'conv-p1', n: 2 });
    insertPostV76(db, { id: 'p2a', ws: null, board: `pair:${pk2}`, conv: 'conv-p2', n: 1 });
    // Same (board, number) twice is the ONE forbidden collision.
    expect(() =>
      insertPostV76(db, { id: 'p1c', ws: null, board: `pair:${pk1}`, conv: 'conv-p1', n: 2 }),
    ).toThrow(/UNIQUE/);
  });
});
