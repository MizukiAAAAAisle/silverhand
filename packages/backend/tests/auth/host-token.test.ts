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

  it('reports whether a host has an active long-lived credential', () => {
    const { db, viewerUserId } = openTestDb();
    const { hostId, hosts, tokens } = createOwnedHostTokenFixture(db, viewerUserId);
    const now = 1_700_000_000_000;

    expect(tokens.hasActiveLongLivedCredential(hostId, { now })).toBe(false);

    const issued = tokens.issueHostToken({ hostId });
    expect(tokens.hasActiveLongLivedCredential(hostId, { now })).toBe(true);

    expect(tokens.revokeCredential(issued.credential.id, now)).toBe(true);
    expect(tokens.hasActiveLongLivedCredential(hostId, { now })).toBe(false);

    const expiring = tokens.issueHostToken({
      hostId,
      expiresAt: now + HOST_TOKEN_ROTATION_GRACE_MS,
    });
    expect(tokens.hasActiveLongLivedCredential(hostId, { now })).toBe(true);
    expect(
      tokens.hasActiveLongLivedCredential(hostId, {
        now: now + HOST_TOKEN_ROTATION_GRACE_MS + 1,
      }),
    ).toBe(false);

    const active = tokens.issueHostToken({ hostId });
    expect(tokens.hasActiveLongLivedCredential(hostId, { now })).toBe(true);
    expect(hosts.revoke(hostId, now)).toBe(true);
    expect(tokens.hasActiveLongLivedCredential(hostId, { now })).toBe(false);
    expect(tokens.verifyHostToken(expiring.hostToken, { now })).toEqual({
      ok: false,
      code: 'host_revoked',
    });
    expect(tokens.verifyHostToken(active.hostToken, { now })).toEqual({
      ok: false,
      code: 'host_revoked',
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

  // Stage B.4: bulk-revoke for the host-revoke route. No grace,
  // idempotent, and reconciles half-failed prior runs.
  it('revokeAllCredentialsForHost sweeps every active credential and is idempotent', () => {
    const { db, viewerUserId } = openTestDb();
    const { hostId, tokens } = createOwnedHostTokenFixture(db, viewerUserId);
    tokens.issueHostToken({ hostId });
    tokens.issueHostToken({ hostId });
    // Manufacture a row that is already revoked — should be skipped
    // by the sweep (its `revoked_at` must not be overwritten).
    const stale = tokens.issueHostToken({ hostId });
    const staleRevokedAt = 1_700_000_000_000;
    db.prepare(`UPDATE host_credentials SET revoked_at = ? WHERE id = ?`).run(
      staleRevokedAt,
      stale.credential.id,
    );

    const updated = tokens.revokeAllCredentialsForHost(hostId, 1_777_777_777_777);
    expect(updated).toBe(2);
    expect(
      db
        .prepare<[string], { c: number }>(
          `SELECT COUNT(*) AS c FROM host_credentials
            WHERE host_id = ? AND revoked_at IS NULL`,
        )
        .get(hostId)?.c ?? 0,
    ).toBe(0);
    expect(
      db
        .prepare<[string], { revoked_at: number | null }>(
          `SELECT revoked_at FROM host_credentials WHERE id = ?`,
        )
        .get(stale.credential.id)?.revoked_at,
    ).toBe(staleRevokedAt);

    // Idempotent re-sweep returns 0 and does not touch existing
    // revoked_at timestamps.
    expect(tokens.revokeAllCredentialsForHost(hostId, 1_888_888_888_888)).toBe(0);
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
