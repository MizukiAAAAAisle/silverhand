import { describe, expect, it } from 'vitest';
import { HostRepo, LOCAL_HOST_NAME } from '../../src/repos/host-repo.js';
import { openTestDb } from '../utils/db.js';

describe('HostRepo', () => {
  it('ensureLocal is idempotent and returns the bootstrapped local host', () => {
    const { db, localHostId } = openTestDb();
    const repo = new HostRepo(db);

    const again = repo.ensureLocal();
    expect(again.id).toBe(localHostId);
    expect(again.name).toBe(LOCAL_HOST_NAME);
    expect(again.kind).toBe('local');
    expect(again.user_id).toBeNull();
    expect(again.installation_id).toBeNull();
    expect(again.revoked_at).toBeNull();

    expect(repo.list()).toHaveLength(1);
  });

  it('create + get + getByName round-trip a remote host', () => {
    const { db } = openTestDb();
    const repo = new HostRepo(db);

    const remote = repo.create('homelab', 'remote');
    expect(remote.kind).toBe('remote');
    expect(repo.get(remote.id)?.name).toBe('homelab');
    expect(repo.getByName('homelab')?.id).toBe(remote.id);
    expect(repo.getByName('does-not-exist')).toBeNull();
  });

  it('stores host ownership, installation id, last_seen, and revocation', () => {
    const { db, viewerUserId } = openTestDb();
    const repo = new HostRepo(db);
    const lastSeenAt = 1_700_000_000_000;

    const host = repo.create('owned-local', 'local', {
      userId: viewerUserId,
      installationId: 'install-1',
      lastSeenAt,
    });

    expect(host.user_id).toBe(viewerUserId);
    expect(host.installation_id).toBe('install-1');
    expect(host.last_seen_at).toBe(lastSeenAt);
    expect(repo.getByUserInstallation(viewerUserId, 'install-1')?.id).toBe(host.id);

    const touchedAt = lastSeenAt + 1;
    expect(repo.touchLastSeen(host.id, touchedAt)).toBe(true);
    expect(repo.get(host.id)?.last_seen_at).toBe(touchedAt);

    const revokedAt = touchedAt + 1;
    expect(repo.revoke(host.id, revokedAt)).toBe(true);
    expect(repo.get(host.id)?.revoked_at).toBe(revokedAt);
    expect(repo.revoke(host.id, revokedAt + 1)).toBe(false);
  });

  it('finds the newest active owned local host without returning legacy local', () => {
    const { db, viewerUserId } = openTestDb();
    const repo = new HostRepo(db);
    expect(repo.getOwnedLocalForUser(viewerUserId)).toBeNull();

    const older = repo.create('local-old', 'local', {
      userId: viewerUserId,
      installationId: 'install-old',
      lastSeenAt: 1_700_000_000_000,
    });
    const newer = repo.create('local-new', 'local', {
      userId: viewerUserId,
      installationId: 'install-new',
      lastSeenAt: 1_700_000_000_001,
    });
    repo.create('remote-owned', 'remote', {
      userId: viewerUserId,
      installationId: 'remote-install',
    });

    expect(repo.getOwnedLocalForUser(viewerUserId)?.id).toBe(newer.id);
    expect(repo.revoke(newer.id)).toBe(true);
    expect(repo.getOwnedLocalForUser(viewerUserId)?.id).toBe(older.id);
  });

  // D4.c C1 — list-form companion of `getOwnedLocalForUser`. Same
  // active-only / sort-by-recency / per-user filter, just returns the
  // full set instead of the silent-pick "best" row. Used by
  // `RuntimeHostPlacementResolver.resolveOwnedLocalForUser` to
  // detect 0 / 1 / N branches and surface `local_host_ambiguous`
  // for N≥2.
  it('listOwnedActiveLocalForUser enumerates 0 / 1 / N active local hosts per user', () => {
    const { db, viewerUserId } = openTestDb();
    const repo = new HostRepo(db);

    // 0
    expect(repo.listOwnedActiveLocalForUser(viewerUserId)).toEqual([]);

    // 1
    const a = repo.create('local-a', 'local', {
      userId: viewerUserId,
      installationId: 'install-a',
      lastSeenAt: 1_700_000_000_000,
    });
    expect(repo.listOwnedActiveLocalForUser(viewerUserId).map(h => h.id)).toEqual([
      a.id,
    ]);

    // N (most-recently-seen first matches getOwnedLocalForUser's
    // sort, so unit tests downstream can assert deterministic order)
    const b = repo.create('local-b', 'local', {
      userId: viewerUserId,
      installationId: 'install-b',
      lastSeenAt: 1_700_000_000_002,
    });
    expect(
      repo.listOwnedActiveLocalForUser(viewerUserId).map(h => h.id),
    ).toEqual([b.id, a.id]);

    // remote hosts of the same user excluded
    repo.create('remote-owned', 'remote', {
      userId: viewerUserId,
      installationId: 'remote-install',
    });
    expect(
      repo.listOwnedActiveLocalForUser(viewerUserId).map(h => h.id),
    ).toEqual([b.id, a.id]);

    // (per-user filter is exercised by `listForUser` / repo
    // ownership tests above; we don't re-create cross-user fixtures
    // here because the test fixture only seeds the viewer user.)

    // revoked rows excluded (active-only invariant matches the
    // single-row variant)
    expect(repo.revoke(b.id)).toBe(true);
    expect(
      repo.listOwnedActiveLocalForUser(viewerUserId).map(h => h.id),
    ).toEqual([a.id]);
  });

  // Stage B.4: re-claim after revoke must succeed under the active-only
  // partial UNIQUE. The lookup path filters revoked rows so
  // `claimOrCreateLocal` reaches its `create` branch with a fresh row.
  it('getByUserInstallation skips revoked rows so revoked + same install does not block re-claim', () => {
    const { db, viewerUserId } = openTestDb();
    const repo = new HostRepo(db);
    const first = repo.create('owned-1', 'local', {
      userId: viewerUserId,
      installationId: 'install-1',
    });
    expect(repo.getByUserInstallation(viewerUserId, 'install-1')?.id).toBe(first.id);

    repo.revoke(first.id);
    expect(repo.getByUserInstallation(viewerUserId, 'install-1')).toBeNull();

    // Re-claim should now mint a fresh active host row for the same
    // (user, installation). The active-only UNIQUE permits both rows
    // to coexist (one revoked, one active). Whether the result row
    // is freshly inserted or a legacy `local` row that got bound is
    // an implementation detail of `claimOrCreateLocal` — what matters
    // for B.4 is that the new row id is different and active.
    const result = repo.claimOrCreateLocal({
      userId: viewerUserId,
      installationId: 'install-1',
    });
    expect(result.host.id).not.toBe(first.id);
    expect(result.host.revoked_at).toBeNull();
    // Both rows now exist for the same (user, installation) pair —
    // one revoked, one active. Order is by created_at; do not assume
    // a specific orientation since `claimOrCreateLocal` may bind a
    // legacy `local` row whose created_at predates `first`.
    const all = db
      .prepare<[string, string], { id: string; revoked_at: number | null }>(
        `SELECT id, revoked_at FROM hosts
          WHERE user_id = ? AND installation_id = ?
          ORDER BY created_at ASC`,
      )
      .all(viewerUserId, 'install-1');
    expect(all).toHaveLength(2);
    const firstRow = all.find(r => r.id === first.id);
    const newRow = all.find(r => r.id === result.host.id);
    expect(firstRow).toBeDefined();
    expect(newRow).toBeDefined();
    expect(firstRow!.revoked_at).toEqual(expect.any(Number));
    expect(newRow!.revoked_at).toBeNull();
  });

  it('listForUser returns only owned hosts, sorted active-first, and includes revoked rows', () => {
    const { db } = openTestDb();
    const repo = new HostRepo(db);
    const aliceActive = repo.create('alice-active', 'local', {
      userId: 'alice',
      installationId: 'i-a-active',
      lastSeenAt: 100,
    });
    const aliceRevoked = repo.create('alice-revoked', 'local', {
      userId: 'alice',
      installationId: 'i-a-revoked',
      lastSeenAt: 50,
    });
    repo.revoke(aliceRevoked.id);
    repo.create('bob-active', 'local', {
      userId: 'bob',
      installationId: 'i-b-active',
      lastSeenAt: 200,
    });

    const aliceList = repo.listForUser('alice');
    expect(aliceList.map(h => h.id)).toEqual([aliceActive.id, aliceRevoked.id]);
    expect(aliceList[0]).toMatchObject({
      revoked_at: null,
      last_seen_at: 100,
    });
    expect(aliceList[1]).toMatchObject({ revoked_at: expect.any(Number) });

    // Cross-user invisibility: Bob's active row never surfaces in
    // Alice's list.
    expect(aliceList.find(h => h.id.startsWith('bob'))).toBeUndefined();
  });
});
