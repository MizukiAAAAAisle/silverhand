import type { Database as Db } from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { UserRow } from '@silverhand/shared';
import {
  PasswordCredentialService,
  type Argon2idPasswordHashParams,
  type PasswordHashResult,
  type PasswordHasher,
} from '../../src/auth/password.js';
import { AuthSessionService } from '../../src/auth/session.js';
import { UserAuthService } from '../../src/auth/user-auth-service.js';
import { isParticipantHandleAvailable } from '../../src/application/name-availability.js';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { SqliteAuthCredentialsRepo } from '../../src/repos/auth-credentials-repo.js';
import { SqliteAuthSessionsRepo } from '../../src/repos/auth-sessions-repo.js';
import {
  createHandleNamespacePort,
  createSqliteAuthUnitOfWork,
} from '../../src/repos/auth-uow.js';
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

/**
 * A `UserRepo` whose first read on each lookup lies "nothing found", then tells
 * the truth. This is how a pre-check goes stale in production — a row appears
 * between the check and the INSERT — without needing a second writer process.
 */
class StaleReadsUserRepo extends UserRepo {
  readonly staleReads = { byName: 1, byEmail: 1 };

  override getByName(name: string): UserRow | null {
    if (this.staleReads.byName > 0) {
      this.staleReads.byName -= 1;
      return null;
    }
    return super.getByName(name);
  }

  override getByEmail(email: string): UserRow | null {
    if (this.staleReads.byEmail > 0) {
      this.staleReads.byEmail -= 1;
      return null;
    }
    return super.getByEmail(email);
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
    const sessions = new AuthSessionService(new SqliteAuthSessionsRepo(db));
    const hasher = new FakePasswordHasher();
    const passwordCredentials = new PasswordCredentialService(new SqliteAuthCredentialsRepo(db), hasher);
    await passwordCredentials.setUserPasswordCredential('local', 'old-password');
    const localSession = sessions.issueSession({ userId: 'local' });
    const aliceSession = sessions.issueSession({ userId: 'alice' });

    const service = new UserAuthService({
      uow: createSqliteAuthUnitOfWork(db, { txMode: 'deferred' }),
      users: new UserRepo(db),
      handles: createHandleNamespacePort(db),
      passwordCredentials,
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
    const hasher = new FakePasswordHasher();
    const service = new UserAuthService({
      uow: createSqliteAuthUnitOfWork(db, { txMode: 'deferred' }),
      users: new UserRepo(db),
      handles: createHandleNamespacePort(db),
      passwordCredentials: new PasswordCredentialService(new SqliteAuthCredentialsRepo(db), hasher),
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

describe('UserAuthService.signup — answer ordering and cost floor', () => {
  let db: Db | null = null;

  afterEach(() => {
    db?.close();
    db = null;
  });

  function build(database: Db): {
    service: UserAuthService;
    hasher: FakePasswordHasher;
  } {
    const hasher = new FakePasswordHasher();
    return {
      hasher,
      service: new UserAuthService({
        uow: createSqliteAuthUnitOfWork(database, { txMode: 'deferred' }),
        users: new UserRepo(database),
        handles: createHandleNamespacePort(database),
        passwordCredentials: new PasswordCredentialService(new SqliteAuthCredentialsRepo(database), hasher),
      }),
    };
  }

  it('pays exactly one hash per attempt whichever answer it returns', async () => {
    // The cost floor is what keeps BOTH answers off the "cheap probe" list: if
    // the handle verdict short-circuited before the password work, an attacker
    // could enumerate handles at query speed instead of at Argon2id speed.
    const opened = openTestDb();
    db = opened.db;
    db.prepare(`UPDATE users SET email = 'alice@example.com' WHERE id = 'alice'`).run();
    const { service, hasher } = build(db);

    await expect(
      service.signup({
        email: 'fresh@example.com',
        password: 'correct-password',
        name: 'alice-test',
      }),
    ).resolves.toEqual({ ok: false, code: 'handle_taken' });
    await expect(
      service.signup({
        email: 'alice@example.com',
        password: 'correct-password',
        name: 'free-handle',
      }),
    ).resolves.toEqual({ ok: false, code: 'auth_failed' });
    await expect(
      service.signup({
        email: 'fresh@example.com',
        password: 'correct-password',
        name: 'fresh-handle',
      }),
    ).resolves.toMatchObject({ ok: true });

    expect(hasher.hashCalls).toEqual([
      'correct-password',
      'correct-password',
      'correct-password',
    ]);
  });

  it('reports a taken handle held by an AGENT, not just by another user', async () => {
    const opened = openTestDb();
    db = opened.db;
    new AgentRepo(db).create(
      { name: 'botname', runtime: 'claude' },
      opened.localHostId,
      'local',
    );
    const { service } = build(db);

    await expect(
      service.signup({
        email: 'human@example.com',
        password: 'correct-password',
        name: 'botname',
      }),
    ).resolves.toEqual({ ok: false, code: 'handle_taken' });
    expect(new UserRepo(db).getByEmail('human@example.com')).toBeNull();
  });

  it('keeps the handle answer first when the DB reports the email conflict', async () => {
    // The DB-conflict path is the SECOND place the ordering has to hold. With a
    // stale pre-check and BOTH axes taken, `users.email` UNIQUE fires before the
    // name trigger, so mapping each SQLite error 1:1 would answer 401 for a
    // taken handle — an email-existence oracle in the race window. `StaleReads`
    // reproduces exactly that: the pre-check sees a free handle and a free
    // email, and the row is there by INSERT time.
    const opened = openTestDb();
    db = opened.db;
    db.prepare(`UPDATE users SET email = 'alice@example.com' WHERE id = 'alice'`).run();
    const users = new StaleReadsUserRepo(db);
    // The handle probe must consume the SAME stale reader: the lie has to
    // cover the pre-check so the conflict re-answer path is what gets tested.
    const agents = new AgentRepo(db);
    const service = new UserAuthService({
      uow: createSqliteAuthUnitOfWork(db, { txMode: 'deferred' }),
      users,
      handles: {
        isParticipantHandleTaken: name =>
          !isParticipantHandleAvailable({ agents, users }, name),
      },
      passwordCredentials: new PasswordCredentialService(
        new SqliteAuthCredentialsRepo(db),
        new FakePasswordHasher(),
      ),
    });
    const usersBefore = new UserRepo(db).list().length;

    await expect(
      service.signup({
        email: 'alice@example.com',
        password: 'correct-password',
        name: 'alice-test',
      }),
    ).resolves.toEqual({ ok: false, code: 'handle_taken' });
    // Both lies were spent, i.e. the pre-check really did read "free".
    expect(users.staleReads).toEqual({ byName: 0, byEmail: 0 });
    expect(new UserRepo(db).list()).toHaveLength(usersBefore);
  });
});
