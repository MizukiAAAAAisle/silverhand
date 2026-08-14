import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrations } from '@silverhand/shared/db/migrations';

// Migration v73 (direct_pair_endpoint_identity) falsifiers —
// agent-scoped-session-v1 §4.2 / §8 P0-e (#task:2017).
//
// The DirectPair placement gains its two ENDPOINTS, and the model rests on one
// property: a DM survives the deletion of the principal on the other side. That
// makes an endpoint a HISTORICAL COORDINATE rather than a foreign key, and it is
// the reason every guard below has to be a database guard:
//
//   (1) BORN VALID. Dropping the FK removes the only structural birth check, so
//       a trigger performs it — and more precisely than an FK could, since which
//       table an id must exist in depends on the sibling `_kind`. The two halves
//       (the `IN ('human','agent')` domain CHECK and the existence trigger) are
//       shown to be INDEPENDENT: each is dropped and the other still refuses
//       what it owns. Without that, "a bad kind is rejected" would be evidence
//       about whichever guard happens to run first.
//   (2) IMMUTABLE. Existence is derived by LOOKUP, and that derivation is only
//       sound while a coordinate cannot be rewritten: a mutable endpoint would
//       make "the lookup misses" mean "wrong id" as easily as "deleted". So
//       every coordinate UPDATE is executed as direct SQL, and a no-op UPDATE
//       that re-writes the same values is shown to still pass (the guard is
//       null-safe `IS`, not a change-detector on NULLs).
//   (3) The TOMBSTONE IS NOT LOAD-BEARING, and is monotonic. It records only
//       WHEN a principal disappeared: born-alive is refused, unstamping and
//       re-stamping are refused, and — the falsifier that matters — with the
//       stamping trigger DROPPED the delete still succeeds and still leaves a
//       row whose endpoint resolves to gone by lookup alone. (The ACL half of
//       that claim, "the survivor is still read-only", lives in
//       direct-pair-endpoint-acl.test.ts, where the predicate exists.)
//   (4) The STAMP IS WRITTEN BY THE DELETE ITSELF, on both principal tables,
//       per side and per kind, and the conversation plus its history survive it.
//       The claim that this covers FK cascades too is an ENGINE claim, so it is
//       probed as one (`agents` / `users` have only RESTRICT parents today, so
//       no cascade currently reaches them — the coverage is about future paths).
//   (5) The REBUILD lost nothing: a full-row differential over every
//       pre-existing conversation, byte-identical index SQL, the generated
//       `kind` column still hidden and still unwritable, and the children the
//       FK escape leaves unprotected (messages, roster rows, name allocations)
//       still there.
//
// The whole-schema fingerprint lives in migration-baseline.test.ts's living
// golden; this file owns the behavioral half. All DBs are `:memory:`.

/** Apply every migration up to and including `maxVersion`, through the same
 *  escape semantics the production runner uses. */
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
      m.precondition?.(db);
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

function applyV73(db: Database.Database): void {
  const v73 = migrations.find(m => m.version === 73);
  expect(v73).toBeDefined();
  // A rebuild migration: the escape is what stops `DROP TABLE conversations`
  // from cascading the children away, so it is part of the contract under test.
  expect(v73!.foreignKeyEscape).toBe(true);
  expect(v73!.precondition).toBeUndefined();
  db.pragma('legacy_alter_table = ON');
  try {
    db.transaction(() => {
      db.exec(v73!.up);
      db.prepare(
        'INSERT INTO _migrations (version, name, applied_at) VALUES (73, ?, 0)',
      ).run(v73!.name);
    })();
  } finally {
    db.pragma('legacy_alter_table = OFF');
  }
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
}

type Row = Record<string, unknown>;

/**
 * A v72 fixture holding one row of every placement that exists BELOW v73, each
 * with the children the rebuild's FK escape leaves unprotected: a public channel
 * with messages and both kinds of roster row, an agent-home DM, and an
 * `agent_inbox` (whose columns v71's backfill and the production aggregate
 * factory write, since a fixture seeded after v71 has no agent for that
 * migration to have found). Both principal kinds exist twice over, because every
 * endpoint probe below needs a live id of each kind AND a live id of the OTHER
 * kind to point the wrong `_kind` at.
 *
 * `conversation_agents` is seeded as PURE MEMBERSHIP: v70 moved the runtime
 * columns out to `agent_runtime_slots`, and each roster row below therefore also
 * mints a slot through that migration's trigger — which is what the rebuild's
 * `foreign_key_check` has to stay empty across.
 */
