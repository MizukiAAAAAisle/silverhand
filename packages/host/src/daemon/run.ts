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
import { IntentDispatcher } from './dispatcher.js';
import { DaemonServer } from './server.js';
import { createDaemonLogger, type DaemonLogger } from './logger.js';
import { encodeFrame, type EventFrame } from '../protocol.js';
import { DAEMON_VERSION, createDaemonHelloResult } from './version.js';
import { logDaemon } from './daemon-logging.js';
import {
  defaultDaemonIdentityPath,
  readOrCreateDaemonIdentity,
} from './identity.js';
import { OutboundDaemonClient } from './outbound-client.js';
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
  let outboundClient: OutboundDaemonClient | null = null;
  const supervisor = opts.supervisorFactory
    ? opts.supervisorFactory({
        emit: event => broadcaster(event),
        logger,
        daemonInstanceId,
        runtimePidRootDir,
      })
    : undefined;
  const dispatcher = new IntentDispatcher({
    logger,
    startedAt,
    helloResult,
    supervisor,
  });
  const server = new DaemonServer({
    socketPath: opts.socketPath,
    dispatcher,
    logger,
  });
  broadcaster = event => {
    server.broadcast(event);
    outboundClient?.sendEvent(event);
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
    outboundClient = new OutboundDaemonClient({
      configPath: opts.hostConfigPath,
      logger,
      readyEvent,
    });
    outboundClient.start();
  }

  let stopped = false;
  const stop = async (reason: string): Promise<void> => {
    if (stopped) return;
    stopped = true;
    logDaemon(logger, { action: 'shutting_down', pid: process.pid });
    outboundClient?.sendEvent({ event: 'shutting_down', reason });
    outboundClient?.stop(reason);
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
