import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrations } from '@silverhand/shared/db/migrations';

// Migration v71 (agent_inbox_placement) falsifiers —
// agent-scoped-session-v1 §4.1 / §4.2 末 / §5 / §8 P0-b (#task:2014).
//
// v71 does three things, and each has its own way of failing silently:
//
//   (1) `conversations` rebuild — `workspace_id` becomes nullable,
//       `inbox_agent_id` appears, and v69's staging gate
//       `CHECK (placement_kind = 'workspace')` is replaced by the exhaustive
//       mutually exclusive arc. A rebuild loses constraints and indexes without
//       erroring, so every surviving index is asserted by its exact SQL and every
//       arc is probed from both sides (legal shape accepted, every illegal
//       combination refused). `direct_pair` must STILL be refused: its endpoint
//       columns do not exist until P3, and admitting the value without them would
//       be the same half-modelled lie v69's gate prevented.
//   (2) inbox backfill — one BRAND-NEW EMPTY inbox per row of `agents`, derived
//       from the aggregate that owns it and from nothing else. There is no title
//       heuristic, no `agent_home` derivation and no oldest-per-agent tie-break,
//       because the legacy `Mentions` DMs are NOT converted and NOT touched
//       (@Cindy 裁定 (b)): they hold messages, tasks and a human participant an
//       `agent_inbox` cannot represent. Both halves of that are falsifiable here
//       and both are gated. "Created" is asserted as a total function of `agents`
//       (every agent exactly one, nothing else) and as EMPTY — an inbox that
//       inherited a title, a seq, a message or a roster row would mean some
//       conversion crept back in. "Untouched" is asserted as a full-row
//       differential over EVERY pre-existing conversation, so the near-misses in
//       the fixture (a same-titled DM in a REGULAR workspace, an open-roster
//       channel called `Mentions`, a second `Mentions` row for one agent) are not
//       three hand-picked cases but the whole table.
//   (3) `messages.cc_source_message_id` + partial UNIQUE — the "exactly one copy
//       per (source message, inbox)" proof. Asserted as a real conflict, and as
//       NOT constraining ordinary messages (a NULL-heavy partial index that
//       accidentally covered every row would break every second plain message).
//
// The whole-schema fingerprint lives in the living golden of
// migration-baseline.test.ts; this file owns the behavioral half. All DBs are
// `:memory:` (shiki gate §6).

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
      // Same order as the production runner (`src/db.ts`): the `precondition`
      // hook runs inside the migration's own transaction, on the same
      // connection, BEFORE `up` — which is what lets v71 stage its
      // production-generated conversation ids in a TEMP table.
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

function applyV71(db: Database.Database): void {
  const v71 = migrations.find(m => m.version === 71);
  expect(v71).toBeDefined();
  expect(v71!.foreignKeyEscape).toBe(true);
  db.pragma('legacy_alter_table = ON');
  try {
    db.transaction(() => {
      // v71 stages one fresh conversation id per agent in a TEMP table here; the
      // backfill INSERT joins it. Skipping the hook is the same failure the
      // production runner would have — `no such table: temp.agent_inbox_backfill`.
      v71!.precondition!(db);
      db.exec(v71!.up);
      db.prepare(
        'INSERT INTO _migrations (version, name, applied_at) VALUES (71, ?, 0)',
      ).run(v71!.name);
    })();
  } finally {
    db.pragma('legacy_alter_table = OFF');
  }
  // The escape disables FK enforcement for the whole migration; the runner's
  // post-condition is that every surviving FK still validates.
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
}

type Row = Record<string, unknown>;

/**
 * A v69 fixture built to make a conversion visible if one happened. Three agents:
 * `a1` and `a2` own an `agent_home` holding a `Mentions`-titled DM (the shape the
 * retired backfill would have converted), `a1` additionally has a second
 * `Mentions` row and an open-roster channel of that title, and a regular
 * workspace holds a third same-titled DM. `a3` owns NO workspace and no
 * conversation at all — the case that proves the backfill reads `agents` rather
 * than any conversation carrier. `c_inbox_a1` carries messages and BOTH roster
 * rows, including a human's: converting it would have cut that human out of his
 * own conversation, which is why nothing is converted.
 */
