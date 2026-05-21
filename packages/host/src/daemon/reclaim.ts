/**
 * Stale-daemon kill-and-reclaim — recovery path for the case where
 * the previous Electron / dev:headless session crashed without
 * tearing down the daemon child. Per design lock
 * `docs/silverhand-daemon-pr2-design.md` §1, the recovery is
 * **bounded reclaim**: we only kill a pid we can positively identify
 * as a sibling silverhand-daemon of *this* silverhand-dir. Anything
 * off → fail loudly so the operator can decide.
 *
 * Why not "attach to the existing daemon": the parent loses the kill
 * lever, daemon restart budgets never reset, and repeat-crash
 * patterns become invisible.
 *
 * Why not OS-level single-instance lock (`flock` + child polls
 * parent suicide): cleanest semantically but adds 100+ lines and a
 * polling cost the current single-parent topology doesn't need.
 *
 * The 4 prerequisite checks (ALL must hold; from §1.2.1):
 *
 *  a. `kill(pid, 0)` returns successfully.
 *     EPERM (pid belongs to another uid / pid 1) → **fail loudly**,
 *     do not attempt to kill.
 *  b. `ps -ww -o command= -p <pid>` cmdline contains BOTH
 *     `--socket-path <our-path>` AND `--pid-file <our-path>` tokens.
 *     Plain `silverhand-daemon` is not enough — a sibling silverhand
 *     dir's daemon would also match.
 *  c. If `ping` over the socket succeeds, `ping.daemon_pid` must
 *     equal the conflict pid from the pid-file. Mismatch → fail
 *     loudly (pid-file lies; we'd be killing the wrong process).
 *  d. If ping fails (ECONNREFUSED / timeout) but checks (a) and (b)
 *     passed, accept as a half-dead daemon and proceed to SIGTERM.
 *     Any other ping failure mode → fail loudly.
 *
 * The reclaim itself: SIGTERM, wait `gracefulMs`; if still alive,
 * SIGKILL, wait `killGraceMs`; if still alive, throw.
 *
 * Test seam: `runPs` and `pingDaemon` are injected so unit tests can
 * simulate every guard outcome without spawning a real daemon. The
 * default implementations are wired in `defaultReclaimDeps()`.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { promisify } from 'node:util';
import { encodeFrame, splitNdjson, AnyFrameSchema } from '../protocol.js';
import type { DaemonLogger } from './logger.js';
import { logProcess } from './daemon-logging.js';

const execFileAsync = promisify(execFile);

export interface ReclaimDeps {
  /** Run `ps -ww -o command= -p <pid>` and return the cmdline. */
  runPs: (pid: number) => Promise<string>;
  /**
   * Open a brief connection to the daemon socket, send `ping`,
   * resolve with the reported daemon_pid (or `null` on connection
   * failure / timeout).
   */
  pingDaemon: (
    socketPath: string,
    timeoutMs: number,
  ) => Promise<{ ok: true; daemon_pid: number } | { ok: false; reason: 'unreachable' | 'timeout' | 'invalid_response' }>;
  /** `kill(pid, signal | 0)`. Returns 'alive' | 'gone' | 'eperm'. */
  signalPid: (pid: number, signal: NodeJS.Signals | 0) => 'alive' | 'gone' | 'eperm';
  /** Wait until `signalPid(pid, 0)` returns 'gone' OR timeout. */
  waitForExit: (pid: number, timeoutMs: number) => Promise<'gone' | 'still_alive'>;
}

export interface ReclaimOptions {
  pidFilePath: string;
  socketPath: string;
  logger: DaemonLogger;
  /** SIGTERM graceful budget, default 5_000ms (per §1.3 shiki). */
  gracefulMs?: number;
  /** SIGKILL grace budget, default 2_000ms. */
  killGraceMs?: number;
  /** Ping timeout, default 1_500ms. */
  pingTimeoutMs?: number;
  /** Test override; production builds use defaultReclaimDeps(). */
  deps?: Partial<ReclaimDeps>;
}

export type ReclaimResult =
  | { action: 'no_pid_file' }
  | { action: 'stale_dead_pid'; pid: number }
  | {
      action: 'reclaimed';
      pid: number;
      method: 'sigterm' | 'sigkill';
      cmdline: string;
    }
  | {
      action: 'fail_loudly';
      pid: number;
      check: 'a_eperm' | 'b_cmdline_mismatch' | 'c_ping_pid_mismatch' | 'd_ping_invalid' | 'survived_sigkill';
      detail: string;
    };

export class ReclaimFailLoudlyError extends Error {
  readonly code = 'reclaim_fail_loudly';
  constructor(
    readonly result: Extract<ReclaimResult, { action: 'fail_loudly' }>,
  ) {
    super(
      `kill-and-reclaim refused (check=${result.check}, pid=${result.pid}): ${result.detail}`,
    );
  }
}

/**
 * Production wiring of the reclaim deps. Tests pass overrides via
 * `opts.deps` to simulate failure modes deterministically.
 */
