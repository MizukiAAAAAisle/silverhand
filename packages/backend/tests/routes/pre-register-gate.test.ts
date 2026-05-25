import { afterEach, describe, expect, it } from 'vitest';
import { apiPaths } from '@silverhand/shared';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

/**
 * Pre-register gate enforced by `installRequireRegisteredViewerMiddleware`.
 *
 * Production identity model (post pre-ship rewrite): pre-registration
 * means `app_settings.viewer_user_id` is unset and `users` is empty.
 * The principal middleware therefore resolves no viewer; downstream
 * routes either work (whitelisted) or return 403 `registration_required`.
 *
 * Contract:
 *   - GET /api/me + POST /api/register + GET /api/health are the ONLY
 *     public routes reachable when no viewer is registered.
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
   * Reset the fixture into the production pre-registration state:
   * `users` row absent + `app_settings.viewer_user_id` unset.
   */
  function unregisterViewer(test: TestApp): void {
    test.ctx.db
      .prepare(`DELETE FROM app_settings WHERE key = 'viewer_user_id'`)
      .run();
    test.ctx.db.prepare(`DELETE FROM users WHERE id = 'local'`).run();
  }

  function noPrincipalHttp(test: TestApp) {
    return http(test, { 'X-Silverhand-User-Id': '' });
  }

  it('GET /api/me returns the registration_required shape before registration', async () => {
    t = buildTestApp();
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

  it('allows POST /api/register before registration', async () => {
    t = buildTestApp();
    unregisterViewer(t);
    const res = await noPrincipalHttp(t).post(apiPaths.register, { name: 'shiki' });
    expect(res.status).toBe(200);
  });

  it('blocks POST /api/workspaces with 403 registration_required', async () => {
    t = buildTestApp();
    unregisterViewer(t);
    const res = await noPrincipalHttp(t).post('/api/workspaces', { name: 'should-block' });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe('registration_required');
  });

  it('blocks POST /api/agents with 403 registration_required', async () => {
    t = buildTestApp();
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
    // ensures registration must happen via /api/register, never via
    // a side-door display_name PATCH (and pre-registration there is
    // no row to patch in the first place).
    t = buildTestApp();
    unregisterViewer(t);
    const res = await noPrincipalHttp(t).patch(apiPaths.me, { display_name: 'Sneaky' });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('registration_required');
  });

  it('blocks GET /api/workspaces with 403 registration_required', async () => {
    // Read paths are gated too — without registration the viewer has
    // no identity for FK / audit purposes, so we deny uniformly.
    t = buildTestApp();
    unregisterViewer(t);
    const res = await noPrincipalHttp(t).get('/api/workspaces');
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('registration_required');
  });

  it('reopens the full surface after POST /api/register succeeds', async () => {
    t = buildTestApp();
    unregisterViewer(t);

    // Register first — INSERT user + write viewer_user_id atomically.
    const reg = await noPrincipalHttp(t).post(apiPaths.register, { name: 'shiki' });
    expect(reg.status).toBe(200);
    const viewer = await reg.json() as { id: string };

    // With A.3 the settings pointer is not a principal fallback; the
    // caller must send an explicit session/legacy principal.
    const create = await http(t, { 'X-Silverhand-User-Id': viewer.id }).post(
      '/api/workspaces',
      { name: 'post-register-ws' },
    );
    expect(create.status).toBe(201);
  });

  it('lets registered viewers reach all routes (no regression)', async () => {
    // Default fixture pre-registers `local` — sanity check that the
    // gate does not over-fire for already-registered users.
    t = buildTestApp();
    const res = await http(t).get('/api/workspaces');
    expect(res.status).toBe(200);
  });

  it('allows GET /api/health before registration (liveness must stay open)', async () => {
    // Supervisors / load balancers probe liveness without credentials
    // and without a viewer. The gate must not turn the pre-registration
    // case into a 403 here, or first-boot health checks would mark the
    // process unhealthy.
    t = buildTestApp();
    unregisterViewer(t);
    const res = await noPrincipalHttp(t).get('/api/health');
    expect(res.status).toBe(200);
  });
});