function seedV69(db: Database.Database): void {
  db.exec(`
    INSERT INTO hosts (id, name, kind, created_at) VALUES ('h1', 'local', 'local', 1);
    INSERT INTO users (id, name, display_name, created_at, updated_at)
      VALUES ('u1', 'u1', 'U One', 1, 1);
    INSERT INTO agents
      (id, name, runtime, model, host_id, description, created_at, updated_at,
       display_name, reasoning_effort, fast_mode, created_by_user_id)
    VALUES
      ('a1', 'a1', 'claude', NULL, 'h1', NULL, 1, 1, 'A One', NULL, NULL, 'u1'),
      ('a2', 'a2', 'claude', NULL, 'h1', NULL, 250, 260, 'A Two', NULL, NULL, 'u1'),
      ('a3', 'a3', 'claude', NULL, 'h1', NULL, 777, 900, 'A Three', NULL, NULL, 'u1');
    INSERT INTO workspaces
      (id, name, description, workspace_kind, owner_agent_id,
       archived_at, pinned_at, created_at, updated_at, owner_user_id)
    VALUES
      ('wsah_a1', 'a1 home', NULL, 'agent_home', 'a1', NULL, NULL, 1, 1, 'u1'),
      ('wsah_a2', 'a2 home', NULL, 'agent_home', 'a2', NULL, NULL, 1, 1, 'u1'),
      ('ws_reg', 'regular', NULL, 'regular', NULL, NULL, NULL, 1, 1, 'u1');
  `);

  const insertConversation = db.prepare(
    `INSERT INTO conversations
       (id, workspace_id, placement_kind, roster_policy, title, status,
        spawned_by_agent_id, closed_at, close_summary, pinned_at,
        created_at, updated_at, archived_at, latest_message_seq, visibility)
     VALUES (@id, @workspace_id, 'workspace', @roster_policy, @title, 'idle',
             NULL, NULL, NULL, @pinned_at, @created_at, @created_at,
             NULL, @latest_message_seq, @visibility)`,
  );
  const rows = [
    // What the retired backfill would have claimed: a `Mentions` DM in an agent
    // home. It stays exactly what it is.
    {
      id: 'c_inbox_a1', workspace_id: 'wsah_a1', roster_policy: 'fixed',
      title: 'Mentions', created_at: 100, pinned_at: 101,
      latest_message_seq: 4, visibility: 'private',
    },
    {
      id: 'c_inbox_a2', workspace_id: 'wsah_a2', roster_policy: 'fixed',
      title: 'Mentions', created_at: 200, pinned_at: null,
      latest_message_seq: 0, visibility: 'private',
    },
    // A second one for the same agent — the shape a pre-UNIQUE race could have
    // produced. With nothing converted there is no tie to break: both survive as
    // ordinary workspace DMs and neither becomes the inbox.
    {
      id: 'c_inbox_a1_dup', workspace_id: 'wsah_a1', roster_policy: 'fixed',
      title: 'Mentions', created_at: 300, pinned_at: null,
      latest_message_seq: 1, visibility: 'private',
    },
    // Right title, wrong everything else — near-misses for any title heuristic.
    {
      id: 'c_reg_mentions', workspace_id: 'ws_reg', roster_policy: 'fixed',
      title: 'Mentions', created_at: 400, pinned_at: null,
      latest_message_seq: 0, visibility: 'private',
    },
    {
      id: 'c_open_mentions', workspace_id: 'wsah_a1', roster_policy: 'open',
      title: 'Mentions', created_at: 500, pinned_at: null,
      latest_message_seq: 0, visibility: 'private',
    },
    // An ordinary home DM and an ordinary channel, to prove nothing else moves.
    {
      id: 'c_home_dm', workspace_id: 'wsah_a1', roster_policy: 'fixed',
      title: 'dm-a1', created_at: 700, pinned_at: null,
      latest_message_seq: 9, visibility: 'private',
    },
    {
      id: 'c_public_chan', workspace_id: 'ws_reg', roster_policy: 'open',
      title: 'general', created_at: 800, pinned_at: null,
      latest_message_seq: 2, visibility: 'public',
    },
  ];
  for (const row of rows) insertConversation.run(row);

  // Children of the legacy `Mentions` row that must survive the rebuild's FK
  // escape — including the HUMAN roster row that makes converting it lossy.
  db.exec(`
    INSERT INTO messages (id, conversation_id, from_kind, from_user_id, content, seq, created_at)
      VALUES ('m_inbox_1', 'c_inbox_a1', 'system', NULL, 'mention copy', 1, 110),
             ('m_inbox_2', 'c_inbox_a1', 'agent', NULL, 'agent reply', 2, 120),
             ('m_dup_1', 'c_inbox_a1_dup', 'system', NULL, 'stray copy', 1, 310);
    INSERT INTO conversation_agents (conversation_id, agent_id, status, joined_at)
      VALUES ('c_inbox_a1', 'a1', 'idle', 111);
    INSERT INTO conversation_users (conversation_id, user_id, joined_at)
      VALUES ('c_inbox_a1', 'u1', 112);
  `);
}

