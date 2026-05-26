import { afterEach, describe, expect, it } from 'vitest';
import { apiPaths } from '@silverhand/shared';
import { HostTokenService, hashHostToken } from '../../src/auth/host-token.js';
import { HostRepo } from '../../src/repos/host-repo.js';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

describe('host routes', () => {
  let t: TestApp | null = null;

  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('claims the legacy local host and stores only a host_token hash', async () => {
    t = buildTestApp({ ownedLocalHostUserIds: [] });
    const userToken = t.ctx.authSessions.issueSession({
      userId: t.viewerUserId,
    }).userToken;
    const legacyLocal = new HostRepo(t.ctx.db).getByName('local');
    expect(legacyLocal).toMatchObject({
      user_id: null,
      installation_id: null,
      revoked_at: null,
    });

    const res = await sessionHttp(t, userToken).post(apiPaths.hostClaimOrCreate, {
      installation_id: '11111111-1111-4111-8111-111111111111',
      label: 'Dev Mac',
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body).toMatchObject({
      host_id: legacyLocal!.id,
      host: {
        id: legacyLocal!.id,
        name: 'local',
        kind: 'local',
        created_at: expect.any(Number),
        revoked_at: null,
        last_seen_at: expect.any(Number),
      },
      server_url: t.ctx.serverConfig.url,
      host_token: expect.any(String),
    });
    expect(body.host.id).toBe(body.host_id);

    const host = new HostRepo(t.ctx.db).get(body.host_id);
    expect(host).toMatchObject({
      user_id: t.viewerUserId,
      installation_id: '11111111-1111-4111-8111-111111111111',
      revoked_at: null,
    });

    const credential = t.ctx.db
      .prepare<[string], { token_hash: string; kind: string }>(
        `SELECT token_hash, kind FROM host_credentials WHERE host_id = ?`,
      )
      .get(body.host_id);
    expect(credential).toEqual({
      token_hash: hashHostToken(body.host_token),
      kind: 'long_lived',
    });
    expect(credential!.token_hash).not.toBe(body.host_token);
    expect(new HostTokenService(t.ctx.db).verifyHostToken(body.host_token))
      .toMatchObject({
        ok: true,
        hostId: body.host_id,
        userId: t.viewerUserId,
      });
  });

  it('reuses the existing host without minting a token when desktop already has one', async () => {
    t = buildTestApp({ ownedLocalHostUserIds: [] });
    const userToken = t.ctx.authSessions.issueSession({
      userId: t.viewerUserId,
    }).userToken;
    const h = sessionHttp(t, userToken);
    const first = await h.json<any>(
      h.post(apiPaths.hostClaimOrCreate, {
        installation_id: '22222222-2222-4222-8222-222222222222',
      }),
    );

    const secondRes = await h.post(apiPaths.hostClaimOrCreate, {
      installation_id: '22222222-2222-4222-8222-222222222222',
      current_host_id: first.host_id,
    });

    expect(secondRes.status).toBe(200);
    const second = await secondRes.json() as any;
    expect(second.host_id).toBe(first.host_id);
    expect(second).not.toHaveProperty('host_token');
    const count = t.ctx.db
      .prepare<[string], { c: number }>(
        `SELECT COUNT(*) AS c FROM host_credentials WHERE host_id = ?`,
      )
      .get(first.host_id);
    expect(count?.c).toBe(1);
  });

  it('mints a replacement token when current_host_id has no active credential', async () => {
    t = buildTestApp({ ownedLocalHostUserIds: [] });
    const userToken = t.ctx.authSessions.issueSession({
      userId: t.viewerUserId,
    }).userToken;
    const h = sessionHttp(t, userToken);
    const first = await h.json<any>(
      h.post(apiPaths.hostClaimOrCreate, {
        installation_id: '22222222-2222-4222-8222-222222222223',
      }),
    );
    t.ctx.db
      .prepare(`UPDATE host_credentials SET revoked_at = ? WHERE host_id = ?`)
      .run(1_700_000_000_000, first.host_id);

    const secondRes = await h.post(apiPaths.hostClaimOrCreate, {
      installation_id: '22222222-2222-4222-8222-222222222223',
      current_host_id: first.host_id,
    });

    expect(secondRes.status).toBe(200);
    const second = await secondRes.json() as any;
    expect(second.host_id).toBe(first.host_id);
    expect(second.host_token).toEqual(expect.any(String));
    expect(second.host_token).not.toBe(first.host_token);
    const count = t.ctx.db
      .prepare<[string], { c: number }>(
        `SELECT COUNT(*) AS c FROM host_credentials WHERE host_id = ?`,
      )
      .get(first.host_id);
    expect(count?.c).toBe(2);
    expect(new HostTokenService(t.ctx.db).verifyHostToken(second.host_token))
      .toMatchObject({
        ok: true,
        hostId: first.host_id,
        userId: t.viewerUserId,
      });
  });

  it('mints a fresh active host when the prior (user, installation) was revoked (Stage B.4 active-only UNIQUE)', async () => {
    t = buildTestApp({ ownedLocalHostUserIds: [] });
    const userToken = t.ctx.authSessions.issueSession({
      userId: t.viewerUserId,
    }).userToken;
    const h = sessionHttp(t, userToken);
    const first = await h.json<any>(
      h.post(apiPaths.hostClaimOrCreate, {
        installation_id: '33333333-3333-4333-8333-333333333333',
      }),
    );

    expect(new HostRepo(t.ctx.db).revoke(first.host_id)).toBe(true);
    const second = await h.post(apiPaths.hostClaimOrCreate, {
      installation_id: '33333333-3333-4333-8333-333333333333',
    });

    // Stage B.4: re-claim after revoke transparently mints a NEW
    // active host row (no 409). The old revoked row stays for audit
    // history; the active-only partial UNIQUE permits a second
    // active row for the same (user, installation).
    expect(second.status).toBe(200);
    const body = (await second.json()) as any;
    expect(body.host_id).not.toBe(first.host_id);
    expect(body.host).toMatchObject({
      id: body.host_id,
      kind: 'local',
      revoked_at: null,
    });
    expect(body.host_token).toEqual(expect.any(String));
    const rows = t.ctx.db
      .prepare<[string, string], { id: string; revoked_at: number | null }>(
        `SELECT id, revoked_at FROM hosts
          WHERE user_id = ?
            AND installation_id = ?
          ORDER BY created_at ASC`,
      )
      .all(t.viewerUserId, '33333333-3333-4333-8333-333333333333');
    expect(rows).toHaveLength(2);
    const firstRow = rows.find(r => r.id === first.host_id);
    const newRow = rows.find(r => r.id === body.host_id);
    expect(firstRow?.revoked_at).toEqual(expect.any(Number));
    expect(newRow?.revoked_at).toBeNull();
  });

  it('rejects retired server-config bearer access to the token-bearing claim route', async () => {
    t = buildTestApp();
    const res = await legacyServerAuthHttp(t).post(apiPaths.hostClaimOrCreate, {
      installation_id: '44444444-4444-4444-8444-444444444444',
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'unauthorized' });
    const count = t.ctx.db
      .prepare<[], { c: number }>(`SELECT COUNT(*) AS c FROM host_credentials`)
      .get();
    expect(count?.c).toBe(0);
  });

  // ── GET /api/hosts viewer filter (Stage B.4) ─────────────────
  describe('GET /api/hosts viewer filter', () => {
    it('returns only hosts owned by the session bearer (Alice cannot see Bob\'s host)', async () => {
      t = buildTestApp({ ownedLocalHostUserIds: ['alice', 'bob'] });
      const aliceToken = t.ctx.authSessions.issueSession({ userId: 'alice' }).userToken;

      const res = await sessionHttp(t, aliceToken).get(apiPaths.hosts);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { hosts: any[] };
      // Every returned row must be owned by Alice; Bob's row is invisible.
      expect(body.hosts.length).toBeGreaterThanOrEqual(1);
      const aliceHostIds = new Set(
        t.ctx.db
          .prepare<[], { id: string }>(`SELECT id FROM hosts WHERE user_id = 'alice'`)
          .all()
          .map(r => r.id),
      );
      for (const h of body.hosts) {
        expect(aliceHostIds.has(h.id)).toBe(true);
      }
      const bobHostIds = new Set(
        t.ctx.db
          .prepare<[], { id: string }>(`SELECT id FROM hosts WHERE user_id = 'bob'`)
          .all()
          .map(r => r.id),
      );
      for (const h of body.hosts) {
        expect(bobHostIds.has(h.id)).toBe(false);
      }
    });

    it('rejects retired server-config bearer (no cross-user enumeration)', async () => {
      t = buildTestApp();
      const res = await legacyServerAuthHttp(t).get(apiPaths.hosts);
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: 'unauthorized' });
    });

    it('includes both active and revoked rows (audit history) for the owner', async () => {
      t = buildTestApp({ ownedLocalHostUserIds: ['alice'] });
      const aliceToken = t.ctx.authSessions.issueSession({ userId: 'alice' }).userToken;
      const aliceHost = new HostRepo(t.ctx.db).getOwnedLocalForUser('alice');
      expect(aliceHost).not.toBeNull();
      // Mint a second active row, revoke the first.
      new HostRepo(t.ctx.db).create('local-extra', 'local', {
        userId: 'alice',
        installationId: 'install-alice-extra',
      });
      new HostRepo(t.ctx.db).revoke(aliceHost!.id);

      const body = (await sessionHttp(t, aliceToken).json<{ hosts: any[] }>(
        sessionHttp(t, aliceToken).get(apiPaths.hosts),
      ));
      const ids = body.hosts.map(h => h.id);
      expect(ids).toContain(aliceHost!.id);
      const revokedRow = body.hosts.find(h => h.id === aliceHost!.id);
      expect(revokedRow).toMatchObject({ revoked_at: expect.any(Number) });
    });
  });

  // ── POST /api/hosts/:id/revoke (Stage B.4) ───────────────────
  describe('POST /api/hosts/:id/revoke', () => {
    it('soft-deletes host + sweeps active credentials in one transaction; agents/workspaces unchanged', async () => {
      t = buildTestApp({ ownedLocalHostUserIds: [] });
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const h = sessionHttp(t, userToken);
      const claimed = await h.json<any>(
        h.post(apiPaths.hostClaimOrCreate, {
          installation_id: '50000001-1111-4111-8111-111111111111',
        }),
      );
      // Snapshot agent/workspace counts to prove no cascade-delete.
      const agentCountBefore = t.ctx.db
        .prepare<[], { c: number }>(`SELECT COUNT(*) AS c FROM agents`)
        .get()?.c ?? 0;
      const workspaceCountBefore = t.ctx.db
        .prepare<[], { c: number }>(`SELECT COUNT(*) AS c FROM workspaces`)
        .get()?.c ?? 0;
      const credCountBefore = t.ctx.db
        .prepare<[string], { c: number }>(
          `SELECT COUNT(*) AS c FROM host_credentials
            WHERE host_id = ? AND revoked_at IS NULL`,
        )
        .get(claimed.host_id)?.c ?? 0;
      expect(credCountBefore).toBe(1);

      const res = await h.post(apiPaths.hostRevoke(claimed.host_id));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { host: any };
      expect(body.host).toMatchObject({
        id: claimed.host_id,
        revoked_at: expect.any(Number),
      });

      const credCountAfter = t.ctx.db
        .prepare<[string], { c: number }>(
          `SELECT COUNT(*) AS c FROM host_credentials
            WHERE host_id = ? AND revoked_at IS NULL`,
        )
        .get(claimed.host_id)?.c ?? 0;
      expect(credCountAfter).toBe(0);
      expect(
        t.ctx.db
          .prepare<[], { c: number }>(`SELECT COUNT(*) AS c FROM agents`)
          .get()?.c ?? 0,
      ).toBe(agentCountBefore);
      expect(
        t.ctx.db
          .prepare<[], { c: number }>(`SELECT COUNT(*) AS c FROM workspaces`)
          .get()?.c ?? 0,
      ).toBe(workspaceCountBefore);
    });

    it('is idempotent and still sweeps a half-failed credential row', async () => {
      t = buildTestApp({ ownedLocalHostUserIds: [] });
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const h = sessionHttp(t, userToken);
      const claimed = await h.json<any>(
        h.post(apiPaths.hostClaimOrCreate, {
          installation_id: '50000002-1111-4111-8111-111111111111',
        }),
      );
      // Manufacture a half-failed state: host already revoked, but
      // a stray credential is still active. Stage B.4 contract: a
      // re-revoke must reconcile this.
      const beforeRevokedAt = Date.now() - 60_000;
      t.ctx.db
        .prepare(`UPDATE hosts SET revoked_at = ? WHERE id = ?`)
        .run(beforeRevokedAt, claimed.host_id);
      t.ctx.db
        .prepare(`UPDATE host_credentials SET revoked_at = NULL WHERE host_id = ?`)
        .run(claimed.host_id);

      const res = await h.post(apiPaths.hostRevoke(claimed.host_id));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { host: any };
      // Tombstone timestamp must NOT advance on re-revoke.
      expect(body.host.revoked_at).toBe(beforeRevokedAt);
      expect(
        t.ctx.db
          .prepare<[string], { c: number }>(
            `SELECT COUNT(*) AS c FROM host_credentials
              WHERE host_id = ? AND revoked_at IS NULL`,
          )
          .get(claimed.host_id)?.c ?? 0,
      ).toBe(0);
    });

    it('returns 404 (not 403) for cross-user revoke attempts (no enumeration)', async () => {
      t = buildTestApp({ ownedLocalHostUserIds: ['alice', 'bob'] });
      const aliceToken = t.ctx.authSessions.issueSession({ userId: 'alice' }).userToken;
      const bobHost = new HostRepo(t.ctx.db).getOwnedLocalForUser('bob');
      expect(bobHost).not.toBeNull();
      const res = await sessionHttp(t, aliceToken).post(apiPaths.hostRevoke(bobHost!.id));
      expect(res.status).toBe(404);
      // Bob's host is still active.
      expect(new HostRepo(t.ctx.db).get(bobHost!.id)).toMatchObject({ revoked_at: null });
    });

    it('returns 404 for missing host id', async () => {
      t = buildTestApp();
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const res = await sessionHttp(t, userToken).post(apiPaths.hostRevoke('nonexistent'));
      expect(res.status).toBe(404);
    });

    it('rejects retired server-config bearer', async () => {
      t = buildTestApp();
      const res = await legacyServerAuthHttp(t).post(apiPaths.hostRevoke('whatever'));
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: 'unauthorized' });
    });
  });

  // ── POST /api/hosts/:id/rotate-token (Stage B.4) ─────────────
  describe('POST /api/hosts/:id/rotate-token', () => {
    it('rotates the active credential with a 60s grace and mints a new long_lived token', async () => {
      t = buildTestApp({ ownedLocalHostUserIds: [] });
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const h = sessionHttp(t, userToken);
      const claimed = await h.json<any>(
        h.post(apiPaths.hostClaimOrCreate, {
          installation_id: '50000003-1111-4111-8111-111111111111',
        }),
      );
      const oldToken = claimed.host_token as string;
      expect(oldToken).toBeTruthy();

      const before = Date.now();
      const res = await h.post(apiPaths.hostRotateToken(claimed.host_id));
      const after = Date.now();
      expect(res.status).toBe(200);
      const body = (await res.json()) as { host_id: string; host_token: string; host: any };
      expect(body.host_id).toBe(claimed.host_id);
      expect(body.host_token).toEqual(expect.any(String));
      expect(body.host_token).not.toBe(oldToken);
      expect(body.host).toMatchObject({ id: claimed.host_id, revoked_at: null });

      // 2 rows: prior cred has expires_at in [before+60s, after+60s];
      // new cred has expires_at = NULL.
      const rows = t.ctx.db
        .prepare<[string], { token_hash: string; expires_at: number | null; revoked_at: number | null }>(
          `SELECT token_hash, expires_at, revoked_at
             FROM host_credentials
            WHERE host_id = ?
            ORDER BY rowid ASC`,
        )
        .all(claimed.host_id);
      expect(rows).toHaveLength(2);
      const oldRow = rows.find(r => r.token_hash === hashHostToken(oldToken));
      const newRow = rows.find(r => r.token_hash === hashHostToken(body.host_token));
      expect(oldRow).toBeDefined();
      expect(newRow).toBeDefined();
      expect(oldRow!.expires_at).toBeGreaterThanOrEqual(before + 60_000);
      expect(oldRow!.expires_at).toBeLessThanOrEqual(after + 60_000);
      expect(oldRow!.revoked_at).toBeNull();
      expect(newRow!.expires_at).toBeNull();

      // Within the grace window the old token still verifies.
      const verifier = new HostTokenService(t.ctx.db);
      expect(verifier.verifyHostToken(oldToken)).toMatchObject({ ok: true });
      // Past the grace window, it's expired.
      expect(
        verifier.verifyHostToken(oldToken, { now: oldRow!.expires_at! + 1 }),
      ).toMatchObject({ ok: false, code: 'credential_expired' });
      // New token verifies indefinitely.
      expect(verifier.verifyHostToken(body.host_token)).toMatchObject({ ok: true });
    });

    it('returns 404 for cross-user rotate (no enumeration)', async () => {
      t = buildTestApp({ ownedLocalHostUserIds: ['alice', 'bob'] });
      const aliceToken = t.ctx.authSessions.issueSession({ userId: 'alice' }).userToken;
      const bobHost = new HostRepo(t.ctx.db).getOwnedLocalForUser('bob');
      expect(bobHost).not.toBeNull();
      const res = await sessionHttp(t, aliceToken).post(
        apiPaths.hostRotateToken(bobHost!.id),
      );
      expect(res.status).toBe(404);
      // No new credential row was minted on Bob's host.
      expect(
        t.ctx.db
          .prepare<[string], { c: number }>(
            `SELECT COUNT(*) AS c FROM host_credentials WHERE host_id = ?`,
          )
          .get(bobHost!.id)?.c ?? 0,
      ).toBeLessThanOrEqual(1);
    });

    it('returns 409 host_revoked on a soft-deleted host', async () => {
      t = buildTestApp({ ownedLocalHostUserIds: [] });
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const h = sessionHttp(t, userToken);
      const claimed = await h.json<any>(
        h.post(apiPaths.hostClaimOrCreate, {
          installation_id: '50000004-1111-4111-8111-111111111111',
        }),
      );
      new HostRepo(t.ctx.db).revoke(claimed.host_id);
      const res = await h.post(apiPaths.hostRotateToken(claimed.host_id));
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error_code: 'host_revoked' });
    });

    it('returns 409 kind_not_supported for non-local hosts', async () => {
      t = buildTestApp({ ownedLocalHostUserIds: [] });
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      // V1 surface only allows rotating the user's local host. Inject
      // a remote-kind row owned by the user to exercise the guard
      // (production has no UI to provision remote hosts yet).
      const remote = new HostRepo(t.ctx.db).create('remote-test', 'remote', {
        userId: t.viewerUserId,
        installationId: 'install-remote',
      });
      const res = await sessionHttp(t, userToken).post(apiPaths.hostRotateToken(remote.id));
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error_code: 'kind_not_supported' });
    });

    it('rejects retired server-config bearer', async () => {
      t = buildTestApp();
      const res = await legacyServerAuthHttp(t).post(apiPaths.hostRotateToken('whatever'));
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: 'unauthorized' });
    });
  });
});

function sessionHttp(t: TestApp, token: string) {
  return http(t, { authorization: `Bearer ${token}` });
}

function legacyServerAuthHttp(t: TestApp) {
  return http(t, { authorization: `Bearer ${t.legacyServerAuthToken}` });
}
