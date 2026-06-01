/**
 * D4.d §5 — boot-time materialization reconciler tests.
 *
 * Pins the three §10.4 contracts from `docs/remote-backend-architecture-notes.md §3.4`:
 *
 *   1. A seeded `pending_materialization` row OLDER than the
 *      threshold is flipped to `failed` with code
 *      `backend_crash_during_materialize`.
 *   2. A seeded `pending_materialization` row NEWER than the
 *      threshold is left in `pending_materialization` intact.
 *   3. The reconciler runs SYNCHRONOUSLY during bootstrap, BEFORE
 *      the HTTP listener binds (`ctx.readiness.listenReady = true`).
 *
 * Plus the supporting unit coverage for the env-knob parser
 * (`SILVERHAND_MATERIALIZE_RECONCILE_THRESHOLD_MS`) and the
 * `runBootMaterializeReconciler` orchestration layer (idempotent
 * second call, no-op when zero rows match, structured log emission
 * with the affected agent ids).
 *
 * **Boundary**: this reconciler is mark-failed-only by R4 design.
 * The tests deliberately do NOT exercise any "re-issue
 * `agent_materialize` for the orphans" behavior — because that
 * behavior does not exist, by design. If a future PR adds
 * compensating execution, it MUST come with a fresh design pass and
 * its own pin, not by relaxing these assertions.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database as Db } from 'better-sqlite3';
import type { ServerConfig } from '@silverhand/shared';
import {
  DEFAULT_MATERIALIZE_RECONCILE_THRESHOLD_MS,
  resolveReconcileThresholdMs,
  runBootMaterializeReconciler,
} from '../../src/runtime/materialize-reconciler.js';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { HostRepo } from '../../src/repos/host-repo.js';
import { openDatabase } from '../../src/db.js';
import {
  startBackend,
  type RunningBackend,
} from '../../src/index.js';
import type { BackendLogger } from '../../src/context.js';
import { openTestDb } from '../utils/db.js';

/**
 * Test logger that records every log call in order. Used by both the
 * unit tests (to inspect emitted records) and the sequencing test
 * (to prove the reconciler info line was emitted before the listen
 * line).
 */
function makeRecordingLogger(): BackendLogger & {
  records: Array<{ level: 'info' | 'warn' | 'error'; payload: unknown; msg?: string }>;
} {
  const records: Array<{ level: 'info' | 'warn' | 'error'; payload: unknown; msg?: string }> = [];
  return {
    records,
    info: (payload: unknown, msg?: string) => {
      records.push({ level: 'info', payload, msg });
    },
    warn: (payload: unknown, msg?: string) => {
      records.push({ level: 'warn', payload, msg });
    },
    error: (payload: unknown, msg?: string) => {
      records.push({ level: 'error', payload, msg });
    },
  };
}

/**
 * Seed an `agents` row in `pending_materialization` with a
 * controlled `created_at`. Reuses `reserveForMaterialize` so the
 * INSERT goes through the same code path the route uses, then
 * rewrites `created_at` to the desired epoch ms.
 */
function seedPendingRow(
  repo: AgentRepo,
  db: Db,
  opts: {
    name: string;
    createdAt: number;
    hostId: string;
    creatorUserId: string;
  },
): string {
  const row = repo.reserveForMaterialize(
    { name: opts.name, runtime: 'claude' },
    opts.hostId,
    opts.creatorUserId,
    // Idempotency-key must be unique per (creator, key); use the
    // name suffix so co-located rows in one test don't collide.
    `t-key-${opts.name}`,
  );
  db.prepare('UPDATE agents SET created_at = ? WHERE id = ?').run(
    opts.createdAt,
    row.id,
  );
  return row.id;
}

