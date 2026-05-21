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
import { DAEMON_VERSION } from './version.js';
import { logDaemon } from './daemon-logging.js';
import type { Supervisor } from './supervisor.js';

export interface RunDaemonOptions {
  /** Absolute path where the daemon should bind its Unix socket. */
  socketPath: string;
  /** Absolute path of the pid file the daemon should claim. */
  pidFilePath: string;
  /** Directory for the daemon's own JSONL log file. */
  logDir: string;
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
  /**
   * Optional supervisor factory. The daemon constructs the supervisor
   * AFTER the server is bound, passing an `emit` callback that
   * broadcasts events to every live socket connection (with
   * runtime_output backpressure applied per §2.2.2). Used by:
   *
   *   - tests, which inject `FakeSupervisor` to validate the full
   *     intent → supervisor → event-broadcast → HostClient.subscribe
   *     path without a real CLI child process.
   *   - PR-2 step 2, which will plug the real CM-derived supervisor
   *     here at production wiring time.
   *
   * Daemons constructed without this factory still function as a PR-1
   * surface (ping/status/echo only); runtime_* intents return
   * `internal_error` because the dispatcher has no supervisor wired.
   */
  supervisorFactory?: (deps: {
    emit: (event: EventFrame) => void;
    logger: DaemonLogger;
  }) => Supervisor;
}

export interface RunningDaemon {
  socketPath: string;
  pidFilePath: string;
  logger: DaemonLogger;
  /**
   * Broadcast an unsolicited event to every live connection. Used by
   * a Supervisor's `emit` callback to surface `runtime_*` events to
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

  const startedAt = Date.now();

  // Resolve the circular dep between supervisor (needs `emit`),
  // dispatcher (needs the supervisor), and server (needs the
  // dispatcher; provides `broadcast`) by giving the supervisor a
  // closure-bound `emit` that we wire to `server.broadcast` once the
  // server exists. Until that point, `emit` is a no-op — the
  // supervisor is constructed but won't fire events before
  // `server.start()` returns anyway.
  let broadcaster: (event: EventFrame) => void = () => {};
  const supervisor = opts.supervisorFactory?.({
    emit: event => broadcaster(event),
    logger,
  });
  const dispatcher = new IntentDispatcher({
    logger,
    startedAt,
    supervisor,
  });
  const server = new DaemonServer({
    socketPath: opts.socketPath,
    dispatcher,
    logger,
  });
  broadcaster = event => server.broadcast(event);

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
    const readyEvent: EventFrame = {
      event: 'ready',
      socket_path: opts.socketPath,
      daemon_pid: process.pid,
      daemon_version: DAEMON_VERSION,
      started_at: startedAt,
    };
    process.stdout.write(encodeFrame(readyEvent));
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

  let stopped = false;
  const stop = async (reason: string): Promise<void> => {
    if (stopped) return;
    stopped = true;
    logDaemon(logger, { action: 'shutting_down', pid: process.pid });
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
    broadcast: event => server.broadcast(event),
    stop,
  };
}
