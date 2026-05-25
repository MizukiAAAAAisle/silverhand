import { existsSync, readFileSync, statSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { authPaths } from '@silverhand/shared';
import {
  prepareEmbeddedBootstrap,
  type EmbeddedBootstrapState,
} from '../../src/auth/embedded-bootstrap.js';
import { buildTestApp, type TestApp } from '../utils/app.js';

describe('embedded bootstrap auth route', () => {
  let t: TestApp | null = null;

  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('writes the one-shot file before listen and exchanges it for a profile-only session', async () => {
    t = singleUserApp();
    const token = await prepare(t);

    expect(existsSync(t.ctx.embeddedBootstrap.filePath)).toBe(true);
    expect(statSync(t.ctx.embeddedBootstrap.filePath).mode & 0o777).toBe(0o600);

    const res = await postBootstrap(t, { token });
    expect(res.status).toBe(200);
    const body = await res.json() as { user_token: string; user: { id: string } };
    expect(body.user_token).toEqual(expect.any(String));
    expect(body.user.id).toBe('local');
    expect(existsSync(t.ctx.embeddedBootstrap.filePath)).toBe(false);
    expect(
      t.ctx.db
        .prepare<[string], { c: number }>(
          `SELECT COUNT(*) AS c FROM user_password_credentials WHERE user_id = ?`,
        )
        .get(body.user.id)?.c,
    ).toBe(0);
  });

  it('creates a profile-only local user for a fresh DB', async () => {
    t = freshUserApp();
    const token = await prepare(t);

    const res = await postBootstrap(t, { token });
    expect(res.status).toBe(200);
    const body = await res.json() as { user: { id: string; name: string } };
    expect(body.user.name).toBe('local');
    expect(
      t.ctx.db
        .prepare<[], { value: string }>(
          `SELECT value FROM app_settings WHERE key = 'viewer_user_id'`,
        )
        .get()?.value,
    ).toBe(body.user.id);
    expect(
      t.ctx.db
        .prepare<[], { c: number }>(`SELECT COUNT(*) AS c FROM users`)
        .get()?.c,
    ).toBe(1);
    expect(
      t.ctx.db
        .prepare<[], { c: number }>(`SELECT COUNT(*) AS c FROM user_password_credentials`)
        .get()?.c,
    ).toBe(0);
  });

  it('rejects remote mode as a missing route', async () => {
    t = singleUserApp();
    const token = await prepare(t, { mode: 'remote' });

    const res = await postBootstrap(t, { token });
    expect(res.status).toBe(404);
    expect(existsSync(t.ctx.embeddedBootstrap.filePath)).toBe(false);
  });

  it('rejects missing or wrong tokens without consuming the valid token', async () => {
    t = singleUserApp();
    const token = await prepare(t);

    expect((await postBootstrap(t, {})).status).toBe(404);
    expect((await postBootstrap(t, { token: 'wrong-token' })).status).toBe(404);

    const ok = await postBootstrap(t, { token });
    expect(ok.status).toBe(200);
  });

  it('rejects a consumed token on the second use', async () => {
    t = singleUserApp();
    const token = await prepare(t);

    expect((await postBootstrap(t, { token })).status).toBe(200);
    expect((await postBootstrap(t, { token })).status).toBe(404);
  });

  it('rejects stale tokens from a prior backend boot', async () => {
    t = singleUserApp();
    const stale = await prepare(t);
    const current = await prepare(t);

    expect(stale).not.toBe(current);
    expect((await postBootstrap(t, { token: stale })).status).toBe(404);
    expect((await postBootstrap(t, { token: current })).status).toBe(200);
  });

  it('rejects non-loopback callers', async () => {
    t = singleUserApp();
    const token = await prepare(t);

    const res = await postBootstrap(t, { token }, '203.0.113.10');
    expect(res.status).toBe(404);
  });

  it('still works when signup is disabled', async () => {
    t = singleUserApp({ signupEnabled: false });
    const token = await prepare(t);

    const res = await postBootstrap(t, { token });
    expect(res.status).toBe(200);
  });

  it('fails loud instead of choosing a user when multiple users exist', async () => {
    t = buildTestApp();
    const token = await prepare(t);

    const res = await postBootstrap(t, { token });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: 'bootstrap_ambiguous_user',
    });
  });
});

function singleUserApp(opts: { signupEnabled?: boolean } = {}): TestApp {
  const app = buildTestApp({
    authConfig:
      opts.signupEnabled === undefined
        ? undefined
        : { signupEnabled: opts.signupEnabled },
    ownedLocalHostUserIds: ['local'],
  });
  app.ctx.db.prepare(`DELETE FROM users WHERE id <> 'local'`).run();
  return app;
}

function freshUserApp(): TestApp {
  const app = buildTestApp({ ownedLocalHostUserIds: [] });
  app.ctx.db.prepare(`DELETE FROM app_settings WHERE key = 'viewer_user_id'`).run();
  app.ctx.db.prepare(`DELETE FROM users`).run();
  return app;
}

async function prepare(
  app: TestApp,
  opts: { mode?: 'embedded' | 'remote' } = {},
): Promise<string> {
  app.ctx.serverConfig = {
    ...app.ctx.serverConfig,
    mode: opts.mode ?? 'embedded',
  };
  app.ctx.embeddedBootstrap = await prepareEmbeddedBootstrap({
    silverhandDir: app.ctx.silverhandDir,
    serverConfig: app.ctx.serverConfig,
    listenHostname: '127.0.0.1',
    logger: app.ctx.logger,
  }) as EmbeddedBootstrapState;
  if (!app.ctx.embeddedBootstrap.enabled) return 'disabled-token';
  return readFileSync(app.ctx.embeddedBootstrap.filePath, 'utf8').trim();
}

async function postBootstrap(
  app: TestApp,
  body: unknown,
  remoteAddress = '127.0.0.1',
): Promise<Response> {
  return app.app.fetch(
    new Request(`http://127.0.0.1${authPaths.embeddedBootstrap}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    {
      incoming: {
        socket: {
          remoteAddress,
          remotePort: 12345,
          remoteFamily: remoteAddress.includes(':') ? 'IPv6' : 'IPv4',
        },
      },
    } as never,
  );
}
