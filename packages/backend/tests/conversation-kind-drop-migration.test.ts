import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrations } from '@silverhand/shared/db/migrations';
import { WORKSPACE_CONVERSATION_REFS_FOR_AGENT_SQL } from '../src/repos/conversation-repo.js';

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

function applyV79(db: Database.Database): void {
  const migration = migrations.find(candidate => candidate.version === 79)!;
  db.transaction(() => {
    migration.precondition?.(db as never);
    db.exec(migration.up);
    db.prepare('INSERT INTO _migrations VALUES (?, ?, 0)')
      .run(migration.version, migration.name);
  })();
}

function schema(db: Database.Database): unknown[] {
  return db.prepare(
    `SELECT type, name, tbl_name, sql
       FROM sqlite_master
      WHERE sql IS NOT NULL
      ORDER BY type, name`,
  ).all();
}

function seedPrincipals(db: Database.Database): void {
  db.exec(`
    INSERT INTO users (id, name, display_name, created_at, updated_at)
    VALUES
      ('u-1', 'kind-drop-one', 'One', 0, 0),
      ('u-2', 'kind-drop-two', 'Two', 0, 0);
    INSERT INTO hosts (id, kind, name, created_at)
    VALUES ('host-1', 'local', 'host', 0);
    INSERT INTO agents
      (id, name, runtime, host_id, created_at, updated_at, created_by_user_id)
    VALUES ('agent-1', 'kind-drop-agent', 'claude', 'host-1', 0, 0, 'u-1');
    INSERT INTO workspaces
      (id, name, name_key, description, workspace_kind, owner_agent_id,
       archived_at, created_at, updated_at)
    VALUES
      ('w-regular', 'Regular', 'regular', NULL, 'regular', NULL, NULL, 0, 0),
      ('w-home', 'Home', NULL, NULL, 'agent_home', 'agent-1', NULL, 0, 0);
  `);
}

function seedConversationArms(db: Database.Database): void {
  db.exec(`
    INSERT INTO conversations
      (id, workspace_id, inbox_agent_id, placement_kind, roster_policy,
       endpoint_a_kind, endpoint_a_id, endpoint_b_kind, endpoint_b_id,
       title, title_key, status, visibility, created_at, updated_at)
    VALUES
      ('c-open', 'w-regular', NULL, 'workspace', 'open',
       NULL, NULL, NULL, NULL,
       'Open', 'open', 'idle', 'public', 1, 11),
      ('c-fixed', 'w-home', NULL, 'workspace', 'fixed',
       NULL, NULL, NULL, NULL,
       'Fixed', 'fixed', 'idle', 'private', 2, 12),
      ('c-inbox', NULL, 'agent-1', 'agent_inbox', 'fixed',
       NULL, NULL, NULL, NULL,
       'Inbox', NULL, 'idle', 'private', 3, 13),
      ('c-pair', NULL, NULL, 'direct_pair', 'fixed',
       'human', 'u-1', 'human', 'u-2',
       'Pair', NULL, 'idle', 'private', 4, 14);
  `);
}

function conversationRowsWithoutKind(db: Database.Database): unknown[] {
  // `kind` is VIRTUAL through v78. `table_info` omits virtual generated
  // columns, which would make the retirement assertion below pass before v79;
  // `table_xinfo` is the required complete schema inventory.
  const columns = (
    db.prepare(`PRAGMA table_xinfo('conversations')`).all() as Array<{ name: string }>
  )
    .map(row => row.name)
    .filter(name => name !== 'kind');
  return db.prepare(
    `SELECT ${columns.map(name => `"${name}"`).join(', ')}
       FROM conversations ORDER BY id`,
  ).all();
}

