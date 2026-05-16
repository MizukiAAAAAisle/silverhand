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
    const apply = () => {
      db.exec(migration.up);
      insertMigration.run(migration.version, migration.name, Date.now());
    };
    if (migration.foreignKeyEscape) {
      db.pragma('foreign_keys = OFF');
      db.pragma('legacy_alter_table = ON');
      try {
        db.transaction(apply)();
      } finally {
        db.pragma('legacy_alter_table = OFF');
        db.pragma('foreign_keys = ON');
      }
    } else {
      db.transaction(apply)();
    }
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

  it('v20 makes conversation inbox delivery rows unique', () => {
    const db = openDbAt(19);
    try {
      db.exec(`
        INSERT INTO hosts (id, name, kind, created_at)
        VALUES ('host_local', 'local', 'local', 1);

        INSERT INTO agents
          (id, name, runtime, model, host_id, description, created_at, updated_at,
           display_name, reasoning_effort, fast_mode)
        VALUES
          ('agent_a', 'alice', 'claude', NULL, 'host_local', NULL, 1, 1,
           'alice', NULL, NULL);

        INSERT INTO workspaces
          (id, name, description, workspace_kind, workspace_path, workspace_host_id,
           owner_agent_id, archived_at, pinned_at, created_at, updated_at)
        VALUES
          ('ws', 'Workspace', NULL, 'regular', '/tmp/ws', 'host_local',
           NULL, NULL, NULL, 1, 1);

        INSERT INTO conversations
          (id, workspace_id, workspace_path, kind, parent_conversation_id, title,
           status, spawned_by_agent_id, closed_at, close_summary, pinned_at,
           archived_at, created_at, updated_at)
        VALUES
          ('conv', 'ws', '/tmp/ws', 'channel', NULL, 'Channel',
           'idle', NULL, NULL, NULL, NULL, NULL, 1, 1);

        INSERT INTO messages
          (id, conversation_id, from_kind, from_agent_id, from_user_id, content,
           metadata, seq, created_at)
        VALUES
          ('msg', 'conv', 'user', NULL, 'local', 'hello', NULL, 1, 1);

        INSERT INTO conversation_inboxes
          (id, conversation_id, agent_id, message_id, delivered_at, created_at)
        VALUES
          (1, 'conv', 'agent_a', 'msg', 10, 1),
          (2, 'conv', 'agent_a', 'msg', NULL, 2),
          (3, 'conv', 'agent_a', 'msg', NULL, 3);
      `);

      runMigrations(db);

      expect(
        db.prepare(`SELECT version FROM _migrations WHERE version = 20`).get(),
      ).toBeDefined();
      const rows = db
        .prepare(
          `SELECT id, delivered_at
             FROM conversation_inboxes
            WHERE conversation_id = 'conv'
              AND agent_id = 'agent_a'
              AND message_id = 'msg'`,
        )
        .all();
      expect(rows).toEqual([{ id: 2, delivered_at: null }]);
      const indexes = (db.pragma('index_list(conversation_inboxes)') as Array<{
        name: string;
        unique: number;
      }>);
      expect(indexes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'uniq_conversation_inbox_delivery',
            unique: 1,
          }),
        ]),
      );
      expect(() =>
        db
          .prepare(
            `INSERT INTO conversation_inboxes
               (conversation_id, agent_id, message_id, delivered_at, created_at)
             VALUES ('conv', 'agent_a', 'msg', NULL, 4)`,
          )
          .run(),
      ).toThrow(/UNIQUE/);
    } finally {
      db.close();
    }
  });

  describe('v21 users registry (Deferred Adoption)', () => {
    /**
     * Deferred Adoption contract: `users` is empty after migration and
     * `app_settings.viewer_user_id` is unset (no viewer exists yet);
     * pre-v21 user-id literals are NON-DESTRUCTIVELY captured into four
     * `legacy_*_v21` staging tables, while the live tables are made
     * FK-clean (NULLed in nullable columns, attachments(kind=user)
     * DELETEd from the main table after copying full rows into staging).
     * `UserService.register()` then consumes staging in the same
     * transaction that creates the first viewer, rewriting legacy ids
     * to the new viewer's id and DROPping staging on success. The
     * migration also installs the cross-namespace uniqueness triggers
     * and the polymorphic attachments dispatch trigger.
     */

    /**
     * Seeds a v20 DB with the legacy-shape data the rewrite must
     * stage (not wipe). Pre-v21 there was no `users` table, so
     * foreign keys to user ids are loose: principal-header literals
     * like `'local'`, `'teammate'` appeared anywhere in the schema.
     * v21 captures those into staging so registration can adopt them.
     */
    function seedV20LegacyData(db: Database.Database): void {
      const now = 1_700_000_000_000;
      db.exec(`
        INSERT INTO hosts (id, name, kind, created_at)
        VALUES ('host_local', 'local', 'local', ${now});

        INSERT INTO agents
          (id, name, runtime, model, host_id, description, created_at, updated_at,
           display_name, reasoning_effort, fast_mode)
        VALUES
          ('agent_alice', 'alice', 'claude', NULL, 'host_local', NULL, ${now}, ${now},
           'Alice', NULL, NULL);

        INSERT INTO workspaces
          (id, name, description, workspace_kind, workspace_path, workspace_host_id,
           owner_agent_id, archived_at, pinned_at, created_at, updated_at)
        VALUES
          ('ws_main', 'Main', NULL, 'regular', '/tmp/ws_main', 'host_local',
           NULL, NULL, NULL, ${now}, ${now});

        INSERT INTO conversations
          (id, workspace_id, workspace_path, kind, parent_conversation_id, title,
           status, spawned_by_agent_id, closed_at, close_summary, pinned_at,
           archived_at, created_at, updated_at)
        VALUES
          ('conv_main', 'ws_main', '/tmp/ws_main', 'channel', NULL, 'general',
           'idle', NULL, NULL, NULL, NULL, NULL, ${now}, ${now});

        INSERT INTO messages
          (id, conversation_id, from_kind, from_agent_id, from_user_id, content,
           metadata, seq, created_at, task_number, task_status,
           task_assignee_agent_id, task_assignee_user_id, task_title,
           task_workspace_id)
        VALUES
          ('msg_local', 'conv_main', 'user', NULL, 'local', 'hello',
           NULL, 1, ${now}, NULL, NULL, NULL, NULL, NULL, NULL),
          ('msg_task',  'conv_main', 'user', NULL, 'local', 'task body',
           NULL, 2, ${now + 1}, 1, 'todo', NULL, 'teammate', 'do thing', 'ws_main'),
          ('msg_null',  'conv_main', 'user', NULL, NULL,    'pre-principal',
           NULL, 3, ${now + 2}, NULL, NULL, NULL, NULL, NULL, NULL);

        INSERT INTO conversation_reads
          (user_id, conversation_id, last_read_seq, read_at)
        VALUES
          ('local',    'conv_main', 2, ${now}),
          ('teammate', 'conv_main', 1, ${now});

        INSERT INTO notifications
          (id, kind, user_id, agent_id, workspace_id, conversation_id, message_id,
           source_workspace_id, source_conversation_id, source_message_id,
           payload, read_at, created_at)
        VALUES
          ('notif_null',  'mention_external', NULL,    'agent_alice',
           'ws_main', 'conv_main', 'msg_local',
           'ws_main', 'conv_main', NULL, '{}', NULL, ${now}),
          ('notif_local', 'mention_external', 'local', 'agent_alice',
           'ws_main', 'conv_main', 'msg_task',
           'ws_main', 'conv_main', NULL, '{}', NULL, ${now + 1});

        INSERT INTO attachments
          (id, channel_id, source_conversation_id, filename, size,
           content_type, storage, storage_key, created_by_kind, created_by_id,
           created_at)
        VALUES
          ('att_user',  'conv_main', 'conv_main', 'user.png', 100,
           'image/png', 'local', 'attachments/att_user.png', 'user', 'local', ${now}),
          ('att_agent', 'conv_main', 'conv_main', 'agent.png', 100,
           'image/png', 'local', 'attachments/att_agent.png', 'agent', 'agent_alice', ${now});
      `);
    }

    it('creates an empty users table with the post-rewrite shape', () => {
      const db = new Database(':memory:');
      try {
        runMigrations(db);

        // Migration version recorded.
        expect(
          db.prepare(`SELECT version FROM _migrations WHERE version = 21`).get(),
        ).toBeDefined();

        // No auto-seeded viewer row, no viewer pointer.
        const userCount = db
          .prepare<[], { c: number }>(`SELECT COUNT(*) as c FROM users`)
          .get();
        expect(userCount?.c).toBe(0);

        const pointer = db
          .prepare<[], { value: string }>(
            `SELECT value FROM app_settings WHERE key = 'viewer_user_id'`,
          )
          .get();
        expect(pointer).toBeUndefined();

        // Column shape: id, name, display_name, avatar_storage_key,
        // avatar_content_type, created_at, updated_at — no
        // `onboarding_required`, no `handle`.
        const cols = (
          db.pragma('table_info(users)') as Array<{ name: string }>
        )
          .map(c => c.name)
          .sort();
        expect(cols).toEqual(
          [
            'id',
            'name',
            'display_name',
            'avatar_storage_key',
            'avatar_content_type',
            'created_at',
            'updated_at',
          ].sort(),
        );
      } finally {
        db.close();
      }
    });

    it('UNIQUE constraint on users.name', () => {
      const db = new Database(':memory:');
      try {
        runMigrations(db);
        db.prepare(
          `INSERT INTO users (id, name, display_name, created_at, updated_at)
           VALUES ('u-a', 'unique-name-a', 'Alice', 1, 1)`,
        ).run();

        expect(() =>
          db
            .prepare(
              `INSERT INTO users (id, name, display_name, created_at, updated_at)
               VALUES ('u-b', 'unique-name-a', 'Bob', 1, 1)`,
            )
            .run(),
        ).toThrow(/UNIQUE constraint failed: users\.name/);
      } finally {
        db.close();
      }
    });

    it('avatar columns are tied together (both NULL or both set)', () => {
      const db = new Database(':memory:');
      try {
        runMigrations(db);

        // Setting only one half violates the CHECK constraint.
        expect(() =>
          db
            .prepare(
              `INSERT INTO users
                 (id, name, display_name, avatar_storage_key,
                  avatar_content_type, created_at, updated_at)
               VALUES ('u-lop', 'half-avatar', 'Lop',
                       'avatars/u.png', NULL, 1, 1)`,
            )
            .run(),
        ).toThrow(/CHECK/);

        // Both set is fine.
        expect(() =>
          db
            .prepare(
              `INSERT INTO users
                 (id, name, display_name, avatar_storage_key,
                  avatar_content_type, created_at, updated_at)
               VALUES ('u-full', 'full-avatar', 'Full',
                       'avatars/u.png', 'image/png', 1, 1)`,
            )
            .run(),
        ).not.toThrow();
      } finally {
        db.close();
      }
    });

    it('cross-namespace uniqueness triggers exist (users.name ⊕ agents.name)', () => {
      const db = new Database(':memory:');
      try {
        runMigrations(db);
        const triggers = db
          .prepare<[], { name: string }>(
            `SELECT name FROM sqlite_schema WHERE type = 'trigger'
             ORDER BY name`,
          )
          .all()
          .map(r => r.name);
        expect(triggers).toEqual(
          expect.arrayContaining([
            'users_name_unique_against_agents_insert',
            'users_name_unique_against_agents_update',
            'agents_name_unique_against_users_insert',
            'agents_name_unique_against_users_update',
            'attachments_created_by_validate_insert',
            'attachments_created_by_validate_update',
          ]),
        );
        // Old `handle`-flavored names (pre-rewrite) must be gone.
        expect(triggers).not.toContain('users_handle_unique_against_agents_insert');
      } finally {
        db.close();
      }
    });

    it('rejects users.name that collides with an existing agents.name', () => {
      const db = new Database(':memory:');
      try {
        runMigrations(db);
        // Need a host + agent before exercising the trigger.
        db.exec(`
          INSERT INTO hosts (id, name, kind, created_at)
          VALUES ('host_local', 'local', 'local', 1);
          INSERT INTO agents
            (id, name, runtime, model, host_id, description, created_at, updated_at,
             display_name, reasoning_effort, fast_mode)
          VALUES
            ('agent_alice', 'alice', 'claude', NULL, 'host_local', NULL, 1, 1,
             'Alice', NULL, NULL);
        `);

        expect(() =>
          db
            .prepare(
              `INSERT INTO users (id, name, display_name, created_at, updated_at)
               VALUES ('u-clash', 'alice', 'Bob', 1, 1)`,
            )
            .run(),
        ).toThrow(/collides with an existing agent name/);

        // INSERT a different name first, then RENAME → 'alice' must fail too.
        db.prepare(
          `INSERT INTO users (id, name, display_name, created_at, updated_at)
           VALUES ('u-bob', 'bob', 'Bob', 1, 1)`,
        ).run();
        expect(() =>
          db.prepare(`UPDATE users SET name = 'alice' WHERE id = 'u-bob'`).run(),
        ).toThrow(/collides with an existing agent name/);
      } finally {
        db.close();
      }
    });

    it('rejects agents.name that collides with an existing users.name', () => {
      const db = new Database(':memory:');
      try {
        runMigrations(db);
        db.exec(`
          INSERT INTO hosts (id, name, kind, created_at)
          VALUES ('host_local', 'local', 'local', 1);
        `);
        db.prepare(
          `INSERT INTO users (id, name, display_name, created_at, updated_at)
           VALUES ('u-shiki', 'shiki', 'Shiki', 1, 1)`,
        ).run();

        expect(() =>
          db
            .prepare(
              `INSERT INTO agents
                 (id, name, runtime, model, host_id, description,
                  created_at, updated_at, display_name, reasoning_effort, fast_mode)
               VALUES ('agent_clash', 'shiki', 'claude', NULL, 'host_local', NULL,
                       1, 1, 'Clashing', NULL, NULL)`,
            )
            .run(),
        ).toThrow(/collides with an existing user name/);

        // RENAME path also fails.
        db.prepare(
          `INSERT INTO agents
             (id, name, runtime, model, host_id, description,
              created_at, updated_at, display_name, reasoning_effort, fast_mode)
           VALUES ('agent_alice', 'alice', 'claude', NULL, 'host_local', NULL,
                   1, 1, 'Alice', NULL, NULL)`,
        ).run();
        expect(() =>
          db.prepare(`UPDATE agents SET name = 'shiki' WHERE id = 'agent_alice'`).run(),
        ).toThrow(/collides with an existing user name/);
      } finally {
        db.close();
      }
    });

    it('attachments dispatch trigger rejects unknown user/agent ids by kind', () => {
      const db = new Database(':memory:');
      try {
        runMigrations(db);
        db.exec(`
          INSERT INTO hosts (id, name, kind, created_at)
          VALUES ('host_local', 'local', 'local', 1);
          INSERT INTO agents
            (id, name, runtime, model, host_id, description, created_at, updated_at,
             display_name, reasoning_effort, fast_mode)
          VALUES
            ('agent_alice', 'alice', 'claude', NULL, 'host_local', NULL, 1, 1,
             'Alice', NULL, NULL);
          INSERT INTO workspaces
            (id, name, description, workspace_kind, workspace_path, workspace_host_id,
             owner_agent_id, archived_at, pinned_at, created_at, updated_at)
          VALUES
            ('ws_main', 'Main', NULL, 'regular', '/tmp/ws_main', 'host_local',
             NULL, NULL, NULL, 1, 1);
          INSERT INTO conversations
            (id, workspace_id, workspace_path, kind, parent_conversation_id, title,
             status, spawned_by_agent_id, closed_at, close_summary, pinned_at,
             archived_at, created_at, updated_at)
          VALUES
            ('conv_main', 'ws_main', '/tmp/ws_main', 'channel', NULL, 'general',
             'idle', NULL, NULL, NULL, NULL, NULL, 1, 1);
        `);

        // kind='user' with a non-existent user id is rejected.
        expect(() =>
          db
            .prepare(
              `INSERT INTO attachments
                 (id, channel_id, source_conversation_id, filename, size,
                  content_type, storage, storage_key, created_by_kind,
                  created_by_id, created_at)
               VALUES ('att_bad_u', 'conv_main', 'conv_main', 'x.png', 1,
                       'image/png', 'local', 'attachments/x.png',
                       'user', 'u-does-not-exist', 1)`,
            )
            .run(),
        ).toThrow(/created_by_id \(kind=user\)/);

        // kind='agent' with a non-existent agent id is rejected.
        expect(() =>
          db
            .prepare(
              `INSERT INTO attachments
                 (id, channel_id, source_conversation_id, filename, size,
                  content_type, storage, storage_key, created_by_kind,
                  created_by_id, created_at)
               VALUES ('att_bad_a', 'conv_main', 'conv_main', 'x.png', 1,
                       'image/png', 'local', 'attachments/x.png',
                       'agent', 'agent_does_not_exist', 1)`,
            )
            .run(),
        ).toThrow(/created_by_id \(kind=agent\)/);

        // Valid: insert a user, then attach as that user.
        db.prepare(
          `INSERT INTO users (id, name, display_name, created_at, updated_at)
           VALUES ('u-shiki', 'shiki', 'Shiki', 1, 1)`,
        ).run();
        expect(() =>
          db
            .prepare(
              `INSERT INTO attachments
                 (id, channel_id, source_conversation_id, filename, size,
                  content_type, storage, storage_key, created_by_kind,
                  created_by_id, created_at)
               VALUES ('att_valid', 'conv_main', 'conv_main', 'x.png', 1,
                       'image/png', 'local', 'attachments/v.png',
                       'user', 'u-shiki', 1)`,
            )
            .run(),
        ).not.toThrow();
      } finally {
        db.close();
      }
    });

    it('rebuilds messages / conversation_reads / notifications with FK on users', () => {
      const db = new Database(':memory:');
      try {
        runMigrations(db);

        // FK list on messages includes from_user_id and task_assignee_user_id
        // both pointing to users with ON DELETE SET NULL.
        const messageFks = (
          db.pragma('foreign_key_list(messages)') as Array<{
            table: string;
            from: string;
            to: string;
            on_delete: string;
          }>
        ).filter(fk => fk.table === 'users');
        const fromCols = messageFks.map(fk => fk.from).sort();
        expect(fromCols).toEqual(['from_user_id', 'task_assignee_user_id']);
        for (const fk of messageFks) {
          expect(fk.to).toBe('id');
          expect(fk.on_delete).toBe('SET NULL');
        }

        // FK on conversation_reads.user_id is CASCADE.
        const readsFks = (
          db.pragma('foreign_key_list(conversation_reads)') as Array<{
            table: string;
            from: string;
            on_delete: string;
          }>
        ).filter(fk => fk.table === 'users');
        expect(readsFks).toHaveLength(1);
        expect(readsFks[0]).toMatchObject({
          from: 'user_id',
          on_delete: 'CASCADE',
        });

        // FK on notifications.user_id is SET NULL.
        const notifFks = (
          db.pragma('foreign_key_list(notifications)') as Array<{
            table: string;
            from: string;
            on_delete: string;
          }>
        ).filter(fk => fk.table === 'users');
        expect(notifFks).toHaveLength(1);
        expect(notifFks[0]).toMatchObject({
          from: 'user_id',
          on_delete: 'SET NULL',
        });

        // FK integrity holds across the whole DB.
        expect(db.pragma('foreign_key_check')).toEqual([]);
      } finally {
        db.close();
      }
    });

    it('stages pre-v21 user-id literals into legacy_*_v21 holding tables (Deferred Adoption)', () => {
      // Open a v20-shape DB seeded with legacy literals, then run all
      // remaining migrations. The new v21 (Deferred Adoption) must:
      //   - NULL nullable user-id columns in main tables (messages.from_user_id,
      //     messages.task_assignee_user_id, notifications.user_id).
      //   - Move kind=user attachments into legacy_user_attachments_v21.
      //   - Move conversation_reads rows into legacy_conversation_reads_v21.
      //   - Capture original-non-null message ids into the two
      //     legacy_message_*_v21 staging tables so register-time adoption
      //     can re-attribute exactly the originally-attributed rows
      //     (rows that were NULL pre-v21 stay NULL).
      // Main schema must be FK-clean immediately so the app boots
      // pre-registration; adoption happens later in UserService.register().
      const db = openDbAt(20);
      try {
        seedV20LegacyData(db);
        runMigrations(db);

        // FK integrity holds — proves the staging move was sufficient.
        expect(db.pragma('foreign_key_check')).toEqual([]);

        // messages.from_user_id NULLed in main; original-non-null ids
        // captured in legacy_message_from_user_v21 (msg_local, msg_task
        // both had from_user_id='local'; msg_null was already NULL).
        const msgs = db
          .prepare<[], { id: string; from_user_id: string | null; task_assignee_user_id: string | null }>(
            `SELECT id, from_user_id, task_assignee_user_id FROM messages ORDER BY seq`,
          )
          .all();
        expect(msgs).toEqual([
          { id: 'msg_local', from_user_id: null, task_assignee_user_id: null },
          { id: 'msg_task',  from_user_id: null, task_assignee_user_id: null },
          { id: 'msg_null',  from_user_id: null, task_assignee_user_id: null },
        ]);

        const fromStaging = db
          .prepare<[], { message_id: string }>(
            `SELECT message_id FROM legacy_message_from_user_v21 ORDER BY message_id`,
          )
          .all();
        expect(fromStaging).toEqual([
          { message_id: 'msg_local' },
          { message_id: 'msg_task' },
        ]);

        // task_assignee staging captures only msg_task (only one
        // with task_number IS NOT NULL AND task_assignee_user_id NOT NULL).
        const taskStaging = db
          .prepare<[], { message_id: string }>(
            `SELECT message_id FROM legacy_message_task_assignee_user_v21 ORDER BY message_id`,
          )
          .all();
        expect(taskStaging).toEqual([{ message_id: 'msg_task' }]);

        // notifications.user_id NULLed; intentionally not staged (pre-v21
        // notifications were mostly system-kind and bulk-adopting would
        // over-claim — see migration header).
        const notifs = db
          .prepare<[], { id: string; user_id: string | null }>(
            `SELECT id, user_id FROM notifications ORDER BY id`,
          )
          .all();
        expect(notifs).toEqual([
          { id: 'notif_local', user_id: null },
          { id: 'notif_null',  user_id: null },
        ]);

        // Main conversation_reads is empty (data lives in staging until
        // register-time adoption merges by conversation_id).
        const reads = db
          .prepare<[], { c: number }>(
            `SELECT COUNT(*) as c FROM conversation_reads`,
          )
          .get();
        expect(reads?.c).toBe(0);

        // legacy_conversation_reads_v21 holds both legacy rows verbatim.
        // Same conversation_id can appear multiple times (different
        // original_user_id) — adoption merges them.
        const readsStaging = db
          .prepare<[], {
            original_user_id: string;
            conversation_id: string;
            last_read_seq: number;
          }>(
            `SELECT original_user_id, conversation_id, last_read_seq
               FROM legacy_conversation_reads_v21
              ORDER BY original_user_id`,
          )
          .all();
        expect(readsStaging).toEqual([
          { original_user_id: 'local',    conversation_id: 'conv_main', last_read_seq: 2 },
          { original_user_id: 'teammate', conversation_id: 'conv_main', last_read_seq: 1 },
        ]);

        // Main attachments has only the agent row (user-kind row moved
        // to staging so the dispatch trigger never sees a row that
        // would fail validation).
        const atts = db
          .prepare<[], { id: string; created_by_kind: string; created_by_id: string }>(
            `SELECT id, created_by_kind, created_by_id FROM attachments ORDER BY id`,
          )
          .all();
        expect(atts).toEqual([
          { id: 'att_agent', created_by_kind: 'agent', created_by_id: 'agent_alice' },
        ]);

        // legacy_user_attachments_v21 holds the user-kind row intact —
        // adoption re-INSERTs it into the live attachments table with
        // created_by_id = viewerId.
        const attStaging = db
          .prepare<[], {
            id: string;
            created_by_kind: string;
            created_by_id: string;
            filename: string;
          }>(
            `SELECT id, created_by_kind, created_by_id, filename
               FROM legacy_user_attachments_v21`,
          )
          .all();
        expect(attStaging).toEqual([
          {
            id: 'att_user',
            created_by_kind: 'user',
            created_by_id: 'local',
            filename: 'user.png',
          },
        ]);

        // No surprise users row was created.
        const userCount = db
          .prepare<[], { c: number }>(`SELECT COUNT(*) as c FROM users`)
          .get();
        expect(userCount?.c).toBe(0);

        // app_settings.viewer_user_id is NOT set yet; adoption audit
        // keys are NOT written yet (those happen at register time).
        const auditKeys = db
          .prepare<[], { key: string }>(
            `SELECT key FROM app_settings
              WHERE key IN (
                'viewer_user_id',
                'legacy_v21_adoption_completed_at',
                'legacy_v21_adoption_counts'
              )`,
          )
          .all();
        expect(auditKeys).toEqual([]);
      } finally {
        db.close();
      }
    });

    it('on a fresh-schema DB (no pre-v21 data) creates empty staging tables', () => {
      // Fresh install path: no source rows, so staging tables exist
      // (CREATE TABLE always runs) but are empty. Register-time adoption
      // will be a no-op with all-zero audit counts.
      const db = new Database(':memory:');
      try {
        runMigrations(db);

        for (const t of [
          'legacy_message_from_user_v21',
          'legacy_message_task_assignee_user_v21',
          'legacy_conversation_reads_v21',
          'legacy_user_attachments_v21',
        ]) {
          const exists = db
            .prepare<[string], { name: string }>(
              `SELECT name FROM sqlite_schema WHERE type='table' AND name = ?`,
            )
            .get(t);
          expect(exists).toBeDefined();

          const count = db
            .prepare<[], { c: number }>(`SELECT COUNT(*) as c FROM ${t}`)
            .get();
          expect(count?.c).toBe(0);
        }
      } finally {
        db.close();
      }
    });
  });

  describe('migration v22 (no-op stub)', () => {
    /**
     * The original v22 renamed `users.handle` → `users.name`. The
     * pre-ship rewrite squashed that into v21 (which now creates
     * `name` directly), so v22 is intentionally empty — kept only to
     * preserve version-sequence continuity for dev DBs that already
     * advanced past v21.
     */
    it('records v22 in _migrations but changes no schema', () => {
      const db = new Database(':memory:');
      try {
        runMigrations(db);
        expect(
          db.prepare(`SELECT version FROM _migrations WHERE version = 22`).get(),
        ).toBeDefined();

        // After v22, users still has `name` (not `handle`), and there
        // are no `handle`-flavored triggers or columns anywhere.
        const cols = (
          db.pragma('table_info(users)') as Array<{ name: string }>
        ).map(c => c.name);
        expect(cols).toContain('name');
        expect(cols).not.toContain('handle');

        const triggers = db
          .prepare<[], { name: string }>(
            `SELECT name FROM sqlite_schema WHERE type = 'trigger'`,
          )
          .all()
          .map(r => r.name);
        for (const tname of triggers) {
          expect(tname).not.toContain('handle');
        }
      } finally {
        db.close();
      }
    });
  });
});
