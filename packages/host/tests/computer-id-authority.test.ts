import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
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
      await daemons.pop()!.stop('test_done').catch(() => undefined);
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
      workspaceDataRootDir: join(dir, 'workspace-data'),
      pidFilePath: join(dir, 'daemon.pid'),
      logDir: join(dir, 'logs'),
      runtimePidRootDir: join(dir, 'runtime-pids'),
      localOutboundSocketPath: join(dir, 'daemon-outbound.sock'),
      installSignals: false,
      writeStdoutHandshake: false,
      alsoStderr: false,
      supervisorFactory: factoryDeps => {
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
    expect((thrown as RuntimeStartResolveError).code).toBe(
      'registry_unavailable',
    );
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
