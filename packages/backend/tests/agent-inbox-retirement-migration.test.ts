// #task:2072 c4 — the v84/v85 pair that retires the `agent_inbox` placement.
//
// House style copied from conversation-kind-drop-migration.test.ts: a local
// `openDbThrough` + a single-version applier, so the suite proves the migration
// PAIR and not the boot path.
//
// The one deliberate deviation, and the reason it is spelled out here: the local
// runner in the neighbouring files opens with `foreign_keys = OFF` for the whole
// build. v84's correctness IS the cascade, so this file turns foreign keys back
// ON before applying it — with them off, v84 would silently leave orphans and
// every assertion below would still pass. Production takes this path for real:
// `openDatabase` sets `foreign_keys = ON` (db.ts:38) before `runMigrations`, and
// the runner only turns them off around `foreignKeyEscape` migrations
// (db.ts:223-231) — which is exactly why the row deletion may not live in v85.
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrations } from '@silverhand/shared/db/migrations';

const CONVERSATION_TRIGGERS_AFTER_V85 = [
  'conversations_create_direct_pair_runtime_slots',
  'conversations_placement_immutable',
  'trg_conversations_endpoint_tombstone_monotonic',
  'trg_conversations_endpoints_birth',
  'trg_conversations_endpoints_born_alive',
  'trg_conversations_endpoints_immutable',
] as const;

const CONVERSATION_INDEXES_AFTER_V85 = [
  'idx_conversations_archived_at',
  'idx_conversations_direct_pair_endpoint_b',
  'idx_conversations_direct_pair_endpoints',
  'idx_conversations_pair_key',
  'idx_conversations_status',
  'idx_conversations_title_key',
  'idx_conversations_workspace',
] as const;

/** Mirrors the production runner in db.ts, including the escape branch's
 *  closing `foreign_key_check`, so a rebuild that orphans a dependent row
 *  fails here for the same reason it would fail at boot. */
function applyVersion(db: Database.Database, version: number): void {
  const migration = migrations.find(candidate => candidate.version === version)!;
  const apply = () =>
    db.transaction(() => {
      migration.precondition?.(db as never);
      db.exec(migration.up);
      if (migration.foreignKeyEscape) {
        const violations = db.pragma('foreign_key_check') as unknown[];
        if (violations.length > 0) {
          throw new Error(
            `migration v${version}: foreign_key_check found ${violations.length} violations`,
          );
        }
      }
      db.prepare('INSERT INTO _migrations VALUES (?, ?, 0)')
        .run(migration.version, migration.name);
    })();
  if (migration.foreignKeyEscape) {
    db.pragma('foreign_keys = OFF');
    db.pragma('legacy_alter_table = ON');
    try {
      apply();
    } finally {
      db.pragma('legacy_alter_table = OFF');
      db.pragma('foreign_keys = ON');
    }
  } else {
    apply();
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
    applyVersion(db, migration.version);
  }
  return db;
}

/** An inbox conversation, a workspace channel, a direct pair, and every
 *  dependent row class the retirement has to answer for. */
