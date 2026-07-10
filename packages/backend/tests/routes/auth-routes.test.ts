import { afterEach, describe, expect, it } from 'vitest';
import { OUTBOUND_PROTOCOL_VERSION } from '@silverhand/host';
import { apiPaths, authPaths } from '@silverhand/shared';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

describe('auth routes', () => {
  let t: TestApp | null = null;

  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('exposes server info with bind scope and serves typed 403 when signup is disabled', async () => {
    // D4.a Commit 4 contract (per `docs/remote-backend-architecture-notes.md §3`):
    //   - `/api/server/info` exposes both `signup_enabled` AND
    //     `bind_address_scope` so desktop/ops tooling can read the
    //     "exposure + signup" combination programmatically.
    //   - `/auth/signup` is ALWAYS mounted; the handler branches on
    //     `signupEnabled` and returns a typed `403 { code:
    //     'signup_disabled' }` body when disabled (reversing the
    //     A.2 hide-as-missing behaviour, see §6.2 for rationale).
    t = buildTestApp({
      authConfig: { signupEnabled: false },
      bindAddressScope: 'lan',
    });

    const info = await requestJson(t, 'GET', apiPaths.serverInfo);
    expect(info.status).toBe(200);
    expect(info.body).toEqual({
      signup_enabled: false,
      bind_address_scope: 'lan',
      outbound_protocol_version: OUTBOUND_PROTOCOL_VERSION,
    });

    const disabled = await requestJson(t, 'POST', authPaths.signup, {
      email: 'closed@example.com',
      password: 'correct-password',
    });
    expect(disabled.status).toBe(403);
    expect(disabled.body).toMatchObject({ code: 'signup_disabled' });

    // The missing-route 404 still works for unrelated paths — pin that
    // the typed 403 is a real handler decision, not a routing accident.
    const missing = await requestText(t, 'POST', '/auth/not-a-route', {
      email: 'closed@example.com',
      password: 'correct-password',
    });
    expect(missing.status).toBe(404);
  });

  it('reports bind_address_scope=loopback by default and surfaces public when overridden', async () => {
    // D4.a Commit 4 (per §6.3 condition 3) — the field is required on
    // production `/api/server/info`. Default in tests must surface
    // `loopback` so route tests do not have to special-case it.
    t = buildTestApp();
    const def = await requestJson(t, 'GET', apiPaths.serverInfo);
    expect(def.status).toBe(200);
    expect(def.body.bind_address_scope).toBe('loopback');
    t.cleanup();

    t = buildTestApp({ bindAddressScope: 'public' });
    const wide = await requestJson(t, 'GET', apiPaths.serverInfo);
    expect(wide.status).toBe(200);
    expect(wide.body.bind_address_scope).toBe('public');
  });

  it('signs up a password user, prioritizes user_token principal, and revokes on logout', async () => {
    t = buildTestApp();

    const signup = await requestJson(t, 'POST', authPaths.signup, {
      email: 'New.User@example.com',
      password: 'correct-password',
      display_name: 'New User',
    });
    expect(signup.status).toBe(200);
    expect(signup.body.user_token).toEqual(expect.any(String));
    expect(signup.body.user).toMatchObject({
      name: 'new-user',
      display_name: 'New User',
    });

    const userRow = t.ctx.db
      .prepare<[string], { id: string; email: string }>(
        `SELECT id, email FROM users WHERE id = ?`,
      )
      .get(signup.body.user.id);
    expect(userRow).toEqual({
      id: signup.body.user.id,
      email: 'new.user@example.com',
    });
    expect(
      t.ctx.db
        .prepare<[string], { c: number }>(
          `SELECT COUNT(*) AS c FROM user_password_credentials WHERE user_id = ?`,
        )
        .get(signup.body.user.id)?.c,
    ).toBe(1);
    expect(
      t.ctx.db
        .prepare<[string], { c: number }>(
          `SELECT COUNT(*) AS c FROM auth_sessions WHERE user_id = ?`,
        )
        .get(signup.body.user.id)?.c,
    ).toBe(1);
    expect(legacyViewerSetting(t)).toBe('local');

    const sessionMe = await requestJson(
      t,
      'GET',
      apiPaths.me,
      undefined,
      bearer(signup.body.user_token),
    );
    expect(sessionMe.status).toBe(200);
    expect(sessionMe.body.id).toBe(signup.body.user.id);

    const legacyMe = await http(t).json(http(t).get(apiPaths.me));
    expect(legacyMe.id).toBe('local');

    const logout = await requestJson(
      t,
      'POST',
      authPaths.logout,
      undefined,
      bearer(signup.body.user_token),
    );
    expect(logout.status).toBe(200);
    expect(logout.body).toEqual({ ok: true });
    expect(legacyViewerSetting(t)).toBe('local');

    const revoked = await requestJson(
      t,
      'GET',
      apiPaths.me,
      undefined,
      bearer(signup.body.user_token),
    );
    expect(revoked.status).toBe(401);
    expect(revoked.body).toEqual({ error: 'unauthorized' });
  });

  it('keeps credential failures uniform for login and duplicate signup', async () => {
    t = buildTestApp();
    const created = await requestJson(t, 'POST', authPaths.signup, {
      email: 'login@example.com',
      password: 'correct-password',
    });
    expect(created.status).toBe(200);
    t.ctx.db
      .prepare(`UPDATE users SET email = 'profile@example.com' WHERE id = 'alice'`)
      .run();

    const ok = await requestJson(t, 'POST', authPaths.login, {
      email: 'LOGIN@example.com',
      password: 'correct-password',
    });
    expect(ok.status).toBe(200);
    expect(ok.body.user.id).toBe(created.body.user.id);
    expect(legacyViewerSetting(t)).toBe('local');

    const duplicateSignup = await requestJson(t, 'POST', authPaths.signup, {
      email: 'login@example.com',
      password: 'different-password',
    });
    const wrongPassword = await requestJson(t, 'POST', authPaths.login, {
      email: 'login@example.com',
      password: 'wrong-password',
    });
    const missingUser = await requestJson(t, 'POST', authPaths.login, {
      email: 'missing@example.com',
      password: 'wrong-password',
    });
    const profileOnly = await requestJson(t, 'POST', authPaths.login, {
      email: 'profile@example.com',
      password: 'wrong-password',
    });

    for (const res of [duplicateSignup, wrongPassword, missingUser, profileOnly]) {
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error_code: 'auth_failed' });
    }
  });

  // Thin route-local schema / bearer guards pinned before the auth carve
  // (#task:983 P17 prep) so the relocation into routes/auth.ts is provably
  // behavior-preserving.
  it('POST /auth/signup with an invalid body is rejected 400', async () => {
    t = buildTestApp();
    const res = await requestJson(t, 'POST', authPaths.signup, {});
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'invalid input' });
  });

  it('POST /auth/login with an invalid body is rejected 400', async () => {
    t = buildTestApp();
    const res = await requestJson(t, 'POST', authPaths.login, {});
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'invalid input' });
  });

  it('POST /auth/logout without a bearer token is rejected 401', async () => {
    t = buildTestApp();
    const res = await requestJson(t, 'POST', authPaths.logout, undefined);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'unauthorized' });
  });
});

function legacyViewerSetting(t: TestApp): string | null {
  return t.ctx.db
    .prepare<[], { value: string }>(
      `SELECT value FROM app_settings WHERE key = 'viewer_user_id'`,
    )
    .get()?.value ?? null;
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function requestJson(
  t: TestApp,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const res = await t.app.fetch(request(method, path, body, headers));
  return { status: res.status, body: await res.json() };
}

async function requestText(
  t: TestApp,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: string }> {
  const res = await t.app.fetch(request(method, path, body));
  return { status: res.status, body: await res.text() };
}

function request(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
