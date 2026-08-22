/**
 * D4.b-1 — Stage D4 / G2 e2e harness.
 *
 * **Why this exists**: G2 acceptance
 * requires that the standalone backend ↔ daemon outbound WS path
 * works end-to-end against the real wire — no `Hono.fetch()`
 * shortcuts, no hand-built outbound frames, no direct
 * `HostWsServerController.sendCommand` calls bypassing the
 * dispatcher. This harness composes the same building blocks
 * `startBackend({ mode: 'standalone' })` and a production daemon
 * would, on top of a real TCP listener and a real `ws`
 * WebSocketServer / WebSocket pair.
 *
 * **Cindy boundary lock (`-RKQgKfHmMGhFk2F` / `_5NUY2CzOF9N80pM`)**:
 *
 *   1. Real HTTP listener (port 0, real Node `http.Server`).
 *   2. Real WS upgrade (`installHostWebSocketServer` from
 *      production, mounted by `startBackend`).
 *   3. Real `HostClient` (i.e. real `OutboundDaemonClient` from
 *      `@silverhand/host/daemon`).
 *   4. Real backend dispatcher / fanout
 *      (`OutboundRuntimeEventFanout`, installed by `startBackend`
 *      when `mode: 'standalone'`). The harness wraps the sink in
 *      a recording observer via the `testHooks.wrapHostWsEventSink`
 *      seam — the wrapper **always** delegates to the real fanout
 *      so the production projection path runs untouched. The
 *      observer is non-mutating: it only records frames for
 *      assertion.
 *   5. The only fake is the runtime driver (later commits — B1
 *      does not exercise any agent runtime, only attach).
 *
 * **What is intentionally NOT here**: agent spawn / runtime
 * intents / inbox drain / stop / reconnect recovery. Those land in
 * B2 / B3 / B4 / B5 with this harness as their substrate. Keeping
 * B1 narrowly scoped to harness + attach is per the agreed
 * cadence — Cindy reviews this checkpoint before B2 is started.
 *
 * **R4 (this IPC is local supervisor/control, not server↔daemon
 * formal semantics)**: this harness is exclusively the
 * server↔daemon outbound WS formal semantics path. The desktop
 * main ↔ backend IPC supervisor channel is not exercised here at
 * all.
 */
import { createSqliteHostPersistence } from '../../src/repos/host-uow.js';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  spawn as nodeSpawn,
  type ChildProcess,
  type SpawnOptions,
} from 'node:child_process';
import { execPath } from 'node:process';
import { fileURLToPath } from 'node:url';
import type { OutboundDaemonToServerEventFrame } from '@silverhand/host';
import {
  OutboundDaemonClient,
  createDaemonHelloResult,
  writeHostConfigAtomic,
  createDaemonLogControl,
  runDaemon,
  Supervisor,
  type RunningDaemon,
  type SupervisorOptions,
  type OutboundDaemonClientOptions,
  type DaemonLogger,
} from '@silverhand/host/daemon';
import {
  spawnDaemonChild,
  type DaemonGenerationInfo,
  type DaemonHandle,
} from '@silverhand/host';
import type { Driver } from '@silverhand/host/drivers';
import {
  DAEMON_HOST_CONFIG_FILENAME,
  type DaemonHostConfig,
  type RuntimeKind,
  type ServerConfig,
} from '@silverhand/shared';
import {
  defaultAppRoot,
  resolveBackendDataPaths,
} from '@silverhand/shared/app-data-layout';
import {
  type HostWsEventSink,
  type HostWsServerController,
  type RunningBackend,
} from '../../src/index.js';
import {
  startTestBackend,
  type TestRunningBackend,
} from '../utils/test-backend.js';
import type { BackendLogger } from '../../src/context.js';
import { HostRepo } from '../../src/repos/host-repo.js';
import { HostTokenService } from '../../src/auth/host-token.js';

const silentBackendLogger: BackendLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const silentDaemonLogger: DaemonLogger = {
  filePath: '/dev/null',
  logControl: createDaemonLogControl('warn'),
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  close: async () => {},
};

/**
 * One captured frame as the harness observed it on the backend
 * side. `frame` is the schema-parsed object handed to
 * `HostWsEventSink.onEvent` — the same normalized object the
 * production fanout consumes. We do not record raw bytes
 * (transport bytes are explicitly OUT of scope per parity claim).
 */
