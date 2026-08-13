/**
 * Per-arm tests for the ONLY site that decodes a SQLite `users`-write rejection
 * (#task:1982 D4). Every arm goes through REAL SQLite: the whole point of this
 * module is that its patterns match what the engine actually says, so a test
 * that hand-crafts the message would pass while production mis-classifies.
 *
 * The pass-through arm is equally load-bearing — an unrecognized failure must
 * stay itself, because both create paths turn a `UserWriteConflictError` into a
 * business answer ("handle taken" / "auth failed"). Laundering a CHECK
 * violation into one of those would answer a question the DB never answered.
 */
import { describe, expect, it } from 'vitest';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { UserRepo } from '../../src/repos/user-repo.js';
import { throwAsUserWriteConflict } from '../../src/repos/sqlite-user-conflicts.js';
import { UserWriteConflictError } from '../../src/services/user/user-write-conflict.js';
import { openTestDb } from '../utils/db.js';

/** Run `fn` and return what it threw (fails if it did not throw). */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected the call to throw');
}

describe('users write conflicts are classified by axis, at one site', () => {
  it('a duplicate internal id is the retryable `user_id` axis', () => {
    const { db } = openTestDb();
    const users = new UserRepo(db);
    users.create({ id: 'dup', name: 'dup-one', displayName: 'Dup One' });

    const err = thrownBy(() =>
      users.create({ id: 'dup', name: 'dup-two', displayName: 'Dup Two' }),
    );

    expect(err).toBeInstanceOf(UserWriteConflictError);
    expect((err as UserWriteConflictError).kind).toBe('user_id');
    // The driver error stays reachable for logs on the standard chain, and is
    // never re-parsed by callers.
    expect((err as UserWriteConflictError).cause).toMatchObject({
      code: 'SQLITE_CONSTRAINT_PRIMARYKEY',
    });
    db.close();
  });

  it('a handle already held by a HUMAN is the `name` axis (column UNIQUE)', () => {
    const { db } = openTestDb();
    const err = thrownBy(() =>
      new UserRepo(db).create({
        id: 'newcomer',
        name: 'alice-test', // a fixture user's handle
        displayName: 'Newcomer',
      }),
    );

    expect(err).toBeInstanceOf(UserWriteConflictError);
    expect((err as UserWriteConflictError).kind).toBe('name');
    db.close();
  });

  it('a handle already held by an AGENT is the SAME `name` axis (cross-namespace trigger)', () => {
    const { db, localHostId } = openTestDb();
    const agent = new AgentRepo(db).create(
      { name: 'shared-handle', runtime: 'claude' },
      localHostId,
      'local',
    );

    const err = thrownBy(() =>
      new UserRepo(db).create({
        id: 'newcomer',
        name: agent.name,
        displayName: 'Newcomer',
      }),
    );

    // One `@handle` namespace, one axis: signup must report "handle taken"
    // whichever half of it holds the name. A distinct kind here would let the
    // application answer differently for an agent-held handle.
    expect(err).toBeInstanceOf(UserWriteConflictError);
    expect((err as UserWriteConflictError).kind).toBe('name');
    db.close();
  });

  it('a duplicate login email is the `email` axis (partial unique index)', () => {
    const { db } = openTestDb();
    const users = new UserRepo(db);
    users.create({
      id: 'first',
      name: 'first-holder',
      displayName: 'First',
      email: 'shared@example.com',
    });

    const err = thrownBy(() =>
      users.create({
        id: 'second',
        name: 'second-holder',
        displayName: 'Second',
        email: 'shared@example.com',
      }),
    );

    expect(err).toBeInstanceOf(UserWriteConflictError);
    expect((err as UserWriteConflictError).kind).toBe('email');
    db.close();
  });

  it('NULL emails do not collide — the index is partial, so the axis stays unfired', () => {
    const { db } = openTestDb();
    const users = new UserRepo(db);
    // Two credential-less profile registrations are the normal state of this
    // table; if this ever became an `email` conflict, signup would answer
    // `auth_failed` to a perfectly free handle.
    users.create({ id: 'p1', name: 'profile-one', displayName: 'One' });
    expect(() =>
      users.create({ id: 'p2', name: 'profile-two', displayName: 'Two' }),
    ).not.toThrow();
    db.close();
  });

  it('an unrecognized failure passes through UNTOUCHED, with identity preserved', () => {
    const { db } = openTestDb();
    // A real engine rejection that is NOT a uniqueness loss: the avatar CHECK
    // constraint (both columns NULL or both set).
    const driverError = thrownBy(() =>
      db
        .prepare(
          `INSERT INTO users
             (id, name, display_name, avatar_storage_key, avatar_content_type,
              created_at, updated_at)
           VALUES ('half', 'half-avatar', 'Half', 'key-only', NULL, 0, 0)`,
        )
        .run(),
    );
    expect(driverError).toMatchObject({ code: 'SQLITE_CONSTRAINT_CHECK' });

    // Same object out, not a copy and not a translation.
    expect(thrownBy(() => throwAsUserWriteConflict(driverError))).toBe(
      driverError,
    );
    const plain = new Error('disk I/O error');
    expect(thrownBy(() => throwAsUserWriteConflict(plain))).toBe(plain);
    expect(thrownBy(() => throwAsUserWriteConflict('not an error'))).toBe(
      'not an error',
    );
    db.close();
  });

  it('an invalid handle FORMAT is not a conflict — the write never reaches the engine', () => {
    const { db } = openTestDb();
    const err = thrownBy(() =>
      new UserRepo(db).create({
        id: 'bad',
        name: '1-starts-with-a-digit',
        displayName: 'Bad',
      }),
    );

    // The format assertion lives OUTSIDE the translated try block on purpose:
    // "this value may not be stored" and "someone else holds this value" are
    // different answers, and only the second one is retryable/reportable as a
    // taken handle.
    expect(err).not.toBeInstanceOf(UserWriteConflictError);
    expect((err as Error).message).toMatch(/ParticipantNameSchema/);
    expect(new UserRepo(db).get('bad')).toBeNull();
    db.close();
  });
});
