/**
 * Adapter-level contract tests for the human-identity persistence composition
 * (#task:1982 W1). Three obligations that only a test at this level can state:
 *
 *  - `RegistrationUnitOfWork` declares the ISOLATION its single-viewer gate
 *    rests on: the gate is a read-then-write invariant over an EMPTY set, so
 *    atomicity alone does not close it. On SQLite the mechanism is the write
 *    lock taken at BEGIN (root-only `BEGIN IMMEDIATE`); "there is usually one
 *    writer" is not a mechanism, so a second connection gets pointed at it.
 *  - The membership backfill is all-or-nothing WITH the user row: a partial
 *    commit would leave a human who cannot see the workspaces they own.
 *  - `claimUnowned` is a guarded single statement. Its `WHERE owner_user_id IS
 *    NULL` is load-bearing — without it the backfill would silently reassign an
 *    owned workspace, and every other assertion here would still pass.
 */
import { fixedConversationTitle, fixedWorkspaceName } from '@silverhand/shared';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database as Db } from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../../src/db.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { createSqliteUserPersistence } from '../../src/repos/user-persistence.js';
import { UserRepo } from '../../src/repos/user-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';

/** A DB in the only state `register` can legally run against: schema present,
 *  `users` EMPTY. `openTestDb()` cannot serve these tests — it seeds fixture
 *  users, which is exactly what the single-viewer gate refuses. */
function openVirginDb(path = ':memory:', opts: { busyTimeoutMs?: number } = {}): Db {
  return openDatabase(path, opts);
}

function countRows(db: Db, table: string): number {
  return db.prepare<[], { c: number }>(`SELECT COUNT(*) AS c FROM ${table}`).get()?.c ?? 0;
}

describe('SqliteUserPersistence registration UnitOfWork isolation', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const fn of cleanups.splice(0)) fn();
  });

  /** Two connections on ONE file-backed DB. `:memory:` cannot express these
   *  tests at all — a second connection can never join an in-memory database.
   *  Both sides use `busyTimeoutMs: 0` so contention surfaces as an immediate
   *  `SQLITE_BUSY` instead of a five-second stall. */
  function fileBackedPair(): { writer: Db; contender: Db } {
    const dir = mkdtempSync(join(tmpdir(), 'silverhand-user-uow-test-'));
    const dbPath = join(dir, 'silverhand.db');
    const writer = openVirginDb(dbPath, { busyTimeoutMs: 0 });
    const contender = openVirginDb(dbPath, { busyTimeoutMs: 0 });
    cleanups.push(() => {
      writer.close();
      contender.close();
      rmSync(dir, { recursive: true, force: true });
    });
    return { writer, contender };
  }

  it('a rival writer cannot register a second viewer while the callback runs', () => {
    const { writer, contender } = fileBackedPair();
    const persistence = createSqliteUserPersistence(writer);
    // The rival is the SAME race the gate exists for: another connection
    // inserting the first human between our `anyExists()` read and our INSERT.
    const rivalRegister = contender.prepare(
      `INSERT INTO users (id, name, display_name, created_at, updated_at)
       VALUES ('rival', 'rival', 'Rival', 0, 0)`,
    );

    let rivalError: unknown;
    const observed = persistence.registration.atomically((tx) => {
      const before = tx.users.anyExists();
      try {
        rivalRegister.run();
      } catch (err) {
        rivalError = err;
      }
      tx.users.create({ id: 'first', name: 'first', displayName: 'First' });
      return { before, after: tx.users.anyExists() };
    });

    // Load-bearing: the rival was LOCKED OUT, not merely invisible. Under a
    // deferred BEGIN the callback's first statement is a read, the write lock
    // is not held yet, and this INSERT would succeed — two viewers, both of
    // which passed the gate.
    expect(rivalError).toMatchObject({ code: 'SQLITE_BUSY' });
    expect(observed).toEqual({ before: false, after: true });
    expect(writer.prepare<[], { id: string }>(`SELECT id FROM users`).all()).toEqual([
      { id: 'first' },
    ]);
  });

  it('the write lock is taken at BEGIN — contention surfaces before the callback runs a step', () => {
    const { writer, contender } = fileBackedPair();
    const persistence = createSqliteUserPersistence(writer);

    contender.exec('BEGIN IMMEDIATE');
    let callbackRan = false;
    try {
      let thrown: unknown;
      try {
        persistence.registration.atomically(() => {
          callbackRan = true;
        });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toMatchObject({ code: 'SQLITE_BUSY' });
    } finally {
      contender.exec('ROLLBACK');
    }
    // The gate read never happened, so it cannot have read a stale answer.
    expect(callbackRan).toBe(false);
  });

  it('immediate policy is root-only and refuses loudly when nested', () => {
    const db = openVirginDb();
    cleanups.push(() => db.close());
    const persistence = createSqliteUserPersistence(db);

    // Nested `.immediate()` silently degrades to a SAVEPOINT and takes no write
    // lock at all, which would leave the gate resting on nothing.
    db.transaction(() => {
      expect(() => persistence.registration.atomically(() => undefined)).toThrow(/root-only/);
    })();
  });
});

