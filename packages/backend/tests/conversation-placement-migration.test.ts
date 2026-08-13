import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrations } from '@silverhand/shared/db/migrations';

// Migration v69 (conversation_placement_and_roster_policy) falsifiers —
// agent-scoped-session-v1 §4.1 / §8 P0-a (#task:2012).
//
// v69 splits `conversations.kind` into `placement_kind` × `roster_policy` and
// turns `kind` into a GENERATED ALWAYS ... VIRTUAL projection of the latter.
// Because an existing plain column cannot become generated in place, it is a
// TABLE REBUILD — and a rebuild's failure mode is not a loud error, it is
// SILENTLY dropping a constraint, an index, a column value, or (with FK
// enforcement escaped for the migration) a whole child table's rows. So the
// assertions here are deliberately exhaustive rather than sampled:
//
//   (1) data      — every pre-existing row survives with every column
//                   byte-identical, and its derived `kind` equals the value it
//                   had before, row by row.
//   (2) children  — `DROP TABLE conversations` under `foreignKeyEscape` must not
//                   cascade-delete messages / conversation_users / tasks, and
//                   `foreign_key_check` must be empty afterwards.
//   (3) schema    — all three `idx_conversations_*` are back with their exact
//                   definitions, the generated column is present-but-hidden, and
//                   the rewritten `visibility` CHECK still refuses public on a
//                   fixed roster (INSERT *and* UPDATE paths).
//   (4) write gate— `kind` is unwritable at PARSE time, which is what licenses
//                   the TS layer to carry no mirrored derivation.
//   (5) plan      — the index over the VIRTUAL generated column is actually
//                   usable by the planner, not just legal to declare. A generated
//                   column that silently degrades `kind = ?` lookups to a table
//                   scan would be a performance regression with no red light.
//
// Delete any single piece of v69 and at least one assertion here goes red.
//
// The whole-schema fingerprint for this migration lives in the living golden of
// migration-baseline.test.ts (`schema-current.normalized.txt`), which is
// regenerated with UPDATE_SCHEMA_SNAPSHOT=1 and reviewed as a diff; this file
// owns the behavioral half. All DBs are `:memory:` (shiki gate §6).

/** Apply every migration up to and including `maxVersion` onto a fresh
 *  in-memory DB, through the same escape semantics the production runner uses
 *  for a rebuild migration. */
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

function applyV69(db: Database.Database): void {
  const v69 = migrations.find(m => m.version === 69);
  expect(v69).toBeDefined();
  expect(v69!.foreignKeyEscape).toBe(true);
  db.pragma('legacy_alter_table = ON');
  try {
    db.transaction(() => {
      db.exec(v69!.up);
      db.prepare(
        'INSERT INTO _migrations (version, name, applied_at) VALUES (69, ?, 0)',
      ).run(v69!.name);
    })();
  } finally {
    db.pragma('legacy_alter_table = OFF');
  }
  // The escape disables FK enforcement for the whole migration; the runner's
  // post-condition is that every surviving FK still validates.
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
}

/**
 * A v68 fixture that spans the whole legal state space of the retiring column
 * and, deliberately, of every OTHER column the rebuild has to carry across:
 * both kinds × both visibilities × populated/NULL optionals × a non-default
 * `latest_message_seq`. Only FK-clean tables are seeded (no hosts/agents), so
 * `foreign_key_check` failing later means the rebuild broke a real edge.
 */
