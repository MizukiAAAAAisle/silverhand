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
});