function seedV72(db: Database.Database): void {
  db.exec(`
    INSERT INTO hosts (id, name, kind, created_at) VALUES ('h1', 'local', 'local', 1);
    INSERT INTO users (id, name, display_name, created_at, updated_at)
      VALUES ('u1', 'u1', 'U One', 1, 1),
             ('u2', 'u2', 'U Two', 1, 1);
    INSERT INTO agents
      (id, name, runtime, model, host_id, description, created_at, updated_at,
       display_name, reasoning_effort, fast_mode, created_by_user_id)
    VALUES
      ('a1', 'a1', 'claude', NULL, 'h1', NULL, 1, 1, 'A One', NULL, NULL, 'u1'),
      ('a2', 'a2', 'claude', NULL, 'h1', NULL, 1, 1, 'A Two', NULL, NULL, 'u1');
    INSERT INTO workspaces
      (id, name, description, workspace_kind, owner_agent_id,
       archived_at, pinned_at, created_at, updated_at, owner_user_id)
    VALUES
      ('wsah_a1', 'a1 home', NULL, 'agent_home', 'a1', NULL, NULL, 1, 1, 'u1'),
      ('ws_reg', 'regular', NULL, 'regular', NULL, NULL, NULL, 1, 1, 'u1');

    INSERT INTO conversations
      (id, workspace_id, inbox_agent_id, placement_kind, roster_policy, title,
       status, spawned_by_agent_id, closed_at, close_summary, pinned_at,
       created_at, updated_at, archived_at, latest_message_seq, visibility)
    VALUES
      ('c_chan', 'ws_reg', NULL, 'workspace', 'open', 'general',
       'idle', NULL, NULL, NULL, 11, 100, 110, NULL, 2, 'public'),
      ('c_dm', 'wsah_a1', NULL, 'workspace', 'fixed', 'a1',
       'idle', NULL, NULL, NULL, NULL, 200, 210, NULL, 1, 'private'),
      ('c_inbox_a1', NULL, 'a1', 'agent_inbox', 'fixed', 'Inbox',
       'idle', NULL, NULL, NULL, NULL, 300, 300, NULL, 0, 'private');

    INSERT INTO messages (id, conversation_id, from_kind, from_user_id, content, seq, created_at)
      VALUES ('m_chan_1', 'c_chan', 'user', 'u1', 'hello', 1, 120),
             ('m_chan_2', 'c_chan', 'agent', NULL, 'hi', 2, 121),
             ('m_dm_1', 'c_dm', 'agent', NULL, 'note', 1, 220);
    INSERT INTO conversation_agents (conversation_id, agent_id, joined_at)
      VALUES ('c_chan', 'a1', 122), ('c_dm', 'a1', 221);
    INSERT INTO conversation_users (conversation_id, user_id, joined_at)
      VALUES ('c_chan', 'u1', 123);
    INSERT INTO conversation_names
      (workspace_id, name, conversation_id, assigned_at, retired_at)
      VALUES ('ws_reg', 'general', 'c_chan', 100, NULL),
             ('wsah_a1', 'a1', 'c_dm', 200, NULL);
  `);
}

/** Every column `conversations` has BELOW v73 — the differential has to read the
 *  same list on both sides of the rebuild, and reading all of them is the point:
 *  a rebuild that dropped a default or reordered a projection shows up here. */
const PRE_V73_COLUMNS = [
  'id', 'workspace_id', 'inbox_agent_id', 'placement_kind', 'roster_policy', 'kind',
  'title', 'status', 'spawned_by_agent_id', 'closed_at', 'close_summary', 'pinned_at',
  'created_at', 'updated_at', 'archived_at', 'latest_message_seq', 'visibility',
].join(', ');

const CONVERSATION_INDEXES = [
  'idx_conversations_workspace',
  'idx_conversations_status',
  'idx_conversations_archived_at',
  'idx_conversations_inbox_agent',
];

function schemaSql(db: Database.Database, name: string): string {
  const row = db
    .prepare<[string], { sql: string }>(
      `SELECT sql FROM sqlite_master WHERE name = ?`,
    )
    .get(name);
  return (row?.sql ?? '').replace(/\s+/g, ' ').trim();
}

