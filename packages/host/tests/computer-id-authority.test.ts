import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { Socket } from 'node:net';
import { join } from 'node:path';
import { runDaemon, type RunningDaemon } from '../src/daemon/index.js';
import { FakeSupervisor } from './_helpers/fake-supervisor.js';
import { HostClient } from '../src/client/index.js';
import { writeHostConfigAtomic } from '../src/daemon/outbound-client.js';
import {
  RuntimeStartResolveError,
  type RuntimeStartResolveDeps,
} from '../src/daemon/runtime-start-resolve.js';

/**
 * #task:1595 review P1 — PRODUCTION WIRING regression for the prompt's
 * Computer authority. The original bug was not in any helper: `runDaemon`
 * wired `resolveComputerId` to `resolveRegistryBinding()`, whose embedded
 * arm substitutes the pre-login placeholder (`daemon_id` / 'local') when
 * the local outbound listener exists but no `host_outbound_attach` has
 * landed — so a spawned prompt would claim `Computer: local`. A pure
 * helper test cannot catch a re-wiring regression, so these tests capture
 * the deps `runDaemon` actually hands the supervisor factory and pin both
 * sides of the authority boundary:
 *   - embedded listener configured but NOT attached → typed fail-closed,
 *     never a placeholder;
 *   - after a real attach → the authenticated `host_id`.
 */
describe('runDaemon wiring — resolveComputerId authority', () => {
  const daemons: RunningDaemon[] = [];
  const dirs: string[] = [];

  afterEach(async () => {
    while (daemons.length) {
      await daemons
        .pop()!
        .stop('test_done')
        .catch(() => undefined);
    }
    while (dirs.length) {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    }
  });

  async function startDaemonCapturingDeps(dir: string): Promise<{
    daemon: RunningDaemon;
    deps: RuntimeStartResolveDeps;
  }> {
    let deps: RuntimeStartResolveDeps | undefined;
    const daemon = await runDaemon({
      socketPath: join(dir, 'daemon.sock'),
      pidFilePath: join(dir, 'daemon.pid'),
      logDir: join(dir, 'logs'),
      runtimePidRootDir: join(dir, 'runtime-pids'),
      daemonIdentityPath: join(dir, 'identity.json'),
      agentHomeRootDir: join(dir, 'agents'),
      localOutboundSocketPath: join(dir, 'daemon-outbound.sock'),
      installSignals: false,
      writeStdoutHandshake: false,
      alsoStderr: false,
      supervisorFactory: (factoryDeps) => {
        deps = factoryDeps.runtimeStartResolveDeps;
        return new FakeSupervisor({ emit: factoryDeps.emit });
      },
    });
    daemons.push(daemon);
    if (!deps) throw new Error('supervisorFactory was not called');
    return { daemon, deps };
  }

  it('embedded listener configured but NOT attached → typed fail-closed, never the local placeholder', async () => {
    const dir = mkdtempSync('/tmp/sh-cid-');
    dirs.push(dir);
    const { deps } = await startDaemonCapturingDeps(dir);

    let thrown: unknown;
    let returned: string | undefined;
    try {
      returned = deps.resolveComputerId();
    } catch (err) {
      thrown = err;
    }
    // The regression this pins: resolveRegistryBinding() would have
    // returned host_id 'local' (or a daemon_id) here instead of throwing.
    expect(returned).toBeUndefined();
    expect(thrown).toBeInstanceOf(RuntimeStartResolveError);
    expect((thrown as RuntimeStartResolveError).code).toBe('registry_unavailable');
  });

  it('after host_outbound_attach → returns the real authenticated host id', async () => {
    const dir = mkdtempSync('/tmp/sh-cid-');
    dirs.push(dir);
    const hostConfigPath = join(dir, 'daemon-config.json');
    writeHostConfigAtomic(hostConfigPath, {
      server_url: 'http://127.0.0.1:58128',
      host_id: 'computer-real-1',
      host_token: 'token-1',
    });
    const { deps } = await startDaemonCapturingDeps(dir);

    const client = new HostClient({ socketPath: join(dir, 'daemon.sock') });
    await client.connect();
    try {
      const attached = await client.hostOutboundAttach({
        config_path: hostConfigPath,
      });
      expect(attached.attached).toBe(true);
    } finally {
      await client.close();
    }

    expect(deps.resolveComputerId()).toBe('computer-real-1');
  });
});

