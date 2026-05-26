import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';
import {
  CURRENT_SCHEMA_VERSION,
  MIN_SUPPORTED_SCHEMA_VERSION,
  migrations as defaultMigrations,
} from '@silverhand/shared';
import type { Migration } from '@silverhand/shared';

export interface OpenDatabaseOptions {
  busyTimeoutMs?: number;
  migrationBusyTimeoutMs?: number;
  allowSchemaUpgrade?: boolean;
  onMigrationResult?: (result: MigrationRunResult) => void;
  onMigrationsApplied?: () => void;
}

export function openDatabase(filepath: string, opts: OpenDatabaseOptions = {}): Db {
  const releaseMigrationLock =
    filepath === ':memory:' ? null : acquireMigrationLock(filepath);
  let db: Db | null = null;
  try {
    db = new Database(filepath);
    const runtimeBusyTimeoutMs = opts.busyTimeoutMs ?? 5000;
    const migrationBusyTimeoutMs = opts.migrationBusyTimeoutMs ?? 0;
    db.pragma(`busy_timeout = ${migrationBusyTimeoutMs}`);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    const migrationDb = db;
    const result = runMigrations(db, {
      expectedVersion: CURRENT_SCHEMA_VERSION,
      minimumSupportedVersion: MIN_SUPPORTED_SCHEMA_VERSION,
      allowSchemaUpgrade: opts.allowSchemaUpgrade ?? false,
      backupPathHint:
        filepath === ':memory:' ? undefined : backupDataDirPathHint(filepath),
      backupBeforeMigration:
        filepath === ':memory:'
          ? undefined
          : info =>
              backupDataDirBeforeMigration(migrationDb, {
                dbPath: filepath,
                ...info,
              }),
      onMigrationsApplied: opts.onMigrationsApplied,
    });
    opts.onMigrationResult?.(result);
    // Runtime SQL keeps the pre-D1 retry behavior. The migration phase above is
    // deliberately fail-fast so concurrent startup/admin migration attempts do
    // not wait in a partially-booted process.
    db.pragma(`busy_timeout = ${runtimeBusyTimeoutMs}`);
    return db;
  } catch (err) {
    db?.close();
    throw err;
  } finally {
    releaseMigrationLock?.();
  }
}

export type DatabaseMigrationErrorCode =
  | 'schema_too_old'
  | 'schema_too_new'
  | 'schema_upgrade_disabled'
  | 'migration_backup_failed'
  | 'migration_locked';

export class DatabaseMigrationError extends Error {
  constructor(
    readonly code: DatabaseMigrationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DatabaseMigrationError';
  }
}

export interface RunMigrationsOptions {
  migrations?: Migration[];
  minimumSupportedVersion?: number;
  expectedVersion?: number;
  allowSchemaUpgrade?: boolean;
  backupPathHint?: string;
  backupBeforeMigration?: (info: MigrationBackupInfo) => string;
  onMigrationsApplied?: () => void;
}

export interface MigrationRunResult {
  beforeVersion: number;
  afterVersion: number;
  appliedVersions: number[];
  backupPath: string | null;
}

export interface MigrationBackupInfo {
  fromVersion: number;
  toVersion: number;
}

export function runMigrations(
  db: Db,
  opts: RunMigrationsOptions = {},
): MigrationRunResult {
  const migrationPlan = opts.migrations ?? defaultMigrations;
  const expectedVersion =
    opts.expectedVersion ?? latestMigrationVersion(migrationPlan);
  const minimumSupportedVersion = opts.minimumSupportedVersion ?? 0;
  const allowSchemaUpgrade = opts.allowSchemaUpgrade ?? true;

  const beforeVersion = currentSchemaVersion(db);
  guardSchemaVersion(db, {
    currentVersion: beforeVersion,
    minimumSupportedVersion,
    expectedVersion,
  });

  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      name    TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);

  const applied = new Set(
    db
      .prepare<[], { version: number }>('SELECT version FROM _migrations')
      .all()
      .map(r => r.version),
  );

  const insertMigration = db.prepare(
    'INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)',
  );
  const pendingMigrations = migrationPlan.filter(m => !applied.has(m.version));
  const upgradesExistingDb = beforeVersion > 0 && pendingMigrations.length > 0;
  if (upgradesExistingDb && !allowSchemaUpgrade) {
    throw new DatabaseMigrationError(
      'schema_upgrade_disabled',
      `DB schema upgrade from v${beforeVersion} to v${expectedVersion} is disabled; set SILVERHAND_MIGRATE=1 to back up the data directory and apply migrations${
        opts.backupPathHint ? `; backup will be written to ${opts.backupPathHint}` : ''
      }`,
    );
  }

  let backupPath: string | null = null;
  if (upgradesExistingDb && opts.backupBeforeMigration) {
    try {
      backupPath = opts.backupBeforeMigration({
        fromVersion: beforeVersion,
        toVersion: expectedVersion,
      });
    } catch (err) {
      throw new DatabaseMigrationError(
        'migration_backup_failed',
        `DB backup before schema upgrade failed: ${errorMessage(err)}`,
      );
    }
  }

  /**
   * Apply a single migration inside a transaction. Both the
   * `precondition` hook (if any) and the `up` SQL run in the same
   * transaction as the `_migrations` row write — any throw rolls back
   * everything, so a failed precondition leaves no `_migrations`
   * marker and the migration is retried on next boot.
   *
   * Shared between the `foreignKeyEscape` branch (which toggles
   * `foreign_keys = OFF` first) and the normal branch so v23-style
   * guard migrations behave identically across both paths.
   */
  const applySingleMigration = (m: Migration): void =>
    db.transaction(() => {
      if (m.precondition) {
        m.precondition(db);
      }
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
    }).exclusive();

  const appliedVersions: number[] = [];
  for (const m of migrationPlan) {
    if (applied.has(m.version)) continue;
    if (m.foreignKeyEscape) {
      db.pragma('foreign_keys = OFF');
      db.pragma('legacy_alter_table = ON');
      try {
        applySingleMigration(m);
      } finally {
        db.pragma('legacy_alter_table = OFF');
        db.pragma('foreign_keys = ON');
      }
    } else {
      applySingleMigration(m);
    }
    applied.add(m.version);
    appliedVersions.push(m.version);
  }
  if (appliedVersions.length === 0) {
    // Even a no-op migration phase takes an exclusive lock probe so concurrent
    // startup/admin migration attempts fail fast instead of silently racing
    // past each other before the HTTP listener is ready.
    db.transaction(() => undefined).exclusive();
  }
  const afterVersion = currentSchemaVersion(db);
  if (afterVersion > expectedVersion) {
    throw new DatabaseMigrationError(
      'schema_too_new',
      `DB schema v${afterVersion} is newer than supported v${expectedVersion}; running an old server against a newer DB is unsupported`,
    );
  }
  opts.onMigrationsApplied?.();
  return { beforeVersion, afterVersion, appliedVersions, backupPath };
}