/** The one parameterized INSERT every endpoint probe below goes through: the
 *  values are what differ, never the statement, so a probe cannot accidentally
 *  test a different column list than the legal case does. */
const INSERT_CONVERSATION = `
  INSERT INTO conversations
    (id, workspace_id, inbox_agent_id,
     endpoint_a_kind, endpoint_a_id, endpoint_b_kind, endpoint_b_id,
     endpoint_a_deleted_at, endpoint_b_deleted_at,
     placement_kind, roster_policy, title, status, created_at, updated_at)
  VALUES
    (@id, @workspace_id, @inbox_agent_id,
     @endpoint_a_kind, @endpoint_a_id, @endpoint_b_kind, @endpoint_b_id,
     @endpoint_a_deleted_at, @endpoint_b_deleted_at,
     @placement_kind, @roster_policy, 'DM', 'idle', 1, 1)`;

interface PairOverrides {
  id?: string;
  workspace_id?: string | null;
  inbox_agent_id?: string | null;
  endpoint_a_kind?: string | null;
  endpoint_a_id?: string | null;
  endpoint_b_kind?: string | null;
  endpoint_b_id?: string | null;
  endpoint_a_deleted_at?: number | null;
  endpoint_b_deleted_at?: number | null;
  placement_kind?: string;
  roster_policy?: string;
}

/** The LEGAL `direct_pair` row, in canonical order (`agent` sorts before
 *  `human`), with one named deviation per probe. The human side is `u2`
 *  deliberately: `u1` authored a message and created both agents, so RESTRICT
 *  edges make it undeletable — and the delete is what half of this file probes. */
function pair(overrides: PairOverrides = {}): Required<PairOverrides> {
  return {
    id: 'dp',
    workspace_id: null,
    inbox_agent_id: null,
    endpoint_a_kind: 'agent',
    endpoint_a_id: 'a1',
    endpoint_b_kind: 'human',
    endpoint_b_id: 'u2',
    endpoint_a_deleted_at: null,
    endpoint_b_deleted_at: null,
    placement_kind: 'direct_pair',
    roster_policy: 'fixed',
    ...overrides,
  };
}

/** A v73 database with the fixture and ONE legal DM (`dp`: agent `a1` ↔ human
 *  `u2`) plus a second one between two agents (`dp2`: `a1` ↔ `a2`), so every
 *  per-side / per-kind claim has a row that must NOT be touched. */
function openV73(): Database.Database {
  const db = openDbThrough(72);
  seedV72(db);
  applyV73(db);
  const insert = db.prepare(INSERT_CONVERSATION);
  insert.run(pair());
  insert.run(
    pair({
      id: 'dp2',
      endpoint_a_kind: 'agent',
      endpoint_a_id: 'a1',
      endpoint_b_kind: 'agent',
      endpoint_b_id: 'a2',
    }),
  );
  return db;
}

function endpointsOf(db: Database.Database, id: string): Row {
  return db
    .prepare<[string], Row>(
      `SELECT endpoint_a_kind, endpoint_a_id, endpoint_b_kind, endpoint_b_id,
              endpoint_a_deleted_at, endpoint_b_deleted_at
         FROM conversations WHERE id = ?`,
    )
    .get(id)!;
}

function countWhere(db: Database.Database, table: string, predicate: string): number {
  return db
    .prepare<[], { n: number }>(`SELECT count(*) AS n FROM ${table} WHERE ${predicate}`)
    .get()!.n;
}

