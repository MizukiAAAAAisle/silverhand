/**
 * Readiness write probe (#task:1982 W4).
 *
 * `/readyz` has to answer one question a read cannot answer: can this process
 * still WRITE to its database? The cheapest honest answer is to take the write
 * lock and immediately give it back — which is a driver-level, dialect-specific
 * capability (`BEGIN IMMEDIATE` / `ROLLBACK`, plus a contention verdict on the
 * failure).
 *
 * That capability is OBSERVABILITY, not routing and not persistence: it owns no
 * domain data, writes no row, and its only output is a boolean plus a latency
 * histogram. It used to live in `routes.ts`, which made an HTTP module the
 * holder of the process's only hand-rolled transaction control statements. It
 * lives here instead, so:
 *  - the route is pure HTTP mapping — it reads `ok` and renders 200/503;
 *  - the probe, its latency accounting and its failure mapping are ONE unit,
 *    so the metric label and the returned outcome can never disagree;
 *  - a future engine swaps the whole probe (`SELECT pg_is_in_recovery()`, a
 *    pooled write ping) by implementing {@link DbWriteProbe}, with no route
 *    change and no second definition of "writable".
 *
 * WHICH driver codes mean contention is no longer decided here (#task:1983 W4):
 * `db-errors.ts` owns that dialect for the whole process. This module keeps the
 * part that is genuinely its own — that a contended database is a `busy` /
 * `locked` probe verdict while anything else is `error`.
 *
 * The probe is deliberately NOT a `Db` consumer at the call site: `/readyz`
 * receives an already-constructed {@link DbWriteProbe} from the composition
 * root, which is what keeps the driver handle out of the HTTP layer entirely.
 */
import { performance } from 'node:perf_hooks';
import type { Database as Db } from 'better-sqlite3';
import { classifySqliteContention } from '../db-errors.js';
import type { BackendMetrics } from './metrics.js';
import { elapsedSince } from './route-span.js';

/**
 * Why a write probe failed, in engine-neutral words. `busy` / `locked` mean
 * "someone else holds the lock" — a transient condition an orchestrator should
 * retry; `error` means the probe could not be performed at all, which is
 * usually fatal. Any engine has to answer in these terms.
 */
export type DbWriteProbeFailure = 'busy' | 'locked' | 'error';

export type DbWriteProbeResult =
  | { ok: true }
  | { ok: false; outcome: DbWriteProbeFailure; error: string };

export interface DbWriteProbe {
  /**
   * Take and release the write lock. NEVER throws: a readiness endpoint must
   * report a failure, not become one. Implementations are responsible for
   * leaving no transaction open on any path.
   */
  probe(): DbWriteProbeResult;
}

/**
 * The classification is the single source of both the returned `outcome` and
 * the metric label — see the module note. Unknown shapes are `error` rather
 * than a guess; only the two documented transient families are named, and which
 * driver codes constitute them is `db-errors.ts`'s answer, not this file's.
 */
function sqliteProbeFailure(err: unknown): DbWriteProbeFailure {
  return classifySqliteContention(err) ?? 'error';
}

/**
 * `BEGIN IMMEDIATE` takes the write lock at BEGIN, so a contended database
 * fails HERE instead of at some later statement — that is the whole point of
 * the probe, and the reason it cannot be a deferred `db.transaction(() => {})`.
 * The rollback is unconditional on the happy path and best-effort on the
 * failure path: `BEGIN` itself may have failed, in which case there is nothing
 * to roll back and asking is cheaper than remembering.
 */
export function createSqliteDbWriteProbe(deps: {
  db: Db;
  metrics?: BackendMetrics;
}): DbWriteProbe {
  return {
    probe(): DbWriteProbeResult {
      const startedAt = performance.now();
      try {
        deps.db.exec('BEGIN IMMEDIATE');
        deps.db.exec('ROLLBACK');
        deps.metrics?.observeReadinessProbe('ok', elapsedSince(startedAt));
        return { ok: true };
      } catch (err) {
        rollbackQuietly(deps.db);
        const outcome = sqliteProbeFailure(err);
        deps.metrics?.observeReadinessProbe(outcome, elapsedSince(startedAt));
        return {
          ok: false,
          outcome,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

function rollbackQuietly(db: Db): void {
  try {
    if (db.inTransaction) db.exec('ROLLBACK');
  } catch {
    // Best-effort cleanup after a failed readiness write probe: the connection
    // may be unusable, and the probe's contract is to report, never to throw.
  }
}
