/**
 * `runDaemon` — programmatic daemon launcher.
 *
 * Composes IntentDispatcher + DaemonServer + pid file + signal handler
 * into one start/stop primitive. Two consumer shapes:
 *
 *  - Process entry (`./entry.ts`): parses argv into `RunDaemonOptions`,
 *    calls `runDaemon(opts)`, blocks until shutdown. Stdout receives
 *    the `ready` handshake line so a parent spawn helper can detect
 *    "daemon is now listening".
 *
 *  - Test harness: calls `runDaemon({ ..., installSignals: false,
 *    writeStdoutHandshake: false })` to spin a daemon up in the test
 *    process, then drives it via a HostClient. The `stop()` method on
 *    the returned handle is the clean teardown path.
 *
 * Why split from `entry.ts`: the entry is the *thinnest possible*
 * argv-parsing shim. All testable logic lives here so the test path
 * never has to fork a subprocess just to assert "daemon refuses to
 * start when another pid owns the lock".
 */
import {
  claimPidFile,
  installShutdownHandlers,
  releasePidFile,
} from './lifecycle.js';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { IntentDispatcher } from './dispatcher.js';
import { DaemonServer } from './server.js';
import { createDaemonLogger, type DaemonLogger } from './logger.js';
import {
  encodeFrame,
  type EventFrame,
  type AgentMaterializeParams,
} from '../protocol.js';
import { DAEMON_VERSION, createDaemonHelloResult } from './version.js';
import { logDaemon } from './daemon-logging.js';
import {
  defaultDaemonIdentityPath,
  readOrCreateDaemonIdentity,
} from './identity.js';
import { OutboundSupervisor } from './outbound-supervisor.js';
import type { OutboundCommandDispatcher } from './outbound-client.js';
import { LocalOutboundFrameServer } from './local-outbound-frame-server.js';
import {
  AgentMaterializeError,
  materializeAgent,
} from './agent-materialize/index.js';
import {
  WorkspaceRegistry,
  WorkspaceProvisionError,
  provisionWorkspace,
  AgentWorkspaceIndexError,
  indexAgentWorkspaces,
  type RegistryBinding,
} from './workspace-registry/index.js';
import {
  buildDaemonInstanceId,
  defaultRuntimePidRootDir,
  reconcileRuntimePidfiles,
} from './runtime-pidfiles.js';
import type { SupervisorContract } from './supervisor-contract.js';

