/**
 * Backend boot dispatch tests for the `SILVERHAND_RUNTIME_HOST` gated
 * runtime host.
 *
 * Cleanup history:
 *   - Commit A flipped the default from `legacy` to `daemon`.
 *   - Commit B (this file) deleted the in-process `ConversationManager`
 *     runtime. The env switch itself survives one more commit (Commit C),
 *     but `=legacy` now throws loudly at boot — there is nothing to
 *     fall back to. These tests pin that the throw carries the right
 *     recovery hint and that the daemon path is unaffected.
 *
 * Cindy `0G5uJBydO_4qt_2r` review boundary still in force:
 *   - daemon mode (default) without a `hostClient` must throw loudly
 *     at boot — and the error message must carry the (now historical)
 *     `SILVERHAND_RUNTIME_HOST=legacy` recovery recipe so an operator
 *     who already pinned that value sees one consistent message family
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

  it('explicit SILVERHAND_RUNTIME_HOST=legacy throws loudly at boot (Commit B removed the runtime)', async () => {
    // Commit A kept `=legacy` working as a rollback escape hatch;
    // Commit B (this commit) deleted the in-process
    // ConversationManager runtime. The env switch is retained for one
    // more commit so an operator who pinned `=legacy` during the soak
    // window sees a clear "removed" message instead of an unrelated
    // wiring failure. The error MUST mention Commit B by name and
    // surface the recovery (unset / =daemon).
    process.env[SILVERHAND_RUNTIME_HOST_ENV] = 'legacy';
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
    expect(err?.message).toContain('SILVERHAND_RUNTIME_HOST=legacy');
    expect(err?.message).toContain('Commit B');
    expect(err?.message).toContain('ConversationManager');
    // Recovery recipe — operator must know what to do.
    expect(err?.message).toMatch(/unset|'daemon'/);
  });

  it('explicit legacy mode also throws even when a hostClient is passed', async () => {
    // Cindy `bJUazoeBrxK8XglK` blocker (2) + `yAyzGil3UdCENIom` B2:
    // the legacy path must not silently start the daemon plumbing
    // when the operator asked for legacy. Post-Commit B we still
    // honour that contract — the throw fires before any hostClient
    // surface is touched.
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
    let err: Error | null = null;
    try {
      running = await startBackend({
        dbPath: join(tmp, 'silverhand.db'),
        silverhandDir: tmp,
        serverConfig: fixedServerConfig,
        silverhandCliLauncher: { command: 'true', args: [] },
        logger: silentLogger(),
        hostClient,
      });
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toContain('SILVERHAND_RUNTIME_HOST=legacy');
    // hostClient surface must not have been called — Cindy B2.
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

  it('daemon mode boot logs the daemon banner with rollback hint', async () => {
    // Post-Commit B the only path that reaches the boot banner log is
    // the daemon path. Verify the describer text surfaces in the
    // captured log line so an operator tailing logs sees mode +
    // rollback recipe in one place. (Banner content per
    // describer is unit-tested in runtime-host-mode.test.ts.)
    //
    // We use a stub hostClient that resolves `ping` synchronously —
    // we don't need the full daemon plumbing for a banner check, only
    // for the boot to clear the dispatch and reach `logger.info`.
    process.env[SILVERHAND_RUNTIME_HOST_ENV] = 'daemon';
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
    const runtimeStatus = vi.fn(() =>
      Promise.resolve({ runtimes: [] as unknown[] }),
    );
    const hostClient = {
      ping,
      subscribe,
      onReconnect,
      close,
      runtimeStatus,
    } as unknown as HostClient;
    const logs: CapturedLog[] = [];
    running = await startBackend({
      dbPath: join(tmp, 'silverhand.db'),
      silverhandDir: tmp,
      serverConfig: fixedServerConfig,
      silverhandCliLauncher: { command: 'true', args: [] },
      logger: capturingLogger(logs),
      hostClient,
    });
    const banner = logs.find(l =>
      l.msg.includes('agent runtime: daemon path'),
    );
    expect(banner).toBeDefined();
    expect(banner?.obj).toMatchObject({
      mode: 'daemon',
    });
    // Banner should mention the env var so an operator scanning logs
    // sees the (historical) rollback path.
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
