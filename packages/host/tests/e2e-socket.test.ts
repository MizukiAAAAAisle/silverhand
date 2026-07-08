import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
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
  const runtimePidRootDir = join(dir, 'runtime-pids');
  const daemon = await runDaemon({
    socketPath,
    pidFilePath,
    logDir,
    runtimePidRootDir,
    installSignals: false,
    writeStdoutHandshake: false,
    alsoStderr: false,
    // PR-1 surface only (ping/status/echo) — runtime_* intents are
    // out of scope here. Explicit `null` opts out of the required-but-
    // nullable supervisorFactory contract (Cindy `XuKGmdna3GWZcY2G` +
    // shiki `Go9ZiB4OnwTbELZU`): "no supervisor here" must be a typed
    // decision, never accidental absence.
    supervisorFactory: null,
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
        runtimePidRootDir: join(f.dir, 'other-runtime-pids'),
        installSignals: false,
        writeStdoutHandshake: false,
        supervisorFactory: null,
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

  it('malformed JSON frame is logged with structured fields only — raw line never lands in JSONL (Cindy `9rxtrdT2NXfX2zEs`)', async () => {
    // §3.4 contract: the malformed-frame path in DaemonServer.handleLine
    // cannot use zod (JSON.parse already failed), so the raw line is
    // the only debug info available — which means it can carry stdin
    // / payload bytes for any frame that happens to be malformed.
    // Verify the log line carries `line_bytes` + `parse_error` only,
    // and that the SECRET token embedded in the bad frame never
    // appears anywhere in the JSONL.
    const f = await setupFixture();
    const logPath = f.daemon.logger.filePath;
    const SECRET = 'LEAK-FROM-MALFORMED-FRAME-AAAAA';
    // Craft a line that's syntactically invalid JSON (trailing `}` →
    // `{`) but carries the secret in the payload position.
    const bad = `{"id":"x","intent":"runtime_deliver","params":{"payload":"${SECRET}"}{\n`;
    await new Promise<void>((resolve, reject) => {
      const sock = createConnection(f.socketPath);
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error('timed out waiting for daemon ack'));
      }, 2000);
      sock.on('connect', () => {
        sock.write(bad, () => {
          // Give the daemon one event-loop tick to consume the bytes,
          // log the malformed-frame line, and destroy the conn — then
          // we tear down our own side and stop waiting.
          setTimeout(() => {
            clearTimeout(timer);
            sock.destroy();
            resolve();
          }, 100);
        });
      });
      sock.on('error', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    // Stop the daemon so the logger drains its write stream.
    await f.daemon.stop('test_done').catch(() => {});
    const raw = readFileSync(logPath, 'utf8');
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain('"line"');
    const lines = raw
      .split('\n')
      .filter(l => l.length > 0)
      .map(l => JSON.parse(l) as Record<string, unknown>);
    const malformed = lines.find(
      l =>
        l.kind === 'connection' &&
        (l as { action?: string }).action === 'frame_parse_failed',
    );
    expect(malformed).toBeDefined();
    // splitNdjson strips the trailing newline before passing the line
    // to JSON.parse, so the logged byte count is `bad` minus the `\n`.
    expect(malformed!.line_bytes).toBe(
      Buffer.byteLength(bad, 'utf8') - 1,
    );
    expect(typeof malformed!.parse_error).toBe('string');
    rmSync(f.dir, { recursive: true, force: true });
  });
});