describe('SqliteUserPersistence registration scope', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const fn of cleanups.splice(0)) fn();
  });

  function seededVirginDb(): {
    db: Db;
    workspaceIds: string[];
    conversationIds: string[];
  } {
    const db = openVirginDb();
    cleanups.push(() => db.close());
    const workspaces = new WorkspaceRepo(db);
    const conversations = new ConversationRepo(db);
    const workspaceIds = ['alpha', 'beta'].map(
      (name) => workspaces.insert({ name: fixedWorkspaceName(name), description: null }).id,
    );
    const conversationIds = workspaceIds.map(
      (workspaceId) =>
        conversations.insertChannel({
          workspaceId,
          title: fixedConversationTitle(`${workspaceId}-room`),
        }).id,
    );
    return { db, workspaceIds, conversationIds };
  }

  it('backfills membership + owner role in every pre-existing workspace and conversation', () => {
    const { db, workspaceIds, conversationIds } = seededVirginDb();
    const persistence = createSqliteUserPersistence(db);

    const created = persistence.registration.atomically((tx) => {
      const row = tx.users.create({
        id: 'human',
        name: 'human',
        displayName: 'Human',
      });
      for (const workspaceId of tx.workspaces.listIds()) {
        tx.workspaces.addOwnerMember(workspaceId, row.id);
      }
      tx.workspaces.claimUnowned(row.id);
      for (const conversationId of tx.conversations.listIds()) {
        tx.conversations.addMember(conversationId, row.id);
      }
      return row;
    });

    expect(created.id).toBe('human');
    const workspaces = new WorkspaceRepo(db);
    for (const workspaceId of workspaceIds) {
      // Role, not mere membership: the first human GOVERNS what predates them.
      expect(workspaces.getUserRole(workspaceId, 'human')).toBe('owner');
      expect(workspaces.get(workspaceId)?.owner_user_id).toBe('human');
    }
    expect(
      db
        .prepare<[], { conversation_id: string }>(
          `SELECT conversation_id FROM conversation_users
            WHERE user_id = 'human' ORDER BY conversation_id`,
        )
        .all()
        .map((r) => r.conversation_id),
    ).toEqual([...conversationIds].sort());
  });

  it('listIds enumerates rows — archived workspaces and conversations included', () => {
    const { db, workspaceIds, conversationIds } = seededVirginDb();
    const persistence = createSqliteUserPersistence(db);
    // Archive one of each. The backfill's obligation is "every workspace /
    // conversation that exists": nothing re-runs it, so a row skipped here is
    // one the first human is locked out of FOREVER (un-archiving does not add
    // membership). This is the falsifier for reaching for a read model —
    // EVERY conversation projection filters `archived_at IS NULL`.
    db.prepare(`UPDATE workspaces SET archived_at = 1 WHERE id = ?`).run(workspaceIds[0]);
    db.prepare(`UPDATE conversations SET archived_at = 1 WHERE id = ?`).run(conversationIds[0]);

    const seen = persistence.registration.atomically((tx) => ({
      workspaces: tx.workspaces.listIds().sort(),
      conversations: tx.conversations.listIds().sort(),
    }));

    expect(seen).toEqual({
      workspaces: [...workspaceIds].sort(),
      conversations: [...conversationIds].sort(),
    });
  });

  it('claimUnowned claims what has no owner and cannot demote an owned workspace', () => {
    const { db, workspaceIds } = seededVirginDb();
    const persistence = createSqliteUserPersistence(db);
    const [owned, unowned] = workspaceIds;

    persistence.registration.atomically((tx) => {
      tx.users.create({ id: 'first', name: 'first', displayName: 'First' });
      tx.workspaces.addOwnerMember(owned!, 'first');
      db.prepare(`UPDATE workspaces SET owner_user_id = ? WHERE id = ?`).run('first', owned);
    });
    persistence.registration.atomically((tx) => {
      tx.users.create({ id: 'second', name: 'second', displayName: 'Second' });
      tx.workspaces.claimUnowned('second');
    });

    const workspaces = new WorkspaceRepo(db);
    expect(workspaces.get(owned!)?.owner_user_id).toBe('first');
    expect(workspaces.get(unowned!)?.owner_user_id).toBe('second');
  });

  it('rollback leaves no half-landed identity or membership', () => {
    const { db, workspaceIds } = seededVirginDb();
    const persistence = createSqliteUserPersistence(db);

    expect(() =>
      persistence.registration.atomically((tx) => {
        tx.users.create({ id: 'human', name: 'human', displayName: 'Human' });
        tx.workspaces.addOwnerMember(workspaceIds[0]!, 'human');
        tx.workspaces.claimUnowned('human');
        tx.conversations.addMember(tx.conversations.listIds()[0]!, 'human');
        // Anything after the writes: the service's own `already_registered`
        // throw takes this same path.
        throw new Error('boom');
      }),
    ).toThrow(/boom/);

    expect(countRows(db, 'users')).toBe(0);
    expect(countRows(db, 'workspace_users')).toBe(0);
    expect(countRows(db, 'conversation_users')).toBe(0);
    expect(
      db
        .prepare<[], { c: number }>(
          `SELECT COUNT(*) AS c FROM workspaces WHERE owner_user_id IS NOT NULL`,
        )
        .get()?.c,
    ).toBe(0);
  });

  it('anyExists answers the gate without reading rows it must not depend on', () => {
    const db = openVirginDb();
    cleanups.push(() => db.close());
    const persistence = createSqliteUserPersistence(db);

    expect(persistence.registration.atomically((tx) => tx.users.anyExists())).toBe(false);
    persistence.registration.atomically((tx) =>
      tx.users.create({ id: 'human', name: 'human', displayName: 'Human' }),
    );
    expect(persistence.registration.atomically((tx) => tx.users.anyExists())).toBe(true);
  });
});

