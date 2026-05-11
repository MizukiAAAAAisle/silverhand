import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrations } from '@silverhand/shared';
import { runMigrations } from '../src/db.js';

function openDbAt(version: number): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      name    TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);
  const insertMigration = db.prepare(
    'INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)',
  );
  for (const migration of migrations) {
    if (migration.version > version) break;
    db.transaction(() => {
      db.exec(migration.up);
      insertMigration.run(migration.version, migration.name, Date.now());
    })();
  }
  return db;
}

function pragmaNumber(db: Database.Database, name: string): number {
  const row = db.pragma(name) as Array<Record<string, number>>;
  return Object.values(row[0] ?? {})[0] ?? 0;
}

function seedV15SystemDmFixture(db: Database.Database): void {
  const now = 1_700_000_000_000;
  db.exec(`
    INSERT INTO hosts (id, name, kind, created_at)
    VALUES ('host_local', 'local', 'local', ${now});

    INSERT INTO agents
      (id, name, runtime, model, host_id, description, created_at, updated_at,
       display_name, reasoning_effort, fast_mode)
    VALUES
      ('agent_alice', 'alice', 'claude', NULL, 'host_local', NULL, ${now}, ${now},
       'alice', NULL, NULL);

    INSERT INTO workspaces
      (id, name, description, workspace_kind, workspace_path, workspace_host_id,
       archived_at, created_at, updated_at)
    VALUES
      ('__system_dm_workspace__', 'Direct Messages', NULL, 'system_dm',
       '/tmp/silverhand/agents/agent_alice', 'host_local', NULL, ${now}, ${now});

    INSERT INTO conversations
      (id, workspace_id, workspace_path, kind, parent_conversation_id, title,
       status, spawned_by_agent_id, closed_at, close_summary, pinned_at,
       created_at, updated_at)
    VALUES
      ('dm_alice', '__system_dm_workspace__', '/tmp/silverhand/agents/agent_alice',
       'dm_channel', NULL, 'dm-alice', 'idle', NULL, NULL, NULL, NULL, ${now}, ${now}),
      ('dm_mentions', '__system_dm_workspace__', '/tmp/silverhand/agents/agent_alice',
       'dm_channel', NULL, 'Mentions', 'idle', NULL, NULL, NULL, NULL, ${now + 1}, ${now + 1}),
      ('thread_dm', '__system_dm_workspace__', '/tmp/silverhand/agents/agent_alice',
       'thread', 'dm_alice', 'Thread', 'idle', NULL, NULL, NULL, NULL, ${now + 2}, ${now + 2});

    INSERT INTO conversation_agents
      (conversation_id, agent_id, cli_session_id, pid, status, joined_at)
    VALUES
      ('dm_alice', 'agent_alice', NULL, NULL, 'idle', ${now}),
      ('dm_mentions', 'agent_alice', NULL, NULL, 'idle', ${now + 1}),
      ('thread_dm', 'agent_alice', NULL, NULL, 'idle', ${now + 2});

    INSERT INTO messages
      (id, conversation_id, from_kind, from_agent_id, from_user_id, content,
       metadata, seq, created_at, task_number, task_status,
       task_assignee_agent_id, task_assignee_user_id, task_title,
       task_workspace_id)
    VALUES
      ('msg_task', 'dm_alice', 'user', NULL, 'local', 'todo', NULL, 1, ${now},
       1, 'todo', NULL, NULL, 'todo', '__system_dm_workspace__');

    INSERT INTO saved_messages
      (id, message_id, conversation_id, workspace_id, saved_at)
    VALUES
      ('saved_task', 'msg_task', 'dm_alice', '__system_dm_workspace__', ${now});

    INSERT INTO notifications
      (id, kind, user_id, agent_id, workspace_id, conversation_id, message_id,
       source_workspace_id, source_conversation_id, source_message_id,
       payload, read_at, created_at)
    VALUES
      ('notif_task', 'mention_external', NULL, 'agent_alice',
       '__system_dm_workspace__', 'dm_alice', 'msg_task',
       '__system_dm_workspace__', 'dm_mentions', NULL, '{}', NULL, ${now});
  `);
}

