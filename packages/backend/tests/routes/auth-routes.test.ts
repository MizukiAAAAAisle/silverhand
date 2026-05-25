import { afterEach, describe, expect, it } from 'vitest';
import { apiPaths, authPaths } from '@silverhand/shared';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

describe('auth routes', () => {
  let t: TestApp | null = null;

  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('exposes immutable server info and hides disabled signup as a missing route', async () => {
    t = buildTestApp({ authConfig: { signupEnabled: false } });

    const info = await requestJson(t, 'GET', apiPaths.serverInfo);
    expect(info.status).toBe(200);
    expect(info.body).toEqual({ signup_enabled: false });

    const disabled = await requestText(t, 'POST', authPaths.signup, {
      email: 'closed@example.com',
      password: 'correct-password',
    });
    const missing = await requestText(t, 'POST', '/auth/not-a-route', {
      email: 'closed@example.com',
      password: 'correct-password',
    });
    expect(disabled.status).toBe(404);
    expect(disabled).toEqual(missing);
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