describe('SqliteUserPersistence read + profile ports', () => {
  it('profile writes return the updated row and null for a user that does not exist', () => {
    const db = openVirginDb();
    const persistence = createSqliteUserPersistence(db);
    persistence.registration.atomically((tx) =>
      tx.users.create({ id: 'human', name: 'human', displayName: 'Human' }),
    );

    expect(persistence.read.get('human')?.display_name).toBe('Human');
    expect(persistence.read.list().map((r) => r.id)).toEqual(['human']);

    expect(
      persistence.profile.updateProfile('human', { display_name: 'Renamed' })?.display_name,
    ).toBe('Renamed');
    const withAvatar = persistence.profile.setAvatar('human', {
      storageKey: 'users/human/avatars/abc',
      contentType: 'image/png',
    });
    expect(withAvatar).toMatchObject({
      avatar_storage_key: 'users/human/avatars/abc',
      avatar_content_type: 'image/png',
    });
    expect(persistence.profile.clearAvatar('human')).toMatchObject({
      avatar_storage_key: null,
      avatar_content_type: null,
    });

    // A missing user is `null`, never a thrown driver error and never an
    // invented row — the service maps this to 404.
    expect(persistence.read.get('ghost')).toBeNull();
    expect(persistence.profile.updateProfile('ghost', { display_name: 'x' })).toBeNull();
    expect(
      persistence.profile.setAvatar('ghost', {
        storageKey: 'k',
        contentType: 'image/png',
      }),
    ).toBeNull();
    expect(persistence.profile.clearAvatar('ghost')).toBeNull();

    db.close();
  });

  /**
   * R4: the port publishes a PROJECTION, not the physical row. Asserted on the
   * KEY SET rather than by reading `email` / `last_seen_at`, because a
   * type-level `Omit<UserRow, …>` — or a spread-and-cast adapter — type-checks
   * while the object still carries both values at runtime. `SELECT *` always
   * materializes every column as a key, so this reddens for such an adapter
   * even when the columns are NULL.
   */
  it('every port surface returns the projection key set, never the physical row', () => {
    const db = openVirginDb();
    const persistence = createSqliteUserPersistence(db);

    // A row whose two non-projected columns are genuinely POPULATED, so the
    // leak this guards against would carry a real login email.
    const repo = new UserRepo(db);
    repo.create({
      id: 'human',
      name: 'human',
      displayName: 'Human',
      email: 'human@example.com',
    });
    repo.touchLastSeen('human', 1_700_000_000_000);
    expect(repo.get('human')?.email).toBe('human@example.com');

    const PROJECTION_KEYS = [
      'avatar_content_type',
      'avatar_storage_key',
      'created_at',
      'display_name',
      'id',
      'name',
      'updated_at',
    ];
    const keysOf = (value: object) => Object.keys(value).sort();

    expect(keysOf(persistence.read.get('human')!)).toEqual(PROJECTION_KEYS);
    expect(persistence.read.list().map(keysOf)).toEqual([PROJECTION_KEYS]);
    expect(
      keysOf(
        persistence.profile.updateProfile('human', {
          display_name: 'Renamed',
        })!,
      ),
    ).toEqual(PROJECTION_KEYS);
    expect(
      keysOf(
        persistence.profile.setAvatar('human', {
          storageKey: 'users/human/avatars/abc',
          contentType: 'image/png',
        })!,
      ),
    ).toEqual(PROJECTION_KEYS);
    expect(keysOf(persistence.profile.clearAvatar('human')!)).toEqual(PROJECTION_KEYS);

    // The in-transaction create is the sixth surface that hands a row out.
    const txDb = openVirginDb();
    const created = createSqliteUserPersistence(txDb).registration.atomically((tx) =>
      tx.users.create({ id: 'other', name: 'other', displayName: 'Other' }),
    );
    expect(keysOf(created)).toEqual(PROJECTION_KEYS);
    txDb.close();

    db.close();
  });
});