function placementOf(db: Database.Database): Row[] {
  return db
    .prepare<[], Row>(
      `SELECT id, placement_kind, workspace_id, inbox_agent_id, kind
         FROM conversations ORDER BY id`,
    )
    .all();
}

function schemaSql(db: Database.Database, name: string): string {
  const row = db
    .prepare<[string], { sql: string }>(
      `SELECT sql FROM sqlite_master WHERE name = ?`,
    )
    .get(name);
  return (row?.sql ?? '').replace(/\s+/g, ' ').trim();
}

function inboxIds(db: Database.Database): string[] {
  return db
    .prepare<[], { id: string }>(
      `SELECT id FROM conversations WHERE placement_kind = 'agent_inbox' ORDER BY id`,
    )
    .all()
    .map(r => r.id);
}

/** The Conversation identity domain: 12 random bytes as 16 base64url chars. It is
 *  the grammar `#conv:<id>` accepts, so a placement that minted its own shape
 *  would produce rows nothing can reference. */
const CONVERSATION_ID_RE = /^[A-Za-z0-9_-]{16}$/;

/** The inbox id of one agent, looked up by the ownership column — which is how
 *  production finds it too (`requireAgentInbox`). Tests must not KNOW an inbox id:
 *  it is opaque, and the shape is asserted separately from the row's contents. */
function inboxIdFor(db: Database.Database, agentId: string): string {
  const row = db
    .prepare<[string], { id: string }>(
      `SELECT id FROM conversations
         WHERE placement_kind = 'agent_inbox' AND inbox_agent_id = ?`,
    )
    .get(agentId);
  expect(row).toBeDefined();
  return row!.id;
}

function countWhere(db: Database.Database, table: string, predicate: string): number {
  return db
    .prepare<[], { n: number }>(`SELECT count(*) AS n FROM ${table} WHERE ${predicate}`)
    .get()!.n;
}

/** Every column an `agent_inbox` row has, so "empty" can be asserted as a whole
 *  row rather than as a chosen subset. */
const INBOX_COLUMNS = [
  'id', 'workspace_id', 'inbox_agent_id', 'placement_kind', 'roster_policy', 'kind',
  'title', 'status', 'spawned_by_agent_id', 'closed_at', 'close_summary', 'pinned_at',
  'created_at', 'updated_at', 'archived_at', 'latest_message_seq', 'visibility',
].join(', ');

/** The same list minus `inbox_agent_id`, which does not exist before v71 — the
 *  differential below has to read the same columns on both sides of the rebuild.
 *  The new column's value on those rows is not skipped, it is pinned by
 *  `placementOf` above. */
const PRE_V71_COLUMNS = INBOX_COLUMNS.replace('inbox_agent_id, ', '');

