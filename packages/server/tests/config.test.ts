import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  apiPaths,
  authPaths,
  DESKTOP_API_EPOCH_HEADER,
  DESKTOP_SERVER_API_EPOCH,
} from '@silverhand/shared';

/**
 * relocation-v1 §6 raised `MINIMUM_CLIENT_API_EPOCH` to the current epoch, so
 * every non-exempt `/api/*` request must stamp the admission header a real
 * desktop stamps — an epoch-less caller is the refused pre-epoch generation
 * (426) and never reaches the route semantics these tests pin.
 */
const CURRENT_DESKTOP_EPOCH_HEADERS: Record<string, string> = {
  [DESKTOP_API_EPOCH_HEADER]: String(DESKTOP_SERVER_API_EPOCH),
};
import {
  DEFAULT_EMBEDDED_SILVERHAND_MIGRATE,
  DEFAULT_SILVERHAND_DATA_DIR,
  resolveStandaloneServerEnv,
  resolveEmbeddedMigrationEnv,
  resolveMigrationEnv,
  ServerEnvConfigError,
  startStandaloneSilverhandServer,
} from '../src/index.js';

const tmpDirs: string[] = [];
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as new (path: string) => {
  pragma(sql: string): unknown;
  exec(sql: string): void;
  close(): void;
};

afterEach(async () => {
  await Promise.all(
    tmpDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })),
  );
});

