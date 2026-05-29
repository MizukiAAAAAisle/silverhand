/**
 * D5.a-3 — `spawnDaemonChild` must forward `localOutboundSocketPath` to
 * the daemon child as `--local-outbound-socket-path <abs>`, and omit the
 * flag entirely when the option is not set. This is the desktop → daemon
 * half of the embedded R4 wiring: the daemon binds its local outbound
 * frame server on that path and the embedded backend dials it (same
 * outbound envelope as standalone WSS).
 *
 * Driven entirely through the `SpawnProcessImpl` + `SpawnClock` test
 * seams — no real subprocess. We capture the argv the supervisor would
 * have handed to `node:child_process.spawn` and assert on it.
 */
import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { spawnDaemonChild, type SpawnProcessImpl } from '../src/spawn.js';
import { HOST_PROTOCOL_VERSION } from '../src/protocol.js';
import { wireFixtures } from './fixtures/wire/wire-fixtures.js';

const READY_FIXTURE = wireFixtures.find(f => f.name === 'event/ready');
if (!READY_FIXTURE) throw new Error('expected wireFixtures to include event/ready');
const READY_BASE = JSON.parse(READY_FIXTURE.frame.trim()) as Record<string, unknown>;
if (READY_BASE.protocol_version !== HOST_PROTOCOL_VERSION) {
  throw new Error('wire fixture protocol_version drifted from HOST_PROTOCOL_VERSION');
}

function readyFrame(socketPath: string): string {
  return (
    JSON.stringify({
      ...READY_BASE,
      daemon_version: '0.0.0-test',
      instance_id: 'instance-1',
      socket_path: socketPath,
      daemon_pid: 4242,
    }) + '\n'
  );
}

class FakeStdStream extends EventEmitter {
  setEncoding(): this {
    return this;
  }
}

class FakeChild extends EventEmitter {
  readonly stdout = new FakeStdStream();
  readonly stderr = new FakeStdStream();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  exited = false;
  kill(): boolean {
    return true;
  }
}

async function captureSpawnArgs(
  localOutboundSocketPath?: string | null,
): Promise<readonly string[]> {
  const socketPath = '/tmp/silverhand-fake.sock';
  let captured: readonly string[] = [];
  const child = new FakeChild();
  const spawnImpl: SpawnProcessImpl = (
    _command: string,
    args: ReadonlyArray<string>,
    _options: SpawnOptions,
  ): ChildProcess => {
    captured = args;
    return child as unknown as ChildProcess;
  };
  const pending = spawnDaemonChild({
    launcher: { command: 'fake-node', args: ['fake-entry.js'] },
    socketPath,
    pidFilePath: '/tmp/silverhand-fake.pid',
    logDir: '/tmp/silverhand-fake-logs',
    alsoStderr: false,
    reclaimStaleDaemon: false,
    spawnProcess: spawnImpl,
    ...(localOutboundSocketPath !== undefined ? { localOutboundSocketPath } : {}),
  });
  // Let the supervisor register its stdout listener, then hand it ready.
  await new Promise(resolve => setImmediate(resolve));
  child.stdout.emit('data', readyFrame(socketPath));
  await pending;
  return captured;
}

describe('spawnDaemonChild — local outbound socket arg forwarding (D5.a-3)', () => {
  it('forwards --local-outbound-socket-path when localOutboundSocketPath is set', async () => {
    const args = await captureSpawnArgs('/tmp/silverhand-fake-outbound.sock');
    const idx = args.indexOf('--local-outbound-socket-path');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('/tmp/silverhand-fake-outbound.sock');
  });

  it('omits the flag when localOutboundSocketPath is unset', async () => {
    const args = await captureSpawnArgs(undefined);
    expect(args).not.toContain('--local-outbound-socket-path');
  });

  it('omits the flag when localOutboundSocketPath is explicitly null', async () => {
    const args = await captureSpawnArgs(null);
    expect(args).not.toContain('--local-outbound-socket-path');
  });
});
