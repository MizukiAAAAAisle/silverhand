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
});
