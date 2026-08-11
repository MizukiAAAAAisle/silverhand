import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database as Db } from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db.js';
import { SqliteAuthCredentialsRepo } from '../../src/repos/auth-credentials-repo.js';
import { createSqliteAuthUnitOfWork } from '../../src/repos/auth-uow.js';
import { openTestDb } from '../utils/db.js';
import type { PasswordHashResult } from '../../src/auth/password.js';

const PREPARED: PasswordHashResult = {
  passwordHash: 'phc-test-hash',
  passwordHashParams: {
    algorithm: 'argon2id',
    library: '@node-rs/argon2',
    version: '0x13',
    memoryCostKiB: 19456,
    timeCost: 2,
    parallelism: 1,
    outputLen: 32,
    benchmark: {
      targetMs: 1,
      measuredMs: 1,
      candidateCount: 1,
      selectedAt: 0,
      cpuCount: 1,
      totalMemoryMiB: 1,
    },
  },
};

describe('SqliteAuthUnitOfWork', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const fn of cleanups.splice(0)) fn();
  });

  function fileDbPair(): { writer: Db; contender: Db } {
    const dir = mkdtempSync(join(tmpdir(), 'silverhand-uow-test-'));
    const dbPath = join(dir, 'silverhand.db');
    const writer = openDatabase(dbPath, { busyTimeoutMs: 0 });
    const contender = openDatabase(dbPath, { busyTimeoutMs: 0 });
    cleanups.push(() => {
      writer.close();
      contender.close();
      rmSync(dir, { recursive: true, force: true });
    });
    return { writer, contender };
  }

  it('deferred policy: commits scope writes atomically and rolls back on callback throw', () => {
    const { db } = openTestDb();
    cleanups.push(() => db.close());
    const uow = createSqliteAuthUnitOfWork(db, { txMode: 'deferred' });

    const userId = uow.atomically(tx => {
      const row = tx.users.create({
        id: 'u1',
        name: 'newbie',
        displayName: 'Newbie',
        email: 'newbie@example.com',
      });
      tx.credentials.upsertPreparedCredential(row.id, PREPARED);
      return row.id;
    });
    const credentials = new SqliteAuthCredentialsRepo(db);
    expect(credentials.getCredential(userId)?.password_hash).toBe('phc-test-hash');

    expect(() =>
      uow.atomically(tx => {
        tx.credentials.upsertPreparedCredential(userId, {
          ...PREPARED,
          passwordHash: 'phc-should-roll-back',
        });
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(credentials.getCredential(userId)?.password_hash).toBe('phc-test-hash');
  });

  it('immediate policy: a concurrent writer surfaces BEFORE the callback runs any step', () => {
    const { writer, contender } = fileDbPair();
    const uow = createSqliteAuthUnitOfWork(writer, { txMode: 'immediate' });

    contender.exec('BEGIN IMMEDIATE');
    let callbackRan = false;
    try {
      let thrown: unknown;
      try {
        uow.atomically(() => {
          callbackRan = true;
        });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toMatchObject({ code: 'SQLITE_BUSY', message: /database is locked/ });
    } finally {
      contender.exec('ROLLBACK');
    }
    expect(callbackRan).toBe(false);

    // and once the contender releases the lock, the same UoW works
    const ok = uow.atomically(() => 'through');
    expect(ok).toBe('through');
  });

  it('immediate policy is root-only: refuses loudly inside an outer transaction', () => {
    const { db } = openTestDb();
    cleanups.push(() => db.close());
    const uow = createSqliteAuthUnitOfWork(db, { txMode: 'immediate' });

    db.transaction(() => {
      expect(() => uow.atomically(() => undefined)).toThrow(/root-only/);
    })();
  });

  it('deferred policy nests as a savepoint under an outer transaction (documented semantics)', () => {
    const { db } = openTestDb();
    cleanups.push(() => db.close());
    const uow = createSqliteAuthUnitOfWork(db, { txMode: 'deferred' });

    expect(() =>
      db.transaction(() => {
        uow.atomically(tx => {
          tx.users.create({
            id: 'u2',
            name: 'nested',
            displayName: 'Nested',
            email: 'nested@example.com',
          });
        });
        throw new Error('outer-rollback');
      })(),
    ).toThrow('outer-rollback');
    // outer rollback takes the inner savepoint's write with it
    const row = db
      .prepare(`SELECT id FROM users WHERE id = 'u2'`)
      .get();
    expect(row).toBeUndefined();
  });
});