export interface RunDaemonOptions {
  /** Absolute path where the daemon should bind its Unix socket. */
  socketPath: string;
  /** Absolute path of the pid file the daemon should claim. */
  pidFilePath: string;
  /** Directory for the daemon's own JSONL log file. */
  logDir: string;
  /**
   * Optional Stage D2 daemon-outbound host config. When present, the daemon
   * polls this atomic JSON file and opens `/api/hosts/connect` with its
   * long-lived host token. Omit/null keeps protocol tests on the Unix socket
   * only.
   */
  hostConfigPath?: string | null;
  /** Install SIGTERM/SIGINT handlers. Defaults to true. Tests pass
   *  false so a daemon running in-process doesn't intercept the test
   *  runner's own signal handling. */
  installSignals?: boolean;
  /** Print the `ready` handshake event to stdout on successful bind.
   *  Defaults to true (entry-script consumers need it). Tests pass
   *  false to keep their stdout clean. */
  writeStdoutHandshake?: boolean;
  /** Mirror log lines to stderr. Defaults to false; the entry script
   *  passes true so a parent that forwards daemon stderr gets a live
   *  view of what the daemon is doing. */
  alsoStderr?: boolean;
  /** Injected logger; tests use it to inspect log lines. When omitted,
   *  one is created at `logDir/daemon-<utc>.log`. */
  logger?: DaemonLogger;
  /** Root for per-runtime pidfiles. Production defaults to
   *  `~/.silverhand/daemon/runtime-pids`; tests pass a temp dir.
   *  `null` disables the phase-1 pidfile feature for protocol-only
   *  fixtures. */
  runtimePidRootDir?: string | null;
  /**
   * Persistent daemon identity file. Four resolution cases:
   *
   *   - `=== null` — skip reading/creating any identity file; the
   *     daemon advertises `DEFAULT_DAEMON_IDENTITY` (bootstrap
   *     `daemon_id='local'` + `host_descriptor={name:'local',
   *     kind:'local'}`). Used by protocol-only tests that don't want
   *     to touch the filesystem.
   *   - omitted **and** `runtimePidRootDir === null` — same as above
   *     (cannot derive a file location without a root); bootstrap
   *     identity is broadcast.
   *   - omitted **and** `runtimePidRootDir` is set — derived to
   *     `dirname(runtimePidRootDir)/identity.json`. Tests that pass
   *     a temp `runtimePidRootDir` therefore keep the identity file
   *     under the same temp tree automatically.
   *   - explicit string — use the given path verbatim. Production
   *     boot in `apps/desktop` lets this default to
   *     `~/.silverhand/daemon/identity.json` via
   *     `defaultDaemonIdentityPath`.
   *
   * On first read for any non-null path, the file is created with the
   * bootstrap identity (atomic tmp+rename, mode 0o600). Subsequent
   * boots reuse it; multi-daemon launchers may pre-populate a
   * different file before boot.
   */
  daemonIdentityPath?: string | null;
  /**
   * D5.a-2 — optional local outbound frame socket path. When set
   * (non-null), the daemon starts a {@link LocalOutboundFrameServer} on
   * this Unix socket alongside the control `DaemonServer`. It speaks the
   * SAME outbound frame envelope the standalone WSS client speaks and
   * routes commands through the same `IntentDispatcher`, so the embedded
   * backend reaches the daemon over the unified formal path (closing R4)
   * instead of the legacy `HostClient` IPC protocol.
   *
   * Omitted/`null` keeps the daemon control-socket-only — every existing
   * protocol test and the standalone deployment leave this unset. The
   * embedded backend wiring (D5.a-3) sets it to
   * `deriveLocalOutboundFrameSocketPath()`.
   */
  localOutboundSocketPath?: string | null;
  /**
   * SupervisorContract factory — REQUIRED, but explicitly nullable (Cindy
   * `XuKGmdna3GWZcY2G` + shiki `Go9ZiB4OnwTbELZU`). The daemon
   * constructs the supervisor AFTER the server is bound, passing an
   * `emit` callback that broadcasts events to every live socket
   * connection (with runtime_output backpressure applied per §2.2.2).
   *
   * Two legitimate shapes:
   *   - `(deps) => new Supervisor(deps)` — production wire
   *     (`entry.ts`). Anything that owns spawn/wake/stop lifecycle.
   *   - `(deps) => new FakeSupervisor({...})` — protocol/e2e tests
   *     validating the full intent → supervisor → broadcast →
   *     HostClient.subscribe path without a real CLI child.
   *   - `null` — explicit opt-out for tests that only exercise the
   *     PR-1 surface (ping/status/echo). `runtime_*` intents in that
   *     mode return `internal_error: no supervisor wired`.
   *
   * Why required-but-nullable instead of optional:
   *   - Optional (`supervisorFactory?:`) was the original PR-1 shape;
   *     after PR-2 step 2 every production caller MUST wire a real
   *     supervisor, and a missing factory silently degrades to PR-1
   *     mode at runtime. This bit us at `43d5295`'s pre-fix state:
   *     `entry.ts` was missing the wire and TypeScript was happy,
   *     daemon booted, all `runtime_*` intents failed.
   *   - Forcing the field to be present makes "I deliberately want
   *     no supervisor here" a typed decision (`null`) instead of
   *     accidental absence. The `entry-supervisor-wiring.test.ts`
   *     suite + the `// @ts-expect-error` contract test in
   *     `run-daemon-type-contract.test.ts` lock both halves of the invariant.
   */
  supervisorFactory:
    | ((deps: {
        emit: (event: EventFrame) => void;
        logger: DaemonLogger;
        daemonInstanceId: string;
        runtimePidRootDir: string | null;
      }) => SupervisorContract)
    | null;
  /**
   * D4.d D6 — **test-only** hooks. NOT part of the embedder
   * contract. Production MUST omit this field. The dispatcher
   * slot ALWAYS calls `materializeAgent(...)` — there is no
   * embedder-facing seam to replace the handler. The two hooks
   * below are narrow test surfaces:
   *
   *   - `agentMaterializeHomeDir` overrides the parent dir
   *     `materializeAgent` joins onto (`<homeDir>/.silverhand/
   *     agents/<id>/`); without it, the real
   *     `materializeAgent` would write into the daemon process's
   *     `homedir()`, which is unacceptable in tests.
   *   - `agentMaterializeFaultInjector` is a deterministic
   *     typed-error pre-hook: if it returns an
   *     `AgentMaterializeError`, the dispatcher surfaces the
   *     typed wire code (Cindy D2 pre-gate #3 narrowing path);
   *     if it returns `undefined`, the real `materializeAgent`
   *     runs. The injector cannot return a synthetic success
   *     result, cannot mutate handler behavior, and is fired
   *     BEFORE `materializeAgent` — so the only behavior under
   *     test control is "fail this dispatch with code X" or
   *     "let the real handler run".
   *
   * Cindy D6-2 P1-1 (`d4IID_Nnn1VShRa5`): a previous draft
   * exposed `agentMaterializeHandler?` at the top of
   * `RunDaemonOptions`, which read like an embedder-facing
   * seam to replace formal server↔daemon semantics. This
   * narrow `testHooks` namespace makes the test-only scope
   * explicit in the API shape and preserves the D4.d invariant
   * that the wire arm is additive only — no fork, no
   * replacement.
   */
  testHooks?: {
    agentMaterializeHomeDir?: string;
    agentMaterializeFaultInjector?: (
      params: AgentMaterializeParams,
    ) => AgentMaterializeError | undefined;
    /**
     * D4.e-1 — override the workspace registry's state dir (where the
     * registry JSON + managed workspaces root live). Production derives
     * it from `dirname(daemonIdentityPath)`; tests point it at a tmp dir
     * so provisioning never writes into the daemon process's real
     * `~/.silverhand/daemon`.
     */
    workspaceRegistryStateDir?: string;
    /**
     * D4.e-1 (Cindy P1-3) — override the silverhand state root used by the
     * registry's requested-path guard (a caller-proposed path may not live
     * inside it, except under `workspaces/`). Production derives it from
     * `dirname(workspaceRegistryStateDir)` (= `~/.silverhand`); tests set it
     * explicitly so the state-root rejection can be exercised against a tmp
     * tree without depending on the real `~/.silverhand`.
     */
    silverhandStateRoot?: string;
  };
}