export function currentSchemaVersion(db: Db): number {
  if (!migrationTableExists(db)) return 0;
  const row = db
    .prepare<[], { version: number | null }>(
      'SELECT MAX(version) AS version FROM _migrations',
    )
    .get();
  return row?.version ?? 0;
}

function migrationTableExists(db: Db): boolean {
  return Boolean(
    db
      .prepare<[], { name: string }>(
        `SELECT name
           FROM sqlite_schema
          WHERE type = 'table'
            AND name = '_migrations'
          LIMIT 1`,
      )
      .get(),
  );
}

function guardSchemaVersion(
  db: Db,
  opts: {
    currentVersion: number;
    minimumSupportedVersion: number;
    expectedVersion: number;
  },
): void {
  if (opts.currentVersion > opts.expectedVersion) {
    throw new DatabaseMigrationError(
      'schema_too_new',
      `DB schema v${opts.currentVersion} is newer than supported v${opts.expectedVersion}; running an old server against a newer DB is unsupported`,
    );
  }
  const isEmpty = opts.currentVersion === 0 && !hasApplicationSchema(db);
  if (!isEmpty && opts.currentVersion < opts.minimumSupportedVersion) {
    throw new DatabaseMigrationError(
      'schema_too_old',
      `DB schema v${opts.currentVersion} is older than minimum supported v${opts.minimumSupportedVersion}; run migration manually before starting this server`,
    );
  }
}

function hasApplicationSchema(db: Db): boolean {
  const rows = db
    .prepare<[], { name: string }>(
      `SELECT name
         FROM sqlite_schema
        WHERE type IN ('table', 'index', 'trigger', 'view')
          AND name NOT LIKE 'sqlite_%'
          AND name != '_migrations'
        LIMIT 1`,
    )
    .all();
  return rows.length > 0;
}

function latestMigrationVersion(migrationPlan: Migration[]): number {
  return migrationPlan.reduce(
    (maxVersion, migration) => Math.max(maxVersion, migration.version),
    0,
  );
}

export function backupDataDirBeforeMigration(
  db: Db,
  opts: {
    dbPath: string;
    fromVersion: number;
    toVersion: number;
  },
): string {
  db.pragma('wal_checkpoint(TRUNCATE)');
  const dataDir = dirname(opts.dbPath);
  const ts = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  const backupPath = join(
    dirname(dataDir),
    `${basename(dataDir)}-backup-${ts}`,
  );
  copyBackupTree(dataDir, backupPath);
  return backupPath;
}

function copyBackupTree(src: string, dest: string): void {
  const info = lstatSync(src);
  if (info.isDirectory()) {
    mkdirSync(dest, { mode: info.mode & 0o777 });
    for (const entry of readdirSync(src)) {
      copyBackupTree(join(src, entry), join(dest, entry));
    }
    return;
  }
  if (info.isFile()) {
    copyFileSync(src, dest);
    return;
  }
  if (info.isSymbolicLink()) {
    symlinkSync(readlinkSync(src), dest);
    return;
  }
  // Unix sockets, FIFOs, and device nodes are runtime artifacts, not
  // restorable Silverhand state. Node's recursive copy throws on sockets; skip
  // these ephemeral filesystem entries so data-dir backups still complete.
}

function acquireMigrationLock(dbPath: string): () => void {
  const lockPath = migrationLockPath(dbPath);
  try {
    mkdirSync(lockPath, { mode: 0o700 });
  } catch (err) {
    throw new DatabaseMigrationError(
      'migration_locked',
      `could not acquire migration lock at ${lockPath}: ${errorMessage(err)}`,
    );
  }
  return () => {
    rmSync(lockPath, { recursive: true, force: true });
  };
}

function backupDataDirPathHint(dbPath: string): string {
  const dataDir = dirname(dbPath);
  return join(
    dirname(dataDir),
    `${basename(dataDir)}-backup-<utc>`,
  );
}

function migrationLockPath(dbPath: string): string {
  const dataDir = dirname(dbPath);
  return join(dirname(dataDir), `${basename(dataDir)}.migration.lock`);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
