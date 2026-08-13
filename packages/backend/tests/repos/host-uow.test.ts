import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database as Db } from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { HostCredentialRow, HostRow } from '@silverhand/shared';
import { createHostInvite } from '../../src/application/create-host-invite.js';
import { HostCredentialIssueError, HostTokenService } from '../../src/auth/host-token.js';
import type {
  HostAuthStatePort,
  HostCredentialsPort,
  HostSetupPort,
  HostTxScope,
} from '../../src/auth/host-ports.js';
import { HostRepo } from '../../src/repos/host-repo.js';
import { UserRepo } from '../../src/repos/user-repo.js';
import { openDatabase } from '../../src/db.js';
import { SqliteHostCredentialsRepo } from '../../src/repos/host-credentials-repo.js';
import { createSqliteHostPersistence } from '../../src/repos/host-uow.js';
import { openTestDb } from '../utils/db.js';

/** The host-token paths share the scope with the setup face but must never
 *  touch it (#task:1982 W5). A throwing stub makes an accidental use a failure
 *  instead of a silent no-op. */
const forbiddenSetupPort: HostSetupPort = {
  getSetupStateForUpdate: () => {
    throw new Error('host-token scope must not read setup state');
  },
  updateDisplayLabel: () => {
    throw new Error('host-token scope must not write display_label');
  },
  markFinalized: () => {
    throw new Error('host-token scope must not finalize');
  },
};

function bootstrap() {
  const { db } = openTestDb();
  const hosts = new HostRepo(db);
  const host = hosts.create('owned-local', 'local', {
    userId: 'local',
    installationId: 'installation-uow-1',
  });
  const persistence = createSqliteHostPersistence(db);
  return {
    db,
    hosts,
    hostId: host.id,
    uow: persistence.uow,
    credentials: persistence.credentials,
    service: new HostTokenService(persistence),
  };
}

function countRows(t: ReturnType<typeof bootstrap>): number {
  return t.db
    .prepare<[], { c: number }>(`SELECT COUNT(*) AS c FROM host_credentials`)
    .get()!.c;
}