export interface CapturedHostWsEvent {
  hostId: string;
  connectionId: string;
  frame: OutboundDaemonToServerEventFrame;
  /** Monotonic clock at the moment the wrapper saw the event. */
  observedAt: number;
}

/** Disconnect records captured by the wrapper, in order. */
export interface CapturedHostWsDisconnect {
  hostId: string;
  connectionId: string;
  observedAt: number;
}

export interface G2Harness {
  /** Booted standalone backend. The harness seeds and inspects rows no
   *  production writer/reader touches, so it boots through
   *  `startTestBackend` and keeps the server's own connection
   *  (#task:1983 W5). */
  backend: TestRunningBackend;
  /** Live host id minted via `HostRepo.claimOrCreateLocal`. */
  hostId: string;
  /** Owning user (always `'local'` — uses the openTestDb fixture). */
  userId: string;
  /** Long-lived host token bound to `hostId`. */
  hostToken: string;
  /** `server_url` written to the daemon's config (matches
   *  `backend.url`). */
  serverUrl: string;
  /** Path of the daemon's `daemon-config.json` (per the resolver's
   *  `localComputer.daemonConfig` coordinate). */
  daemonConfigPath: string;
  /** The `.silverhand` directory the backend + daemon share. Tests
   *  that boot a real daemon (`bootDaemonWithSupervisor`) place
   *  socket / pidfile / logs / runtime-pids under this root so the
   *  whole fixture tears down with a single `rmSync(tempDir)`. */
  silverhandDir: string;
  /** Boots a real `OutboundDaemonClient` against the harness'
   *  config. Returns a stop handle. Tests may call this multiple
   *  times in sequence (later commits' reconnect tests). */
  bootDaemon: () => Promise<{
    client: OutboundDaemonClient;
    stop: (reason?: string) => void;
  }>;
  /** All events the recording wrapper has observed, in order. */
  events: CapturedHostWsEvent[];
  /** All disconnects the wrapper has observed, in order. */
  disconnects: CapturedHostWsDisconnect[];
  /**
   * D4.b-6: close the current `backend` and bring up a fresh one
   * against the SAME `dbPath` / `silverhandDir`, re-writing
   * `daemon-config.json` with the new bound port (and the
   * unchanged `host_id` / `host_token` — proving credentials
   * persist across a backend restart). The harness's `backend` /
   * `serverUrl` / `events` / `disconnects` are swapped in place
   * so subsequent assertions transparently target the new
   * backend. The daemon (if running) will reconnect to the new
   * URL on its next config poll.
   */
  restartBackend: () => Promise<void>;
  /** Tear everything down — close daemon, close backend, rm temp dir. */
  shutdown: () => Promise<void>;
}

export interface G2HarnessOptions {
  /** Override the test user id. Defaults to `'local'` (the
   *  `openTestDb` fixture user). */
  userId?: string;
  /** Override the bind hostname. Defaults to `'127.0.0.1'`. */
  hostname?: string;
  /** Toggle backend logging — useful when debugging a failing
   *  test. Default: silent. */
  verbose?: boolean;
  /** Lifecycle tests opt into a fail-closed preflight that prints every
   * temp coordinate before any backend/daemon subprocess starts. */
  assertIsolation?: boolean;
}

function pathsOverlap(left: string, right: string): boolean {
  const leftToRight = relative(resolve(left), resolve(right));
  const rightToLeft = relative(resolve(right), resolve(left));
  const contains = (candidate: string) =>
    candidate === '' || (!candidate.startsWith('..') && !isAbsolute(candidate));
  return contains(leftToRight) || contains(rightToLeft);
}

function assertIsolatedTestRoot(tempRoot: string, coordinates: readonly string[]): void {
  const liveRoots = [
    defaultAppRoot(),
    join(homedir(), '.qoder'),
    join(homedir(), '.config', 'qoder'),
    ...(process.env['SILVERHAND_DATA_DIR']
      ? [process.env['SILVERHAND_DATA_DIR']!]
      : []),
  ];
  const root = resolve(tempRoot);
  for (const coordinate of coordinates) {
    const absolute = resolve(coordinate);
    if (!pathsOverlap(root, absolute) || absolute === root) {
      throw new Error(`G2 isolation violation: ${absolute} is outside temp root ${root}`);
    }
    for (const liveRoot of liveRoots) {
      if (pathsOverlap(absolute, liveRoot)) {
        throw new Error(
          `G2 isolation violation: ${absolute} overlaps live root ${resolve(liveRoot)}`,
        );
      }
    }
  }
  process.stderr.write(
    `[g2-isolation] ${JSON.stringify({ tempRoot: root, coordinates })}\n`,
  );
}

