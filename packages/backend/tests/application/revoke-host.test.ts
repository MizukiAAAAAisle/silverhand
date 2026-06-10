import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiPaths } from '@silverhand/shared';
import { revokeHost } from '../../src/application/revoke-host.js';
import { HostRepo } from '../../src/repos/host-repo.js';
import { HostTokenService } from '../../src/auth/host-token.js';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

/**
 * Application-level tests for the `revokeHost` use case (#task:978, P9). The route suite
 * (`tests/routes/hosts.test.ts`) pins the HTTP-mapped behavior — incl. tx
 * atomicity + full-body fidelity (commit `8c322d0`). These call the use case
 * DIRECTLY so the contract is pinned independent of Hono: the typed result
 * branches and, crucially, the defensive refetch-null throw (spec §2.1) which
 * is UNREACHABLE at the route level (a soft-delete is an UPDATE, so the row is
 * always present) and only surfaces by injecting a stub `hosts.get`.
 */

function sessionHttp(t: TestApp, token: string) {
  return http(t, { authorization: `Bearer ${token}` });
}

async function claimHost(t: TestApp, installationId: string): Promise<string> {
  const token = t.ctx.authSessions.issueSession({ userId: t.viewerUserId }).userToken;
  const h = sessionHttp(t, token);
  const claimed = await h.json<any>(
    h.post(apiPaths.hostClaimOrCreate, { installation_id: installationId }),
  );
  return claimed.host_id as string;
}

describe('revokeHost use case', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('revokes a freshly-claimed host, sweeps its credentials, returns the revoked HostDto', async () => {
    t = buildTestApp({ ownedLocalHostUserIds: [] });
    const hostId = await claimHost(t, '60000001-1111-4111-8111-111111111111');
    const hosts = new HostRepo(t.ctx.db);
    const hostTokens = new HostTokenService(t.ctx.db);

    const result = revokeHost(
      { ctx: t.ctx, hosts, hostTokens },
      { hostId, requesterUserId: t.viewerUserId },
    );

    expect(result.kind).toBe('revoked');
    if (result.kind !== 'revoked') return;
    expect(result.host.id).toBe(hostId);
    expect(typeof result.host.revoked_at).toBe('number');
    const active =
      t.ctx.db
        .prepare<[string], { c: number }>(
          `SELECT COUNT(*) AS c FROM host_credentials
            WHERE host_id = ? AND revoked_at IS NULL`,
        )
        .get(hostId)?.c ?? 0;
    expect(active).toBe(0);
  });

  it('returns notFound for a missing host id (no throw, no write)', () => {
    t = buildTestApp();
    const result = revokeHost(
      {
        ctx: t.ctx,
        hosts: new HostRepo(t.ctx.db),
        hostTokens: new HostTokenService(t.ctx.db),
      },
      { hostId: 'no-such-host', requesterUserId: t.viewerUserId },
    );
    expect(result).toEqual({ kind: 'notFound' });
  });

  it('returns notFound (no enumeration) for a cross-user host and leaves it active', () => {
    t = buildTestApp({ ownedLocalHostUserIds: ['alice', 'bob'] });
    const bobHost = new HostRepo(t.ctx.db).getOwnedLocalForUser('bob');
    expect(bobHost).not.toBeNull();

    const result = revokeHost(
      {
        ctx: t.ctx,
        hosts: new HostRepo(t.ctx.db),
        hostTokens: new HostTokenService(t.ctx.db),
      },
      { hostId: bobHost!.id, requesterUserId: 'alice' },
    );

    expect(result).toEqual({ kind: 'notFound' });
    expect(new HostRepo(t.ctx.db).get(bobHost!.id)).toMatchObject({ revoked_at: null });
  });

  // The (i) gap from the coverage audit: the post-commit refetch returning null
  // is a defensive invariant breach (a committed soft-delete leaves the row in
  // place, so it cannot happen via the route). Pin it by stubbing `hosts.get`
  // to return the real owned row on the owner-resolve call and null on the
  // post-commit refetch.
  it('throws (defensive) when the post-commit refetch returns null', async () => {
    const app = (t = buildTestApp({ ownedLocalHostUserIds: [] }));
    const hostId = await claimHost(app, '60000002-1111-4111-8111-111111111111');
    const hosts = new HostRepo(app.ctx.db);
    const hostTokens = new HostTokenService(app.ctx.db);
    const realRow = hosts.get(hostId);
    expect(realRow).not.toBeNull();

    let calls = 0;
    vi.spyOn(hosts, 'get').mockImplementation((_id: string) => {
      calls += 1;
      return calls === 1 ? realRow : null;
    });

    expect(() =>
      revokeHost(
        { ctx: app.ctx, hosts, hostTokens },
        { hostId, requesterUserId: app.viewerUserId },
      ),
    ).toThrow(/returned null for revoked host/);
  });
});
