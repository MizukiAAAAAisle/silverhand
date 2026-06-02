import { afterEach, describe, expect, it } from 'vitest';
import { apiPaths } from '@silverhand/shared';
import type {
  OutboundServerCommandKind,
  OutboundServerCommandParams,
  OutboundServerCommandResult,
} from '@silverhand/host';
import { HostTokenService, hashHostToken } from '../../src/auth/host-token.js';
import { HostRepo } from '../../src/repos/host-repo.js';
import type { HostWsServerController } from '../../src/ws/host-ws-server.js';
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

  // ── POST /api/hosts/claim_or_create — standalone (D4.c C2) ───
  describe('POST /api/hosts/claim_or_create (standalone)', () => {
    /**
     * D4.c C2 — pre-D4.c the standalone branch in routes.ts short-
     * circuited every host-mutation route to `host_runtime_disabled`
     * (409). C2 lifts that guard: standalone now owns a real hosts
     * table populated by remote daemons attaching over outbound WSS,
     * so claim_or_create has to succeed and persist a credential just
     * like embedded.
     *
     * R4 boundary: this test exercises the SAME HTTP route, the SAME
     * DB write, and the SAME host_token contract regardless of
     * deployment mode — there is no wire-protocol fork.
     */
    it('claims a host and mints a credential under standalone (no host_runtime_disabled)', async () => {
      t = buildTestApp({
        deploymentMode: 'standalone',
        ownedLocalHostUserIds: [],
      });
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;

      const res = await sessionHttp(t, userToken).post(apiPaths.hostClaimOrCreate, {
        installation_id: '5a000001-1111-4111-8111-111111111111',
        label: 'Standalone Mac',
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body).toMatchObject({
        host_id: expect.any(String),
        host: {
          id: body.host_id,
          kind: 'local',
          revoked_at: null,
        },
        host_token: expect.any(String),
      });
      // The new credential is verifiable end-to-end — same shape as
      // embedded mode.
      expect(new HostTokenService(t.ctx.db).verifyHostToken(body.host_token))
        .toMatchObject({
          ok: true,
          hostId: body.host_id,
          userId: t.viewerUserId,
        });
    });
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

    /**
     * D4.c C2 — pre-D4.c the standalone branch short-circuited
     * /api/hosts/:id/revoke to `host_runtime_disabled`. C2 lifts the
     * guard AND adds a best-effort `wsController.disconnectHost(id)`
     * call after the revoke transaction commits, so the kicked
     * daemon learns its credential is gone via WS close 1008
     * (`host_revoked`) instead of waiting for the next heartbeat /
     * attachment timeout.
     *
     * R4 boundary: the disconnect is a transport-layer hint, not a
     * server↔daemon protocol mechanism. The credential is already
     * revoked at the DB level; if the disconnect throws or the host
     * isn't currently attached, the revoke still succeeds (best-
     * effort, log-and-swallow) — backend correctness still rests on
     * `verifyHostToken` rejecting the credential on the next attach.
     */
    it('standalone revoke succeeds and asks the WS controller to kick the live attachment', async () => {
      let controller: FakeHostWsController | null = null;
      t = buildTestApp({
        deploymentMode: 'standalone',
        hostWsController: () => controller,
      });
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const host = new HostRepo(t.ctx.db).getOwnedLocalForUser(t.viewerUserId)!;
      controller = new FakeHostWsController(async () => ({}));

      const res = await sessionHttp(t, userToken).post(apiPaths.hostRevoke(host.id));

      expect(res.status).toBe(200);
      const body = (await res.json()) as { host: any };
      expect(body.host).toMatchObject({
        id: host.id,
        revoked_at: expect.any(Number),
      });
      // DB-level revoke did happen (the authoritative bit).
      expect(new HostRepo(t.ctx.db).get(host.id)).toMatchObject({
        revoked_at: expect.any(Number),
      });
      // Best-effort kick: controller saw exactly this host id.
      expect(controller!.disconnects).toEqual([host.id]);
    });

    it('standalone revoke still succeeds when the WS controller throws (best-effort)', async () => {
      class ThrowingController extends FakeHostWsController {
        constructor() {
          super(async () => ({}));
        }
        override disconnectHost(hostId: string): boolean {
          this.disconnects.push(hostId);
          throw new Error('synthetic disconnect failure');
        }
      }
      let controller: ThrowingController | null = null;
      t = buildTestApp({
        deploymentMode: 'standalone',
        hostWsController: () => controller,
      });
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const host = new HostRepo(t.ctx.db).getOwnedLocalForUser(t.viewerUserId)!;
      controller = new ThrowingController();

      const res = await sessionHttp(t, userToken).post(apiPaths.hostRevoke(host.id));

      expect(res.status).toBe(200);
      // Even though the controller threw, the revoke is committed.
      expect(new HostRepo(t.ctx.db).get(host.id)).toMatchObject({
        revoked_at: expect.any(Number),
      });
      // And the controller was indeed asked.
      expect(controller!.disconnects).toEqual([host.id]);
    });

    /**
     * D4.c C2 round-1 fixup (Cindy nit) — pin that the standalone
     * lift didn't smuggle a path past the owner check. Pre-D4.c the
     * standalone guard would have short-circuited at
     * `host_runtime_disabled` BEFORE the cross-user check; if a
     * future refactor accidentally swaps the order, the cross-user
     * 404 test under default (embedded) mode wouldn't catch it.
     * This test pins both: standalone returns 404 (not 403, not
     * `host_runtime_disabled`) for cross-user revoke, AND the WS
     * controller's `disconnectHost` is never called.
     */
    it('standalone — cross-user revoke still 404 + does NOT call disconnectHost', async () => {
      let controller: FakeHostWsController | null = null;
      t = buildTestApp({
        deploymentMode: 'standalone',
        ownedLocalHostUserIds: ['alice', 'bob'],
        hostWsController: () => controller,
      });
      const aliceToken = t.ctx.authSessions.issueSession({ userId: 'alice' }).userToken;
      const bobHost = new HostRepo(t.ctx.db).getOwnedLocalForUser('bob');
      expect(bobHost).not.toBeNull();
      controller = new FakeHostWsController(async () => ({}));

      const res = await sessionHttp(t, aliceToken).post(apiPaths.hostRevoke(bobHost!.id));

      expect(res.status).toBe(404);
      // Bob's host stays active.
      expect(new HostRepo(t.ctx.db).get(bobHost!.id)).toMatchObject({
        revoked_at: null,
      });
      // The kick is never invoked — owner check rejects before the
      // best-effort disconnect runs.
      expect(controller!.disconnects).toEqual([]);
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

      // 2 rows: prior cred has a scheduled grace revoke in [before+60s, after+60s]
      // and records the rotation handoff in consumed_at; new cred is active.
      const rows = t.ctx.db
        .prepare<
          [string],
          {
            token_hash: string;
            expires_at: number | null;
            consumed_at: number | null;
            revoked_at: number | null;
          }
        >(
          `SELECT token_hash, expires_at, consumed_at, revoked_at
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
      expect(oldRow!.expires_at).toBeNull();
      expect(oldRow!.consumed_at).toBeGreaterThanOrEqual(before);
      expect(oldRow!.consumed_at).toBeLessThanOrEqual(after);
      expect(oldRow!.revoked_at).toBeGreaterThanOrEqual(before + 60_000);
      expect(oldRow!.revoked_at).toBeLessThanOrEqual(after + 60_000);
      expect(newRow!.expires_at).toBeNull();
      expect(newRow!.consumed_at).toBeNull();
      expect(newRow!.revoked_at).toBeNull();

      // Within the grace window the old token still verifies.
      const verifier = new HostTokenService(t.ctx.db);
      expect(verifier.verifyHostToken(oldToken)).toMatchObject({ ok: true });
      // Past the grace window, it's expired.
      expect(
        verifier.verifyHostToken(oldToken, { now: oldRow!.revoked_at! + 1 }),
      ).toMatchObject({ ok: false, code: 'credential_expired' });
      // New token verifies indefinitely.
      expect(verifier.verifyHostToken(body.host_token)).toMatchObject({ ok: true });
    });

    it('standalone rotates over host websocket without returning cleartext token', async () => {
      let controller: FakeHostWsController | null = null;
      t = buildTestApp({
        deploymentMode: 'standalone',
        hostWsController: () => controller,
      });
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const host = new HostRepo(t.ctx.db).getOwnedLocalForUser(t.viewerUserId);
      expect(host).not.toBeNull();
      const tokens = new HostTokenService(t.ctx.db);
      const old = tokens.issueHostToken({ hostId: host!.id });
      controller = new FakeHostWsController(async call => {
        expect(call).toMatchObject({
          hostId: host!.id,
          kind: 'rotate_token',
        });
        expect(call.params.host_token).not.toBe(old.hostToken);
        return {
          rotated: true,
          host_id: host!.id,
          config_refreshed_at: 1_700_000_000_123,
        };
      });

      const res = await sessionHttp(t, userToken).post(
        apiPaths.hostRotateToken(host!.id),
      );

      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body).toMatchObject({
        host_id: host!.id,
        status: 'rotated',
      });
      expect(body).not.toHaveProperty('host_token');
      expect(controller!.calls).toHaveLength(1);
      expect(tokens.verifyHostToken(old.hostToken)).toMatchObject({
        ok: true,
        hostId: host!.id,
      });
      const oldRow = t.ctx.db
        .prepare<[string], { consumed_at: number | null; revoked_at: number | null }>(
          `SELECT consumed_at, revoked_at FROM host_credentials WHERE id = ?`,
        )
        .get(old.credential.id);
      expect(oldRow?.consumed_at).toEqual(expect.any(Number));
      expect(oldRow?.revoked_at).toEqual(expect.any(Number));
    });

    it('standalone leaves credentials unchanged when daemon rejects rotate', async () => {
      let controller: FakeHostWsController | null = null;
      t = buildTestApp({
        deploymentMode: 'standalone',
        hostWsController: () => controller,
      });
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const host = new HostRepo(t.ctx.db).getOwnedLocalForUser(t.viewerUserId)!;
      const tokens = new HostTokenService(t.ctx.db);
      const old = tokens.issueHostToken({ hostId: host.id });
      const beforeRows = t.ctx.db
        .prepare<[string], Record<string, unknown>>(
          `SELECT id, token_hash, consumed_at, revoked_at
             FROM host_credentials
            WHERE host_id = ?
            ORDER BY rowid ASC`,
        )
        .all(host.id);
      controller = new FakeHostWsController(async () => ({
        rotated: false,
        reason: 'write_failed',
        message: 'EACCES',
      }));

      const res = await sessionHttp(t, userToken).post(
        apiPaths.hostRotateToken(host.id),
      );

      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({
        error_code: 'host_token_rotation_failed',
        reason: 'write_failed',
      });
      expect(
        t.ctx.db
          .prepare<[string], Record<string, unknown>>(
            `SELECT id, token_hash, consumed_at, revoked_at
               FROM host_credentials
              WHERE host_id = ?
              ORDER BY rowid ASC`,
          )
          .all(host.id),
      ).toEqual(beforeRows);
      expect(tokens.verifyHostToken(old.hostToken)).toMatchObject({ ok: true });
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

  // ─── v36 (#task:808) — PATCH /api/hosts/:id rename ──────────────────
  describe('PATCH /api/hosts/:id', () => {
    it('renames a host the caller owns and exposes display_label on the DTO', async () => {
      t = buildTestApp();
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const host = new HostRepo(t.ctx.db).getOwnedLocalForUser(t.viewerUserId);
      expect(host).not.toBeNull();

      const res = await sessionHttp(t, userToken).patch(
        apiPaths.host(host!.id),
        { display_label: 'Studio Mac' },
      );
      expect(res.status).toBe(200);
      const body = await res.json() as { host: { id: string; name: string; display_label: string | null } };
      expect(body.host.id).toBe(host!.id);
      expect(body.host.display_label).toBe('Studio Mac');
      // `name` stays stable — never the rename target.
      expect(body.host.name).toBe(host!.name);
    });

    it('clears the label with null', async () => {
      t = buildTestApp();
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const host = new HostRepo(t.ctx.db).getOwnedLocalForUser(t.viewerUserId);
      const h = sessionHttp(t, userToken);
      await h.patch(apiPaths.host(host!.id), { display_label: 'temp' });
      const res = await h.patch(apiPaths.host(host!.id), { display_label: null });
      expect(res.status).toBe(200);
      const body = await res.json() as { host: { display_label: string | null } };
      expect(body.host.display_label).toBeNull();
    });

    it('auto-truncates over-long labels via the repo (single round-trip UX)', async () => {
      // Schema allows up to 256; the repo trims+slices to 64. A 200-char
      // input should land as the first 64 chars, NOT as a 400.
      t = buildTestApp();
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const host = new HostRepo(t.ctx.db).getOwnedLocalForUser(t.viewerUserId);
      const long = 'A'.repeat(200);
      const res = await sessionHttp(t, userToken).patch(
        apiPaths.host(host!.id),
        { display_label: long },
      );
      expect(res.status).toBe(200);
      const body = await res.json() as { host: { display_label: string | null } };
      expect(body.host.display_label).toBe('A'.repeat(64));
    });

    it('rejects display_label past the hard cap (256 chars)', async () => {
      // Anything well past the UI's plausible cap is rejected — protects
      // the column from a buggy renderer / direct curl spamming KB-class
      // strings (Cindy slice-1 nit #2 boundary).
      t = buildTestApp();
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const host = new HostRepo(t.ctx.db).getOwnedLocalForUser(t.viewerUserId);
      const tooBig = 'A'.repeat(257);
      const res = await sessionHttp(t, userToken).patch(
        apiPaths.host(host!.id),
        { display_label: tooBig },
      );
      expect(res.status).toBe(400);
    });

    it('returns 404 for cross-user host (no enumeration)', async () => {
      // Default fixture provisions a local host for every TEST_FIXTURE_USER_IDS
      // entry — `alice` and `bob` each own one. Caller=alice, target=bob's.
      t = buildTestApp();
      const bobHost = new HostRepo(t.ctx.db)
        .listOwnedActiveLocalForUser('bob')[0];
      expect(bobHost).toBeDefined();
      const aliceToken = t.ctx.authSessions.issueSession({ userId: 'alice' }).userToken;
      const res = await sessionHttp(t, aliceToken).patch(
        apiPaths.host(bobHost!.id),
        { display_label: 'ha' },
      );
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error_code: 'host_not_found' });
    });

    it('returns 404 for missing id (no enumeration)', async () => {
      t = buildTestApp();
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const res = await sessionHttp(t, userToken).patch(
        apiPaths.host('nonexistent'),
        { display_label: 'x' },
      );
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error_code: 'host_not_found' });
    });

    it('rejects rename on a revoked host with 409', async () => {
      t = buildTestApp();
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const repo = new HostRepo(t.ctx.db);
      const host = repo.getOwnedLocalForUser(t.viewerUserId);
      expect(repo.revoke(host!.id)).toBe(true);

      const res = await sessionHttp(t, userToken).patch(
        apiPaths.host(host!.id),
        { display_label: 'new' },
      );
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error_code: 'host_revoked' });
    });
  });

  // ─── v36 (#task:808) — GET /api/hosts/:id/status snapshot ──────────
  describe('GET /api/hosts/:id/status', () => {
    it('returns `available` arm with snapshot + top-level agents when the daemon answers', async () => {
      let controller: FakeHostWsController | null = null;
      t = buildTestApp({ hostWsController: () => controller });
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const host = new HostRepo(t.ctx.db).getOwnedLocalForUser(t.viewerUserId);
      expect(host).not.toBeNull();

      // Register an agent on this host so the registration list has at
      // least one row to enrich with `online`.
      const insertedAgentId = insertTestAgent(t, {
        hostId: host!.id,
        name: 'helper',
        displayName: 'Helper',
        runtime: 'claude',
      });

      controller = new FakeHostWsController(async call => {
        expect(call.kind).toBe('host_status');
        expect(call.params).toEqual({});
        return {
          os: 'macOS 14.5',
          os_arch: 'arm64',
          daemon_pid: 4242,
          daemon_version: '0.1.0',
          started_at: 1_700_000_000_000,
          uptime_ms: 60_000,
          active_agent_ids: [insertedAgentId],
        };
      });

      const res = await sessionHttp(t, userToken).get(
        apiPaths.hostStatus(host!.id),
      );
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body).toMatchObject({
        host_id: host!.id,
        availability: 'available',
        snapshot: {
          os: 'macOS 14.5',
          os_arch: 'arm64',
          daemon_pid: 4242,
          daemon_version: '0.1.0',
          started_at: 1_700_000_000_000,
          uptime_ms: 60_000,
        },
        agents: [
          {
            agent_id: insertedAgentId,
            display_name: 'Helper',
            handle: '@helper',
            runtime: 'claude',
            avatar_url: null,
            online: 'online',
          },
        ],
      });
      // Registration moved OUT of snapshot (Cindy `Mtf5zZL-Y7PauIDi` P1):
      // snapshot carries ONLY dynamic daemon-derived fields now.
      expect(body.snapshot as Record<string, unknown>).not.toHaveProperty('agents');
      // Tagged-union strictness: `available` arm MUST NOT carry a `reason`.
      expect(body).not.toHaveProperty('reason');
    });

    it('marks unregistered active agent_ids as filler-noise (NOT injected into top-level agents[])', async () => {
      // The registration list is the source of truth. A daemon that
      // reports an active id NOT in `agents.host_id == hostId` does not
      // get a phantom row injected — ComputerPane shows registrations
      // only.
      let controller: FakeHostWsController | null = null;
      t = buildTestApp({ hostWsController: () => controller });
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const host = new HostRepo(t.ctx.db).getOwnedLocalForUser(t.viewerUserId);
      const agentId = insertTestAgent(t, {
        hostId: host!.id,
        name: 'real',
        displayName: 'Real Agent',
        runtime: 'claude',
      });

      controller = new FakeHostWsController(async () => ({
        os: 'macOS 14.5',
        daemon_pid: 1,
        daemon_version: '0.1.0',
        started_at: 1,
        uptime_ms: 1,
        active_agent_ids: [agentId, 'phantom-not-registered'],
      }));

      const res = await sessionHttp(t, userToken).get(
        apiPaths.hostStatus(host!.id),
      );
      const body = await res.json() as {
        availability: string;
        agents: Array<{ agent_id: string; online: string }>;
      };
      expect(body.availability).toBe('available');
      expect(body.agents.map(a => a.agent_id)).toEqual([agentId]);
      expect(body.agents[0]!.online).toBe('online');
    });

    it('returns `disconnected` arm with registration list (all offline) when daemon not attached', async () => {
      // Cindy `Mtf5zZL-Y7PauIDi` P1: registration view must survive daemon
      // disconnect. ComputerPane still shows which agents live on this
      // host even when the daemon is offline — they just can't be online.
      t = buildTestApp({ hostWsController: () => null });
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const host = new HostRepo(t.ctx.db).getOwnedLocalForUser(t.viewerUserId);
      const agentA = insertTestAgent(t, {
        hostId: host!.id,
        name: 'a',
        displayName: 'A',
        runtime: 'claude',
      });
      const agentB = insertTestAgent(t, {
        hostId: host!.id,
        name: 'b',
        displayName: 'B',
        runtime: 'claude',
      });

      const res = await sessionHttp(t, userToken).get(
        apiPaths.hostStatus(host!.id),
      );
      expect(res.status).toBe(200);
      const body = await res.json() as {
        availability: string;
        agents: Array<{ agent_id: string; online: string; handle: string; avatar_url: string | null }>;
      } & Record<string, unknown>;
      expect(body).toMatchObject({
        host_id: host!.id,
        availability: 'disconnected',
      });
      // Registration survives daemon disconnect, all offline.
      expect(body.agents.map(a => a.agent_id).sort()).toEqual([agentA, agentB].sort());
      expect(body.agents.every(a => a.online === 'offline')).toBe(true);
      // `avatar_url` MUST be present on every offline-arm row too —
      // the field is canonical on the producer side regardless of
      // availability. Cindy `r96u1vc8awdjfnVT`: pin every arm so the
      // schema/route invariant doesn't drift on one arm only.
      expect(body.agents.every(a => 'avatar_url' in a && a.avatar_url === null)).toBe(true);
      // Tagged-union strictness: never leak a half-snapshot or a reason
      // onto a non-`available` arm (Cindy `nTB67NWSepk054UL` constraint).
      expect(body).not.toHaveProperty('snapshot');
      expect(body).not.toHaveProperty('reason');
    });

    it('returns `unreachable{reason:"timeout"}` with registration list (all offline) when daemon RPC times out', async () => {
      let controller: FakeHostWsController | null = null;
      t = buildTestApp({ hostWsController: () => controller });
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const host = new HostRepo(t.ctx.db).getOwnedLocalForUser(t.viewerUserId);
      const agentId = insertTestAgent(t, {
        hostId: host!.id,
        name: 'reg',
        displayName: 'Reg',
        runtime: 'claude',
      });

      controller = new FakeHostWsController(async call => {
        // Importing the error class inline keeps this test from
        // forcing a top-level dependency the other suites don't need.
        const { HostWsCommandTransportError } = await import(
          '../../src/ws/host-ws-server.js'
        );
        throw new HostWsCommandTransportError(
          'transport_timeout',
          'simulated timeout',
          { hostId: call.hostId, commandKind: call.kind },
        );
      });

      const res = await sessionHttp(t, userToken).get(
        apiPaths.hostStatus(host!.id),
      );
      expect(res.status).toBe(200);
      const body = await res.json() as {
        availability: string;
        agents: Array<{ agent_id: string; online: string; avatar_url: string | null }>;
      } & Record<string, unknown>;
      expect(body).toMatchObject({
        host_id: host!.id,
        availability: 'unreachable',
        reason: 'timeout',
      });
      // Registration still visible; offline because no live daemon answered.
      expect(body.agents.map(a => a.agent_id)).toEqual([agentId]);
      expect(body.agents[0]!.online).toBe('offline');
      expect(body.agents[0]!.avatar_url).toBeNull();
      expect(body).not.toHaveProperty('snapshot');
    });

    it('returns `revoked` arm with registration list (all offline), no daemon dispatch', async () => {
      let controller: FakeHostWsController | null = null;
      t = buildTestApp({ hostWsController: () => controller });
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const repo = new HostRepo(t.ctx.db);
      const host = repo.getOwnedLocalForUser(t.viewerUserId);
      const agentId = insertTestAgent(t, {
        hostId: host!.id,
        name: 'orphan',
        displayName: 'Orphan',
        runtime: 'claude',
      });
      expect(repo.revoke(host!.id)).toBe(true);

      controller = new FakeHostWsController(async () => {
        throw new Error('daemon should NOT be dispatched for a revoked host');
      });

      const res = await sessionHttp(t, userToken).get(
        apiPaths.hostStatus(host!.id),
      );
      expect(res.status).toBe(200);
      const body = await res.json() as {
        availability: string;
        agents: Array<{ agent_id: string; online: string; avatar_url: string | null }>;
      } & Record<string, unknown>;
      expect(body).toMatchObject({
        host_id: host!.id,
        availability: 'revoked',
      });
      // Registrations survive revocation so the user can audit / cleanup.
      expect(body.agents.map(a => a.agent_id)).toEqual([agentId]);
      expect(body.agents[0]!.online).toBe('offline');
      expect(body.agents[0]!.avatar_url).toBeNull();
      expect(body).not.toHaveProperty('snapshot');
      expect(body).not.toHaveProperty('reason');
      // Daemon dispatch was short-circuited — controller stayed idle.
      expect(controller!.calls).toHaveLength(0);
    });

    it('returns 404 for cross-user host', async () => {
      t = buildTestApp();
      const bobHost = new HostRepo(t.ctx.db)
        .listOwnedActiveLocalForUser('bob')[0];
      const aliceToken = t.ctx.authSessions.issueSession({ userId: 'alice' }).userToken;
      const res = await sessionHttp(t, aliceToken).get(
        apiPaths.hostStatus(bobHost!.id),
      );
      expect(res.status).toBe(404);
    });
  });
});

/** Helper: insert a minimal agent row bound to `hostId` so the route's
 *  registration projection has something to render. The agent service
 *  has its own materialization machinery (D4.d) we don't need here —
 *  these tests focus on the route projection, not the spawn lifecycle.
 */
function insertTestAgent(
  t: TestApp,
  input: { hostId: string; name: string; displayName: string; runtime: string },
): string {
  const id = `agent-${input.name}-${Math.floor(Math.random() * 1_000_000)}`;
  const now = Date.now();
  t.ctx.db
    .prepare(
      `INSERT INTO agents
         (id, name, display_name, runtime, model, reasoning_effort, fast_mode,
          host_id, description, created_by_user_id,
          materialization_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, NULL, ?, 'active', ?, ?)`,
    )
    .run(
      id,
      input.name,
      input.displayName,
      input.runtime,
      input.hostId,
      t.viewerUserId,
      now,
      now,
    );
  return id;
}

function sessionHttp(t: TestApp, token: string) {
  return http(t, { authorization: `Bearer ${token}` });
}

function legacyServerAuthHttp(t: TestApp) {
  return http(t, { authorization: `Bearer ${t.legacyServerAuthToken}` });
}

class FakeHostWsController implements HostWsServerController {
  readonly calls: Array<{
    hostId: string;
    kind: OutboundServerCommandKind;
    params: any;
  }> = [];
  readonly disconnects: string[] = [];

  constructor(
    private readonly handler: (call: {
      hostId: string;
      kind: OutboundServerCommandKind;
      params: any;
    }) => Promise<unknown>,
  ) {}

  activeConnectionCount(): number {
    return 1;
  }

  connectedHostIds(): string[] {
    return ['host'];
  }

  connectionIdForHost(): string | null {
    return 'conn-1';
  }

  getAttachment(): null {
    // Route tests don't exercise the attachment registry; D3.a's
    // boot-readiness invariant is covered in host-ws-server tests.
    return null;
  }

  async sendCommand<K extends OutboundServerCommandKind>(
    hostId: string,
    kind: K,
    params: OutboundServerCommandParams<K>,
  ): Promise<OutboundServerCommandResult<K>> {
    const call = { hostId, kind, params };
    this.calls.push(call);
    return await this.handler(call) as OutboundServerCommandResult<K>;
  }

  // D4.c C2 — record the disconnect call so tests can assert the
  // revoke route invoked it. Returns true unconditionally; the
  // route's contract is "best-effort, log and swallow", so the
  // value isn't load-bearing for the route side.
  disconnectHost(hostId: string): boolean {
    this.disconnects.push(hostId);
    return true;
  }

  async close(): Promise<void> {
    // no-op
  }
}