describe('D4.d §5 — markStaleMaterializationsFailed (repo primitive)', () => {
  it('flips a pending row older than the threshold; leaves a fresher one alone', () => {
    const { db, localHostId } = openTestDb();
    const repo = new AgentRepo(db);
    const now = 1_700_000_000_000; // arbitrary fixed wall clock for the test

    const olderId = seedPendingRow(repo, db, {
      name: 'older',
      createdAt: now - 120_000, // 2 minutes old → stale at 60s threshold
      hostId: localHostId,
      creatorUserId: 'local',
    });
    const fresherId = seedPendingRow(repo, db, {
      name: 'fresher',
      createdAt: now - 30_000, // 30s old → within 60s threshold
      hostId: localHostId,
      creatorUserId: 'local',
    });

    const result = repo.markStaleMaterializationsFailed({
      now,
      olderThanMs: 60_000,
    });

    expect(result.affected).toBe(1);
    expect(result.ids).toEqual([olderId]);

    const older = repo.get(olderId);
    expect(older?.materialization_status).toBe('failed');
    expect(older?.materialization_failed_code).toBe(
      'backend_crash_during_materialize',
    );
    expect(older?.materialization_failed_at).toBe(now);

    const fresher = repo.get(fresherId);
    expect(fresher?.materialization_status).toBe('pending_materialization');
    expect(fresher?.materialization_failed_code).toBeNull();
    expect(fresher?.materialization_failed_at).toBeNull();
  });

  it('row exactly at the cutoff boundary (created_at === now - threshold) is NOT flipped (strict `<` semantics)', () => {
    // Locks the WHERE clause's strict-less-than. A row created
    // exactly at the cutoff is, by definition, on the freshness
    // side. This matters: if the comparator were `<=`, a row
    // born exactly at boot - threshold would flip the moment the
    // reconciler ran, which is a surprising edge case.
    const { db, localHostId } = openTestDb();
    const repo = new AgentRepo(db);
    const now = 1_700_000_000_000;

    const id = seedPendingRow(repo, db, {
      name: 'boundary',
      createdAt: now - 60_000,
      hostId: localHostId,
      creatorUserId: 'local',
    });

    const result = repo.markStaleMaterializationsFailed({
      now,
      olderThanMs: 60_000,
    });

    expect(result.affected).toBe(0);
    expect(repo.get(id)?.materialization_status).toBe(
      'pending_materialization',
    );
  });

  it('already-active rows are left untouched (status filter is `pending_materialization` only)', () => {
    const { db, localHostId } = openTestDb();
    const repo = new AgentRepo(db);

    const active = repo.create(
      { name: 'already-active', runtime: 'claude' },
      localHostId,
      'local',
    );
    // active rows default to created_at = Date.now(); push it
    // arbitrarily far into the past to prove the status filter,
    // not the age filter, is what protects it.
    db.prepare('UPDATE agents SET created_at = 0 WHERE id = ?').run(active.id);

    const result = repo.markStaleMaterializationsFailed({
      now: 1_700_000_000_000,
      olderThanMs: 60_000,
    });

    expect(result.affected).toBe(0);
    expect(repo.get(active.id)?.materialization_status).toBe('active');
  });

  it('already-failed rows are left untouched (no double-flip, failed_at preserved)', () => {
    const { db, localHostId } = openTestDb();
    const repo = new AgentRepo(db);
    const now = 1_700_000_000_000;

    // Use the materialize-lifecycle helpers to manufacture a
    // failed row with an old failed_at; the reconciler must NOT
    // bump failed_at on a re-run.
    const row = repo.reserveForMaterialize(
      { name: 'already-failed', runtime: 'claude' },
      localHostId,
      'local',
      't-key-already-failed',
    );
    repo.flipToFailed(row.id, 'agent_dir_collision', now - 1_000_000);
    db.prepare('UPDATE agents SET created_at = 0 WHERE id = ?').run(row.id);

    const result = repo.markStaleMaterializationsFailed({
      now,
      olderThanMs: 60_000,
    });

    expect(result.affected).toBe(0);
    const after = repo.get(row.id);
    expect(after?.materialization_status).toBe('failed');
    expect(after?.materialization_failed_code).toBe('agent_dir_collision');
    expect(after?.materialization_failed_at).toBe(now - 1_000_000);
  });

  it('no matching rows → returns {affected: 0, ids: []}', () => {
    const { db } = openTestDb();
    const repo = new AgentRepo(db);
    const result = repo.markStaleMaterializationsFailed({
      now: 1_700_000_000_000,
      olderThanMs: 60_000,
    });
    expect(result).toEqual({ affected: 0, ids: [] });
  });

  it('flips multiple stale rows in one pass; ids list contains all flipped agent ids', () => {
    const { db, localHostId } = openTestDb();
    const repo = new AgentRepo(db);
    const now = 1_700_000_000_000;

    const ids = [
      seedPendingRow(repo, db, {
        name: 'stale-a',
        createdAt: now - 200_000,
        hostId: localHostId,
        creatorUserId: 'local',
      }),
      seedPendingRow(repo, db, {
        name: 'stale-b',
        createdAt: now - 300_000,
        hostId: localHostId,
        creatorUserId: 'local',
      }),
      seedPendingRow(repo, db, {
        name: 'stale-c',
        createdAt: now - 90_000,
        hostId: localHostId,
        creatorUserId: 'local',
      }),
    ];
    // Add one fresher row that should be excluded.
    seedPendingRow(repo, db, {
      name: 'fresh-d',
      createdAt: now - 10_000,
      hostId: localHostId,
      creatorUserId: 'local',
    });

    const result = repo.markStaleMaterializationsFailed({
      now,
      olderThanMs: 60_000,
    });
    expect(result.affected).toBe(3);
    // ids set equality (RETURNING order can vary by SQLite plan)
    expect(new Set(result.ids)).toEqual(new Set(ids));
  });
});

