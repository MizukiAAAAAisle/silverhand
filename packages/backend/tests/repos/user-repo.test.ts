import { describe, expect, it } from 'vitest';
import { UserRepo } from '../../src/repos/user-repo.js';
import { openTestDb } from '../utils/db.js';

/**
 * `users.name` FORMAT is fenced at the write boundary (#task:1828).
 *
 * `users.name` is a mention handle, and the two production writers derive it
 * server-side (embedded bootstrap passes `local`; signup derives it from the
 * email local part). So the property that matters — "every stored human handle
 * can actually be @mentioned" — has no user-facing input surface to guard, and
 * before this it was only an emergent consequence of the email derivation's
 * character folding. These tests lock the assertion that makes it declared:
 * the repo rejects a name the mention grammar cannot address, and accepts the
 * shapes the real writers produce (so the gate is not merely "always throws").
 */
describe('UserRepo.create — name format gate (#task:1828)', () => {
  it('rejects a name the mention grammar cannot address, and writes no row', () => {
    const { db } = openTestDb();
    const repo = new UserRepo(db);

    expect(() =>
      repo.create({ id: 'numeric1', name: '2bob', displayName: 'Two Bob' }),
    ).toThrow(/ParticipantNameSchema/);
    expect(repo.get('numeric1')).toBeNull();
    expect(repo.getByName('2bob')).toBeNull();
  });

  it('rejects the other unaddressable shapes: empty, dot, space, leading dash', () => {
    const { db } = openTestDb();
    const repo = new UserRepo(db);
    const before = repo.list().length;

    for (const name of ['', '-bob', '_bob', 'bo b', 'bo.b', 'bób']) {
      expect(() =>
        repo.create({ id: `id-${name}`, name, displayName: 'X' }),
      ).toThrow(/ParticipantNameSchema/);
    }
    expect(repo.list()).toHaveLength(before);
  });

  it('accepts the names the two production writers actually produce', () => {
    const { db } = openTestDb();
    const repo = new UserRepo(db);

    // Embedded bootstrap (`routes.ts` → `UserService.register`) passes `local`.
    const bootstrap = repo.create({
      id: 'boot0001',
      name: 'local',
      displayName: 'Local User',
    });
    expect(bootstrap.name).toBe('local');

    // Signup: email-derived base, the `user-` prefix fallback, and the
    // `-<hex>` collision suffix are all inside the grammar.
    for (const name of ['bu', 'user-2b', 'a_b-c']) {
      expect(repo.create({ id: `id${name}`, name, displayName: name }).name).toBe(
        name,
      );
    }
  });
});
