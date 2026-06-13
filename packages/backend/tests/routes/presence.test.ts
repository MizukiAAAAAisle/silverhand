import { afterEach, describe, expect, it } from 'vitest';
import { apiPaths, PresenceResponseSchema } from '@silverhand/shared';
import { UserRepo } from '../../src/repos/user-repo.js';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

describe('GET /api/presence', () => {
  let t: TestApp | null = null;

  afterEach(() => {
    t?.ctx.presence.dispose();
    t?.cleanup();
    t = null;
  });

  it('returns a global snapshot of all users with current presence', async () => {
    t = buildTestApp();
    const users = new UserRepo(t.ctx.db);
    users.touchLastSeen('alice', 1_234);
    t.ctx.presence.onConnect('local', 'conn-local');

    const res = await http(t).get(apiPaths.presence);
    expect(res.status).toBe(200);
    const body = PresenceResponseSchema.parse(await res.json());
    const byId = Object.fromEntries(body.users.map(user => [user.user_id, user]));

    expect(Object.keys(byId)).toEqual(
      expect.arrayContaining(['local', 'alice', 'other']),
    );
    expect(byId.local).toEqual({
      user_id: 'local',
      presence: 'online',
      last_seen_at: null,
    });
    expect(byId.alice).toEqual({
      user_id: 'alice',
      presence: 'offline',
      last_seen_at: 1_234,
    });
    expect(byId.other).toMatchObject({
      user_id: 'other',
      presence: 'offline',
      last_seen_at: null,
    });
  });
});
