/**
 * Helper for Electron main / dev:headless to spawn the daemon as a
 * managed child process and learn its socket path.
 *
 * Lifecycle:
 *
 *   spawnDaemonChild({ launcher, socketPath, pidFilePath, logDir })
 *     → spawns `<launcher.command> <launcher.args>... <daemon args>`
 *     → reads stdout line-by-line waiting for the `ready` handshake
 *     → resolves with `{ pid, socketPath, kill, onExit }`
 *
 * The launcher is host-supplied (Electron main resolves it via the
 * same `process.execPath + ELECTRON_RUN_AS_NODE=1` trick used for the
 * CLI; tests can hand it a plain `node` + daemon entry script path).
 *
 * Restart policy:
 *
 *  - PR-1 ships a *capped restart loop*: if the daemon exits non-zero
 *    within `restartWindowMs`, restart it; if it crashes
 *    `maxRestarts` times within the window, give up and propagate the
 *    failure via `onExit({ fatal: true })`.
 *  - PR-2 may upgrade this to a circuit breaker; the API surface
 *    here is designed to absorb that without breaking callers.
 *
 * Stderr piping:
 *
 *  - Daemon stderr is forwarded to the parent's stderr by default.
 *    The daemon itself only writes to stderr when `--stderr` is set,
 *    and even then it's prefixed `[daemon ...]` so it doesn't get
 *    confused with backend logs.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import {
  EventFrameSchema,
  HOST_PROTOCOL_VERSION,
  splitNdjson,
  type EventFrame,
} from './protocol.js';
import {
  reclaimStaleDaemonIfPresent,
  ReclaimFailLoudlyError,
  type ReclaimDeps,
} from './daemon/reclaim.js';
import { createDaemonLogger } from './daemon/logger.js';

export interface DaemonLauncher {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface SpawnDaemonOptions {
  launcher: DaemonLauncher;
  socketPath: string;
  pidFilePath: string;
  logDir: string;
  /** Optional Stage D2 outbound WS host-token config path. */
  hostConfigPath?: string | null;
  /** Mirror daemon log lines to stderr too. Default true in dev. */
  alsoStderr?: boolean;
  /** Max time to wait for the `ready` handshake. Default 10_000ms. */
  readyTimeoutMs?: number;
  /** Max non-zero exits per restartWindowMs before we give up. Default 5. */
  maxRestarts?: number;
  /** Sliding window for `maxRestarts`. Default 60_000ms. */
  restartWindowMs?: number;
  /**
   * Stale-daemon reclaim toggle. When true (default), the parent
   * inspects the pid file before spawning and, if it points at a
   * still-live silverhand-daemon of *this* silverhand-dir,
   * SIGTERM/SIGKILLs it before launching a fresh one. Disable for
   * tests that want to assert raw behaviour against an already-
   * running fixture.
   */
  reclaimStaleDaemon?: boolean;
  /** Test override for reclaim deps; production paths use defaults. */
  reclaimDeps?: Partial<ReclaimDeps>;
}

export interface DaemonHandle {
  /** Process pid of the currently-live daemon. Updated across restarts. */
  pid: number;
  /** Socket path the daemon is bound to (echoed from the handshake;
   *  always equals `opts.socketPath` but we surface it so callers can
   *  trust one source of truth). */
  socketPath: string;
  /** Daemon version string from the handshake. */
  daemonVersion: string;
  /**
   * Send SIGTERM to the daemon and wait for exit. Falls back to
   * SIGKILL after `gracefulMs` (default 5_000ms). Disables auto-
   * restart so the daemon stays down. Idempotent.
   */
  kill(opts?: { gracefulMs?: number }): Promise<void>;
  /**
   * Subscribe to fatal-exit notifications: fired when the daemon
   * exceeds the restart budget. NOT fired on intentional `kill()`.
   */
  onExit(handler: (info: { reason: string; code: number | null }) => void): () => void;
}

