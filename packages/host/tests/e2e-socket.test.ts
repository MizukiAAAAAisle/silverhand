import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDaemon, type RunningDaemon } from '../src/daemon/index.js';
import { HostClient } from '../src/client/index.js';

/**
 * End-to-end test using a real Unix socket but keeping the daemon in
 * the test process (via `runDaemon`). This validates the SocketTransport
 * path + the actual `node:net` server, while keeping the test fast
 * (~50ms) and free of subprocess flake.
 *
 * The subprocess form (spawnDaemonChild → real `node` child) is
 * covered separately in `spawn-daemon.test.ts`.
 */

interface E2eFixture {
  dir: string;
  socketPath: string;
  pidFilePath: string;
  logDir: string;
  daemon: RunningDaemon;
}

async function setupFixture(): Promise<E2eFixture> {
  const dir = mkdtempSync(join(tmpdir(), 'silverhand-host-e2e-'));
  const socketPath = join(dir, 'daemon.sock');
  const pidFilePath = join(dir, 'daemon.pid');
  const logDir = join(dir, 'logs');
  const daemon = await runDaemon({
    socketPath,
    pidFilePath,
    logDir,
    installSignals: false,
    writeStdoutHandshake: false,
    alsoStderr: false,
  });
  return { dir, socketPath, pidFilePath, logDir, daemon };
}

async function teardown(f: E2eFixture, client?: HostClient): Promise<void> {
  await client?.close();
  await f.daemon.stop('test_done');
  rmSync(f.dir, { recursive: true, force: true });
}

describe('e2e — real Unix socket', () => {
  const fixtures: E2eFixture[] = [];
  const clients: HostClient[] = [];

  afterEach(async () => {
    while (clients.length) await clients.pop()!.close().catch(() => {});
    while (fixtures.length) {
      const f = fixtures.pop()!;
      await f.daemon.stop('test_done').catch(() => {});
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it('client pings the real daemon and gets its pid', async () => {
    const f = await setupFixture();
    fixtures.push(f);
    const client = new HostClient({ socketPath: f.socketPath });
    clients.push(client);
    await client.connect();
    const r = await client.ping();
    expect(r.pong).toBe(true);
    expect(r.daemon_pid).toBe(process.pid);
    expect(r.daemon_version).toMatch(/^\d/);
  });

  it('echo round-trips a payload', async () => {
    const f = await setupFixture();
    fixtures.push(f);
    const client = new HostClient({ socketPath: f.socketPath });
    clients.push(client);
    await client.connect();
    const r = await client.echo('hello daemon');
    expect(r.echoed).toBe('hello daemon');
  });

  it('status reports increasing intent_count', async () => {
    const f = await setupFixture();
    fixtures.push(f);
    const client = new HostClient({ socketPath: f.socketPath });
    clients.push(client);
    await client.connect();
    await client.ping();
    await client.echo('x');
    const s = await client.status();
    expect(s.intent_count).toBeGreaterThanOrEqual(3); // 2 user + status
    expect(s.daemon_pid).toBe(process.pid);
  });

  it('refuses to start a second daemon on the same pid file', async () => {
    const f = await setupFixture();
    fixtures.push(f);
    await expect(
      runDaemon({
        socketPath: join(f.dir, 'other.sock'),
        pidFilePath: f.pidFilePath,
        logDir: f.logDir,
        installSignals: false,
        writeStdoutHandshake: false,
      }),
    ).rejects.toThrow(/already running/);
  });

  it('returns shutting_down errors to in-flight clients after stop', async () => {
    const f = await setupFixture();
    fixtures.push(f);
    const client = new HostClient({
      socketPath: f.socketPath,
      // Block automatic reconnect noise during teardown.
      initialBackoffMs: 1_000_000,
    });
    clients.push(client);
    await client.connect();
    await f.daemon.stop('test_done');
    // Calling immediately after stop: socket is closed → disconnected.
    await expect(client.ping()).rejects.toMatchObject({ code: 'disconnected' });
  });
});
