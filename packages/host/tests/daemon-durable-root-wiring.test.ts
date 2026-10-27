import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createConnection, type Socket } from 'node:net';
import { runDaemon, type RunningDaemon } from '../src/daemon/index.js';
import { FakeSupervisor } from './_helpers/fake-supervisor.js';
import { HostClient } from '../src/client/index.js';
import { writeHostConfigAtomic } from '../src/daemon/outbound-client.js';
import { RuntimeStartResolveError } from '../src/daemon/runtime-start-resolve.js';
import type { RuntimeStartResolveDeps } from '../src/daemon/runtime-start-resolve.js';
import { resolveAgentWorkspaceBundleDir } from '../src/daemon/agent-materialize/index.js';
import {
  OutboundDaemonToServerCommandResponseFrameSchema,
  encodeOutboundFrame,
  type OutboundServerToDaemonCommandFrame,
} from '../src/outbound-protocol.js';
import { splitNdjson } from '../src/protocol.js';

/**
 * #task:1596 durability fix (Cindy P1) — PRODUCTION WIRING for the durable
 * agent tree. The roots holding agent L1/L2 memory must NOT live under the
 * identity file's directory (desktop's wipeable `run/`).
 *
 * relocation-v1 §7-4 removed the daemon's registry and its workspace-data
 * root, so the surviving durability claim is about the AGENT TREE: `runDaemon`
 * roots it at the EXPLICIT coordinate the embedder passes — `agentHomeRootDir`,
 * or the binding-keyed slot under `computersRootDir` — and hands that same root
 * to the runtime-spawn deps. This pins the wiring end to end: the resolver
 * serves the DURABLE root, every derived L2 bundle sits under it, and the
 * claim is falsified by EXECUTION — the runtime dir is a true sibling of the
 * agent tree and is actually deleted, after which real bundle bytes must still
 * be readable. A fixture that merely nests both under one scratch dir cannot
 * tell "durable" from "not yet deleted".
 */
describe('runDaemon wiring — durable agent-tree placement', () => {
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

  it('the durable agent root survives a full wipe of the runtime dir (identity/socket/pid/logs are a SIBLING of the agent tree)', async () => {
    const scratch = mkdtempSync('/tmp/sh-agentroot-');
    dirs.push(scratch);
    // Two SIBLING subtrees, exactly as desktop lays them out: everything
    // runtime-scoped (identity file, socket, pidfile, logs, runtime pidfiles,
    // host config) lives under `run/` — the dir a reinstall/reset may wipe —
    // while the durable agent tree lives under `data/`. Neither is an ancestor
    // of the other, so "wipe the runtime dir" is a real, executable falsifier.
    const runDir = join(scratch, 'run');
    const agentHomeRootDir = join(scratch, 'data', 'agents');
    mkdirSync(runDir, { recursive: true });
    const hostConfigPath = join(runDir, 'daemon-config.json');
    writeHostConfigAtomic(hostConfigPath, {
      server_url: 'http://127.0.0.1:58128',
      host_id: 'computer-real-1',
      host_token: 'token-1',
    });

    let deps: RuntimeStartResolveDeps | undefined;
    const daemon = await runDaemon({
      socketPath: join(runDir, 'daemon.sock'),
      pidFilePath: join(runDir, 'daemon.pid'),
      logDir: join(runDir, 'logs'),
      // #task:1598 round 4 — the identity coordinate is EXPLICIT now (no
      // sibling derivation); `runDir` stays the legacy migration source via
      // dirname(daemonIdentityPath).
      daemonIdentityPath: join(runDir, 'identity.json'),
      runtimePidRootDir: join(runDir, 'runtime-pids'),
      agentHomeRootDir,
      localOutboundSocketPath: join(runDir, 'daemon-outbound.sock'),
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

    const client = new HostClient({ socketPath: join(runDir, 'daemon.sock') });
    await client.connect();
    try {
      const attached = await client.hostOutboundAttach({
        config_path: hostConfigPath,
      });
      expect(attached.attached).toBe(true);
    } finally {
      await client.close();
    }

    // relocation-v1 §7-4 — a regular workspace's L2 bundle is the deterministic
    // agent-centric coordinate UNDER the durable agent-home root; no registry
    // and no DB column derives it. The resolver deps must carry the DURABLE
    // root, and every derived bundle must sit under it — never under `run/`.
    expect(deps.agentHomeRootDir).toBe(agentHomeRootDir);
    const l2Bundle = resolveAgentWorkspaceBundleDir('agent-x', 'ws-mig', {
      agentHomeRootDir: deps.agentHomeRootDir,
    });
    expect(l2Bundle.startsWith(`${agentHomeRootDir}/`)).toBe(true);
    expect(l2Bundle.startsWith(`${runDir}/`)).toBe(false);
    expect(existsSync(join(runDir, 'agents'))).toBe(false);

    // Now EXECUTE the falsifier: real guest memory in the bundle, then wipe the
    // whole runtime dir. If any part of the durable tree were derived from the
    // identity/runtime dir, this deletion would take the memory with it.
    mkdirSync(l2Bundle, { recursive: true });
    const evidence = join(l2Bundle, 'MEMORY.md');
    writeFileSync(evidence, '# guest memory that must outlive a runtime wipe\n');
    await daemons.pop()!.stop('test_done');
    rmSync(runDir, { recursive: true, force: true });

    expect(existsSync(runDir)).toBe(false);
    expect(existsSync(evidence)).toBe(true);
    expect(readFileSync(evidence, 'utf-8')).toContain('guest memory');
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
      supervisorFactory: (factoryDeps) => {
        deps = factoryDeps.runtimeStartResolveDeps;
        return new FakeSupervisor({ emit: factoryDeps.emit });
      },
    });
    daemons.push(daemon);
    if (!deps) throw new Error('supervisorFactory was not called');
    // The frozen context serves the slot-keyed agents root immediately.
    expect(deps.agentHomeRootDir).toBe(join(dir, 'computers', 'computer-direct-1', 'agents'));
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
      await daemons
        .pop()!
        .stop('test_done')
        .catch(() => undefined);
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
      supervisorFactory: (factoryDeps) => {
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
      socket.on('error', (err) => finish(() => rejectPromise(err)));
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
    expect((thrown as RuntimeStartResolveError).code).toBe('registry_unavailable');
  });
});
