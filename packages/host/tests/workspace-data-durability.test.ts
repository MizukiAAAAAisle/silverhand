import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createConnection, type Socket } from 'node:net';
import { runDaemon, type RunningDaemon } from '../src/daemon/index.js';
import { FakeSupervisor } from './_helpers/fake-supervisor.js';
import { HostClient } from '../src/client/index.js';
import { writeHostConfigAtomic } from '../src/daemon/outbound-client.js';
import {
  bindingSlug,
  managedWorkspaceSlug,
} from '../src/daemon/workspace-registry/registry.js';
import { RuntimeStartResolveError } from '../src/daemon/runtime-start-resolve.js';
import type { RuntimeStartResolveDeps } from '../src/daemon/runtime-start-resolve.js';
import {
  OutboundDaemonToServerCommandResponseFrameSchema,
  encodeOutboundFrame,
  type OutboundServerToDaemonCommandFrame,
} from '../src/outbound-protocol.js';
import { splitNdjson } from '../src/protocol.js';

/**
 * #task:1596 durability fix (Cindy P1) — PRODUCTION WIRING for the
 * workspace-data location. The registry (and the managed roots holding
 * agent L2 memory) must NOT live under the identity file's directory
 * (desktop's wipeable `run/`): `runDaemon` roots it at the EXPLICIT
 * durable data root the embedder passes (`workspaceDataRootDir`) and migrates a pre-fix
 * namespace on the first registry build. This pins the wiring end to end:
 * a legacy namespace seeded next to the identity file is relocated, the
 * resolver serves the DURABLE path, and nothing registry-owned remains in
 * the wipeable dir — so wiping it can no longer destroy guest memory.
 */
