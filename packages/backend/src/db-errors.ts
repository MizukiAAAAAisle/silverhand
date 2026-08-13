/**
 * #task:1983 W4 — the ONE place that decodes a driver ERROR CODE.
 *
 * Sibling of `db.ts` (which owns the driver handle) on purpose: this module is
 * the driver's error dialect, not persistence and not a domain. Its counterpart
 * `repos/sqlite-user-conflicts.ts` decodes the other dialect — constraint and
 * trigger TEXT, whose authority is the schema. Two authorities, two modules; no
 * third file names a `SQLITE_*` code.
 *
 * Why this exists rather than three private helpers: before this module,
 * `admin.ts`, `observability/db-write-probe.ts` and
 * `observability/observed-statement.ts` each answered "is this contention?"
 * independently, and they did not agree. The two adapters matched the whole
 * `SQLITE_BUSY*` / `SQLITE_LOCKED*` families by prefix; the offline admin
 * command compared for equality against `SQLITE_BUSY` alone, so
 * `SQLITE_BUSY_SNAPSHOT` and every `SQLITE_LOCKED*` variant escaped its
 * `db_locked` mapping and reached the operator as a raw driver error. A dialect
 * answered in three places is a dialect that drifts — which is the whole reason
 * Gate 7 fences it to an exact file set.
 *
 * The prefix match is deliberate and is the contract: SQLite extends its result
 * codes in place (`SQLITE_BUSY` → `SQLITE_BUSY_SNAPSHOT`,
 * `SQLITE_BUSY_TIMEOUT`, …), so a new extended code in a family we already
 * classify must classify the same way rather than silently degrade to
 * "unknown".
 *
 * What callers do with the verdict stays theirs: the readiness probe turns it
 * into a probe outcome + metric label, the statement chokepoint into a
 * contention metric, the admin command into a `db_locked` domain error. This
 * module answers only "which transient family, if any".
 */

/**
 * The two transient families worth naming. Anything else is deliberately NOT
 * classified here — a caller's own fallback ("error", "ok") is a caller
 * concern, and guessing a family for an unrecognized code is how an engine
 * detail becomes a wrong domain answer.
 */
export type SqliteContention = 'busy' | 'locked';

/**
 * The driver's `code` property, when it is a string. Shared because all three
 * consumers need the same defensive shape check: better-sqlite3 throws
 * `SqliteError` with a string `code`, but these paths also see plain `Error`s
 * (a failed `openDatabase`, a bug in a callback) and must not crash while
 * classifying one.
 */
export function driverErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object' || !('code' in err)) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** Which contention family this driver error belongs to, or `null`. */
export function classifySqliteContention(err: unknown): SqliteContention | null {
  const code = driverErrorCode(err);
  if (!code) return null;
  if (code.startsWith('SQLITE_BUSY')) return 'busy';
  if (code.startsWith('SQLITE_LOCKED')) return 'locked';
  return null;
}

/**
 * True when the database refused the work because someone else holds the lock —
 * the question a caller asks when it does not care WHICH family, only that
 * retrying later is the right advice.
 */
export function isSqliteContention(err: unknown): boolean {
  return classifySqliteContention(err) !== null;
}
