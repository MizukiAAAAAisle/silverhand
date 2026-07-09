import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { apiPaths, authPaths } from '@silverhand/shared';
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
    expect(resolved.eventWsAllowedOrigins).toEqual({
      value: [],
      source: 'default',
    });

    expect(resolveStandaloneServerEnv({ SILVERHAND_MIGRATE: '1' }).migrate).toEqual({
      value: true,
      source: 'env',
    });
  });

  it('resolves deployment-aware migration defaults', () => {
    expect(resolveMigrationEnv({})).toEqual({
      value: false,
      source: 'default',
    });
    expect(resolveMigrationEnv({}, DEFAULT_EMBEDDED_SILVERHAND_MIGRATE)).toEqual({
      value: true,
      source: 'default',
    });
    expect(resolveEmbeddedMigrationEnv({})).toEqual({
      value: true,
      source: 'default',
    });
    expect(
      resolveEmbeddedMigrationEnv({ SILVERHAND_MIGRATE: '0' }),
    ).toEqual({
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
      resolveStandaloneServerEnv({ SILVERHAND_EVENT_WS_ALLOWED_ORIGINS: ' , ' }),
    ).toThrow(ServerEnvConfigError);
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

  // D4.c/D4.d/D4.e rewrite of the original D1/G1 test
  // ("supports signup, workspace creation, and human messages without
  //  a host runtime"). That story is obsolete: placement is now
  // unified across deployment modes, so BOTH agent and workspace
  // creation resolve an owning host first — and workspace creation is
  // daemon-mediated (`workspace_provision` dispatched to the owning
  // daemon). A bare standalone server with no claimed host (and no
  // attached daemon) is therefore a pure auth/control surface: signup
  // and runtime detection answer, but any resource that needs a host
  // fails fast with a typed `local_host_unbound` 409. Human-message
  // coverage moved to the backend e2e suites (which attach a daemon);
  // it cannot exist here because there is no workspace to post into.
  it('standalone server with no claimed host: signup answers; agent + workspace creation fail-fast typed', async () => {
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
          display_name: 'User',
        }),
        headers: { 'content-type': 'application/json' },
      });
      expect(signup.status).toBe(200);
      const session = await signup.json() as { user_token: string };

      const runtimes = await fetch(`${running.url}${apiPaths.runtimes}`, {
        headers: { authorization: `Bearer ${session.user_token}` },
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
          authorization: `Bearer ${session.user_token}`,
          'content-type': 'application/json',
          'Idempotency-Key': 'config-test-standalone-agent',
        },
      });
      expect(agentCreate.status).toBe(409);
      expect(await agentCreate.json()).toMatchObject({
        code: 'local_host_unbound',
      });

      // D4.c C3: workspace creation runs the SAME unified placement
      // (`resolveCreateHostId` → `resolveOwnedLocalForUser`). The
      // pre-D4.c synthesized `STANDALONE_SERVER` placeholder host is
      // gone, so with no claimed host this also fails fast typed —
      // the old "control-plane builds a workspace without a host" 201
      // is no longer reachable.
      const workspace = await fetch(`${running.url}${apiPaths.workspaces}`, {
        method: 'POST',
        body: JSON.stringify({ name: 'remote_control_plane' }),
        headers: {
          authorization: `Bearer ${session.user_token}`,
          'content-type': 'application/json',
        },
      });
      expect(workspace.status).toBe(409);
      expect(await workspace.json()).toMatchObject({
        code: 'local_host_unbound',
      });
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