/**
 * The single-viewer gate asks EXISTENCE, and the adapter answers it with an
 * existence query. `list().length > 0` gives the same boolean, so no behavior
 * assertion can tell the two apart — the regression this pins is structural:
 * the gate must not read (nor order) user rows, because it runs holding the
 * registration write lock.
 */
describe('SqliteUserPersistence single-viewer gate: existence, not rows', () => {
  it('is false on an empty table and true once one identity exists', () => {
    const db = openVirginDb();
    const { registration } = createSqliteUserPersistence(db);

    expect(registration.atomically((tx) => tx.users.anyExists())).toBe(false);
    new UserRepo(db).create({
      id: 'first001',
      name: 'first',
      displayName: 'First Human',
    });
    expect(registration.atomically((tx) => tx.users.anyExists())).toBe(true);

    db.close();
  });

  it('asks the table exactly once, stops at the first row and selects no column', () => {
    const db = openVirginDb();
    const repo = new UserRepo(db);
    // Two rows on purpose: a full-list form reads (and orders) both.
    repo.create({ id: 'first001', name: 'first', displayName: 'First' });
    repo.create({ id: 'second01', name: 'second', displayName: 'Second' });
    const { registration } = createSqliteUserPersistence(db);

    const spy = vi.spyOn(db, 'prepare');
    const exists = registration.atomically((tx) => tx.users.anyExists());
    const statements = spy.mock.calls.map((call) => String(call[0]));
    spy.mockRestore();

    expect(exists).toBe(true);
    const overUsers = statements.filter((sql) => /\busers\b/i.test(sql));
    expect(overUsers).toHaveLength(1);
    const [gate] = overUsers as [string];
    // `LIMIT 1` is the "stops at the first row" half; the absence of a column
    // list and of an ordering is the "reads no row" half.
    expect(gate).toMatch(/\blimit\s+1\b/i);
    expect(gate).not.toContain('*');
    expect(gate).not.toMatch(/\border\s+by\b/i);

    db.close();
  });
});

describe('related human directory', () => {
  it('reads only the creator membership union, deduplicates and reflects removal', () => {
    const db = openVirginDb();
    try {
      db.exec(`
        INSERT INTO users(id,name,display_name,created_at,updated_at) VALUES
          ('owner','owner','Owner',1,1),('peer','peer','Peer',2,2),('foreign','foreign','Foreign',3,3);
        INSERT INTO workspaces(id,name,name_key,owner_user_id,archived_at,created_at,updated_at) VALUES
          ('a','A','a','owner',NULL,1,1),('b','B','b','owner',10,1,1),
          ('other','Other','other','foreign',NULL,1,1);
        INSERT INTO workspace_users(workspace_id,user_id,joined_at) VALUES
          ('a','owner',1),('a','peer',1),('b','peer',1),('other','owner',1),('other','foreign',1);
      `);
      const { read } = createSqliteUserPersistence(db);
      expect(read.listRelated('owner').map((u) => u.id)).toEqual(['owner', 'peer']);
      expect(read.listRelated('peer')).toEqual([]);
      db.prepare("DELETE FROM workspace_users WHERE workspace_id='a' AND user_id='peer'").run();
      expect(read.listRelated('owner').map((u) => u.id)).toEqual(['owner', 'peer']);
      db.prepare("DELETE FROM workspaces WHERE id='b'").run();
      expect(read.listRelated('owner').map((u) => u.id)).toEqual(['owner']);
      expect(read.list()).toHaveLength(3);
    } finally {
      db.close();
    }
  });
});
