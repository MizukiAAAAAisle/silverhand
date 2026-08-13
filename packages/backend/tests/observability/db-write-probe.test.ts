/**
 * #task:1982 W4 — semantic contract of the readiness write probe.
 *
 * The probe is the process's only hand-rolled transaction-control SQL, so what
 * it means has to be pinned by behavior rather than by reading the statements:
 *
 *  - **It answers "can I write NOW", not "is the file there".** `BEGIN
 *    IMMEDIATE` takes the write lock at BEGIN, so a rival writer makes the
 *    probe fail immediately. The test carries its own falsifier: a DEFERRED
 *    `BEGIN` under the same contention succeeds, which is exactly the wrong
 *    answer for `/readyz` and the reason the statement cannot be relaxed into
 *    `db.transaction(() => {})`.
 *  - **It never throws and never leaks a transaction**, on any arm — a
 *    readiness endpoint must report a failure, not become one, and a probe that
 *    left `BEGIN` open would poison every later writer on that connection.
 *  - **One classification feeds both the result and the metric label.** The
 *    two transient families are reached through the real public surface by
 *    throwing from the driver seam, so the mapping is asserted rather than
 *    assumed; `busy` additionally has a real, driver-produced case.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database as Db } from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db.js';
import { createSqliteDbWriteProbe } from '../../src/observability/db-write-probe.js';
import type { BackendMetrics } from '../../src/observability/metrics.js';

/** Records only the readiness histogram; every other metric is irrelevant
 *  here, and a partial double is more honest than a full registry. */
function recordingMetrics(): {
  metrics: BackendMetrics;
  observed: Array<{ outcome: string; elapsedMs: number }>;
} {
  const observed: Array<{ outcome: string; elapsedMs: number }> = [];
  const metrics = {
    observeReadinessProbe: (outcome: string, elapsedMs: number) => {
      observed.push({ outcome, elapsedMs });
    },
  } as unknown as BackendMetrics;
  return { metrics, observed };
}

/** A driver seam that fails the way a driver fails. Used for the arms a single
 *  process cannot produce naturally (`SQLITE_LOCKED`, a non-Error throw). */
function throwingDb(
  err: unknown,
  opts: { inTransaction?: boolean; rollbackThrows?: boolean } = {},
): { db: Db; statements: string[] } {
  const statements: string[] = [];
  const db = {
    get inTransaction() {
      return opts.inTransaction ?? false;
    },
    exec(sql: string) {
      statements.push(sql);
      if (sql === 'ROLLBACK') {
        if (opts.rollbackThrows) throw new Error('rollback failed too');
        return;
      }
      throw err;
    },
  } as unknown as Db;
  return { db, statements };
}

