import type { Database as Db } from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  Argon2idPasswordHasher,
  PasswordCredentialService,
  benchmarkPasswordHashParams,
  type Argon2idPasswordHashParams,
  type PasswordHashResult,
  type PasswordHasher,
} from '../../src/auth/password.js';
import { openTestDb } from '../utils/db.js';
import {
  parsePasswordHashParams,
  SqliteAuthCredentialsRepo,
} from '../../src/repos/auth-credentials-repo.js';

const TEST_PARAMS: Argon2idPasswordHashParams = {
  algorithm: 'argon2id',
  library: '@node-rs/argon2',
  version: '0x13',
  memoryCostKiB: 64,
  timeCost: 1,
  parallelism: 1,
  outputLen: 16,
  benchmark: {
    targetMs: 1,
    measuredMs: 1,
    candidateCount: 1,
    selectedAt: 1,
    cpuCount: 1,
    totalMemoryMiB: 1,
  },
};

class FakePasswordHasher implements PasswordHasher {
  readonly hashCalls: string[] = [];
  readonly verifyCalls: Array<{ password: string; passwordHash: string }> = [];
  readonly dummyCalls: string[] = [];

  async hashPassword(password: string): Promise<PasswordHashResult> {
    this.hashCalls.push(password);
    return {
      passwordHash: `hash:${password}`,
      passwordHashParams: TEST_PARAMS,
    };
  }

  async verifyPassword(
    password: string,
    passwordHash: string,
  ): Promise<boolean> {
    this.verifyCalls.push({ password, passwordHash });
    return passwordHash === 'hash:correct-horse' && password === 'correct-horse';
  }

  async verifyDummyPassword(password: string): Promise<boolean> {
    this.dummyCalls.push(password);
    return false;
  }
}

describe('Argon2id password auth helpers', () => {
  let db: Db | null = null;

  afterEach(() => {
    db?.close();
    db = null;
  });

  it('hashes with Argon2id params and verifies correct and wrong passwords', async () => {
    const hasher = new Argon2idPasswordHasher({
      paramsProvider: async () => TEST_PARAMS,
      dummyPassword: 'dummy-password',
    });

    const result = await hasher.hashPassword('correct-horse');
    expect(result.passwordHash).toMatch(/^\$argon2id\$/);
    expect(result.passwordHashParams).toMatchObject({
      algorithm: 'argon2id',
      library: '@node-rs/argon2',
      memoryCostKiB: TEST_PARAMS.memoryCostKiB,
      timeCost: TEST_PARAMS.timeCost,
      parallelism: TEST_PARAMS.parallelism,
    });
    await expect(
      hasher.verifyPassword('correct-horse', result.passwordHash),
    ).resolves.toBe(true);
    await expect(
      hasher.verifyPassword('wrong-password', result.passwordHash),
    ).resolves.toBe(false);
  });

  it('benchmarks params from measured candidates instead of fixed production constants', async () => {
    const params = await benchmarkPasswordHashParams({
      targetMs: 25,
      candidates: [
        { memoryCostKiB: 64, timeCost: 1, parallelism: 1, outputLen: 16 },
        { memoryCostKiB: 128, timeCost: 1, parallelism: 1, outputLen: 16 },
        { memoryCostKiB: 256, timeCost: 1, parallelism: 1, outputLen: 16 },
      ],
      measureCandidate: async candidate => candidate.memoryCostKiB / 8,
    });

    expect(params).toMatchObject({
      algorithm: 'argon2id',
      library: '@node-rs/argon2',
      memoryCostKiB: 19 * 1024,
      timeCost: 2,
      parallelism: 1,
      outputLen: 16,
      benchmark: {
        targetMs: 25,
        measuredMs: 32,
        candidateCount: 3,
        flooredFrom: {
          memoryCostKiB: 256,
          timeCost: 1,
        },
      },
    });
  });

  it('stores params JSON and verifies login passwords by email', async () => {
    const opened = openTestDb();
    db = opened.db;
    db.prepare(`UPDATE users SET email = 'Local@Example.com' WHERE id = 'local'`).run();
    const fake = new FakePasswordHasher();
    const service = new PasswordCredentialService(new SqliteAuthCredentialsRepo(db), fake);

    const row = await service.setUserPasswordCredential('local', 'correct-horse');
    expect(row.password_hash).toBe('hash:correct-horse');
    expect(parsePasswordHashParams(row.password_hash_params)).toMatchObject({
      algorithm: 'argon2id',
      memoryCostKiB: TEST_PARAMS.memoryCostKiB,
    });

    await expect(
      service.verifyLoginPassword({
        email: 'local@example.com',
        password: 'correct-horse',
      }),
    ).resolves.toEqual({ ok: true, userId: 'local' });
    await expect(
      service.verifyLoginPassword({
        email: 'local@example.com',
        password: 'wrong-password',
      }),
    ).resolves.toEqual({ ok: false, code: 'auth_failed' });

    expect(fake.hashCalls).toEqual(['correct-horse']);
    expect(fake.verifyCalls).toEqual([
      { password: 'correct-horse', passwordHash: 'hash:correct-horse' },
      { password: 'wrong-password', passwordHash: 'hash:correct-horse' },
    ]);
    expect(fake.dummyCalls).toEqual([]);
  });

  it('uses the dummy verify path for missing users and profile-only users', async () => {
    const opened = openTestDb();
    db = opened.db;
    db.prepare(`UPDATE users SET email = 'profile@example.com' WHERE id = 'alice'`).run();
    const fake = new FakePasswordHasher();
    const service = new PasswordCredentialService(new SqliteAuthCredentialsRepo(db), fake);

    await expect(
      service.verifyLoginPassword({
        email: 'missing@example.com',
        password: 'same-shape',
      }),
    ).resolves.toEqual({ ok: false, code: 'auth_failed' });
    await expect(
      service.verifyLoginPassword({
        email: 'profile@example.com',
        password: 'same-shape',
      }),
    ).resolves.toEqual({ ok: false, code: 'auth_failed' });

    expect(fake.verifyCalls).toEqual([]);
    expect(fake.dummyCalls).toEqual(['same-shape', 'same-shape']);
  });
});