function seedV68(db: Database.Database): void {
  db.prepare(
    `INSERT INTO users (id, name, display_name, created_at, updated_at)
     VALUES ('u1', 'u1', 'U One', 0, 0)`,
  ).run();
  db.prepare(
    `INSERT INTO workspaces
       (id, name, description, workspace_kind, owner_agent_id,
        archived_at, created_at, updated_at, pinned_at, owner_user_id)
     VALUES ('w1', 'w1', NULL, 'regular', NULL, NULL, 0, 0, NULL, 'u1')`,
  ).run();

  const insertConversation = db.prepare(
    `INSERT INTO conversations
       (id, workspace_id, kind, title, status, spawned_by_agent_id,
        closed_at, close_summary, pinned_at, created_at, updated_at,
        archived_at, latest_message_seq, visibility)
     VALUES (@id, 'w1', @kind, @title, @status, NULL,
             @closed_at, @close_summary, @pinned_at, @created_at, @updated_at,
             @archived_at, @latest_message_seq, @visibility)`,
  );
  const rows = [
    {
      id: 'c_chan_bare', kind: 'channel', title: 'bare channel', status: 'idle',
      closed_at: null, close_summary: null, pinned_at: null,
      created_at: 10, updated_at: 11, archived_at: null,
      latest_message_seq: 0, visibility: 'private',
    },
    {
      id: 'c_chan_public', kind: 'channel', title: 'public channel', status: 'active',
      closed_at: null, close_summary: null, pinned_at: null,
      created_at: 20, updated_at: 21, archived_at: null,
      latest_message_seq: 7, visibility: 'public',
    },
    {
      id: 'c_chan_full', kind: 'channel', title: 'closed archived channel',
      status: 'archived',
      closed_at: 33, close_summary: 'wrapped up', pinned_at: 34,
      created_at: 30, updated_at: 31, archived_at: 32,
      latest_message_seq: 99, visibility: 'private',
    },
    {
      id: 'c_dm_bare', kind: 'dm_channel', title: 'bare dm', status: 'idle',
      closed_at: null, close_summary: null, pinned_at: null,
      created_at: 40, updated_at: 41, archived_at: null,
      latest_message_seq: 0, visibility: 'private',
    },
    {
      id: 'c_dm_full', kind: 'dm_channel', title: 'closed archived dm',
      status: 'crashed',
      closed_at: 53, close_summary: 'done', pinned_at: 54,
      created_at: 50, updated_at: 51, archived_at: 52,
      latest_message_seq: 3, visibility: 'private',
    },
  ];
  for (const row of rows) insertConversation.run(row);

  // Children on three distinct cascade edges into `conversations`.
  db.prepare(
    `INSERT INTO messages (id, conversation_id, from_kind, from_user_id, content, seq, created_at)
     VALUES ('m1', 'c_chan_bare', 'user', 'u1', 'hello', 1, 60)`,
  ).run();
  db.prepare(
    `INSERT INTO messages (id, conversation_id, from_kind, from_user_id, content, seq, created_at)
     VALUES ('m2', 'c_dm_full', 'user', 'u1', 'dm body', 1, 61)`,
  ).run();
  db.prepare(
    `INSERT INTO conversation_users (conversation_id, user_id, joined_at)
     VALUES ('c_chan_bare', 'u1', 62)`,
  ).run();
  db.prepare(
    `INSERT INTO tasks
       (id, workspace_id, task_number, conversation_id, thread_root_id, title,
        content, status, creator_kind, created_at)
     VALUES ('t1', 'w1', 1, 'c_chan_bare', NULL, 'a task', '', 'todo', 'system', 63)`,
  ).run();
}

type Row = Record<string, unknown>;

function conversationRows(db: Database.Database): Row[] {
  return db.prepare<[], Row>('SELECT * FROM conversations ORDER BY id').all();
}

function schemaSql(db: Database.Database, name: string): string {
  const row = db
    .prepare<[string], { sql: string }>(
      `SELECT sql FROM sqlite_master WHERE name = ?`,
    )
    .get(name);
  return (row?.sql ?? '').replace(/\s+/g, ' ').trim();
}

