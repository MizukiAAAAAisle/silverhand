import { existsSync, readFileSync, statSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { authPaths } from '@silverhand/shared';
import {
  prepareEmbeddedBootstrap,
  type EmbeddedBootstrapState,
} from '../../src/auth/embedded-bootstrap.js';
import { canGovernWorkspace } from '../../src/permissions.js';
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
    const workspaceCount = t.ctx.db
      .prepare<[], { c: number }>(`SELECT COUNT(*) AS c FROM workspaces`)
      .get()?.c ?? 0;
    const conversationCount = t.ctx.db
      .prepare<[], { c: number }>(`SELECT COUNT(*) AS c FROM conversations`)
      .get()?.c ?? 0;
    expect(workspaceCount).toBeGreaterThan(0);
    expect(conversationCount).toBeGreaterThan(0);
    expect(
      t.ctx.db
        .prepare<[string], { c: number }>(
          `SELECT COUNT(*) AS c FROM workspace_users WHERE user_id = ?`,
        )
        .get(body.user.id)?.c,
    ).toBe(workspaceCount);
    expect(
      t.ctx.db
        .prepare<[string], { c: number }>(
          `SELECT COUNT(*) AS c FROM conversation_users WHERE user_id = ?`,
        )
        .get(body.user.id)?.c,
    ).toBe(conversationCount);
    // v40 (graded-permissions): the first registered human is the OWNER
    // of every pre-existing workspace — role + owner pointer, not a plain
    // member. This is the register-path twin of the v40 migration
    // backfill; without it Layer A neutrality breaks (view/post but no
    // govern on pre-user workspaces).
    expect(
      t.ctx.db
        .prepare<[string], { c: number }>(
          `SELECT COUNT(*) AS c FROM workspace_users WHERE user_id = ? AND role != 'owner'`,
        )
        .get(body.user.id)?.c,
    ).toBe(0);
    expect(
      t.ctx.db
        .prepare<[string], { c: number }>(
          `SELECT COUNT(*) AS c FROM workspaces WHERE owner_user_id IS NULL OR owner_user_id != ?`,
        )
        .get(body.user.id)?.c,
    ).toBe(0);
    // …and the governance gate agrees.
    const someWorkspaceId = t.ctx.db
      .prepare<[], { id: string }>(`SELECT id FROM workspaces LIMIT 1`)
      .get()?.id as string;
    expect(
      canGovernWorkspace(
        t.ctx,
        { kind: 'user', userId: body.user.id },
        someWorkspaceId,
        'owner',
      ),
    ).toBe(true);
    expect(
      t.ctx.db
        .prepare<[], { value: string }>(
          `SELECT value FROM app_settings WHERE key = 'viewer_user_id'`,
        )
        .get(),
    ).toBeUndefined();
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
  // Exercise UserService.register's first-user membership backfill.
  const host = app.ctx.db
    .prepare<[], { id: string }>(`SELECT id FROM hosts WHERE name = 'local'`)
    .get();
  if (!host) throw new Error('local host missing from test DB');
  const now = Date.now();
  const workspacePath = `${app.ctx.workspacesRoot}/pre-user-bootstrap`;
  app.ctx.db
    .prepare<[string, string, number, number]>(
      `INSERT INTO workspaces
       (id, name, description, workspace_kind, workspace_path, workspace_host_id,
        owner_agent_id, archived_at, created_at, updated_at)
       VALUES ('pre-user-bootstrap', 'pre-user-bootstrap', NULL, 'regular',
               ?, ?, NULL, NULL, ?, ?)`,
    )
    .run(workspacePath, host.id, now, now);
  app.ctx.db
    .prepare<[string, number, number]>(
      `INSERT INTO conversations
       (id, workspace_id, workspace_path, kind,
        title, status, spawned_by_agent_id, closed_at, close_summary,
        pinned_at, created_at, updated_at)
       VALUES ('pre-user-bootstrap-channel', 'pre-user-bootstrap', ?,
               'channel', 'pre-user-bootstrap', 'idle', NULL,
               NULL, NULL, NULL, ?, ?)`,
    )
    .run(workspacePath, now, now);
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
