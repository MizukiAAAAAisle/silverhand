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
    computersRootDir?: string | null;
    silverhandStateRootDir?: string | null;
    daemonIdentityPath?: string | null;
    controlPlaneServerUrlPath?: string | null;
    layoutMigrationOutcome?: 'migrated' | 'already_current' | null;
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
    ...(opts.computersRootDir !== undefined
      ? { computersRootDir: opts.computersRootDir }
      : {}),
    ...(opts.silverhandStateRootDir !== undefined
      ? { silverhandStateRootDir: opts.silverhandStateRootDir }
      : {}),
    ...(opts.daemonIdentityPath !== undefined
      ? { daemonIdentityPath: opts.daemonIdentityPath }
      : {}),
    ...(opts.controlPlaneServerUrlPath !== undefined
      ? { controlPlaneServerUrlPath: opts.controlPlaneServerUrlPath }
      : {}),
    ...(opts.layoutMigrationOutcome !== undefined
      ? { layoutMigrationOutcome: opts.layoutMigrationOutcome }
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

  it('forwards --computers-root-dir when computersRootDir is set (#task:1608)', async () => {
    const args = await captureSpawnArgs({
      computersRootDir: '/tmp/silverhand-fake-computers-root',
    });
    const idx = args.indexOf('--computers-root-dir');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('/tmp/silverhand-fake-computers-root');
  });

  it('omits --computers-root-dir when computersRootDir is unset or null', async () => {
    const unsetArgs = await captureSpawnArgs();
    expect(unsetArgs).not.toContain('--computers-root-dir');

    const nullArgs = await captureSpawnArgs({ computersRootDir: null });
    expect(nullArgs).not.toContain('--computers-root-dir');
  });

  it('forwards --silverhand-state-root-dir when silverhandStateRootDir is set (#task:1598)', async () => {
    // Load-bearing desktop chain: daemonPaths → spawn argv → entry →
    // runDaemon guard root. A dropped flag silently falls back to the
    // home root, so the forwarding itself is pinned here.
    const args = await captureSpawnArgs({
      silverhandStateRootDir: '/tmp/silverhand-fake-app-root',
    });
    const idx = args.indexOf('--silverhand-state-root-dir');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('/tmp/silverhand-fake-app-root');
  });

  it('omits --silverhand-state-root-dir when unset or null', async () => {
    const unsetArgs = await captureSpawnArgs();
    expect(unsetArgs).not.toContain('--silverhand-state-root-dir');

    const nullArgs = await captureSpawnArgs({ silverhandStateRootDir: null });
    expect(nullArgs).not.toContain('--silverhand-state-root-dir');
  });

  it('forwards --daemon-identity-path when daemonIdentityPath is set (#task:1598 round 4)', async () => {
    // Load-bearing desktop chain: with the sibling derivation removed, a
    // dropped flag would silently move the identity file to the bare
    // default under ~/.silverhand/daemon.
    const args = await captureSpawnArgs({
      daemonIdentityPath: '/tmp/silverhand-fake-run/identity.json',
    });
    const idx = args.indexOf('--daemon-identity-path');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('/tmp/silverhand-fake-run/identity.json');
  });

  it('omits --daemon-identity-path when unset or null', async () => {
    const unsetArgs = await captureSpawnArgs();
    expect(unsetArgs).not.toContain('--daemon-identity-path');

    const nullArgs = await captureSpawnArgs({ daemonIdentityPath: null });
    expect(nullArgs).not.toContain('--daemon-identity-path');
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

  it('forwards --layout-migration-outcome when set (#task:1613)', async () => {
    // Load-bearing observation chain: desktop prepare outcome -> spawn
    // argv -> entry parse -> runDaemon ready capabilities. A dropped flag
    // silently turns every desktop boot into "unobserved" for the
    // migration-unit deletion gate.
    const args = await captureSpawnArgs({ layoutMigrationOutcome: 'migrated' });
    const idx = args.indexOf('--layout-migration-outcome');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('migrated');

    const alreadyArgs = await captureSpawnArgs({
      layoutMigrationOutcome: 'already_current',
    });
    const idx2 = alreadyArgs.indexOf('--layout-migration-outcome');
    expect(alreadyArgs[idx2 + 1]).toBe('already_current');
  });

  it('omits --layout-migration-outcome when unset or null', async () => {
    const unsetArgs = await captureSpawnArgs();
    expect(unsetArgs).not.toContain('--layout-migration-outcome');

    const nullArgs = await captureSpawnArgs({ layoutMigrationOutcome: null });
    expect(nullArgs).not.toContain('--layout-migration-outcome');
  });

});
