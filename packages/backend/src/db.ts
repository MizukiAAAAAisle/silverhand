import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  readdirSync,
  renameSync,
  chmodSync,
  symlinkSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';
import {
  CURRENT_MIGRATION_STEP,
  migrations as defaultMigrations,
} from '@silverhand/shared/db/migrations';
import type { Migration } from '@silverhand/shared/db/migrations';
import { BASELINE_MIGRATION_STEP } from '@silverhand/shared/db/baseline-schema';
import {
  CURRENT_SCHEMA_EPOCH,
  MIN_SUPPORTED_MIGRATION_STEP,
  MIN_SUPPORTED_SCHEMA_EPOCH,
  classifyMigrationLedger,
  epochForMigrationStep,
  reportedEpochForAppliedStep,
} from '@silverhand/shared/db/schema-epochs';

export interface OpenDatabaseOptions {
  busyTimeoutMs?: number;
  migrationBusyTimeoutMs?: number;
  allowSchemaUpgrade?: boolean;
  onMigrationResult?: (result: MigrationRunResult) => void;
  onMigrationsApplied?: () => void;
}

export function openDatabase(filepath: string, opts: OpenDatabaseOptions = {}): Db {
  let db: Db | null = null;
  try {
    db = new Database(filepath);
    const runtimeBusyTimeoutMs = opts.busyTimeoutMs ?? 5000;
    const migrationBusyTimeoutMs = opts.migrationBusyTimeoutMs ?? 0;
    db.pragma(`busy_timeout = ${migrationBusyTimeoutMs}`);
    // Shared with Rust startup: hold the real database lock across the complete
    // preparation, including backup and gaps between migration transactions.
    if (filepath !== ':memory:') db.pragma('locking_mode = EXCLUSIVE');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec('BEGIN EXCLUSIVE; COMMIT;');
    const migrationDb = db;
    const result = runMigrations(db, {
      expectedStep: CURRENT_MIGRATION_STEP,
      minimumSupportedStep: MIN_SUPPORTED_MIGRATION_STEP,
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
    if (filepath !== ':memory:') {
      db.close();
      db = null;
      db = new Database(filepath);
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = ON');
    }
    db.pragma(`busy_timeout = ${runtimeBusyTimeoutMs}`);
    return db;
  } catch (err) {
    db?.close();
    throw err;
  }
}

/**
 * Open a database for READING ONLY, exactly as it is on disk: no migrations, no
 * schema guard, no journal-mode change, no `_migrations` table creation.
 *
 * `openDatabase` is how every Silverhand PROCESS gets its handle, and it either
 * upgrades a behind-schema database or refuses to open it. That is the right
 * policy for anything that then serves requests, and the wrong policy for a
 * PRE-MIGRATION probe: #task:2016's title-address scan exists so an operator can
 * see the folded-title collisions that would abort the v72 migration, rename
 * those channels by hand, and only then upgrade. A probe that has to upgrade the
 * schema before it can answer is not a probe.
 *
 * `readonly` is the enforcement, not the intent: the connection refuses writes
 * even if a caller asks, so "read-only diagnostic" is a property of the handle
 * instead of a claim about the SQL above it. Nothing here is a migration bypass
 * for a serving process — this returns a handle that may be at ANY version,
 * which is safe only for code that probes the catalog before it queries.
 */
export function openDatabaseUnmigratedReadOnly(filepath: string): Db {
  return new Database(filepath, { readonly: true });
}

export type DatabaseMigrationErrorCode =
  | 'schema_too_old'
  | 'schema_too_new'
  | 'schema_upgrade_disabled'
  | 'schema_ledger_inconsistent'
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
  minimumSupportedStep?: number;
  expectedStep?: number;
  allowSchemaUpgrade?: boolean;
  backupPathHint?: string;
  backupBeforeMigration?: (info: MigrationBackupInfo) => string;
  onMigrationsApplied?: () => void;
}

export interface MigrationRunResult {
  /** Highest migration step applied before this run (internal axis). */
  beforeStep: number;
  /** Highest migration step applied after this run (internal axis). */
  afterStep: number;
  /** The steps this run applied, in order. */
  appliedSteps: number[];
  /**
   * Outward schema epoch before / after this run (#task:2103). Derived, never
   * stored: a run that stops partway through an epoch reports the PREVIOUS epoch
   * on both sides, because the epoch has not been reached.
   */
  beforeEpoch: number;
  afterEpoch: number;
  backupPath: string | null;
}

export interface MigrationBackupInfo {
  fromStep: number;
  toStep: number;
}

export function runMigrations(
  db: Db,
  opts: RunMigrationsOptions = {},
): MigrationRunResult {
  const migrationPlan = opts.migrations ?? defaultMigrations;
  const expectedStep =
    opts.expectedStep ?? latestMigrationStep(migrationPlan);
  const minimumSupportedStep = opts.minimumSupportedStep ?? 0;
  const allowSchemaUpgrade = opts.allowSchemaUpgrade ?? true;

  const beforeStep = currentMigrationStep(db);
  guardMigrationStep(db, {
    currentStep: beforeStep,
    minimumSupportedStep,
    expectedStep,
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

  // The ledger must be a legal PREFIX of the plan before anything is applied
  // (#task:2103). A crash mid-epoch is expected and resumable; a hole is not
  // recoverable information, and the old behavior — "apply whatever is not in the
  // ledger, in plan order" — would silently replay a step out of order on top of
  // a schema that is already past it. Fail loud instead of guessing.
  const ledger = classifyMigrationLedger([...applied], migrationPlan);
  if (ledger.kind === 'inconsistent') {
    const details = [
      ledger.missingSteps.length > 0
        ? `missing step(s) ${ledger.missingSteps.join(', ')} below applied step ${ledger.appliedThroughStep}`
        : null,
      ledger.unexpectedSteps.length > 0
        ? `step(s) ${ledger.unexpectedSteps.join(', ')} applied that this build does not define`
        : null,
    ]
      .filter(Boolean)
      .join('; ');
    throw new DatabaseMigrationError(
      'schema_ledger_inconsistent',
      `DB migration ledger is not a prefix of this build's migration plan (${details}); `
        + 'refusing to guess an upgrade order — restore the pre-upgrade backup or repair the ledger by hand',
    );
  }

  const insertMigration = db.prepare(
    'INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)',
  );
  const pendingMigrations = migrationPlan.filter(m => !applied.has(m.version));
  const upgradesExistingDb = beforeStep > 0 && pendingMigrations.length > 0;
  if (upgradesExistingDb && !allowSchemaUpgrade) {
    throw new DatabaseMigrationError(
      'schema_upgrade_disabled',
      `DB schema upgrade from epoch ${reportedEpochForAppliedStep(beforeStep)} to epoch ${reportedEpochForAppliedStep(expectedStep)} `
        + `(migration steps ${beforeStep} -> ${expectedStep}) is disabled; `
        + 'set SILVERHAND_MIGRATE=1 to back up the data directory and apply migrations'
        + (opts.backupPathHint ? `; backup will be written to ${opts.backupPathHint}` : ''),
    );
  }

  let backupPath: string | null = null;
  if (upgradesExistingDb && opts.backupBeforeMigration) {
    // One backup per migration RUN, never one per step — and a resumed partial
    // upgrade is a new run, so it backs up again (#task:2103, contract set by
    // shiki). This is a deliberate CHOICE, not a structural necessity: a legal
    // partial ledger is already sufficient authority to suppress the second
    // backup, because a target-epoch step only lands after that run's backup
    // succeeded, so `classifyMigrationLedger(...).progress.kind === 'partial'`
    // means "this upgrade already started and was already backed up". We keep the
    // per-run backup anyway: each attempt captures the mid-epoch state the prior
    // backup could not, and the pre-upgrade backup stays the rollback target.
    // Retention is operator-owned, so a crash-looping start leaves one backup
    // directory per attempt.
    try {
      backupPath = opts.backupBeforeMigration({
        fromStep: beforeStep,
        toStep: expectedStep,
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

  const appliedSteps: number[] = [];
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
    appliedSteps.push(m.version);
  }
  if (appliedSteps.length === 0) {
    // Even a no-op migration phase takes an exclusive lock probe so concurrent
    // startup/admin migration attempts fail fast instead of silently racing
    // past each other before the HTTP listener is ready.
    db.transaction(() => undefined).exclusive();
  }
  const afterStep = currentMigrationStep(db);
  if (afterStep > expectedStep) {
    throw new DatabaseMigrationError(
      'schema_too_new',
      `DB schema is at migration step ${afterStep}, past the newest step ${expectedStep} `
        + `this build knows (it ships schema epoch ${CURRENT_SCHEMA_EPOCH}); `
        + 'running an old server against a newer DB is unsupported',
    );
  }
  opts.onMigrationsApplied?.();
  return {
    beforeStep,
    afterStep,
    appliedSteps,
    beforeEpoch: reportedEpochForAppliedStep(beforeStep),
    afterEpoch: reportedEpochForAppliedStep(afterStep),
    backupPath,
  };
}

/** Highest migration step recorded in the ledger (internal axis). */
export function currentMigrationStep(db: Db): number {
  if (!migrationTableExists(db)) return 0;
  const row = db
    .prepare<[], { version: number | null }>(
      'SELECT MAX(version) AS version FROM _migrations',
    )
    .get();
  return row?.version ?? 0;
}

/**
 * Outward schema epoch of a database, derived from its ledger (#task:2103).
 *
 * Nothing stores this. A database stopped partway through an epoch reports the
 * previous epoch, because it has not reached the new one.
 */
export function currentSchemaEpoch(db: Db): number {
  return reportedEpochForAppliedStep(currentMigrationStep(db));
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

/**
 * Refuse a database this build must not serve, BEFORE anything is written.
 *
 * The comparison is on the STEP axis on purpose (#task:2103): step order is
 * strictly finer than epoch order, so this also catches the one case epoch
 * comparison cannot — a database a newer binary upgraded only PARTWAY through an
 * epoch, where both sides still report the same epoch. The messages name the
 * epoch because that is the number a release announces, and add the step so an
 * operator can locate the exact ledger row.
 *
 * The two too-old cases are different failures and say so (#task:2103). Below the
 * BASELINE step is a safety refusal: the baseline is a full CREATE, so running it
 * on a populated pre-baseline DB would rebuild live tables. Between the baseline
 * and the support-policy floor is a policy refusal: the path exists, this release
 * just does not promise it. They coincide today, and that is precisely why the
 * texts have to distinguish them.
 */
function guardMigrationStep(
  db: Db,
  opts: {
    currentStep: number;
    minimumSupportedStep: number;
    expectedStep: number;
  },
): void {
  if (opts.currentStep > opts.expectedStep) {
    throw new DatabaseMigrationError(
      'schema_too_new',
      `DB schema is at migration step ${opts.currentStep} (schema epoch ${reportedEpochForAppliedStep(opts.currentStep)}), `
        + `past the newest step ${opts.expectedStep} this build knows (it ships schema epoch ${CURRENT_SCHEMA_EPOCH}); `
        + 'running an old server against a newer DB is unsupported',
    );
  }
  const isEmpty = opts.currentStep === 0 && !hasApplicationSchema(db);
  if (isEmpty || opts.currentStep >= opts.minimumSupportedStep) return;
  const at = `DB schema is at migration step ${opts.currentStep} (schema epoch ${reportedEpochForAppliedStep(opts.currentStep)}), `;
  if (opts.currentStep < BASELINE_MIGRATION_STEP) {
    throw new DatabaseMigrationError(
      'schema_too_old',
      at
        + `below the baseline step ${BASELINE_MIGRATION_STEP}, whose migration is a full CREATE; `
        + 'upgrade through an intermediate release first — this build cannot rebuild an existing pre-baseline schema',
    );
  }
  throw new DatabaseMigrationError(
    'schema_too_old',
    at
      + `below the oldest schema epoch ${epochForMigrationStep(opts.minimumSupportedStep) ?? MIN_SUPPORTED_SCHEMA_EPOCH} this build supports upgrading from `
      + `(its first migration step is ${opts.minimumSupportedStep}); `
      + 'run migration manually before starting this server',
  );
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

function latestMigrationStep(migrationPlan: Migration[]): number {
  return migrationPlan.reduce(
    (maxVersion, migration) => Math.max(maxVersion, migration.version),
    0,
  );
}

export function backupDataDirBeforeMigration(
  db: Db,
  opts: {
    dbPath: string;
    fromStep: number;
    toStep: number;
  },
): string {
  const checkpoint = db.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number }>;
  if (checkpoint.some(row => row.busy !== 0)) {
    throw new Error('migration backup checkpoint is busy');
  }
  const dataDir = dirname(opts.dbPath);
  const ts = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  const backupPath = join(
    dirname(dataDir),
    `${basename(dataDir)}-backup-${ts}`,
  );
  const partialPath = `${backupPath}.partial`;
  const excluded = new Set([opts.dbPath, `${opts.dbPath}-wal`, `${opts.dbPath}-shm`, `${opts.dbPath}-journal`]);
  copyBackupTree(dataDir, partialPath, excluded);
  const backupDb = join(partialPath, basename(opts.dbPath));
  db.prepare('VACUUM INTO ?').run(backupDb);
  chmodSync(backupDb, lstatSync(opts.dbPath).mode & 0o777);
  renameSync(partialPath, backupPath);
  return backupPath;
}

function copyBackupTree(src: string, dest: string, excluded: ReadonlySet<string>): void {
  if (excluded.has(src)) return;
  const info = lstatSync(src);
  if (info.isDirectory()) {
    mkdirSync(dest, { mode: info.mode & 0o777 });
    for (const entry of readdirSync(src)) {
      copyBackupTree(join(src, entry), join(dest, entry), excluded);
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

function backupDataDirPathHint(dbPath: string): string {
  const dataDir = dirname(dbPath);
  return join(
    dirname(dataDir),
    `${basename(dataDir)}-backup-<utc>`,
  );
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
