/**
 * The driver-error dialect (#task:1983 W4). This is the ONE module that decides
 * which SQLite result codes mean contention, so the family rule is pinned here
 * rather than at each of the three call sites that used to answer it privately.
 */
import { describe, expect, it } from 'vitest';
import {
  classifySqliteContention,
  driverErrorCode,
  isSqliteContention,
} from '../src/db-errors.js';

/** better-sqlite3 throws an `Error` carrying a string `code`. */
function driverError(code: string): Error & { code: string } {
  return Object.assign(new Error(`fake ${code}`), { code });
}

describe('db-errors: driverErrorCode', () => {
  it('returns the code only when it is a string', () => {
    expect(driverErrorCode(driverError('SQLITE_BUSY'))).toBe('SQLITE_BUSY');
    expect(driverErrorCode(Object.assign(new Error('x'), { code: 5 }))).toBeUndefined();
    expect(driverErrorCode(new Error('no code'))).toBeUndefined();
    expect(driverErrorCode(null)).toBeUndefined();
    expect(driverErrorCode(undefined)).toBeUndefined();
    expect(driverErrorCode('SQLITE_BUSY')).toBeUndefined();
  });
});

describe('db-errors: classifySqliteContention', () => {
  it('classifies the whole SQLITE_BUSY family as busy', () => {
    for (const code of [
      'SQLITE_BUSY',
      'SQLITE_BUSY_RECOVERY',
      'SQLITE_BUSY_SNAPSHOT',
      'SQLITE_BUSY_TIMEOUT',
    ]) {
      expect(classifySqliteContention(driverError(code)), code).toBe('busy');
    }
  });

  it('classifies the whole SQLITE_LOCKED family as locked', () => {
    for (const code of ['SQLITE_LOCKED', 'SQLITE_LOCKED_SHAREDCACHE', 'SQLITE_LOCKED_VTAB']) {
      expect(classifySqliteContention(driverError(code)), code).toBe('locked');
    }
  });

  it('does not guess a family for any other driver code', () => {
    for (const code of [
      'SQLITE_CONSTRAINT_UNIQUE',
      'SQLITE_CORRUPT',
      'SQLITE_READONLY_DBMOVED',
      'SQLITE_CANTOPEN',
      'SQLITE_IOERR_WRITE',
    ]) {
      expect(classifySqliteContention(driverError(code)), code).toBeNull();
    }
  });

  it('survives every non-driver error shape these paths actually see', () => {
    // `openDatabase` can throw a plain Error, a callback can throw anything at
    // all, and the statement chokepoint also asks about the NO-error case.
    for (const err of [null, undefined, new Error('boom'), 'string', 42, {}, { code: 5 }]) {
      expect(classifySqliteContention(err)).toBeNull();
      expect(isSqliteContention(err)).toBe(false);
    }
  });

  it('is the prefix rule, not an exact-code list — the regression W4 fixed', () => {
    // The offline admin command used to ask `String(err.code) === 'SQLITE_BUSY'`,
    // so an extended code in a family it MEANT to catch escaped its `db_locked`
    // mapping and reached the operator as a raw driver error. SQLite extends
    // result codes in place, so an exact-equality predicate is wrong by
    // construction: these are the codes that predicate missed.
    const missedByExactEquality = ['SQLITE_BUSY_SNAPSHOT', 'SQLITE_LOCKED'];
    for (const code of missedByExactEquality) {
      expect(String(code) === 'SQLITE_BUSY', code).toBe(false);
      expect(isSqliteContention(driverError(code)), code).toBe(true);
    }
  });
});