function seedV83World(db: Database.Database): void {
  db.exec(`
    INSERT INTO users (id, name, display_name, created_at, updated_at)
    VALUES ('u-1', 'inbox-retire-one', 'One', 0, 0),
           ('u-2', 'inbox-retire-two', 'Two', 0, 0);

    INSERT INTO hosts (id, kind, name, created_at)
    VALUES ('host-1', 'local', 'host', 0);

    INSERT INTO agents
      (id, name, runtime, host_id, created_at, updated_at,
       created_by_user_id, session_scope)
    VALUES ('agent-1', 'inbox-retire-agent', 'claude', 'host-1', 0, 0,
            'u-1', 'conversation'),
           ('agent-2', 'inbox-retire-bystander', 'claude', 'host-1', 0, 0,
            'u-1', 'conversation');

    INSERT INTO workspaces
      (id, name, name_key, description, owner_agent_id,
       archived_at, created_at, updated_at)
    VALUES ('w-1', 'Regular', 'regular', NULL, NULL, NULL, 0, 0);

    -- The inbox row's runtime seat is minted by the v71-era birth trigger, not
    -- by this fixture: asserting the seat is gone after v84 therefore proves the
    -- cascade, not the fixture.
    INSERT INTO conversations
      (id, workspace_id, inbox_agent_id, placement_kind, roster_policy,
       endpoint_a_kind, endpoint_a_id, endpoint_b_kind, endpoint_b_id,
       title, title_key, status, visibility, created_at, updated_at)
    VALUES
      ('c-channel', 'w-1', NULL, 'workspace', 'open',
       NULL, NULL, NULL, NULL, 'Channel', 'channel', 'idle', 'public', 1, 11),
      ('c-inbox', NULL, 'agent-1', 'agent_inbox', 'fixed',
       NULL, NULL, NULL, NULL, 'Inbox', NULL, 'idle', 'private', 2, 12),
      ('c-pair', NULL, NULL, 'direct_pair', 'fixed',
       'agent', 'agent-1', 'human', 'u-1',
       'Pair', NULL, 'idle', 'private', 3, 13);

    INSERT INTO conversation_agents (conversation_id, agent_id, joined_at)
    VALUES ('c-channel', 'agent-1', 0);

    INSERT INTO messages
      (id, conversation_id, from_kind, from_agent_id, from_user_id,
       content, seq, created_at)
    VALUES ('m-inbox', 'c-inbox', 'system', NULL, NULL, 'wake', 1, 20),
           ('m-pair', 'c-pair', 'agent', 'agent-1', NULL, 'hi', 1, 21);

    -- Two notification shapes the migration must treat DIFFERENTLY:
    -- n-target navigates INTO the inbox (target dies with it), n-provenance
    -- merely remembers the inbox as where a mention came from.
    INSERT INTO notifications
      (id, kind, user_id, agent_id, workspace_id, conversation_id, message_id,
       source_workspace_id, source_conversation_id, source_message_id,
       payload, read_at, created_at)
    VALUES
      ('n-target', 'mention', 'u-1', NULL, NULL, 'c-inbox', 'm-inbox',
       NULL, NULL, NULL, NULL, NULL, 30),
      ('n-provenance', 'mention', 'u-1', NULL, NULL, 'c-pair', 'm-pair',
       NULL, 'c-inbox', 'm-inbox', NULL, NULL, 31);

    -- No FK by deliberate design (see the column comment in the DDL): this row
    -- documents the accepted cost, i.e. that history keeps a coordinate the
    -- cascade cannot follow.
    INSERT INTO agent_runtime_events
      (slot_id, agent_id, conversation_id, generation, event_kind,
       daemon_instance_id, observed_status, observed_pid, cli_session_id,
       occurred_at)
    VALUES (9999, 'agent-1', 'c-inbox', 0, 'generation_claimed',
            'daemon-1', 'idle', NULL, NULL, 40);
  `);
}

function columnNames(db: Database.Database, table: string): string[] {
  // `table_xinfo`, not `table_info`: the latter omits VIRTUAL generated columns,
  // so it cannot tell a surviving `pair_key` from a rebuild that dropped it.
  return (
    db.prepare(`PRAGMA table_xinfo('${table}')`).all() as Array<{ name: string }>
  ).map(row => row.name);
}

function objectNames(
  db: Database.Database,
  type: 'index' | 'trigger',
  table: string,
): string[] {
  return db.prepare(
    `SELECT name FROM sqlite_master
      WHERE type = ? AND tbl_name = ? AND sql IS NOT NULL
      ORDER BY name`,
  ).pluck().all(type, table) as string[];
}