describe('SqliteHostUnitOfWork + HostTokenService atomic boundaries', () => {
  it('issueHostToken: eligibility read + insert share one transaction; ineligible host writes NOTHING', () => {
    const t = bootstrap();
    // eligible path issues
    const issued = t.service.issueHostToken({ hostId: t.hostId });
    expect(issued.credential.host_id).toBe(t.hostId);

    // revoke the host, then re-issue: eligibility fails INSIDE the tx → zero new rows
    t.hosts.revoke(t.hostId, Date.now());
    const before = countRows(t);
    expect(() => t.service.issueHostToken({ hostId: t.hostId })).toThrow(
      HostCredentialIssueError,
    );
    expect(countRows(t)).toBe(before);
  });

  it('issueHostToken: insert failure after a passing eligibility check rolls back atomically', () => {
    const t = bootstrap();
    const failing: HostTxScope = {
      setup: forbiddenSetupPort,
      hosts: {
        getAuthState: id => {
          const row = t.hosts.get(id);
          return row ? { userId: row.user_id, revokedAt: row.revoked_at } : null;
        },
        getAuthStateForUpdate: id => {
          const row = t.hosts.get(id);
          return row ? { userId: row.user_id, revokedAt: row.revoked_at } : null;
        },
        revoke: (id, at) => t.hosts.revoke(id, at),
        createUserInvite: input => t.hosts.createUserInvite(input),
      },
      credentials: new (class extends SqliteHostCredentialsRepo {
        override insert(): never {
          throw new Error('insert-blows-up');
        }
      })(t.db),
    };
    const service = new HostTokenService({
      credentials: failing.credentials,
      hosts: failing.hosts,
      uow: {
        atomically: <T,>(fn: (tx: HostTxScope) => T): T =>
          t.db.transaction(() => fn(failing))(),
      },
    });
    const before = countRows(t);
    expect(() => service.issueHostToken({ hostId: t.hostId })).toThrow('insert-blows-up');
    expect(countRows(t)).toBe(before);
  });

  it('rotation: new-credential insert and old-credential sweep commit or roll back together', () => {
    const t = bootstrap();
    const first = t.service.issueHostToken({ hostId: t.hostId });
    // make the sweep blow up mid-transaction → the new credential must vanish too
    const failing: HostTxScope = {
      setup: forbiddenSetupPort,
      hosts: {
        getAuthState: id => {
          const row = t.hosts.get(id);
          return row ? { userId: row.user_id, revokedAt: row.revoked_at } : null;
        },
        getAuthStateForUpdate: id => {
          const row = t.hosts.get(id);
          return row ? { userId: row.user_id, revokedAt: row.revoked_at } : null;
        },
        revoke: (id, at) => t.hosts.revoke(id, at),
        createUserInvite: input => t.hosts.createUserInvite(input),
      },
      credentials: new (class extends SqliteHostCredentialsRepo {
        override revokeOtherLongLivedForHost(): never {
          throw new Error('sweep-blows-up');
        }
      })(t.db),
    };
    const service = new HostTokenService({
      credentials: failing.credentials,
      hosts: failing.hosts,
      uow: {
        atomically: <T,>(fn: (tx: HostTxScope) => T): T =>
          t.db.transaction(() => fn(failing))(),
      },
    });
    const before = countRows(t);
    expect(() => service.rotateHostTokenImmediate({ hostId: t.hostId })).toThrow(
      'sweep-blows-up',
    );
    expect(countRows(t)).toBe(before);
    // and the pre-existing credential is still active
    expect(t.service.verifyHostToken(first.hostToken).ok).toBe(true);
  });

  it('createHostInvite: host row and first credential commit or roll back together', () => {
    const t = bootstrap();
    const hostsBefore = t.db
      .prepare<[], { c: number }>(`SELECT COUNT(*) AS c FROM hosts`)
      .get()!.c;
    const failing: HostTxScope = {
      setup: forbiddenSetupPort,
      hosts: {
        getAuthState: id => {
          const row = t.hosts.get(id);
          return row ? { userId: row.user_id, revokedAt: row.revoked_at } : null;
        },
        getAuthStateForUpdate: id => {
          const row = t.hosts.get(id);
          return row ? { userId: row.user_id, revokedAt: row.revoked_at } : null;
        },
        revoke: (id, at) => t.hosts.revoke(id, at),
        createUserInvite: input => t.hosts.createUserInvite(input),
      },
      credentials: new (class extends SqliteHostCredentialsRepo {
        override insert(): never {
          throw new Error('credential-blows-up');
        }
      })(t.db),
    };
    const uow = {
      atomically: <T,>(fn: (tx: HostTxScope) => T): T =>
        t.db.transaction(() => fn(failing))(),
    };
    expect(() => createHostInvite({ uow }, { userId: 'local' })).toThrow(
      'credential-blows-up',
    );
    // the freshly-allocated host row rolled back with the failed credential
    expect(
      t.db.prepare<[], { c: number }>(`SELECT COUNT(*) AS c FROM hosts`).get()!.c,
    ).toBe(hostsBefore);

    // and the happy path commits both
    const created = createHostInvite({ uow: t.uow }, { userId: 'local' });
    expect(created.host.provisioning_source).toBe('user_invite');
    expect(t.service.verifyHostToken(created.issued.hostToken).ok).toBe(true);
  });

  it('hasActiveLongLivedCredential: every predicate of the semantic read-model flips the verdict', () => {
    const t = bootstrap();
    const now = Date.now();
    // no credential at all
    expect(t.service.hasActiveLongLivedCredential(t.hostId, { now })).toBe(false);
    // active long-lived
    const issued = t.service.issueHostToken({ hostId: t.hostId });
    expect(t.service.hasActiveLongLivedCredential(t.hostId, { now })).toBe(true);
    // expired
    t.db
      .prepare(`UPDATE host_credentials SET expires_at = ? WHERE id = ?`)
      .run(now - 1, issued.credential.id);
    expect(t.service.hasActiveLongLivedCredential(t.hostId, { now })).toBe(false);
    t.db
      .prepare(`UPDATE host_credentials SET expires_at = NULL WHERE id = ?`)
      .run(issued.credential.id);
    // consumed
    t.db
      .prepare(`UPDATE host_credentials SET consumed_at = ? WHERE id = ?`)
      .run(now, issued.credential.id);
    expect(t.service.hasActiveLongLivedCredential(t.hostId, { now })).toBe(false);
    t.db
      .prepare(`UPDATE host_credentials SET consumed_at = NULL WHERE id = ?`)
      .run(issued.credential.id);
    // revoked credential
    t.db
      .prepare(`UPDATE host_credentials SET revoked_at = ? WHERE id = ?`)
      .run(now, issued.credential.id);
    expect(t.service.hasActiveLongLivedCredential(t.hostId, { now })).toBe(false);
    t.db
      .prepare(`UPDATE host_credentials SET revoked_at = NULL WHERE id = ?`)
      .run(issued.credential.id);
    // non-long-lived kind
    t.db
      .prepare(`UPDATE host_credentials SET kind = 'bootstrap' WHERE id = ?`)
      .run(issued.credential.id);
    expect(t.service.hasActiveLongLivedCredential(t.hostId, { now })).toBe(false);
    t.db
      .prepare(`UPDATE host_credentials SET kind = 'long_lived' WHERE id = ?`)
      .run(issued.credential.id);
    // host unbound
    t.db.prepare(`UPDATE hosts SET user_id = NULL WHERE id = ?`).run(t.hostId);
    expect(t.service.hasActiveLongLivedCredential(t.hostId, { now })).toBe(false);
    t.db.prepare(`UPDATE hosts SET user_id = 'local' WHERE id = ?`).run(t.hostId);
    // host revoked
    t.db.prepare(`UPDATE hosts SET revoked_at = ? WHERE id = ?`).run(now, t.hostId);
    expect(t.service.hasActiveLongLivedCredential(t.hostId, { now })).toBe(false);
  });
});