export async function spawnDaemonChild(opts: SpawnDaemonOptions): Promise<DaemonHandle> {
  const maxRestarts = opts.maxRestarts ?? 5;
  const restartWindowMs = opts.restartWindowMs ?? 60_000;
  const readyTimeoutMs = opts.readyTimeoutMs ?? 10_000;
  const alsoStderr = opts.alsoStderr ?? true;
  const exitHandlers = new Set<(info: { reason: string; code: number | null }) => void>();
  const exitTimes: number[] = [];

  let child: ChildProcess | null = null;
  let lastHandshake: Extract<EventFrame, { event: 'ready' }> | null = null;
  let killed = false;
  let killResolve: (() => void) | null = null;

  // ── Stale-daemon reclaim (PR-2 step 1) ───────────────────────────
  // Run BEFORE the first spawn so a crashed-prior-session daemon
  // doesn't make our child fail to claim the pid file. Disabled in
  // tests that want to assert "two daemons clash" semantics.
  if (opts.reclaimStaleDaemon ?? true) {
    const reclaimLogger = createDaemonLogger({
      dir: opts.logDir,
      alsoStderr,
      base: { component: 'silverhand-spawn-reclaim' },
    });
    try {
      const r = await reclaimStaleDaemonIfPresent({
        pidFilePath: opts.pidFilePath,
        socketPath: opts.socketPath,
        logger: reclaimLogger,
        deps: opts.reclaimDeps,
      });
      if (r.action === 'fail_loudly') {
        await reclaimLogger.close();
        throw new ReclaimFailLoudlyError(r);
      }
      // 'no_pid_file' / 'stale_dead_pid' / 'reclaimed' → safe to
      // proceed; logger captured what happened.
    } finally {
      await reclaimLogger.close();
    }
  }

  const spawnOnce = async (): Promise<Extract<EventFrame, { event: 'ready' }>> => {
    const daemonArgs = [
      '--socket-path', opts.socketPath,
      '--pid-file', opts.pidFilePath,
      '--log-dir', opts.logDir,
      ...(opts.hostConfigPath ? ['--host-config', opts.hostConfigPath] : []),
      ...(alsoStderr ? ['--stderr'] : []),
    ];
    const proc = spawn(
      opts.launcher.command,
      [...opts.launcher.args, ...daemonArgs],
      {
        env: { ...process.env, ...(opts.launcher.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    child = proc;

    // Drain stderr to parent stderr so daemon warnings are visible.
    proc.stderr?.setEncoding('utf8');
    proc.stderr?.on('data', chunk => {
      process.stderr.write(typeof chunk === 'string' ? chunk : String(chunk));
    });

    return new Promise<Extract<EventFrame, { event: 'ready' }>>((resolve, reject) => {
      let settled = false;
      let buffer = '';
      const readyTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { proc.kill('SIGKILL'); } catch { /* already gone */ }
        reject(new Error(`daemon did not emit ready handshake within ${readyTimeoutMs}ms`));
      }, readyTimeoutMs);
      readyTimer.unref?.();

      proc.stdout?.setEncoding('utf8');
      proc.stdout?.on('data', chunk => {
        const { frames, leftover, overflow } = splitNdjson(buffer, chunk as string);
        buffer = leftover;
        if (overflow) {
          if (!settled) {
            settled = true;
            clearTimeout(readyTimer);
            reject(new Error('daemon stdout overflowed before handshake'));
          }
          return;
        }
        for (const line of frames) {
          let parsed: unknown;
          try { parsed = JSON.parse(line); } catch { continue; }
          const validated = EventFrameSchema.safeParse(parsed);
          if (!validated.success) continue;
          if (validated.data.event === 'ready') {
            if (settled) continue;
            settled = true;
            clearTimeout(readyTimer);
            if (validated.data.protocol_version !== HOST_PROTOCOL_VERSION) {
              try { proc.kill('SIGKILL'); } catch { /* already gone */ }
              reject(
                new Error(
                  `daemon stdout ready speaks host protocol_version=${validated.data.protocol_version}; ` +
                    `client expects ${HOST_PROTOCOL_VERSION}. ` +
                    `Daemon version=${validated.data.daemon_version}. ` +
                    'Recovery: stop the stale silverhand-daemon and restart the app/CLI so client and daemon come from the same checkout/build.',
                ),
              );
              return;
            }
            resolve(validated.data);
            return;
          }
        }
      });
      proc.once('error', err => {
        if (settled) return;
        settled = true;
        clearTimeout(readyTimer);
        reject(err);
      });
      proc.once('exit', code => {
        if (settled) return;
        settled = true;
        clearTimeout(readyTimer);
        reject(new Error(`daemon exited (code=${code}) before handshake`));
      });
    });
  };

  const onExit = (code: number | null): void => {
    if (killed) {
      killResolve?.();
      return;
    }
    // Trim exit-time window
    const now = Date.now();
    exitTimes.push(now);
    while (exitTimes.length > 0 && exitTimes[0]! < now - restartWindowMs) {
      exitTimes.shift();
    }
    if (exitTimes.length > maxRestarts) {
      const info = {
        reason: `daemon crashed ${exitTimes.length} times within ${restartWindowMs}ms; giving up`,
        code,
      };
      for (const h of exitHandlers) {
        try { h(info); } catch { /* swallow */ }
      }
      return;
    }
    // Best-effort restart. Errors here propagate to onExit handlers
    // since we no longer have a settle path.
    void (async () => {
      try {
        const handshake = await spawnOnce();
        lastHandshake = handshake;
        handle.pid = handshake.daemon_pid;
        handle.daemonVersion = handshake.daemon_version;
        attachExit();
      } catch (err) {
        const info = {
          reason: `daemon restart failed: ${(err as Error).message}`,
          code: null,
        };
        for (const h of exitHandlers) {
          try { h(info); } catch { /* swallow */ }
        }
      }
    })();
  };

  const attachExit = (): void => {
    child?.once('exit', code => onExit(code));
  };

  const firstHandshake = await spawnOnce();
  lastHandshake = firstHandshake;
  attachExit();

  const handle: DaemonHandle = {
    pid: firstHandshake.daemon_pid,
    socketPath: firstHandshake.socket_path,
    daemonVersion: firstHandshake.daemon_version,
    async kill(killOpts) {
      if (killed) return;
      killed = true;
      const proc = child;
      if (!proc) return;
      const gracefulMs = killOpts?.gracefulMs ?? 5_000;
      await new Promise<void>(resolve => {
        killResolve = resolve;
        const fallback = setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch { /* already gone */ }
        }, gracefulMs);
        fallback.unref?.();
        proc.once('exit', () => {
          clearTimeout(fallback);
          resolve();
        });
        try { proc.kill('SIGTERM'); } catch {
          clearTimeout(fallback);
          resolve();
        }
      });
    },
    onExit(handler) {
      exitHandlers.add(handler);
      return () => { exitHandlers.delete(handler); };
    },
  };
  // Use the captured firstHandshake (`lastHandshake` is updated across
  // restarts but currently equals firstHandshake at return time).
  void lastHandshake;
  return handle;
}
