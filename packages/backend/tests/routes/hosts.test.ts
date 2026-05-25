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
    t = buildTestApp();
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
    t = buildTestApp();
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
    t = buildTestApp();
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

  it('fails closed for a revoked existing host and does not issue a new token', async () => {
    t = buildTestApp();
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
    const revoked = await h.post(apiPaths.hostClaimOrCreate, {
      installation_id: '33333333-3333-4333-8333-333333333333',
    });

    expect(revoked.status).toBe(409);
    expect(await revoked.json()).toEqual({
      error: 'host has been revoked',
      error_code: 'host_revoked',
    });
    const count = t.ctx.db
      .prepare<[string], { c: number }>(
        `SELECT COUNT(*) AS c FROM host_credentials WHERE host_id = ?`,
      )
      .get(first.host_id);
    expect(count?.c).toBe(1);
  });

  it('rejects legacy embedded bearer access to the token-bearing claim route', async () => {
    t = buildTestApp();
    const res = await http(t).post(apiPaths.hostClaimOrCreate, {
      installation_id: '44444444-4444-4444-8444-444444444444',
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: 'host claim requires a user session bearer',
      code: 'session_bearer_required',
    });
    const count = t.ctx.db
      .prepare<[], { c: number }>(`SELECT COUNT(*) AS c FROM host_credentials`)
      .get();
    expect(count?.c).toBe(0);
  });
});

function sessionHttp(t: TestApp, token: string) {
  return http(t, { authorization: `Bearer ${token}` });
}