describe('capability contract: locking vs non-locking eligibility read', () => {
  // Pins the P1 invariant with distinguishable throwing ports: each operation
  // must call the CORRECT capability and must fail if it ever calls the
  // forbidden one — no engine simulation needed, only "did the domain choose
  // the right read".
  function makeScope(
    forbidden: ReadonlySet<'getAuthState' | 'getAuthStateForUpdate'>,
  ) {
    const calls: string[] = [];
    const hosts: HostAuthStatePort = {
      getAuthState() {
        calls.push('getAuthState');
        if (forbidden.has('getAuthState')) {
          throw new Error('forbidden capability used: getAuthState');
        }
        return { userId: 'local', revokedAt: null };
      },
      getAuthStateForUpdate() {
        calls.push('getAuthStateForUpdate');
        if (forbidden.has('getAuthStateForUpdate')) {
          throw new Error('forbidden capability used: getAuthStateForUpdate');
        }
        return { userId: 'local', revokedAt: null };
      },
      revoke: () => false,
      createUserInvite: () => ({ id: 'host-1' }) as HostRow,
    };
    const credentials: HostCredentialsPort = {
      insert: row =>
        ({
          id: 'cred-1',
          host_id: row.hostId,
          token_hash: row.tokenHash,
          kind: row.kind,
          expires_at: row.expiresAt,
          consumed_at: row.consumedAt,
          revoked_at: null,
        }) as HostCredentialRow,
      getById: () => null,
      lookupVerification: () => null,
      hasActiveLongLivedCredential: () => false,
      revokeById: () => false,
      revokeAllForHost: () => 0,
      revokeOtherLongLivedForHost: () => 0,
    };
    const service = new HostTokenService({
      credentials,
      hosts,
      uow: { atomically: fn => fn({ hosts, credentials, setup: forbiddenSetupPort }) },
    });
    return { service, calls };
  }

  it('prepareHostTokenRotation uses ONLY the non-locking read (transaction-free preflight)', () => {
    const { service, calls } = makeScope(new Set(['getAuthStateForUpdate']));
    expect(() => service.prepareHostTokenRotation({ hostId: 'host-1' })).not.toThrow();
    expect(calls).toEqual(['getAuthState']);
  });

  it('issueHostToken uses ONLY the locking read inside the transaction', () => {
    const { service, calls } = makeScope(new Set(['getAuthState']));
    expect(() => service.issueHostToken({ hostId: 'host-1' })).not.toThrow();
    expect(calls).toEqual(['getAuthStateForUpdate']);
  });

  it('completePreparedHostTokenRotation uses ONLY the locking read inside the transaction', () => {
    const { service, calls } = makeScope(new Set(['getAuthState']));
    const prepared = {
      hostId: 'host-1',
      hostToken: 'pre-generated-token',
      issuedAt: 1_000,
      graceUntil: 2_000,
    };
    expect(() => service.completePreparedHostTokenRotation(prepared)).not.toThrow();
    expect(calls).toEqual(['getAuthStateForUpdate']);
  });

  it('rotateHostTokenImmediate uses ONLY the locking read inside the transaction', () => {
    const { service, calls } = makeScope(new Set(['getAuthState']));
    expect(() => service.rotateHostTokenImmediate({ hostId: 'host-1' })).not.toThrow();
    expect(calls).toEqual(['getAuthStateForUpdate']);
  });
});

/**
 * The isolation mechanism itself, on a REAL second connection (#task:1982 review
 * round 3, finding 4). `openTestDb()` is `:memory:`, where a rival connection is
 * impossible, so these use a file — the only way to show that "one synchronous
 * connection" was never the mechanism and `BEGIN IMMEDIATE` is.
 */
type FileFixture = {
  db: Db;
  dbPath: string;
  hosts: HostRepo;
  hostId: string;
  owner: string;
  uow: ReturnType<typeof createSqliteHostPersistence>['uow'];
};

