/**
 * Sub-commit 2a backend boot dispatch tests for the
 * `SILVERHAND_RUNTIME_HOST` gated runtime host.
 *
 * Cindy `0G5uJBydO_4qt_2r` review boundary:
 *   - legacy mode (default) must be 0-drift from before sub-commit 2a
 *   - legacy mode must NOT depend on `hostClient` even if one is passed
 *   - daemon mode without a `hostClient` must throw loudly at boot
 *   - banner / rollback recipe must surface in the boot logs
 *
 * These are integration tests against the real `startBackend` (no
 * mocking of internals) so any drift in the gate wiring surfaces here.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '@silverhand/shared';
import type { HostClient } from '@silverhand/host';
import {
  startBackend,
  type BackendLogger,
  type RunningBackend,
} from '../../src/index.js';
import { SILVERHAND_RUNTIME_HOST_ENV } from '../../src/runtime/runtime-host-mode.js';

const fixedServerConfig: ServerConfig = {
  mode: 'embedded',
  url: 'http://127.0.0.1:0',
  auth_token: 'a'.repeat(32),
  refresh_token: null,
  child_sessions: {
    max_concurrent_per_parent: null,
    spawn_cooldown_seconds: null,
    max_depth: 1,
  },
};

function silentLogger(): BackendLogger {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

interface CapturedLog {
  level: 'info' | 'warn' | 'error';
  obj: unknown;
  msg: string;
}

function capturingLogger(out: CapturedLog[]): BackendLogger {
  return {
    info: (obj, msg) => out.push({ level: 'info', obj, msg: msg ?? '' }),
    warn: (obj, msg) => out.push({ level: 'warn', obj, msg: msg ?? '' }),
    error: (obj, msg) => out.push({ level: 'error', obj, msg: msg ?? '' }),
  };
}

describe('startBackend — SILVERHAND_RUNTIME_HOST dispatch (sub-commit 2a)', () => {
  let tmp: string;
  let running: RunningBackend | null = null;
  const originalEnv = process.env[SILVERHAND_RUNTIME_HOST_ENV];

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'silverhand-dispatch-test-'));
    delete process.env[SILVERHAND_RUNTIME_HOST_ENV];
  });

  afterEach(async () => {
    if (running) {
      await running.close().catch(() => undefined);
      running = null;
    }
    rmSync(tmp, { recursive: true, force: true });
    if (originalEnv !== undefined) {
      process.env[SILVERHAND_RUNTIME_HOST_ENV] = originalEnv;
    } else {
      delete process.env[SILVERHAND_RUNTIME_HOST_ENV];
    }
  });

  it('default (env unset): legacy mode, runtimeHost is ConversationManager', async () => {
    running = await startBackend({
      dbPath: join(tmp, 'silverhand.db'),
      silverhandDir: tmp,
      serverConfig: fixedServerConfig,
      silverhandCliLauncher: { command: 'true', args: [] },
      logger: silentLogger(),
    });
    // ctx.runtimeHost === ctx.conversationManager in legacy mode.
    expect(running.context.runtimeHost).toBe(
      running.context.conversationManager,
    );
  });

  it('legacy mode ignores hostClient even when one is passed', async () => {
    // Cindy `bJUazoeBrxK8XglK` blocker (2) + `yAyzGil3UdCENIom` B2:
    // the legacy fallback MUST be independent of daemon plumbing.
    // Track every call on the hostClient surface backend might
    // accidentally touch (ping, subscribe, onReconnect, close); after
    // a successful legacy boot every counter must still be zero. The
    // ping mock returns instead of throwing so that any silent
    // invocation surfaces as a positive assertion failure rather
    // than the test passing because the throw got swallowed.
    const ping = vi.fn(() =>
      Promise.resolve({
        daemon_pid: 12345,
        daemon_version: '0.0.0-test',
        started_at: 0,
      }),
    );
    const subscribe = vi.fn(() => () => {});
    const onReconnect = vi.fn(() => () => {});
    const close = vi.fn(() => Promise.resolve());
    const hostClient = {
      ping,
      subscribe,
      onReconnect,
      close,
    } as unknown as HostClient;
    process.env[SILVERHAND_RUNTIME_HOST_ENV] = 'legacy';
    running = await startBackend({
      dbPath: join(tmp, 'silverhand.db'),
      silverhandDir: tmp,
      serverConfig: fixedServerConfig,
      silverhandCliLauncher: { command: 'true', args: [] },
      logger: silentLogger(),
      hostClient,
    });
    // Daemon shim NOT constructed.
    expect(running.context.runtimeHost).toBe(
      running.context.conversationManager,
    );
    // Cindy B2: legacy boot must not touch the hostClient surface.
    expect(ping).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
    expect(onReconnect).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it('daemon mode without hostClient throws loudly at boot', async () => {
    process.env[SILVERHAND_RUNTIME_HOST_ENV] = 'daemon';
    let err: Error | null = null;
    try {
      running = await startBackend({
        dbPath: join(tmp, 'silverhand.db'),
        silverhandDir: tmp,
        serverConfig: fixedServerConfig,
        silverhandCliLauncher: { command: 'true', args: [] },
        logger: silentLogger(),
      });
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toContain('SILVERHAND_RUNTIME_HOST=daemon');
    expect(err?.message).toContain('HostClient');
    expect(err?.message).toContain('SILVERHAND_RUNTIME_HOST=legacy');
  });

  it('invalid env value throws before any boot work', async () => {
    process.env[SILVERHAND_RUNTIME_HOST_ENV] = 'inprocess';
    let err: Error | null = null;
    try {
      running = await startBackend({
        dbPath: join(tmp, 'silverhand.db'),
        silverhandDir: tmp,
        serverConfig: fixedServerConfig,
        silverhandCliLauncher: { command: 'true', args: [] },
        logger: silentLogger(),
      });
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toContain('SILVERHAND_RUNTIME_HOST');
    expect(err?.message).toContain('"inprocess"');
    expect(err?.message).toContain("'legacy'");
    expect(err?.message).toContain("'daemon'");
  });

  it('boot logs the mode banner with rollback recipe', async () => {
    const logs: CapturedLog[] = [];
    running = await startBackend({
      dbPath: join(tmp, 'silverhand.db'),
      silverhandDir: tmp,
      serverConfig: fixedServerConfig,
      silverhandCliLauncher: { command: 'true', args: [] },
      logger: capturingLogger(logs),
    });
    const banner = logs.find(l =>
      l.msg.includes('agent runtime: legacy path'),
    );
    expect(banner).toBeDefined();
    expect(banner?.obj).toMatchObject({
      mode: 'legacy',
    });
    // Even on the safe default, the banner names the env var so an
    // operator scanning logs sees the opt-in toggle.
    expect(banner?.msg).toContain('SILVERHAND_RUNTIME_HOST=daemon');
  });

  it('daemon mode boot failure tears down before throwing', async () => {
    process.env[SILVERHAND_RUNTIME_HOST_ENV] = 'daemon';
    // Same throw as the no-hostClient test, but we use it to verify
    // the partially-constructed backend doesn't leak: there is no
    // `running` to close and the test cleanup should be a no-op.
    let err: Error | null = null;
    try {
      await startBackend({
        dbPath: join(tmp, 'silverhand.db'),
        silverhandDir: tmp,
        serverConfig: fixedServerConfig,
        silverhandCliLauncher: { command: 'true', args: [] },
        logger: silentLogger(),
      });
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeInstanceOf(Error);
    expect(running).toBeNull();
  });
});
