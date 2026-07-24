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
  opts: {
    localOutboundSocketPath?: string | null;
    runtimePidRootDir?: string | null;
    agentHomeRootDir?: string | null;
    workspaceDataRootDir?: string | null;
    controlPlaneServerUrlPath?: string | null;
  } = {},
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
    ...(opts.localOutboundSocketPath !== undefined
      ? { localOutboundSocketPath: opts.localOutboundSocketPath }
      : {}),
    ...(opts.runtimePidRootDir !== undefined
      ? { runtimePidRootDir: opts.runtimePidRootDir }
      : {}),
    ...(opts.agentHomeRootDir !== undefined
      ? { agentHomeRootDir: opts.agentHomeRootDir }
      : {}),
    ...(opts.workspaceDataRootDir !== undefined
      ? { workspaceDataRootDir: opts.workspaceDataRootDir }
      : {}),
    ...(opts.controlPlaneServerUrlPath !== undefined
      ? { controlPlaneServerUrlPath: opts.controlPlaneServerUrlPath }
      : {}),
  });
  // Let the supervisor register its stdout listener, then hand it ready.
  await new Promise(resolve => setImmediate(resolve));
  child.stdout.emit('data', readyFrame(socketPath));
  await pending;
  return captured;
}

describe('spawnDaemonChild — local outbound socket arg forwarding (D5.a-3)', () => {
  it('forwards --local-outbound-socket-path when localOutboundSocketPath is set', async () => {
    const args = await captureSpawnArgs({
      localOutboundSocketPath: '/tmp/silverhand-fake-outbound.sock',
    });
    const idx = args.indexOf('--local-outbound-socket-path');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('/tmp/silverhand-fake-outbound.sock');
  });

  it('omits the flag when localOutboundSocketPath is unset', async () => {
    const args = await captureSpawnArgs();
    expect(args).not.toContain('--local-outbound-socket-path');
  });

  it('omits the flag when localOutboundSocketPath is explicitly null', async () => {
    const args = await captureSpawnArgs({ localOutboundSocketPath: null });
    expect(args).not.toContain('--local-outbound-socket-path');
  });

  it('forwards --runtime-pid-root-dir when runtimePidRootDir is set', async () => {
    const args = await captureSpawnArgs({
      runtimePidRootDir: '/tmp/silverhand-fake-runtime-pids',
    });
    const idx = args.indexOf('--runtime-pid-root-dir');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('/tmp/silverhand-fake-runtime-pids');
  });

  it('omits --runtime-pid-root-dir when runtimePidRootDir is unset or null', async () => {
    const unsetArgs = await captureSpawnArgs();
    expect(unsetArgs).not.toContain('--runtime-pid-root-dir');

    const nullArgs = await captureSpawnArgs({ runtimePidRootDir: null });
    expect(nullArgs).not.toContain('--runtime-pid-root-dir');
  });

  it('forwards --agent-home-root-dir when agentHomeRootDir is set', async () => {
    const args = await captureSpawnArgs({
      agentHomeRootDir: '/tmp/silverhand-fake-agent-home-root',
    });
    const idx = args.indexOf('--agent-home-root-dir');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('/tmp/silverhand-fake-agent-home-root');
  });

  it('omits --agent-home-root-dir when agentHomeRootDir is unset or null', async () => {
    const unsetArgs = await captureSpawnArgs();
    expect(unsetArgs).not.toContain('--agent-home-root-dir');

    const nullArgs = await captureSpawnArgs({ agentHomeRootDir: null });
    expect(nullArgs).not.toContain('--agent-home-root-dir');
  });

  it('forwards --workspace-data-root-dir when workspaceDataRootDir is set (#task:1596)', async () => {
    const args = await captureSpawnArgs({
      workspaceDataRootDir: '/tmp/silverhand-fake-workspace-data',
    });
    const idx = args.indexOf('--workspace-data-root-dir');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('/tmp/silverhand-fake-workspace-data');
  });

  it('omits --workspace-data-root-dir when unset or null', async () => {
    const unsetArgs = await captureSpawnArgs();
    expect(unsetArgs).not.toContain('--workspace-data-root-dir');

    const nullArgs = await captureSpawnArgs({ workspaceDataRootDir: null });
    expect(nullArgs).not.toContain('--workspace-data-root-dir');
  });

  it('forwards --control-plane-server-url-path when set', async () => {
    const args = await captureSpawnArgs({
      controlPlaneServerUrlPath: '/tmp/silverhand-control-plane-url',
    });
    const idx = args.indexOf('--control-plane-server-url-path');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('/tmp/silverhand-control-plane-url');
  });

  it('omits --control-plane-server-url-path when unset or null', async () => {
    const unsetArgs = await captureSpawnArgs();
    expect(unsetArgs).not.toContain('--control-plane-server-url-path');

    const nullArgs = await captureSpawnArgs({
      controlPlaneServerUrlPath: null,
    });
    expect(nullArgs).not.toContain('--control-plane-server-url-path');
  });
});
