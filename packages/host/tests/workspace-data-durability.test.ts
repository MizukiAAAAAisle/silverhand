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

  it('resolves the durable path from the explicit workspace-data root (the daemon performs no legacy moves)', async () => {
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
    // Seed the FINISHED durable FLAT shape (#task:1608 — the desktop
    // layout engine owns all legacy physical moves + the flatten and runs
    // before any daemon).
    const durableRoot = join(dir, 'data', 'workspace-data');
    const durableSeedManaged = join(durableRoot, 'workspaces', 'ws-mig');
    mkdirSync(durableSeedManaged, { recursive: true });
    writeFileSync(
      join(durableRoot, 'workspace-registry.json'),
      JSON.stringify({
        schema_version: 1,
        binding,
        workspaces: {
          'ws-mig': { path: durableSeedManaged, provisioned_at: 1 },
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

    // The registry resolves the DURABLE path from the explicit root; the
    // identity dir stays free of registry-owned state (wiping the runtime
    // dir can never destroy the registry or guest L2 roots).
    expect(deps.resolveRegularWorkspacePath('ws-mig')).toBe(durableSeedManaged);
    expect(existsSync(durableSeedManaged)).toBe(true);
    expect(existsSync(join(dir, bindingSlug(binding)))).toBe(false);
  });


  it('a direct --host-config boot freezes the computer context at startup without crashing (P0-1 TDZ falsifier)', async () => {
    const dir = mkdtempSync('/tmp/sh-directboot-');
    dirs.push(dir);
    // The direct binding is accepted at spawn time: the startup freeze
    // used to read `localOutboundServer` inside its temporal dead zone
    // and crash EVERY connect boot before any test noticed (the IPC
    // attach path initialized everything first).
    let deps: RuntimeStartResolveDeps | undefined;
    const daemon = await runDaemon({
      socketPath: join(dir, 'daemon.sock'),
      pidFilePath: join(dir, 'daemon.pid'),
      logDir: join(dir, 'logs'),
      hostConfig: {
        server_url: 'http://127.0.0.1:59999',
        host_id: 'computer-direct-1',
        host_token: 'token-direct',
      },
      runtimePidRootDir: join(dir, 'runtime-pids'),
      computersRootDir: join(dir, 'computers'),
      silverhandStateRootDir: dir,
      daemonIdentityPath: join(dir, 'identity.json'),
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
    // The frozen context serves the slot-keyed agents root immediately.
    expect(deps.agentHomeRootDir).toBe(
      join(dir, 'computers', 'computer-direct-1', 'agents'),
    );
  });
});

/**
 * #task:1608 P0-2 falsifiers — PRODUCTION DISPATCH, not helper units. In
 * slot mode (desktop passes `computersRootDir`) there is no agents root
 * before the machine registers: an agent-file operation must fail closed
 * with the handler's OWN typed code. The regression these pin: the
 * handlers used to fall through to the helpers' legacy homedir default and
 * silently rebuild the retired top-level `~/.silverhand/agents/` authority.
 * All three go through the real wiring — two via raw outbound frames on
 * the embedded socket, one via the runtime-spawn deps `runDaemon` hands
 * the supervisor.
 */
describe('slot mode fails closed before registration (#task:1608 P0-2)', () => {
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

  async function startSlotModeDaemon(): Promise<{
    dir: string;
    deps: RuntimeStartResolveDeps;
    outboundSocketPath: string;
  }> {
    const dir = mkdtempSync('/tmp/sh-slotmode-');
    dirs.push(dir);
    let deps: RuntimeStartResolveDeps | undefined;
    const daemon = await runDaemon({
      socketPath: join(dir, 'daemon.sock'),
      pidFilePath: join(dir, 'daemon.pid'),
      logDir: join(dir, 'logs'),
      runtimePidRootDir: join(dir, 'runtime-pids'),
      computersRootDir: join(dir, 'computers'),
      silverhandStateRootDir: dir,
      daemonIdentityPath: join(dir, 'identity.json'),
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
    return { dir, deps, outboundSocketPath: join(dir, 'daemon-outbound.sock') };
  }

  /** Send ONE command frame on the embedded outbound socket and return its
   *  command_response (skipping event frames like the connect-time ready). */
  function sendOutboundCommand(
    socketPath: string,
    frame: OutboundServerToDaemonCommandFrame,
  ): Promise<unknown> {
    return new Promise((resolvePromise, rejectPromise) => {
      const socket: Socket = createConnection(socketPath);
      const timer = setTimeout(() => {
        socket.destroy();
        rejectPromise(new Error('no command_response received in time'));
      }, 3_000);
      let buffer = '';
      const finish = (fn: () => void): void => {
        clearTimeout(timer);
        socket.destroy();
        fn();
      };
      socket.setEncoding('utf8');
      socket.on('connect', () => {
        socket.write(`${encodeOutboundFrame(frame)}\n`);
      });
      socket.on('error', err => finish(() => rejectPromise(err)));
      socket.on('data', (chunk: string | Buffer) => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        const { frames, leftover } = splitNdjson(buffer, text);
        buffer = leftover;
        for (const line of frames) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue;
          }
          if (
            parsed !== null &&
            typeof parsed === 'object' &&
            (parsed as { type?: unknown }).type === 'command_response'
          ) {
            finish(() => resolvePromise(parsed));
            return;
          }
        }
      });
    });
  }

  it('agent_materialize on the real dispatch path → typed fs_unavailable, no homedir fallback', async () => {
    const { deps, outboundSocketPath } = await startSlotModeDaemon();
    void deps;
    const raw = await sendOutboundCommand(outboundSocketPath, {
      direction: 'server_to_daemon',
      type: 'command',
      id: 'cmd-p02-1',
      kind: 'agent_materialize',
      params: {
        agent_id: 'agent-preclaim-1',
        agent_home_workspace_id: 'wsah_agent-preclaim-1',
        name: 'preclaim',
        runtime: 'claude',
        template_choice: 'default',
      },
    } as OutboundServerToDaemonCommandFrame);
    const parsed = OutboundDaemonToServerCommandResponseFrameSchema.parse(raw);
    expect('error' in parsed && parsed.error).toMatchObject({
      code: 'fs_unavailable',
    });
    // The falsified fallback: nothing may appear under the REAL home-root
    // shape inside the sandbox (or anywhere in the slot root).
    expect(existsSync(join(dirs[dirs.length - 1]!, 'agents'))).toBe(false);
    expect(existsSync(join(dirs[dirs.length - 1]!, 'computers'))).toBe(false);
  });

  it('agent_workspace_tree (L1 read) on the real dispatch path → typed registry_unavailable', async () => {
    const { outboundSocketPath } = await startSlotModeDaemon();
    const raw = await sendOutboundCommand(outboundSocketPath, {
      direction: 'server_to_daemon',
      type: 'command',
      id: 'cmd-p02-2',
      kind: 'agent_workspace_tree',
      params: { agent_id: 'agent-preclaim-2' },
    } as OutboundServerToDaemonCommandFrame);
    const parsed = OutboundDaemonToServerCommandResponseFrameSchema.parse(raw);
    expect('error' in parsed && parsed.error).toMatchObject({
      code: 'registry_unavailable',
    });
  });

  it('runtime spawn resolution → agentHomeRootDir throws typed registry_unavailable', async () => {
    const { deps } = await startSlotModeDaemon();
    let thrown: unknown;
    try {
      void deps.agentHomeRootDir;
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RuntimeStartResolveError);
    expect((thrown as RuntimeStartResolveError).code).toBe(
      'registry_unavailable',
    );
  });
});