describe('runDaemon wiring — durable workspace-data placement', () => {
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

  it('migrates a pre-fix namespace out of the identity dir and resolves the durable path', async () => {
    const dir = mkdtempSync('/tmp/sh-wsdata-');
    dirs.push(dir);
    // The identity file is placed at `<dir>/identity.json` → `dir` is the
    // legacy (wipeable) state dir the registry USED to live in.
    const runtimePidRootDir = join(dir, 'runtime-pids');
    const agentHomeRootDir = join(dir, 'data', 'agents');
    const hostConfigPath = join(dir, 'daemon-config.json');
    writeHostConfigAtomic(hostConfigPath, {
      server_url: 'http://127.0.0.1:58128',
      host_id: 'computer-real-1',
      host_token: 'token-1',
    });

    // The embedded registry binding after attach.
    const binding = {
      server_origin: 'local-embedded',
      host_id: 'computer-real-1',
    };
    // Seed the PRE-FIX layout: namespace directly under the identity dir,
    // with one managed workspace whose registry entry points inside it.
    const legacyNs = join(dir, bindingSlug(binding));
    const legacyManaged = join(
      legacyNs,
      'workspaces',
      managedWorkspaceSlug('ws-mig'),
    );
    mkdirSync(legacyManaged, { recursive: true });
    writeFileSync(
      join(legacyNs, 'workspace-registry.json'),
      JSON.stringify({
        schema_version: 1,
        binding,
        workspaces: {
          'ws-mig': { path: legacyManaged, provisioned_at: 1 },
        },
      }),
      'utf-8',
    );

    let deps: RuntimeStartResolveDeps | undefined;
    const daemon = await runDaemon({
      socketPath: join(dir, 'daemon.sock'),
      pidFilePath: join(dir, 'daemon.pid'),
      logDir: join(dir, 'logs'),
      // #task:1598 round 4 — the identity coordinate is EXPLICIT now (no
      // sibling derivation); `dir` stays the legacy migration source via
      // dirname(daemonIdentityPath).
      daemonIdentityPath: join(dir, 'identity.json'),
      runtimePidRootDir,
      agentHomeRootDir,
      workspaceDataRootDir: join(dir, 'data', 'workspace-data'),
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

    const durableNs = join(dir, 'data', 'workspace-data', bindingSlug(binding));
    const durableManaged = join(
      durableNs,
      'workspaces',
      managedWorkspaceSlug('ws-mig'),
    );
    // First registry use migrates and resolves the DURABLE path.
    expect(deps.resolveRegularWorkspacePath('ws-mig')).toBe(durableManaged);
    expect(existsSync(durableManaged)).toBe(true);
    // Nothing registry-owned remains next to the identity file: wiping the
    // runtime dir can no longer destroy the registry or guest L2 roots.
    expect(existsSync(legacyNs)).toBe(false);
  });

  it('migration ambiguity crosses REAL intent boundaries as typed registry_unavailable (never internal_error)', async () => {
    // Round-3 P1-1 falsifier: registry construction (where the migration
    // runs) must fail inside each intent's typed boundary. Seed an
    // AMBIGUOUS state — the same binding namespace in BOTH the legacy
    // identity dir and the durable dir — and assert the failure's wire
    // shape on two real boundaries: the runtime_start resolver deps and a
    // workspace_provision command over the real local outbound socket.
    const dir = mkdtempSync('/tmp/sh-wsdata-amb-');
    dirs.push(dir);
    const runtimePidRootDir = join(dir, 'runtime-pids');
    const agentHomeRootDir = join(dir, 'data', 'agents');
    const hostConfigPath = join(dir, 'daemon-config.json');
    writeHostConfigAtomic(hostConfigPath, {
      server_url: 'http://127.0.0.1:58128',
      host_id: 'computer-real-1',
      host_token: 'token-1',
    });
    const binding = {
      server_origin: 'local-embedded',
      host_id: 'computer-real-1',
    };
    for (const stateDir of [dir, join(dir, 'data', 'workspace-data')]) {
      const ns = join(stateDir, bindingSlug(binding));
      mkdirSync(join(ns, 'workspaces'), { recursive: true });
      writeFileSync(
        join(ns, 'workspace-registry.json'),
        JSON.stringify({ schema_version: 1, binding, workspaces: {} }),
        'utf-8',
      );
    }

    let deps: RuntimeStartResolveDeps | undefined;
    const outboundSock = join(dir, 'daemon-outbound.sock');
    const daemon = await runDaemon({
      socketPath: join(dir, 'daemon.sock'),
      pidFilePath: join(dir, 'daemon.pid'),
      logDir: join(dir, 'logs'),
      // #task:1598 round 4 — the identity coordinate is EXPLICIT now (no
      // sibling derivation); `dir` stays the legacy migration source via
      // dirname(daemonIdentityPath).
      daemonIdentityPath: join(dir, 'identity.json'),
      runtimePidRootDir,
      agentHomeRootDir,
      workspaceDataRootDir: join(dir, 'data', 'workspace-data'),
      localOutboundSocketPath: outboundSock,
      installSignals: false,
      writeStdoutHandshake: false,
      alsoStderr: false,
      supervisorFactory: factoryDeps => {
        deps = factoryDeps.runtimeStartResolveDeps;
        return new FakeSupervisor({ emit: factoryDeps.emit });
      },
    });
    daemons.push(daemon);
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

    // Boundary 1 — runtime_start path resolution: typed, mapped code.
    let thrown: unknown;
    try {
      deps!.resolveRegularWorkspacePath('ws-any');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RuntimeStartResolveError);
    expect((thrown as RuntimeStartResolveError).code).toBe('registry_unavailable');
    // The path-free error contract: no host path leaks in the message.
    expect((thrown as Error).message).not.toContain(dir);

    // Boundary 2 — a REAL workspace_provision command over the local
    // outbound socket answers with the intent's typed registry_unavailable.
    const socket: Socket = createConnection(outboundSock);
    await new Promise<void>((resolvePromise, reject) => {
      socket.once('connect', () => resolvePromise());
      socket.once('error', reject);
    });
    const frames: unknown[] = [];
    let buffered = '';
    socket.on('data', chunk => {
      const split = splitNdjson(buffered, chunk.toString('utf-8'));
      buffered = split.leftover;
      frames.push(...split.frames.map(line => JSON.parse(line)));
    });
    const command = {
      direction: 'server_to_daemon',
      type: 'command',
      id: 'cmd-amb-1',
      kind: 'workspace_provision',
      params: { workspace_id: 'ws-any', kind: 'regular' },
    } as OutboundServerToDaemonCommandFrame;
    socket.write(`${encodeOutboundFrame(command)}\n`);
    const response = await (async () => {
      const deadline = Date.now() + 5_000;
      for (;;) {
        const hit = frames.find(
          f => (f as { type?: string; id?: string }).type === 'command_response',
        );
        if (hit) return hit;
        if (Date.now() > deadline) throw new Error('no command_response');
        await new Promise(r => setTimeout(r, 10));
      }
    })();
    socket.destroy();
    const parsed = OutboundDaemonToServerCommandResponseFrameSchema.parse(response);
    expect('error' in parsed && parsed.error).toMatchObject({
      code: 'registry_unavailable',
    });
    if ('error' in parsed) {
      expect(parsed.error.message).not.toContain(dir);
    }
    // Ambiguity resolution is manual and explicit: both trees still exist.
    expect(existsSync(join(dir, bindingSlug(binding)))).toBe(true);
    expect(
      existsSync(join(dir, 'data', 'workspace-data', bindingSlug(binding))),
    ).toBe(true);
  });
});
