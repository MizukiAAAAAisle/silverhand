import Database from 'better-sqlite3';
import {
  existsSync,
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
  resolveMessageAuthor,
  type MessageAuthorRow,
} from '@silverhand/shared';
import {
  BASELINE_SCHEMA_SQL,
  BASELINE_MIGRATION_STEP,
} from '@silverhand/shared/db/baseline-schema';
import {
  CURRENT_MIGRATION_STEP,
  migrations,
} from '@silverhand/shared/db/migrations';
import {
  CURRENT_SCHEMA_EPOCH,
  MIN_SUPPORTED_MIGRATION_STEP,
  ONE_TO_ONE_EPOCH_CEILING_STEP,
  epochForMigrationStep,
  reportedEpochForAppliedStep,
} from '@silverhand/shared/db/schema-epochs';
import {
  backupDataDirBeforeMigration,
  currentMigrationStep,
  currentSchemaEpoch,
  openDatabase,
  runMigrations,
  type MigrationBackupInfo,
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
      // Preconditions are part of applying a migration, not an optional extra:
      // v71 stages its inbox ids in a temp table there, so a helper that skipped
      // them could not open a DB at any version >= 71 at all.
      if (migration.precondition) migration.precondition(db);
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
 * tests can observe an intermediate state between two retained migrations.
 *
 * Post-baseline-compaction (#task:1213) the lowest applicable version is the
 * baseline (44), so `maxVersion` must be >= 44; intermediate historical states
 * below the baseline no longer exist.
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

const SYNTHETIC_UPGRADE_BASE_VERSION = MIN_SUPPORTED_MIGRATION_STEP;
const SYNTHETIC_UPGRADE_TARGET_VERSION = MIN_SUPPORTED_MIGRATION_STEP + 1;

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
      expect(currentMigrationStep(db)).toBe(CURRENT_MIGRATION_STEP);
    } finally {
      db.close();
    }
  });

  it('reruns idempotently when the DB is already at the current version', () => {
    const db = openDatabase(':memory:');
    try {
      const first = currentMigrationStep(db);
      const second = runMigrations(db, {
        expectedStep: CURRENT_MIGRATION_STEP,
        minimumSupportedStep: MIN_SUPPORTED_MIGRATION_STEP,
      });
      expect(first).toBe(CURRENT_MIGRATION_STEP);
      expect(second).toEqual({
        beforeStep: CURRENT_MIGRATION_STEP,
        afterStep: CURRENT_MIGRATION_STEP,
        appliedSteps: [],
        beforeEpoch: CURRENT_SCHEMA_EPOCH,
        afterEpoch: CURRENT_SCHEMA_EPOCH,
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
          expectedStep: SYNTHETIC_UPGRADE_TARGET_VERSION,
          minimumSupportedStep: SYNTHETIC_UPGRADE_BASE_VERSION,
          allowSchemaUpgrade: false,
        }),
      ).toThrow(/SILVERHAND_MIGRATE=1/);
      expect(currentMigrationStep(db)).toBe(SYNTHETIC_UPGRADE_BASE_VERSION);
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
        expectedStep: SYNTHETIC_UPGRADE_TARGET_VERSION,
        minimumSupportedStep: SYNTHETIC_UPGRADE_BASE_VERSION,
        allowSchemaUpgrade: true,
        backupBeforeMigration: info =>
          backupDataDirBeforeMigration(db, { dbPath, ...info }),
      });
      expect(result.beforeStep).toBe(SYNTHETIC_UPGRADE_BASE_VERSION);
      expect(result.afterStep).toBe(SYNTHETIC_UPGRADE_TARGET_VERSION);
      expect(result.appliedSteps).toEqual([SYNTHETIC_UPGRADE_TARGET_VERSION]);
      expect(result.backupPath).toMatch(/data-backup-\d{8}T\d{6}Z$/);
      expect(currentMigrationStep(db)).toBe(SYNTHETIC_UPGRADE_TARGET_VERSION);
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
        expect(currentMigrationStep(backupDb)).toBe(
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
          expectedStep: SYNTHETIC_UPGRADE_TARGET_VERSION,
          minimumSupportedStep: SYNTHETIC_UPGRADE_BASE_VERSION,
          allowSchemaUpgrade: true,
          backupBeforeMigration: () => {
            throw new Error('backup path is not writable');
          },
        }),
      ).toThrow(/backup path is not writable/);
      expect(currentMigrationStep(db)).toBe(SYNTHETIC_UPGRADE_BASE_VERSION);
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
      expect(currentMigrationStep(db)).toBe(1);
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
          expectedStep: CURRENT_MIGRATION_STEP,
          minimumSupportedStep: MIN_SUPPORTED_MIGRATION_STEP,
        }),
      ).toThrow(/below the baseline step \d+, whose migration is a full CREATE/);
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
          expectedStep: CURRENT_MIGRATION_STEP,
          minimumSupportedStep: MIN_SUPPORTED_MIGRATION_STEP,
        }),
      ).toThrow(/below the baseline step \d+, whose migration is a full CREATE/);
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

  it('upgrades a baseline-version DB by applying only the retained increments', () => {
    // The linchpin of the floor=44 safety argument (#task:1213 §3.1): a DB
    // already at the baseline must skip the baseline migration (it is a full
    // CREATE and would collide with the existing tables) and apply only the
    // retained v45.. increments. Simulate a real v44 DB: the v44 schema in
    // place + the ledger holding version 44.
    const db = new Database(':memory:');
    try {
      db.exec(BASELINE_SCHEMA_SQL);
      db.exec(`
        CREATE TABLE _migrations (
          version INTEGER PRIMARY KEY,
          name    TEXT NOT NULL,
          applied_at INTEGER NOT NULL
        );
        INSERT INTO _migrations (version, name, applied_at)
        VALUES (${BASELINE_MIGRATION_STEP}, 'baseline', 1);
      `);
      const result = runMigrations(db, {
        expectedStep: CURRENT_MIGRATION_STEP,
        minimumSupportedStep: MIN_SUPPORTED_MIGRATION_STEP,
        allowSchemaUpgrade: true,
      });
      expect(result.beforeStep).toBe(BASELINE_MIGRATION_STEP);
      expect(result.afterStep).toBe(CURRENT_MIGRATION_STEP);
      // Baseline (44) is NOT re-applied; only the retained increments are.
      expect(result.appliedSteps).toEqual(
        migrations
          .filter(m => m.version > BASELINE_MIGRATION_STEP)
          .map(m => m.version),
      );
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
          expectedStep: CURRENT_MIGRATION_STEP,
          minimumSupportedStep: MIN_SUPPORTED_MIGRATION_STEP,
        }),
      ).toThrow(/past the newest step \d+ this build knows/);
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

  it('does not remove unknown legacy lock directories and returns a normal runtime connection', () => {
    const dir = mkdtempSync(join(tmpdir(), 'silverhand-migration-dir-lock-test-'));
    const dataDir = join(dir, '.silverhand');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(join(dir, '.silverhand.migration.lock'));
    try {
      const db = openDatabase(join(dataDir, 'silverhand.db'));
      try {
        expect(db.pragma('locking_mode', { simple: true })).toBe('normal');
        expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
        expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
        expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
      } finally { db.close(); }
      expect(existsSync(join(dir, '.silverhand.migration.lock'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('users / agents identity schema invariants', () => {
    // The current schema (baseline) enforces a shared user/agent identity:
    // users.name UNIQUE, cross-namespace uniqueness (users.name ⊕ agents.name)
    // via triggers, the polymorphic attachments dispatch trigger, and FK-clean
    // user references. These probe the live constraints directly (runMigrations
    // → full current schema); they are not tied to the migration that first
    // introduced them.

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
            (id, name, name_key, description,
             owner_agent_id, archived_at, created_at, updated_at)
          VALUES
            ('ws_main', 'Main', 'main', NULL,
             NULL, NULL, 1, 1);
          INSERT INTO conversations
            (id, workspace_id, placement_kind, roster_policy, title, title_key,
             status, spawned_by_agent_id, closed_at, close_summary, pinned_at,
             archived_at, created_at, updated_at)
          VALUES
            ('conv_main', 'ws_main', 'workspace', 'open', 'general', 'general',
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

        // FK list on messages is exactly from_user_id pointing to users with
        // ON DELETE SET NULL. The second user FK this used to name,
        // `task_assignee_user_id`, belonged to v60's dead "a message IS a task"
        // carrier and was physically dropped in v87 (#task:2083) — the row's
        // remaining tie to a person is who SENT it.
        const messageFks = (
          db.pragma('foreign_key_list(messages)') as Array<{
            table: string;
            from: string;
            to: string;
            on_delete: string;
          }>
        ).filter(fk => fk.table === 'users');
        const fromCols = messageFks.map(fk => fk.from).sort();
        expect(fromCols).toEqual(['from_user_id']);
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

  });

  describe('membership schema invariants', () => {
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
             (id, name, name_key, description,
              owner_agent_id, created_at, updated_at)
           VALUES ('ws1', 'w', 'w', NULL, NULL, ?, ?)`,
        ).run(now, now);
        db.prepare(
          `INSERT INTO conversations
             (id, workspace_id, placement_kind, roster_policy, title, title_key,
              status, created_at, updated_at)
           VALUES ('c1', 'ws1', 'workspace', 'open', 't', 't', 'open', ?, ?)`,
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

  describe('agent creator + avatar schema invariants', () => {
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
             (id, name, name_key, description,
              owner_agent_id, archived_at, created_at, updated_at)
           VALUES ('ws1', 'main', 'main', NULL, NULL, NULL, ?, ?)`,
        ).run(now, now);
        db.prepare(
          `INSERT INTO conversations
             (id, workspace_id, placement_kind, roster_policy, title, title_key,
              status, spawned_by_agent_id, closed_at, close_summary, pinned_at,
              archived_at, created_at, updated_at)
           VALUES ('c1', 'ws1', 'workspace', 'open', 'general', 'general',
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

  // v48 rebuilds user_list_sort_mode to add `scope` to the primary key, so the
  // workspace rail can carry a per-section mode while channels stay list-wide.
  // A table-rebuild + PK migration is the kind that breaks silently later, so
  // pin the upgrade: old (user_id, list_key) rows fold into scope '', the new
  // PK is (user_id, list_key, scope), and the same (user, list) can now hold
  // distinct per-scope modes.
  describe('v51 conversation_reads_per_stream', () => {
    it('migrates the old per-conversation cursor to a mainline row, eager-seeds existing threads, and enforces the per-stream uniqueness + root invariants', () => {
      const db = openDbAt(50);
      try {
        const now = 1_700_000_000_000;
        db.exec(`
          INSERT INTO hosts (id, name, kind, created_at)
          VALUES ('host_local', 'local', 'local', ${now});
          INSERT INTO users (id, name, display_name, created_at, updated_at)
          VALUES ('u1', 'one', 'One', ${now}, ${now}),
                 ('u2', 'two', 'Two', ${now}, ${now});
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
             'idle', NULL, NULL, NULL, NULL, NULL, ${now}, ${now}),
            ('conv_other', 'ws_main', '/tmp/ws_main', 'channel', NULL, 'other',
             'idle', NULL, NULL, NULL, NULL, NULL, ${now}, ${now});
          -- root1 (mainline) + reply1 (thread under root1) in conv_main; rootOther
          -- is a mainline message belonging to conv_other.
          INSERT INTO messages
            (id, conversation_id, from_kind, from_user_id, content, seq, created_at, thread_root_id)
          VALUES
            ('root1', 'conv_main', 'user', 'u1', 'root', 1, ${now}, NULL),
            ('reply1', 'conv_main', 'user', 'u1', 'r1', 2, ${now}, 'root1'),
            ('rootOther', 'conv_other', 'user', 'u1', 'o', 1, ${now}, NULL);
          -- per-stream freshness heads: mainline + the one thread in conv_main.
          INSERT INTO conversation_stream_heads (conversation_id, thread_root_id, latest_seq)
          VALUES ('conv_main', NULL, 10),
                 ('conv_main', 'root1', 20),
                 ('conv_other', NULL, 3);
          -- OLD per-conversation cursors (v50 shape: PK user_id, conversation_id).
          INSERT INTO conversation_reads (user_id, conversation_id, last_read_seq, read_at)
          VALUES ('u1', 'conv_main', 5, ${now}),
                 ('u2', 'conv_main', 3, ${now});
        `);

        applyMigrationsThrough(db, 51);
        expect(
          db.prepare(`SELECT version FROM _migrations WHERE version = 51`).get(),
        ).toBeDefined();

        // New per-stream column.
        const cols = (
          db.pragma('table_info(conversation_reads)') as Array<{ name: string }>
        ).map(c => c.name);
        expect(cols).toContain('thread_root_id');

        // Old rows became MAINLINE cursors (thread_root_id NULL), value preserved.
        const mainline = db
          .prepare(
            `SELECT user_id, last_read_seq FROM conversation_reads
              WHERE conversation_id = 'conv_main' AND thread_root_id IS NULL
              ORDER BY user_id`,
          )
          .all();
        expect(mainline).toEqual([
          { user_id: 'u1', last_read_seq: 5 },
          { user_id: 'u2', last_read_seq: 3 },
        ]);

        // Eager seed: every existing thread stream gets a per-(user,thread) row
        // frozen at that user's old mainline value — so an upgrade produces no
        // historical unread flood, and the steady-state model needs no fallback.
        const seeded = db
          .prepare(
            `SELECT user_id, last_read_seq FROM conversation_reads
              WHERE conversation_id = 'conv_main' AND thread_root_id = 'root1'
              ORDER BY user_id`,
          )
          .all();
        expect(seeded).toEqual([
          { user_id: 'u1', last_read_seq: 5 },
          { user_id: 'u2', last_read_seq: 3 },
        ]);

        // conv_other had no cursor → nothing seeded there.
        expect(
          db
            .prepare(
              `SELECT COUNT(*) AS c FROM conversation_reads WHERE conversation_id = 'conv_other'`,
            )
            .get(),
        ).toEqual({ c: 0 });

        // Partial-unique indexes: one mainline row + one row per thread.
        expect(() =>
          db
            .prepare(
              `INSERT INTO conversation_reads (user_id, conversation_id, thread_root_id, last_read_seq, read_at)
               VALUES ('u1', 'conv_main', NULL, 0, ${now})`,
            )
            .run(),
        ).toThrow(/UNIQUE/i);
        expect(() =>
          db
            .prepare(
              `INSERT INTO conversation_reads (user_id, conversation_id, thread_root_id, last_read_seq, read_at)
               VALUES ('u1', 'conv_main', 'root1', 0, ${now})`,
            )
            .run(),
        ).toThrow(/UNIQUE/i);

        // Root-invariant trigger: a thread_root_id that is itself a reply,
        // that lives in another conversation, or that doesn't exist — all reject.
        expect(() =>
          db
            .prepare(
              `INSERT INTO conversation_reads (user_id, conversation_id, thread_root_id, last_read_seq, read_at)
               VALUES ('u2', 'conv_main', 'reply1', 0, ${now})`,
            )
            .run(),
        ).toThrow(/must not itself be a reply/);
        expect(() =>
          db
            .prepare(
              `INSERT INTO conversation_reads (user_id, conversation_id, thread_root_id, last_read_seq, read_at)
               VALUES ('u2', 'conv_main', 'rootOther', 0, ${now})`,
            )
            .run(),
        ).toThrow(/same conversation/);
        expect(() =>
          db
            .prepare(
              `INSERT INTO conversation_reads (user_id, conversation_id, thread_root_id, last_read_seq, read_at)
               VALUES ('u2', 'conv_main', 'ghost', 0, ${now})`,
            )
            .run(),
        ).toThrow();
      } finally {
        db.close();
      }
    });
  });

  describe('v48 user_list_sort_mode_per_scope', () => {
    it('folds existing v47 rows into scope "" and re-keys on (user_id, list_key, scope)', () => {
      const db = openDbAt(47);
      try {
        const now = 1_700_000_000_000;
        db.prepare(
          `INSERT INTO users (id, name, display_name, created_at, updated_at)
           VALUES ('u1', 'viewer', 'Viewer', ?, ?)`,
        ).run(now, now);

        // v47 shape: PK (user_id, list_key), NO scope column.
        const v47Cols = (
          db.pragma('table_info(user_list_sort_mode)') as Array<{ name: string }>
        ).map(c => c.name);
        expect(v47Cols).not.toContain('scope');
        db.prepare(
          `INSERT INTO user_list_sort_mode (user_id, list_key, mode, updated_at)
           VALUES ('u1', 'workspaces', 'manual', ?)`,
        ).run(now);
        db.prepare(
          `INSERT INTO user_list_sort_mode (user_id, list_key, mode, updated_at)
           VALUES ('u1', 'channels:ws1', 'recent', ?)`,
        ).run(now);

        applyMigrationsThrough(db, 48);
        expect(
          db.prepare(`SELECT version FROM _migrations WHERE version = 48`).get(),
        ).toBeDefined();

        // New column + composite PK shape.
        const cols = db.pragma('table_info(user_list_sort_mode)') as Array<{
          name: string;
          notnull: number;
          pk: number;
        }>;
        expect(cols.find(c => c.name === 'scope')?.notnull).toBe(1);
        const pkCols = cols
          .filter(c => c.pk > 0)
          .sort((a, b) => a.pk - b.pk)
          .map(c => c.name);
        expect(pkCols).toEqual(['user_id', 'list_key', 'scope']);

        // Every pre-existing row folds into the list-wide sentinel scope ''.
        const rows = db
          .prepare(
            `SELECT list_key, scope, mode FROM user_list_sort_mode ORDER BY list_key`,
          )
          .all();
        expect(rows).toEqual([
          { list_key: 'channels:ws1', scope: '', mode: 'recent' },
          { list_key: 'workspaces', scope: '', mode: 'manual' },
        ]);

        // The new key lets one (user, list) hold distinct per-scope modes —
        // the rail's per-section toggles — impossible under the old PK.
        db.prepare(
          `INSERT INTO user_list_sort_mode (user_id, list_key, scope, mode, updated_at)
           VALUES ('u1', 'workspaces', 'pinned', 'manual', ?)`,
        ).run(now);
        db.prepare(
          `INSERT INTO user_list_sort_mode (user_id, list_key, scope, mode, updated_at)
           VALUES ('u1', 'workspaces', 'dm', 'recent', ?)`,
        ).run(now);
        const wsModes = db
          .prepare(
            `SELECT scope, mode FROM user_list_sort_mode
             WHERE user_id = 'u1' AND list_key = 'workspaces' ORDER BY scope`,
          )
          .all();
        expect(wsModes).toEqual([
          { scope: '', mode: 'manual' },
          { scope: 'dm', mode: 'recent' },
          { scope: 'pinned', mode: 'manual' },
        ]);

        // …but the PK still rejects a duplicate (user, list, scope).
        expect(() =>
          db
            .prepare(
              `INSERT INTO user_list_sort_mode (user_id, list_key, scope, mode, updated_at)
               VALUES ('u1', 'workspaces', 'pinned', 'recent', ?)`,
            )
            .run(now),
        ).toThrow(/UNIQUE|PRIMARY/i);
      } finally {
        db.close();
      }
    });
  });

  // v53 retires the legacy `conversations.kind='thread'` fossil (#task:1303,
  // 2c): a table rebuild that narrows the kind CHECK to ('channel','dm_channel')
  // and drops the thread branch of the parent CHECK, dropping the old
  // conversations_thread_parent_{insert,update} triggers with it. It is
  // destructive DDL guarded by a fail-loud precondition (fossil rows must have
  // been purged in Phase-1 first), so pin both the success shape and the guard.
  describe('v53 retire_thread_conversation_kind', () => {
    const now = 1_700_000_000_000;

    /** Seed a host + regular workspace + one channel at v52, so we can insert
     *  conversations (workspace/host FKs satisfied) before applying v53. */
    function seedBase(db: Database.Database): void {
      db.exec(`
        INSERT INTO hosts (id, name, kind, created_at)
        VALUES ('host_local', 'local', 'local', ${now});
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
          ('c_parent', 'ws_main', '/tmp/ws_main', 'channel', NULL, 'general',
           'idle', NULL, NULL, NULL, NULL, NULL, ${now}, ${now});
      `);
    }

    it('tightens the CHECK, drops the thread triggers, and preserves channel-like rows', () => {
      const db = openDbAt(52);
      try {
        seedBase(db);
        // A dm_channel row too, to prove both surviving kinds round-trip the rebuild.
        db.exec(`
          INSERT INTO conversations
            (id, workspace_id, workspace_path, kind, parent_conversation_id, title,
             status, spawned_by_agent_id, closed_at, close_summary, pinned_at,
             archived_at, created_at, updated_at)
          VALUES
            ('c_dm', 'ws_main', '/tmp/ws_main', 'dm_channel', NULL, 'dm',
             'idle', NULL, NULL, NULL, NULL, NULL, ${now}, ${now});
        `);

        applyMigrationsThrough(db, 53);
        expect(
          db.prepare(`SELECT version FROM _migrations WHERE version = 53`).get(),
        ).toBeDefined();

        // Both channel-like rows survived the rebuild verbatim.
        const rows = db
          .prepare(`SELECT id, kind FROM conversations ORDER BY id`)
          .all();
        expect(rows).toEqual([
          { id: 'c_dm', kind: 'dm_channel' },
          { id: 'c_parent', kind: 'channel' },
        ]);

        // The thread-parent triggers are gone (auto-dropped with the old table,
        // not recreated).
        const triggers = db
          .prepare<[], { name: string }>(
            `SELECT name FROM sqlite_schema WHERE type = 'trigger'`,
          )
          .all()
          .map(r => r.name);
        expect(triggers).not.toContain('conversations_thread_parent_insert');
        expect(triggers).not.toContain('conversations_thread_parent_update');

        // All four conversations indexes were rebuilt.
        const indexes = db
          .prepare<[], { name: string }>(
            `SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'conversations'`,
          )
          .all()
          .map(r => r.name);
        expect(indexes).toEqual(
          expect.arrayContaining([
            'idx_conversations_workspace',
            'idx_conversations_parent',
            'idx_conversations_status',
            'idx_conversations_archived_at',
          ]),
        );

        // The narrowed column CHECK now rejects kind='thread' outright.
        expect(() =>
          db
            .prepare(
              `INSERT INTO conversations
                 (id, workspace_id, workspace_path, kind, parent_conversation_id, title,
                  status, spawned_by_agent_id, closed_at, close_summary, pinned_at,
                  archived_at, created_at, updated_at)
               VALUES ('t_new', 'ws_main', '/tmp/ws_main', 'thread', 'c_parent', 't',
                       'idle', NULL, NULL, NULL, NULL, NULL, ${now}, ${now})`,
            )
            .run(),
        ).toThrow(/CHECK/);

        // The tightened table CHECK now rejects a non-NULL parent on a channel.
        expect(() =>
          db
            .prepare(
              `INSERT INTO conversations
                 (id, workspace_id, workspace_path, kind, parent_conversation_id, title,
                  status, spawned_by_agent_id, closed_at, close_summary, pinned_at,
                  archived_at, created_at, updated_at)
               VALUES ('c_bad', 'ws_main', '/tmp/ws_main', 'channel', 'c_parent', 't',
                       'idle', NULL, NULL, NULL, NULL, NULL, ${now}, ${now})`,
            )
            .run(),
        ).toThrow(/CHECK/);

        // FK integrity holds across the rebuild.
        expect(db.pragma('foreign_key_check')).toEqual([]);
      } finally {
        db.close();
      }
    });

    it('fails loud and writes no _migrations row when a thread fossil still exists', () => {
      const db = openDbAt(52);
      try {
        seedBase(db);
        // A surviving Sense1 fossil: kind='thread' child of the channel (the v52
        // triggers require a channel-like parent in the same workspace).
        db.exec(`
          INSERT INTO conversations
            (id, workspace_id, workspace_path, kind, parent_conversation_id, title,
             status, spawned_by_agent_id, closed_at, close_summary, pinned_at,
             archived_at, created_at, updated_at)
          VALUES
            ('t_fossil', 'ws_main', '/tmp/ws_main', 'thread', 'c_parent', 'old thread',
             'idle', NULL, NULL, NULL, NULL, NULL, ${now}, ${now});
        `);

        expect(() => applyMigrationsThrough(db, 53)).toThrow(
          /legacy thread fossil/,
        );

        // Precondition threw inside the tx → rolled back → no v53 ledger row.
        expect(
          db.prepare(`SELECT version FROM _migrations WHERE version = 53`).get(),
        ).toBeUndefined();
        // …and the table was NOT rebuilt: the old thread triggers still stand.
        const triggers = db
          .prepare<[], { name: string }>(
            `SELECT name FROM sqlite_schema WHERE type = 'trigger'`,
          )
          .all()
          .map(r => r.name);
        expect(triggers).toContain('conversations_thread_parent_insert');
        expect(triggers).toContain('conversations_thread_parent_update');
        // The fossil is still readable (nothing was destroyed).
        expect(
          db.prepare(`SELECT kind FROM conversations WHERE id = 't_fossil'`).get(),
        ).toEqual({ kind: 'thread' });
      } finally {
        db.close();
      }
    });
  });

  describe('v54 drop_conversation_parent_column', () => {
    const now = 1_700_000_000_000;

    function seedBase(db: Database.Database): void {
      db.exec(`
        INSERT INTO hosts (id, name, kind, created_at)
        VALUES ('host_local', 'local', 'local', ${now});
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
          ('c_channel', 'ws_main', '/tmp/ws_main', 'channel', NULL, 'general',
           'idle', NULL, NULL, NULL, NULL, NULL, ${now}, ${now}),
          ('c_dm', 'ws_main', '/tmp/ws_main', 'dm_channel', NULL, 'dm',
           'idle', NULL, NULL, NULL, NULL, NULL, ${now}, ${now});
        INSERT INTO conversation_events (conversation_id, agent_id, kind, payload, created_at)
        VALUES ('c_channel', NULL, 'archived', NULL, ${now});
        INSERT INTO messages
          (id, conversation_id, from_kind, content, seq, created_at)
        VALUES ('m1', 'c_channel', 'system', 'hello', 1, ${now});
      `);
    }

    it('drops parent_conversation_id and its index while preserving channel-like rows', () => {
      const db = openDbAt(53);
      try {
        seedBase(db);

        applyMigrationsThrough(db, 54);
        expect(
          db.prepare(`SELECT version FROM _migrations WHERE version = 54`).get(),
        ).toBeDefined();

        const columns = db
          .prepare<[], { name: string }>(`PRAGMA table_info(conversations)`)
          .all()
          .map(r => r.name);
        expect(columns).not.toContain('parent_conversation_id');
        expect(columns).toEqual(
          expect.arrayContaining([
            'id',
            'workspace_id',
            'workspace_path',
            'kind',
            'title',
            'status',
            'spawned_by_agent_id',
            'closed_at',
            'close_summary',
            'pinned_at',
            'created_at',
            'updated_at',
            'archived_at',
            'latest_message_seq',
          ]),
        );

        const rows = db
          .prepare(`SELECT id, kind, title FROM conversations ORDER BY id`)
          .all();
        expect(rows).toEqual([
          { id: 'c_channel', kind: 'channel', title: 'general' },
          { id: 'c_dm', kind: 'dm_channel', title: 'dm' },
        ]);
        expect(
          db
            .prepare(
              `SELECT conversation_id, kind FROM conversation_events WHERE conversation_id = 'c_channel'`,
            )
            .get(),
        ).toEqual({ conversation_id: 'c_channel', kind: 'archived' });
        expect(
          db
            .prepare(
              `SELECT id, conversation_id, content FROM messages WHERE id = 'm1'`,
            )
            .get(),
        ).toEqual({ id: 'm1', conversation_id: 'c_channel', content: 'hello' });

        const indexes = db
          .prepare<[], { name: string }>(
            `SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'conversations'`,
          )
          .all()
          .map(r => r.name);
        expect(indexes).toEqual(
          expect.arrayContaining([
            'idx_conversations_workspace',
            'idx_conversations_status',
            'idx_conversations_archived_at',
          ]),
        );
        expect(indexes).not.toContain('idx_conversations_parent');

        expect(() =>
          db.exec(`
            INSERT INTO conversations
              (id, workspace_id, workspace_path, kind, parent_conversation_id, title,
               status, spawned_by_agent_id, closed_at, close_summary, pinned_at,
               archived_at, created_at, updated_at)
            VALUES
              ('c_bad_parent_col', 'ws_main', '/tmp/ws_main', 'channel', NULL, 'bad',
               'idle', NULL, NULL, NULL, NULL, NULL, ${now}, ${now})
          `),
        ).toThrow(/parent_conversation_id/);

        expect(() =>
          db.exec(`
            INSERT INTO conversations
              (id, workspace_id, workspace_path, kind, title, status,
               spawned_by_agent_id, closed_at, close_summary, pinned_at,
               archived_at, created_at, updated_at)
            VALUES
              ('c_thread', 'ws_main', '/tmp/ws_main', 'thread', 'bad',
               'idle', NULL, NULL, NULL, NULL, NULL, ${now}, ${now})
          `),
        ).toThrow(/CHECK/);

        expect(db.pragma('foreign_key_check')).toEqual([]);
      } finally {
        db.close();
      }
    });

    it('fails loud and writes no _migrations row when a non-null parent column remains', () => {
      const db = openDbAt(53);
      try {
        seedBase(db);
        db.pragma('ignore_check_constraints = ON');
        try {
          db.exec(`
            INSERT INTO conversations
              (id, workspace_id, workspace_path, kind, parent_conversation_id, title,
               status, spawned_by_agent_id, closed_at, close_summary, pinned_at,
               archived_at, created_at, updated_at)
            VALUES
              ('c_dirty_parent', 'ws_main', '/tmp/ws_main', 'channel', 'c_channel', 'dirty',
               'idle', NULL, NULL, NULL, NULL, NULL, ${now}, ${now});
          `);
        } finally {
          db.pragma('ignore_check_constraints = OFF');
        }

        expect(() => applyMigrationsThrough(db, 54)).toThrow(
          /parent_conversation_id/,
        );
        expect(
          db.prepare(`SELECT version FROM _migrations WHERE version = 54`).get(),
        ).toBeUndefined();
        const columns = db
          .prepare<[], { name: string }>(`PRAGMA table_info(conversations)`)
          .all()
          .map(r => r.name);
        expect(columns).toContain('parent_conversation_id');
        expect(
          db
            .prepare(
              `SELECT parent_conversation_id FROM conversations WHERE id = 'c_dirty_parent'`,
            )
            .get(),
        ).toEqual({ parent_conversation_id: 'c_channel' });
      } finally {
        db.close();
      }
    });
  });

  describe('v55 host_activation_and_provisioning_source', () => {
    it('backfills app-install source only for install-bound user hosts and activates existing owned local hosts', () => {
      const db = openDbAt(54);
      try {
        const now = 1_700_000_000_000;
        db.exec(`
          INSERT INTO users (id, name, display_name, avatar_storage_key, avatar_content_type, created_at, updated_at, email, last_seen_at)
          VALUES ('u1', 'u1', 'User One', NULL, NULL, ${now}, ${now}, NULL, NULL);

          INSERT INTO hosts (id, name, kind, created_at, user_id, installation_id, last_seen_at, revoked_at, display_label)
          VALUES
            ('h_app', 'h-app', 'local', ${now}, 'u1', 'install-1', ${now + 1}, NULL, NULL),
            ('h_revoked', 'h-revoked', 'local', ${now}, 'u1', 'install-revoked', ${now + 2}, ${now + 3}, NULL),
            ('h_user_no_install', 'h-user-no-install', 'local', ${now}, 'u1', NULL, ${now + 4}, NULL, NULL),
            ('h_remote_user', 'h-remote-user', 'remote', ${now}, 'u1', NULL, ${now + 5}, NULL, NULL),
            ('h_system', 'h-system', 'remote', ${now}, NULL, NULL, NULL, NULL, NULL);
        `);

        applyMigrationsThrough(db, 55);

        const rows = db
          .prepare<
            [],
            {
              id: string;
              provisioning_source: string;
              activated_at: number | null;
            }
          >(
            `SELECT id, provisioning_source, activated_at
               FROM hosts
              WHERE id LIKE 'h_%'
              ORDER BY id`,
          )
          .all();
        expect(rows).toEqual([
          {
            id: 'h_app',
            provisioning_source: 'app_install',
            activated_at: now + 1,
          },
          {
            id: 'h_remote_user',
            provisioning_source: 'system',
            activated_at: null,
          },
          {
            id: 'h_revoked',
            provisioning_source: 'app_install',
            activated_at: null,
          },
          {
            id: 'h_system',
            provisioning_source: 'system',
            activated_at: null,
          },
          {
            id: 'h_user_no_install',
            provisioning_source: 'system',
            activated_at: now + 4,
          },
        ]);
      } finally {
        db.close();
      }
    });
  });

  describe('v56 host_finalization_lifecycle', () => {
    it('backfills finalized_at only for already-formal non-user-invite active hosts', () => {
      const db = openDbAt(55);
      try {
        const now = 1_700_000_100_000;
        db.exec(`
          INSERT INTO users (id, name, display_name, avatar_storage_key, avatar_content_type, created_at, updated_at, email, last_seen_at)
          VALUES ('u1', 'u1', 'User One', NULL, NULL, ${now}, ${now}, NULL, NULL);

          INSERT INTO hosts
            (id, name, kind, created_at, user_id, installation_id, last_seen_at,
             revoked_at, display_label, activated_at, provisioning_source)
          VALUES
            ('h_app', 'h-app-v56', 'local', ${now}, 'u1', 'install-1', ${now + 1}, NULL, NULL, ${now + 1}, 'app_install'),
            ('h_system_active', 'h-system-active-v56', 'local', ${now}, 'u1', NULL, ${now + 2}, NULL, NULL, ${now + 2}, 'system'),
            ('h_invite_pending', 'h-invite-pending-v56', 'remote', ${now}, 'u1', NULL, NULL, NULL, NULL, NULL, 'user_invite'),
            ('h_invite_attached', 'h-invite-attached-v56', 'remote', ${now}, 'u1', NULL, ${now + 3}, NULL, NULL, ${now + 3}, 'user_invite'),
            ('h_revoked', 'h-revoked-v56', 'local', ${now}, 'u1', 'install-revoked', ${now + 4}, ${now + 5}, NULL, ${now + 4}, 'app_install');
        `);

        applyMigrationsThrough(db, 56);

        const rows = db
          .prepare<
            [],
            {
              id: string;
              activated_at: number | null;
              finalized_at: number | null;
              provisioning_source: string;
            }
          >(
            `SELECT id, activated_at, finalized_at, provisioning_source
               FROM hosts
              WHERE id LIKE 'h_%'
              ORDER BY id`,
          )
          .all();
        expect(rows).toEqual([
          {
            id: 'h_app',
            activated_at: now + 1,
            finalized_at: now + 1,
            provisioning_source: 'app_install',
          },
          {
            id: 'h_invite_attached',
            activated_at: now + 3,
            finalized_at: null,
            provisioning_source: 'user_invite',
          },
          {
            id: 'h_invite_pending',
            activated_at: null,
            finalized_at: null,
            provisioning_source: 'user_invite',
          },
          {
            id: 'h_revoked',
            activated_at: now + 4,
            finalized_at: null,
            provisioning_source: 'app_install',
          },
          {
            id: 'h_system_active',
            activated_at: now + 2,
            finalized_at: now + 2,
            provisioning_source: 'system',
          },
        ]);
      } finally {
        db.close();
      }
    });
  });

  describe('v57 agent_runtime_transition_lock', () => {
    it('adds a paired nullable durable transition lock', () => {
      const db = openDbAt(56);
      try {
        applyMigrationsThrough(db, 57);
        const columns = db
          .prepare<[], { name: string; notnull: number }>('PRAGMA table_info(agents)')
          .all()
          .filter(row => row.name.startsWith('runtime_transition_'))
          .map(row => ({ name: row.name, notnull: row.notnull }));
        expect(columns).toEqual([
          { name: 'runtime_transition_started_at', notnull: 0 },
          { name: 'runtime_transition_target', notnull: 0 },
        ]);
        const table = db
          .prepare<[], { sql: string }>(
            `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agents'`,
          )
          .get();
        expect(table?.sql).toContain('runtime_transition_target IN');
        expect(table?.sql).toContain('runtime_transition_started_at IS NOT NULL');
        const triggers = db
          .prepare<[], { name: string }>(
            `SELECT name FROM sqlite_master
              WHERE type = 'trigger'
                AND name LIKE 'agents_runtime_transition_pair_%'
              ORDER BY name`,
          )
          .all()
          .map(row => row.name);
        expect(triggers).toEqual([
          'agents_runtime_transition_pair_insert',
          'agents_runtime_transition_pair_update',
        ]);
      } finally {
        db.close();
      }
    });
  });

  describe('v63 message_author_snapshot', () => {
    // The backfill runs through the SAME production migration definition
    // (`migrations` array, replayed by `applyMigrationsThrough`) as `runMigrations`
    // — this drives the real `up` SQL, not a hand-copied version. NOTE the fidelity
    // boundary: v63+ rows capture the author snapshot at SEND time, but this
    // one-time backfill reconstructs each surviving actor's identity at MIGRATION
    // time (best effort — no send-time value was ever recorded for pre-v63 rows).
    // We prove the migration-time backfill populates the snapshot columns from the
    // live authority for still-resolvable rows, leaves them NULL for system rows
    // and rows whose actor was ALREADY hard-deleted before the column existed,
    // and — critically — that the snapshot survives a LATER hard delete so the ONE
    // server-authoritative resolver classifies the row as `deleted` (never a
    // fabricated identity, never an "unresolved" regression).
    function seedV62(db: Database.Database): { now: number } {
      const now = 1_700_000_200_000;
      db.exec(`
        INSERT INTO users (id, name, display_name, avatar_storage_key, avatar_content_type, created_at, updated_at, email, last_seen_at)
        VALUES ('u1', 'u1', 'User One', NULL, NULL, ${now}, ${now}, NULL, NULL);

        INSERT INTO hosts (id, name, kind, created_at, user_id, installation_id, last_seen_at, revoked_at, display_label)
        VALUES ('h1', 'h1', 'local', ${now}, 'u1', NULL, ${now}, NULL, NULL);

        INSERT INTO agents (id, name, runtime, host_id, created_at, updated_at, display_name, created_by_user_id)
        VALUES
          ('a_kept', 'kept-agent', 'claude', 'h1', ${now}, ${now}, 'Kept Agent', 'u1'),
          ('a_pre',  'pre-agent',  'codex',  'h1', ${now}, ${now}, 'Pre Agent',  'u1');

        INSERT INTO workspaces (id, name, description, workspace_kind, workspace_path, workspace_host_id, owner_agent_id, created_at, updated_at)
        VALUES ('w1', 'w1', NULL, 'regular', '/tmp/w1', 'h1', NULL, ${now}, ${now});

        INSERT INTO conversations (id, workspace_id, workspace_path, kind, title, status, created_at, updated_at)
        VALUES ('c1', 'w1', '/tmp/w1', 'channel', 'c1', 'open', ${now}, ${now});

        -- Message by an agent that STAYS alive across the migration.
        INSERT INTO messages (id, conversation_id, from_kind, from_agent_id, from_user_id, content, seq, created_at)
        VALUES ('m_agent', 'c1', 'agent', 'a_kept', NULL, 'by kept agent', 1, ${now});

        -- Message by a live user.
        INSERT INTO messages (id, conversation_id, from_kind, from_agent_id, from_user_id, content, seq, created_at)
        VALUES ('m_user', 'c1', 'user', NULL, 'u1', 'by user', 2, ${now});

        -- System message: no author on either axis.
        INSERT INTO messages (id, conversation_id, from_kind, from_agent_id, from_user_id, content, seq, created_at)
        VALUES ('m_system', 'c1', 'system', NULL, NULL, 'system notice', 3, ${now});

        -- Message by an agent that is hard-deleted BEFORE the migration runs:
        -- ON DELETE SET NULL wipes from_agent_id, leaving nothing to snapshot.
        INSERT INTO messages (id, conversation_id, from_kind, from_agent_id, from_user_id, content, seq, created_at)
        VALUES ('m_pre', 'c1', 'agent', 'a_pre', NULL, 'by pre-deleted agent', 4, ${now});
      `);
      // Hard-delete a_pre BEFORE the migration — its message loses the FK now.
      db.prepare(`DELETE FROM agents WHERE id = 'a_pre'`).run();
      return { now };
    }

    /** Read a message's author-bearing columns back as the resolver's row shape. */
    function authorRow(db: Database.Database, id: string): MessageAuthorRow {
      return db
        .prepare<[string], MessageAuthorRow>(
          `SELECT from_kind, from_agent_id, from_user_id,
                  author_id, author_name, author_display_name
             FROM messages WHERE id = ?`,
        )
        .get(id)!;
    }

    it('backfills the author snapshot from live authority at migration time (best effort), leaves system + already-deleted rows NULL, and the snapshot survives a later delete → resolver says deleted', () => {
      const db = openDbAt(62);
      try {
        seedV62(db);

        applyMigrationsThrough(db, 63);

        // Live agent + live user rows are backfilled with a complete snapshot.
        expect(authorRow(db, 'm_agent')).toEqual({
          from_kind: 'agent',
          from_agent_id: 'a_kept',
          from_user_id: null,
          author_id: 'a_kept',
          author_name: 'kept-agent',
          author_display_name: 'Kept Agent',
        });
        expect(authorRow(db, 'm_user')).toEqual({
          from_kind: 'user',
          from_agent_id: null,
          from_user_id: 'u1',
          author_id: 'u1',
          author_name: 'u1',
          author_display_name: 'User One',
        });

        // System row: all three snapshot columns stay NULL.
        expect(authorRow(db, 'm_system')).toMatchObject({
          author_id: null,
          author_name: null,
          author_display_name: null,
        });

        // Row whose actor was ALREADY deleted before the migration: FK was nulled,
        // so the backfill has nothing to copy → snapshot stays NULL → unresolved
        // (we NEVER fabricate an identity that was never captured).
        const preRow = authorRow(db, 'm_pre');
        expect(preRow).toMatchObject({
          from_agent_id: null,
          author_id: null,
          author_name: null,
          author_display_name: null,
        });
        expect(resolveMessageAuthor(preRow, null)).toEqual({
          kind: 'agent',
          status: 'unresolved',
          id: null,
          name: null,
          display_name: null,
          avatar_url: null,
        });

        // Now hard-delete the still-live agent AFTER the migration: ON DELETE SET
        // NULL wipes the FK, but the backfilled snapshot survives → the resolver
        // classifies the row as `deleted`, naming the gone actor from the snapshot.
        db.prepare(`DELETE FROM agents WHERE id = 'a_kept'`).run();
        const deletedRow = authorRow(db, 'm_agent');
        expect(deletedRow).toMatchObject({
          from_agent_id: null,
          author_id: 'a_kept',
          author_name: 'kept-agent',
          author_display_name: 'Kept Agent',
        });
        expect(resolveMessageAuthor(deletedRow, null)).toEqual({
          kind: 'agent',
          status: 'deleted',
          id: 'a_kept',
          name: 'kept-agent',
          display_name: 'Kept Agent',
          avatar_url: null,
        });
      } finally {
        db.close();
      }
    });
  });

  describe('v64 drop_workspace_local_binding_columns', () => {
    const now = 1_700_000_000_000;

    // Seed a POPULATED v63 DB (the migration's real input): a regular + an
    // agent_home workspace, public / private / archived / pinned conversations,
    // and representative child rows across both rebuilt tables. The migration
    // rebuilds `conversations` (child) then `workspaces` (parent); this proves
    // no field, row, FK, index, or CHECK is lost across the two rebuilds.
    function seedV63(db: Database.Database): void {
      db.exec(`
        INSERT INTO hosts (id, name, kind, created_at)
          VALUES ('host_local', 'local', 'local', ${now});
        INSERT INTO users (id, name, display_name, created_at, updated_at)
          VALUES ('u_local', 'local', 'Local', ${now}, ${now});
        INSERT INTO agents
          (id, name, runtime, host_id, created_by_user_id, created_at, updated_at)
          VALUES
            ('agent_home_owner', 'homie', 'claude', 'host_local', 'u_local', ${now}, ${now}),
            ('agent_member',     'memb',  'claude', 'host_local', 'u_local', ${now}, ${now});

        INSERT INTO workspaces
          (id, name, description, workspace_kind, workspace_path, workspace_host_id,
           owner_agent_id, archived_at, created_at, updated_at, pinned_at, owner_user_id)
        VALUES
          ('ws_reg', 'Regular', 'desc', 'regular', '/tmp/ws_reg', 'host_local',
           NULL, NULL, ${now}, ${now}, ${now}, 'u_local'),
          ('ws_home', 'home', NULL, 'agent_home', '/tmp/ws_home', 'host_local',
           'agent_home_owner', NULL, ${now}, ${now}, NULL, NULL);

        INSERT INTO workspace_members (workspace_id, agent_id, joined_at)
          VALUES ('ws_reg', 'agent_member', ${now});

        INSERT INTO conversations
          (id, workspace_id, workspace_path, kind, title, status, spawned_by_agent_id,
           closed_at, close_summary, pinned_at, created_at, updated_at, archived_at,
           latest_message_seq, visibility)
        VALUES
          ('c_public',   'ws_reg',  '/tmp/ws_reg',  'channel',    'public',   'idle',   NULL, NULL, NULL,   NULL,   ${now}, ${now}, NULL,   3, 'public'),
          ('c_private',  'ws_reg',  '/tmp/ws_reg',  'channel',    'private',  'idle',   NULL, NULL, NULL,   ${now}, ${now}, ${now}, NULL,   0, 'private'),
          ('c_archived', 'ws_reg',  '/tmp/ws_reg',  'channel',    'archived', 'closed', NULL, ${now}, 'done', NULL, ${now}, ${now}, ${now}, 0, 'private'),
          ('c_dm',       'ws_home', '/tmp/ws_home', 'dm_channel', 'dm',       'idle',   NULL, NULL, NULL,   NULL,   ${now}, ${now}, NULL,   0, 'private');

        INSERT INTO messages (id, conversation_id, from_kind, content, seq, created_at)
          VALUES ('m1', 'c_public', 'system', 'hello', 1, ${now});
        INSERT INTO conversation_events (conversation_id, agent_id, kind, payload, created_at)
          VALUES ('c_archived', NULL, 'archived', NULL, ${now});
      `);
    }

    it('drops workspace_path AND workspace_host_id, preserves every row/child/FK, keeps all indexes + CHECKs', () => {
      const db = openDbAt(63);
      try {
        seedV63(db);

        applyMigrationsThrough(db, 64);
        expect(
          db.prepare(`SELECT version FROM _migrations WHERE version = 64`).get(),
        ).toBeDefined();

        // ── columns: both local-binding columns gone ───────────────────────
        const convCols = db
          .prepare<[], { name: string }>(`PRAGMA table_info(conversations)`)
          .all()
          .map(r => r.name);
        expect(convCols).not.toContain('workspace_path');
        expect(convCols).toEqual(
          expect.arrayContaining([
            'id', 'workspace_id', 'kind', 'title', 'status',
            'spawned_by_agent_id', 'closed_at', 'close_summary', 'pinned_at',
            'created_at', 'updated_at', 'archived_at', 'latest_message_seq',
            'visibility',
          ]),
        );

        const wsCols = db
          .prepare<[], { name: string }>(`PRAGMA table_info(workspaces)`)
          .all()
          .map(r => r.name);
        expect(wsCols).not.toContain('workspace_path');
        // relocation-v1 §6 — ONE removal set, ONE rebuild: `workspace_host_id`
        // (#task:1808) retires in the SAME v64 as `workspace_path` (#task:1807),
        // so neither column may survive this migration. This is the falsifier
        // for the two-column atomic cut: if a future edit re-splits the removal
        // into v64+v65, this assertion fails at v64.
        expect(wsCols).not.toContain('workspace_host_id');
        // …and the FK it carried is gone with it: `workspace_host_id`'s
        // `REFERENCES hosts(id) ON DELETE RESTRICT` was what made a workspace
        // row block a computer delete. After v64 no workspaces FK points at
        // hosts at all (relocation-v1 I1: a workspace has no owning computer).
        expect(
          db
            .prepare<[], { table: string }>(`PRAGMA foreign_key_list(workspaces)`)
            .all()
            .map(r => r.table),
        ).not.toContain('hosts');
        expect(wsCols).toEqual(
          expect.arrayContaining([
            'id', 'name', 'description', 'workspace_kind',
            'owner_agent_id', 'archived_at', 'created_at', 'updated_at',
            'pinned_at', 'owner_user_id',
          ]),
        );

        // ── every workspace row + its surviving values survive ─────────────
        expect(
          db
            .prepare(
              `SELECT id, workspace_kind, owner_agent_id,
                      owner_user_id, pinned_at
                 FROM workspaces ORDER BY id`,
            )
            .all(),
        ).toEqual([
          {
            id: 'ws_home', workspace_kind: 'agent_home',
            owner_agent_id: 'agent_home_owner', owner_user_id: null, pinned_at: null,
          },
          {
            id: 'ws_reg', workspace_kind: 'regular',
            owner_agent_id: null, owner_user_id: 'u_local', pinned_at: now,
          },
        ]);

        // ── every conversation row + kind/visibility/archived/pinned survive ─
        expect(
          db
            .prepare(
              `SELECT id, workspace_id, kind, visibility,
                      archived_at IS NOT NULL AS archived,
                      pinned_at   IS NOT NULL AS pinned
                 FROM conversations ORDER BY id`,
            )
            .all(),
        ).toEqual([
          { id: 'c_archived', workspace_id: 'ws_reg',  kind: 'channel',    visibility: 'private', archived: 1, pinned: 0 },
          { id: 'c_dm',       workspace_id: 'ws_home', kind: 'dm_channel', visibility: 'private', archived: 0, pinned: 0 },
          { id: 'c_private',  workspace_id: 'ws_reg',  kind: 'channel',    visibility: 'private', archived: 0, pinned: 1 },
          { id: 'c_public',   workspace_id: 'ws_reg',  kind: 'channel',    visibility: 'public',  archived: 0, pinned: 0 },
        ]);

        // ── children of both rebuilt tables survive ────────────────────────
        expect(
          db.prepare(`SELECT conversation_id, content, seq FROM messages WHERE id = 'm1'`).get(),
        ).toEqual({ conversation_id: 'c_public', content: 'hello', seq: 1 });
        expect(
          db
            .prepare(`SELECT conversation_id, kind FROM conversation_events WHERE conversation_id = 'c_archived'`)
            .get(),
        ).toEqual({ conversation_id: 'c_archived', kind: 'archived' });
        expect(
          db.prepare(`SELECT workspace_id, agent_id FROM workspace_members`).all(),
        ).toEqual([{ workspace_id: 'ws_reg', agent_id: 'agent_member' }]);

        // ── no FK relationship broke across parent+child rebuild ───────────
        expect(db.pragma('foreign_key_check')).toEqual([]);

        // ── every index is reproduced, none extra dropped ──────────────────
        const convIdx = db
          .prepare<[], { name: string }>(
            `SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'conversations' AND name NOT LIKE 'sqlite_%'`,
          )
          .all()
          .map(r => r.name)
          .sort();
        expect(convIdx).toEqual([
          'idx_conversations_archived_at',
          'idx_conversations_status',
          'idx_conversations_workspace',
        ]);
        const wsIdx = db
          .prepare<[], { name: string }>(
            `SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'workspaces' AND name NOT LIKE 'sqlite_%'`,
          )
          .all()
          .map(r => r.name)
          .sort();
        expect(wsIdx).toEqual([
          'idx_workspaces_pinned_at',
          'workspaces_regular_name_unique',
        ]);

        // ── surviving CHECKs / unique index still enforce (post-rebuild) ───
        // visibility CHECK: a public dm_channel is rejected.
        expect(() =>
          db.exec(`
            INSERT INTO conversations
              (id, workspace_id, kind, title, status, spawned_by_agent_id,
               closed_at, close_summary, pinned_at, created_at, updated_at,
               archived_at, latest_message_seq, visibility)
            VALUES ('c_badvis', 'ws_reg', 'dm_channel', 'bad', 'idle', NULL,
                    NULL, NULL, NULL, ${now}, ${now}, NULL, 0, 'public')
          `),
        ).toThrow(/CHECK/);
        // regular-name unique: a second 'regular' named 'Regular' is rejected.
        expect(() =>
          db.exec(`
            INSERT INTO workspaces
              (id, name, description, workspace_kind,
               owner_agent_id, archived_at, created_at, updated_at, pinned_at, owner_user_id)
            VALUES ('ws_dup', 'Regular', NULL, 'regular',
                    NULL, NULL, ${now}, ${now}, NULL, NULL)
          `),
        ).toThrow(/UNIQUE/);
        // agent_home owner CHECK: an agent_home with a NULL owner is rejected.
        expect(() =>
          db.exec(`
            INSERT INTO workspaces
              (id, name, description, workspace_kind,
               owner_agent_id, archived_at, created_at, updated_at, pinned_at, owner_user_id)
            VALUES ('ws_badhome', 'badhome', NULL, 'agent_home',
                    NULL, NULL, ${now}, ${now}, NULL, NULL)
          `),
        ).toThrow(/CHECK/);
      } finally {
        db.close();
      }
    });
  });

  describe('v65 attention_mute_tier_and_workspace_suppressor', () => {
    const now = 1_700_000_000_000;

    // Seed a POPULATED v64 DB — the migration's real input. The `mute` tier
    // arrives by REBUILDING `channel_attention_preferences` (SQLite cannot ALTER
    // a CHECK), and a rebuild's two failure modes are invisible to a schema
    // snapshot: existing rows silently dropped/altered, and triggers not
    // recreated on the new table. Both are asserted below.
    function seedV64(db: Database.Database): void {
      db.exec(`
        INSERT INTO hosts (id, name, kind, created_at)
          VALUES ('host_local', 'local', 'local', ${now});
        INSERT INTO users (id, name, display_name, created_at, updated_at)
          VALUES
            ('u_one', 'one', 'One', ${now}, ${now}),
            ('u_two', 'two', 'Two', ${now}, ${now});
        INSERT INTO agents
          (id, name, runtime, host_id, created_by_user_id, created_at, updated_at)
          VALUES ('agent_home_owner', 'homie', 'claude', 'host_local', 'u_one', ${now}, ${now});

        INSERT INTO workspaces
          (id, name, description, workspace_kind,
           owner_agent_id, archived_at, created_at, updated_at, pinned_at, owner_user_id)
        VALUES
          ('ws_reg',  'Regular', NULL, 'regular',    NULL, NULL, ${now}, ${now}, NULL, 'u_one'),
          ('ws_home', 'home',    NULL, 'agent_home', 'agent_home_owner', NULL, ${now}, ${now}, NULL, NULL);

        INSERT INTO conversations
          (id, workspace_id, kind, title, status, spawned_by_agent_id,
           closed_at, close_summary, pinned_at, created_at, updated_at,
           archived_at, latest_message_seq, visibility)
        VALUES
          ('c_one', 'ws_reg',  'channel',    'one', 'idle', NULL, NULL, NULL, NULL, ${now}, ${now}, NULL, 0, 'private'),
          ('c_two', 'ws_reg',  'channel',    'two', 'idle', NULL, NULL, NULL, NULL, ${now}, ${now}, NULL, 0, 'private'),
          ('c_dm',  'ws_home', 'dm_channel', 'dm',  'idle', NULL, NULL, NULL, NULL, ${now}, ${now}, NULL, 0, 'private');

        -- Both legal v64 tier values, distinct updated_at, and two users on the
        -- same channel so the composite PK's rows are all observable.
        INSERT INTO channel_attention_preferences
          (user_id, conversation_id, mode, updated_at)
        VALUES
          ('u_one', 'c_one', 'all',      ${now + 1}),
          ('u_one', 'c_two', 'mentions', ${now + 2}),
          ('u_two', 'c_one', 'mentions', ${now + 3});
      `);
    }

    it('preserves every stored tier + updated_at, opens the mute tier, and re-arms all four scope triggers', () => {
      const db = openDbAt(64);
      try {
        seedV64(db);
        // The pre-upgrade state is the v64 contract: 'mute' is NOT yet legal.
        expect(() =>
          db.exec(
            `UPDATE channel_attention_preferences SET mode = 'mute' WHERE conversation_id = 'c_one'`,
          ),
        ).toThrow(/CHECK/);

        applyMigrationsThrough(db, 65);
        expect(
          db.prepare(`SELECT version FROM _migrations WHERE version = 65`).get(),
        ).toBeDefined();

        // ── existing rows survive the rebuild BYTE-FOR-BYTE ────────────────
        // `updated_at` included on purpose: the suppressor is a pure addition
        // (§6 — no backfill, no re-read), so not one existing row may be
        // rewritten or re-stamped by this migration.
        expect(
          db
            .prepare(
              `SELECT user_id, conversation_id, mode, updated_at
                 FROM channel_attention_preferences
                ORDER BY user_id, conversation_id`,
            )
            .all(),
        ).toEqual([
          { user_id: 'u_one', conversation_id: 'c_one', mode: 'all',      updated_at: now + 1 },
          { user_id: 'u_one', conversation_id: 'c_two', mode: 'mentions', updated_at: now + 2 },
          { user_id: 'u_two', conversation_id: 'c_one', mode: 'mentions', updated_at: now + 3 },
        ]);

        // ── the third tier is now writable, and only the three are legal ───
        db.exec(
          `UPDATE channel_attention_preferences SET mode = 'mute', updated_at = ${now + 4}
            WHERE user_id = 'u_one' AND conversation_id = 'c_one'`,
        );
        expect(
          db
            .prepare<[], { mode: string }>(
              `SELECT mode FROM channel_attention_preferences
                WHERE user_id = 'u_one' AND conversation_id = 'c_one'`,
            )
            .get()?.mode,
        ).toBe('mute');
        expect(() =>
          db.exec(
            `INSERT INTO channel_attention_preferences (user_id, conversation_id, mode, updated_at)
             VALUES ('u_two', 'c_two', 'silent', ${now})`,
          ),
        ).toThrow(/CHECK/);

        // ── both channel-only triggers exist ON THE REBUILT TABLE ─────────
        // A rebuild that forgets to recreate them leaves a table that accepts
        // meaningless dead state (a pref on a DM), which no fresh-schema
        // snapshot would notice.
        expect(() =>
          db.exec(
            `INSERT INTO channel_attention_preferences (user_id, conversation_id, mode, updated_at)
             VALUES ('u_one', 'c_dm', 'mute', ${now})`,
          ),
        ).toThrow(/must reference a regular channel/);
        expect(() =>
          db.exec(
            `UPDATE channel_attention_preferences SET conversation_id = 'c_dm'
              WHERE user_id = 'u_one' AND conversation_id = 'c_two'`,
          ),
        ).toThrow(/must reference a regular channel/);

        // ── the rebuilt FK still cascades (declared ≠ wired) ──────────────
        db.exec(`DELETE FROM conversations WHERE id = 'c_two'`);
        expect(
          db
            .prepare<[], { c: number }>(
              `SELECT COUNT(*) AS c FROM channel_attention_preferences
                WHERE conversation_id = 'c_two'`,
            )
            .get()?.c,
        ).toBe(0);
        expect(db.pragma('foreign_key_check')).toEqual([]);

        // ── the new suppressor table: regular-only on INSERT and UPDATE ───
        db.exec(
          `INSERT INTO workspace_attention_preferences (user_id, workspace_id, muted, updated_at)
           VALUES ('u_one', 'ws_reg', 1, ${now})`,
        );
        expect(
          db
            .prepare<[], { muted: number }>(
              `SELECT muted FROM workspace_attention_preferences
                WHERE user_id = 'u_one' AND workspace_id = 'ws_reg'`,
            )
            .get()?.muted,
        ).toBe(1);
        // An agent_home workspace hosts DMs, which are directed-grade and have no
        // ambient tier to suppress — a row there is dead state, so the DB fails
        // loud rather than storing it.
        expect(() =>
          db.exec(
            `INSERT INTO workspace_attention_preferences (user_id, workspace_id, muted, updated_at)
             VALUES ('u_one', 'ws_home', 1, ${now})`,
          ),
        ).toThrow(/must reference a regular workspace/);
        expect(() =>
          db.exec(
            `UPDATE workspace_attention_preferences SET workspace_id = 'ws_home'
              WHERE user_id = 'u_one' AND workspace_id = 'ws_reg'`,
          ),
        ).toThrow(/must reference a regular workspace/);
        expect(() =>
          db.exec(
            `INSERT INTO workspace_attention_preferences (user_id, workspace_id, muted, updated_at)
             VALUES ('u_two', 'ws_reg', 2, ${now})`,
          ),
        ).toThrow(/CHECK/);

        // ── indexes: the rebuilt table's is reproduced, the new one exists ─
        expect(
          db
            .prepare<[], { name: string }>(
              `SELECT name FROM sqlite_schema
                WHERE type = 'index'
                  AND tbl_name IN ('channel_attention_preferences',
                                   'workspace_attention_preferences')
                  AND name NOT LIKE 'sqlite_%'`,
            )
            .all()
            .map(r => r.name)
            .sort(),
        ).toEqual([
          'idx_channel_attention_prefs_conversation',
          'idx_workspace_attention_prefs_workspace',
        ]);
      } finally {
        db.close();
      }
    });
  });
});

