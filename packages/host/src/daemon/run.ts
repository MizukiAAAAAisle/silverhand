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

  const startedAt = Date.now();
  const dispatcher = new IntentDispatcher({ logger, startedAt });
  const server = new DaemonServer({
    socketPath: opts.socketPath,
    dispatcher,
    logger,
  });

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

  let stopped = false;
  const stop = async (reason: string): Promise<void> => {
    if (stopped) return;
    stopped = true;
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