describe('runDaemon wiring — post-attach ready re-announce (#task:1719)', () => {
  const daemons: RunningDaemon[] = [];
  const dirs: string[] = [];
  afterEach(async () => {
    while (daemons.length > 0)
      await daemons
        .pop()!
        .stop('test_done')
        .catch(() => undefined);
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it('a successful host_outbound_attach re-announces `ready` on the local outbound socket (binding is now real)', async () => {
    const dir = mkdtempSync('/tmp/sh-attach-ready-');
    dirs.push(dir);
    const hostConfigPath = join(dir, 'daemon-config.json');
    writeHostConfigAtomic(hostConfigPath, {
      server_url: 'http://127.0.0.1:58129',
      host_id: 'computer-ready-1',
      host_token: 'token-1',
    });
    const outboundSocketPath = join(dir, 'daemon-outbound.sock');
    const daemon = await runDaemon({
      socketPath: join(dir, 'daemon.sock'),
      pidFilePath: join(dir, 'daemon.pid'),
      logDir: join(dir, 'logs'),
      runtimePidRootDir: join(dir, 'runtime-pids'),
      daemonIdentityPath: join(dir, 'identity.json'),
      agentHomeRootDir: join(dir, 'agents'),
      localOutboundSocketPath: outboundSocketPath,
      installSignals: false,
      writeStdoutHandshake: false,
      alsoStderr: false,
      supervisorFactory: (factoryDeps) => new FakeSupervisor({ emit: factoryDeps.emit }),
    });
    daemons.push(daemon);

    // Raw NDJSON reader on the local outbound socket: the embedded
    // backend's view of daemon events.
    const readyEvents: unknown[] = [];
    const socket = new Socket();
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.connect(outboundSocketPath, () => resolve());
    });
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += String(chunk);
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (parsed['kind'] === 'ready') readyEvents.push(parsed);
        } catch {
          /* non-JSON noise is not under test */
        }
      }
    });

    // Connection-scoped ready arrives at accept (pre-binding).
    await waitFor(() => readyEvents.length >= 1);

    const client = new HostClient({ socketPath: join(dir, 'daemon.sock') });
    await client.connect();
    try {
      const attached = await client.hostOutboundAttach({
        config_path: hostConfigPath,
      });
      expect(attached.attached).toBe(true);
    } finally {
      await client.close();
    }

    // The causal re-announce: a SECOND ready lands after the binding is
    // real, so the backend's ready-triggered registry reconcile no
    // longer races host_outbound_attach (dogfood 2026-07-30 finding).
    await waitFor(() => readyEvents.length >= 2);
    socket.destroy();
  });

  it('a FAILED attach re-announces nothing (negative pin)', async () => {
    const dir = mkdtempSync('/tmp/sh-attach-noready-');
    dirs.push(dir);
    const outboundSocketPath = join(dir, 'daemon-outbound.sock');
    const daemon = await runDaemon({
      socketPath: join(dir, 'daemon.sock'),
      pidFilePath: join(dir, 'daemon.pid'),
      logDir: join(dir, 'logs'),
      runtimePidRootDir: join(dir, 'runtime-pids'),
      daemonIdentityPath: join(dir, 'identity.json'),
      agentHomeRootDir: join(dir, 'agents'),
      localOutboundSocketPath: outboundSocketPath,
      installSignals: false,
      writeStdoutHandshake: false,
      alsoStderr: false,
      supervisorFactory: (factoryDeps) => new FakeSupervisor({ emit: factoryDeps.emit }),
    });
    daemons.push(daemon);

    const readyEvents: unknown[] = [];
    const socket = new Socket();
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.connect(outboundSocketPath, () => resolve());
    });
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += String(chunk);
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (parsed['kind'] === 'ready') readyEvents.push(parsed);
        } catch {
          /* noise */
        }
      }
    });
    await waitFor(() => readyEvents.length >= 1);

    const client = new HostClient({ socketPath: join(dir, 'daemon.sock') });
    await client.connect();
    try {
      // Nonexistent config path → typed attach failure, attached:false.
      const attached = await client.hostOutboundAttach({
        config_path: join(dir, 'no-such-config.json'),
      });
      expect(attached.attached).toBe(false);
    } finally {
      await client.close();
    }

    // Grace window: no second ready may appear for a failed attach.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(readyEvents).toHaveLength(1);
    socket.destroy();
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
