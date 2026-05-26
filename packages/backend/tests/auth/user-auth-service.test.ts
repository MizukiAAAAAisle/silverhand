import type { Database as Db } from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PasswordCredentialService,
  type Argon2idPasswordHashParams,
  type PasswordHashResult,
  type PasswordHasher,
} from '../../src/auth/password.js';
import { AuthSessionService } from '../../src/auth/session.js';
import { UserAuthService } from '../../src/auth/user-auth-service.js';
import { UserRepo } from '../../src/repos/user-repo.js';
import { openTestDb } from '../utils/db.js';

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
    return passwordHash === `hash:${password}`;
  }

  async verifyDummyPassword(password: string): Promise<boolean> {
    this.dummyCalls.push(password);
    return false;
  }
}

describe('UserAuthService.resetPassword', () => {
  let db: Db | null = null;

  afterEach(() => {
    db?.close();
    db = null;
  });

  it('updates an existing user credential and revokes their active sessions', async () => {
    const opened = openTestDb();
    db = opened.db;
    db.prepare(`UPDATE users SET email = 'Local@Example.com' WHERE id = 'local'`).run();
    db.prepare(`UPDATE users SET email = 'alice@example.com' WHERE id = 'alice'`).run();
    const sessions = new AuthSessionService(db);
    const hasher = new FakePasswordHasher();
    const passwordCredentials = new PasswordCredentialService(db, hasher);
    await passwordCredentials.setUserPasswordCredential('local', 'old-password');
    const localSession = sessions.issueSession({ userId: 'local' });
    const aliceSession = sessions.issueSession({ userId: 'alice' });

    const service = new UserAuthService({
      db,
      users: new UserRepo(db),
      passwordCredentials,
      authSessions: sessions,
    });
    await expect(
      service.resetPassword({
        email: 'local@example.com',
        password: 'new-password',
      }),
    ).resolves.toEqual({
      ok: true,
      reset: {
        userId: 'local',
        email: 'Local@Example.com',
        sessionsRevoked: 1,
      },
    });

    await expect(
      passwordCredentials.verifyLoginPassword({
        email: 'local@example.com',
        password: 'new-password',
      }),
    ).resolves.toEqual({ ok: true, userId: 'local' });
    expect(sessions.validateSessionToken(localSession.userToken)).toEqual({
      ok: false,
      code: 'auth_failed',
    });
    expect(sessions.validateSessionToken(aliceSession.userToken)).toMatchObject({
      ok: true,
      session: { user_id: 'alice' },
    });
    expect(hasher.hashCalls).toEqual(['old-password', 'new-password']);
  });

  it('fails missing email without hashing or creating a user', async () => {
    const opened = openTestDb();
    db = opened.db;
    const sessions = new AuthSessionService(db);
    const hasher = new FakePasswordHasher();
    const service = new UserAuthService({
      db,
      users: new UserRepo(db),
      passwordCredentials: new PasswordCredentialService(db, hasher),
      authSessions: sessions,
    });

    await expect(
      service.resetPassword({
        email: 'missing@example.com',
        password: 'new-password',
      }),
    ).resolves.toEqual({ ok: false, code: 'user_not_found' });
    expect(hasher.hashCalls).toEqual([]);
    expect(new UserRepo(db).getByEmail('missing@example.com')).toBeNull();
  });
});
