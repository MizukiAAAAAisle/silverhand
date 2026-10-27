/**
 * Daemon process lifecycle: pid file + signal handling.
 *
 * The pid file is the single source of truth for "is a daemon already
 * running on this host". Layout:
 *
 *   ~/.silverhand/run/daemon.pid    → "<pid>\n"
 *
 * Why a pid file (and not "just `lsof` the socket"):
 *
 *  - The socket file alone is not a reliable lock — a crashed daemon
 *    leaves the socket file behind, and `unlink` is enough to clear
 *    it. We need a second probe to distinguish "stale leftover" from
 *    "live daemon already owns this socket".
 *  - `kill(pid, 0)` is the standard way to ask "is this pid alive
 *    under my uid?" without sending a real signal. Combined with the
 *    pid file, we can decide on startup:
 *      * pid file missing → fresh start.
 *      * pid file present, pid alive → another daemon already running;
 *        refuse to start (exit code 2).
 *      * pid file present, pid dead → stale; overwrite and continue.
 *
 * Signals:
 *
 *  - SIGTERM / SIGINT trigger graceful shutdown via the registered
 *    callback. Default node behaviour on these signals is to exit
 *    immediately, which would skip our drain + unlink work.
 *  - SIGHUP is intentionally NOT handled in PR-1 (no config reload
 *    yet). It uses node default (exit) — acceptable.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DaemonLogger } from './logger.js';

export interface PidFileState {
  /** `'wrote'` on success; `'conflict'` when another live daemon
   *  already owns the file. */
  status: 'wrote' | 'conflict';
  /** When `status='conflict'`, the live pid we observed. */
  conflictingPid?: number;
}

/**
 * Attempt to claim the pid file for the current process. Stale files
 * (whose recorded pid no longer maps to a live process) are silently
 * overwritten — that's the normal recovery path after a crash.
 */
export function claimPidFile(pidFilePath: string): PidFileState {
  mkdirSync(dirname(pidFilePath), { recursive: true });
  if (existsSync(pidFilePath)) {
    const raw = safeReadFile(pidFilePath);
    const priorPid = raw ? Number.parseInt(raw.trim(), 10) : NaN;
    if (Number.isInteger(priorPid) && priorPid > 0 && isProcessAlive(priorPid)) {
      return { status: 'conflict', conflictingPid: priorPid };
    }
    // Stale — fall through and overwrite.
  }
  writeFileSync(pidFilePath, `${process.pid}\n`, { mode: 0o600 });
  return { status: 'wrote' };
}

export function releasePidFile(pidFilePath: string): void {
  // Only unlink if WE still own the file. A second daemon that raced
  // in (after we exited but before unlink) would otherwise have its
  // pid file removed out from under it.
  if (!existsSync(pidFilePath)) return;
  const raw = safeReadFile(pidFilePath);
  const recorded = raw ? Number.parseInt(raw.trim(), 10) : NaN;
  if (recorded === process.pid) {
    try {
      unlinkSync(pidFilePath);
    } catch {
      /* concurrent unlink — fine */
    }
  }
}

/**
 * Install SIGINT / SIGTERM handlers that call `onShutdown(reason)`
 * exactly once. Subsequent signals are logged and ignored so an
 * impatient operator hammering Ctrl-C doesn't race us into mid-drain
 * `process.exit`.
 */
export function installShutdownHandlers(
  logger: DaemonLogger,
  onShutdown: (reason: string) => Promise<void> | void,
): void {
  let fired = false;
  const handle = (signal: NodeJS.Signals): void => {
    if (fired) {
      logger.warn({ signal }, 'shutdown already in progress; ignoring signal');
      return;
    }
    fired = true;
    logger.info({ signal }, 'received shutdown signal');
    Promise.resolve(onShutdown(`signal:${signal}`))
      .catch((err) => {
        logger.error({ err: (err as Error).message }, 'shutdown handler threw');
      })
      .finally(() => {
        // Give the logger a tick to flush, then exit. We use `setImmediate`
        // (not `process.nextTick`) so any queued writes drain first.
        setImmediate(() => process.exit(0));
      });
  };
  process.on('SIGINT', handle);
  process.on('SIGTERM', handle);
}

function safeReadFile(p: string): string | null {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/**
 * POSIX trick: `kill(pid, 0)` doesn't deliver a signal — it just
 * checks whether the pid is reachable from the current uid. Returns
 * true when the pid exists, false on ESRCH or EPERM (EPERM means the
 * pid exists but we can't signal it — still "alive" for our purposes).
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true;
    return false;
  }
}
