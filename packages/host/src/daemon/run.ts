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
  defaultAppRoot,
  legacyWorkspacesRootDir,
  resolveComputerSlotFromComputersRoot,
  resolveDesktopAppPaths,
  resolveLegacyStandaloneDaemonPaths,
} from '@silverhand/shared/app-data-layout';
import {
  claimPidFile,
  installShutdownHandlers,
  releasePidFile,
} from './lifecycle.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { DaemonHostConfig } from '@silverhand/shared';
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
  type DaemonIdentity,
  readOrCreateDaemonIdentity,
} from './identity.js';
import { OutboundSupervisor } from './outbound-supervisor.js';
import {
  OutboundDaemonClient,
  type OutboundCommandDispatcher,
} from './outbound-client.js';
import type { OwnerCleanup } from './outbound-frame-mapping.js';
import { LocalOutboundFrameServer } from './local-outbound-frame-server.js';
import {
  AgentMaterializeError,
  materializeAgent,
} from './agent-materialize/index.js';
import {
  WorkspaceRegistry,
  WorkspaceRegistryError,
  WorkspaceProvisionError,
  provisionWorkspace,
  AgentWorkspaceIndexError,
  indexAgentWorkspaces,
  AgentL2SeedError,
  seedAgentL2,
  AgentFilesPurgeError,
  defaultWorkspaceDataRootDir,
  legacyNamespaceDirs,
  legacyWorkspaceDataSourceDirs,
  purgeAgentFiles,
  type RegistryBinding,
} from './workspace-registry/index.js';
import {
  AgentWorkspaceFsError,
  listAgentWorkspaceTree,
  readAgentWorkspaceFile,
} from './agent-workspace-fs/index.js';
import {
  AgentProfileMcpError,
  readAgentProfileMcp,
  writeAgentProfileMcp,
} from './agent-profile-mcp/index.js';
import { probeMcpServer } from './mcp-probe/index.js';
import {
  resolveAuthenticatedComputerId,
  RuntimeStartResolveError,
  type RuntimeStartResolveDeps,
} from './runtime-start-resolve.js';
import {
  buildDaemonInstanceId,
  defaultRuntimePidRootDir,
  reconcileRuntimePidfiles,
} from './runtime-pidfiles.js';
import type { SupervisorContract } from './supervisor-contract.js';
import {
  migrateLegacyDaemonProxyConfig,
  readDaemonProxyConfig,
  writeDaemonProxyConfig,
} from './proxy-config.js';
import { computerProxyConfigPath } from './computer-profile.js';
import {
  resolveLocalSilverhandCliLauncher,
  type SilverhandCliLauncher,
} from './silverhand-cli-launcher.js';

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
  /**
   * In-memory outbound host config for the public `connect` command. Unlike
   * `hostConfigPath`, this does not write the connect token into daemon-owned
   * config; the token lives in the user's copied command / service unit.
   */
  hostConfig?: DaemonHostConfig | null;
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
   * #task:1608 — the per-computer durable slots root
   * (`<app-root>/computers`). When set (desktop), the ACCEPTED binding's
   * slot `computers/<computer_id>/{agents,workspace-data}` is frozen into
   * the generation-scoped computer path context at attach; hot paths only
   * consume that context. Explicit `agentHomeRootDir` /
   * `workspaceDataRootDir` overrides (connect --data-root, tests) win
   * over the slot.
   */
  computersRootDir?: string | null;
  /**
   * Root for daemon-owned per-agent L1 dirs. Omit to keep the legacy
   * `~/.silverhand/agents/<id>` default; connect passes a data-root-scoped
   * path so custom roots are fully isolated from the user's profile.
   */
  agentHomeRootDir?: string | null;
  /**
   * #task:1596 — the EXPLICIT persistent workspace-data root for this
   * computer (registry file + managed workspace roots, which hold agent L2
   * memory). Desktop passes `<silverhand-dir>/workspace-data`; `connect`
   * passes `<data-root>/workspace-data`. Never derived from identity/pid
   * paths (those are wipeable runtime state) nor from where agent L1
   * lives. Absent → the global `~/.silverhand/workspace-data`.
   */
  workspaceDataRootDir?: string | null;
  /**
   * #task:1598 — the EXPLICIT global silverhand root used as the
   * requested-path guard root (protectedRoots) and the legacy-workspaces
   * exemption anchor. Desktop passes its app root; connect passes the
   * global home root. Never derived from identity/registry paths.
   */
  silverhandStateRootDir?: string | null;
  /**
   * Explicit daemon-local proxy config file. Standalone `connect --data-root`
   * uses this to keep every runtime artifact under its chosen data root.
   * Embedded desktop leaves it null so the daemon resolves the file from the
   * current computer binding under `<silverhand>/computers/<profile>/`.
   */
  proxyConfigPath?: string | null;
  /**
   * Legacy app-managed proxy file (`<silverhand>/daemon/proxy-config.json`).
   * When `proxyConfigPath` is null and a per-computer path can be resolved,
   * daemon migrates this file once, then renames the legacy file aside. Runtime
   * reads never permanently fall back to this path.
   */
  legacyProxyConfigPath?: string | null;
  /**
   * Host-local control-plane URL file for embedded desktop boots. Desktop
   * writes the finalized loopback URL after the embedded backend starts;
   * the daemon reads it at runtime spawn. Standalone remote boots use
   * `daemon-config.json` / outbound binding instead.
   */
  controlPlaneServerUrlPath?: string | null;
  /**
   * Persistent daemon identity file. Resolution (#task:1598 round 4 —
   * the historical `dirname(runtimePidRootDir)/identity.json` sibling
   * derivation is gone; embedders pass the coordinate explicitly):
   *
   *   - `=== null` — skip reading/creating any identity file; the
   *     daemon advertises `DEFAULT_DAEMON_IDENTITY` (bootstrap
   *     `daemon_id='local'` + `host_descriptor={name:'local',
   *     kind:'local'}`). Protocol-only tests and `connect` (which
   *     supplies `daemonIdentity` directly) use this.
   *   - explicit string — use the given path verbatim. Desktop passes
   *     the resolver's `localComputer.run.identity` through
   *     `--daemon-identity-path`.
   *   - omitted — bare-daemon fallback `defaultDaemonIdentityPath()`
   *     (`~/.silverhand/daemon/identity.json` via the resolver).
   *
   * On first read for any non-null path, the file is created with the
   * bootstrap identity (atomic tmp+rename, mode 0o600). Subsequent
   * boots reuse it; multi-daemon launchers may pre-populate a
   * different file before boot.
   */
  daemonIdentityPath?: string | null;
  /** Explicit process identity for public `connect` launches. This lets the
   *  ready event report the target machine hostname as diagnostic metadata
   *  without creating a desktop-style identity file. */
  daemonIdentity?: DaemonIdentity | null;
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
   *     (`entry.ts`). Anything that owns spawn/deliver/stop lifecycle.
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
        daemonSocketPath: string;
        /**
         * D4.e-6 — host path resolution deps for `runtime_start`. The
         * daemon resolves semantic workspace/agent refs to absolute host
         * paths via these (registry for `regular`, `computeAgentDir` for
         * `agent_home`), fail-closed. `runDaemon` builds them from the
         * workspace registry; the factory threads them into `Supervisor`.
         */
        runtimeStartResolveDeps: RuntimeStartResolveDeps;
        proxyConfigPath: () => string | null;
        localSilverhandCliLauncher: SilverhandCliLauncher | null;
        controlPlaneServerUrl: () => string | null;
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