describe('migration v73 direct_pair endpoints — rebuild', () => {
  it('carries every pre-existing conversation across column for column', () => {
    const db = openDbThrough(72);
    try {
      seedV72(db);
      const before = db
        .prepare<[], Row>(`SELECT ${PRE_V73_COLUMNS} FROM conversations ORDER BY id`)
        .all();
      applyV73(db);
      const after = db
        .prepare<[], Row>(`SELECT ${PRE_V73_COLUMNS} FROM conversations ORDER BY id`)
        .all();

      // No data migration exists BECAUSE no `direct_pair` row can exist below
      // v73 — so the rebuild's whole obligation is to change nothing.
      expect(after).toEqual(before);
      expect(before).toHaveLength(3);
      // The six new columns are NULL on every one of them, which is also what
      // the placement arc demands of the two non-`direct_pair` arms.
      expect(
        countWhere(
          db,
          'conversations',
          `endpoint_a_kind IS NULL AND endpoint_a_id IS NULL
           AND endpoint_b_kind IS NULL AND endpoint_b_id IS NULL
           AND endpoint_a_deleted_at IS NULL AND endpoint_b_deleted_at IS NULL`,
        ),
      ).toBe(3);
    } finally {
      db.close();
    }
  });

  it('keeps all four indexes byte-identical and the generated `kind` hidden', () => {
    const db = openDbThrough(72);
    try {
      seedV72(db);
      const before = CONVERSATION_INDEXES.map(name => schemaSql(db, name));
      expect(before.every(sql => sql.length > 0)).toBe(true);
      applyV73(db);

      // Byte-identical, not merely present: an index recreated with a different
      // column order or a dropped WHERE clause is a silent plan regression, and
      // the partial UNIQUE is additionally the one-inbox-per-agent invariant.
      expect(CONVERSATION_INDEXES.map(name => schemaSql(db, name))).toEqual(before);

      const visible = db
        .prepare<[], { name: string }>('PRAGMA table_info(conversations)')
        .all()
        .map(c => c.name);
      expect(visible).not.toContain('kind');
      expect(visible).toEqual(
        expect.arrayContaining([
          'endpoint_a_kind', 'endpoint_a_id', 'endpoint_b_kind', 'endpoint_b_id',
          'endpoint_a_deleted_at', 'endpoint_b_deleted_at',
        ]),
      );
      expect(
        db
          .prepare<[], { name: string; hidden: number }>('PRAGMA table_xinfo(conversations)')
          .all()
          .find(c => c.name === 'kind'),
      ).toMatchObject({ hidden: 2 });
      expect(() =>
        db.prepare(`UPDATE conversations SET kind = 'channel' WHERE id = 'c_dm'`),
      ).toThrow(/generated column/i);
    } finally {
      db.close();
    }
  });

  it('leaves the children the FK escape unprotects exactly where they were', () => {
    const db = openDbThrough(72);
    try {
      seedV72(db);
      applyV73(db);
      // `DROP TABLE conversations` with enforcement ON would have taken all of
      // these; name allocations are here too because v72 deliberately dropped
      // that FK, so nothing but the escape protects them either.
      expect(countWhere(db, 'messages', `1 = 1`)).toBe(3);
      expect(countWhere(db, 'conversation_agents', `1 = 1`)).toBe(2);
      expect(countWhere(db, 'conversation_users', `1 = 1`)).toBe(1);
      expect(countWhere(db, 'conversation_names', `retired_at IS NULL`)).toBe(2);
    } finally {
      db.close();
    }
  });
});