export function defaultReclaimDeps(): ReclaimDeps {
  return {
    runPs: async pid => {
      try {
        const { stdout } = await execFileAsync('ps', [
          '-ww',
          '-o',
          'command=',
          '-p',
          String(pid),
        ]);
        return stdout.toString().trim();
      } catch {
        // ps exits non-zero when pid doesn't exist; treat as empty.
        return '';
      }
    },
    pingDaemon: async (socketPath, timeoutMs) => {
      // One-shot raw `node:net.Socket` round trip — open, send ping,
      // wait for response, close. We don't reuse SocketTransport
      // because reclaim is a different connection lifecycle (we
      // throw the connection away regardless of outcome).
      return new Promise(resolve => {
        const sock = new Socket();
        sock.setEncoding('utf8');
        let buffer = '';
        let settled = false;
        const settle = (
          r:
            | { ok: true; daemon_pid: number }
            | { ok: false; reason: 'unreachable' | 'timeout' | 'invalid_response' },
        ): void => {
          if (settled) return;
          settled = true;
          try {
            sock.destroy();
          } catch {
            /* already gone */
          }
          resolve(r);
        };
        const timer = setTimeout(() => settle({ ok: false, reason: 'timeout' }), timeoutMs);
        timer.unref?.();
        sock.once('error', () => settle({ ok: false, reason: 'unreachable' }));
        sock.once('end', () => settle({ ok: false, reason: 'unreachable' }));
        sock.once('connect', () => {
          // Send ping after connect; the server emits a `ready`
          // event unsolicited on connect, which we filter out below.
          try {
            sock.write(encodeFrame({ id: 'reclaim-ping', intent: 'ping', params: {} }));
          } catch {
            settle({ ok: false, reason: 'unreachable' });
          }
        });
        sock.on('data', chunk => {
          const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
          const { frames, leftover, overflow } = splitNdjson(buffer, text);
          buffer = leftover;
          if (overflow) return settle({ ok: false, reason: 'invalid_response' });
          for (const line of frames) {
            let parsed: unknown;
            try {
              parsed = JSON.parse(line);
            } catch {
              return settle({ ok: false, reason: 'invalid_response' });
            }
            const validated = AnyFrameSchema.safeParse(parsed);
            if (!validated.success) {
              return settle({ ok: false, reason: 'invalid_response' });
            }
            const f = validated.data;
            if ('event' in f) {
              // Skip the unsolicited `ready` event the server sends
              // on every new connection; we want only the ping
              // response.
              continue;
            }
            if ('result' in f) {
              clearTimeout(timer);
              const r = f.result as { daemon_pid?: number };
              if (typeof r.daemon_pid !== 'number') {
                return settle({ ok: false, reason: 'invalid_response' });
              }
              return settle({ ok: true, daemon_pid: r.daemon_pid });
            }
            // error frame — invalid response (could be shutting_down
            // etc.; from reclaim's POV, we can't trust the pid match).
            return settle({ ok: false, reason: 'invalid_response' });
          }
        });
        sock.connect(socketPath);
      });
    },
    signalPid: (pid, signal) => {
      try {
        process.kill(pid, signal);
        return 'alive';
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EPERM') return 'eperm';
        return 'gone';
      }
    },
    waitForExit: async (pid, timeoutMs) => {
      const startedAt = Date.now();
      // Poll every 50ms — short enough to feel snappy, long enough
      // not to spin the CPU.
      while (Date.now() - startedAt < timeoutMs) {
        try {
          process.kill(pid, 0);
        } catch {
          return 'gone';
        }
        await new Promise(r => setTimeout(r, 50));
      }
      return 'still_alive';
    },
  };
}