describe('D4.d §5 — resolveReconcileThresholdMs (env knob)', () => {
  it('unset env → default 60_000ms', () => {
    expect(resolveReconcileThresholdMs({})).toBe(
      DEFAULT_MATERIALIZE_RECONCILE_THRESHOLD_MS,
    );
    expect(DEFAULT_MATERIALIZE_RECONCILE_THRESHOLD_MS).toBe(60_000);
  });

  it('empty-string env → default + no warn (treated identical to unset)', () => {
    const logger = makeRecordingLogger();
    expect(
      resolveReconcileThresholdMs(
        { SILVERHAND_MATERIALIZE_RECONCILE_THRESHOLD_MS: '' },
        logger,
      ),
    ).toBe(DEFAULT_MATERIALIZE_RECONCILE_THRESHOLD_MS);
    expect(logger.records.filter(r => r.level === 'warn')).toEqual([]);
  });

  it('valid positive integer string → parsed value, no warn', () => {
    const logger = makeRecordingLogger();
    expect(
      resolveReconcileThresholdMs(
        { SILVERHAND_MATERIALIZE_RECONCILE_THRESHOLD_MS: '120000' },
        logger,
      ),
    ).toBe(120_000);
    expect(logger.records.filter(r => r.level === 'warn')).toEqual([]);
  });

  it('non-integer (`60s`) → default + WARN with envVar + value in payload', () => {
    const logger = makeRecordingLogger();
    expect(
      resolveReconcileThresholdMs(
        { SILVERHAND_MATERIALIZE_RECONCILE_THRESHOLD_MS: '60s' },
        logger,
      ),
    ).toBe(DEFAULT_MATERIALIZE_RECONCILE_THRESHOLD_MS);
    const warns = logger.records.filter(r => r.level === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0]!.payload).toMatchObject({
      envVar: 'SILVERHAND_MATERIALIZE_RECONCILE_THRESHOLD_MS',
      value: '60s',
    });
  });

  it('zero → default + WARN (positive-integer requirement)', () => {
    const logger = makeRecordingLogger();
    expect(
      resolveReconcileThresholdMs(
        { SILVERHAND_MATERIALIZE_RECONCILE_THRESHOLD_MS: '0' },
        logger,
      ),
    ).toBe(DEFAULT_MATERIALIZE_RECONCILE_THRESHOLD_MS);
    expect(logger.records.filter(r => r.level === 'warn')).toHaveLength(1);
  });

  it('negative (`-1`) → default + WARN (the `^\\d+$` regex rejects the minus)', () => {
    const logger = makeRecordingLogger();
    expect(
      resolveReconcileThresholdMs(
        { SILVERHAND_MATERIALIZE_RECONCILE_THRESHOLD_MS: '-1' },
        logger,
      ),
    ).toBe(DEFAULT_MATERIALIZE_RECONCILE_THRESHOLD_MS);
    expect(logger.records.filter(r => r.level === 'warn')).toHaveLength(1);
  });
});

