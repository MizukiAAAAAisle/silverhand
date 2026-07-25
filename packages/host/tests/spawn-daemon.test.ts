import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { spawnDaemonChild, type DaemonHandle } from '../src/spawn.js';
import { HostClient } from '../src/client/index.js';

/**
 * End-to-end test for `spawnDaemonChild` — really forks a child `node`
 * process running `daemon/entry.ts` via tsx, waits for its `ready`
 * handshake, talks to it over the socket, then kills it.
 *
 * Why this is its own file (not merged with e2e-socket.test.ts):
 *
 *  - It pays the cost of spawning a real subprocess (~200ms each). Keep
 *    the in-process e2e suite fast for the common edit-loop.
 *  - It depends on `tsx` being available (it is — backend uses it for
 *    its own dev runs). If tsx ever disappears from devDependencies,
 *    this is the file that breaks.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, '..');
const TSX_BIN = join(PACKAGE_ROOT, 'node_modules', '.bin', 'tsx');
const DAEMON_ENTRY = resolve(HERE, '../src/daemon/entry.ts');

describe('e2e — spawnDaemonChild subprocess', () => {
  const cleanup: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanup.length) {
      const fn = cleanup.pop();
      try { await fn?.(); } catch { /* ignore */ }
    }
  });

  it('spawns a real daemon, pings it, then SIGTERMs it cleanly', async () => {
    if (!existsSync(TSX_BIN)) {
      // tsx not installed locally — skip rather than fail the suite.
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), 'silverhand-host-spawn-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const socketPath = join(dir, 'daemon.sock');
    const pidFilePath = join(dir, 'daemon.pid');
    const logDir = join(dir, 'logs');
    const homeDir = join(dir, 'home');

    let handle: DaemonHandle | null = null;
    handle = await spawnDaemonChild({
      launcher: {
        command: TSX_BIN,
        args: [DAEMON_ENTRY],
        env: { HOME: homeDir },
      },
      socketPath,
      pidFilePath,
      logDir,
      // #task:1613 — ride the existing subprocess boot to prove the FULL
      // production observation chain: spawn argv → entry parse → runDaemon
      // → handshake capabilities (asserted on the client below).
      layoutMigrationOutcome: 'migrated',
      alsoStderr: false,
      maxRestarts: 0,        // disable auto-restart for this test
      restartWindowMs: 1_000,
      readyTimeoutMs: 10_000,
    });
    cleanup.push(() => handle!.kill());
    expect(handle.pid).toBeGreaterThan(0);
    expect(handle.socketPath).toBe(socketPath);
    expect(existsSync(pidFilePath)).toBe(true);

    const client = new HostClient({ socketPath });
    cleanup.push(() => client.close());
    await client.connect();
    const ping = await client.ping();
    expect(ping.daemon_pid).toBe(handle.pid);
    expect(ping.pong).toBe(true);
    expect(client.capabilities.has('layout_migration.v2.migrated')).toBe(true);
    expect(client.capabilities.has('layout_migration.v2.already_current')).toBe(false);

    await client.close();
    await handle.kill({ gracefulMs: 2_000 });
    // pid file released on clean shutdown.
    expect(existsSync(pidFilePath)).toBe(false);
  }, 20_000);
});