describe('v70 runtime slots scoped authority (#task:2013)', () => {
  it('migrates every membership runtime row exactly once and enforces scope authority', () => {
    const db = openDbAt(68);
    try {
      db.exec(`
        INSERT INTO users (
          id, name, display_name, created_at, updated_at
        ) VALUES ('u_runtime', 'runtime-owner', 'Runtime Owner', 1, 1);
        INSERT INTO hosts (
          id, name, kind, created_at, user_id
        ) VALUES ('h_runtime', 'runtime-host', 'local', 1, 'u_runtime');
        INSERT INTO agents (
          id, name, display_name, runtime, host_id, created_by_user_id,
          materialization_status, created_at, updated_at
        ) VALUES
          ('a_one', 'runtime-one', 'Runtime One', 'codex', 'h_runtime',
           'u_runtime', 'active', 1, 1),
          ('a_two', 'runtime-two', 'Runtime Two', 'claude', 'h_runtime',
           'u_runtime', 'active', 2, 2);
        INSERT INTO workspaces (
          id, name, description, workspace_kind, owner_agent_id,
          created_at, updated_at
        ) VALUES ('w_runtime', 'Runtime', NULL, 'regular', NULL, 1, 1);
        INSERT INTO conversations (
          id, workspace_id, kind, title, status,
          created_at, updated_at, visibility
        ) VALUES
          ('c_one', 'w_runtime', 'channel', 'One', 'open', 1, 1, 'private'),
          ('c_two', 'w_runtime', 'dm_channel', 'Two', 'open', 2, 2, 'private');
        INSERT INTO conversation_agents (
          conversation_id, agent_id, cli_session_id, pid, status, joined_at
        ) VALUES
          ('c_one', 'a_one', 'resume-one', 101, 'active', 11),
          ('c_two', 'a_one', NULL, NULL, 'crashed', 12),
          ('c_one', 'a_two', 'resume-two', 202, 'starting', 13);
      `);

      applyMigrationsThrough(db, 70);

      expect(
        db
          .prepare<[], { name: string }>('PRAGMA table_info(conversation_agents)')
          .all()
          .map(row => row.name),
      ).toEqual(['conversation_id', 'agent_id', 'joined_at']);
      expect(
        db
          .prepare(
            `SELECT conversation_id, agent_id, joined_at
               FROM conversation_agents
              ORDER BY conversation_id, agent_id`,
          )
          .all(),
      ).toEqual([
        { conversation_id: 'c_one', agent_id: 'a_one', joined_at: 11 },
        { conversation_id: 'c_one', agent_id: 'a_two', joined_at: 13 },
        { conversation_id: 'c_two', agent_id: 'a_one', joined_at: 12 },
      ]);
      expect(
        db
          .prepare(
            `SELECT agent_id, conversation_id, generation,
                    claimed_by_daemon_instance_id, observed_status,
                    observed_pid, cli_session_id
               FROM agent_runtime_slots
              ORDER BY conversation_id, agent_id`,
          )
          .all(),
      ).toEqual([
        {
          agent_id: 'a_one',
          conversation_id: 'c_one',
          generation: 0,
          claimed_by_daemon_instance_id: null,
          observed_status: 'active',
          observed_pid: 101,
          cli_session_id: 'resume-one',
        },
        {
          agent_id: 'a_two',
          conversation_id: 'c_one',
          generation: 0,
          claimed_by_daemon_instance_id: null,
          observed_status: 'starting',
          observed_pid: 202,
          cli_session_id: 'resume-two',
        },
        {
          agent_id: 'a_one',
          conversation_id: 'c_two',
          generation: 0,
          claimed_by_daemon_instance_id: null,
          observed_status: 'crashed',
          observed_pid: null,
          cli_session_id: null,
        },
      ]);
      expect(
        db
          .prepare<[], { count: number }>(
            `SELECT COUNT(*) AS count FROM agent_runtime_events
              WHERE event_kind = 'slot_migrated'`,
          )
          .get()?.count,
      ).toBe(3);
      expect(
        db
          .prepare<[], { session_scope: string }>(
            'SELECT DISTINCT session_scope FROM agents',
          )
          .all(),
      ).toEqual([{ session_scope: 'conversation' }]);
      expect(() =>
        db.exec(`UPDATE agents SET session_scope = 'agent' WHERE id = 'a_one'`),
      ).toThrow(/session_scope is immutable/);

      db.exec(`
        INSERT INTO conversations (
          id, workspace_id, placement_kind, roster_policy, title, status,
          created_at, updated_at, visibility
        ) VALUES (
          'c_three', 'w_runtime', 'workspace', 'open', 'Three', 'open',
          3, 3, 'private'
        );
        INSERT INTO conversation_agents (conversation_id, agent_id, joined_at)
        VALUES ('c_three', 'a_one', 14);
      `);
      expect(
        db
          .prepare<[], { count: number }>(
            `SELECT COUNT(*) AS count FROM agent_runtime_slots
              WHERE agent_id = 'a_one' AND conversation_id = 'c_three'`,
          )
          .get()?.count,
      ).toBe(1);
      expect(() =>
        db.exec(`
          INSERT INTO agent_runtime_slots (agent_id, conversation_id)
          VALUES ('a_one', NULL)
        `),
      ).toThrow(/scope must match/);
      expect(() =>
        db.exec(`
          INSERT INTO agent_runtime_slots (agent_id, conversation_id)
          VALUES ('a_one', 'c_one')
        `),
      ).toThrow(/UNIQUE/);
      expect(() =>
        db.exec(`
          UPDATE agent_runtime_slots SET generation = generation + 2
          WHERE agent_id = 'a_one' AND conversation_id = 'c_one'
        `),
      ).toThrow(/generation must advance by one/);
      expect(() =>
        db.exec(`
          UPDATE agent_runtime_slots SET generation = generation - 1
          WHERE agent_id = 'a_one' AND conversation_id = 'c_one'
        `),
      ).toThrow(/generation must advance by one/);

      db.exec(`
        INSERT INTO agents (
          id, name, display_name, runtime, host_id, created_by_user_id,
          materialization_status, created_at, updated_at, session_scope
        ) VALUES (
          'a_scoped', 'runtime-scoped', 'Runtime Scoped', 'codex',
          'h_runtime', 'u_runtime', 'active', 3, 3, 'agent'
        );
        INSERT INTO conversation_agents (conversation_id, agent_id, joined_at)
        VALUES ('c_one', 'a_scoped', 15);
      `);
      expect(
        db
          .prepare<[], { conversation_id: string | null }>(
            `SELECT conversation_id FROM agent_runtime_slots
              WHERE agent_id = 'a_scoped'`,
          )
          .all(),
      ).toEqual([{ conversation_id: null }]);
      expect(() =>
        db.exec(`
          INSERT INTO agent_runtime_slots (agent_id, conversation_id)
          VALUES ('a_scoped', 'c_one')
        `),
      ).toThrow(/scope must match/);
      expect(() =>
        db.exec(`
          INSERT INTO agent_runtime_slots (agent_id, conversation_id)
          VALUES ('a_scoped', NULL)
        `),
      ).toThrow(/UNIQUE/);

      const migratedEventId = db
        .prepare<[], { id: number }>(
          `SELECT id FROM agent_runtime_events ORDER BY id LIMIT 1`,
        )
        .get()!.id;
      expect(() =>
        db.prepare('UPDATE agent_runtime_events SET occurred_at = 0 WHERE id = ?')
          .run(migratedEventId),
      ).toThrow(/append-only/);
      expect(() =>
        db.prepare('DELETE FROM agent_runtime_events WHERE id = ?').run(migratedEventId),
      ).toThrow(/append-only/);
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
    }
  });
});