describe('standalone server env config', () => {
  it('resolves documented defaults', () => {
    const resolved = resolveStandaloneServerEnv({});

    expect(resolved.listen).toEqual({
      value: { hostname: '127.0.0.1', port: 8080 },
      source: 'default',
    });
    expect(resolved.dataDir).toEqual({
      value: DEFAULT_SILVERHAND_DATA_DIR,
      source: 'default',
    });
    expect(resolved.disableSignup).toEqual({ value: false, source: 'default' });
    expect(resolved.logLevel).toEqual({ value: 'info', source: 'default' });
    expect(resolved.migrate).toEqual({
      value: false,
      source: 'default',
    });
    expect(resolved.metricsListen).toEqual({ value: null, source: 'default' });
    expect(resolved.eventWsAllowedOrigins).toEqual({
      value: [],
      source: 'default',
    });

    expect(
      resolveStandaloneServerEnv({ SILVERHAND_MIGRATE: '1' }).migrate,
    ).toEqual({
      value: true,
      source: 'env',
    });
  });

  it('resolves deployment-aware migration defaults', () => {
    expect(resolveMigrationEnv({})).toEqual({
      value: false,
      source: 'default',
    });
    expect(
      resolveMigrationEnv({}, DEFAULT_EMBEDDED_SILVERHAND_MIGRATE),
    ).toEqual({
      value: true,
      source: 'default',
    });
    expect(resolveEmbeddedMigrationEnv({})).toEqual({
      value: true,
      source: 'default',
    });
    expect(resolveEmbeddedMigrationEnv({ SILVERHAND_MIGRATE: '0' })).toEqual({
      value: false,
      source: 'env',
    });
  });

  it('validates env values before boot', () => {
    expect(() =>
      resolveStandaloneServerEnv({ SILVERHAND_LISTEN: '127.0.0.1' }),
    ).toThrow(ServerEnvConfigError);
    expect(() =>
      resolveStandaloneServerEnv({ SILVERHAND_DATA_DIR: 'relative' }),
    ).toThrow(ServerEnvConfigError);
    expect(() =>
      resolveStandaloneServerEnv({ SILVERHAND_DISABLE_SIGNUP: 'true' }),
    ).toThrow(ServerEnvConfigError);
    expect(() =>
      resolveStandaloneServerEnv({ SILVERHAND_LOG_LEVEL: 'trace' }),
    ).toThrow(ServerEnvConfigError);
    expect(() =>
      resolveStandaloneServerEnv({ SILVERHAND_MIGRATE: 'true' }),
    ).toThrow(ServerEnvConfigError);
    expect(() =>
      resolveStandaloneServerEnv({ SILVERHAND_METRICS_LISTEN: '0.0.0.0:9464' }),
    ).toThrow(ServerEnvConfigError);
    expect(() =>
      resolveStandaloneServerEnv({
        SILVERHAND_EVENT_WS_ALLOWED_ORIGINS: 'wss://example.test',
      }),
    ).toThrow(ServerEnvConfigError);
    expect(() =>
      resolveStandaloneServerEnv({
        SILVERHAND_EVENT_WS_ALLOWED_ORIGINS: 'https://example.test/ws',
      }),
    ).toThrow(ServerEnvConfigError);
    // set-but-empty (only separators / blanks) is a misconfiguration
    expect(() =>
      resolveStandaloneServerEnv({
        SILVERHAND_EVENT_WS_ALLOWED_ORIGINS: ' , ',
      }),
    ).toThrow(ServerEnvConfigError);
  });

  it('accepts only an explicit loopback metrics listener', () => {
    expect(
      resolveStandaloneServerEnv({
        SILVERHAND_METRICS_LISTEN: '127.0.0.1:9464',
      }).metricsListen,
    ).toEqual({
      value: { hostname: '127.0.0.1', port: 9464 },
      source: 'env',
    });
  });

  it('resolves the event-WS Origin allowlist (comma-separated, reverse-proxy origins)', () => {
    const resolved = resolveStandaloneServerEnv({
      SILVERHAND_EVENT_WS_ALLOWED_ORIGINS:
        'https://proxy.example.test/, https://alt.example.test',
    });

    expect(resolved.eventWsAllowedOrigins).toEqual({
      value: ['https://proxy.example.test', 'https://alt.example.test'],
      source: 'env',
    });
  });

  it('boots standalone in control-plane mode without embedded bootstrap', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'silverhand-server-test-'));
    tmpDirs.push(dataDir);

    const running = await startStandaloneSilverhandServer({
      env: {
        SILVERHAND_LISTEN: '127.0.0.1:0',
        SILVERHAND_DATA_DIR: dataDir,
        SILVERHAND_DISABLE_SIGNUP: '1',
        SILVERHAND_LOG_LEVEL: 'warn',
        SILVERHAND_METRICS_LISTEN: '127.0.0.1:0',
        SILVERHAND_EVENT_WS_ALLOWED_ORIGINS: 'https://proxy.example.test/',
      },
    });
    try {
      expect(running.context.deploymentMode).toBe('standalone');
      expect(running.context.serverConfig.mode).toBe('remote');
      expect(running.context.serverConfig.event_ws_allowed_origins).toEqual([
        'https://proxy.example.test',
      ]);
      // The server's identity URL is its bind address — it does NOT know its
      // public origin. So `serverConfig.url` equals the actually-bound URL.
      expect(running.context.serverConfig.url).toBe(running.url);
      expect(running.context.embeddedBootstrap.enabled).toBe(false);

      const health = await fetch(`${running.url}/api/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ ok: true, mode: 'remote' });

      const ready = await fetch(`${running.url}/readyz`);
      expect(ready.status).toBe(200);
      expect(await ready.json()).toMatchObject({
        ok: true,
        mode: 'remote',
        deployment_mode: 'standalone',
        checks: {
          migrations_applied: true,
          listen_ready: true,
          db_writable: true,
        },
      });

      await fetch(`${running.url}/api/hosts/some-host/status`, {
        headers: { ...CURRENT_DESKTOP_EPOCH_HEADERS },
      });

      expect(running.metricsUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const metrics = await fetch(`${running.metricsUrl}/metrics`);
      expect(metrics.status).toBe(200);
      const metricsBody = await metrics.text();
      expect(metricsBody).toContain(
        'silverhand_http_request_duration_seconds_bucket',
      );
      expect(metricsBody).toContain('route="/readyz"');
      expect(metricsBody).not.toContain('/api/hosts/some-host');
      const publicMetrics = await fetch(`${running.url}/metrics`);
      expect(publicMetrics.status).not.toBe(200);
      expect(await publicMetrics.text()).not.toContain(
        'silverhand_http_request_duration_seconds',
      );

      const bootstrap = await fetch(`${running.url}/auth/embedded-bootstrap`, {
        method: 'POST',
        body: JSON.stringify({ token: 'unused' }),
        headers: { 'content-type': 'application/json' },
      });
      expect(bootstrap.status).toBe(404);
    } finally {
      await running.close();
    }
  });

  // D4.c/D4.d/D4.e rewrite of the original D1/G1 test, re-split by
  // relocation-v1 §7-4. Placement is unified across deployment modes, but the
  // two resources no longer share a placement question:
  //   - AGENT creation really does pick a computer, so with no claimed host it
  //     still fails fast with a typed `local_host_unbound` 409;
  //   - WORKSPACE creation resolves NO host at all — a regular workspace has no
  //     owning computer and no daemon-mediated provision step — so on a bare
  //     standalone server it SUCCEEDS. The old 409 here was placement debt, and
  //     this is the network-level twin of the in-process pin in
  //     `backend/tests/routes/workspace-placement-preflight.test.ts`.
  // Human-message coverage moved to the backend e2e suites (which attach a
  // daemon): a channel needs a member agent, which needs a computer.
  it('standalone server with no claimed host: signup answers; AGENT creation fails fast typed, WORKSPACE creation succeeds (§7-4)', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'silverhand-server-test-'));
    tmpDirs.push(dataDir);

    const running = await startStandaloneSilverhandServer({
      env: {
        SILVERHAND_LISTEN: '127.0.0.1:0',
        SILVERHAND_DATA_DIR: dataDir,
        SILVERHAND_LOG_LEVEL: 'warn',
      },
    });
    try {
      const signup = await fetch(`${running.url}${authPaths.signup}`, {
        method: 'POST',
        body: JSON.stringify({
          email: 'user@example.com',
          password: 'password123',
          name: 'user-one',
          display_name: 'User',
        }),
        headers: { 'content-type': 'application/json' },
      });
      expect(signup.status).toBe(200);
      const session = (await signup.json()) as { user_token: string };

      const runtimes = await fetch(`${running.url}${apiPaths.runtimes}`, {
        headers: {
          ...CURRENT_DESKTOP_EPOCH_HEADERS,
          authorization: `Bearer ${session.user_token}`,
        },
      });
      expect(runtimes.status).toBe(503);
      expect(await runtimes.json()).toMatchObject({
        code: 'host_runtime_disabled',
      });

      // D4.d D3: `POST /api/agents` is now the materialization
      // lifecycle route (the pre-D4 standalone `host_runtime_disabled`
      // short-circuit is gone; handlers no longer fork by deployment
      // mode — R4 invariant). Two contract changes this pins:
      //   1. the route REQUIRES an `Idempotency-Key` header (else 400
      //      `idempotency_key_missing`), and
      //   2. with no claimed host, unified placement
      //      (`resolveOwnedLocalForUser`) fails fast → 409
      //      `local_host_unbound`, NOT the old 409 `host_runtime_disabled`.
      const agentCreate = await fetch(`${running.url}${apiPaths.agents}`, {
        method: 'POST',
        body: JSON.stringify({ name: 'standalone_agent', runtime: 'codex' }),
        headers: {
          ...CURRENT_DESKTOP_EPOCH_HEADERS,
          authorization: `Bearer ${session.user_token}`,
          'content-type': 'application/json',
          'Idempotency-Key': 'config-test-standalone-agent',
        },
      });
      expect(agentCreate.status).toBe(409);
      expect(await agentCreate.json()).toMatchObject({
        code: 'local_host_unbound',
      });

      // relocation-v1 §7-4: workspace creation resolves no host, writes no host
      // column and dispatches no provision command, so "no claimed host" is not
      // a question it can fail on. Pinning the 201 here (not just in-process)
      // is what proves the retirement holds through the real HTTP stack of a
      // bare standalone server.
      const workspace = await fetch(`${running.url}${apiPaths.workspaces}`, {
        method: 'POST',
        body: JSON.stringify({ name: 'remote_control_plane' }),
        headers: {
          ...CURRENT_DESKTOP_EPOCH_HEADERS,
          authorization: `Bearer ${session.user_token}`,
          'content-type': 'application/json',
        },
      });
      expect(workspace.status).toBe(201);
      const workspaceBody = (await workspace.json()) as {
        workspace: Record<string, unknown>;
      };
      // No owning-computer pointer survives on the DTO (§7-3/§7-4 dropped both
      // `workspace_path` and `workspace_host_id`).
      expect('workspace_host_id' in workspaceBody.workspace).toBe(false);
      expect('workspace_path' in workspaceBody.workspace).toBe(false);
    } finally {
      await running.close();
    }
  });

  it('fails fast when startup cannot acquire the migration lock', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'silverhand-server-test-'));
    tmpDirs.push(dataDir);
    const env = {
      SILVERHAND_LISTEN: '127.0.0.1:0',
      SILVERHAND_DATA_DIR: dataDir,
      SILVERHAND_LOG_LEVEL: 'warn',
    };
    const initialized = await startStandaloneSilverhandServer({ env });
    await initialized.close();

    const lockDb = new Database(join(dataDir, 'silverhand.db'));
    lockDb.pragma('journal_mode = WAL');
    lockDb.pragma('busy_timeout = 0');
    lockDb.exec('BEGIN EXCLUSIVE');
    try {
      await expect(startStandaloneSilverhandServer({ env })).rejects.toThrow(
        /database is locked|SQLITE_BUSY/i,
      );
    } finally {
      lockDb.exec('ROLLBACK');
      lockDb.close();
    }
  });
});