export async function reclaimStaleDaemonIfPresent(
  opts: ReclaimOptions,
): Promise<ReclaimResult> {
  const deps: ReclaimDeps = { ...defaultReclaimDeps(), ...opts.deps };
  const gracefulMs = opts.gracefulMs ?? 5_000;
  const killGraceMs = opts.killGraceMs ?? 2_000;
  const pingTimeoutMs = opts.pingTimeoutMs ?? 1_500;

  if (!existsSync(opts.pidFilePath)) {
    return { action: 'no_pid_file' };
  }
  let raw: string;
  try {
    raw = readFileSync(opts.pidFilePath, 'utf8');
  } catch {
    // File appeared then disappeared — treat as no_pid_file.
    return { action: 'no_pid_file' };
  }
  const pid = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    // Garbage in the file — let the daemon's own claimPidFile sort
    // it out (its existing kill(0) check overwrites stale files).
    opts.logger.warn(
      { pidFilePath: opts.pidFilePath, raw: raw.slice(0, 32) },
      'pid file contained non-integer; treating as stale',
    );
    return { action: 'stale_dead_pid', pid: 0 };
  }

  // ── Check (a) — pid alive / EPERM is fatal, ESRCH is stale-dead ──
  const liveness = deps.signalPid(pid, 0);
  if (liveness === 'gone') {
    opts.logger.info({ pid }, 'pid in pidfile is dead; no reclaim needed');
    return { action: 'stale_dead_pid', pid };
  }
  if (liveness === 'eperm') {
    const fail: ReclaimResult = {
      action: 'fail_loudly',
      pid,
      check: 'a_eperm',
      detail:
        'kill(pid, 0) returned EPERM — pid belongs to another uid or pid 1. Refusing to kill.',
    };
    opts.logger.error(fail, 'kill-and-reclaim aborted: EPERM');
    return fail;
  }

  // ── Check (b) — cmdline must include both expected tokens ──────
  const cmdline = await deps.runPs(pid);
  const expectedSocketToken = `--socket-path ${opts.socketPath}`;
  const expectedPidFileToken = `--pid-file ${opts.pidFilePath}`;
  if (
    !cmdline.includes(expectedSocketToken) ||
    !cmdline.includes(expectedPidFileToken)
  ) {
    const fail: ReclaimResult = {
      action: 'fail_loudly',
      pid,
      check: 'b_cmdline_mismatch',
      detail: `cmdline did not contain both --socket-path and --pid-file tokens. Got: ${cmdline.slice(0, 200)}`,
    };
    // §3.4: log structured fields only — do NOT log the cmdline itself
    // even on mismatch. The `fail.detail` carrying the cmdline tail is
    // surfaced upstream via `ReclaimFailLoudlyError` for operator debug,
    // not via the daemon JSONL log.
    opts.logger.error(
      { check: fail.check, pid, cmdline_match: false },
      'kill-and-reclaim aborted: cmdline mismatch',
    );
    return fail;
  }

  // ── Check (c) / (d) — ping; pid must match, or ECONNREFUSED ──
  const ping = await deps.pingDaemon(opts.socketPath, pingTimeoutMs);
  if (ping.ok) {
    if (ping.daemon_pid !== pid) {
      const fail: ReclaimResult = {
        action: 'fail_loudly',
        pid,
        check: 'c_ping_pid_mismatch',
        detail: `ping returned daemon_pid=${ping.daemon_pid} but pid-file said ${pid}. pid-file may be stale and pointed at a different live daemon — refusing to kill.`,
      };
      opts.logger.error(fail, 'kill-and-reclaim aborted: ping pid mismatch');
      return fail;
    }
    // ping ok + pid match → confident it's our daemon; proceed.
  } else if (ping.reason === 'unreachable' || ping.reason === 'timeout') {
    // Half-dead daemon: cmdline matches our identity but the socket
    // is non-responsive. Acceptable to kill.
    opts.logger.info(
      { pid, ping_reason: ping.reason },
      'half-dead daemon detected; proceeding to reclaim',
    );
  } else {
    const fail: ReclaimResult = {
      action: 'fail_loudly',
      pid,
      check: 'd_ping_invalid',
      detail: `ping returned an invalid response shape (ping.reason=${ping.reason}); refusing to kill on unclear evidence.`,
    };
    opts.logger.error(fail, 'kill-and-reclaim aborted: ping invalid');
    return fail;
  }

  // ── Reclaim — SIGTERM gracefulMs → SIGKILL killGraceMs ─────────
  // §3.4: do NOT log the cmdline itself — only `cmdline_match: true`
  // (verified above by checks (b) and (c)/(d)).
  opts.logger.info(
    { pid, gracefulMs, killGraceMs },
    'reclaiming stale daemon: SIGTERM',
  );
  logProcess(opts.logger, { action: 'sigterm', pid, cmdline_match: true });
  deps.signalPid(pid, 'SIGTERM');
  let exitState = await deps.waitForExit(pid, gracefulMs);
  if (exitState === 'gone') {
    logProcess(opts.logger, { action: 'reclaim', pid, exit_code: null, cmdline_match: true });
    return {
      action: 'reclaimed',
      pid,
      method: 'sigterm',
      cmdline,
    };
  }
  opts.logger.warn(
    { pid, gracefulMs },
    'daemon survived SIGTERM grace; escalating to SIGKILL',
  );
  logProcess(opts.logger, { action: 'sigkill', pid, cmdline_match: true });
  deps.signalPid(pid, 'SIGKILL');
  exitState = await deps.waitForExit(pid, killGraceMs);
  if (exitState === 'gone') {
    logProcess(opts.logger, { action: 'reclaim', pid, exit_code: null, cmdline_match: true });
    return {
      action: 'reclaimed',
      pid,
      method: 'sigkill',
      cmdline,
    };
  }
  const fail: ReclaimResult = {
    action: 'fail_loudly',
    pid,
    check: 'survived_sigkill',
    detail: `pid ${pid} survived SIGKILL after ${killGraceMs}ms — kernel-level wedge, manual intervention required.`,
  };
  opts.logger.error(fail, 'kill-and-reclaim aborted: survived SIGKILL');
  return fail;
}