/**
 * v75 runtime slots placement aware (#task:2020, P3) — the migration that makes a
 * SEAT belong to PARTICIPATION instead of to the roster.
 *
 * v70 shipped the slot table while `conversation_agents` was still the only
 * participation edge, so it tied the two together twice: a composite FK to the
 * roster (a ConversationSlot could not EXIST without a roster row) and a single
 * roster-INSERT creation trigger (a ConversationSlot could not be BORN any other
 * way). §4.2 gives `direct_pair` and `agent_inbox` zero roster rows, so on the
 * unified P2+P3 model those two arms could hold no seat at all — a session
 * running in a DM was invisible to switch / stop / teardown / session
 * management, and no honest fixture could even construct one.
 *
 * The assertions below are ordered as the three things that must all hold at
 * once, because fixing any one alone reintroduces the others:
 *   1. the REBUILD is lossless — same rows, same ids (`agent_runtime_events`
 *      points at `slot_id` with no FK, so a renumbering would silently detach
 *      every historical event), and the roster FK is gone from the survivor;
 *   2. the BACKFILL gives the two rosterless arms the seats they could never
 *      have had, exactly once, without re-stamping a birth event on the slots
 *      that already had one;
 *   3. the CREATION and RELEASE triggers are placement-gated in agreement: each
 *      arm's own participation edge mints its seat, and a stray roster row on a
 *      rosterless placement neither mints nor destroys one.
 */