const FILE_OWNER = 'owner-user';

function fileFixture(cleanups: Array<() => void>): FileFixture {
  const dir = mkdtempSync(join(tmpdir(), 'silverhand-host-uow-test-'));
  const dbPath = join(dir, 'silverhand.db');
  const db = openDatabase(dbPath, { busyTimeoutMs: 0 });
  cleanups.push(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  new UserRepo(db).create({ id: FILE_OWNER, name: FILE_OWNER, displayName: 'Owner' });
  const hosts = new HostRepo(db);
  const invited = hosts.createUserInvite({ userId: FILE_OWNER });
  hosts.markActivated(invited.id, 1700000001000);
  return {
    db,
    dbPath,
    hosts,
    hostId: invited.id,
    owner: FILE_OWNER,
    uow: createSqliteHostPersistence(db).uow,
  };
}

describe('SqliteHostUnitOfWork isolation on a second connection', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const fn of cleanups.splice(0)) fn();
  });

  it('a rival holding the write lock means the callback never runs — the authoritative read cannot happen on unowned state', () => {
    const t = fileFixture(cleanups);
    const rival = openDatabase(t.dbPath, { busyTimeoutMs: 0 });
    cleanups.unshift(() => rival.close());

    rival.exec('BEGIN IMMEDIATE');
    let callbackRan = false;
    try {
      let thrown: unknown;
      try {
        t.uow.atomically(() => {
          callbackRan = true;
        });
      } catch (err) {
        thrown = err;
      }
      // BEGIN IMMEDIATE fails at BEGIN, so `getSetupStateForUpdate` /
      // `getAuthStateForUpdate` never observe a state another writer owns.
      expect(thrown).toMatchObject({ code: 'SQLITE_BUSY' });
    } finally {
      rival.exec('ROLLBACK');
    }
    expect(callbackRan).toBe(false);
  });

  it('while the scope is open no rival can change host state — the state the decision used is still true at commit', () => {
    const t = fileFixture(cleanups);
    const rival = openDatabase(t.dbPath, { busyTimeoutMs: 0 });
    cleanups.unshift(() => rival.close());

    let rivalError: unknown;
    const state = t.uow.atomically(tx => {
      const read = tx.setup.getSetupStateForUpdate(t.hostId);
      // The exact race the finalize decision would lose: a revoke landing
      // between the authoritative read and the writes derived from it.
      try {
        rival.prepare(`UPDATE hosts SET revoked_at = ? WHERE id = ?`).run(1, t.hostId);
      } catch (err) {
        rivalError = err;
      }
      tx.setup.updateDisplayLabel(t.hostId, 'Studio');
      tx.setup.markFinalized(t.hostId, 1700000002000);
      return read;
    });

    expect(state?.revokedAt).toBeNull();
    expect(rivalError).toMatchObject({ code: 'SQLITE_BUSY' });
    const row = t.hosts.get(t.hostId);
    // The read stayed true: the host this finalize acted on is still unrevoked.
    expect(row?.revoked_at).toBeNull();
    expect(row?.display_label).toBe('Studio');
    expect(row?.finalized_at).toBe(1700000002000);
  });

  it('the immediate policy is root-only and refuses loudly when nested', () => {
    const t = fileFixture(cleanups);
    // Nested, `.immediate()` degrades to a SAVEPOINT that takes NO write lock —
    // the authoritative reads would then rest on nothing.
    t.db.transaction(() => {
      expect(() => t.uow.atomically(() => undefined)).toThrow(/root-only/);
    })();
  });

  it('no physical hosts column crosses the setup write faces (R4)', () => {
    const t = fileFixture(cleanups);
    const row = t.hosts.get(t.hostId);
    expect(row).not.toBeNull();
    if (!row) return;
    const dtoKeys = Object.keys(t.hosts.toDto(row)).sort();
    const rowOnly = Object.keys(row).filter(key => !dtoKeys.includes(key));
    // §CG: the claim below is only meaningful if row-only columns exist at all.
    expect(rowOnly.length).toBeGreaterThan(0);

    const returned = t.uow.atomically(tx => [
      tx.setup.updateDisplayLabel(t.hostId, 'Studio'),
      tx.setup.markFinalized(t.hostId, 1700000002000),
    ]);
    for (const projection of returned) {
      expect(projection).not.toBeNull();
      // Key-set, not a type assertion: the adapter returns the wire projection
      // built from the row, so no physical column can ride along.
      expect(Object.keys(projection ?? {}).sort()).toEqual(dtoKeys);
      expect(Object.keys(projection ?? {}).filter(key => rowOnly.includes(key))).toEqual([]);
    }
  });
});