function readControlPlaneServerUrl(
  filepath: string | null | undefined,
  logger: DaemonLogger,
): string | null {
  if (!filepath) return null;
  try {
    const raw = readFileSync(filepath, 'utf8').trim();
    if (!raw) return null;
    return new URL(raw).origin;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      logger.warn(
        { filepath, err: (err as Error).message },
        'failed to read daemon-local control-plane URL; runtime_start will fail if no outbound binding is attached',
      );
    }
    return null;
  }
}

function resolveControlPlaneServerUrl(input: {
  registryBinding: RegistryBinding | null;
  controlPlaneServerUrlPath: string | null | undefined;
  logger: DaemonLogger;
}): string | null {
  const daemonLocalUrl = readControlPlaneServerUrl(
    input.controlPlaneServerUrlPath,
    input.logger,
  );
  if (daemonLocalUrl) return daemonLocalUrl;

  const origin = input.registryBinding?.server_origin ?? null;
  if (!origin) return null;
  try {
    const url = new URL(origin);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return url.origin;
    }
  } catch {
    // `local-embedded` is a workspace-registry namespace, not an HTTP
    // control-plane origin. It must never reach SILVERHAND_SERVER_URL or
    // daemon-side backend fetch URLs.
  }
  return null;
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
      ? defaultDaemonIdentityPath()
      : opts.daemonIdentityPath;
  const daemonIdentity =
    opts.daemonIdentity !== undefined
      ? opts.daemonIdentity ?? undefined
      : daemonIdentityPath === null
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
  const localSilverhandCliLauncher = resolveLocalSilverhandCliLauncher();
  if (localSilverhandCliLauncher) {
    logDaemon(logger, {
      action: 'cli_launcher_resolved',
      pid: process.pid,
    });
  } else if (opts.supervisorFactory) {
    logDaemon(logger, {
      action: 'cli_launcher_unavailable',
      pid: process.pid,
    });
  }

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
  // Late-bound like `commandForwarder` (the dispatcher is created below): the
  // owner-scoped deferred-queue cleanup an outbound ingress fires on its
  // connection drop (#task:1417 Stage 3, §11.4.1).
  let ownerCleanup: OwnerCleanup = () => {};
  const outboundSupervisor = new OutboundSupervisor({
    logger,
    readyEvent,
    dispatchCommand: (command, ctx) => commandForwarder(command, ctx),
    cleanupDeferredForOwner: owner => ownerCleanup(owner),
  });
  const directOutboundBinding = opts.hostConfig
    ? {
        server_origin: new URL(opts.hostConfig.server_url).origin,
        host_id: opts.hostConfig.host_id,
      }
    : null;
  // D4.e-1 — workspace registry wiring. The registry is the daemon's
  // sole authority for host-local workspace paths (invariant I1). It is
  // namespaced per control-plane binding `{server_origin, host_id}`:
  //   - Standalone: the live outbound binding (`currentBinding()`), so
  //     the registry follows exactly the control plane the daemon is
  //     attached to. Before attach there is no binding → fail-closed.
  //   - Embedded (local outbound socket present): a fixed
  //     `local-embedded` origin, but the host id comes from the live
  //     `daemon-config.json` binding once desktop has claimed the real
  //     app-managed host. Before that attach lands we fall back to the
  //     daemon bootstrap id (`local`) only as a pre-login placeholder.
  // The registry is built lazily per command because the binding is only
  // known after `host_outbound_attach` on both desktop and standalone
  // late-attach paths.
  //
  // #task:1596 durability fix (Cindy P1): workspace-data (registry file +
  // managed roots, which hold agent L2 memory) is DURABLE state — it must
  // not live under the identity file's directory (desktop's wipeable
  // `~/.silverhand/run`) nor the historical `~/.silverhand/daemon`. The
  // embedder passes its persistent computer data root EXPLICITLY
  // (`workspaceDataRootDir`: desktop `~/.silverhand/workspace-data`,
  // connect `<data-root>/workspace-data`) — where agent L1 lives never
  // implicitly decides where workspace-data lives. Absent → the global
  // default. The daemon performs no legacy physical moves — the desktop
  // layout engine owns them (#task:1603 single-owner rule).
  const workspaceRegistryStateDirHook = opts.testHooks?.workspaceRegistryStateDir;
  // Non-slot root selection (explicit override / test hook / bare default).
  // With `computersRootDir` set these are superseded by the accepted
  // binding's slot inside the frozen computer path context below.
  const explicitWorkspaceDataRoot =
    workspaceRegistryStateDirHook ?? opts.workspaceDataRootDir ?? undefined;
  const explicitAgentsRoot = opts.agentHomeRootDir ?? undefined;
  // D4.e-1 (Cindy P1-3) — the requested-path guard roots, constructed ONCE
  // here and injected into every registry build (NOT re-derived via
  // homedir() inside the handler), so the validate-root can never diverge
  // from the actual state root under testHook/packaging. The state root
  // keeps its pre-#task:1596 derivation (parent of the identity/state dir:
  // desktop `~/.silverhand/run` → `~/.silverhand`; in-memory identity →
  // `~/.silverhand`) — only the workspace-data dir moved, the guard root
  // and the per-computer profile root did not. The lone allowed child
  // inside it is `workspaces/` (pre-D4.e generated roots).
  // #task:1598 round 2 (Cindy P1-2) — the guard root is an EXPLICIT
  // resolved coordinate from the composition root (desktop passes its app
  // root; connect passes the global home root), never a parent inversion
  // of the identity/registry paths: a v2 layout that moves those files
  // must not silently move the protected root. Bare daemons fall back to
  // the resolver's home root.
  const silverhandStateRoot =
    opts.testHooks?.silverhandStateRoot ??
    opts.silverhandStateRootDir ??
    defaultAppRoot();
  // Legacy ALIAS source inventory (#task:1603) — NOT a path authority and
  // NOT a move source (the daemon performs no legacy physical moves; the
  // desktop layout engine is the single owner). Feeds only the registry's
  // stale-legacy-path re-bind provenance for #1529's hydrate backfill.
  // DELETION CONDITION: retires with the #1529 observation-first gate.
  const legacyAliasSourceDirs: (string | null)[] =
    legacyWorkspaceDataSourceDirs({
      daemonIdentityPath,
      silverhandStateRoot,
    });
  const legacyWorkspacesRoot = legacyWorkspacesRootDir(silverhandStateRoot);
  const fallbackEmbeddedHostId = daemonIdentity?.daemon_id ?? 'local';
  const liveOutboundBinding = (): RegistryBinding | null =>
    directOutboundBinding ?? outboundSupervisor.currentBinding();
  const resolveRegistryBinding = (): RegistryBinding | null => {
    if (localOutboundServer != null) {
      return {
        server_origin: 'local-embedded',
        host_id: liveOutboundBinding()?.host_id ?? fallbackEmbeddedHostId,
      };
    }
    return liveOutboundBinding();
  };
  // ── #task:1608 — generation-scoped computer path context ─────────────
  // The accepted binding's computer id is frozen into ONE typed path
  // context per binding generation, at the attach/detach transitions.
  // Hot paths (registry builds, L1 materialize, seed/purge, runtime
  // spawn resolution) only consume this context — they never re-derive
  // roots from a mutable `currentBinding()` lookup, so an in-flight
  // operation can never straddle two computer directories. The embedded
  // pre-claim placeholder host id (`fallbackEmbeddedHostId`) NEVER enters
  // the context: before the machine registers there is no computer slot,
  // and data-plane intents fail closed with their existing typed
  // `registry_unavailable`.
  interface ComputerPathContext {
    binding: RegistryBinding;
    agentsRoot: string | undefined;
    workspaceDataRoot: string;
  }
  let computerContext: ComputerPathContext | null = null;
  const freezeComputerContext = (): void => {
    const live = liveOutboundBinding();
    if (live == null) {
      computerContext = null;
      return;
    }
    const binding: RegistryBinding =
      localOutboundServer != null
        ? { server_origin: 'local-embedded', host_id: live.host_id }
        : live;
    const slot =
      opts.computersRootDir != null
        ? resolveComputerSlotFromComputersRoot(
            opts.computersRootDir,
            binding.host_id,
          )
        : null;
    computerContext = {
      binding,
      agentsRoot: explicitAgentsRoot ?? slot?.agents,
      workspaceDataRoot:
        explicitWorkspaceDataRoot ??
        slot?.workspaceData ??
        defaultWorkspaceDataRootDir(),
    };
  };
  const fenceComputerContext = (): void => {
    computerContext = null;
  };
  // NOTE (#task:1608 P0-1): the startup freeze for a direct `--host-config`
  // binding happens AFTER `localOutboundServer` is initialized (below) —
  // calling it here would read the const inside its temporal dead zone and
  // crash every connect boot.
  const currentAgentsRoot = (): string | undefined =>
    computerContext?.agentsRoot ?? explicitAgentsRoot;
  // #task:1608 P0-2 — in slot mode (desktop passes `computersRootDir`) an
  // agent-file operation BEFORE the machine registers must fail closed
  // with the handler's own typed error: falling through to the helpers'
  // legacy homedir default would silently rebuild the retired top-level
  // `agents/` authority. Explicit roots (connect --data-root, tests) are
  // not binding-derived and stay valid pre-attach by contract.
  const slotMode = opts.computersRootDir != null;
  const agentsRootFor = <E extends Error>(
    wrap: (message: string) => E,
  ): string | undefined => {
    const root = currentAgentsRoot();
    if (root === undefined && slotMode) {
      throw wrap(
        'no computer is registered on this daemon yet; agent files are unavailable until the machine binds to a server',
      );
    }
    return root;
  };

  const workspaceRegistry = (ctx: ComputerPathContext): WorkspaceRegistry => {
    const binding = ctx.binding;
    // #task:1608 workspace-data convergence: the cross-binding lazy
    // re-bind (legacyBindings/copyLegacyEntry) is retired — the migration
    // lifts the current binding's registry once, and old namespaces are
    // inert orphans the runtime never reads. The #1529 stale-DB-path
    // alias below is coordinate math only (no filesystem reads) and keeps
    // its own observation-first retirement gate; desktop-managed daemons
    // still trust their own historical namespace coordinates (post-claim
    // host id AND the pre-claim `local` placeholder) for it.
    const aliasBindings: RegistryBinding[] = [binding];
    if (daemonIdentityPath !== null) {
      aliasBindings.push(
        { server_origin: 'local-embedded', host_id: binding.host_id },
        { server_origin: 'local-embedded', host_id: fallbackEmbeddedHostId },
      );
    }
    return new WorkspaceRegistry({
      stateDir: ctx.workspaceDataRoot,
      binding,
      silverhandStateRoot,
      legacyWorkspacesRoot,
      trustedLegacyNamespaceDirs: legacyNamespaceDirs(
        // Trusted alias SOURCE roots: the released run-era root(s) plus
        // this computer's own workspace-data root — a stale server row may
        // carry either the run-era slug coordinate or the intermediate
        // slot-era one (`<workspace-data>/<binding-slug>/workspaces/<slug>`)
        // from before the #task:1608 flat convergence.
        [...legacyAliasSourceDirs, ctx.workspaceDataRoot],
        aliasBindings,
      ),
      // #task:1596 rounds 3-5 (Cindy P1-3) — a requested workspace path may
      // never overlap (either direction) the durable roots this daemon
      // depends on: its workspace-data root, its agent L1 root, AND the
      // global silverhand root. All three need their own ancestor guard —
      // a connect custom data root can live on a disjoint volume, so the
      // global root's ancestors are not covered transitively. The
      // legacy-workspaces exemption survives only for paths strictly
      // INSIDE the global root (the registry keys it off
      // silverhandStateRoot).
      protectedRoots: [
        ctx.workspaceDataRoot,
        ...(ctx.agentsRoot ? [ctx.agentsRoot] : []),
        silverhandStateRoot,
      ],
    });
  };
  // #task:1596 round 3 (Cindy P1-1) — registry construction must fail
  // INSIDE each intent's typed boundary: a WorkspaceRegistryError here
  // (registry_corrupt / registry_foreign) becomes the intent's own typed
  // `registry_unavailable`, never the dispatcher's generic internal_error.
  const buildRegistryAs = <E extends Error>(
    ctx: ComputerPathContext,
    wrap: (message: string) => E,
  ): WorkspaceRegistry => {
    try {
      return workspaceRegistry(ctx);
    } catch (err) {
      if (err instanceof WorkspaceRegistryError) throw wrap(err.message);
      throw err;
    }
  };
  const resolveProxyConfigPath = (): string | null => {
    if (opts.proxyConfigPath) return opts.proxyConfigPath;
    const binding = computerContext?.binding ?? null;
    if (binding == null) return null;
    const targetPath = computerProxyConfigPath(binding, silverhandStateRoot);
    if (
      localOutboundServer != null &&
      binding.host_id !== fallbackEmbeddedHostId
    ) {
      migrateLegacyDaemonProxyConfig({
        legacyPath: computerProxyConfigPath(
          { host_id: fallbackEmbeddedHostId },
          silverhandStateRoot,
        ),
        targetPath,
        logger,
      });
    }
    migrateLegacyDaemonProxyConfig({
      legacyPath: opts.legacyProxyConfigPath,
      targetPath,
      logger,
    });
    return targetPath;
  };
  // D4.e-6 — runtime_start path resolution deps. The wire options are
  // semantic-only; the supervisor resolves regular-workspace paths via the
  // registry here (fail-closed) and agent-home via `computeAgentDir` (inside
  // `resolveRuntimeStartPaths`). Built lazily per start so the standalone
  // binding (known only post-attach) is current — same pattern as the
  // data-plane handlers below. A `WorkspaceRegistryError` is mapped to the
  // typed runtime_start taxonomy: `not_provisioned` → recoverable
  // `workspace_not_provisioned` (backend may backfill + retry); a foreign /
  // corrupt registry, or no binding at all, → hard `registry_unavailable`.
  const runtimeStartResolveDeps = {
    homeDir: opts.testHooks?.agentMaterializeHomeDir,
    // Generation-scoped (#task:1608): reads the FROZEN context at spawn
    // time via a getter — never a mutable binding lookup.
    get agentHomeRootDir(): string | undefined {
      return agentsRootFor(
        m => new RuntimeStartResolveError('registry_unavailable', m),
      );
    },
    resolveRegularWorkspacePath: (workspaceId: string): string => {
      const ctx = computerContext;
      if (ctx == null) {
        throw new RuntimeStartResolveError(
          'registry_unavailable',
          'daemon not attached to a control plane; cannot resolve workspace registry binding',
        );
      }
      try {
        return workspaceRegistry(ctx).resolve(workspaceId);
      } catch (err) {
        if (err instanceof WorkspaceRegistryError) {
          throw new RuntimeStartResolveError(
            err.code === 'not_provisioned'
              ? 'workspace_not_provisioned'
              : 'registry_unavailable',
            err.message,
          );
        }
        throw err;
      }
    },
    // The prompt's This Context → Computer line. Authority is the LIVE
    // authenticated outbound binding only — never resolveRegistryBinding(),
    // whose embedded arm substitutes the pre-login placeholder
    // (`daemon_id` / 'local') when desktop has not claimed yet. Pre-attach
    // this fails closed (typed, recoverable) instead of stamping a
    // placeholder into prompt provenance.
    resolveComputerId: (): string =>
      resolveAuthenticatedComputerId(liveOutboundBinding()),
  };
  const supervisor = opts.supervisorFactory
    ? opts.supervisorFactory({
        emit: event => broadcaster(event),
        logger,
        daemonInstanceId,
        runtimePidRootDir,
        daemonSocketPath: opts.socketPath,
        runtimeStartResolveDeps,
        proxyConfigPath: resolveProxyConfigPath,
        localSilverhandCliLauncher,
        controlPlaneServerUrl: () =>
          resolveControlPlaneServerUrl({
            registryBinding: resolveRegistryBinding(),
            controlPlaneServerUrlPath: opts.controlPlaneServerUrlPath,
            logger,
          }),
      })
    : undefined;
  const dispatcher = new IntentDispatcher({
    logger,
    startedAt,
    helloResult,
    supervisor,
    // #task:1608 — binding transitions are the ONLY places the computer
    // path context changes: freeze after an accepted attach/reload, fence
    // BEFORE detach so no in-flight operation can land in a stale (or,
    // after re-registration, a new) computer directory.
    hostOutboundAttachHandler: async params => {
      const result = await outboundSupervisor.attach(params);
      freezeComputerContext();
      return result;
    },
    hostOutboundDetachHandler: async () => {
      fenceComputerContext();
      return outboundSupervisor.detach();
    },
    hostOutboundReloadHandler: async () => {
      const result = await outboundSupervisor.reload();
      freezeComputerContext();
      return result;
    },
    hostProxyConfigGetHandler: () => ({
      config: readDaemonProxyConfig(resolveProxyConfigPath(), logger),
    }),
    hostProxyConfigSetHandler: params => {
      const proxyConfigPath = resolveProxyConfigPath();
      if (!proxyConfigPath) {
        throw new Error('host proxy config path is not configured');
      }
      return {
        config: writeDaemonProxyConfig(proxyConfigPath, params),
      };
    },
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
        agentHomeRootDir: agentsRootFor(
          m => new AgentMaterializeError('fs_unavailable', m),
        ),
      });
    },
    // D4.e-1 — workspace_provision: bind a regular workspace into the
    // registry + create its `.silverhand/` skeleton. ONE operation, two
    // path regimes: no `requested_path` → daemon-managed default; with one
    // → daemon re-validates the caller-proposed path then binds it (M1
    // folder picker / sandbox typed path / legacy backfill). Built lazily
    // so the standalone binding (known only post-attach) is current.
    workspaceProvisionHandler: async params => {
      const ctx = computerContext;
      if (ctx == null) {
        throw new WorkspaceProvisionError(
          'registry_unavailable',
          'daemon not attached to a control plane; cannot resolve workspace registry binding',
        );
      }
      const registry = buildRegistryAs(
        ctx,
        m => new WorkspaceProvisionError('registry_unavailable', m),
      );
      return provisionWorkspace(params, { registry, logger });
    },
    // D4.e-1 — agent_workspace_index: route-time `agent_dir` resolver.
    // agent-home dirs resolve from the daemon's homedir (test override via
    // `agentMaterializeHomeDir`); regular workspaces resolve via the
    // registry (fail-closed, never from a backend-supplied path).
    agentWorkspaceIndexHandler: async params => {
      const ctx = computerContext;
      if (ctx == null) {
        throw new AgentWorkspaceIndexError(
          'registry_unavailable',
          'daemon not attached to a control plane; cannot resolve workspace registry binding',
        );
      }
      const registry = buildRegistryAs(
        ctx,
        m => new AgentWorkspaceIndexError('registry_unavailable', m),
      );
      return indexAgentWorkspaces(params, {
        registry,
        homeDir: opts.testHooks?.agentMaterializeHomeDir,
        agentHomeRootDir: agentsRootFor(
          m => new AgentWorkspaceIndexError('registry_unavailable', m),
        ),
      });
    },
    // #task:811/#1190 — agent_workspace_tree: flat tree of every visible
    // file/directory under the selected agent memory root. No `workspace_id`
    // means agent-home/L1 (homedir-derived); `workspace_id` means the daemon
    // resolves the regular workspace via its registry, or agent_home/DM back
    // to the same L1 dir. No server-derived path crosses the wire.
    agentWorkspaceTreeHandler: async params => {
      const ctx = params.workspace_id ? computerContext : null;
      const registry = ctx
        ? buildRegistryAs(
            ctx,
            m => new AgentWorkspaceFsError('registry_unavailable', m),
          )
        : undefined;
      return listAgentWorkspaceTree(params, {
        registry,
        homeDir: opts.testHooks?.agentMaterializeHomeDir,
        agentHomeRootDir: agentsRootFor(
          m => new AgentWorkspaceFsError('registry_unavailable', m),
        ),
      });
    },
    // #task:811/#1190 — agent_workspace_file_read: read one file from the
    // selected agent memory root by virtual path. The helper enforces the
    // segment-shape rules + per-segment lstat-walk + realpath boundary check
    // so the daemon never follows a symlink or reads outside the resolved base.
    agentWorkspaceFileReadHandler: async params => {
      const ctx = params.workspace_id ? computerContext : null;
      const registry = ctx
        ? buildRegistryAs(
            ctx,
            m => new AgentWorkspaceFsError('registry_unavailable', m),
          )
        : undefined;
      return readAgentWorkspaceFile(params, {
        registry,
        homeDir: opts.testHooks?.agentMaterializeHomeDir,
        agentHomeRootDir: agentsRootFor(
          m => new AgentWorkspaceFsError('registry_unavailable', m),
        ),
      });
    },
    // D4.e-3 — agent_l2_seed: seed a member agent's L2 (per-workspace)
    // memory dir on the owning host. Resolves the regular workspace's path
    // from the registry (fail-closed `workspace_not_provisioned` when
    // unbound) and writes the L2 template (L1 minus system_prompt.md),
    // idempotent. Built lazily so the standalone binding is current.
    agentL2SeedHandler: async params => {
      const ctx = computerContext;
      if (ctx == null) {
        throw new AgentL2SeedError(
          'registry_unavailable',
          'daemon not attached to a control plane; cannot resolve workspace registry binding',
        );
      }
      const registry = buildRegistryAs(
        ctx,
        m => new AgentL2SeedError('registry_unavailable', m),
      );
      return seedAgentL2(params, { registry });
    },
    // D4.e-4 — agent_files_purge: remove an agent's host-local L1/L2 files
    // on the owning host. L1 resolves from the daemon's homedir (test
    // override via `agentMaterializeHomeDir`, same as materialize); each L2
    // workspace resolves from the registry (fail-closed `registry_unavailable`
    // on a whole-registry failure; an unbound id is reported via
    // `skipped_unprovisioned`, not an error). A hard fs failure on any target
    // → typed `partial_purge` so the route keeps the DB row. Built lazily so
    // the standalone binding is current.
    agentFilesPurgeHandler: async params => {
      const ctx = computerContext;
      if (ctx == null) {
        throw new AgentFilesPurgeError(
          'registry_unavailable',
          'daemon not attached to a control plane; cannot resolve workspace registry binding',
        );
      }
      const registry = buildRegistryAs(
        ctx,
        m => new AgentFilesPurgeError('registry_unavailable', m),
      );
      return purgeAgentFiles(params, {
        registry,
        homeDir: opts.testHooks?.agentMaterializeHomeDir,
        agentHomeRootDir: agentsRootFor(
          m => new AgentFilesPurgeError('registry_unavailable', m),
        ),
      });
    },
    // #task:1135 — agent_profile_mcp_read / _write: the host-local truth
    // behind `silverhand profile mcp get|set`. L1 resolves from the daemon's
    // homedir (test override via `agentMaterializeHomeDir`); the write handler
    // re-validates the canonical schema and replaces `mcp.json` atomically.
    agentProfileMcpReadHandler: async params =>
      readAgentProfileMcp(params, {
        homeDir: opts.testHooks?.agentMaterializeHomeDir,
        agentHomeRootDir: agentsRootFor(
          m => new AgentProfileMcpError('fs_unavailable', m),
        ),
      }),
    agentProfileMcpWriteHandler: async params =>
      writeAgentProfileMcp(params, {
        homeDir: opts.testHooks?.agentMaterializeHomeDir,
        agentHomeRootDir: agentsRootFor(
          m => new AgentProfileMcpError('fs_unavailable', m),
        ),
      }),
    // #task:1137 — mcp_probe: open a one-shot live MCP connection to a named
    // server (initialize + optional tools/list) and close it immediately. L1
    // resolves from the same homedir as read/write.
    mcpProbeHandler: async params =>
      probeMcpServer(params, {
        homeDir: opts.testHooks?.agentMaterializeHomeDir,
        agentHomeRootDir: agentsRootFor(
          m => new AgentProfileMcpError('fs_unavailable', m),
        ),
      }),
  });
  commandForwarder = (command, ctx) =>
    dispatcher.dispatch(command.id, String(command.kind), command.params, ctx);
  ownerCleanup = owner => dispatcher.cleanupDeferredForOwner(owner);
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
  const directOutboundClient = opts.hostConfig
    ? new OutboundDaemonClient({
        config: opts.hostConfig,
        logger,
        readyEvent,
        dispatchCommand: (command, ctx) => commandForwarder(command, ctx),
        cleanupDeferredForOwner: owner => ownerCleanup(owner),
      })
    : null;
  const localOutboundServer =
    opts.localOutboundSocketPath != null
      ? new LocalOutboundFrameServer({
          socketPath: opts.localOutboundSocketPath,
          dispatchCommand: (command, ctx) => commandForwarder(command, ctx),
          cleanupDeferredForOwner: owner => ownerCleanup(owner),
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
    directOutboundClient?.sendEvent(event);
    localOutboundServer?.broadcast(event);
  };
  // #task:1608 P0-1 — the startup freeze for a direct `--host-config`
  // binding runs HERE, after every const it reads is initialized (an
  // earlier call sat in `localOutboundServer`'s temporal dead zone and
  // crashed every connect boot). No-binding boots leave the context null.
  freezeComputerContext();

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
    if (cliAttach.attached) freezeComputerContext();
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
  directOutboundClient?.start();

  let stopped = false;
  const stop = async (reason: string): Promise<void> => {
    if (stopped) return;
    stopped = true;
    logDaemon(logger, { action: 'shutting_down', pid: process.pid });
    outboundSupervisor.sendEvent({ event: 'shutting_down', reason });
    outboundSupervisor.stop(reason);
    directOutboundClient?.stop(reason);
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