describe('v75 runtime slots placement aware (#task:2020)', () => {
  it('rebuilds without the roster FK, backfills the rosterless arms once, and gates every seat on its own participation edge', () => {
    // Seeded at v69 and carried up through the REAL migrations rather than
    // assembled at v74. A hand-built v74 fixture looks identical and is not: its
    // slots were made by triggers, so their ids were a dense 1..n and none of
    // them carried an event. Id preservation was then true by coincidence — an
    // AUTOINCREMENT renumbering maps 1..n onto itself — and survived its own
    // falsifier. Here v70 migrates the roster payload into the seat and stamps
    // its provenance, v71 mints the inbox, and a deleted agent leaves both a hole
    // in the id sequence and an event pointing at a slot that no longer exists.
    const db = openDbAt(69);
    try {
      db.exec(`
        INSERT INTO users (
          id, name, display_name, created_at, updated_at
        ) VALUES ('u_p', 'placement-owner', 'Placement Owner', 1, 1);
        INSERT INTO hosts (
          id, name, kind, created_at, user_id
        ) VALUES ('h_p', 'placement-host', 'local', 1, 'u_p');
        -- No session_scope column yet: v70 adds it, defaulting every existing
        -- agent to 'conversation'. The agent-scoped arm is created after it.
        INSERT INTO agents (
          id, name, display_name, runtime, host_id, created_by_user_id,
          materialization_status, created_at, updated_at
        ) VALUES
          ('a_conv', 'placement-conv', 'Conv', 'claude', 'h_p', 'u_p',
           'active', 1, 1),
          ('a_gone', 'placement-gone', 'Gone', 'claude', 'h_p', 'u_p',
           'active', 2, 2);
        INSERT INTO workspaces (
          id, name, description, workspace_kind, owner_agent_id,
          created_at, updated_at
        ) VALUES ('w_p', 'Placement', NULL, 'regular', NULL, 1, 1);
        INSERT INTO conversations (
          id, workspace_id, placement_kind, roster_policy, title, status,
          created_at, updated_at, visibility
        ) VALUES (
          'c_chan', 'w_p', 'workspace', 'open', 'chan', 'open', 1, 1, 'private'
        );
        -- At v69 the runtime payload still lives ON the roster row; v70 is what
        -- moves it into a slot and records where it came from. TWO rows, because
        -- the second one's seat is deleted below to leave a GAP.
        INSERT INTO conversation_agents (
          conversation_id, agent_id, joined_at, cli_session_id, pid, status
        ) VALUES
          ('c_chan', 'a_conv', 10, 'resume-chan', 4242, 'active'),
          ('c_chan', 'a_gone', 11, NULL, NULL, 'idle');
      `);

      applyMigrationsThrough(db, 74);

      db.exec(`
        -- Custody is not a roster column, so v70 had nothing to migrate into it:
        -- it is set here, and the rebuild has to carry it too.
        UPDATE agent_runtime_slots
           SET claimed_by_daemon_instance_id = 'daemon-1'
         WHERE agent_id = 'a_conv' AND conversation_id = 'c_chan';
        -- The hole: an agent aggregate dies and takes its seat and its v71 inbox
        -- with it. AUTOINCREMENT never hands that id back, so the surviving ids
        -- are no longer 1..n and a rebuild that dropped \`id\` would renumber
        -- them visibly.
        DELETE FROM agents WHERE id = 'a_gone';
        -- The agent-scoped arm. Created after v71, so it has NO inbox — which is
        -- why its coverage below is one aggregate seat and nothing else.
        INSERT INTO agents (
          id, name, display_name, runtime, host_id, created_by_user_id,
          materialization_status, created_at, updated_at, session_scope
        ) VALUES (
          'a_scoped', 'placement-scoped', 'Scoped', 'claude', 'h_p', 'u_p',
          'active', 3, 3, 'agent'
        );
        -- The DM, in v74's shape: endpoints are typed columns in v73's canonical
        -- order, and v74 derives \`pair_key\` from them.
        INSERT INTO conversations (
          id, workspace_id, placement_kind, roster_policy, title, status,
          created_at, updated_at, visibility,
          endpoint_a_kind, endpoint_a_id, endpoint_b_kind, endpoint_b_id
        ) VALUES (
          'c_pair', NULL, 'direct_pair', 'fixed', '', 'open', 4, 4, 'private',
          'agent', 'a_conv', 'human', 'u_p'
        );
      `);

      // v71's inbox for `a_conv`, by its production-minted id: nothing here
      // hand-builds an inbox, so its absence from the seat table below is the
      // real dogfood state and not a fixture choice.
      const inboxRow = db
        .prepare<[], { id: string }>(
          `SELECT id FROM conversations WHERE inbox_agent_id = 'a_conv'`,
        )
        .get();
      expect(inboxRow).toBeDefined();
      const inboxId = inboxRow!.id;
      // Seats as sorted keys, because the inbox id is minted at random and an
      // `ORDER BY conversation_id` would otherwise make the expectation depend
      // on which bytes it drew.
      const seatKeys = () =>
        db
          .prepare<[], { agent_id: string; conversation_id: string | null }>(
            'SELECT agent_id, conversation_id FROM agent_runtime_slots',
          )
          .all()
          .map(r => `${r.agent_id}:${r.conversation_id ?? '(agent)'}`)
          .sort();

      // THE DEFECT, stated as the precondition: `a_conv` participates in three
      // placements and holds a seat in exactly the one with a roster row.
      expect(seatKeys()).toEqual(['a_conv:c_chan', 'a_scoped:(agent)']);
      const slotIdsBefore = db
        .prepare<[], { id: number; agent_id: string }>(
          'SELECT id, agent_id FROM agent_runtime_slots ORDER BY id',
        )
        .all();
      // The hole, asserted: without it the id-preservation check below cannot
      // fail, because renumbering a dense sequence reproduces it exactly.
      expect(slotIdsBefore.map(r => r.id)).toEqual([1, 3]);
      // The two `slot_migrated` rows v70 wrote — one per pre-existing seat. These
      // are the ONLY runtime history in this database, and the second one belongs
      // to the seat deleted above, which is what makes the id-preservation check
      // below falsifiable.
      expect(
        db
          .prepare<[], { slot_id: number; count: number }>(
            `SELECT slot_id, COUNT(*) AS count FROM agent_runtime_events
              WHERE event_kind = 'slot_migrated'
              GROUP BY slot_id ORDER BY slot_id`,
          )
          .all(),
      ).toEqual([
        { slot_id: 1, count: 1 },
        { slot_id: 2, count: 1 },
      ]);
      // v70 tied a slot's existence to a roster row; that FK is what made a
      // rosterless seat unrepresentable rather than merely uncreated. (The
      // composite FK reports one row per column, hence the dedupe.)
      expect(
        [
          ...new Set(
            db
              .prepare<[], { table: string }>(
                'PRAGMA foreign_key_list(agent_runtime_slots)',
              )
              .all()
              .map(r => r.table),
          ),
        ].sort(),
      ).toEqual(['agents', 'conversation_agents', 'conversations']);

      applyMigrationsThrough(db, 75);

      // 1a. The survivor references only the two real owners of a seat's
      //     identity. Nothing about membership can reach it any more.
      expect(
        db
          .prepare<[], { table: string; on_delete: string }>(
            'PRAGMA foreign_key_list(agent_runtime_slots)',
          )
          .all()
          .map(r => ({ table: r.table, on_delete: r.on_delete }))
          .sort((x, y) => x.table.localeCompare(y.table)),
      ).toEqual([
        { table: 'agents', on_delete: 'CASCADE' },
        { table: 'conversations', on_delete: 'CASCADE' },
      ]);
      // 1b. Lossless, ids included: `agent_runtime_events.slot_id` is an FK-less
      //     historical coordinate, so a renumbering would detach every event
      //     ever written without a single constraint noticing.
      expect(
        db
          .prepare<[], { id: number; agent_id: string }>(
            `SELECT id, agent_id FROM agent_runtime_slots
              WHERE agent_id IN ('a_conv', 'a_scoped')
                AND (conversation_id = 'c_chan' OR conversation_id IS NULL)
              ORDER BY id`,
          )
          .all(),
      ).toEqual(slotIdsBefore);
      expect(
        db
          .prepare(
            `SELECT generation, claimed_by_daemon_instance_id, observed_status,
                    observed_pid, cli_session_id
               FROM agent_runtime_slots
              WHERE agent_id = 'a_conv' AND conversation_id = 'c_chan'`,
          )
          .get(),
      ).toEqual({
        generation: 0,
        claimed_by_daemon_instance_id: 'daemon-1',
        observed_status: 'active',
        observed_pid: 4242,
        cli_session_id: 'resume-chan',
      });
      expect(db.pragma('foreign_key_check')).toEqual([]);

      // 2. The backfill: the DM and the inbox now hold exactly one idle seat
      //    each, and the agent-scoped agent gained none (its one AgentSlot
      //    already serves every conversation it participates in).
      expect(seatKeys()).toEqual(
        [
          'a_conv:c_chan',
          `a_conv:${inboxId}`,
          'a_conv:c_pair',
          'a_scoped:(agent)',
        ].sort(),
      );
      expect(
        db
          .prepare(
            `SELECT generation, observed_status, observed_pid, cli_session_id
               FROM agent_runtime_slots WHERE conversation_id = 'c_pair'`,
          )
          .get(),
      ).toEqual({
        generation: 0,
        observed_status: 'idle',
        observed_pid: null,
        cli_session_id: null,
      });
      // The seats born here get NO event, and the two v70 wrote are untouched:
      // this log records runtime GENERATIONS, and a seat at generation 0 that no
      // daemon has claimed has none to report. "History from first claim" is the
      // contract; the alternative — a synthetic birth row per seat — would be true
      // for the length of the upgrade and false at the next roster join, since the
      // four creation triggers insert a slot and nothing else.
      expect(
        db
          .prepare<[], { slot_id: number; count: number }>(
            `SELECT slot_id, COUNT(*) AS count FROM agent_runtime_events
              GROUP BY slot_id ORDER BY slot_id`,
          )
          .all(),
      ).toEqual([
        { slot_id: 1, count: 1 },
        { slot_id: 2, count: 1 },
      ]);
      // …and slot 2's event is now an orphan: history is append-only and
      // `slot_id` carries no FK by design. This is the sharp end of 1b — had the
      // rebuild renumbered the survivors into 1..n, `a_scoped`'s seat would have
      // become id 2 and SILENTLY INHERITED a deleted agent's runtime history,
      // with no constraint in the schema able to notice.
      expect(
        db
          .prepare<[], { count: number }>(
            `SELECT COUNT(*) AS count FROM agent_runtime_events e
              WHERE NOT EXISTS (
                SELECT 1 FROM agent_runtime_slots s WHERE s.id = e.slot_id
              )`,
          )
          .get()!.count,
      ).toBe(1);

      // 3a. Each arm's own participation edge mints its seat, at birth. The pair
      //     below has an agent on BOTH sides, so one INSERT must mint two seats:
      //     the trigger's two-sided SELECT is the part a per-endpoint rewrite
      //     would silently halve.
      db.exec(`
        INSERT INTO agents (
          id, name, display_name, runtime, host_id, created_by_user_id,
          materialization_status, created_at, updated_at, session_scope
        ) VALUES (
          'a_conv_z', 'placement-conv-z', 'Conv Z', 'claude', 'h_p', 'u_p',
          'active', 4, 4, 'conversation'
        );
        INSERT INTO conversations (
          id, workspace_id, placement_kind, roster_policy, title, status,
          created_at, updated_at, visibility,
          endpoint_a_kind, endpoint_a_id, endpoint_b_kind, endpoint_b_id
        ) VALUES (
          'c_pair2', NULL, 'direct_pair', 'fixed', '', 'open', 4, 4, 'private',
          'agent', 'a_conv', 'agent', 'a_conv_z'
        );
        INSERT INTO conversations (
          id, workspace_id, inbox_agent_id, placement_kind, roster_policy,
          title, status, created_at, updated_at, visibility
        ) VALUES (
          'c_inbox2', NULL, 'a_conv_z', 'agent_inbox', 'fixed',
          'Mentions', 'open', 5, 5, 'private'
        );
      `);
      expect(
        db
          .prepare<[], { conversation_id: string }>(
            `SELECT conversation_id FROM agent_runtime_slots
              WHERE agent_id = 'a_conv' ORDER BY conversation_id`,
          )
          .all()
          .map(r => r.conversation_id),
      ).toEqual(['c_chan', inboxId, 'c_pair', 'c_pair2'].sort());
      expect(
        db
          .prepare<[], { conversation_id: string }>(
            `SELECT conversation_id FROM agent_runtime_slots
              WHERE agent_id = 'a_conv_z' ORDER BY conversation_id`,
          )
          .all()
          .map(r => r.conversation_id),
      ).toEqual(['c_inbox2', 'c_pair2']);
      // …and an agent-scoped endpoint gets NONE: one aggregate slot serves every
      // pair it is an endpoint of, so a per-pair seat would be a second seat for
      // one process.
      db.exec(`
        INSERT INTO conversations (
          id, workspace_id, placement_kind, roster_policy, title, status,
          created_at, updated_at, visibility,
          endpoint_a_kind, endpoint_a_id, endpoint_b_kind, endpoint_b_id
        ) VALUES (
          'c_pair3', NULL, 'direct_pair', 'fixed', '', 'open', 6, 6, 'private',
          'agent', 'a_scoped', 'human', 'u_p'
        );
      `);
      expect(
        db
          .prepare<[], { conversation_id: string | null }>(
            `SELECT conversation_id FROM agent_runtime_slots
              WHERE agent_id = 'a_scoped'`,
          )
          .all(),
      ).toEqual([{ conversation_id: null }]);
      // The AgentSlot trigger survived the rebuild: dropping it while dropping
      // the roster one would leave every future agent-scoped agent seatless.
      db.exec(`
        INSERT INTO agents (
          id, name, display_name, runtime, host_id, created_by_user_id,
          materialization_status, created_at, updated_at, session_scope
        ) VALUES (
          'a_scoped2', 'placement-scoped-2', 'Scoped 2', 'claude', 'h_p', 'u_p',
          'active', 7, 7, 'agent'
        );
      `);
      expect(
        db
          .prepare<[], { conversation_id: string | null; observed_status: string }>(
            `SELECT conversation_id, observed_status FROM agent_runtime_slots
              WHERE agent_id = 'a_scoped2'`,
          )
          .all(),
      ).toEqual([{ conversation_id: null, observed_status: 'idle' }]);

      // 3b. A stray roster row on a rosterless placement is INERT in BOTH
      //     directions: it mints no second seat, and removing it does not take
      //     the endpoint-owned seat away. An ungated release trigger here would
      //     silently kill a live DM session's only control coordinate.
      db.exec(`
        INSERT INTO conversation_agents (conversation_id, agent_id, joined_at)
          VALUES ('c_pair', 'a_conv', 20);
      `);
      expect(
        db
          .prepare<[], { count: number }>(
            `SELECT COUNT(*) AS count FROM agent_runtime_slots
              WHERE agent_id = 'a_conv' AND conversation_id = 'c_pair'`,
          )
          .get()?.count,
      ).toBe(1);
      db.exec(
        `DELETE FROM conversation_agents
          WHERE conversation_id = 'c_pair' AND agent_id = 'a_conv'`,
      );
      expect(
        db
          .prepare<[], { count: number }>(
            `SELECT COUNT(*) AS count FROM agent_runtime_slots
              WHERE agent_id = 'a_conv' AND conversation_id = 'c_pair'`,
          )
          .get()?.count,
      ).toBe(1);
      // The workspace arm is the one the roster DOES own, so there the release
      // still fires — the two gates have to agree on whose seat that is.
      db.exec(
        `DELETE FROM conversation_agents
          WHERE conversation_id = 'c_chan' AND agent_id = 'a_conv'`,
      );
      expect(
        db
          .prepare<[], { count: number }>(
            `SELECT COUNT(*) AS count FROM agent_runtime_slots
              WHERE agent_id = 'a_conv' AND conversation_id = 'c_chan'`,
          )
          .get()?.count,
      ).toBe(0);

      // The guard triggers came through the rebuild intact — the rebuild
      // recreates them by hand, so "still enforced" is not implied by anything.
      expect(() =>
        db.exec(`
          INSERT INTO agent_runtime_slots (agent_id, conversation_id)
          VALUES ('a_conv', NULL)
        `),
      ).toThrow(/scope must match/);
      expect(() =>
        db.exec(`
          INSERT INTO agent_runtime_slots (agent_id, conversation_id)
          VALUES ('a_conv', 'c_pair')
        `),
      ).toThrow(/UNIQUE/);
      expect(() =>
        db.exec(`
          UPDATE agent_runtime_slots SET generation = generation + 2
          WHERE agent_id = 'a_conv' AND conversation_id = 'c_pair'
        `),
      ).toThrow(/generation must advance by one/);
      expect(() =>
        db.exec(`
          UPDATE agent_runtime_slots SET conversation_id = 'c_pair2'
          WHERE agent_id = 'a_conv' AND conversation_id = 'c_pair'
        `),
      ).toThrow(/identity is immutable/);

      // 4. PARTICIPATION IS THE INVARIANT, not just the creation path. The three
      //    AFTER INSERT triggers above prove a seat is MINTED by a participation
      //    edge; they say nothing about a row that arrives any other way, and the
      //    composite FK that used to refuse one is gone. A forged seat is a forged
      //    control coordinate — stop / switch / teardown would act on it — so the
      //    rule is asserted against a direct writer, once per arm.
      db.exec(`
        INSERT INTO agents (
          id, name, display_name, runtime, host_id, created_by_user_id,
          materialization_status, created_at, updated_at, session_scope
        ) VALUES (
          'a_conv_y', 'placement-conv-y', 'Conv Y', 'claude', 'h_p', 'u_p',
          'active', 8, 8, 'conversation'
        );
      `);
      const forgeSeat = (agentId: string, conversationId: string) => () =>
        db.exec(`
          INSERT INTO agent_runtime_slots (agent_id, conversation_id)
          VALUES ('${agentId}', '${conversationId}')
        `);
      // workspace arm: no roster row…
      expect(forgeSeat('a_conv_y', 'c_chan')).toThrow(/requires participation/);
      // …direct_pair arm: neither endpoint…
      expect(forgeSeat('a_conv_y', 'c_pair2')).toThrow(/requires participation/);
      // …agent_inbox arm: not the inbox's agent.
      expect(forgeSeat('a_conv_y', 'c_inbox2')).toThrow(/requires participation/);
      // The differential: the SAME insert, in the same place, succeeds the moment
      // the participation edge exists — so the refusals above are about
      // participation and not about this agent, this conversation, or a writer
      // that cannot insert slots at all. (Through the roster edge, which is what
      // production has; the trigger and the direct writer agree.)
      db.exec(`
        INSERT INTO conversation_agents (conversation_id, agent_id, joined_at)
          VALUES ('c_chan', 'a_conv_y', 30);
      `);
      expect(
        db
          .prepare<[], { conversation_id: string | null }>(
            `SELECT conversation_id FROM agent_runtime_slots
              WHERE agent_id = 'a_conv_y'`,
          )
          .all(),
      ).toEqual([{ conversation_id: 'c_chan' }]);

      // 5. The EDGES a seat is derived from are frozen. An UPDATE is neither the
      //    INSERT that mints a seat nor the DELETE that releases it, so a movable
      //    edge would desynchronise the derivation without either trigger firing.
      const seatsBefore = seatKeys();
      db.exec(`
        INSERT INTO conversations (
          id, workspace_id, placement_kind, roster_policy, title, title_key,
          status, created_at, updated_at, visibility
        ) VALUES (
          'c_chan2', 'w_p', 'workspace', 'open', 'chan2', 'chan2',
          'open', 9, 9, 'private'
        );
      `);
      // The ADDRESS aggregate, snapshotted after that insert: since #task:2016 a
      // workspace-placed row IS its own allocation (`title_key`), so there is no
      // separate namespace table to count — the occupied address set is a
      // projection of `conversations` itself.
      const addressesBefore = db
        .prepare<[], { keys: string }>(
          `SELECT group_concat(k, '|') AS keys FROM (
             SELECT title_key AS k FROM conversations
              WHERE placement_kind = 'workspace' ORDER BY title_key
           )`,
        )
        .get()!.keys;
      // Relocating a roster row would leave the seat on the old conversation and
      // the new membership with none.
      expect(() =>
        db.exec(`
          UPDATE conversation_agents SET conversation_id = 'c_chan2'
          WHERE conversation_id = 'c_chan' AND agent_id = 'a_conv_y'
        `),
      ).toThrow(/roster edge is immutable/);
      // One level up: a COORDINATED arm conversion that satisfies every CHECK the
      // schema has. It would hand an inbox a mutable roster, drag it into the
      // workspace ADDRESS SPACE it never entered (#task:2016), and move its seat's
      // owning edge — all without an INSERT or a DELETE anywhere.
      expect(() =>
        db.exec(`
          UPDATE conversations
             SET placement_kind = 'workspace', workspace_id = 'w_p',
                 inbox_agent_id = NULL, roster_policy = 'open'
           WHERE id = 'c_inbox2'
        `),
      ).toThrow(/placement is immutable/);
      // …and each column alone, because a freeze that only catches the four
      // together is not a freeze.
      expect(() =>
        db.exec(`UPDATE conversations SET workspace_id = NULL WHERE id = 'c_chan'`),
      ).toThrow(/placement is immutable/);
      expect(() =>
        db.exec(
          `UPDATE conversations SET roster_policy = 'open' WHERE id = 'c_pair2'`,
        ),
      ).toThrow(/placement is immutable/);
      expect(() =>
        db.exec(
          `UPDATE conversations SET inbox_agent_id = 'a_conv_y' WHERE id = 'c_inbox2'`,
        ),
      ).toThrow(/placement is immutable/);
      // Zero drift in all three aggregates the conversion would have bypassed:
      // the placement row itself, the workspace address space, and the seat set.
      expect(
        db
          .prepare(
            `SELECT placement_kind, workspace_id, inbox_agent_id, roster_policy
               FROM conversations WHERE id = 'c_inbox2'`,
          )
          .get(),
      ).toEqual({
        placement_kind: 'agent_inbox',
        workspace_id: null,
        inbox_agent_id: 'a_conv_z',
        roster_policy: 'fixed',
      });
      expect(
        db
          .prepare<[], { keys: string }>(
            `SELECT group_concat(k, '|') AS keys FROM (
               SELECT title_key AS k FROM conversations
                WHERE placement_kind = 'workspace' ORDER BY title_key
             )`,
          )
          .get()!.keys,
      ).toBe(addressesBefore);
      expect(seatKeys()).toEqual(seatsBefore);
      // The freeze is a COLUMN LIST, not a blanket ban on updating a placement:
      // display and lifecycle columns still move, which is why the rename pair
      // (`title` + its folded `title_key`) is asserted here rather than assumed.
      db.exec(
        `UPDATE conversations SET title = 'renamed', title_key = 'renamed'
           WHERE id = 'c_chan'`,
      );
      expect(
        db
          .prepare<[], { title: string }>(
            `SELECT title FROM conversations WHERE id = 'c_chan'`,
          )
          .get()!.title,
      ).toBe('renamed');

      // Deleting the CONVERSATION releases its seats through the slot's own FK —
      // which is why the release trigger being inert on rosterless placements is
      // correct rather than a hole.
      db.exec(`DELETE FROM conversations WHERE id = 'c_pair'`);
      expect(
        db
          .prepare<[], { count: number }>(
            `SELECT COUNT(*) AS count FROM agent_runtime_slots
              WHERE conversation_id = 'c_pair'`,
          )
          .get()?.count,
      ).toBe(0);
      // …and deleting the AGENT releases every seat it holds, on every arm.
      db.exec(`DELETE FROM agents WHERE id = 'a_conv'`);
      expect(
        db
          .prepare<[], { count: number }>(
            `SELECT COUNT(*) AS count FROM agent_runtime_slots
              WHERE agent_id = 'a_conv'`,
          )
          .get()?.count,
      ).toBe(0);
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe('v86 user_list_sort_mode_rail_scope_agent_space (#task:2045 Delta 4)', () => {
  /** Seed one user with rail sort state under the OLD token: a mode row keyed by
   *  scope, and manual ranks keyed by entity (the asymmetry that makes skipping
   *  the migration a silent bug rather than a visible one). */
  function seedRailSortState(db: Database.Database): void {
    const now = Date.now();
    db.exec(`
      INSERT INTO users (id, name, display_name, created_at, updated_at)
        VALUES ('u_rail', 'rail-owner', 'Rail Owner', ${now}, ${now});
      INSERT INTO user_list_sort_mode (user_id, list_key, scope, mode, updated_at)
        VALUES ('u_rail', 'workspaces', 'dm', 'manual', ${now}),
               ('u_rail', 'workspaces', 'regular', 'recent', ${now}),
               ('u_rail', 'channels:ws1', '', 'manual', ${now});
      INSERT INTO user_sort_entry (user_id, list_key, entity_id, rank, last_accessed_at)
        VALUES ('u_rail', 'workspaces', 'ws_space_a', 200, ${now}),
               ('u_rail', 'workspaces', 'ws_space_b', 100, ${now});
    `);
  }

  function modeRows(db: Database.Database): Array<{ scope: string; mode: string }> {
    return db
      .prepare<[], { scope: string; mode: string }>(
        `SELECT scope, mode FROM user_list_sort_mode
          WHERE user_id = 'u_rail' AND list_key = 'workspaces' ORDER BY scope`,
      )
      .all();
  }

  it('moves the rail scope to the agent-space token and leaves every other row and rank untouched', () => {
    const db = openDbAt(85);
    try {
      seedRailSortState(db);
      const ranksBefore = db
        .prepare(
          `SELECT entity_id, rank FROM user_sort_entry
            WHERE user_id = 'u_rail' ORDER BY entity_id`,
        )
        .all();

      applyMigrationsThrough(db, 86);

      // The mode MOVED (same mode, new scope) — not reset, not duplicated.
      expect(modeRows(db)).toEqual([
        { scope: 'agent_space', mode: 'manual' },
        { scope: 'regular', mode: 'recent' },
      ]);
      // The channel sidebar's list-wide row is a different list_key: untouched.
      expect(
        db
          .prepare<[], { scope: string; mode: string }>(
            `SELECT scope, mode FROM user_list_sort_mode
              WHERE user_id = 'u_rail' AND list_key = 'channels:ws1'`,
          )
          .all(),
      ).toEqual([{ scope: '', mode: 'manual' }]);
      // Manual ranks are entity-keyed, so they must be byte-identical. This is
      // the pairing the whole migration exists for: had the mode been left
      // behind, these ranks would survive and simply stop being applied.
      expect(
        db
          .prepare(
            `SELECT entity_id, rank FROM user_sort_entry
              WHERE user_id = 'u_rail' ORDER BY entity_id`,
          )
          .all(),
      ).toEqual(ranksBefore);
    } finally {
      db.close();
    }
  });

  it('is idempotent on replay and a no-op on a DB that never held the old token', () => {
    const db = openDbAt(86);
    try {
      const now = Date.now();
      db.exec(`
        INSERT INTO users (id, name, display_name, created_at, updated_at)
          VALUES ('u_rail', 'rail-owner', 'Rail Owner', ${now}, ${now});
        INSERT INTO user_list_sort_mode (user_id, list_key, scope, mode, updated_at)
          VALUES ('u_rail', 'workspaces', 'agent_space', 'manual', ${now});
      `);
      const before = modeRows(db);

      const v86 = migrations.find(m => m.version === 86)!;
      db.exec(v86.up);
      db.exec(v86.up);

      expect(modeRows(db)).toEqual(before);
    } finally {
      db.close();
    }
  });

  it('fails loud and writes no _migrations row when a user already holds both tokens', () => {
    const db = openDbAt(85);
    try {
      const now = Date.now();
      db.exec(`
        INSERT INTO users (id, name, display_name, created_at, updated_at)
          VALUES ('u_rail', 'rail-owner', 'Rail Owner', ${now}, ${now});
        INSERT INTO user_list_sort_mode (user_id, list_key, scope, mode, updated_at)
          VALUES ('u_rail', 'workspaces', 'dm', 'manual', ${now}),
                 ('u_rail', 'workspaces', 'agent_space', 'recent', ${now});
      `);

      // Merging two conflicting modes is a user-data decision, not a
      // migration's: the collision must abort the whole version.
      expect(() => applyMigrationsThrough(db, 86)).toThrow(/UNIQUE|PRIMARY/i);
      expect(
        db
          .prepare<[], { version: number }>(
            'SELECT version FROM _migrations WHERE version = 86',
          )
          .get(),
      ).toBeUndefined();
      expect(modeRows(db)).toEqual([
        { scope: 'agent_space', mode: 'recent' },
        { scope: 'dm', mode: 'manual' },
      ]);
    } finally {
      db.close();
    }
  });
});

describe('v88 workspaces_drop_retired_rail_sort_scopes (#task:2190)', () => {
  function wsModes(
    db: Database.Database,
  ): Array<{ scope: string; mode: string }> {
    return db
      .prepare<[], { scope: string; mode: string }>(
        `SELECT scope, mode FROM user_list_sort_mode
          WHERE user_id = 'u1' AND list_key = 'workspaces' ORDER BY scope`,
      )
      .all();
  }

  it('drops only the retired workspaces scopes and keeps legal current scopes, other lists, and unknown scopes verbatim', () => {
    // A real pre-v48 provenance: the viewer once held a single flat workspaces
    // mode (no scope column) and a flat channels mode. v48 folds both to the
    // list-wide sentinel scope ''. The workspaces '' row is exactly the orphan
    // that v86 left behind and the strict reader now fails closed on.
    const db = openDbAt(47);
    try {
      const now = 1_700_000_000_000;
      db.prepare(
        `INSERT INTO users (id, name, display_name, created_at, updated_at)
         VALUES ('u1', 'viewer', 'Viewer', ?, ?)`,
      ).run(now, now);
      db.prepare(
        `INSERT INTO user_list_sort_mode (user_id, list_key, mode, updated_at)
         VALUES ('u1', 'workspaces', 'manual', ?)`,
      ).run(now);
      db.prepare(
        `INSERT INTO user_list_sort_mode (user_id, list_key, mode, updated_at)
         VALUES ('u1', 'channels:ws1', 'recent', ?)`,
      ).run(now);

      // v48 introduces the scope column and folds both rows to scope ''.
      applyMigrationsThrough(db, 85);
      expect(wsModes(db)).toEqual([{ scope: '', mode: 'manual' }]);

      // Over the following releases the viewer accumulated per-group modes: the
      // retired 'pinned' group, a legacy 'dm' group (v86 remaps it to
      // 'agent_space'), a current 'regular' group, and — to prove the DELETE is
      // narrow — some OTHER unknown scope this migration must NOT swallow.
      db.prepare(
        `INSERT INTO user_list_sort_mode (user_id, list_key, scope, mode, updated_at)
         VALUES ('u1', 'workspaces', 'pinned', 'manual', ?),
                ('u1', 'workspaces', 'dm', 'recent', ?),
                ('u1', 'workspaces', 'regular', 'recent', ?),
                ('u1', 'workspaces', 'mystery', 'manual', ?)`,
      ).run(now, now, now, now);

      applyMigrationsThrough(db, CURRENT_MIGRATION_STEP);
      expect(
        db.prepare(`SELECT version FROM _migrations WHERE version = 88`).get(),
      ).toBeDefined();

      // The two retired kinds ('' and 'pinned') are gone. The legal current
      // scopes survive verbatim: 'regular' as written, and 'agent_space' as v86
      // remapped it from 'dm'. The unknown 'mystery' scope is left for the
      // strict reader to fail closed on — this migration does not swallow it.
      expect(wsModes(db)).toEqual([
        { scope: 'agent_space', mode: 'recent' },
        { scope: 'mystery', mode: 'manual' },
        { scope: 'regular', mode: 'recent' },
      ]);

      // A different list's legitimate flat sentinel '' is untouched.
      expect(
        db
          .prepare<[], { scope: string; mode: string }>(
            `SELECT scope, mode FROM user_list_sort_mode
              WHERE user_id = 'u1' AND list_key = 'channels:ws1'`,
          )
          .all(),
      ).toEqual([{ scope: '', mode: 'recent' }]);
    } finally {
      db.close();
    }
  });

  it('is idempotent on replay and a no-op on a DB with only legal current scopes', () => {
    const db = openDbAt(88);
    try {
      const now = 1_700_000_000_000;
      db.exec(`
        INSERT INTO users (id, name, display_name, created_at, updated_at)
          VALUES ('u1', 'viewer', 'Viewer', ${now}, ${now});
        INSERT INTO user_list_sort_mode (user_id, list_key, scope, mode, updated_at)
          VALUES ('u1', 'workspaces', 'regular', 'recent', ${now}),
                 ('u1', 'workspaces', 'agent_space', 'manual', ${now}),
                 ('u1', 'channels:ws1', '', 'manual', ${now});
      `);
      const before = wsModes(db);

      const v88 = migrations.find(m => m.version === 88)!;
      db.exec(v88.up);
      db.exec(v88.up);

      expect(wsModes(db)).toEqual(before);
      expect(
        db
          .prepare<[], { scope: string; mode: string }>(
            `SELECT scope, mode FROM user_list_sort_mode
              WHERE user_id = 'u1' AND list_key = 'channels:ws1'`,
          )
          .all(),
      ).toEqual([{ scope: '', mode: 'manual' }]);
    } finally {
      db.close();
    }
  });
});

describe('schema epoch reporting and ledger prefix enforcement (#task:2103)', () => {
  const SYNTHETIC_PLAN_FLOOR = MIN_SUPPORTED_MIGRATION_STEP;

  function ledgerOnlyDb(steps: number[], extraSql = ''): Database.Database {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE _migrations (
        version INTEGER PRIMARY KEY,
        name    TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );
      INSERT INTO _migrations (version, name, applied_at) VALUES
      ${steps.map(step => `(${step}, 'synthetic-${step}', 1)`).join(', ')};
      ${extraSql}
    `);
    return db;
  }

  it('names the two too-old refusals apart', () => {
    // Safety (below the baseline CREATE) and policy (below the supported epoch)
    // coincide at step 44 today, which is exactly why the texts must differ: the
    // first says "this build cannot rebuild your schema", the second says "this
    // release does not promise that upgrade".
    const preBaseline = ledgerOnlyDb(
      [BASELINE_MIGRATION_STEP - 1],
      // Non-empty: the floor guard only refuses a DB that already has application
      // schema, because an empty file is initialized from the baseline instead.
      'CREATE TABLE users (id TEXT PRIMARY KEY);',
    );
    try {
      expect(() =>
        runMigrations(preBaseline, {
          expectedStep: CURRENT_MIGRATION_STEP,
          minimumSupportedStep: MIN_SUPPORTED_MIGRATION_STEP,
          allowSchemaUpgrade: true,
        }),
      ).toThrow(/below the baseline step \d+, whose migration is a full CREATE/);
    } finally {
      preBaseline.close();
    }

    // A policy floor above the baseline: the path exists, this build just does
    // not promise it.
    const supported = openDbAt(BASELINE_MIGRATION_STEP);
    try {
      expect(() =>
        runMigrations(supported, {
          expectedStep: CURRENT_MIGRATION_STEP,
          minimumSupportedStep: BASELINE_MIGRATION_STEP + 1,
          allowSchemaUpgrade: true,
        }),
      ).toThrow(/below the oldest schema epoch \d+ this build supports/);
    } finally {
      supported.close();
    }
  });

  it('reports the epoch a fresh DB reaches, on both axes', () => {
    const db = openDatabase(':memory:');
    try {
      expect(currentMigrationStep(db)).toBe(CURRENT_MIGRATION_STEP);
      expect(currentSchemaEpoch(db)).toBe(CURRENT_SCHEMA_EPOCH);
    } finally {
      db.close();
    }
  });

  it('does not report a partially-upgraded DB as having reached the epoch', () => {
    // A DB stopped one step short of the epoch's last step is exactly what a
    // crash mid-upgrade leaves behind. It must read as the PREVIOUS epoch, or an
    // operator would take a half-migrated database for a shipped one.
    const partialStep = CURRENT_MIGRATION_STEP - 1;
    const db = openDbAt(partialStep);
    try {
      expect(currentMigrationStep(db)).toBe(partialStep);
      expect(currentSchemaEpoch(db)).toBe(CURRENT_SCHEMA_EPOCH - 1);
      expect(reportedEpochForAppliedStep(partialStep)).toBe(
        CURRENT_SCHEMA_EPOCH - 1,
      );

      // Resuming from that legal prefix finishes the epoch, and only then does
      // the epoch move.
      const result = runMigrations(db, {
        expectedStep: CURRENT_MIGRATION_STEP,
        minimumSupportedStep: MIN_SUPPORTED_MIGRATION_STEP,
        allowSchemaUpgrade: true,
      });
      expect(result.appliedSteps).toEqual([CURRENT_MIGRATION_STEP]);
      expect(result.beforeEpoch).toBe(CURRENT_SCHEMA_EPOCH - 1);
      expect(result.afterEpoch).toBe(CURRENT_SCHEMA_EPOCH);
      expect(currentSchemaEpoch(db)).toBe(CURRENT_SCHEMA_EPOCH);
    } finally {
      db.close();
    }
  });

  it('refuses a ledger with a hole below the highest applied step', () => {
    const db = ledgerOnlyDb([SYNTHETIC_PLAN_FLOOR, SYNTHETIC_PLAN_FLOOR + 2]);
    try {
      expect(() =>
        runMigrations(db, {
          migrations: [
            { version: SYNTHETIC_PLAN_FLOOR, name: 'floor', up: 'SELECT 1;' },
            {
              version: SYNTHETIC_PLAN_FLOOR + 1,
              name: 'skipped',
              up: `CREATE TABLE skipped_rows (id TEXT PRIMARY KEY);`,
            },
            {
              version: SYNTHETIC_PLAN_FLOOR + 2,
              name: 'applied-out-of-order',
              up: 'SELECT 1;',
            },
          ],
          expectedStep: SYNTHETIC_PLAN_FLOOR + 2,
          minimumSupportedStep: SYNTHETIC_PLAN_FLOOR,
          allowSchemaUpgrade: true,
        }),
      ).toThrow(
        new RegExp(
          `missing step\\(s\\) ${SYNTHETIC_PLAN_FLOOR + 1} below applied step ${SYNTHETIC_PLAN_FLOOR + 2}`,
        ),
      );
      // Nothing was replayed: refusing is the whole point, so the skipped step's
      // table must not exist.
      expect(
        db
          .prepare(
            `SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'skipped_rows'`,
          )
          .get(),
      ).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('refuses a ledger carrying an in-range step this build does not define', () => {
    const db = ledgerOnlyDb([SYNTHETIC_PLAN_FLOOR, SYNTHETIC_PLAN_FLOOR + 1]);
    try {
      expect(() =>
        runMigrations(db, {
          migrations: [
            { version: SYNTHETIC_PLAN_FLOOR, name: 'floor', up: 'SELECT 1;' },
            {
              version: SYNTHETIC_PLAN_FLOOR + 2,
              name: 'ceiling',
              up: 'SELECT 1;',
            },
          ],
          expectedStep: SYNTHETIC_PLAN_FLOOR + 2,
          minimumSupportedStep: SYNTHETIC_PLAN_FLOOR,
          allowSchemaUpgrade: true,
        }),
      ).toThrow(
        new RegExp(
          `step\\(s\\) ${SYNTHETIC_PLAN_FLOOR + 1} applied that this build does not define`,
        ),
      );
    } finally {
      db.close();
    }
  });

  it('treats ledger rows below the plan floor as history, not as unknown steps', () => {
    // A real production DB still carries v1..v43 rows from before the baseline
    // compaction (#task:1213). Those are history; judging them against this
    // build's plan would refuse a perfectly healthy database.
    const db = openDatabase(':memory:');
    try {
      db.exec(`
        INSERT INTO _migrations (version, name, applied_at) VALUES
        (1, 'historical-1', 1), (2, 'historical-2', 1), (43, 'historical-43', 1);
      `);
      const result = runMigrations(db, {
        expectedStep: CURRENT_MIGRATION_STEP,
        minimumSupportedStep: MIN_SUPPORTED_MIGRATION_STEP,
        allowSchemaUpgrade: true,
      });
      expect(result.appliedSteps).toEqual([]);
      expect(result.afterStep).toBe(CURRENT_MIGRATION_STEP);
      expect(result.afterEpoch).toBe(CURRENT_SCHEMA_EPOCH);
    } finally {
      db.close();
    }
  });
});

describe('v68 -> epoch 69 upgrade, as an operator sees it (#task:2103)', () => {
  const LAST_ONE_TO_ONE_STEP = ONE_TO_ONE_EPOCH_CEILING_STEP;

  it('backs up once, applies every step in order, and reports epoch 68 -> 69', () => {
    // The shape of the production database this build will meet: step 68, i.e.
    // the last step of the 1:1 era, where epoch 68 IS step 68.
    const db = openDbAt(LAST_ONE_TO_ONE_STEP);
    try {
      expect(currentSchemaEpoch(db)).toBe(LAST_ONE_TO_ONE_STEP);
      const backups: MigrationBackupInfo[] = [];
      const result = runMigrations(db, {
        expectedStep: CURRENT_MIGRATION_STEP,
        minimumSupportedStep: MIN_SUPPORTED_MIGRATION_STEP,
        allowSchemaUpgrade: true,
        backupBeforeMigration: info => {
          backups.push(info);
          return '/tmp/silverhand-fake-backup';
        },
      });
      // One backup for the whole release upgrade, not one per step.
      expect(backups).toEqual([
        { fromStep: LAST_ONE_TO_ONE_STEP, toStep: CURRENT_MIGRATION_STEP },
      ]);
      expect(result.appliedSteps).toEqual(
        migrations
          .filter(m => m.version > LAST_ONE_TO_ONE_STEP)
          .map(m => m.version),
      );
      expect(result.beforeEpoch).toBe(LAST_ONE_TO_ONE_STEP);
      expect(result.afterEpoch).toBe(CURRENT_SCHEMA_EPOCH);
      expect(currentSchemaEpoch(db)).toBe(CURRENT_SCHEMA_EPOCH);
    } finally {
      db.close();
    }
  });

  it('lets an older binary refuse a DB upgraded partway into a newer epoch', () => {
    // Both sides must be INSIDE the same unfinished epoch, or this proves the
    // easy case (refusing a finished newer epoch) instead of the hard one:
    //   DB           = step 86 → still reports epoch 68, epoch 69 unfinished
    //   older binary = step 85 → also reports epoch 68
    // Epoch comparison sees "68 vs 68" and admits the DB; the step axis sees
    // 86 > 85 and refuses. That gap is the whole reason the guard stayed on steps.
    const dbStep = CURRENT_MIGRATION_STEP - 1;
    const olderBinaryNewestStep = CURRENT_MIGRATION_STEP - 2;
    expect(epochForMigrationStep(dbStep)).toBe(CURRENT_SCHEMA_EPOCH);
    expect(reportedEpochForAppliedStep(dbStep)).toBe(LAST_ONE_TO_ONE_STEP);
    expect(reportedEpochForAppliedStep(olderBinaryNewestStep)).toBe(
      LAST_ONE_TO_ONE_STEP,
    );
    const db = openDbAt(dbStep);
    try {
      expect(currentSchemaEpoch(db)).toBe(LAST_ONE_TO_ONE_STEP);
      expect(() =>
        runMigrations(db, {
          migrations: migrations.filter(
            m => m.version <= olderBinaryNewestStep,
          ),
          expectedStep: olderBinaryNewestStep,
          minimumSupportedStep: MIN_SUPPORTED_MIGRATION_STEP,
          allowSchemaUpgrade: true,
        }),
      ).toThrow(/past the newest step \d+ this build knows/);
      // Nothing was written by the refusal.
      expect(currentMigrationStep(db)).toBe(dbStep);
    } finally {
      db.close();
    }
  });

});
