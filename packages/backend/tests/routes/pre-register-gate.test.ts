import { afterEach, describe, expect, it } from 'vitest';
import { apiPaths, authPaths } from '@silverhand/shared';
import { HostRepo } from '../../src/repos/host-repo.js';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

/**
 * Pre-register gate enforced by `installRequireRegisteredViewerMiddleware`.
 *
 * Production identity model: pre-auth means no user principal has been
 * resolved for the request; downstream public routes either work
 * (whitelisted setup reads) or return 403 `registration_required`.
 *
 * Contract:
 *   - GET /api/me + GET /api/health are the ONLY `/api/*` routes reachable
 *     when no viewer is authenticated.
 *   - GET /api/me returns the discriminated `RegistrationRequired` shape
 *     (`{registration_required: true, suggested_name: 'user-XXXX'}`).
 *   - Every other public route returns 403 `registration_required`.
 *   - Internal (agent-principal) routes are unaffected — agents have
 *     no registration state and should keep working even before the
 *     human registers.
 *
 * The renderer-side gate in `App.tsx` is the user-friendly half;
 * this middleware is the security half (V2 multi-user, CLI tools,
 * any non-renderer caller).
 */
describe('Pre-register gate (requireRegisteredViewer middleware)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  /**
   * Reset the fixture into the production pre-auth state:
   * no users row and no legacy settings pointer.
   */
  function unregisterViewer(test: TestApp): void {
    test.ctx.db
      .prepare(`DELETE FROM app_settings WHERE key = 'viewer_user_id'`)
      .run();
    test.ctx.db.prepare(`DELETE FROM users`).run();
  }

  function noPrincipalHttp(test: TestApp) {
    return http(test, { 'X-Silverhand-User-Id': '' });
  }

  it('GET /api/me returns the registration_required shape before registration', async () => {
    t = buildTestApp({ ownedLocalHostUserIds: [] });
    unregisterViewer(t);
    const res = await noPrincipalHttp(t).get(apiPaths.me);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      registration_required?: boolean;
      suggested_name?: string;
    };
    expect(body.registration_required).toBe(true);
    expect(body.suggested_name).toMatch(/^user-[0-9a-f]{8}$/);
  });

  it('does not expose legacy POST /api/register before authentication', async () => {
    t = buildTestApp({ ownedLocalHostUserIds: [] });
    unregisterViewer(t);
    const res = await noPrincipalHttp(t).post('/api/register', { name: 'shiki' });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('registration_required');
  });

  it('blocks POST /api/workspaces with 403 registration_required', async () => {
    t = buildTestApp({ ownedLocalHostUserIds: [] });
    unregisterViewer(t);
    const res = await noPrincipalHttp(t).post('/api/workspaces', { name: 'should-block' });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe('registration_required');
  });

  it('blocks POST /api/agents with 403 registration_required', async () => {
    t = buildTestApp({ ownedLocalHostUserIds: [] });
    unregisterViewer(t);
    const res = await noPrincipalHttp(t).post('/api/agents', {
      name: 'should-block',
      runtime: 'claude',
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('registration_required');
  });

  it('blocks PATCH /api/me with 403 registration_required', async () => {
    // PATCH /api/me is NOT whitelisted — only the read is. The gate
    // prevents side-door profile creation/update before authentication.
    t = buildTestApp({ ownedLocalHostUserIds: [] });
    unregisterViewer(t);
    const res = await noPrincipalHttp(t).patch(apiPaths.me, { display_name: 'Sneaky' });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('registration_required');
  });

  it('blocks GET /api/workspaces with 403 registration_required', async () => {
    // Read paths are gated too — without registration the viewer has
    // no identity for FK / audit purposes, so we deny uniformly.
    t = buildTestApp({ ownedLocalHostUserIds: [] });
    unregisterViewer(t);
    const res = await noPrincipalHttp(t).get('/api/workspaces');
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('registration_required');
  });

  it('reopens the full surface after auth signup succeeds', async () => {
    t = buildTestApp({ ownedLocalHostUserIds: [] });
    unregisterViewer(t);

    const signup = await noPrincipalHttp(t).post(authPaths.signup, {
      email: 'shiki@example.test',
      password: 'correct horse battery staple',
      display_name: 'Shiki',
    });
    expect(signup.status).toBe(200);
    const auth = await signup.json() as { user_token: string; user: { id: string } };
    new HostRepo(t.ctx.db).claimOrCreateLocal({
      userId: auth.user.id,
      installationId: 'post-register-install',
    });

    const create = await http(t, {
      authorization: `Bearer ${auth.user_token}`,
      'X-Silverhand-User-Id': '',
    }).post(
      '/api/workspaces',
      { name: 'post-register-ws' },
    );
    expect(create.status).toBe(201);
  });

  it('lets registered viewers reach all routes (no regression)', async () => {
    // Default fixture pre-registers `local` — sanity check that the
    // gate does not over-fire for already-registered users.
    t = buildTestApp({ ownedLocalHostUserIds: [] });
    const res = await http(t).get('/api/workspaces');
    expect(res.status).toBe(200);
  });

  it('allows GET /api/health before registration (liveness must stay open)', async () => {
    // Supervisors / load balancers probe liveness without credentials
    // and without a viewer. The gate must not turn the pre-registration
    // case into a 403 here, or first-boot health checks would mark the
    // process unhealthy.
    t = buildTestApp({ ownedLocalHostUserIds: [] });
    unregisterViewer(t);
    const res = await noPrincipalHttp(t).get('/api/health');
    expect(res.status).toBe(200);
  });
});
