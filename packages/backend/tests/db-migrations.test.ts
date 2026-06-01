import Database from 'better-sqlite3';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CURRENT_SCHEMA_VERSION,
  MIN_SUPPORTED_SCHEMA_VERSION,
  migrations,
} from '@silverhand/shared';
import {
  backupDataDirBeforeMigration,
  currentSchemaVersion,
  openDatabase,
  runMigrations,
} from '../src/db.js';

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

/**
 * Test helper: apply pending migrations up to and including the
 * requested version, mirroring `runMigrations` semantics (transactions,
 * preconditions, foreignKeyEscape branching) but stopping early so
 * tests can observe intermediate states.
 *
 * Used by tests that need to inspect the post-v22 state (the
 * staging-creation contract from v21 — see Deferred Adoption history)
 * without triggering v23's Mode B cleanup, which drops empty staging
 * tables and refuses to run when staging holds unadopted rows.
 */
function applyMigrationsThrough(
  db: Database.Database,
  maxVersion: number,
): void {
  const applied = new Set(
    db
      .prepare<[], { version: number }>('SELECT version FROM _migrations')
      .all()
      .map(r => r.version),
  );
  const insertMigration = db.prepare(
    'INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)',
  );
  for (const m of migrations) {
    if (applied.has(m.version)) continue;
    if (m.version > maxVersion) break;
    const apply = () => {
      if (m.precondition) m.precondition(db);
      db.exec(m.up);
      if (m.foreignKeyEscape) {
        const violations = db.pragma('foreign_key_check') as unknown[];
        if (violations.length > 0) {
          throw new Error(
            `migration v${m.version}: foreign_key_check found ${violations.length} violations: ${JSON.stringify(violations)}`,
          );
        }
      }
      insertMigration.run(m.version, m.name, Date.now());
    };
    if (m.foreignKeyEscape) {
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
}

function pragmaNumber(db: Database.Database, name: string): number {
  const row = db.pragma(name) as Array<Record<string, number>>;
  return Object.values(row[0] ?? {})[0] ?? 0;
}

const SYNTHETIC_UPGRADE_BASE_VERSION = MIN_SUPPORTED_SCHEMA_VERSION;
const SYNTHETIC_UPGRADE_TARGET_VERSION = MIN_SUPPORTED_SCHEMA_VERSION + 1;

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
  it('initializes a clean DB to the current schema version', () => {
    let completed = false;
    const db = openDatabase(':memory:', {
      onMigrationsApplied: () => {
        completed = true;
      },
    });
    try {
      expect(completed).toBe(true);
      expect(currentSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  it('reruns idempotently when the DB is already at the current version', () => {
    const db = openDatabase(':memory:');
    try {
      const first = currentSchemaVersion(db);
      const second = runMigrations(db, {
        expectedVersion: CURRENT_SCHEMA_VERSION,
        minimumSupportedVersion: MIN_SUPPORTED_SCHEMA_VERSION,
      });
      expect(first).toBe(CURRENT_SCHEMA_VERSION);
      expect(second).toEqual({
        beforeVersion: CURRENT_SCHEMA_VERSION,
        afterVersion: CURRENT_SCHEMA_VERSION,
        appliedVersions: [],
        backupPath: null,
      });
    } finally {
      db.close();
    }
  });

  it('requires env-style opt-in before upgrading an existing DB', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE _migrations (
          version INTEGER PRIMARY KEY,
          name    TEXT NOT NULL,
          applied_at INTEGER NOT NULL
        );
        INSERT INTO _migrations (version, name, applied_at)
        VALUES (${SYNTHETIC_UPGRADE_BASE_VERSION}, 'current', 1);
      `);
      expect(() =>
        runMigrations(db, {
          migrations: [
            {
              version: SYNTHETIC_UPGRADE_TARGET_VERSION,
              name: 'future',
              up: `CREATE TABLE future_rows (id TEXT PRIMARY KEY);`,
            },
          ],
          expectedVersion: SYNTHETIC_UPGRADE_TARGET_VERSION,
          minimumSupportedVersion: SYNTHETIC_UPGRADE_BASE_VERSION,
          allowSchemaUpgrade: false,
        }),
      ).toThrow(/SILVERHAND_MIGRATE=1/);
      expect(currentSchemaVersion(db)).toBe(SYNTHETIC_UPGRADE_BASE_VERSION);
      expect(
        db
          .prepare(
            `SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'future_rows'`,
          )
          .get(),
      ).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('backs up the whole data directory before an opted-in schema upgrade', async () => {
    const dir = mkdtempSync('/tmp/shmig-');
    const dataDir = join(dir, 'data');
    const dbPath = join(dataDir, 'silverhand.db');
    mkdirSync(join(dataDir, 'blobs'), { recursive: true });
    mkdirSync(join(dataDir, 'logs'), { recursive: true });
    mkdirSync(join(dataDir, 'run'), { recursive: true });
    mkdirSync(join(dataDir, 'workspaces'), { recursive: true });
    writeFileSync(join(dataDir, 'blobs', 'blob.txt'), 'blob bytes');
    writeFileSync(join(dataDir, 'logs', 'backend.log'), 'log bytes');
    writeFileSync(join(dataDir, 'workspaces', 'workspace.txt'), 'workspace bytes');
    symlinkSync('../blobs/blob.txt', join(dataDir, 'logs', 'blob-link'));
    const socketPath = join(dataDir, 'run', 'daemon.sock');
    const socketServer = createServer();
    await new Promise<void>((resolve, reject) => {
      socketServer.once('error', reject);
      socketServer.listen(socketPath, resolve);
    });
    const db = new Database(dbPath);
    try {
      db.exec(`
        CREATE TABLE _migrations (
          version INTEGER PRIMARY KEY,
          name    TEXT NOT NULL,
          applied_at INTEGER NOT NULL
        );
        INSERT INTO _migrations (version, name, applied_at)
        VALUES (${SYNTHETIC_UPGRADE_BASE_VERSION}, 'current', 1);

        CREATE TABLE preserved_rows (id TEXT PRIMARY KEY);
        INSERT INTO preserved_rows (id) VALUES ('before');
      `);
      const result = runMigrations(db, {
        migrations: [
          {
            version: SYNTHETIC_UPGRADE_TARGET_VERSION,
            name: 'future',
            up: `CREATE TABLE future_rows (id TEXT PRIMARY KEY);`,
          },
        ],
        expectedVersion: SYNTHETIC_UPGRADE_TARGET_VERSION,
        minimumSupportedVersion: SYNTHETIC_UPGRADE_BASE_VERSION,
        allowSchemaUpgrade: true,
        backupBeforeMigration: info =>
          backupDataDirBeforeMigration(db, { dbPath, ...info }),
      });
      expect(result.beforeVersion).toBe(SYNTHETIC_UPGRADE_BASE_VERSION);
      expect(result.afterVersion).toBe(SYNTHETIC_UPGRADE_TARGET_VERSION);
      expect(result.appliedVersions).toEqual([SYNTHETIC_UPGRADE_TARGET_VERSION]);
      expect(result.backupPath).toMatch(/data-backup-\d{8}T\d{6}Z$/);
      expect(currentSchemaVersion(db)).toBe(SYNTHETIC_UPGRADE_TARGET_VERSION);
      expect(
        db
          .prepare(
            `SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'future_rows'`,
          )
          .get(),
      ).toBeDefined();

      expect(
        readFileSync(join(result.backupPath!, 'blobs', 'blob.txt'), 'utf8'),
      ).toBe('blob bytes');
      expect(
        readFileSync(join(result.backupPath!, 'logs', 'backend.log'), 'utf8'),
      ).toBe('log bytes');
      expect(
        readFileSync(
          join(result.backupPath!, 'workspaces', 'workspace.txt'),
          'utf8',
        ),
      ).toBe('workspace bytes');
      expect(
        readFileSync(join(result.backupPath!, 'logs', 'blob-link'), 'utf8'),
      ).toBe('blob bytes');
      expect(() =>
        readFileSync(join(result.backupPath!, 'run', 'daemon.sock')),
      ).toThrow();

      const backupDb = new Database(
        join(result.backupPath!, 'silverhand.db'),
        { readonly: true },
      );
      try {
        expect(currentSchemaVersion(backupDb)).toBe(
          SYNTHETIC_UPGRADE_BASE_VERSION,
        );
        expect(
          backupDb.prepare(`SELECT id FROM preserved_rows`).get(),
        ).toEqual({ id: 'before' });
        expect(
          backupDb
            .prepare(
              `SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'future_rows'`,
            )
            .get(),
        ).toBeUndefined();
      } finally {
        backupDb.close();
      }
    } finally {
      db.close();
      await new Promise<void>(resolve => socketServer.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not apply migrations when the pre-migration backup fails', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE _migrations (
          version INTEGER PRIMARY KEY,
          name    TEXT NOT NULL,
          applied_at INTEGER NOT NULL
        );
        INSERT INTO _migrations (version, name, applied_at)
        VALUES (${SYNTHETIC_UPGRADE_BASE_VERSION}, 'current', 1);
      `);
      expect(() =>
        runMigrations(db, {
          migrations: [
            {
              version: SYNTHETIC_UPGRADE_TARGET_VERSION,
              name: 'future',
              up: `CREATE TABLE future_rows (id TEXT PRIMARY KEY);`,
            },
          ],
          expectedVersion: SYNTHETIC_UPGRADE_TARGET_VERSION,
          minimumSupportedVersion: SYNTHETIC_UPGRADE_BASE_VERSION,
          allowSchemaUpgrade: true,
          backupBeforeMigration: () => {
            throw new Error('backup path is not writable');
          },
        }),
      ).toThrow(/backup path is not writable/);
      expect(currentSchemaVersion(db)).toBe(SYNTHETIC_UPGRADE_BASE_VERSION);
      expect(
        db
          .prepare(
            `SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'future_rows'`,
          )
          .get(),
      ).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('rolls back a failed migration and does not call the completion hook', () => {
    const db = new Database(':memory:');
    let completed = false;
    try {
      expect(() =>
        runMigrations(db, {
          migrations: [
            {
              version: 1,
              name: 'stable',
              up: `CREATE TABLE stable_rows (id TEXT PRIMARY KEY);`,
            },
            {
              version: 2,
              name: 'broken',
              up: `
                CREATE TABLE broken_rows (id TEXT PRIMARY KEY);
                INSERT INTO missing_table VALUES ('fail');
              `,
            },
          ],
          onMigrationsApplied: () => {
            completed = true;
          },
        }),
      ).toThrow(/missing_table/);
      expect(completed).toBe(false);
      expect(currentSchemaVersion(db)).toBe(1);
      expect(
        db
          .prepare(
            `SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'stable_rows'`,
          )
          .get(),
      ).toBeDefined();
      expect(
        db
          .prepare(
            `SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'broken_rows'`,
          )
          .get(),
      ).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('rejects startup when the DB schema is older than the minimum supported version', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE _migrations (
          version INTEGER PRIMARY KEY,
          name    TEXT NOT NULL,
          applied_at INTEGER NOT NULL
        );
        INSERT INTO _migrations (version, name, applied_at)
        VALUES (1, 'initial', 1);
      `);
      expect(() =>
        runMigrations(db, {
          expectedVersion: CURRENT_SCHEMA_VERSION,
          minimumSupportedVersion: MIN_SUPPORTED_SCHEMA_VERSION,
        }),
      ).toThrow(/older than minimum supported/);
    } finally {
      db.close();
    }
  });

  it('rejects unsupported pre-migration application DBs without creating _migrations', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`CREATE TABLE legacy_rows (id TEXT PRIMARY KEY);`);
      expect(() =>
        runMigrations(db, {
          expectedVersion: CURRENT_SCHEMA_VERSION,
          minimumSupportedVersion: MIN_SUPPORTED_SCHEMA_VERSION,
        }),
      ).toThrow(/older than minimum supported/);
      expect(
        db
          .prepare(
            `SELECT name FROM sqlite_schema WHERE type = 'table' AND name = '_migrations'`,
          )
          .get(),
      ).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('rejects startup when the DB schema is newer than this code supports', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE _migrations (
          version INTEGER PRIMARY KEY,
          name    TEXT NOT NULL,
          applied_at INTEGER NOT NULL
        );
        INSERT INTO _migrations (version, name, applied_at)
        VALUES (999, 'future', 1);
      `);
      expect(() =>
        runMigrations(db, {
          expectedVersion: CURRENT_SCHEMA_VERSION,
          minimumSupportedVersion: MIN_SUPPORTED_SCHEMA_VERSION,
        }),
      ).toThrow(/newer than supported/);
    } finally {
      db.close();
    }
  });

  it('fails fast when the migration phase cannot acquire the SQLite write lock', () => {
    const dir = mkdtempSync(join(tmpdir(), 'silverhand-migration-lock-test-'));
    const dbPath = join(dir, 'silverhand.db');
    const db = openDatabase(dbPath);
    try {
      db.exec('BEGIN EXCLUSIVE');
      try {
        expect(() => openDatabase(dbPath)).toThrow(/database is locked|SQLITE_BUSY/i);
      } finally {
        db.exec('ROLLBACK');
      }
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails fast when another process owns the migration lock directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'silverhand-migration-dir-lock-test-'));
    const dataDir = join(dir, '.silverhand');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(join(dir, '.silverhand.migration.lock'));
    try {
      expect(() => openDatabase(join(dataDir, 'silverhand.db'))).toThrow(
        /migration lock/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('v16 splits the legacy system DM workspace into one multi-channel agent_home', () => {
    const db = openDbAt(15);
    try {
      seedV15SystemDmFixture(db);

      // Stops at v22 — the seed creates `from_user_id='local'` legacy
      // user references, which v21 stages into `legacy_message_*_v21`.
      // Running through v23 would refuse (Mode B: non-empty staging
      // means unadopted data). v16's contract is unaffected by v23 so
      // observing post-v22 state is sufficient.
      applyMigrationsThrough(db, 22);

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
        'title',
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
        INSERT INTO users (id, name, display_name, created_at, updated_at)
          VALUES ('u-creator', 'creator', 'Creator', 1, 1);
        INSERT INTO agents
          (id, name, runtime, model, host_id, description,
           created_at, updated_at, display_name, reasoning_effort, fast_mode,
           created_by_user_id)
          VALUES ('ag', 'a', 'claude', NULL, 'h', NULL, 1, 1, 'A', NULL, NULL,
                  'u-creator');
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

      // Stops at v22 — same reason as the v16 test above (legacy
      // user references would otherwise prime v21 staging and trip
      // v23's Mode B refusal).
      applyMigrationsThrough(db, 22);

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

  it('v32 adds in-flight delivery columns for outbound replay recovery', () => {
    const db = openDbAt(31);
    try {
      runMigrations(db);
      expect(
        db.prepare(`SELECT version FROM _migrations WHERE version = 32`).get(),
      ).toBeDefined();

      const cols = (db.pragma('table_info(conversation_inboxes)') as Array<{
        name: string;
      }>).map(c => c.name);
      expect(cols).toEqual(
        expect.arrayContaining([
          'in_flight_owner',
          'in_flight_at',
          'failed_at',
          'failed_reason',
        ]),
      );

      const indexes = (db.pragma('index_list(conversation_inboxes)') as Array<{
        name: string;
      }>).map(r => r.name);
      expect(indexes).toEqual(
        expect.arrayContaining([
          'idx_conversation_inbox_replay_pending',
          'idx_conversation_inbox_in_flight_owner',
        ]),
      );
    } finally {
      db.close();
    }
  });

  it('v33 adds agent materialization columns and creator-scoped idempotency_key index', () => {
    // D4.d D1 (additive schema; design §4.1). Pin:
    //   (a) the four new columns exist on `agents`;
    //   (b) the CHECK on materialization_status accepts only the
    //       three documented values;
    //   (c) the partial unique index is keyed
    //       (created_by_user_id, idempotency_key) — NOT keyed
    //       (idempotency_key) alone, so two distinct users colliding
    //       on the same opaque key can both succeed (Cindy round-2
    //       P1 #5: globally-unique index would leak existence
    //       across users);
    //   (d) idempotency_key=NULL rows are NOT subject to the
    //       partial index (so legacy/active rows can coexist with
    //       NULL keys without unique-constraint friction).
    const db = openDbAt(32);
    try {
      runMigrations(db);
      expect(
        db.prepare(`SELECT version FROM _migrations WHERE version = 33`).get(),
      ).toBeDefined();

      const cols = (db.pragma('table_info(agents)') as Array<{
        name: string;
        notnull: number;
        dflt_value: string | null;
      }>);
      const colNames = cols.map(c => c.name);
      expect(colNames).toEqual(
        expect.arrayContaining([
          'materialization_status',
          'materialization_failed_code',
          'materialization_failed_at',
          'idempotency_key',
        ]),
      );

      const statusCol = cols.find(c => c.name === 'materialization_status')!;
      // Backfill default is 'active' (existing rows pre-D4.d went
      // through the legacy backend-direct-fs path; their L1 dirs
      // already exist).
      expect(statusCol.notnull).toBe(1);
      expect(statusCol.dflt_value).toBe("'active'");

      const indexes = (db.pragma('index_list(agents)') as Array<{
        name: string;
        unique: number;
      }>);
      const idemIndex = indexes.find(i => i.name === 'idx_agents_idempotency_key_per_user');
      expect(idemIndex).toBeDefined();
      expect(idemIndex!.unique).toBe(1);

      // Pin keyed columns explicitly: (created_by_user_id, idempotency_key).
      const idxCols = (db.pragma(
        'index_info(idx_agents_idempotency_key_per_user)',
      ) as Array<{ seqno: number; name: string }>).map(c => c.name);
      expect(idxCols).toEqual(['created_by_user_id', 'idempotency_key']);

      // Seed a viewer + host so we can exercise the new columns.
      db.exec(`
        INSERT INTO hosts (id, name, kind, created_at)
        VALUES ('h1', 'local', 'local', 1);
        INSERT INTO users
          (id, name, display_name, created_at, updated_at)
        VALUES
          ('u1', 'alice_u', 'Alice U', 1, 1),
          ('u2', 'bob_u',   'Bob U',   2, 2);
      `);

      // CHECK constraint: only the three documented status values
      // are accepted.
      expect(() =>
        db
          .prepare(
            `INSERT INTO agents
               (id, name, runtime, host_id, created_at, updated_at,
                created_by_user_id, materialization_status)
             VALUES ('a_bad', 'bad', 'claude', 'h1', 1, 1, 'u1', 'archived')`,
          )
          .run(),
      ).toThrow(/CHECK/);

      // NULL idempotency_key is NOT subject to the partial unique
      // index; two rows with NULL keys (different ids) coexist.
      db.prepare(
        `INSERT INTO agents
           (id, name, runtime, host_id, created_at, updated_at,
            created_by_user_id)
         VALUES ('a_n1', 'n1', 'claude', 'h1', 1, 1, 'u1')`,
      ).run();
      db.prepare(
        `INSERT INTO agents
           (id, name, runtime, host_id, created_at, updated_at,
            created_by_user_id)
         VALUES ('a_n2', 'n2', 'claude', 'h1', 1, 1, 'u1')`,
      ).run();

      // Same (user, key) twice rejected. Different users with the
      // same key both succeed (this is the whole point of the
      // creator-scoped index).
      db.prepare(
        `INSERT INTO agents
           (id, name, runtime, host_id, created_at, updated_at,
            created_by_user_id, idempotency_key)
         VALUES ('a1', 'a1', 'claude', 'h1', 1, 1, 'u1', 'k-shared')`,
      ).run();
      expect(() =>
        db
          .prepare(
            `INSERT INTO agents
               (id, name, runtime, host_id, created_at, updated_at,
                created_by_user_id, idempotency_key)
             VALUES ('a1b', 'a1b', 'claude', 'h1', 1, 1, 'u1', 'k-shared')`,
          )
          .run(),
      ).toThrow(/UNIQUE/);

      db.prepare(
        `INSERT INTO agents
           (id, name, runtime, host_id, created_at, updated_at,
            created_by_user_id, idempotency_key)
         VALUES ('a2', 'a2', 'claude', 'h1', 1, 1, 'u2', 'k-shared')`,
      ).run();

      const sharedRows = db
        .prepare(
          `SELECT id, created_by_user_id
             FROM agents
             WHERE idempotency_key = 'k-shared'
             ORDER BY id`,
        )
        .all() as Array<{ id: string; created_by_user_id: string }>;
      expect(sharedRows).toEqual([
        { id: 'a1', created_by_user_id: 'u1' },
        { id: 'a2', created_by_user_id: 'u2' },
      ]);
    } finally {
      db.close();
    }
  });

  it('v34 adds task_archived_at to messages with active/archived task indexes', () => {
    const db = openDbAt(33);
    try {
      runMigrations(db);
      expect(
        db.prepare(`SELECT version FROM _migrations WHERE version = 34`).get(),
      ).toBeDefined();

      const messageCols = (db.pragma('table_info(messages)') as Array<{
        name: string;
        notnull: number;
      }>).map(c => ({ name: c.name, notnull: c.notnull }));
      expect(messageCols).toContainEqual({ name: 'task_archived_at', notnull: 0 });

      const indexes = (db.pragma('index_list(messages)') as Array<{
        name: string;
        partial: number;
      }>);
      expect(indexes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'idx_messages_task_workspace_active',
            partial: 1,
          }),
          expect.objectContaining({
            name: 'idx_messages_task_workspace_archived',
            partial: 1,
          }),
        ]),
      );
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
      const db = openDbAt(21);
      try {
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
          INSERT INTO users (id, name, display_name, created_at, updated_at)
          VALUES ('u-creator', 'creator', 'Creator', 1, 1);
          INSERT INTO agents
            (id, name, runtime, model, host_id, description, created_at, updated_at,
             display_name, reasoning_effort, fast_mode, created_by_user_id)
          VALUES
            ('agent_alice', 'alice', 'claude', NULL, 'host_local', NULL, 1, 1,
             'Alice', NULL, NULL, 'u-creator');
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
                  created_at, updated_at, display_name, reasoning_effort, fast_mode,
                  created_by_user_id)
               VALUES ('agent_clash', 'shiki', 'claude', NULL, 'host_local', NULL,
                       1, 1, 'Clashing', NULL, NULL, 'u-shiki')`,
            )
            .run(),
        ).toThrow(/collides with an existing user name/);

        // RENAME path also fails.
        db.prepare(
          `INSERT INTO agents
             (id, name, runtime, model, host_id, description,
              created_at, updated_at, display_name, reasoning_effort, fast_mode,
              created_by_user_id)
           VALUES ('agent_alice', 'alice', 'claude', NULL, 'host_local', NULL,
                   1, 1, 'Alice', NULL, NULL, 'u-shiki')`,
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
          INSERT INTO users (id, name, display_name, created_at, updated_at)
          VALUES ('u-creator', 'creator', 'Creator', 1, 1);
          INSERT INTO agents
            (id, name, runtime, model, host_id, description, created_at, updated_at,
             display_name, reasoning_effort, fast_mode, created_by_user_id)
          VALUES
            ('agent_alice', 'alice', 'claude', NULL, 'host_local', NULL, 1, 1,
             'Alice', NULL, NULL, 'u-creator');
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
      // Open a v20-shape DB seeded with legacy literals, then apply
      // through v22. Mode B's v23 cleanup intentionally refuses to run
      // when staging holds rows; this test asserts the historical v21
      // staging-creation contract (still meaningful as a bridge for
      // pre-v21 backups consumed on older builds).
      // The new v21 (Deferred Adoption) must:
      //   - NULL nullable user-id columns in main tables (messages.from_user_id,
      //     messages.task_assignee_user_id, notifications.user_id).
      //   - Move kind=user attachments into legacy_user_attachments_v21.
      //   - Move conversation_reads rows into legacy_conversation_reads_v21.
      //   - Capture original-non-null message ids into the two
      //     legacy_message_*_v21 staging tables so register-time adoption
      //     can re-attribute exactly the originally-attributed rows
      //     (rows that were NULL pre-v21 stay NULL).
      // Main schema must be FK-clean immediately so the app boots
      // pre-registration.
      const db = openDbAt(20);
      try {
        seedV20LegacyData(db);
        applyMigrationsThrough(db, 22);

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
      // (CREATE TABLE always runs) but are empty.
      //
      // Test stops at v22 to verify v21's staging-creation contract.
      // After v23 (Mode B cleanup) runs, the staging tables are
      // dropped — the post-v23 fresh-DB invariant is covered by the
      // v23 describe block below.
      const db = new Database(':memory:');
      try {
        // Bootstrap _migrations to satisfy applyMigrationsThrough's
        // initial SELECT.
        db.exec(`
          CREATE TABLE IF NOT EXISTS _migrations (
            version INTEGER PRIMARY KEY,
            name    TEXT NOT NULL,
            applied_at INTEGER NOT NULL
          );
        `);
        applyMigrationsThrough(db, 22);

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

  describe('migration v23 (Mode B cleanup of v21 adoption bridge)', () => {
    it('drops empty staging tables on a post-v22 fresh DB', () => {
      // Fresh install path through the whole chain. v21 created the
      // four `legacy_*_v21` staging tables (CREATE TABLE always
      // runs); v23's precondition saw zero rows in each, so its `up`
      // legitimately DROPped them. End state: no staging, FK clean.
      const db = new Database(':memory:');
      try {
        runMigrations(db);
        expect(
          db.prepare(`SELECT version FROM _migrations WHERE version = 23`).get(),
        ).toBeDefined();
        for (const t of [
          'legacy_message_from_user_v21',
          'legacy_message_task_assignee_user_v21',
          'legacy_conversation_reads_v21',
          'legacy_user_attachments_v21',
        ]) {
          expect(
            db
              .prepare(
                `SELECT name FROM sqlite_schema WHERE type='table' AND name = ?`,
              )
              .get(t),
          ).toBeUndefined();
        }
        expect(db.pragma('foreign_key_check')).toEqual([]);
      } finally {
        db.close();
      }
    });

    it('refuses to run when staging tables still hold unadopted rows', () => {
      // Simulated pre-v21 backup that was never registered: v21 ran
      // and staged rows, but no `POST /api/register` adoption ran. v23
      // refuses with a clear "register first on a build that still has
      // Deferred Adoption" error so the operator does not lose data.
      const db = new Database(':memory:');
      try {
        db.exec(`
          CREATE TABLE IF NOT EXISTS _migrations (
            version INTEGER PRIMARY KEY,
            name    TEXT NOT NULL,
            applied_at INTEGER NOT NULL
          );
        `);
        applyMigrationsThrough(db, 22);
        // Inject one staged row to simulate unadopted legacy data.
        db.exec(`
          INSERT INTO legacy_message_from_user_v21 (message_id)
          VALUES ('msg_legacy_unadopted');
        `);

        // Sanity: staging is non-empty after seed.
        const fromUserCount = db
          .prepare<[], { c: number }>(
            `SELECT COUNT(*) AS c FROM legacy_message_from_user_v21`,
          )
          .get();
        expect(fromUserCount?.c).toBe(1);

        // v23 must throw, leaving _migrations.version=23 unwritten.
        expect(() => runMigrations(db)).toThrow(
          /v23 cleanup: legacy_\*_v21 staging tables still hold unadopted/,
        );
        expect(
          db.prepare(`SELECT version FROM _migrations WHERE version = 23`).get(),
        ).toBeUndefined();

        // Staging tables remain — data is preserved for the operator
        // to recover via an older build that still has Deferred
        // Adoption.
        expect(
          db
            .prepare(
              `SELECT name FROM sqlite_schema WHERE type='table'
                AND name = 'legacy_message_from_user_v21'`,
            )
            .get(),
        ).toBeDefined();
        expect(
          db
            .prepare<[], { c: number }>(
              `SELECT COUNT(*) AS c FROM legacy_message_from_user_v21`,
            )
            .get()?.c,
        ).toBe(1);
      } finally {
        db.close();
      }
    });

    it('is idempotent on a post-adoption DB (staging already dropped)', () => {
      // Simulated post-register state: staging tables were DROPped at
      // registration time on an older Deferred-Adoption build. v23
      // sees no staging, no FK issues, and applies as a no-op.
      const db = new Database(':memory:');
      try {
        db.exec(`
          CREATE TABLE IF NOT EXISTS _migrations (
            version INTEGER PRIMARY KEY,
            name    TEXT NOT NULL,
            applied_at INTEGER NOT NULL
          );
        `);
        applyMigrationsThrough(db, 22);
        for (const t of [
          'legacy_message_from_user_v21',
          'legacy_message_task_assignee_user_v21',
          'legacy_conversation_reads_v21',
          'legacy_user_attachments_v21',
        ]) {
          db.exec(`DROP TABLE IF EXISTS ${t};`);
        }

        runMigrations(db);
        expect(
          db.prepare(`SELECT version FROM _migrations WHERE version = 23`).get(),
        ).toBeDefined();
        expect(db.pragma('foreign_key_check')).toEqual([]);
      } finally {
        db.close();
      }
    });
  });

  describe('migration v24 (legacy v21 audit settings cleanup)', () => {
    it('removes only the retired adoption audit keys from app_settings', () => {
      const db = new Database(':memory:');
      try {
        db.exec(`
          CREATE TABLE IF NOT EXISTS _migrations (
            version INTEGER PRIMARY KEY,
            name    TEXT NOT NULL,
            applied_at INTEGER NOT NULL
          );
        `);
        applyMigrationsThrough(db, 23);
        db.exec(`
          INSERT INTO app_settings (key, value) VALUES
            ('viewer_user_id', 'viewer_1'),
            ('legacy_v21_adoption_completed_at', '1778956750799'),
            (
              'legacy_v21_adoption_counts',
              '{"messages_from":1019,"messages_task":0,"conversation_reads":71,"attachments":12}'
            );
        `);

        runMigrations(db);

        expect(
          db.prepare(`SELECT version FROM _migrations WHERE version = 24`).get(),
        ).toBeDefined();
        expect(
          db
            .prepare(
              `SELECT key FROM app_settings
                WHERE key IN (
                  'legacy_v21_adoption_completed_at',
                  'legacy_v21_adoption_counts'
                )`,
            )
            .all(),
        ).toEqual([]);
        expect(
          db
            .prepare<[], { value: string }>(
              `SELECT value FROM app_settings WHERE key = 'viewer_user_id'`,
            )
            .get()?.value,
        ).toBe('viewer_1');
      } finally {
        db.close();
      }
    });
  });

  describe('migration v25 (human workspace and conversation membership)', () => {
    it('creates membership tables and backfills the registered viewer into existing rows', () => {
      const db = new Database(':memory:');
      try {
        db.exec(`
          CREATE TABLE IF NOT EXISTS _migrations (
            version INTEGER PRIMARY KEY,
            name    TEXT NOT NULL,
            applied_at INTEGER NOT NULL
          );
        `);
        applyMigrationsThrough(db, 24);

        // Pre-v25 state: a registered viewer plus a workspace and a
        // conversation row. v25 must backfill membership for both.
        const now = 1_700_000_000_000;
        db.prepare(
          `INSERT INTO users (id, name, display_name, created_at, updated_at)
           VALUES ('viewer_1', 'viewer-test', 'Viewer Test', ?, ?)`,
        ).run(now, now);
        db.prepare(
          `INSERT INTO app_settings (key, value)
             VALUES ('viewer_user_id', 'viewer_1')`,
        ).run();
        db.prepare(
          `INSERT INTO hosts (id, name, kind, created_at)
             VALUES ('h1', 'local', 'local', ?)`,
        ).run(now);
        db.prepare(
          `INSERT INTO workspaces
             (id, name, description, workspace_path, workspace_kind,
              workspace_host_id, owner_agent_id, created_at, updated_at)
           VALUES ('ws1', 'pre-v25', NULL, '/tmp/x', 'regular', 'h1', NULL, ?, ?)`,
        ).run(now, now);
        db.prepare(
          `INSERT INTO conversations
             (id, workspace_id, kind, title, workspace_path, status,
              created_at, updated_at)
           VALUES ('c1', 'ws1', 'channel', 'main', '/tmp/x', 'open', ?, ?)`,
        ).run(now, now);

        runMigrations(db);

        expect(
          db.prepare(`SELECT version FROM _migrations WHERE version = 25`).get(),
        ).toBeDefined();

        const wsRow = db
          .prepare<[], { workspace_id: string; user_id: string; joined_at: number }>(
            `SELECT workspace_id, user_id, joined_at FROM workspace_users`,
          )
          .all();
        expect(wsRow).toEqual([
          { workspace_id: 'ws1', user_id: 'viewer_1', joined_at: now },
        ]);
        const convRow = db
          .prepare<[], { conversation_id: string; user_id: string; joined_at: number }>(
            `SELECT conversation_id, user_id, joined_at FROM conversation_users`,
          )
          .all();
        expect(convRow).toEqual([
          { conversation_id: 'c1', user_id: 'viewer_1', joined_at: now },
        ]);
      } finally {
        db.close();
      }
    });

    it('is a no-op backfill on pre-registration databases', () => {
      const db = new Database(':memory:');
      try {
        // Run all migrations on a virgin DB (no viewer_user_id, no
        // users row). v25 must create the membership tables but write
        // zero rows because the viewer subquery returns NULL.
        runMigrations(db);

        expect(
          db.prepare(`SELECT version FROM _migrations WHERE version = 25`).get(),
        ).toBeDefined();
        expect(
          (db.prepare(`SELECT COUNT(*) AS n FROM workspace_users`).get() as { n: number }).n,
        ).toBe(0);
        expect(
          (db.prepare(`SELECT COUNT(*) AS n FROM conversation_users`).get() as { n: number }).n,
        ).toBe(0);
      } finally {
        db.close();
      }
    });

    it('cascades membership rows when a workspace or conversation is deleted', () => {
      const db = new Database(':memory:');
      try {
        runMigrations(db);
        const now = Date.now();
        db.prepare(
          `INSERT INTO users (id, name, display_name, created_at, updated_at)
             VALUES ('u1', 'u1-test', 'U1', ?, ?)`,
        ).run(now, now);
        db.prepare(
          `INSERT INTO hosts (id, name, kind, created_at)
             VALUES ('h1', 'local', 'local', ?)`,
        ).run(now);
        db.prepare(
          `INSERT INTO workspaces
             (id, name, description, workspace_path, workspace_kind,
              workspace_host_id, owner_agent_id, created_at, updated_at)
           VALUES ('ws1', 'w', NULL, '/tmp/y', 'regular', 'h1', NULL, ?, ?)`,
        ).run(now, now);
        db.prepare(
          `INSERT INTO conversations
             (id, workspace_id, kind, title, workspace_path, status,
              created_at, updated_at)
           VALUES ('c1', 'ws1', 'channel', 't', '/tmp/y', 'open', ?, ?)`,
        ).run(now, now);
        db.prepare(
          `INSERT INTO workspace_users (workspace_id, user_id, joined_at)
             VALUES ('ws1', 'u1', ?)`,
        ).run(now);
        db.prepare(
          `INSERT INTO conversation_users (conversation_id, user_id, joined_at)
             VALUES ('c1', 'u1', ?)`,
        ).run(now);

        db.prepare(`DELETE FROM conversations WHERE id = ?`).run('c1');
        expect(
          (db.prepare(`SELECT COUNT(*) AS n FROM conversation_users`).get() as { n: number }).n,
        ).toBe(0);

        db.prepare(`DELETE FROM workspaces WHERE id = ?`).run('ws1');
        expect(
          (db.prepare(`SELECT COUNT(*) AS n FROM workspace_users`).get() as { n: number }).n,
        ).toBe(0);
      } finally {
        db.close();
      }
    });
  });

  describe('migration v26 (agent creator + avatar)', () => {
    it('backfills created_by_user_id from app_settings.viewer_user_id for existing agents', () => {
      const db = new Database(':memory:');
      try {
        db.exec(`
          CREATE TABLE IF NOT EXISTS _migrations (
            version INTEGER PRIMARY KEY,
            name    TEXT NOT NULL,
            applied_at INTEGER NOT NULL
          );
        `);
        applyMigrationsThrough(db, 25);

        // Pre-v26 state: a registered viewer + an existing agent. v26
        // must backfill created_by_user_id to the viewer.
        const now = 1_700_000_000_000;
        db.prepare(
          `INSERT INTO users (id, name, display_name, created_at, updated_at)
             VALUES ('viewer_1', 'shiki', 'Shiki', ?, ?)`,
        ).run(now, now);
        db.prepare(
          `INSERT INTO app_settings (key, value)
             VALUES ('viewer_user_id', 'viewer_1')`,
        ).run();
        db.prepare(
          `INSERT INTO hosts (id, name, kind, created_at)
             VALUES ('h1', 'local', 'local', ?)`,
        ).run(now);
        db.prepare(
          `INSERT INTO agents
             (id, name, runtime, model, host_id, description,
              created_at, updated_at, display_name, reasoning_effort, fast_mode)
           VALUES ('a1', 'alice', 'claude', NULL, 'h1', NULL, ?, ?, 'Alice', NULL, NULL)`,
        ).run(now, now);

        runMigrations(db);

        expect(
          db.prepare(`SELECT version FROM _migrations WHERE version = 26`).get(),
        ).toBeDefined();

        const row = db
          .prepare<[], {
            created_by_user_id: string;
            avatar_storage_key: string | null;
            avatar_content_type: string | null;
          }>(
            `SELECT created_by_user_id, avatar_storage_key, avatar_content_type
               FROM agents WHERE id = 'a1'`,
          )
          .get();
        expect(row).toEqual({
          created_by_user_id: 'viewer_1',
          avatar_storage_key: null,
          avatar_content_type: null,
        });
      } finally {
        db.close();
      }
    });

    it('is a no-op on empty pre-registration DBs (no agents → no NOT NULL violation)', () => {
      const db = new Database(':memory:');
      try {
        // Virgin DB: no users row, no viewer_user_id, no agents. v26 must
        // succeed because zero-row INSERT-SELECT short-circuits without
        // dereferencing the (NULL) viewer subquery.
        runMigrations(db);

        expect(
          db.prepare(`SELECT version FROM _migrations WHERE version = 26`).get(),
        ).toBeDefined();
        expect(
          (db.prepare(`SELECT COUNT(*) AS n FROM agents`).get() as { n: number }).n,
        ).toBe(0);

        // The new shape is in place (FK + CHECK pair).
        const cols = (db.pragma('table_info(agents)') as Array<{
          name: string;
          notnull: number;
        }>).reduce<Record<string, { notnull: number }>>((acc, c) => {
          acc[c.name] = { notnull: c.notnull };
          return acc;
        }, {});
        expect(cols.created_by_user_id?.notnull).toBe(1);
        expect(cols.avatar_storage_key?.notnull).toBe(0);
        expect(cols.avatar_content_type?.notnull).toBe(0);

        const fk = (db.pragma('foreign_key_list(agents)') as Array<{
          table: string;
          from: string;
          on_delete: string;
        }>).find(f => f.from === 'created_by_user_id');
        expect(fk?.table).toBe('users');
        expect(fk?.on_delete).toBe('RESTRICT');
      } finally {
        db.close();
      }
    });

    it('aborts loudly when pre-registration DB has agents but no viewer_user_id (impossible in production)', () => {
      const db = new Database(':memory:');
      try {
        db.exec(`
          CREATE TABLE IF NOT EXISTS _migrations (
            version INTEGER PRIMARY KEY,
            name    TEXT NOT NULL,
            applied_at INTEGER NOT NULL
          );
        `);
        applyMigrationsThrough(db, 25);

        // Corrupt pre-condition: agent rows exist but no viewer pointer.
        // (Production cannot reach this — the create route is user-gated —
        // but the migration must NOT silently succeed if it does.)
        const now = 1_700_000_000_000;
        db.prepare(
          `INSERT INTO hosts (id, name, kind, created_at)
             VALUES ('h1', 'local', 'local', ?)`,
        ).run(now);
        db.prepare(
          `INSERT INTO agents
             (id, name, runtime, model, host_id, description,
              created_at, updated_at, display_name, reasoning_effort, fast_mode)
           VALUES ('a1', 'alice', 'claude', NULL, 'h1', NULL, ?, ?, 'Alice', NULL, NULL)`,
        ).run(now, now);

        expect(() => runMigrations(db)).toThrow(/NOT NULL/i);
      } finally {
        db.close();
      }
    });

    it('leaves no agents_legacy_v26 drift behind', () => {
      const db = new Database(':memory:');
      try {
        runMigrations(db);
        const tables = db
          .prepare<[], { name: string }>(
            `SELECT name FROM sqlite_schema WHERE type = 'table'`,
          )
          .all()
          .map(r => r.name);
        expect(tables).toContain('agents');
        expect(tables).not.toContain('agents_legacy_v26');
      } finally {
        db.close();
      }
    });

    it('preserves the v21 trigger surface verbatim across the rebuild', () => {
      const db = new Database(':memory:');
      try {
        runMigrations(db);
        const triggers = db
          .prepare<[], { name: string }>(
            `SELECT name FROM sqlite_schema WHERE type = 'trigger' ORDER BY name`,
          )
          .all()
          .map(r => r.name);
        expect(triggers).toEqual(
          expect.arrayContaining([
            'attachments_created_by_validate_insert',
            'attachments_created_by_validate_update',
            'users_name_unique_against_agents_insert',
            'users_name_unique_against_agents_update',
            'agents_name_unique_against_users_insert',
            'agents_name_unique_against_users_update',
          ]),
        );
      } finally {
        db.close();
      }
    });

    it('user/agent name collision triggers still fire after the rebuild (both directions)', () => {
      const db = new Database(':memory:');
      try {
        runMigrations(db);
        const now = Date.now();
        db.prepare(
          `INSERT INTO hosts (id, name, kind, created_at)
             VALUES ('h1', 'local', 'local', ?)`,
        ).run(now);
        db.prepare(
          `INSERT INTO users (id, name, display_name, created_at, updated_at)
             VALUES ('u1', 'shiki', 'Shiki', ?, ?)`,
        ).run(now, now);
        db.prepare(
          `INSERT INTO agents
             (id, name, runtime, model, host_id, description,
              created_at, updated_at, display_name, reasoning_effort, fast_mode,
              created_by_user_id)
           VALUES ('a1', 'alice', 'claude', NULL, 'h1', NULL, ?, ?,
                   'Alice', NULL, NULL, 'u1')`,
        ).run(now, now);

        // user→agent direction (insert + update).
        expect(() =>
          db
            .prepare(
              `INSERT INTO users (id, name, display_name, created_at, updated_at)
                 VALUES ('u-clash', 'alice', 'Bob', ?, ?)`,
            )
            .run(now, now),
        ).toThrow(/collides with an existing agent name/);
        db.prepare(
          `INSERT INTO users (id, name, display_name, created_at, updated_at)
             VALUES ('u-bob', 'bob', 'Bob', ?, ?)`,
        ).run(now, now);
        expect(() =>
          db.prepare(`UPDATE users SET name = 'alice' WHERE id = 'u-bob'`).run(),
        ).toThrow(/collides with an existing agent name/);

        // agent→user direction (insert + update).
        expect(() =>
          db
            .prepare(
              `INSERT INTO agents
                 (id, name, runtime, model, host_id, description,
                  created_at, updated_at, display_name, reasoning_effort, fast_mode,
                  created_by_user_id)
               VALUES ('a-clash', 'shiki', 'claude', NULL, 'h1', NULL, ?, ?,
                       'Clash', NULL, NULL, 'u1')`,
            )
            .run(now, now),
        ).toThrow(/collides with an existing user name/);
        expect(() =>
          db.prepare(`UPDATE agents SET name = 'shiki' WHERE id = 'a1'`).run(),
        ).toThrow(/collides with an existing user name/);
      } finally {
        db.close();
      }
    });

    it('attachments dispatch trigger still rejects orphan owner ids after the rebuild', () => {
      const db = new Database(':memory:');
      try {
        runMigrations(db);
        const now = Date.now();
        db.prepare(
          `INSERT INTO hosts (id, name, kind, created_at)
             VALUES ('h1', 'local', 'local', ?)`,
        ).run(now);
        db.prepare(
          `INSERT INTO users (id, name, display_name, created_at, updated_at)
             VALUES ('u1', 'shiki', 'Shiki', ?, ?)`,
        ).run(now, now);
        db.prepare(
          `INSERT INTO agents
             (id, name, runtime, model, host_id, description,
              created_at, updated_at, display_name, reasoning_effort, fast_mode,
              created_by_user_id)
           VALUES ('a1', 'alice', 'claude', NULL, 'h1', NULL, ?, ?,
                   'Alice', NULL, NULL, 'u1')`,
        ).run(now, now);
        db.prepare(
          `INSERT INTO workspaces
             (id, name, description, workspace_kind, workspace_path, workspace_host_id,
              owner_agent_id, archived_at, pinned_at, created_at, updated_at)
           VALUES ('ws1', 'main', NULL, 'regular', '/tmp/ws1', 'h1', NULL, NULL, NULL, ?, ?)`,
        ).run(now, now);
        db.prepare(
          `INSERT INTO conversations
             (id, workspace_id, workspace_path, kind, parent_conversation_id, title,
              status, spawned_by_agent_id, closed_at, close_summary, pinned_at,
              archived_at, created_at, updated_at)
           VALUES ('c1', 'ws1', '/tmp/ws1', 'channel', NULL, 'general',
                   'idle', NULL, NULL, NULL, NULL, NULL, ?, ?)`,
        ).run(now, now);

        // kind='user' with unknown id rejected.
        expect(() =>
          db
            .prepare(
              `INSERT INTO attachments
                 (id, channel_id, source_conversation_id, filename, size,
                  content_type, storage, storage_key, created_by_kind,
                  created_by_id, created_at)
               VALUES ('att_u', 'c1', 'c1', 'x.png', 1,
                       'image/png', 'local', 'attachments/x.png',
                       'user', 'u-missing', ?)`,
            )
            .run(now),
        ).toThrow(/created_by_id \(kind=user\)/);

        // kind='agent' with unknown id rejected.
        expect(() =>
          db
            .prepare(
              `INSERT INTO attachments
                 (id, channel_id, source_conversation_id, filename, size,
                  content_type, storage, storage_key, created_by_kind,
                  created_by_id, created_at)
               VALUES ('att_a', 'c1', 'c1', 'x.png', 1,
                       'image/png', 'local', 'attachments/x.png',
                       'agent', 'a-missing', ?)`,
            )
            .run(now),
        ).toThrow(/created_by_id \(kind=agent\)/);
      } finally {
        db.close();
      }
    });

    it('blocks DELETE on the creator user via ON DELETE RESTRICT', () => {
      const db = new Database(':memory:');
      try {
        runMigrations(db);
        const now = Date.now();
        db.prepare(
          `INSERT INTO hosts (id, name, kind, created_at)
             VALUES ('h1', 'local', 'local', ?)`,
        ).run(now);
        db.prepare(
          `INSERT INTO users (id, name, display_name, created_at, updated_at)
             VALUES ('u1', 'shiki', 'Shiki', ?, ?)`,
        ).run(now, now);
        db.prepare(
          `INSERT INTO agents
             (id, name, runtime, model, host_id, description,
              created_at, updated_at, display_name, reasoning_effort, fast_mode,
              created_by_user_id)
           VALUES ('a1', 'alice', 'claude', NULL, 'h1', NULL, ?, ?,
                   'Alice', NULL, NULL, 'u1')`,
        ).run(now, now);

        expect(() =>
          db.prepare(`DELETE FROM users WHERE id = 'u1'`).run(),
        ).toThrow(/FOREIGN KEY/);
      } finally {
        db.close();
      }
    });

    it('CHECK pair rejects half-set avatar columns', () => {
      const db = new Database(':memory:');
      try {
        runMigrations(db);
        const now = Date.now();
        db.prepare(
          `INSERT INTO hosts (id, name, kind, created_at)
             VALUES ('h1', 'local', 'local', ?)`,
        ).run(now);
        db.prepare(
          `INSERT INTO users (id, name, display_name, created_at, updated_at)
             VALUES ('u1', 'shiki', 'Shiki', ?, ?)`,
        ).run(now, now);
        db.prepare(
          `INSERT INTO agents
             (id, name, runtime, model, host_id, description,
              created_at, updated_at, display_name, reasoning_effort, fast_mode,
              created_by_user_id, avatar_storage_key, avatar_content_type)
           VALUES ('a1', 'alice', 'claude', NULL, 'h1', NULL, ?, ?,
                   'Alice', NULL, NULL, 'u1', NULL, NULL)`,
        ).run(now, now);

        // storage_key set but content_type null → CHECK violation.
        expect(() =>
          db
            .prepare(
              `UPDATE agents
                  SET avatar_storage_key = 'avatars/agent_a1.png',
                      avatar_content_type = NULL
                WHERE id = 'a1'`,
            )
            .run(),
        ).toThrow(/CHECK/);

        // content_type set but storage_key null → CHECK violation.
        expect(() =>
          db
            .prepare(
              `UPDATE agents
                  SET avatar_storage_key = NULL,
                      avatar_content_type = 'image/png'
                WHERE id = 'a1'`,
            )
            .run(),
        ).toThrow(/CHECK/);

        // Both set → ok.
        db.prepare(
          `UPDATE agents
              SET avatar_storage_key = 'avatars/agent_a1.png',
                  avatar_content_type = 'image/png'
            WHERE id = 'a1'`,
        ).run();
      } finally {
        db.close();
      }
    });
  });

  describe('migration v27 (schedule titles)', () => {
    it('adds title without deriving pseudo-titles from historical message', () => {
      const db = new Database(':memory:');
      try {
        db.exec(`
          CREATE TABLE IF NOT EXISTS _migrations (
            version INTEGER PRIMARY KEY,
            name    TEXT NOT NULL,
            applied_at INTEGER NOT NULL
          );
        `);
        applyMigrationsThrough(db, 25);

        const now = 1_700_000_000_000;
        db.prepare(
          `INSERT INTO users (id, name, display_name, created_at, updated_at)
             VALUES ('viewer_1', 'shiki', 'Shiki', ?, ?)`,
        ).run(now, now);
        db.prepare(
          `INSERT INTO app_settings (key, value)
             VALUES ('viewer_user_id', 'viewer_1')`,
        ).run();
        db.prepare(
          `INSERT INTO hosts (id, name, kind, created_at)
             VALUES ('h1', 'local', 'local', ?)`,
        ).run(now);
        db.prepare(
          `INSERT INTO agents
             (id, name, runtime, model, host_id, description,
              created_at, updated_at, display_name, reasoning_effort, fast_mode)
           VALUES ('a1', 'alice', 'claude', NULL, 'h1', NULL, ?, ?, 'Alice', NULL, NULL)`,
        ).run(now, now);
        db.prepare(
          `INSERT INTO schedules
             (id, owner_agent_id, message, spec_json, next_fire_at, status,
              fired_count, created_at, updated_at)
           VALUES ('s1', 'a1', 'review deploy status', '{"kind":"once","fire_at":1}',
                   1, 'pending', 0, ?, ?)`,
        ).run(now, now);

        runMigrations(db);

        expect(
          db.prepare(`SELECT version FROM _migrations WHERE version = 27`).get(),
        ).toBeDefined();
        const row = db
          .prepare<[], { title: string }>(
            `SELECT title FROM schedules WHERE id = 's1'`,
          )
          .get();
        expect(row?.title).toBe('');
      } finally {
        db.close();
      }
    });
  });

  describe('migration v28 (schedule target_conversation_id)', () => {
    it('adds NOT NULL target_conversation_id and backfills existing rows from owner agent_home DM', () => {
      // Lock the v28 backfill contract: rows that pre-date the column
      // get their `target_conversation_id` populated from the owner's
      // agent_home DM, preserving the legacy hardcoded fire target.
      // After v28 the service no longer reads `agent_home` at fire
      // time — the column is the single source of truth.
      const db = new Database(':memory:');
      try {
        db.exec(`
          CREATE TABLE IF NOT EXISTS _migrations (
            version INTEGER PRIMARY KEY,
            name    TEXT NOT NULL,
            applied_at INTEGER NOT NULL
          );
        `);
        applyMigrationsThrough(db, 27);

        const now = 1_700_000_000_000;
        db.prepare(
          `INSERT INTO users (id, name, display_name, created_at, updated_at)
             VALUES ('viewer_1', 'shiki', 'Shiki', ?, ?)`,
        ).run(now, now);
        db.prepare(
          `INSERT INTO app_settings (key, value)
             VALUES ('viewer_user_id', 'viewer_1')`,
        ).run();
        db.prepare(
          `INSERT INTO hosts (id, name, kind, created_at)
             VALUES ('h1', 'local', 'local', ?)`,
        ).run(now);
        db.prepare(
          `INSERT INTO agents
             (id, name, runtime, model, host_id, description,
              created_at, updated_at, display_name, reasoning_effort, fast_mode,
              created_by_user_id)
           VALUES ('a1', 'alice', 'claude', NULL, 'h1', NULL, ?, ?, 'Alice', NULL, NULL,
                   'viewer_1')`,
        ).run(now, now);
        // Owner's agent_home + DM (the legacy fire target).
        db.prepare(
          `INSERT INTO workspaces
             (id, name, description, workspace_kind, workspace_path,
              workspace_host_id, owner_agent_id, archived_at, created_at, updated_at)
           VALUES ('ws_home', 'alice', NULL, 'agent_home',
                   '/tmp/alice-home', 'h1', 'a1', NULL, ?, ?)`,
        ).run(now, now);
        db.prepare(
          `INSERT INTO conversations
             (id, workspace_id, workspace_path, kind, parent_conversation_id,
              title, status, spawned_by_agent_id, closed_at, close_summary,
              pinned_at, archived_at, created_at, updated_at)
           VALUES ('conv_dm', 'ws_home', '/tmp/alice-home', 'dm_channel',
                   NULL, 'dm-alice', 'active', NULL, NULL, NULL, NULL, NULL, ?, ?)`,
        ).run(now, now);
        // Pre-existing schedule with no target_conversation_id (column
        // didn't exist in v27).
        db.prepare(
          `INSERT INTO schedules
             (id, owner_agent_id, title, message, spec_json, next_fire_at, status,
              fired_count, created_at, updated_at)
           VALUES ('s1', 'a1', 'Daily review',
                   'review deploy status', '{"kind":"once","fire_at":1}',
                   1, 'pending', 0, ?, ?)`,
        ).run(now, now);

        runMigrations(db);

        expect(
          db.prepare(`SELECT version FROM _migrations WHERE version = 28`).get(),
        ).toBeDefined();
        // Backfilled to the owner's agent_home DM.
        const row = db
          .prepare<[], { target_conversation_id: string }>(
            `SELECT target_conversation_id FROM schedules WHERE id = 's1'`,
          )
          .get();
        expect(row?.target_conversation_id).toBe('conv_dm');
        // Index exists for fast scheduler-side lookups by target.
        const idx = db
          .prepare<[], { name: string }>(
            `SELECT name FROM sqlite_master
              WHERE type = 'index' AND name = 'idx_schedules_target'`,
          )
          .get();
        expect(idx?.name).toBe('idx_schedules_target');
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

  describe('migration v29 (user auth credentials)', () => {
    it('adds nullable unique-when-set email plus password credentials and auth sessions', () => {
      const db = openDbAt(28);
      try {
        runMigrations(db);

        expect(
          db.prepare(`SELECT version FROM _migrations WHERE version = 29`).get(),
        ).toBeDefined();

        const userColumns = (
          db.pragma('table_info(users)') as Array<{ name: string; notnull: 0 | 1 }>
        ).map(c => ({ name: c.name, notnull: c.notnull }));
        expect(userColumns).toContainEqual({ name: 'email', notnull: 0 });

        const now = Date.now();
        db.prepare(
          `INSERT INTO users (id, name, display_name, created_at, updated_at)
           VALUES ('u1', 'u1-test', 'U1', ?, ?)`,
        ).run(now, now);
        db.prepare(
          `INSERT INTO users (id, name, display_name, created_at, updated_at)
           VALUES ('u2', 'u2-test', 'U2', ?, ?)`,
        ).run(now, now);

        db.prepare(`UPDATE users SET email = 'User@Example.com' WHERE id = 'u1'`).run();
        expect(() =>
          db.prepare(`UPDATE users SET email = 'user@example.com' WHERE id = 'u2'`).run(),
        ).toThrow(/UNIQUE constraint failed/);

        db.prepare(
          `INSERT INTO user_password_credentials
             (user_id, password_hash, password_hash_params, password_updated_at)
           VALUES ('u1', '$argon2id$v=19$m=1,t=1,p=1$fake$fake',
                   '{"algorithm":"argon2id"}', ?)`,
        ).run(now);
        expect(() =>
          db.prepare(
            `INSERT INTO user_password_credentials
               (user_id, password_hash, password_hash_params, password_updated_at)
             VALUES ('u2', 'hash', 'not-json', ?)`,
          ).run(now),
        ).toThrow(/CHECK constraint failed/);

        db.prepare(
          `INSERT INTO auth_sessions
             (id, user_id, token_hash, created_at, last_used_at, revoked_at,
              user_agent, ip_first_seen)
           VALUES ('s1', 'u1', 'token-hash', ?, ?, NULL, 'vitest', '127.0.0.1')`,
        ).run(now, now);

        db.prepare(`DELETE FROM users WHERE id = 'u1'`).run();
        expect(
          db
            .prepare(`SELECT COUNT(*) AS c FROM user_password_credentials`)
            .get(),
        ).toEqual({ c: 0 });
        expect(
          db.prepare(`SELECT COUNT(*) AS c FROM auth_sessions`).get(),
        ).toEqual({ c: 0 });
      } finally {
        db.close();
      }
    });
  });

  describe('migration v30 (host identity credentials)', () => {
    it('adds host owner fields and host credential storage', () => {
      const db = openDbAt(29);
      try {
        const now = Date.now();
        db.prepare(
          `INSERT INTO hosts (id, name, kind, created_at)
           VALUES ('legacy-local', 'local', 'local', ?)`,
        ).run(now);

        runMigrations(db);

        expect(
          db.prepare(`SELECT version FROM _migrations WHERE version = 30`).get(),
        ).toBeDefined();

        const hostColumns = (
          db.pragma('table_info(hosts)') as Array<{ name: string; notnull: 0 | 1 }>
        ).map(c => ({ name: c.name, notnull: c.notnull }));
        expect(hostColumns).toContainEqual({ name: 'user_id', notnull: 0 });
        expect(hostColumns).toContainEqual({ name: 'installation_id', notnull: 0 });
        expect(hostColumns).toContainEqual({ name: 'last_seen_at', notnull: 0 });
        expect(hostColumns).toContainEqual({ name: 'revoked_at', notnull: 0 });

        expect(
          db
            .prepare(
              `SELECT user_id, installation_id, last_seen_at, revoked_at
                 FROM hosts
                WHERE id = 'legacy-local'`,
            )
            .get(),
        ).toEqual({
          user_id: null,
          installation_id: null,
          last_seen_at: null,
          revoked_at: null,
        });

        db.prepare(
          `INSERT INTO users (id, name, display_name, created_at, updated_at)
           VALUES ('u1', 'u1-test', 'U1', ?, ?)`,
        ).run(now, now);
        db.prepare(
          `INSERT INTO users (id, name, display_name, created_at, updated_at)
           VALUES ('u2', 'u2-test', 'U2', ?, ?)`,
        ).run(now, now);

        db.prepare(
          `INSERT INTO hosts
             (id, name, kind, user_id, installation_id, last_seen_at, created_at)
           VALUES ('owned-1', 'owned-1', 'local', 'u1', 'install-1', ?, ?)`,
        ).run(now, now);
        expect(() =>
          db.prepare(
            `INSERT INTO hosts
               (id, name, kind, user_id, installation_id, created_at)
             VALUES ('owned-dup', 'owned-dup', 'local', 'u1', 'install-1', ?)`,
          ).run(now),
        ).toThrow(/UNIQUE constraint failed/);
        db.prepare(
          `INSERT INTO hosts
             (id, name, kind, user_id, installation_id, created_at)
           VALUES ('owned-2', 'owned-2', 'local', 'u2', 'install-1', ?)`,
        ).run(now);

        db.prepare(
          `INSERT INTO host_credentials
             (id, host_id, token_hash, kind, expires_at, consumed_at, revoked_at)
           VALUES ('hc1', 'owned-1', 'hash-1', 'long_lived', NULL, NULL, NULL)`,
        ).run();
        db.prepare(
          `INSERT INTO host_credentials
             (id, host_id, token_hash, kind, expires_at, consumed_at, revoked_at)
           VALUES ('hc2', 'owned-1', 'hash-2', 'bootstrap', ?, NULL, NULL)`,
        ).run(now + 60_000);
        expect(() =>
          db.prepare(
            `INSERT INTO host_credentials
               (id, host_id, token_hash, kind, expires_at, consumed_at, revoked_at)
             VALUES ('hc3', 'owned-1', 'hash-3', 'other', NULL, NULL, NULL)`,
          ).run(),
        ).toThrow(/CHECK constraint failed/);
        expect(() =>
          db.prepare(
            `INSERT INTO host_credentials
               (id, host_id, token_hash, kind, expires_at, consumed_at, revoked_at)
             VALUES ('hc4', 'owned-1', 'hash-1', 'long_lived', NULL, NULL, NULL)`,
          ).run(),
        ).toThrow(/UNIQUE constraint failed/);

        db.prepare(`DELETE FROM hosts WHERE id = 'owned-1'`).run();
        expect(
          db
            .prepare(`SELECT COUNT(*) AS c FROM host_credentials WHERE host_id = 'owned-1'`)
            .get(),
        ).toEqual({ c: 0 });
      } finally {
        db.close();
      }
    });
  });

  describe('B.3 runtime host placement schema boundary', () => {
    it('does not add a runtime_host_id column to conversation_agents', () => {
      const db = openDbAt(30);
      try {
        const columnNames = (
          db.pragma('table_info(conversation_agents)') as Array<{ name: string }>
        ).map(c => c.name);
        expect(columnNames).not.toContain('runtime_host_id');
      } finally {
        db.close();
      }
    });
  });

  describe('migration v31 (active-only host installation UNIQUE)', () => {
    it('replaces the v30 unique index with an active-only variant so revoked rows do not block re-claim', () => {
      const db = openDbAt(30);
      try {
        // Pre-state: v30 index name present.
        const indexNamesAt30 = (
          db
            .prepare<[], { name: string }>(
              `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'hosts'`,
            )
            .all() as Array<{ name: string }>
        ).map(r => r.name);
        expect(indexNamesAt30).toContain('uniq_hosts_user_installation_when_set');
        expect(indexNamesAt30).not.toContain(
          'uniq_hosts_user_installation_when_active',
        );

        // Seed a user + a revoked host occupying the (user, installation)
        // pair. Under v30 a second active row with the same pair would
        // violate the partial UNIQUE.
        const now = Date.now();
        db.prepare(
          `INSERT INTO users (id, name, display_name, created_at, updated_at)
           VALUES ('u1', 'u1-test', 'U1', ?, ?)`,
        ).run(now, now);
        db.prepare(
          `INSERT INTO hosts
             (id, name, kind, user_id, installation_id, revoked_at, created_at)
           VALUES ('h-revoked', 'h-revoked', 'local', 'u1', 'inst-1', ?, ?)`,
        ).run(now - 1000, now - 2000);

        // Apply v31.
        runMigrations(db);
        expect(
          db.prepare(`SELECT version FROM _migrations WHERE version = 31`).get(),
        ).toBeDefined();

        const indexNamesAt31 = (
          db
            .prepare<[], { name: string }>(
              `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'hosts'`,
            )
            .all() as Array<{ name: string }>
        ).map(r => r.name);
        expect(indexNamesAt31).not.toContain('uniq_hosts_user_installation_when_set');
        expect(indexNamesAt31).toContain('uniq_hosts_user_installation_when_active');

        // Now a fresh active row with the SAME (user_id, installation_id)
        // is allowed, because the partial predicate excludes the
        // revoked row.
        db.prepare(
          `INSERT INTO hosts
             (id, name, kind, user_id, installation_id, created_at)
           VALUES ('h-active', 'h-active', 'local', 'u1', 'inst-1', ?)`,
        ).run(now);

        // But two active rows for the same pair still violate.
        expect(() =>
          db
            .prepare(
              `INSERT INTO hosts
                 (id, name, kind, user_id, installation_id, created_at)
               VALUES ('h-active-dup', 'h-active-dup', 'local', 'u1', 'inst-1', ?)`,
            )
            .run(now),
        ).toThrow(/UNIQUE constraint failed/);
      } finally {
        db.close();
      }
    });
  });
});
