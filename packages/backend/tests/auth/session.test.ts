import type { Database as Db } from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthSessionService, hashSessionToken } from '../../src/auth/session.js';
import { openTestDb } from '../utils/db.js';

describe('AuthSessionService', () => {
  let db: Db | null = null;

  afterEach(() => {
    db?.close();
    db = null;
  });

  it('issues opaque tokens, stores only hashes, touches on validate, and revokes', () => {
    const opened = openTestDb();
    db = opened.db;
    const sessions = new AuthSessionService(db);

    const issued = sessions.issueSession({
      userId: 'local',
      userAgent: 'SilverhandTest/1.0',
      ipFirstSeen: '203.0.113.7',
    });
    expect(issued.userToken).toMatch(/^[A-Za-z0-9_-]+$/);

    const stored = db
      .prepare<[string], { token_hash: string; user_agent: string; ip_first_seen: string }>(
        `SELECT token_hash, user_agent, ip_first_seen
           FROM auth_sessions
          WHERE id = ?`,
      )
      .get(issued.session.id);
    expect(stored).toMatchObject({
      token_hash: hashSessionToken(issued.userToken),
      user_agent: 'SilverhandTest/1.0',
      ip_first_seen: '203.0.113.7',
    });
    expect(stored?.token_hash).not.toBe(issued.userToken);

    const beforeTouch = Date.now() - 1_000;
    db.prepare(`UPDATE auth_sessions SET last_used_at = ? WHERE id = ?`).run(
      beforeTouch,
      issued.session.id,
    );
    const validated = sessions.validateSessionToken(issued.userToken);
    expect(validated).toMatchObject({
      ok: true,
      session: { id: issued.session.id, user_id: 'local' },
    });
    const touched = db
      .prepare<[string], { last_used_at: number }>(
        `SELECT last_used_at FROM auth_sessions WHERE id = ?`,
      )
      .get(issued.session.id);
    expect(touched?.last_used_at).toBeGreaterThan(beforeTouch);

    expect(sessions.revokeSessionToken(issued.userToken)).toBe(true);
    expect(sessions.validateSessionToken(issued.userToken)).toEqual({
      ok: false,
      code: 'auth_failed',
    });
  });

  it('denies sessions whose sliding TTL has expired', () => {
    const opened = openTestDb();
    db = opened.db;
    const sessions = new AuthSessionService(db, { sessionTtlMs: 1 });
    const issued = sessions.issueSession({ userId: 'local' });
    db.prepare(`UPDATE auth_sessions SET last_used_at = ? WHERE id = ?`).run(
      Date.now() - 10,
      issued.session.id,
    );

    expect(sessions.validateSessionToken(issued.userToken)).toEqual({
      ok: false,
      code: 'auth_failed',
    });
  });

  it('revokes every active session for one user only', () => {
    const opened = openTestDb();
    db = opened.db;
    const sessions = new AuthSessionService(db);
    const localOne = sessions.issueSession({ userId: 'local' });
    const localTwo = sessions.issueSession({ userId: 'local' });
    const alice = sessions.issueSession({ userId: 'alice' });

    expect(sessions.revokeAllForUser('local')).toBe(2);
    expect(sessions.validateSessionToken(localOne.userToken)).toEqual({
      ok: false,
      code: 'auth_failed',
    });
    expect(sessions.validateSessionToken(localTwo.userToken)).toEqual({
      ok: false,
      code: 'auth_failed',
    });
    expect(sessions.validateSessionToken(alice.userToken)).toMatchObject({
      ok: true,
      session: { user_id: 'alice' },
    });
    expect(sessions.revokeAllForUser('local')).toBe(0);
  });
});