describe('migration v73 direct_pair endpoints — born valid', () => {
  it('accepts the canonical pair for both kind combinations', () => {
    const db = openV73();
    try {
      expect(endpointsOf(db, 'dp')).toEqual({
        endpoint_a_kind: 'agent',
        endpoint_a_id: 'a1',
        endpoint_b_kind: 'human',
        endpoint_b_id: 'u2',
        endpoint_a_deleted_at: null,
        endpoint_b_deleted_at: null,
      });
      // A `direct_pair` is a `dm_channel` by roster policy, and it belongs to no
      // workspace — the two facts every read surface has to route on.
      expect(
        db
          .prepare<[], Row>(
            `SELECT kind, workspace_id, inbox_agent_id FROM conversations WHERE id = 'dp'`,
          )
          .get(),
      ).toEqual({ kind: 'dm_channel', workspace_id: null, inbox_agent_id: null });
    } finally {
      db.close();
    }
  });

  it('refuses every ill-formed pair as direct SQL', () => {
    const db = openV73();
    try {
      const insert = db.prepare(INSERT_CONVERSATION);
      const refuse = (overrides: PairOverrides, matcher: RegExp) =>
        expect(() => insert.run(pair({ id: 'bad', ...overrides }))).toThrow(matcher);

      // A kind outside the domain. The domain CHECK and the existence trigger
      // both cover it; which one speaks is pinned by the independence test
      // below, not asserted here.
      refuse({ endpoint_a_kind: 'bot', endpoint_a_id: 'a1' }, /CHECK constraint failed|must name an existing principal/);
      // An id that names nobody.
      refuse({ endpoint_a_id: 'ghost' }, /must name an existing principal/);
      refuse({ endpoint_b_id: 'ghost' }, /must name an existing principal/);
      // The id exists — in the OTHER table. This is the case no foreign key can
      // express, since the table to check depends on the sibling `_kind`.
      refuse({ endpoint_a_kind: 'agent', endpoint_a_id: 'u1' }, /must name an existing principal/);
      refuse({ endpoint_b_kind: 'human', endpoint_b_id: 'a2' }, /must name an existing principal/);
      // Reversed order and a self-pair: both are the SAME conversation as one
      // already-legal row, which is why the canonical order is a constraint and
      // not a convention P3 could normalize later.
      refuse(
        {
          endpoint_a_kind: 'human', endpoint_a_id: 'u1',
          endpoint_b_kind: 'agent', endpoint_b_id: 'a1',
        },
        /CHECK constraint failed/,
      );
      refuse(
        {
          endpoint_a_kind: 'agent', endpoint_a_id: 'a1',
          endpoint_b_kind: 'agent', endpoint_b_id: 'a1',
        },
        /CHECK constraint failed/,
      );
      // Half a pair. The BIRTH TRIGGER speaks first here (a NULL kind selects
      // its `ELSE 0` arm, a NULL id resolves no principal), so this is asserted
      // through the message it does produce; that the arc CHECK refuses the same
      // shape on its own is shown by the independence test below. Between them,
      // `directPairEndpointsOf`'s "impossible half pair" throw is unreachable
      // rather than merely unlikely.
      refuse({ endpoint_b_kind: null, endpoint_b_id: null }, /must name an existing principal/);
      refuse({ endpoint_a_id: null }, /must name an existing principal/);
      // A `direct_pair` is placed on neither of the other two coordinates, and
      // its roster is never open (so it can never be public).
      refuse({ workspace_id: 'ws_reg' }, /CHECK constraint failed/);
      refuse({ inbox_agent_id: 'a1' }, /CHECK constraint failed/);
      refuse({ roster_policy: 'open' }, /CHECK constraint failed/);
      // Born tombstoned — invisible to the monotonicity trigger (UPDATE only),
      // so a row could otherwise start life as a DM nobody may post to.
      refuse({ endpoint_a_deleted_at: 1 }, /born alive/);
      refuse({ endpoint_b_deleted_at: 1 }, /born alive/);
      // The other two arms carry no endpoint columns at all: a workspace channel
      // with an endpoint would be a second, contradictory participant rule.
      refuse(
        { placement_kind: 'workspace', workspace_id: 'ws_reg', roster_policy: 'open' },
        /CHECK constraint failed/,
      );
      refuse(
        { placement_kind: 'agent_inbox', inbox_agent_id: 'a2' },
        /CHECK constraint failed/,
      );
      // …and neither may be born stamped either, which is the arc CHECK's job
      // rather than the born-alive trigger's (the trigger fires first, so this
      // shape is asserted through the message it does produce).
      refuse(
        {
          placement_kind: 'agent_inbox', inbox_agent_id: 'a2',
          endpoint_a_kind: null, endpoint_a_id: null,
          endpoint_b_kind: null, endpoint_b_id: null,
          endpoint_a_deleted_at: 1,
        },
        /born alive/,
      );

      // Nothing above landed.
      expect(countWhere(db, 'conversations', `id = 'bad'`)).toBe(0);
    } finally {
      db.close();
    }
  });

  it('the domain CHECK and the existence trigger are independent guards', () => {
    const db = openV73();
    try {
      const insert = db.prepare(INSERT_CONVERSATION);
      // BEFORE INSERT triggers run before CHECKs, so with both guards installed
      // an inadmissible kind reports the TRIGGER's message. Each is therefore
      // shown alone: drop the trigger and the CHECK still refuses the kind…
      db.exec(`DROP TRIGGER trg_conversations_endpoints_birth`);
      expect(() =>
        insert.run(pair({ id: 'bad', endpoint_a_kind: 'bot', endpoint_a_id: 'a1' })),
      ).toThrow(/CHECK constraint failed/);
      // …and the same for a half pair, which the trigger also happened to catch:
      // the STRUCTURE of a `direct_pair` row is the arc CHECK's own claim.
      expect(() =>
        insert.run(pair({ id: 'bad', endpoint_b_kind: null, endpoint_b_id: null })),
      ).toThrow(/CHECK constraint failed/);
      // …and with the trigger gone, an id that names nobody now LANDS — which is
      // exactly what the trigger, and only the trigger, was preventing.
      expect(() => insert.run(pair({ id: 'orphan', endpoint_a_id: 'ghost' }))).not.toThrow();
      expect(countWhere(db, 'conversations', `id = 'orphan'`)).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe('migration v73 direct_pair endpoints — immutable coordinates', () => {
  it('refuses every coordinate rewrite and allows a no-op write of the same values', () => {
    const db = openV73();
    try {
      // One statement per column, because `UPDATE OF` fires per named column: a
      // guard that listed only three of the four would be invisible otherwise.
      for (const sql of [
        `UPDATE conversations SET endpoint_a_kind = 'human' WHERE id = 'dp'`,
        `UPDATE conversations SET endpoint_a_id = 'a2' WHERE id = 'dp'`,
        `UPDATE conversations SET endpoint_b_kind = 'agent' WHERE id = 'dp'`,
        `UPDATE conversations SET endpoint_b_id = 'u1' WHERE id = 'dp'`,
      ]) {
        expect(() => db.prepare(sql).run()).toThrow(/endpoint coordinates are immutable/);
      }
      // Setting a coordinate to NULL is the same rewrite, and the one that would
      // turn a DM into an unrepresentable half pair.
      expect(() =>
        db.prepare(`UPDATE conversations SET endpoint_b_id = NULL WHERE id = 'dp'`).run(),
      ).toThrow(/endpoint coordinates are immutable/);

      // A write of the SAME values passes: the guard compares with null-safe
      // `IS`, so an UPDATE that touches the row for other reasons is not
      // collateral damage.
      expect(() =>
        db
          .prepare(
            `UPDATE conversations
                SET endpoint_a_kind = endpoint_a_kind, endpoint_b_id = endpoint_b_id,
                    title = 'renamed'
              WHERE id = 'dp'`,
          )
          .run(),
      ).not.toThrow();
      // And an ordinary column UPDATE on a `direct_pair` row is untouched by
      // either guard — the placement is not read-only, only its identity is.
      expect(() =>
        db.prepare(`UPDATE conversations SET updated_at = 999 WHERE id = 'dp'`).run(),
      ).not.toThrow();

      expect(endpointsOf(db, 'dp')).toMatchObject({
        endpoint_a_kind: 'agent',
        endpoint_a_id: 'a1',
        endpoint_b_kind: 'human',
        endpoint_b_id: 'u2',
      });
    } finally {
      db.close();
    }
  });
});

describe('migration v73 direct_pair endpoints — tombstone', () => {
  it('is stamped once, never unstamped and never re-stamped', () => {
    const db = openV73();
    try {
      // NULL → value is the only legal transition, and it is the one the
      // stamping triggers perform.
      expect(() =>
        db
          .prepare(`UPDATE conversations SET endpoint_a_deleted_at = 500 WHERE id = 'dp'`)
          .run(),
      ).not.toThrow();
      for (const sql of [
        `UPDATE conversations SET endpoint_a_deleted_at = NULL WHERE id = 'dp'`,
        `UPDATE conversations SET endpoint_a_deleted_at = 600 WHERE id = 'dp'`,
      ]) {
        expect(() => db.prepare(sql).run()).toThrow(/stamped once and never unstamped/);
      }
      // Re-writing the same instant is a no-op, not a re-stamp.
      expect(() =>
        db
          .prepare(`UPDATE conversations SET endpoint_a_deleted_at = 500 WHERE id = 'dp'`)
          .run(),
      ).not.toThrow();
      // The two sides are independent: b is still alive on the same row.
      expect(endpointsOf(db, 'dp')).toMatchObject({
        endpoint_a_deleted_at: 500,
        endpoint_b_deleted_at: null,
      });
    } finally {
      db.close();
    }
  });

  it('is written by the delete itself, per side and per kind, and the DM survives', () => {
    const db = openV73();
    try {
      db.pragma('foreign_keys = ON');
      db.prepare(
        `INSERT INTO messages (id, conversation_id, from_kind, content, seq, created_at)
         VALUES ('m_dp_1', 'dp', 'agent', 'said something', 1, 400)`,
      ).run();

      // Deleting the HUMAN stamps the `human` side of `dp` and nothing on
      // `dp2` (whose endpoints are both agents), which is what makes the
      // per-kind predicate in the trigger load-bearing rather than decorative.
      const before = Date.now();
      db.prepare(`DELETE FROM users WHERE id = 'u2'`).run();
      const dp = endpointsOf(db, 'dp');
      expect(dp).toMatchObject({ endpoint_a_deleted_at: null });
      expect(dp.endpoint_b_deleted_at).toBeGreaterThanOrEqual(before);
      expect(endpointsOf(db, 'dp2')).toMatchObject({
        endpoint_a_deleted_at: null,
        endpoint_b_deleted_at: null,
      });

      // Deleting an AGENT stamps the `agent` side — on BOTH conversations it is
      // an endpoint of, and on the correct side of each.
      db.prepare(`DELETE FROM agents WHERE id = 'a1'`).run();
      expect(endpointsOf(db, 'dp').endpoint_a_deleted_at).toBeGreaterThanOrEqual(before);
      expect(endpointsOf(db, 'dp2').endpoint_a_deleted_at).toBeGreaterThanOrEqual(before);
      expect(endpointsOf(db, 'dp2').endpoint_b_deleted_at).toBeNull();

      // THE property the whole placement exists for: the DM and its history are
      // still here after both of its principals are gone, and the schema is
      // still consistent (no FK ever pointed at an endpoint).
      expect(countWhere(db, 'conversations', `id = 'dp'`)).toBe(1);
      expect(countWhere(db, 'messages', `conversation_id = 'dp'`)).toBe(1);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      // The agent's own cascade still took its inbox, which is the placement
      // whose participant IS a foreign key. Endpoint identity did not weaken it.
      expect(countWhere(db, 'conversations', `id = 'c_inbox_a1'`)).toBe(0);
    } finally {
      db.close();
    }
  });

  it('falsifier: with the stamping trigger dropped the delete still succeeds and the endpoint is still gone by lookup', () => {
    const db = openV73();
    try {
      db.pragma('foreign_keys = ON');
      db.exec(`DROP TRIGGER trg_agents_stamp_endpoint_deleted`);
      db.prepare(`DELETE FROM agents WHERE id = 'a2'`).run();

      // The stamp is a denormalized timestamp: missing it costs the WHEN, not
      // the WHETHER. `dp2`'s b endpoint is unstamped and yet unresolvable —
      // which is why the ACL ORs a failed lookup in rather than trusting the
      // column (the read-only half of this claim is in the ACL suite).
      expect(endpointsOf(db, 'dp2')).toMatchObject({ endpoint_b_deleted_at: null });
      expect(countWhere(db, 'agents', `id = 'a2'`)).toBe(0);
      expect(countWhere(db, 'conversations', `id = 'dp2'`)).toBe(1);
    } finally {
      db.close();
    }
  });

  it('engine claim: a BEFORE DELETE trigger fires for rows removed by ON DELETE CASCADE', () => {
    const db = openV73();
    try {
      db.pragma('foreign_keys = ON');
      // `agents` and `users` have only RESTRICT parents today, so no cascade
      // currently reaches either — the reason the stamp lives in a trigger is
      // that a FUTURE cascade path would silently bypass an app-side write. That
      // makes this an ENGINE claim, and it is probed as one: an own BEFORE
      // DELETE trigger on the CHILD table must fire when the row goes away
      // because its parent did, not only for a direct DELETE.
      db.exec(`
        CREATE TABLE probe_parent (id TEXT PRIMARY KEY);
        CREATE TABLE probe_child (
          id TEXT PRIMARY KEY,
          parent_id TEXT REFERENCES probe_parent(id) ON DELETE CASCADE
        );
        CREATE TABLE probe_log (child_id TEXT);
        CREATE TRIGGER probe_child_before_delete BEFORE DELETE ON probe_child
        BEGIN
          INSERT INTO probe_log (child_id) VALUES (OLD.id);
        END;
        INSERT INTO probe_parent (id) VALUES ('p1');
        INSERT INTO probe_child (id, parent_id) VALUES ('c1', 'p1');
        DELETE FROM probe_parent WHERE id = 'p1';
      `);
      expect(
        db.prepare<[], { child_id: string }>(`SELECT child_id FROM probe_log`).all(),
      ).toEqual([{ child_id: 'c1' }]);
      expect(countWhere(db, 'probe_child', `id = 'c1'`)).toBe(0);
    } finally {
      db.close();
    }
  });
});