describe('#task:1982 W4 — readiness write probe', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const fn of cleanups.splice(0)) fn();
  });

  /** Two connections on ONE file-backed DB — `:memory:` cannot express write
   *  contention at all. `busyTimeoutMs: 0` makes contention immediate instead
   *  of a five-second stall. */
  function fileBacked(): { probed: Db; rival: Db } {
    const dir = mkdtempSync(join(tmpdir(), 'silverhand-readyz-probe-'));
    const dbPath = join(dir, 'silverhand.db');
    const probed = openDatabase(dbPath, { busyTimeoutMs: 0 });
    const rival = openDatabase(dbPath, { busyTimeoutMs: 0 });
    cleanups.push(() => {
      probed.close();
      rival.close();
      rmSync(dir, { recursive: true, force: true });
    });
    return { probed, rival };
  }

  it('an idle database is writable, leaves no open transaction, and times the probe', () => {
    const { probed } = fileBacked();
    const { metrics, observed } = recordingMetrics();
    const probe = createSqliteDbWriteProbe({ db: probed, metrics });

    expect(probe.probe()).toEqual({ ok: true });
    expect(probed.inTransaction).toBe(false);
    // repeatable: the first probe released the lock it took
    expect(probe.probe()).toEqual({ ok: true });
    expect(observed.map(o => o.outcome)).toEqual(['ok', 'ok']);
    for (const o of observed) expect(o.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('a rival writer makes the probe report busy — and a deferred BEGIN would not (falsifier)', () => {
    const { probed, rival } = fileBacked();
    const { metrics, observed } = recordingMetrics();
    const probe = createSqliteDbWriteProbe({ db: probed, metrics });

    rival.exec('BEGIN IMMEDIATE');
    rival.exec("CREATE TABLE IF NOT EXISTS probe_rival (id INTEGER PRIMARY KEY)");

    const result = probe.probe();
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.outcome).toBe('busy');
    expect(result.ok === false && result.error).toMatch(/database is locked/i);
    expect(observed.map(o => o.outcome)).toEqual(['busy']);
    // the failed probe left nothing open on the probed connection
    expect(probed.inTransaction).toBe(false);

    // FALSIFIER: the same contention with a DEFERRED begin reports success,
    // because a deferred transaction defers the write lock. That is the answer
    // `/readyz` must never give, and it is what pins `BEGIN IMMEDIATE` here.
    probed.exec('BEGIN');
    expect(probed.inTransaction).toBe(true);
    probed.exec('ROLLBACK');

    // once the rival commits, the probe recovers on its own
    rival.exec('ROLLBACK');
    expect(probe.probe()).toEqual({ ok: true });
    expect(observed.map(o => o.outcome)).toEqual(['busy', 'ok']);
  });

  it('classifies the transient families and reports everything else as error', () => {
    const cases: Array<{ thrown: unknown; outcome: string; error: string }> = [
      {
        thrown: Object.assign(new Error('locked'), {
          code: 'SQLITE_LOCKED_SHAREDCACHE',
        }),
        outcome: 'locked',
        error: 'locked',
      },
      {
        thrown: Object.assign(new Error('busy snapshot'), {
          code: 'SQLITE_BUSY_SNAPSHOT',
        }),
        outcome: 'busy',
        error: 'busy snapshot',
      },
      {
        thrown: Object.assign(new Error('io'), { code: 'SQLITE_IOERR' }),
        outcome: 'error',
        error: 'io',
      },
      // no `code` at all — e.g. a closed connection
      { thrown: new Error('connection is not open'), outcome: 'error', error: 'connection is not open' },
      // not even an Error: the message must still be a string
      { thrown: 'plain string failure', outcome: 'error', error: 'plain string failure' },
    ];

    for (const c of cases) {
      const { metrics, observed } = recordingMetrics();
      const { db } = throwingDb(c.thrown);
      const result = createSqliteDbWriteProbe({ db, metrics }).probe();
      expect(result, c.outcome).toEqual({
        ok: false,
        outcome: c.outcome,
        error: c.error,
      });
      // the metric label is the SAME classification, never a second opinion
      expect(observed.map(o => o.outcome)).toEqual([c.outcome]);
    }
  });

  it('cleans up only when a transaction is actually open, and survives a failing rollback', () => {
    // BEGIN failed and left nothing open: no ROLLBACK is issued
    const clean = throwingDb(new Error('nope'));
    expect(createSqliteDbWriteProbe({ db: clean.db }).probe().ok).toBe(false);
    expect(clean.statements).toEqual(['BEGIN IMMEDIATE']);

    // BEGIN failed with a transaction open: the probe rolls it back
    const dirty = throwingDb(new Error('nope'), { inTransaction: true });
    expect(createSqliteDbWriteProbe({ db: dirty.db }).probe().ok).toBe(false);
    expect(dirty.statements).toEqual(['BEGIN IMMEDIATE', 'ROLLBACK']);

    // even the cleanup failing cannot turn the probe into a throw
    const doomed = throwingDb(new Error('nope'), {
      inTransaction: true,
      rollbackThrows: true,
    });
    const { metrics, observed } = recordingMetrics();
    expect(() =>
      createSqliteDbWriteProbe({ db: doomed.db, metrics }).probe(),
    ).not.toThrow();
    expect(observed.map(o => o.outcome)).toEqual(['error']);
  });

  it('works without a metrics registry (the common desktop configuration)', () => {
    const { probed } = fileBacked();
    expect(createSqliteDbWriteProbe({ db: probed }).probe()).toEqual({
      ok: true,
    });
  });
});