describe('D4.d §5 — runBootMaterializeReconciler (orchestration)', () => {
  it('emits an info log when affected > 0, including failedCode + ids + threshold', () => {
    const { db, localHostId } = openTestDb();
    const repo = new AgentRepo(db);
    const logger = makeRecordingLogger();
    const now = 1_700_000_000_000;
    const id = seedPendingRow(repo, db, {
      name: 'orphan',
      createdAt: now - 120_000,
      hostId: localHostId,
      creatorUserId: 'local',
    });

    const result = runBootMaterializeReconciler({
      agents: repo,
      logger,
      now: () => now,
      thresholdMs: 60_000,
    });

    expect(result).toEqual({
      affected: 1,
      ids: [id],
      thresholdMs: 60_000,
    });
    const infos = logger.records.filter(r => r.level === 'info');
    expect(infos).toHaveLength(1);
    expect(infos[0]!.payload).toMatchObject({
      affected: 1,
      ids: [id],
      thresholdMs: 60_000,
      failedCode: 'backend_crash_during_materialize',
    });
  });

  it('emits NO info log when affected === 0 (boot stays quiet on healthy state)', () => {
    const { db } = openTestDb();
    const repo = new AgentRepo(db);
    const logger = makeRecordingLogger();
    const result = runBootMaterializeReconciler({
      agents: repo,
      logger,
      now: () => 1_700_000_000_000,
      thresholdMs: 60_000,
    });
    expect(result.affected).toBe(0);
    expect(logger.records.filter(r => r.level === 'info')).toEqual([]);
  });

  it('falls back to env-resolved threshold when `thresholdMs` is omitted', () => {
    const { db, localHostId } = openTestDb();
    const repo = new AgentRepo(db);
    const logger = makeRecordingLogger();
    const now = 1_700_000_000_000;
    // 100ms old → would NOT be stale under default 60s, but IS
    // stale under the override of 10ms below. Proves the env path
    // is what selected the threshold.
    const id = seedPendingRow(repo, db, {
      name: 'orphan-env',
      createdAt: now - 100,
      hostId: localHostId,
      creatorUserId: 'local',
    });

    const result = runBootMaterializeReconciler({
      agents: repo,
      logger,
      now: () => now,
      env: { SILVERHAND_MATERIALIZE_RECONCILE_THRESHOLD_MS: '10' },
    });

    expect(result.thresholdMs).toBe(10);
    expect(result.ids).toEqual([id]);
  });

  it('idempotent: a second call after the first flipped everything is a no-op', () => {
    const { db, localHostId } = openTestDb();
    const repo = new AgentRepo(db);
    const logger = makeRecordingLogger();
    const now = 1_700_000_000_000;
    seedPendingRow(repo, db, {
      name: 'orphan-idem',
      createdAt: now - 120_000,
      hostId: localHostId,
      creatorUserId: 'local',
    });

    runBootMaterializeReconciler({
      agents: repo,
      logger,
      now: () => now,
      thresholdMs: 60_000,
    });
    const second = runBootMaterializeReconciler({
      agents: repo,
      logger,
      now: () => now + 1,
      thresholdMs: 60_000,
    });
    expect(second.affected).toBe(0);
    // exactly one info log across both calls (the first one only).
    expect(logger.records.filter(r => r.level === 'info')).toHaveLength(1);
  });
});

// ── Sequencing pin via real startBackend ──────────────────────────────
//
// This is the §10.4 contract item #3: the reconciler runs SYNCHRONOUSLY
// during bootstrap, BEFORE the HTTP listener binds
// (`ctx.readiness.listenReady = true`).
//
// The cleanest evidence we can produce without intercepting internal
// boot phases: boot the backend with a pre-seeded
// `pending_materialization` row whose `created_at = 0` (deep past). If
// `startBackend()` resolves AND the row is `failed` on the returned
// context, then the reconciler MUST have run during bootstrap. We pair
// this with a logger that records the order of `info` messages to
// also pin that the reconciler's info line is emitted before the
// "backend listening" line that `startBackend` writes from inside the
// `serve()` ready callback.

