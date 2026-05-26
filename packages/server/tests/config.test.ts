import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { apiPaths, authPaths } from '@silverhand/shared';
import {
  DEFAULT_SILVERHAND_DATA_DIR,
  resolveStandaloneServerEnv,
  ServerEnvConfigError,
  startStandaloneSilverhandServer,
} from '../src/index.js';

const tmpDirs: string[] = [];

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
      },
    });
    try {
      expect(running.context.deploymentMode).toBe('standalone');
      expect(running.context.serverConfig.mode).toBe('remote');
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

  it('supports signup, workspace creation, and human messages without a host runtime', async () => {
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

      const agentCreate = await fetch(`${running.url}${apiPaths.agents}`, {
        method: 'POST',
        body: JSON.stringify({ name: 'standalone_agent', runtime: 'codex' }),
        headers: {
          authorization: `Bearer ${session.user_token}`,
          'content-type': 'application/json',
        },
      });
      expect(agentCreate.status).toBe(409);
      expect(await agentCreate.json()).toMatchObject({
        code: 'host_runtime_disabled',
      });

      const workspace = await fetch(`${running.url}${apiPaths.workspaces}`, {
        method: 'POST',
        body: JSON.stringify({ name: 'remote_control_plane' }),
        headers: {
          authorization: `Bearer ${session.user_token}`,
          'content-type': 'application/json',
        },
      });
      expect(workspace.status).toBe(201);
      const workspaceBody = await workspace.json() as {
        channel: { id: string };
        workspace: { workspace_host_id: string };
      };
      expect(workspaceBody.workspace.workspace_host_id).toBeTruthy();

      const message = await fetch(
        `${running.url}${apiPaths.channelMessages(workspaceBody.channel.id)}`,
        {
          method: 'POST',
          body: JSON.stringify({ content: 'hello from standalone' }),
          headers: {
            authorization: `Bearer ${session.user_token}`,
            'content-type': 'application/json',
          },
        },
      );
      expect(message.status).toBe(201);
      expect(await message.json()).toMatchObject({
        message: { content: 'hello from standalone' },
      });
    } finally {
      await running.close();
    }
  });
});