describe('database migrations', () => {
  it('v16 splits the legacy system DM workspace into one multi-channel agent_home', () => {
    const db = openDbAt(15);
    try {
      seedV15SystemDmFixture(db);

      runMigrations(db);

      expect(pragmaNumber(db, 'foreign_keys')).toBe(1);
      expect(pragmaNumber(db, 'legacy_alter_table')).toBe(0);
      expect(
        db.prepare(`SELECT version FROM _migrations WHERE version = 16`).get(),
      ).toBeDefined();
      expect(db.pragma('foreign_key_check')).toEqual([]);

      expect(
        db
          .prepare(
            `SELECT workspace_kind, owner_agent_id
               FROM workspaces
              WHERE id = 'wsah_agent_alice'`,
          )
          .get(),
      ).toEqual({ workspace_kind: 'agent_home', owner_agent_id: 'agent_alice' });
      expect(
        db
          .prepare(`SELECT id FROM workspaces WHERE id = '__system_dm_workspace__'`)
          .get(),
      ).toBeUndefined();
      expect(
        db
          .prepare(
            `SELECT id, workspace_id
               FROM conversations
              WHERE id IN ('dm_alice', 'dm_mentions', 'thread_dm')
              ORDER BY id`,
          )
          .all(),
      ).toEqual([
        { id: 'dm_alice', workspace_id: 'wsah_agent_alice' },
        { id: 'dm_mentions', workspace_id: 'wsah_agent_alice' },
        { id: 'thread_dm', workspace_id: 'wsah_agent_alice' },
      ]);
      expect(
        db.prepare(`SELECT task_workspace_id FROM messages WHERE id = 'msg_task'`).get(),
      ).toEqual({ task_workspace_id: 'wsah_agent_alice' });
      expect(
        db.prepare(`SELECT workspace_id FROM saved_messages WHERE id = 'saved_task'`).get(),
      ).toEqual({ workspace_id: 'wsah_agent_alice' });
      expect(
        db
          .prepare(
            `SELECT workspace_id, source_workspace_id
               FROM notifications
              WHERE id = 'notif_task'`,
          )
          .get(),
      ).toEqual({
        workspace_id: 'wsah_agent_alice',
        source_workspace_id: 'wsah_agent_alice',
      });
    } finally {
      db.close();
    }
  });

  it('foreignKeyEscape rolls back v16 and restores pragmas on foreign_key_check failure', () => {
    const db = openDbAt(15);
    try {
      seedV15SystemDmFixture(db);
      db.pragma('foreign_keys = OFF');
      db.exec(`
        INSERT INTO conversations
          (id, workspace_id, workspace_path, kind, parent_conversation_id, title,
           status, spawned_by_agent_id, closed_at, close_summary, pinned_at,
           created_at, updated_at)
        VALUES
          ('dm_broken', '__system_dm_workspace__', '/tmp/silverhand/agents/missing',
           'dm_channel', NULL, 'dm-missing', 'idle', NULL, NULL, NULL, NULL, 1, 1);

        INSERT INTO conversation_agents
          (conversation_id, agent_id, cli_session_id, pid, status, joined_at)
        VALUES
          ('dm_broken', 'missing_agent', NULL, NULL, 'idle', 1);
      `);
      db.pragma('foreign_keys = ON');

      expect(() => runMigrations(db)).toThrow(/foreign_key_check/);

      expect(pragmaNumber(db, 'foreign_keys')).toBe(1);
      expect(pragmaNumber(db, 'legacy_alter_table')).toBe(0);
      expect(
        db.prepare(`SELECT version FROM _migrations WHERE version = 16`).get(),
      ).toBeUndefined();
      expect(
        db.prepare(`SELECT id FROM workspaces WHERE id = '__system_dm_workspace__'`).get(),
      ).toBeDefined();
    } finally {
      db.close();
    }
  });

  it('v18 creates the schedules table with the agent-owned shape', () => {
    const db = openDbAt(17);
    try {
      runMigrations(db);
      // Migration registered.
      expect(
        db.prepare(`SELECT version FROM _migrations WHERE version = 18`).get(),
      ).toBeDefined();

      // Schema columns: every field the design locked, in the right
      // shape. Names matter — repos query by exact column.
      const cols = (db.pragma('table_info(schedules)') as Array<{
        name: string;
        notnull: number;
      }>).reduce<Record<string, { notnull: number }>>((acc, c) => {
        acc[c.name] = { notnull: c.notnull };
        return acc;
      }, {});
      const expectedNotNull = [
        'id',
        'owner_agent_id',
        'message',
        'spec_json',
        'next_fire_at',
        'status',
        'fired_count',
        'created_at',
        'updated_at',
      ];
      for (const col of expectedNotNull) {
        expect(cols[col]?.notnull, `${col} should be NOT NULL`).toBe(1);
      }
      const expectedNullable = [
        'last_fired_at',
        'max_occurrences',
        'until_at',
        'failure_reason',
        'cancelled_at',
      ];
      for (const col of expectedNullable) {
        expect(cols[col]?.notnull, `${col} should be nullable`).toBe(0);
      }
      // Importantly NOT present (the design forbids any conversation /
      // message / task linkage).
      expect(cols['conversation_id']).toBeUndefined();
      expect(cols['source_conversation_id']).toBeUndefined();
      expect(cols['source_message_id']).toBeUndefined();
      expect(cols['source_task_message_id']).toBeUndefined();

      // Indexes the scheduler depends on.
      const indexes = (db.pragma('index_list(schedules)') as Array<{
        name: string;
      }>).map(r => r.name);
      expect(indexes).toContain('idx_schedules_due');
      expect(indexes).toContain('idx_schedules_owner');

      // CASCADE on owner_agent_id: agent delete must remove schedules.
      const fks = (db.pragma('foreign_key_list(schedules)') as Array<{
        table: string;
        from: string;
        on_delete: string;
      }>);
      const ownerFk = fks.find(fk => fk.from === 'owner_agent_id');
      expect(ownerFk?.table).toBe('agents');
      expect(ownerFk?.on_delete).toBe('CASCADE');

      // Status CHECK enforces the locked enum.
      db.exec(`
        INSERT INTO hosts (id, name, kind, created_at)
          VALUES ('h', 'local', 'local', 1);
        INSERT INTO agents
          (id, name, runtime, model, host_id, description,
           created_at, updated_at, display_name, reasoning_effort, fast_mode)
          VALUES ('ag', 'a', 'claude', NULL, 'h', NULL, 1, 1, 'A', NULL, NULL);
      `);
      expect(() =>
        db
          .prepare(
            `INSERT INTO schedules
               (id, owner_agent_id, message, spec_json, next_fire_at, status,
                fired_count, created_at, updated_at)
             VALUES ('s1','ag','hi','{}',1,'bogus',0,1,1)`,
          )
          .run(),
      ).toThrow(/CHECK/);
    } finally {
      db.close();
    }
  });

  it('v19 adds nullable workspace pin timestamps', () => {
    const db = openDbAt(18);
    try {
      runMigrations(db);
      expect(
        db.prepare(`SELECT version FROM _migrations WHERE version = 19`).get(),
      ).toBeDefined();

      const cols = (db.pragma('table_info(workspaces)') as Array<{
        name: string;
        notnull: number;
      }>).reduce<Record<string, { notnull: number }>>((acc, c) => {
        acc[c.name] = { notnull: c.notnull };
        return acc;
      }, {});
      expect(cols.pinned_at?.notnull).toBe(0);

      const indexes = (db.pragma('index_list(workspaces)') as Array<{
        name: string;
      }>).map(r => r.name);
      expect(indexes).toContain('idx_workspaces_pinned_at');
    } finally {
      db.close();
    }
  });
});