describe('v79 conversation kind retirement', () => {
  it('fails before any DDL/DML when legacy favorite keys would collapse', () => {
    const db = openDbThrough(78);
    db.exec(`
      INSERT INTO users (id, name, display_name, created_at, updated_at)
      VALUES ('u-1', 'kind-drop-one', 'One', 0, 0);
      INSERT INTO user_sort_entry
        (user_id, list_key, entity_id, rank, last_accessed_at, starred_at)
      VALUES
        ('u-1', 'favorites', 'channel:c-1', 1, NULL, NULL),
        ('u-1', 'favorites', 'dm_channel:c-1', 2, NULL, NULL),
        ('u-1', 'favorites', 'channel:c-2', 3, NULL, NULL),
        ('u-1', 'favorites', 'conversation:c-2', 4, NULL, NULL);
    `);
    const beforeSchema = schema(db);
    const beforeRows = db.prepare(
      `SELECT * FROM user_sort_entry ORDER BY user_id, list_key, entity_id`,
    ).all();

    let failure: Error | undefined;
    try {
      applyV79(db);
    } catch (error) {
      failure = error as Error;
    }
    expect(failure?.message).toMatch(/favorite keys would collapse.*2 collision/s);
    expect(failure?.message).toContain('u-1:conversation:c-1');
    // GROUP_CONCAT order is not a contract; assert each conflicting source key
    // independently so a planner change cannot turn this behavior proof red.
    expect(failure?.message).toContain('channel:c-1');
    expect(failure?.message).toContain('dm_channel:c-1');
    expect(schema(db)).toEqual(beforeSchema);
    expect(db.prepare(
      `SELECT * FROM user_sort_entry ORDER BY user_id, list_key, entity_id`,
    ).all()).toEqual(beforeRows);
    expect(db.prepare('SELECT 1 FROM _migrations WHERE version = 79').get()).toBeUndefined();
    db.close();
  });

  it('drops only the bridge, rewrites favorite ordering keys losslessly, and preserves every arm', () => {
    const db = openDbThrough(78);
    seedPrincipals(db);
    seedConversationArms(db);
    db.exec(`
      INSERT INTO user_sort_entry
        (user_id, list_key, entity_id, rank, last_accessed_at, starred_at)
      VALUES
        ('u-1', 'favorites', 'channel:c-open', 7, NULL, NULL),
        ('u-1', 'favorites', 'dm_channel:c-inbox', 3, NULL, NULL),
        ('u-1', 'favorites', 'workspace:orphan', 9, NULL, NULL),
        ('u-1', 'channels:w-regular', 'c-open', NULL, 111, 222);
      INSERT INTO user_list_sort_mode (user_id, list_key, scope, mode, updated_at)
      VALUES ('u-1', 'favorites', '', 'manual', 333);
    `);
    const beforeConversations = conversationRowsWithoutKind(db);
    const beforeHome = db.prepare(
      `SELECT * FROM user_sort_entry
        WHERE list_key LIKE 'channels:%'
        ORDER BY user_id, list_key, entity_id`,
    ).all();
    const beforeMode = db.prepare(
      `SELECT * FROM user_list_sort_mode WHERE list_key = 'favorites'`,
    ).all();
    const beforeFavoriteKeys = db.prepare(
      `SELECT user_id, entity_id FROM user_sort_entry
        WHERE list_key = 'favorites' ORDER BY user_id, entity_id`,
    ).all() as Array<{ user_id: string; entity_id: string }>;

    applyV79(db);

    // Keep using `table_xinfo`: unlike `table_info`, it would have exposed the
    // v78 VIRTUAL bridge and therefore distinguishes a real DROP from a no-op.
    expect(
      (db.prepare(`PRAGMA table_xinfo('conversations')`).all() as Array<{ name: string }>)
        .map(row => row.name),
    ).not.toContain('kind');
    expect(conversationRowsWithoutKind(db)).toEqual(beforeConversations);
    expect(db.prepare(
      `SELECT * FROM user_sort_entry
        WHERE list_key LIKE 'channels:%'
        ORDER BY user_id, list_key, entity_id`,
    ).all()).toEqual(beforeHome);
    expect(db.prepare(
      `SELECT * FROM user_list_sort_mode WHERE list_key = 'favorites'`,
    ).all()).toEqual(beforeMode);

    const afterFavorites = db.prepare(
      `SELECT user_id, entity_id, rank, last_accessed_at, starred_at
         FROM user_sort_entry
        WHERE list_key = 'favorites'
        ORDER BY user_id, entity_id`,
    ).all() as Array<{
      user_id: string;
      entity_id: string;
      rank: number | null;
      last_accessed_at: number | null;
      starred_at: number | null;
    }>;
    expect(afterFavorites).toEqual([
      {
        user_id: 'u-1', entity_id: 'conversation:c-inbox', rank: 3,
        last_accessed_at: null, starred_at: null,
      },
      {
        user_id: 'u-1', entity_id: 'conversation:c-open', rank: 7,
        last_accessed_at: null, starred_at: null,
      },
      {
        user_id: 'u-1', entity_id: 'workspace:orphan', rank: 9,
        last_accessed_at: null, starred_at: null,
      },
    ]);
    expect(afterFavorites).toHaveLength(beforeFavoriteKeys.length);
    expect(new Set(afterFavorites.map(row => `${row.user_id}\0${row.entity_id}`)).size)
      .toBe(beforeFavoriteKeys.length);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });

  it('rebuilds the workspace access path and keeps attention preferences fail closed', () => {
    const db = openDbThrough(78);
    seedPrincipals(db);
    seedConversationArms(db);
    applyV79(db);

    expect(db.prepare(
      `SELECT sql FROM sqlite_master
        WHERE type = 'index' AND name = 'idx_conversations_workspace'`,
    ).pluck().get()).toBe(
      'CREATE INDEX idx_conversations_workspace\n        ON conversations(workspace_id, updated_at DESC)',
    );
    const triggers = db.prepare(
      `SELECT name, sql FROM sqlite_master
        WHERE type = 'trigger' AND name LIKE 'channel_attention_prefs_channel_only_%'
        ORDER BY name`,
    ).all() as Array<{ name: string; sql: string }>;
    expect(triggers).toHaveLength(2);
    for (const trigger of triggers) {
      expect(trigger.sql).toContain('SELECT roster_policy FROM conversations');
      expect(trigger.sql).not.toMatch(/\bkind\b/);
    }

    const insertPref = db.prepare(
      `INSERT INTO channel_attention_preferences
        (user_id, conversation_id, mode, updated_at) VALUES ('u-1', ?, 'all', 0)`,
    );
    expect(() => insertPref.run('missing')).toThrow(/must reference a regular channel/);
    expect(() => insertPref.run('c-inbox')).toThrow(/must reference a regular channel/);
    expect(() => insertPref.run('c-open')).not.toThrow();
    expect(() => db.prepare(
      `UPDATE channel_attention_preferences SET conversation_id = 'c-inbox'
        WHERE user_id = 'u-1' AND conversation_id = 'c-open'`,
    ).run()).toThrow(/must reference a regular channel/);

    const insertConversation = db.prepare(
      `INSERT INTO conversations
        (id, workspace_id, inbox_agent_id, placement_kind, roster_policy,
         endpoint_a_kind, endpoint_a_id, endpoint_b_kind, endpoint_b_id,
         title, title_key, status, visibility, created_at, updated_at)
       VALUES (?, ?, NULL, 'workspace', 'open', NULL, NULL, NULL, NULL,
               ?, ?, 'idle', 'private', ?, ?)`,
    );
    const insertMembership = db.prepare(
      `INSERT INTO conversation_agents (conversation_id, agent_id, joined_at)
       VALUES (?, 'agent-1', 0)`,
    );
    for (let i = 0; i < 300; i += 1) {
      const workspaceId = `w-decoy-${i}`;
      db.prepare(
        `INSERT INTO workspaces
          (id, name, name_key, description, workspace_kind, owner_agent_id,
           archived_at, created_at, updated_at)
         VALUES (?, ?, ?, NULL, 'regular', NULL, NULL, 0, 0)`,
      ).run(workspaceId, `Decoy ${i}`, `decoy ${i}`);
      const conversationId = `c-decoy-${i}`;
      insertConversation.run(
        conversationId,
        workspaceId,
        `Decoy ${i}`,
        `decoy ${i}`,
        i,
        i,
      );
      insertMembership.run(conversationId);
    }
    insertMembership.run('c-open');
    db.exec('ANALYZE');
    const plan = db.prepare(
      `EXPLAIN QUERY PLAN ${WORKSPACE_CONVERSATION_REFS_FOR_AGENT_SQL}`,
    ).all('agent-1', 'w-regular') as Array<{ detail: string }>;
    expect(plan.map(row => row.detail).join('\n')).toContain(
      'idx_conversations_workspace (workspace_id=?)',
    );
    expect(plan.map(row => row.detail).join('\n')).not.toContain('USE TEMP B-TREE');
    db.close();
  });
});
