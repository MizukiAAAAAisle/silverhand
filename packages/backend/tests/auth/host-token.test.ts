import { describe, expect, it } from 'vitest';
import type { Database as Db } from 'better-sqlite3';
import {
  HOST_TOKEN_ROTATION_GRACE_MS,
  HostTokenService,
  hashHostToken,
} from '../../src/auth/host-token.js';
import { HostRepo } from '../../src/repos/host-repo.js';
import { openTestDb } from '../utils/db.js';

describe('HostTokenService', () => {
  it('stores only a host_token hash and verifies a valid token', () => {
    const { db, viewerUserId } = openTestDb();
    const { hostId, tokens } = createOwnedHostTokenFixture(db, viewerUserId);

    const issued = tokens.issueHostToken({ hostId });
    expect(issued.credential.token_hash).toBe(hashHostToken(issued.hostToken));
    expect(issued.credential.token_hash).not.toBe(issued.hostToken);

    const stored = db
      .prepare<[string], { token_hash: string }>(
        `SELECT token_hash FROM host_credentials WHERE id = ?`,
      )
      .get(issued.credential.id);
    expect(stored?.token_hash).toBe(hashHostToken(issued.hostToken));

    expect(tokens.verifyHostToken(issued.hostToken)).toEqual({
      ok: true,
      hostId,
      userId: viewerUserId,
      credentialId: issued.credential.id,
    });
  });

  it('accepts a rotated token during the grace window and denies it after grace', () => {
    const { db, viewerUserId } = openTestDb();
    const { hostId, tokens } = createOwnedHostTokenFixture(db, viewerUserId);
    const old = tokens.issueHostToken({ hostId });
    const now = 1_700_000_000_000;

    const fresh = tokens.rotateHostToken({ hostId, now });

    const oldCredential = db
      .prepare<[string], { expires_at: number | null }>(
        `SELECT expires_at FROM host_credentials WHERE id = ?`,
      )
      .get(old.credential.id);
    expect(oldCredential?.expires_at).toBe(now + HOST_TOKEN_ROTATION_GRACE_MS);

    expect(
      tokens.verifyHostToken(old.hostToken, {
        now: now + HOST_TOKEN_ROTATION_GRACE_MS - 1,
      }),
    ).toMatchObject({
      ok: true,
      hostId,
      userId: viewerUserId,
    });
    expect(
      tokens.verifyHostToken(old.hostToken, {
        now: now + HOST_TOKEN_ROTATION_GRACE_MS + 1,
      }),
    ).toEqual({ ok: false, code: 'credential_expired' });
    expect(
      tokens.verifyHostToken(fresh.hostToken, {
        now: now + HOST_TOKEN_ROTATION_GRACE_MS + 1,
      }),
    ).toMatchObject({
      ok: true,
      hostId,
      userId: viewerUserId,
    });
  });

  it('denies a revoked credential without a grace window', () => {
    const { db, viewerUserId } = openTestDb();
    const { hostId, tokens } = createOwnedHostTokenFixture(db, viewerUserId);
    const issued = tokens.issueHostToken({ hostId });

    expect(tokens.revokeCredential(issued.credential.id, 1_700_000_000_000)).toBe(true);

    expect(tokens.verifyHostToken(issued.hostToken)).toEqual({
      ok: false,
      code: 'credential_revoked',
    });
  });

  it('denies a token for a revoked host even when the credential is active', () => {
    const { db, viewerUserId } = openTestDb();
    const { hostId, hosts, tokens } = createOwnedHostTokenFixture(db, viewerUserId);
    const issued = tokens.issueHostToken({ hostId });

    expect(hosts.revoke(hostId, 1_700_000_000_000)).toBe(true);

    expect(tokens.verifyHostToken(issued.hostToken)).toEqual({
      ok: false,
      code: 'host_revoked',
    });
  });

  it('denies empty or unknown tokens as missing', () => {
    const { db, viewerUserId } = openTestDb();
    const { tokens } = createOwnedHostTokenFixture(db, viewerUserId);

    expect(tokens.verifyHostToken('')).toEqual({ ok: false, code: 'missing' });
    expect(tokens.verifyHostToken('not-a-real-token')).toEqual({
      ok: false,
      code: 'missing',
    });
  });

  it('does not accept bootstrap credentials as long-lived host tokens', () => {
    const { db, viewerUserId } = openTestDb();
    const { hostId, tokens } = createOwnedHostTokenFixture(db, viewerUserId);

    const bootstrap = tokens.issueHostToken({
      hostId,
      kind: 'bootstrap',
      expiresAt: 1_700_000_060_000,
    });

    expect(tokens.verifyHostToken(bootstrap.hostToken)).toEqual({
      ok: false,
      code: 'credential_not_usable',
    });
  });
});

function createOwnedHostTokenFixture(db: Db, userId: string) {
  const hosts = new HostRepo(db);
  const host = hosts.create('owned-local', 'local', {
    userId,
    installationId: 'installation-1',
  });
  const tokens = new HostTokenService(db);
  return { hosts, hostId: host.id, tokens };
}