describe('v84/v85 agent_inbox retirement', () => {
  it('deletes the inbox population through the designed cascades and leaves the other arms whole', () => {
    const db = openDbThrough(83);
    seedV83World(db);
    expect(db.prepare(
      `SELECT COUNT(*) FROM agent_runtime_slots WHERE conversation_id = 'c-inbox'`,
    ).pluck().get()).toBe(1);

    // The cascade IS the claim; see the file docblock.
    db.pragma('foreign_keys = ON');
    applyVersion(db, 84);

    expect(db.prepare('SELECT id FROM conversations ORDER BY id').pluck().all())
      .toEqual(['c-channel', 'c-pair']);
    expect(db.prepare('SELECT id FROM messages ORDER BY id').pluck().all())
      .toEqual(['m-pair']);
    expect(db.prepare(
      `SELECT COUNT(*) FROM agent_runtime_slots WHERE conversation_id = 'c-inbox'`,
    ).pluck().get()).toBe(0);
    // The direct_pair seat is the control: a cascade that over-reached would
    // have taken it too.
    expect(db.prepare(
      `SELECT COUNT(*) FROM agent_runtime_slots WHERE conversation_id = 'c-pair'`,
    ).pluck().get()).toBe(1);

    // Target vs provenance: a null TARGET kills the row, a null PROVENANCE
    // does not.
    expect(db.prepare('SELECT id FROM notifications ORDER BY id').pluck().all())
      .toEqual(['n-provenance']);
    expect(db.prepare(
      `SELECT conversation_id, message_id, source_conversation_id, source_message_id
         FROM notifications WHERE id = 'n-provenance'`,
    ).get()).toEqual({
      conversation_id: 'c-pair',
      message_id: 'm-pair',
      source_conversation_id: null,
      source_message_id: null,
    });

    // Append-only history is neither rewritten nor able to block the delete,
    // and its coordinate is now deliberately dangling.
    expect(db.prepare(
      `SELECT conversation_id FROM agent_runtime_events ORDER BY id`,
    ).pluck().all()).toEqual(['c-inbox']);

    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });

  it('retires the column, the alphabet member and the arc branch together', () => {
    const db = openDbThrough(83);
    seedV83World(db);
    db.pragma('foreign_keys = ON');
    applyVersion(db, 84);
    const surviving = db.prepare(
      `SELECT id, workspace_id, placement_kind, roster_policy,
              endpoint_a_kind, endpoint_a_id, endpoint_b_kind, endpoint_b_id,
              title, title_key, status, visibility, created_at, updated_at,
              pair_key
         FROM conversations ORDER BY id`,
    ).all();

    applyVersion(db, 85);

    expect(columnNames(db, 'conversations')).not.toContain('inbox_agent_id');
    // The rebuild must carry the rows AND the inline VIRTUAL generated column
    // that is the sole carrier of direct_pair uniqueness.
    expect(db.prepare(
      `SELECT id, workspace_id, placement_kind, roster_policy,
              endpoint_a_kind, endpoint_a_id, endpoint_b_kind, endpoint_b_id,
              title, title_key, status, visibility, created_at, updated_at,
              pair_key
         FROM conversations ORDER BY id`,
    ).all()).toEqual(surviving);
    expect(db.prepare(
      `SELECT pair_key FROM conversations WHERE id = 'c-pair'`,
    ).pluck().get()).not.toBeNull();

    // Names, not counts: an index or trigger that silently failed to come back
    // has to be nameable for this to fail (and the retired birth trigger has to
    // be nameably absent).
    expect(objectNames(db, 'index', 'conversations'))
      .toEqual([...CONVERSATION_INDEXES_AFTER_V85]);
    expect(objectNames(db, 'trigger', 'conversations'))
      .toEqual([...CONVERSATION_TRIGGERS_AFTER_V85]);
    // `test_seed_conversation_users` belongs to tests/utils/db.ts, not to the
    // production schema; a rebuild that "restored" it would be wrong.
    expect(objectNames(db, 'trigger', 'conversations'))
      .not.toContain('test_seed_conversation_users');

    const conversationsSql = db.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'conversations'`,
    ).pluck().get() as string;
    expect(conversationsSql).not.toContain('agent_inbox');
    expect(conversationsSql).not.toContain('inbox_agent_id');
    // The ELSE arm stays: it is what makes an unregistered placement fail loud
    // instead of skipping the arc check.
    expect(conversationsSql).toContain('ELSE 0');

    // The alphabet is now closed against the retired value, at the CHECK level.
    expect(() => db.prepare(
      `INSERT INTO conversations
        (id, workspace_id, placement_kind, roster_policy,
         endpoint_a_kind, endpoint_a_id, endpoint_b_kind, endpoint_b_id,
         title, title_key, status, visibility, created_at, updated_at)
       VALUES ('c-revenant', NULL, 'agent_inbox', 'fixed',
               NULL, NULL, NULL, NULL, 'Revenant', NULL, 'idle', 'private', 4, 14)`,
    ).run()).toThrow(/CHECK constraint failed/);

    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });

  it('keeps the cross-table participation trigger compiling and still fail closed', () => {
    // The regression this cell exists for: `agent_runtime_slots_participation_insert`
    // lives on ANOTHER table and still named `c.inbox_agent_id`. SQLite compiles
    // trigger bodies lazily, so a v85 that forgot to replace it would MIGRATE
    // GREEN and fail on the next runtime-slot insert with
    // `no such column: c.inbox_agent_id`. Nothing but an actual insert catches it.
    const db = openDbThrough(83);
    seedV83World(db);
    db.pragma('foreign_keys = ON');
    applyVersion(db, 84);
    applyVersion(db, 85);

    const participationSql = db.prepare(
      `SELECT sql FROM sqlite_master
        WHERE type = 'trigger' AND name = 'agent_runtime_slots_participation_insert'`,
    ).pluck().get() as string;
    expect(participationSql).not.toContain('inbox_agent_id');

    // Positive: the birth trigger's insert compiles and runs against the new
    // two-arm participation body.
    db.exec(`
      INSERT INTO conversations
        (id, workspace_id, placement_kind, roster_policy,
         endpoint_a_kind, endpoint_a_id, endpoint_b_kind, endpoint_b_id,
         title, title_key, status, visibility, created_at, updated_at)
      VALUES ('c-pair-2', NULL, 'direct_pair', 'fixed',
              'agent', 'agent-2', 'human', 'u-2',
              'Pair 2', NULL, 'idle', 'private', 5, 15);
    `);
    expect(db.prepare(
      `SELECT agent_id FROM agent_runtime_slots WHERE conversation_id = 'c-pair-2'`,
    ).pluck().all()).toEqual(['agent-2']);

    // Negative: a conversation-scoped non-participant is still refused — and by
    // the participation trigger, not by the scope-consistency one.
    expect(() => db.prepare(
      `INSERT INTO agent_runtime_slots
        (agent_id, conversation_id, generation, observed_status)
       VALUES ('agent-2', 'c-pair', 0, 'idle')`,
    ).run()).toThrow(/requires participation in its conversation/);

    db.close();
  });
});