describe('migration v69 conversation placement × roster policy — data', () => {
  it('carries every pre-existing row across the rebuild byte-identically', () => {
    const db = openDbThrough(68);
    try {
      seedV68(db);
      const before = conversationRows(db);
      expect(before).toHaveLength(5);

      applyV69(db);

      const after = conversationRows(db);
      expect(after.map(r => r.id)).toEqual(before.map(r => r.id));
      for (const [i, row] of after.entries()) {
        const prior = before[i]!;
        // Every column that existed at v68 — including the DERIVED `kind` —
        // must be identical. Not a subset, not a spot check: the full column
        // set of the old row.
        for (const [column, value] of Object.entries(prior)) {
          expect({ id: row.id, column, value: row[column] }).toEqual({
            id: row.id,
            column,
            value,
          });
        }
      }
    } finally {
      db.close();
    }
  });

  it('backfills the two authoritative axes from the retiring column, totally', () => {
    const db = openDbThrough(68);
    try {
      seedV68(db);
      applyV69(db);

      expect(
        db
          .prepare<[], { id: string; placement_kind: string; roster_policy: string; kind: string }>(
            'SELECT id, placement_kind, roster_policy, kind FROM conversations ORDER BY id',
          )
          .all(),
      ).toEqual([
        { id: 'c_chan_bare', placement_kind: 'workspace', roster_policy: 'open', kind: 'channel' },
        { id: 'c_chan_full', placement_kind: 'workspace', roster_policy: 'open', kind: 'channel' },
        { id: 'c_chan_public', placement_kind: 'workspace', roster_policy: 'open', kind: 'channel' },
        { id: 'c_dm_bare', placement_kind: 'workspace', roster_policy: 'fixed', kind: 'dm_channel' },
        { id: 'c_dm_full', placement_kind: 'workspace', roster_policy: 'fixed', kind: 'dm_channel' },
      ]);
      // Totality: no row escaped the backfill into a NULL axis.
      expect(
        db
          .prepare<[], { n: number }>(
            `SELECT COUNT(*) AS n FROM conversations
             WHERE placement_kind IS NULL OR roster_policy IS NULL`,
          )
          .get()?.n,
      ).toBe(0);
    } finally {
      db.close();
    }
  });

  it('leaves the 14-row-shaped fixed-roster population private and unchanged', () => {
    const db = openDbThrough(68);
    try {
      seedV68(db);
      applyV69(db);
      // The live population's load-bearing property (design §"先测量再设计"):
      // every fixed-roster conversation stays private and still reads as
      // `dm_channel` on the wire.
      expect(
        db
          .prepare<[], { id: string; visibility: string; kind: string }>(
            `SELECT id, visibility, kind FROM conversations
             WHERE roster_policy = 'fixed' ORDER BY id`,
          )
          .all(),
      ).toEqual([
        { id: 'c_dm_bare', visibility: 'private', kind: 'dm_channel' },
        { id: 'c_dm_full', visibility: 'private', kind: 'dm_channel' },
      ]);
    } finally {
      db.close();
    }
  });

  it('does not cascade-delete children while FK enforcement is escaped', () => {
    const db = openDbThrough(68);
    try {
      seedV68(db);
      applyV69(db);

      expect(
        db.prepare<[], { id: string; conversation_id: string; content: string }>(
          'SELECT id, conversation_id, content FROM messages ORDER BY id',
        ).all(),
      ).toEqual([
        { id: 'm1', conversation_id: 'c_chan_bare', content: 'hello' },
        { id: 'm2', conversation_id: 'c_dm_full', content: 'dm body' },
      ]);
      expect(
        db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM conversation_users').get()?.n,
      ).toBe(1);
      expect(
        db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM tasks').get()?.n,
      ).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe('migration v69 conversation placement × roster policy — schema', () => {
  it('restores all three conversation indexes with their exact definitions', () => {
    const db = openDbThrough(68);
    try {
      const before = {
        workspace: schemaSql(db, 'idx_conversations_workspace'),
        status: schemaSql(db, 'idx_conversations_status'),
        archived: schemaSql(db, 'idx_conversations_archived_at'),
      };
      applyV69(db);
      // Byte-identical: the rebuild must not quietly change an access path.
      expect({
        workspace: schemaSql(db, 'idx_conversations_workspace'),
        status: schemaSql(db, 'idx_conversations_status'),
        archived: schemaSql(db, 'idx_conversations_archived_at'),
      }).toEqual(before);
      expect(before.workspace).toContain('kind');
    } finally {
      db.close();
    }
  });

  it('keeps `kind` a hidden generated column and both axes NOT NULL', () => {
    const db = openDbThrough(68);
    try {
      applyV69(db);
      // PRAGMA table_info OMITS generated columns; only table_xinfo shows them
      // (hidden = 2 for VIRTUAL). Both facts are asserted so a future switch to
      // a plain or STORED column cannot pass silently.
      const info = db
        .prepare<[], { name: string; notnull: number }>('PRAGMA table_info(conversations)')
        .all();
      expect(info.map(c => c.name)).not.toContain('kind');
      expect(
        info
          .filter(c => c.name === 'placement_kind' || c.name === 'roster_policy')
          .map(c => ({ name: c.name, notnull: c.notnull })),
      ).toEqual([
        { name: 'placement_kind', notnull: 1 },
        { name: 'roster_policy', notnull: 1 },
      ]);

      const xinfo = db
        .prepare<[], { name: string; hidden: number }>('PRAGMA table_xinfo(conversations)')
        .all();
      expect(xinfo.find(c => c.name === 'kind')?.hidden).toBe(2);
      expect(schemaSql(db, 'conversations')).toContain('GENERATED ALWAYS AS');
    } finally {
      db.close();
    }
  });

  it('keeps the `kind = ?` access path on the index, not a table scan', () => {
    const db = openDbThrough(68);
    try {
      seedV68(db);
      applyV69(db);
      // Declaring an index over a VIRTUAL generated column is legal; the
      // falsifier is that the PLANNER still uses it. Otherwise every
      // `workspace_id + kind` list query silently degrades to a scan.
      const plan = db
        .prepare<[], { detail: string }>(
          `EXPLAIN QUERY PLAN
             SELECT id FROM conversations
             WHERE workspace_id = 'w1' AND kind = 'channel'
             ORDER BY updated_at DESC`,
        )
        .all()
        .map(r => r.detail)
        .join(' | ');
      expect(plan).toContain('idx_conversations_workspace');
      expect(plan).not.toContain('SCAN conversations');
    } finally {
      db.close();
    }
  });
});

describe('migration v69 conversation placement × roster policy — write gates', () => {
  const insertOpen = (db: Database.Database, id: string, extra = '') =>
    db
      .prepare(
        `INSERT INTO conversations
           (id, workspace_id, placement_kind, roster_policy, title, status,
            created_at, updated_at${extra ? ', visibility' : ''})
         VALUES ('${id}', 'w1', 'workspace', 'open', 't', 'idle', 0, 0${extra})`,
      )
      .run();

  function freshV69(): Database.Database {
    const db = openDbThrough(68);
    seedV68(db);
    applyV69(db);
    return db;
  }

  it('refuses to write `kind` at parse time (INSERT and UPDATE)', () => {
    const db = freshV69();
    try {
      // Parse-time refusal is the whole reason the TS layer keeps no mirrored
      // derivation: a drifting write cannot even be prepared.
      expect(() =>
        db.prepare(
          `INSERT INTO conversations
             (id, workspace_id, placement_kind, roster_policy, kind, title, status,
              created_at, updated_at)
           VALUES ('x1', 'w1', 'workspace', 'open', 'channel', 't', 'idle', 0, 0)`,
        ),
      ).toThrow(/generated column/i);
      expect(() =>
        db.prepare(`UPDATE conversations SET kind = 'dm_channel' WHERE id = 'c_dm_bare'`),
      ).toThrow(/generated column/i);
    } finally {
      db.close();
    }
  });

  it('rejects an unknown value on either axis', () => {
    const db = freshV69();
    try {
      expect(() =>
        db
          .prepare(
            `INSERT INTO conversations
               (id, workspace_id, placement_kind, roster_policy, title, status, created_at, updated_at)
             VALUES ('x2', 'w1', 'somewhere', 'open', 't', 'idle', 0, 0)`,
          )
          .run(),
      ).toThrow();
      expect(() =>
        db
          .prepare(
            `INSERT INTO conversations
               (id, workspace_id, placement_kind, roster_policy, title, status, created_at, updated_at)
             VALUES ('x3', 'w1', 'workspace', 'semi_open', 't', 'idle', 0, 0)`,
          )
          .run(),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it('refuses a placement that is not yet representable at this version', () => {
    const db = freshV69();
    try {
      // P0-a introduces the axis, not the placements: with no `pair_key` /
      // `inbox_agent_id` column and `workspace_id` still NOT NULL, a
      // non-workspace row would be a half-modeled conversation. The gate is
      // fail-closed so the migration that first admits one (§8 P0-b / P3) MUST
      // relax it — which is exactly where the `JOIN workspaces` read surfaces
      // get re-audited for silently dropped rows.
      for (const placement of ['direct_pair', 'agent_inbox']) {
        expect(() =>
          db
            .prepare(
              `INSERT INTO conversations
                 (id, workspace_id, placement_kind, roster_policy, title, status, created_at, updated_at)
               VALUES ('x-${placement}', 'w1', '${placement}', 'fixed', 't', 'idle', 0, 0)`,
            )
            .run(),
        ).toThrow();
      }
      expect(
        db
          .prepare<[], { n: number }>(
            `SELECT COUNT(*) AS n FROM conversations WHERE placement_kind <> 'workspace'`,
          )
          .get()?.n,
      ).toBe(0);
    } finally {
      db.close();
    }
  });

  it('still allows public only on an open roster (rewritten CHECK, INSERT path)', () => {
    const db = freshV69();
    try {
      expect(() => insertOpen(db, 'x_pub', `, 'public'`)).not.toThrow();
      expect(() =>
        db
          .prepare(
            `INSERT INTO conversations
               (id, workspace_id, placement_kind, roster_policy, title, status,
                created_at, updated_at, visibility)
             VALUES ('x_fixed_pub', 'w1', 'workspace', 'fixed', 't', 'idle', 0, 0, 'public')`,
          )
          .run(),
      ).toThrow();
      expect(() =>
        db
          .prepare(
            `INSERT INTO conversations
               (id, workspace_id, placement_kind, roster_policy, title, status,
                created_at, updated_at, visibility)
             VALUES ('x_unlisted', 'w1', 'workspace', 'open', 't', 'idle', 0, 0, 'unlisted')`,
          )
          .run(),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it('still refuses to make an existing conversation illegally public (UPDATE path)', () => {
    const db = freshV69();
    try {
      // Both directions of the cross-column rule, on the sibling column too:
      // SQLite re-validates the whole row CHECK on any UPDATE.
      expect(() =>
        db.prepare(`UPDATE conversations SET visibility = 'public' WHERE id = 'c_dm_bare'`).run(),
      ).toThrow();
      expect(() =>
        db
          .prepare(`UPDATE conversations SET roster_policy = 'fixed' WHERE id = 'c_chan_public'`)
          .run(),
      ).toThrow();
      // …and the legal transition still works.
      expect(() =>
        db
          .prepare(`UPDATE conversations SET visibility = 'public' WHERE id = 'c_chan_bare'`)
          .run(),
      ).not.toThrow();
      expect(
        db
          .prepare<[], { kind: string }>(`SELECT kind FROM conversations WHERE id = 'c_chan_bare'`)
          .get()?.kind,
      ).toBe('channel');
    } finally {
      db.close();
    }
  });
});
