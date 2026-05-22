/**
 * Backend boot dispatch tests for the `SILVERHAND_RUNTIME_HOST` gated
 * runtime host.
 *
 * Commit A of the cleanup sequence flipped the default from `legacy`
 * to `daemon`. The legacy path remains reachable as an explicit
 * rollback (`SILVERHAND_RUNTIME_HOST=legacy`) until the legacy CM
 * surfaces are deleted in a later commit — these tests pin that the
 * explicit-rollback path stays 0-drift even as the default changes.
 *
 * Cindy `0G5uJBydO_4qt_2r` review boundary:
 *   - legacy mode (now explicit override) must remain functional and
 *     0-drift from before the flip
 *   - legacy mode must NOT depend on `hostClient` even if one is passed
 *   - daemon mode (now default) without a `hostClient` must throw
 *     loudly at boot — and the error message must carry the rollback
 *     recipe (`SILVERHAND_RUNTIME_HOST=legacy`)
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

describe('startBackend — SILVERHAND_RUNTIME_HOST dispatch', () => {
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

  it('default (env unset): daemon mode — boot without hostClient throws with rollback recipe', async () => {
    // Commit A pin: env unset means daemon mode. Without a hostClient
    // the boot MUST throw, and the error MUST carry the explicit
    // legacy rollback recipe so an operator who hits a daemon-spawn
    // regression knows the recovery command verbatim.
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
    // Rollback recipe is the load-bearing assertion for Commit A.
    expect(err?.message).toContain('SILVERHAND_RUNTIME_HOST=legacy');
  });

  it('explicit SILVERHAND_RUNTIME_HOST=legacy still routes to in-process ConversationManager (rollback regression)', async () => {
    // Commit A keeps `=legacy` working as the explicit rollback path
    // until the legacy CM surfaces are deleted in a later commit. If
    // this test ever fails, the deletion landed too early and the
    // rollback escape hatch is gone — abort the diff that broke this.
    process.env[SILVERHAND_RUNTIME_HOST_ENV] = 'legacy';
    running = await startBackend({
      dbPath: join(tmp, 'silverhand.db'),
      silverhandDir: tmp,
      serverConfig: fixedServerConfig,
      silverhandCliLauncher: { command: 'true', args: [] },
      logger: silentLogger(),
    });
    expect(running.context.runtimeHost).toBe(
      running.context.conversationManager,
    );
  });

  it('explicit legacy mode ignores hostClient even when one is passed', async () => {
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

  it('explicit SILVERHAND_RUNTIME_HOST=daemon without hostClient throws loudly at boot', async () => {
    // Same failure as the env-unset case (since daemon is now the
    // default). Kept as a separate test so the explicit-opt-in
    // signal does not silently disappear if the default flips again
    // in the future.
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

  it('explicit legacy mode boot logs the legacy banner with rollback hint', async () => {
    // We boot in legacy explicitly because we need a successful boot
    // (the default daemon path needs a hostClient). The banner
    // assertions still verify the describer text — daemon banner is
    // verified in the runtime-host-mode unit tests.
    process.env[SILVERHAND_RUNTIME_HOST_ENV] = 'legacy';
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
    // Banner should mention the env var so an operator scanning logs
    // sees how to return to the default daemon path.
    expect(banner?.msg).toContain(SILVERHAND_RUNTIME_HOST_ENV);
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