/**
 * Boot a standalone backend with the wrapping event-sink observer
 * installed, claim a local host + issue its token, and write the
 * daemon-config.json the production `OutboundDaemonClient` expects.
 * Does NOT start the daemon — call `bootDaemon()` from your test
 * for that, so tests can assert pre-attach state if needed.
 */
export async function bootG2Harness(
  opts: G2HarnessOptions = {},
): Promise<G2Harness> {
  const tempDir = mkdtempSync(join(tmpdir(), 'silverhand-g2-'));
  const dbPath = join(tempDir, 'silverhand.db');
  const silverhandDir = join(tempDir, '.silverhand');
  if (opts.assertIsolation) {
    assertIsolatedTestRoot(tempDir, [dbPath, silverhandDir]);
  }
  const verbose = opts.verbose ?? false;
  const userId = opts.userId ?? 'local';

  const events: CapturedHostWsEvent[] = [];
  const disconnects: CapturedHostWsDisconnect[] = [];

  // Bootstrap the standalone server config the same way production
  // does: mode=remote, an url placeholder (rewritten post-listen).
  const serverConfig: ServerConfig = {
    mode: 'remote',
    url: 'http://127.0.0.1:0',
    auth_token: 'unused-in-standalone-test',
    refresh_token: null,
    child_sessions: {
      max_concurrent_per_parent: null,
      spawn_cooldown_seconds: null,
      max_depth: 1,
    },
  };

  const backend = await startTestBackend({
    mode: 'standalone',
    dbPath,
    ...resolveBackendDataPaths(silverhandDir),
    serverConfig,
    listen: { hostname: opts.hostname ?? '127.0.0.1', port: 0 },
    logger: verbose ? consoleBackendLogger() : silentBackendLogger,
    testHooks: {
      // Cindy P1 #task:660: the wrapper FAILS loud if `startBackend`
      // hands the wrap factory `undefined` (i.e. standalone mode did
      // not install `OutboundRuntimeEventFanout`). Without that
      // strict check a regression that drops the fanout install
      // would still see B1's ready-frame tests stay green because
      // the recording observer would happily capture frames in
      // isolation.
      wrapHostWsEventSink: wrapWithStrictRecording(events, disconnects),
    },
  });

  // The fixture user 'local' is registered by `openTestDb` in unit
  // tests, but here we boot a real backend that performs its own
  // migrations against a fresh disk DB. Insert the user row
  // directly via the same shape `openTestDb` uses, so route ACL +
  // host ownership wiring see a known principal.
  const now = Date.now();
  backend.context.db
    .prepare(
      `INSERT OR IGNORE INTO users (id, name, display_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(userId, `${userId}-test`, `${userId} Test User`, now, now);

  // Claim a local host for the user. `claimOrCreateLocal` is the
  // production path (Stage B.4 `host_claim_or_create`); using it
  // here keeps the harness on the same code path the desktop would
  // exercise on first launch.
  const hostRepo = new HostRepo(backend.context.db);
  const { host } = hostRepo.claimOrCreateLocal({
    userId,
    installationId: `inst-${userId}-${now}`,
    preferredName: 'g2-harness-host',
    now,
  });
  const tokens = new HostTokenService(createSqliteHostPersistence(backend.context.db));
  const issued = tokens.issueHostToken({ hostId: host.id });
  const hostToken = issued.hostToken;

  const daemonConfigPath = join(
    silverhandDir,
    DAEMON_HOST_CONFIG_FILENAME,
  );
  const config: DaemonHostConfig = {
    server_url: backend.url,
    host_id: host.id,
    host_token: hostToken,
  };
  // Use the production atomic writer so we exercise the same
  // disk-layout invariants the desktop hits.
  writeHostConfigAtomic(daemonConfigPath, config);

  const harness: G2Harness = {
    backend,
    hostId: host.id,
    userId,
    hostToken,
    serverUrl: backend.url,
    daemonConfigPath,
    silverhandDir,
    events,
    disconnects,
    bootDaemon: async () => bootHarnessDaemon(daemonConfigPath),
    restartBackend: async () => {
      // Close the current backend cleanly so its port releases. The
      // daemon's still-alive OutboundDaemonClient will drop the WS
      // here; it then polls `daemon-config.json` and reconnects on
      // the next desired-config swap. We rewrite the config with
      // the SAME `host_id` / `host_token` to prove the credential
      // survives a backend restart on the same DB.
      await harness.backend.close().catch(() => undefined);
      const newBackend = await startTestBackend({
        mode: 'standalone',
        dbPath,
        ...resolveBackendDataPaths(silverhandDir),
        serverConfig,
        listen: { hostname: opts.hostname ?? '127.0.0.1', port: 0 },
        logger: verbose ? consoleBackendLogger() : silentBackendLogger,
        testHooks: {
          wrapHostWsEventSink: wrapWithStrictRecording(events, disconnects),
        },
      });
      harness.backend = newBackend;
      harness.serverUrl = newBackend.url;
      writeHostConfigAtomic(daemonConfigPath, {
        server_url: newBackend.url,
        host_id: host.id,
        host_token: hostToken,
      });
    },
    shutdown: async () => {
      await harness.backend.close().catch(() => undefined);
      rmSync(tempDir, { recursive: true, force: true });
    },
  };

  // The 'daemon-config' path may live under a parent directory not
  // yet created — `writeHostConfigAtomic` mkdirs the parent on its
  // own, so by this point the daemon can open the file for reading.
  return harness;
}

/** Spawn a real `OutboundDaemonClient`. The client polls
 *  `daemon-config.json` and reconnects on its own.
 *
 *  Returns the client + a `stop()` for tests to call in their
 *  cleanup. Tests may also call `client.stop(...)` directly. */
async function bootHarnessDaemon(configPath: string): Promise<{
  client: OutboundDaemonClient;
  stop: (reason?: string) => void;
}> {
  const daemonStartedAt = Date.now();
  const helloResult = createDaemonHelloResult(
    `__g2_harness__-${process.pid}-${daemonStartedAt}`,
  );
  const clientOpts: OutboundDaemonClientOptions = {
    configPath,
    logger: silentDaemonLogger,
    // Production daemon's ready event sets `socket_path` for the
    // IPC handshake fallback; the outbound projection strips that
    // field on the wire (see
    // `outboundEventFanout.outboundEventToEventFrame`). The harness
    // uses the production constructor directly so the frame we
    // observe on the server is exactly what a real daemon would
    // emit.
    readyEvent: () => ({
      event: 'ready',
      ...helloResult,
      socket_path: '__g2_harness_no_ipc__',
      daemon_pid: process.pid,
      // A reconnect is a new socket, not a new daemon generation. Production
      // captures this once in runDaemon(); keep the G2 harness equally stable
      // or custody claims become stale merely because the backend restarted.
      started_at: daemonStartedAt,
    }),
    // Very fast config-poll for tests; production default is much
    // larger to avoid spinning on disk.
    configPollMs: 50,
    // Tight backoff so re-attach tests (later commits) stay
    // deterministic without `setTimeout` waiting.
    backoff: {
      minDelayMs: 25,
      maxDelayMs: 100,
      factor: 2,
      jitterRatio: 0,
    },
    heartbeat: {
      pingIntervalMs: 10_000,
      pongTimeoutMs: 5_000,
    },
  };
  const client = new OutboundDaemonClient(clientOpts);
  client.start();
  return {
    client,
    stop: (reason = 'g2_harness_shutdown') => client.stop(reason),
  };
}

/**
 * D4.b-2 — Boot a real in-process daemon with a real `Supervisor`
 * wired in. Use this instead of `harness.bootDaemon()` when the test
 * needs to exercise the full backend→daemon `runtime_*` dispatch +
 * `runtime_parsed_event` projection path (not just attach / ready
 * frame parity).
 *
 * Composition (per Cindy `_5NUY2CzOF9N80pM` boundary #1: real
 * listener / WS / HostClient / dispatcher / fanout; only the runtime
 * driver is fake):
 *
 *   - Real `runDaemon(...)` constructs the production
 *     `IntentDispatcher` + `OutboundSupervisor` + `DaemonServer`.
 *   - `hostConfigPath` points at the harness's daemon-config.json so
 *     the CLI auto-attach path opens the outbound WS to the backend
 *     (same code production runs on a manual `--host-config` daemon
 *     launch).
 *   - The injected `SupervisorContract` is a real `Supervisor` whose
 *     `driverFor` / `resolveBinary` / `spawnFn` seams are wired to a
 *     test-supplied fake driver + fixture binary. The supervisor
 *     itself is unchanged from production: it owns the spawn,
 *     stdout pump, `driver.parseLine` invocation, and
 *     `runtime_parsed_event` emission. Only the *interpretation* of
 *     stdout lines (i.e. the Driver) is faked.
 *
 * **R4 (this IPC is local supervisor/control, not server↔daemon
 * formal semantics)**: the Unix socket the daemon binds for IPC
 * isn't exercised by these tests; we never open a `HostClient`
 * against `socketPath`. The outbound WS path is what's under test.
 */
export interface DaemonWithSupervisorOptions {
  /** Fake Driver factory; called by Supervisor on each
   *  `driverFor(kind)`. Test passes a stub whose `binary` points at
   *  a fixture script and whose `parseLine` interprets a sentinel
   *  stdout line as the parsed event the test wants to fan out. */
  driverFor: (kind: RuntimeKind) => Driver;
  /** Pin the resolved binary path (and the version the daemon would
   *  have probed). Defaults to returning the driver's declared
   *  `.binary` verbatim with no version — i.e. tests that point the
   *  driver at an absolute fixture path get that path used unchanged,
   *  and version-gated driver capabilities fail closed. */
  resolveRuntime?: SupervisorOptions['resolveRuntime'];
  /** Override `child_process.spawn`. Defaults to invoking the
   *  resolved binary via the same node interpreter (`execPath`) so
   *  `.cjs` fixtures don't need `chmod +x`. */
  spawnFn?: SupervisorOptions['spawnFn'];
  /**
   * Launcher embedded in the generated per-runtime `silverhand` shim.
   * Defaults to `true` for G2 tests that do not execute the CLI. A test
   * proving spawned-child auth may point this at the repository CLI so the
   * child itself crosses the canonical HTTP route with its injected bearer.
   */
  localSilverhandCliLauncher?: SupervisorOptions['localSilverhandCliLauncher'];
  /**
   * The EXACT agents root the daemon resolves every agent L1/L2
   * coordinate under. Defaults to a dir inside the harness's own
   * daemon sandbox; pass it when the test asserts against its own
   * tree (#task:1813 — the root is a required production option,
   * never a test hook).
   */
  agentHomeRootDir?: string;
  /**
   * D4.d D6 — narrow test hooks on `RunDaemonOptions.testHooks`,
   * pinned by Cindy P1-1 (`d4IID_Nnn1VShRa5`). The production
   * dispatcher slot ALWAYS calls the real `materializeAgent`;
   * tests can only inject a deterministic typed
   * `AgentMaterializeError` BEFORE `materializeAgent` runs. There is
   * no home-dir seam: the agents root is an ordinary production
   * option (see `agentHomeRootDir`).
   * No handler-replacement seam, no embedder-facing API for
   * rewriting `agent_materialize` formal semantics.
   */
  testHooks?: NonNullable<Parameters<typeof runDaemon>[0]['testHooks']>;
}

export interface DaemonWithSupervisorHandle {
  daemon: RunningDaemon;
  stop: (reason?: string) => Promise<void>;
}

export interface DesktopSupervisedDaemonHandle {
  daemon: DaemonHandle;
  generationChanges: DaemonGenerationInfo[];
  stop: () => Promise<void>;
}

/**
 * Launch the isolated daemon fixture through the same production process
 * supervisor Desktop main uses. This is deliberately distinct from
 * `bootDaemonWithSupervisor`: that helper proves the daemon's inner contract,
 * while this one keeps the outer restart/generation observer in the tree.
 */
export async function bootDesktopSupervisedDaemon(
  harness: G2Harness,
  opts: { shortWatchdogs?: boolean } = {},
): Promise<DesktopSupervisedDaemonHandle> {
  // Keep Unix-socket coordinates below macOS' ~104-byte sockaddr_un limit.
  const daemonDir = join(harness.silverhandDir, 'd');
  const logDir = join(daemonDir, 'l');
  const runtimePidRootDir = join(daemonDir, 'p');
  const agentHomeRootDir = join(daemonDir, 'a');
  const socketPath = join(daemonDir, 'd.sock');
  const pidFilePath = join(daemonDir, 'd.pid');
  assertIsolatedTestRoot(harness.silverhandDir, [
    socketPath,
    pidFilePath,
    logDir,
    runtimePidRootDir,
    agentHomeRootDir,
    harness.daemonConfigPath,
  ]);
  mkdirSync(logDir, { recursive: true });
  mkdirSync(runtimePidRootDir, { recursive: true });
  mkdirSync(agentHomeRootDir, { recursive: true });
  const fixture = join(
    dirname(fileURLToPath(import.meta.url)),
    '_fixtures/desktop-supervised-daemon.ts',
  );
  const tsxLoader = join(
    dirname(fileURLToPath(import.meta.url)),
    '../../../host/node_modules/tsx/dist/loader.mjs',
  );
  const daemon = await spawnDaemonChild({
    launcher: {
      command: execPath,
      args: [
        '--import',
        tsxLoader,
        fixture,
        '--test-agent-home-root',
        agentHomeRootDir,
        '--test-short-watchdogs',
        opts.shortWatchdogs ? 'true' : 'false',
      ],
    },
    socketPath,
    pidFilePath,
    logDir,
    hostConfigPath: harness.daemonConfigPath,
    runtimePidRootDir,
    alsoStderr: false,
    readyTimeoutMs: 15_000,
    backoffSchedule: [10, 20, 40],
    maxRestarts: 3,
    restartWindowMs: 10_000,
    successResetMs: 60_000,
  });
  const generationChanges: DaemonGenerationInfo[] = [];
  daemon.onDaemonGenerationChanged(info => generationChanges.push(info));
  return {
    daemon,
    generationChanges,
    stop: () => daemon.kill({ gracefulMs: 1_000 }),
  };
}

export async function bootDaemonWithSupervisor(
  harness: G2Harness,
  opts: DaemonWithSupervisorOptions,
): Promise<DaemonWithSupervisorHandle> {
  const daemonDir = join(harness.silverhandDir, 'daemon');
  const logDir = join(daemonDir, 'logs');
  const runtimePidRootDir = join(daemonDir, 'runtime-pids');
  mkdirSync(logDir, { recursive: true });
  mkdirSync(runtimePidRootDir, { recursive: true });
  const socketPath = join(daemonDir, 'daemon.sock');
  const pidFilePath = join(daemonDir, 'daemon.pid');

  // Default spawn: launch the resolved binary via node so .cjs
  // fixtures don't need to be marked executable. This is the same
  // pattern `packages/host/tests/supervisor.test.ts` uses.
  //
  // A benign 'error' listener is attached to every spawned child: a
  // late delivery/restart can ask the supervisor to spawn a runtime
  // *after* the suite's `afterAll` has `rmSync`'d the runtime cwd,
  // which makes Node emit an async `spawn ... ENOENT` on the child.
  // The supervisor only listens for 'exit'/'close', so that error
  // would otherwise surface as an unhandled exception that fails the
  // run even though every test passed (observed only under full-suite
  // timing). We own the returned child here, so swallowing its error
  // is the correct place to absorb the teardown race — it does not
  // suppress the supervisor's own exit/close-based failure handling.
  const defaultSpawnFn: NonNullable<SupervisorOptions['spawnFn']> = (
    bin,
    args,
    options,
  ): ChildProcess => {
    const child = nodeSpawn(execPath, [bin, ...args.slice(1)], options as SpawnOptions);
    child.on('error', () => {
      /* swallow teardown-race spawn ENOENT (cwd rm'd during shutdown) */
    });
    return child;
  };

  const daemon = await runDaemon({
    socketPath,
    pidFilePath,
    logDir,
    hostConfigPath: harness.daemonConfigPath,
    installSignals: false,
    writeStdoutHandshake: false,
    alsoStderr: false,
    runtimePidRootDir,
    // #task:1596 / relocation-v1 §7-4 — keep the DURABLE agent tree inside the
    // test sandbox. #task:1813: the agents root is REQUIRED (no homedir
    // fallback, no home-dir test hook), so the harness always states one; a
    // test asserting against its own tree passes `agentHomeRootDir`.
    agentHomeRootDir: opts.agentHomeRootDir ?? join(daemonDir, 'agents'),
    daemonIdentityPath: null,
    testHooks: opts.testHooks,
    supervisorFactory: ({
      emit,
      logger,
      daemonInstanceId,
      runtimePidRootDir: pidRoot,
      runtimeStartResolveDeps,
      controlPlaneServerUrl,
      agentHomeMutationCoordinator,
    }) =>
      new Supervisor({
        emit,
        logger,
        driverFor: opts.driverFor,
        resolveRuntime:
          opts.resolveRuntime ??
          (async (_kind, fallback) => ({ binary: fallback, version: null })),
        spawnFn: opts.spawnFn ?? defaultSpawnFn,
        daemonInstanceId,
        runtimePidRootDir: pidRoot,
        runtimeStartResolveDeps,
        controlPlaneServerUrl,
        agentHomeMutationCoordinator,
        localSilverhandCliLauncher:
          opts.localSilverhandCliLauncher ?? { command: 'true', args: [] },
        // Tight watchdogs so a misbehaving fixture surfaces fast
        // rather than hanging at the production-default 5min cap.
        initLivenessSilenceMs: 10_000,
        initPreProtocolCapMs: 10_000,
        initPostProtocolMs: 10_000,
        sigtermToSigkillMs: 200,
        sigkillTimeoutMs: 1_000,
      }),
  });

  return {
    daemon,
    stop: async (reason = 'g2_harness_shutdown') => {
      await daemon.stop(reason).catch(() => undefined);
    },
  };
}

/**
 * Wrap the real fanout sink in a recording observer.
 *
 * The wrapper is **strictly delegating**:
 *
 *   - `onEvent` calls `real.onEvent(...)` **first**; only if the
 *     real fanout returns without throwing does the wrapper push
 *     the frame into `events[]`. A real-fanout throw therefore
 *     never leaves a captured frame behind — `waitForReadyFrame`
 *     fails / times out and the test fails for the right reason
 *     (Cindy P1 #task:660: "fake real sink throw → event must
 *     not enter events[]").
 *   - `onDisconnect` mirrors the same ordering (delegate first,
 *     then record) so disconnect semantics stay consistent.
 *   - `real === undefined` is **not** a legitimate input for B1 /
 *     B2 / G2. The whole point of the harness is that the
 *     standalone backend installs `OutboundRuntimeEventFanout`.
 *     If a future standalone-mode regression drops the fanout
 *     install, the wrap factory `wrapHostWsEventSink` must fail
 *     loud rather than let the harness keep recording in
 *     isolation (which would mask the missing-fanout bug).
 *
 * The observer is exposed through `harness.events` only — no
 * subscription / unsubscribe API. Tests inspect the array
 * directly and rely on the harness teardown to drop the wrapper.
 */
export function makeRecordingSink(
  real: HostWsEventSink,
  events: CapturedHostWsEvent[],
  disconnects: CapturedHostWsDisconnect[],
): HostWsEventSink {
  return {
    onEvent: (hostId, frame, connectionId) => {
      // Delegate first. If the real fanout throws, the rethrow
      // propagates out of `HostWsConnection.onMessage` exactly as
      // it would in production, AND the wrapper does NOT record
      // the frame — so a test that asserts on `events[]` will
      // observe the failure rather than be fooled by an
      // observer-only success path.
      real.onEvent(hostId, frame, connectionId);
      events.push({
        hostId,
        connectionId,
        frame,
        observedAt: Date.now(),
      });
    },
    onDisconnect: (hostId, connectionId) => {
      real.onDisconnect?.(hostId, connectionId);
      disconnects.push({
        hostId,
        connectionId,
        observedAt: Date.now(),
      });
    },
  };
}

/**
 * The wrap factory passed to `startBackend`'s `testHooks`. Cindy
 * P1 #task:660: if `startBackend` does not install a real fanout
 * (i.e. passes `undefined` into the wrap), fail the harness boot
 * loudly instead of returning a recording-in-isolation sink — a
 * silent fallback would let B1 stay green even after a regression
 * dropped the production fanout install.
 */
function wrapWithStrictRecording(
  events: CapturedHostWsEvent[],
  disconnects: CapturedHostWsDisconnect[],
): (real: HostWsEventSink | undefined) => HostWsEventSink {
  return real => {
    if (!real) {
      throw new Error(
        'g2-harness: wrapHostWsEventSink received undefined fanout — ' +
          'standalone backend must install OutboundRuntimeEventFanout ' +
          'for G2 harness assertions to be meaningful',
      );
    }
    return makeRecordingSink(real, events, disconnects);
  };
}

/**
 * Bounded poll helper — wait until `predicate()` returns truthy
 * or the deadline elapses. Throws with a descriptive message on
 * timeout so test failures point at the unmet condition rather
 * than the bare `Promise<never>`.
 *
 * Used in place of wall-clock `setTimeout(...)` `await` patterns.
 * Cindy's boundary #4: "deterministic, no wall-clock backoff
 * betting".
 */
export async function waitFor<T>(
  predicate: () => T | null | undefined | false,
  opts: {
    timeoutMs?: number;
    intervalMs?: number;
    label?: string;
    /**
     * D4.c C9-2: optional diagnostic hook fired on timeout. The
     * returned value is appended to the thrown Error's message via
     * `JSON.stringify`. Use it to capture observable state at the
     * moment of failure (e.g. DB row, controller attachment, cache
     * size) so an intermittent flake leaves enough evidence on the
     * next occurrence to root-cause it without re-running. Errors
     * thrown by the hook are caught and reported as
     * `{ onTimeoutError: <message> }` rather than overriding the
     * original timeout error.
     */
    onTimeout?: () => unknown;
  } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 2_000;
  const intervalMs = opts.intervalMs ?? 10;
  const label = opts.label ?? 'predicate';
  const deadline = Date.now() + timeoutMs;
  // First-pass synchronous check so a satisfied predicate returns
  // immediately without a microtask round trip.
  const first = predicate();
  if (first) return first as T;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, intervalMs));
    const result = predicate();
    if (result) return result as T;
  }
  let diagnostic: unknown;
  if (opts.onTimeout) {
    try {
      diagnostic = opts.onTimeout();
    } catch (err) {
      diagnostic = {
        onTimeoutError: err instanceof Error ? err.message : String(err),
      };
    }
  }
  const suffix =
    diagnostic === undefined
      ? ''
      : ` :: diagnostic=${JSON.stringify(diagnostic)}`;
  throw new Error(
    `waitFor: timed out after ${timeoutMs}ms waiting for ${label}${suffix}`,
  );
}

/** Wait until the controller reports an attachment for `hostId`. */
export async function waitForAttachment(
  controller: HostWsServerController,
  hostId: string,
  timeoutMs = 2_000,
): Promise<NonNullable<ReturnType<HostWsServerController['getAttachment']>>> {
  return waitFor(
    () => controller.getAttachment(hostId) ?? null,
    { timeoutMs, label: `attachment for host ${hostId}` },
  );
}

/**
 * D4.c C9-2 — wait until `controller.getAttachment(hostId)` returns
 * a NEW attachment whose `connectionId` differs from `prevConnectionId`.
 *
 * Use this in restart / reconnect tests where `waitForAttachment`'s
 * "any non-null attachment" predicate is semantically weaker than
 * what the test actually wants. The "fresh" predicate explicitly
 * waits for the observable state transition the test cares about —
 * a fresh `hostws-*` connectionId distinct from `prevConnectionId`.
 *
 * **Cindy boundary** (`Acsun_kzRmpNmXZo` + `cXpfB1KnydlUosFO`): this
 * helper is **defensive harness cleanup** to make the restart-flow
 * assertion semantically precise. It does NOT by itself prove a
 * product-side race or any stale-snapshot scenario; the post-restart
 * controller is a fresh instance and cannot return entries from a
 * prior backend's controller. If a flake recurs after this helper
 * is in place, the timeout `onTimeout` diagnostic on the calling
 * `waitFor` should capture observable state for root-cause analysis.
 */
export async function waitForFreshAttachment(
  controller: HostWsServerController,
  hostId: string,
  prevConnectionId: string | null,
  timeoutMs = 2_000,
): Promise<NonNullable<ReturnType<HostWsServerController['getAttachment']>>> {
  return waitFor(
    () => {
      const attached = controller.getAttachment(hostId);
      if (!attached) return null;
      if (attached.connectionId === prevConnectionId) return null;
      return attached;
    },
    {
      timeoutMs,
      label: `fresh attachment for host ${hostId} (prev=${prevConnectionId ?? 'null'})`,
    },
  );
}

function consoleBackendLogger(): BackendLogger {
  /* istanbul ignore next — debug aid, opt-in via `{ verbose: true }`. */
  return {
    info: (obj, msg) => console.info('[backend]', msg, obj),
    warn: (obj, msg) => console.warn('[backend]', msg, obj),
    error: (obj, msg) => console.error('[backend]', msg, obj),
  };
}

/**
 * relocation-v1 §7-4 — workspace creation is a pure DB write and L2
 * materializes lazily from the agent-centric coordinate; there is no daemon
 * provision to dispatch. The old `provisionWorkspaceOnDaemon` leg only ever
 * asserted the outbound adapter was wired (the invariant it implicitly
 * depended on), so it is named for what it actually checks — no retired
 * product concept wrapped as a "documented no-op". The runtime-start flow
 * performs any lazy materialization on its own.
 */
export async function assertOutboundAdapterWired(
  backend: RunningBackend,
): Promise<void> {
  const adapter = backend.context.outboundFrameAdapter?.();
  if (!adapter) throw new Error('outbound frame adapter unwired in harness');
}