describe('D4.d §5 — sequencing: runs before HTTP listener binds (real boot)', () => {
  let tempDir: string;
  let backend: RunningBackend | null = null;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'silverhand-d4d-reconcile-'));
  });

  afterEach(async () => {
    if (backend) {
      await backend.close();
      backend = null;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('seeded stale pending row is `failed` by the time startBackend() resolves AND log order proves pre-listen sequencing', async () => {
    const dbPath = join(tempDir, 'silverhand.db');
    const silverhandDir = join(tempDir, '.silverhand');
    const logger = makeRecordingLogger();

    // Step 1: open the DB once (this runs migrations to v33) and
    // seed a pending row whose created_at is the deep past.
    const { db, localHostId, viewerUserId } = openTestDbAt(dbPath);
    const repo = new AgentRepo(db);
    const seeded = seedPendingRow(repo, db, {
      name: 'pre-boot-orphan',
      createdAt: 0,
      hostId: localHostId,
      creatorUserId: viewerUserId,
    });
    db.close();

    // Step 2: real boot. The reconciler is part of the startBackend
    // happy path; it must run synchronously before `serve()` is
    // invoked, and `startBackend` only resolves when `serve()`'s
    // ready callback fires (which flips listenReady=true).
    const serverConfig: ServerConfig = {
      mode: 'embedded',
      url: 'http://127.0.0.1:0',
      auth_token: 'a'.repeat(32),
      refresh_token: null,
      child_sessions: {
        max_concurrent_per_parent: null,
        spawn_cooldown_seconds: null,
        max_depth: 1,
      },
    };
    backend = await startBackend({
      mode: 'standalone',
      dbPath,
      silverhandDir,
      serverConfig,
      listen: { hostname: '127.0.0.1', port: 0 },
      logger,
      authConfig: {
        signupEnabled: true,
        sessionTtlMs: 30 * 24 * 60 * 60 * 1000,
      },
    });

    // Step 3: state pin. The row is failed with the canonical code.
    expect(backend.context.readiness.listenReady).toBe(true);
    const after = new AgentRepo(backend.context.db).get(seeded);
    expect(after?.materialization_status).toBe('failed');
    expect(after?.materialization_failed_code).toBe(
      'backend_crash_during_materialize',
    );
    expect(after?.materialization_failed_at).toBeGreaterThan(0);

    // Step 4: ordering pin. The reconciler's info line is emitted
    // BEFORE the "backend listening" line (which `startBackend`
    // writes from inside the `serve()` ready callback that flips
    // `listenReady=true`). Anyone refactoring the boot order to
    // call the reconciler AFTER `serve()` would invert these two
    // log entries and trip this assertion.
    const reconcileIdx = logger.records.findIndex(
      r =>
        r.level === 'info'
        && r.msg?.startsWith('D4.d boot reconciler: marked '),
    );
    const listenIdx = logger.records.findIndex(
      r => r.level === 'info' && r.msg === 'backend listening',
    );
    expect(reconcileIdx).toBeGreaterThanOrEqual(0);
    expect(listenIdx).toBeGreaterThanOrEqual(0);
    expect(reconcileIdx).toBeLessThan(listenIdx);
  });
});

// ── helpers ───────────────────────────────────────────────────────────

/**
 * File-backed analog of `openTestDb()` used only by the sequencing
 * pin. The default helper uses `:memory:`; the sequencing pin needs
 * to seed the same DB file `startBackend` then opens.
 */
function openTestDbAt(dbPath: string): {
  db: Db;
  localHostId: string;
  viewerUserId: string;
} {
  // Seed pass: migrate a fresh file from v0 to current. The real
  // `startBackend` opens the same path next with allowSchemaUpgrade
  // default-false; by then the schema is already current, so
  // `runMigrations` is a no-op.
  const db = openDatabase(dbPath, { allowSchemaUpgrade: true });
  const local = new HostRepo(db).ensureLocal();
  const now = Date.now();
  db.prepare(
    `INSERT INTO users (id, name, display_name, created_at, updated_at)
     VALUES ('local', 'local-test', 'Local Test User', ?, ?)`,
  ).run(now, now);
  return { db, localHostId: local.id, viewerUserId: 'local' };
}