export interface RunningDaemon {
  socketPath: string;
  pidFilePath: string;
  logger: DaemonLogger;
  /**
   * Broadcast an unsolicited event to every live connection. Used by
   * a SupervisorContract's `emit` callback to surface `runtime_*` events to
   * the backend. `runtime_output` frames participate in the
   * per-(conv, agent) 4 MiB drop cap (§2.2.2); all other events write
   * straight through.
   */
  broadcast(event: EventFrame): void;
  /** Stop the daemon: drain in-flight intents, close socket, release
   *  pid file. Idempotent. Resolves once everything is flushed. */
  stop(reason: string): Promise<void>;
}

export async function runDaemon(opts: RunDaemonOptions): Promise<RunningDaemon> {
  const startedAt = Date.now();
  const daemonInstanceId = buildDaemonInstanceId(startedAt);
  const runtimePidRootDir =
    opts.runtimePidRootDir === undefined
      ? defaultRuntimePidRootDir()
      : opts.runtimePidRootDir;
  const daemonIdentityPath =
    opts.daemonIdentityPath === undefined
      ? defaultDaemonIdentityPath(runtimePidRootDir)
      : opts.daemonIdentityPath;
  const daemonIdentity =
    daemonIdentityPath === null
      ? undefined
      : readOrCreateDaemonIdentity(daemonIdentityPath);
  const helloResult = createDaemonHelloResult(daemonInstanceId, daemonIdentity);
  const readyEvent = (): Extract<EventFrame, { event: 'ready' }> => ({
    event: 'ready',
    ...helloResult,
    socket_path: opts.socketPath,
    daemon_pid: process.pid,
    started_at: startedAt,
  });
  const logger =
    opts.logger ??
    createDaemonLogger({
      dir: opts.logDir,
      alsoStderr: opts.alsoStderr ?? false,
      base: { component: 'silverhand-daemon', daemon_version: DAEMON_VERSION },
    });

  const claim = claimPidFile(opts.pidFilePath);
  if (claim.status === 'conflict') {
    const err = new Error(
      `another silverhand-daemon is already running (pid=${claim.conflictingPid})`,
    );
    (err as NodeJS.ErrnoException).code = 'EALREADY';
    logger.error(
      { pidFilePath: opts.pidFilePath, conflictingPid: claim.conflictingPid },
      'refusing to start: pid file already owned by live daemon',
    );
    await logger.close();
    throw err;
  }
  logDaemon(logger, {
    action: 'pid_claim',
    pid: process.pid,
    pid_file_path: opts.pidFilePath,
  });

  if (runtimePidRootDir !== null) {
    try {
      const reconcile = reconcileRuntimePidfiles({
        rootDir: runtimePidRootDir,
        selfDaemonInstanceId: daemonInstanceId,
        logger,
      });
      logger.info(
        {
          runtimePidRootDir,
          daemonInstanceId,
          ...reconcile,
        },
        'runtime pidfile orphan reconcile completed',
      );
    } catch (err) {
      logger.warn(
        {
          runtimePidRootDir,
          daemonInstanceId,
          err: (err as Error).message,
        },
        'runtime pidfile orphan reconcile failed; continuing daemon boot',
      );
    }
  }

  // Resolve the circular dep between supervisor (needs `emit`),
  // dispatcher (needs the supervisor), and server (needs the
  // dispatcher; provides `broadcast`) by giving the supervisor a
  // closure-bound `emit` that we wire to `server.broadcast` once the
  // server exists. Until that point, `emit` is a no-op — the
  // supervisor is constructed but won't fire events before
  // `server.start()` returns anyway.
  let broadcaster: (event: EventFrame) => void = () => {};
  // D3.a Commit 3: the outbound client is no longer constructed
  // unconditionally at boot. The OutboundSupervisor encapsulates the
  // `attach(configPath)` decision tree (validate, idempotency,
  // graceful swap) and is consumed by both the legacy CLI `--host-config`
  // auto-start path (below) and the new `host_outbound_attach` IPC
  // intent (wired into the dispatcher).
  //
  // Note the deliberate forward-declaration dance: OutboundSupervisor
  // needs a `dispatchCommand` callback that routes outbound-WS
  // commands into the dispatcher, but the dispatcher itself needs a
  // `hostOutboundAttachHandler` that calls into the supervisor. We
  // close the loop with a mutable `commandForwarder` placeholder that
  // is assigned to the real `dispatcher.dispatch` once the dispatcher
  // exists. Calling the forwarder before that point throws — but no
  // outbound socket can be open before this function returns, so the
  // throw is unreachable in practice.
  let commandForwarder: OutboundCommandDispatcher = () => {
    throw new Error(
      'outbound dispatchCommand invoked before dispatcher was wired',
    );
  };
  const outboundSupervisor = new OutboundSupervisor({
    logger,
    readyEvent,
    dispatchCommand: command => commandForwarder(command),
  });
  const supervisor = opts.supervisorFactory
    ? opts.supervisorFactory({
        emit: event => broadcaster(event),
        logger,
        daemonInstanceId,
        runtimePidRootDir,
      })
    : undefined;
  // D4.e-1 — workspace registry wiring. The registry is the daemon's
  // sole authority for host-local workspace paths (invariant I1). It is
  // namespaced per control-plane binding `{server_origin, host_id}`:
  //   - Standalone: the live outbound binding (`currentBinding()`), so
  //     the registry follows exactly the control plane the daemon is
  //     attached to. Before attach there is no binding → fail-closed.
  //   - Embedded (local outbound socket present): a fixed
  //     `local-embedded` origin + the daemon's own identity id, since an
  //     embedded daemon never attaches a WSS outbound client.
  // The registry is built lazily per command because the standalone
  // binding is only known after `host_outbound_attach`.
  const workspaceRegistryStateDir =
    opts.testHooks?.workspaceRegistryStateDir ??
    (daemonIdentityPath !== null
      ? dirname(daemonIdentityPath)
      : `${homedir()}/.silverhand/daemon`);
  // D4.e-1 (Cindy P1-3) — the requested-path guard roots, constructed ONCE
  // here and injected into every registry build (NOT re-derived via
  // homedir() inside the handler), so the validate-root can never diverge
  // from the actual state root under testHook/packaging. The state root is
  // the parent of the daemon state dir (`~/.silverhand/daemon` →
  // `~/.silverhand`); the lone allowed child inside it is `workspaces/`
  // (pre-D4.e generated roots).
  const silverhandStateRoot =
    opts.testHooks?.silverhandStateRoot ?? dirname(workspaceRegistryStateDir);
  const legacyWorkspacesRoot = join(silverhandStateRoot, 'workspaces');
  const resolveRegistryBinding = (): RegistryBinding | null => {
    if (localOutboundServer != null) {
      return {
        server_origin: 'local-embedded',
        host_id: daemonIdentity?.daemon_id ?? 'local',
      };
    }
    return outboundSupervisor.currentBinding();
  };
  const dispatcher = new IntentDispatcher({
    logger,
    startedAt,
    helloResult,
    supervisor,
    hostOutboundAttachHandler: params => outboundSupervisor.attach(params),
    hostOutboundDetachHandler: () => outboundSupervisor.detach(),
    hostOutboundReloadHandler: () => outboundSupervisor.reload(),
    // D4.d D2 — server↔daemon formal semantics. `materializeAgent`
    // owns the §4.6 idempotency decision tree + atomic seed +
    // sentinel write. `homeDir` defaults to the daemon process's
    // own `homedir()`, which is correct in production (the daemon
    // runs as the user whose `~/.silverhand/agents/` is the target
    // L1 root). D4.d D6 narrowed the test seam to `testHooks` per
    // Cindy `d4IID_Nnn1VShRa5` P1-1: there is NO embedder-facing
    // handler-replacement option. The dispatcher slot ALWAYS
    // invokes `materializeAgent`; tests may inject a tmp `homeDir`
    // and/or a deterministic typed-error fault BEFORE the real
    // handler runs.
    agentMaterializeHandler: async params => {
      const fault = opts.testHooks?.agentMaterializeFaultInjector?.(params);
      if (fault) throw fault;
      return materializeAgent(params, {
        homeDir: opts.testHooks?.agentMaterializeHomeDir,
      });
    },
    // D4.e-1 — workspace_provision: bind a regular workspace into the
    // registry + create its `.silverhand/` skeleton. ONE operation, two
    // path regimes: no `requested_path` → daemon-managed default; with one
    // → daemon re-validates the caller-proposed path then binds it (M1
    // folder picker / sandbox typed path / legacy backfill). Built lazily
    // so the standalone binding (known only post-attach) is current.
    workspaceProvisionHandler: async params => {
      const binding = resolveRegistryBinding();
      if (binding == null) {
        throw new WorkspaceProvisionError(
          'registry_unavailable',
          'daemon not attached to a control plane; cannot resolve workspace registry binding',
        );
      }
      const registry = new WorkspaceRegistry({
        stateDir: workspaceRegistryStateDir,
        binding,
        silverhandStateRoot,
        legacyWorkspacesRoot,
      });
      return provisionWorkspace(params, { registry, logger });
    },
    // D4.e-1 — agent_workspace_index: route-time `agent_dir` resolver.
    // agent-home dirs resolve from the daemon's homedir (test override via
    // `agentMaterializeHomeDir`); regular workspaces resolve via the
    // registry (fail-closed, never from a backend-supplied path).
    agentWorkspaceIndexHandler: async params => {
      const binding = resolveRegistryBinding();
      if (binding == null) {
        throw new AgentWorkspaceIndexError(
          'registry_unavailable',
          'daemon not attached to a control plane; cannot resolve workspace registry binding',
        );
      }
      const registry = new WorkspaceRegistry({
        stateDir: workspaceRegistryStateDir,
        binding,
        silverhandStateRoot,
        legacyWorkspacesRoot,
      });
      return indexAgentWorkspaces(params, {
        registry,
        homeDir: opts.testHooks?.agentMaterializeHomeDir,
      });
    },
  });
  commandForwarder = command =>
    dispatcher.dispatch(command.id, String(command.kind), command.params);
  const server = new DaemonServer({
    socketPath: opts.socketPath,
    dispatcher,
    logger,
  });
  // D5.a-2 — embedded formal path. The local outbound frame server shares
  // the exact `commandForwarder` (→ `dispatcher.dispatch`) and the same
  // outbound envelope mapping as the standalone WSS client, so embedded
  // and standalone are one dispatch path, not two protocols. Constructed
  // only when a socket path is supplied (embedded mode); standalone and
  // protocol-only tests leave it null.
  const localOutboundServer =
    opts.localOutboundSocketPath != null
      ? new LocalOutboundFrameServer({
          socketPath: opts.localOutboundSocketPath,
          dispatchCommand: command => commandForwarder(command),
          logger,
          // Same handshake the standalone WSS client sends on connect
          // (`outbound-client.ts` → `sendEvent(readyEvent())`). The
          // embedded adapter relies on it to latch the daemon key and
          // hydrate, so embedded and standalone share the `ready` path.
          readyEvent,
        })
      : null;
  broadcaster = event => {
    server.broadcast(event);
    outboundSupervisor.sendEvent(event);
    localOutboundServer?.broadcast(event);
  };

  try {
    await server.start();
  } catch (err) {
    logger.error(
      { err: (err as Error).message, socketPath: opts.socketPath },
      'failed to bind socket',
    );
    releasePidFile(opts.pidFilePath);
    await logger.close();
    throw err;
  }

  if (localOutboundServer) {
    try {
      await localOutboundServer.start();
    } catch (err) {
      logger.error(
        {
          err: (err as Error).message,
          socketPath: opts.localOutboundSocketPath,
        },
        'failed to bind local outbound frame socket',
      );
      await server.stop('local_outbound_bind_failed');
      releasePidFile(opts.pidFilePath);
      await logger.close();
      throw err;
    }
  }

  // The handshake is the contract the spawn helper relies on to know
  // the daemon is *ready to accept connections*. Print it AFTER
  // server.start() so a parent process that reads "ready" can connect
  // immediately without retry.
  if (opts.writeStdoutHandshake ?? true) {
    process.stdout.write(encodeFrame(readyEvent()));
  }
  logger.info(
    {
      socketPath: opts.socketPath,
      pidFilePath: opts.pidFilePath,
      logFile: logger.filePath,
    },
    'daemon ready',
  );
  logDaemon(logger, {
    action: 'boot',
    pid: process.pid,
    socket_path: opts.socketPath,
    pid_file_path: opts.pidFilePath,
  });
  if (opts.hostConfigPath) {
    // Legacy `--host-config` CLI auto-start path, preserved for
    // standalone / manual daemon launches that have a credential file
    // ready at spawn time (e.g. headless server hosts, protocol
    // fixtures). Desktop main does NOT take this path under D3.a —
    // it spawns without `--host-config` and triggers attach via the
    // `host_outbound_attach` IPC after login. Both paths funnel
    // through the same `OutboundSupervisor.attach`, which means the
    // validation, idempotency, and swap semantics are identical.
    const cliAttach = outboundSupervisor.attach({
      config_path: opts.hostConfigPath,
    });
    if (!cliAttach.attached) {
      // Don't fail-loud the whole daemon boot — the supervisor's
      // failure path leaves state untouched and a later
      // host_outbound_attach IPC can recover. Just log so the
      // operator can see why outbound never connected.
      logger.warn(
        {
          kind: 'outbound_supervisor',
          action: 'cli_auto_attach_failed',
          reason: cliAttach.reason,
          message: cliAttach.message,
        },
        'daemon outbound CLI auto-attach failed; outbound is inactive until host_outbound_attach IPC arrives',
      );
    }
  }

  let stopped = false;
  const stop = async (reason: string): Promise<void> => {
    if (stopped) return;
    stopped = true;
    logDaemon(logger, { action: 'shutting_down', pid: process.pid });
    outboundSupervisor.sendEvent({ event: 'shutting_down', reason });
    outboundSupervisor.stop(reason);
    if (localOutboundServer) {
      try {
        await localOutboundServer.stop();
      } catch (err) {
        logger.error(
          { err: (err as Error).message },
          'local outbound server stop threw; continuing teardown',
        );
      }
    }
    try {
      await server.stop(reason);
    } catch (err) {
      logger.error(
        { err: (err as Error).message },
        'server.stop threw; continuing teardown',
      );
    }
    releasePidFile(opts.pidFilePath);
    logger.info({ reason }, 'daemon stopped');
    await logger.close();
  };

  if (opts.installSignals ?? true) {
    installShutdownHandlers(logger, async signal => {
      await stop(signal);
    });
  }

  return {
    socketPath: opts.socketPath,
    pidFilePath: opts.pidFilePath,
    logger,
    broadcast: event => broadcaster(event),
    stop,
  };
}