describe('migration v71 agent inbox placement — backfill', () => {
  it('creates one brand-new inbox per agent and converts nothing', () => {
    const db = openDbThrough(69);
    try {
      seedV69(db);
      applyV71(db);

      // Resolved by OWNER, never by a guessable id: the ids below are opaque
      // conversation ids, so the row-by-row expectation states which agent each
      // placement belongs to and the shape claim is made separately, just under.
      const inboxA1 = inboxIdFor(db, 'a1');
      const inboxA2 = inboxIdFor(db, 'a2');
      const inboxA3 = inboxIdFor(db, 'a3');

      expect(placementOf(db)).toEqual(
        [
        // Every pre-existing row keeps its workspace placement — including all
        // four `Mentions`-titled ones. There is no predicate that could have
        // picked one of them, which is the point.
        {
          id: 'c_home_dm', placement_kind: 'workspace',
          workspace_id: 'wsah_a1', inbox_agent_id: null, kind: 'dm_channel',
        },
        {
          id: 'c_inbox_a1', placement_kind: 'workspace',
          workspace_id: 'wsah_a1', inbox_agent_id: null, kind: 'dm_channel',
        },
        {
          id: 'c_inbox_a1_dup', placement_kind: 'workspace',
          workspace_id: 'wsah_a1', inbox_agent_id: null, kind: 'dm_channel',
        },
        {
          id: 'c_inbox_a2', placement_kind: 'workspace',
          workspace_id: 'wsah_a2', inbox_agent_id: null, kind: 'dm_channel',
        },
        {
          id: 'c_open_mentions', placement_kind: 'workspace',
          workspace_id: 'wsah_a1', inbox_agent_id: null, kind: 'channel',
        },
        {
          id: 'c_public_chan', placement_kind: 'workspace',
          workspace_id: 'ws_reg', inbox_agent_id: null, kind: 'channel',
        },
        {
          id: 'c_reg_mentions', placement_kind: 'workspace',
          workspace_id: 'ws_reg', inbox_agent_id: null, kind: 'dm_channel',
        },
        // The new placements: one per agent, each with an ORDINARY conversation
        // id. `placementOf` orders by id, and these are random, so the expected
        // list is sorted the same way rather than assuming where they land.
        {
          id: inboxA1, placement_kind: 'agent_inbox',
          workspace_id: null, inbox_agent_id: 'a1', kind: 'dm_channel',
        },
        {
          id: inboxA2, placement_kind: 'agent_inbox',
          workspace_id: null, inbox_agent_id: 'a2', kind: 'dm_channel',
        },
        {
          id: inboxA3, placement_kind: 'agent_inbox',
          workspace_id: null, inbox_agent_id: 'a3', kind: 'dm_channel',
        },
        ].sort((left, right) => (left.id < right.id ? -1 : 1)),
      );

      // The id DOMAIN, asserted separately because the expectation above uses the
      // observed values: an inbox id is a conversation id and nothing else — 16
      // base64url chars, unique, and NOT derived from the owner. A derived shape
      // (`inbox-<agentId>`) would parse as no `#conv:` reference and would leak
      // the owner into an opaque identifier, and one-per-agent is already carried
      // by `idx_conversations_inbox_agent` rather than by the id.
      for (const [agentId, inboxId] of [
        ['a1', inboxA1],
        ['a2', inboxA2],
        ['a3', inboxA3],
      ] as const) {
        expect(inboxId).toMatch(CONVERSATION_ID_RE);
        expect(inboxId).not.toBe(`inbox-${agentId}`);
      }
      expect(new Set([inboxA1, inboxA2, inboxA3]).size).toBe(3);
    } finally {
      db.close();
    }
  });

  it('carries every pre-existing conversation across the rebuild column for column', () => {
    const db = openDbThrough(69);
    try {
      seedV69(db);
      const before = db
        .prepare<[], Row>(`SELECT ${PRE_V71_COLUMNS} FROM conversations ORDER BY id`)
        .all();
      applyV71(db);
      const after = db
        .prepare<[], Row>(
          `SELECT ${PRE_V71_COLUMNS} FROM conversations
             WHERE placement_kind = 'workspace' ORDER BY id`,
        )
        .all();

      // The full-table differential, not a chosen subset of columns and not a
      // chosen subset of rows: a conversion of ANY row would either change a
      // column here or drop the row out of the `workspace` projection.
      expect(after).toEqual(before);
      // Guards the fixture itself: an empty table would satisfy the equality.
      expect(before).toHaveLength(7);
    } finally {
      db.close();
    }
  });

  it('derives the inbox from the agent aggregate: total, empty and rosterless', () => {
    const db = openDbThrough(69);
    try {
      seedV69(db);
      applyV71(db);

      // A total function of `agents`, asserted in both directions — no agent
      // without an inbox, no inbox without an agent.
      expect(
        db
          .prepare<[], Row>(
            `SELECT a.id FROM agents a
               LEFT JOIN conversations c ON c.inbox_agent_id = a.id
              WHERE c.id IS NULL`,
          )
          .all(),
      ).toEqual([]);
      expect(
        db
          .prepare<[], Row>(
            `SELECT c.id FROM conversations c
               LEFT JOIN agents a ON a.id = c.inbox_agent_id
              WHERE c.placement_kind = 'agent_inbox' AND a.id IS NULL`,
          )
          .all(),
      ).toEqual([]);

      // `a3` owns no workspace and no conversation at all, so its inbox can only
      // have come from the agent row — and every column of it is stated, because
      // "empty" is the whole claim: a title, a `pinned_at` or a non-zero seq
      // inherited from somewhere would mean a conversion crept back in. Both
      // timestamps are the agent's `created_at` (777), NOT its `updated_at`
      // (900): the inbox has existed for as long as the agent has, and a
      // truthful old `updated_at` keeps it at the bottom of the list on upgrade
      // day instead of jumping every roster to the top.
      const inboxA3 = inboxIdFor(db, 'a3');
      expect(
        db
          .prepare<[string], Row>(
            `SELECT ${INBOX_COLUMNS} FROM conversations WHERE id = ?`,
          )
          .get(inboxA3),
      ).toEqual({
        id: inboxA3,
        workspace_id: null,
        inbox_agent_id: 'a3',
        placement_kind: 'agent_inbox',
        roster_policy: 'fixed',
        kind: 'dm_channel',
        title: 'Inbox',
        status: 'idle',
        spawned_by_agent_id: null,
        closed_at: null,
        close_summary: null,
        pinned_at: null,
        created_at: 777,
        updated_at: 777,
        archived_at: null,
        latest_message_seq: 0,
        visibility: 'private',
      });

      // No content and NO ROSTER ROW: on this arc the participant IS
      // `inbox_agent_id` (§4.2 表), so a projected `conversation_agents` row
      // would be a second authority for the same fact.
      const childCount = (table: string): number =>
        db
          .prepare<[], { n: number }>(
            `SELECT count(*) AS n FROM ${table}
              WHERE conversation_id IN (
                SELECT id FROM conversations WHERE placement_kind = 'agent_inbox'
              )`,
          )
          .get()!.n;
      expect(childCount('messages')).toBe(0);
      expect(childCount('conversation_agents')).toBe(0);
      expect(childCount('conversation_users')).toBe(0);
    } finally {
      db.close();
    }
  });

  it('keeps the legacy `Mentions` row’s messages and both roster rows', () => {
    const db = openDbThrough(69);
    try {
      seedV69(db);
      applyV71(db);

      // The rebuild runs with FK enforcement off, so children are exactly what a
      // botched `DROP TABLE conversations` would take with it. The human roster
      // row is the load-bearing one: it is the participant a conversion to an
      // `agent_inbox` would have deleted, and it is still here.
      expect(
        db
          .prepare<[], { n: number }>(
            `SELECT count(*) AS n FROM messages WHERE conversation_id = 'c_inbox_a1'`,
          )
          .get()!.n,
      ).toBe(2);
      expect(
        db
          .prepare<[], { n: number }>(
            `SELECT count(*) AS n FROM conversation_agents WHERE conversation_id = 'c_inbox_a1'`,
          )
          .get()!.n,
      ).toBe(1);
      expect(
        db
          .prepare<[], { n: number }>(
            `SELECT count(*) AS n FROM conversation_users WHERE conversation_id = 'c_inbox_a1'`,
          )
          .get()!.n,
      ).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe('migration v71 agent inbox placement — schema', () => {
  it('keeps all three pre-existing conversation indexes and adds the inbox UNIQUE', () => {
    const db = openDbThrough(69);
    try {
      const before = [
        'idx_conversations_workspace',
        'idx_conversations_status',
        'idx_conversations_archived_at',
      ].map(name => schemaSql(db, name));
      expect(before.every(sql => sql.length > 0)).toBe(true);

      seedV69(db);
      applyV71(db);

      // Byte-identical, not merely present: a rebuild that recreates an index
      // with a different column order or a dropped WHERE clause is a silent
      // plan regression.
      expect(
        [
          'idx_conversations_workspace',
          'idx_conversations_status',
          'idx_conversations_archived_at',
        ].map(name => schemaSql(db, name)),
      ).toEqual(before);
      expect(schemaSql(db, 'idx_conversations_inbox_agent')).toBe(
        'CREATE UNIQUE INDEX idx_conversations_inbox_agent '
        + "ON conversations(inbox_agent_id) WHERE placement_kind = 'agent_inbox'",
      );
    } finally {
      db.close();
    }
  });

  it('still hides the generated `kind` column and still refuses writes to it', () => {
    const db = openDbThrough(69);
    try {
      seedV69(db);
      applyV71(db);

      const visible = db
        .prepare<[], { name: string }>('PRAGMA table_info(conversations)')
        .all()
        .map(c => c.name);
      expect(visible).not.toContain('kind');
      expect(visible).toContain('inbox_agent_id');
      expect(
        db
          .prepare<[], { name: string; hidden: number }>('PRAGMA table_xinfo(conversations)')
          .all()
          .find(c => c.name === 'kind'),
      ).toMatchObject({ hidden: 2 });

      expect(() =>
        db.prepare(`UPDATE conversations SET kind = 'channel' WHERE id = 'c_home_dm'`),
      ).toThrow(/generated column/i);
    } finally {
      db.close();
    }
  });

  it('makes `workspace_id` nullable only for a non-workspace placement', () => {
    const db = openDbThrough(69);
    try {
      seedV69(db);
      applyV71(db);

      // A workspace placement still requires its workspace…
      expect(() =>
        db
          .prepare(
            `INSERT INTO conversations
               (id, workspace_id, inbox_agent_id, placement_kind, roster_policy,
                title, status, created_at, updated_at)
             VALUES ('bad', NULL, NULL, 'workspace', 'open', 'x', 'idle', 1, 1)`,
          )
          .run(),
      ).toThrow(/CHECK constraint failed/);
      // …and must not also claim an inbox owner.
      expect(() =>
        db
          .prepare(
            `INSERT INTO conversations
               (id, workspace_id, inbox_agent_id, placement_kind, roster_policy,
                title, status, created_at, updated_at)
             VALUES ('bad', 'ws_reg', 'a1', 'workspace', 'open', 'x', 'idle', 1, 1)`,
          )
          .run(),
      ).toThrow(/CHECK constraint failed/);
    } finally {
      db.close();
    }
  });

  it('enforces the agent_inbox arc from every side', () => {
    const db = openDbThrough(69);
    try {
      seedV69(db);
      applyV71(db);
      // Two agents created AFTER the backfill, so they have no inbox yet: every
      // fixture agent does, and reusing one would make these probes hit the
      // partial UNIQUE instead of the CHECK they are aimed at.
      db.exec(`
        INSERT INTO agents
          (id, name, runtime, model, host_id, description, created_at, updated_at,
           display_name, reasoning_effort, fast_mode, created_by_user_id)
        VALUES ('a4', 'a4', 'claude', NULL, 'h1', NULL, 1, 1, 'A Four', NULL, NULL, 'u1'),
               ('a5', 'a5', 'claude', NULL, 'h1', NULL, 1, 1, 'A Five', NULL, NULL, 'u1');
      `);

      const insert = (values: string) =>
        db
          .prepare(
            `INSERT INTO conversations
               (id, workspace_id, inbox_agent_id, placement_kind, roster_policy,
                title, status, created_at, updated_at)
             VALUES ${values}`,
          )
          .run();

      // Legal: owner set, no workspace, fixed roster.
      expect(() =>
        insert(`('ok', NULL, 'a4', 'agent_inbox', 'fixed', 'Inbox', 'idle', 1, 1)`),
      ).not.toThrow();
      // A second inbox for the same agent is now unrepresentable (partial UNIQUE).
      expect(() =>
        insert(`('ok2', NULL, 'a4', 'agent_inbox', 'fixed', 'Inbox', 'idle', 1, 1)`),
      ).toThrow(/UNIQUE constraint failed/);
      // Missing owner.
      expect(() =>
        insert(`('bad', NULL, NULL, 'agent_inbox', 'fixed', 'x', 'idle', 1, 1)`),
      ).toThrow(/CHECK constraint failed/);
      // Owner AND workspace — the arcs are mutually exclusive.
      expect(() =>
        insert(`('bad', 'ws_reg', 'a5', 'agent_inbox', 'fixed', 'x', 'idle', 1, 1)`),
      ).toThrow(/CHECK constraint failed/);
      // An inbox can never have an open roster (and therefore never be public).
      expect(() =>
        insert(`('bad', NULL, 'a5', 'agent_inbox', 'open', 'x', 'idle', 1, 1)`),
      ).toThrow(/CHECK constraint failed/);
      // `direct_pair` stays fail-closed until P3 brings its endpoint columns.
      expect(() =>
        insert(`('bad', NULL, NULL, 'direct_pair', 'fixed', 'x', 'idle', 1, 1)`),
      ).toThrow(/CHECK constraint failed/);
      expect(() =>
        insert(`('bad', 'ws_reg', NULL, 'direct_pair', 'fixed', 'x', 'idle', 1, 1)`),
      ).toThrow(/CHECK constraint failed/);
    } finally {
      db.close();
    }
  });

  it('cascades an inbox away with its owner instead of blocking the delete', () => {
    const db = openDbThrough(69);
    try {
      seedV69(db);
      applyV71(db);
      db.pragma('foreign_keys = ON');
      const inboxA1 = inboxIdFor(db, 'a1');
      const inboxA2 = inboxIdFor(db, 'a2');
      // Content in the inbox, so the cascade has to reach past the conversation
      // row itself.
      db.prepare(
        `INSERT INTO messages (id, conversation_id, from_kind, content, seq, created_at)
         VALUES ('m_new_inbox', ?, 'system', 'copy', 1, 1)`,
      ).run(inboxA1);

      // `a3` is the clean probe for the NEW edge: it owns no workspace, so the
      // only path from the agent to its inbox is `inbox_agent_id`.
      expect(() => db.prepare(`DELETE FROM agents WHERE id = 'a3'`).run()).not.toThrow();
      expect(inboxIds(db).sort()).toEqual([inboxA1, inboxA2].sort());

      // `a1` is the loaded one: it also owns an `agent_home` (whose own cascade
      // takes the legacy `Mentions` DM) and a `conversation_agents` row — the
      // shape that used to make a projected membership row abort the delete.
      expect(() => db.prepare(`DELETE FROM agents WHERE id = 'a1'`).run()).not.toThrow();
      expect(inboxIds(db)).toEqual([inboxA2]);
      expect(
        db
          .prepare<[string], { n: number }>(
            `SELECT count(*) AS n FROM messages WHERE conversation_id = ?`,
          )
          .get(inboxA1)!.n,
      ).toBe(0);
      // The legacy row went with the home workspace, by the pre-existing chain.
      expect(countWhere(db, 'conversations', `id = 'c_inbox_a1'`)).toBe(0);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      // `a2` is untouched — the cascade is per owner, not per table.
      expect(countWhere(db, 'conversations', `id = 'c_inbox_a2'`)).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe('migration v71 agent inbox placement — CC dedupe column', () => {
  it('dedupes one copy per (source message, inbox) without constraining ordinary messages', () => {
    const db = openDbThrough(69);
    try {
      seedV69(db);
      applyV71(db);

      const inboxA1 = inboxIdFor(db, 'a1');
      const inboxA2 = inboxIdFor(db, 'a2');
      const insert = db.prepare(
        `INSERT INTO messages
           (id, conversation_id, from_kind, content, seq, created_at, cc_source_message_id)
         VALUES (?, ?, 'system', 'copy', ?, 1, ?)`,
      );
      insert.run('cc1', inboxA1, 1, 'src_msg');
      // Same source, same inbox → refused.
      expect(() => insert.run('cc2', inboxA1, 2, 'src_msg')).toThrow(
        /UNIQUE constraint failed/,
      );
      // Same source, DIFFERENT inbox → allowed: two recipients of one mention.
      expect(() => insert.run('cc3', inboxA2, 1, 'src_msg')).not.toThrow();
      // Ordinary messages are all NULL here and must not collide with each other.
      expect(() => {
        insert.run('p1', 'c_home_dm', 20, null);
        insert.run('p2', 'c_home_dm', 21, null);
      }).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('leaves an already-received copy in place when the source conversation is deleted', () => {
    const db = openDbThrough(69);
    try {
      seedV69(db);
      applyV71(db);
      db.pragma('foreign_keys = ON');

      db.prepare(
        `INSERT INTO messages
           (id, conversation_id, from_kind, content, seq, created_at, cc_source_message_id)
         VALUES ('cc1', ?, 'system', 'copy', 1, 1, 'm_src')`,
      ).run(inboxIdFor(db, 'a1'));
      db.prepare(
        `INSERT INTO messages (id, conversation_id, from_kind, content, seq, created_at)
         VALUES ('m_src', 'c_public_chan', 'user', 'the mention', 1, 1)`,
      ).run();

      // Deleting the SOURCE conversation (and with it the source message) must
      // not reach into someone else's inbox: `cc_source_message_id` is a
      // historical coordinate, deliberately without a foreign key.
      db.prepare(`DELETE FROM conversations WHERE id = 'c_public_chan'`).run();
      expect(
        db
          .prepare<[], { n: number }>(`SELECT count(*) AS n FROM messages WHERE id = 'cc1'`)
          .get()!.n,
      ).toBe(1);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      db.close();
    }
  });
});
