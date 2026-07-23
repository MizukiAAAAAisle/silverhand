/**
 * Helper for Electron main / dev:headless to spawn the daemon as a
 * managed child process and learn its socket path.
 *
 * Lifecycle:
 *
 *   spawnDaemonChild({ launcher, socketPath, pidFilePath, logDir })
 *     → spawns `<launcher.command> <launcher.args>... <daemon args>`
 *     → reads stdout line-by-line waiting for the `ready` handshake
 *     → resolves with `{ pid, socketPath, kill, onExit, onDaemonGenerationChanged }`
 *
 * The launcher is host-supplied (Electron main resolves it via the
 * same `process.execPath + ELECTRON_RUN_AS_NODE=1` trick used for the
 * CLI; tests can hand it a plain `node` + daemon entry script path).
 *
 * Restart policy (D3.b refinement of PR-1's capped restart loop):
 *
 *  - On non-zero exit (or signal): schedule a respawn after a delay
 *    pulled from `backoffSchedule` (default `[500, 1000, 2000, 4000,
 *    8000, 30000]`ms; consecutive failures past the array length
 *    repeat the last value). This is the local supervisor's "give the
 *    OS a moment" backoff — it is NOT the server↔daemon formal
 *    protocol.
 *  - Per-attempt counter is the same as the sliding-window crash
 *    counter (`exitTimes.length`); both reset together when the
 *    daemon has run successfully for `successResetMs` (default 5000)
 *    after a handshake. This avoids drift between "do I schedule
 *    aggressively?" and "have I exceeded budget?".
 *  - If `exitTimes.length > maxRestarts` within `restartWindowMs`,
 *    give up: fire `onExit({reason, code})` and stop scheduling
 *    respawns. Default `maxRestarts=5` is the conservative core
 *    floor; Electron main may pass a different value to express
 *    UI-layer policy (see D3.b Commit 2).
 *  - On successful respawn handshake, the consumer is notified via
 *    `onDaemonGenerationChanged({pid, daemonVersion, instanceId,
 *    startedAt, attempt})`. The consumer's job is to re-establish
 *    anything tied to *this* daemon process — notably the post-login
 *    `host_outbound_attach` (the fresh daemon is spawned WITHOUT
 *    `--host-config` per D3.a Commit 4, so its outbound supervisor
 *    is dormant until main re-attaches). `instanceId` is the
 *    handshake `instance_id`, the canonical daemon-generation id;
 *    consumers should dedupe by `instanceId`, not by `pid` (macOS
 *    pids are reusable) or `daemonVersion` (constant across
 *    restarts of the same binary).
 *
 * Terminal-state disposition (R1/R4 framing — see `notes/`):
 *
 *  - In the long-run target topology the local daemon is started by
 *    launchd (or a per-OS service manager) with its host_token loaded
 *    from the OS keychain, and it attaches to its assigned backend
 *    without any desktop main process involvement. At that point
 *    `spawnDaemonChild` and `onDaemonGenerationChanged` both go away
 *    along with the rest of `apps/desktop/src/main/index.ts`'s
 *    spawn/IPC supervisor surface.
 *  - Until then, desktop main is the OS-parent of the local daemon
 *    purely as a packaging convenience. This file is a
 *    **V1 desktop-embedded local supervisor adapter** — it is NOT a
 *    server↔daemon formal communication channel, and nothing in this
 *    file or in `onDaemonGenerationChanged` callbacks should be
 *    surfaced to backend, renderer, or wire-protocol semantics.
 *
 * Stderr piping:
 *
 *  - Daemon stderr is forwarded to the parent's stderr by default.
 *    The daemon itself only writes to stderr when `--stderr` is set,
 *    and even then it's prefixed `[daemon ...]` so it doesn't get
 *    confused with backend logs.
 *
 * Test seams (D3.b Commit 1):
 *
 *  - `clock` lets unit tests advance backoff timers without sleeping.
 *  - `spawnProcess` lets unit tests substitute a fake ChildProcess so
 *    the whole supervisor loop can be exercised without `tsx` on
 *    PATH. The seam is package-internal; production callers should
 *    never pass it. The seam is positioned at the lowest layer
 *    (`node:child_process.spawn`) so handshake parsing and pid
 *    lifecycle are still exercised end-to-end in the test.
 */
import {
  spawn as nodeSpawn,
  type ChildProcess,
  type SpawnOptions,
} from 'node:child_process';
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

/** Test-only injection seam: replaces `node:child_process.spawn`. */
export type SpawnProcessImpl = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions,
) => ChildProcess;

/**
 * Test-only clock seam. The default uses `Date.now()` and
 * `setTimeout` (with `.unref()` so the timer doesn't keep Node
 * alive during shutdown). Unit tests substitute a fake that
 * advances synchronously.
 */
export interface SpawnClock {
  now(): number;
  /** Schedule `fn` after `ms` and return a handle whose `clear()`
   *  prevents the firing. Calling `clear()` after the timer fired
   *  is a no-op. */
  setTimeout(fn: () => void, ms: number): SpawnTimer;
}

export interface SpawnTimer {
  clear(): void;
}

const REAL_CLOCK: SpawnClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return {
      clear: () => clearTimeout(t),
    };
  },
};

/**
 * Discriminator for `DaemonHandle.onExit` fatal-exit callbacks. The
 * supervisor has two distinct terminal failure modes, and downstream
 * consumers may want to react differently:
 *
 *  - `restart_budget_exhausted` — daemon crashed `> maxRestarts`
 *    times inside `restartWindowMs`. Recovery requires a fresh app
 *    launch (the supervisor will not schedule any further respawns).
 *  - `respawn_handshake_failed` — a single respawn attempt failed
 *    its ready handshake (e.g. daemon binary returned non-zero, or
 *    its `ready` frame never arrived within `readyTimeoutMs`). The
 *    surrounding sliding-window budget may still have room, but THIS
 *    attempt is dead; the supervisor falls through to fatal because
 *    a failed respawn handshake means we can't reach the daemon at
 *    all on the current attempt.
 *
 * Cindy `#task:629` D3.b Commit 2 review gate: desktop main's
 * `local_host_status: 'failed'` flip is gated to
 * `restart_budget_exhausted` only — handshake failures are recovery-
 * surface ambiguous (might be a transient bad config the user can
 * fix) and shouldn't lock the UI into the same end-state as
 * "supervisor gave up". Without this discriminator the strict-source
 * rule from `local-host-failure.ts` would be silently violated.
 */
export type DaemonFatalExitKind =
  | 'restart_budget_exhausted'
  | 'respawn_handshake_failed';

export interface DaemonFatalExitInfo {
  kind: DaemonFatalExitKind;
  reason: string;
  /** Process exit code from the last incarnation. `null` for
   *  handshake-failure paths where we never observed an OS exit
   *  (e.g. handshake reject before the child died). */
  code: number | null;
}
export const DEFAULT_BACKOFF_SCHEDULE_MS: ReadonlyArray<number> = [
  500, 1_000, 2_000, 4_000, 8_000, 30_000,
];

/** Default "ran successfully this long after handshake → reset
 *  backoff" threshold. Picked so flapping crashes still escalate
 *  but a normal long-lived daemon stays at attempt 0. */
export const DEFAULT_SUCCESS_RESET_MS = 5_000;

export interface SpawnDaemonOptions {
  launcher: DaemonLauncher;
  socketPath: string;
  pidFilePath: string;
  logDir: string;
  /** Optional Stage D2 outbound WS host-token config path. Note that
   *  D3.a Commit 4 removed this from the desktop spawn path; it is
   *  preserved here for standalone / manual / test callers. */
  hostConfigPath?: string | null;
  /**
   * Optional path to bind the daemon's local outbound frame server. When
   * set, the daemon starts a `LocalOutboundFrameServer` on this Unix
   * socket and the embedded backend dials it to receive the D5.a
   * R4-unified outbound envelope (same schemas/error-taxonomy as the
   * standalone WSS path). Omit for callers that don't run an embedded
   * backend against this daemon. Forwarded as
   * `--local-outbound-socket-path` to the daemon entry. */
  localOutboundSocketPath?: string | null;
  /** Root for runtime pidfiles owned by this daemon. Desktop passes a
   *  path under SILVERHAND_DIR so parallel isolated apps do not reap
   *  each other's runtime children. Omit to let daemon entry use its
   *  legacy default. */
  runtimePidRootDir?: string | null;
  /** Root for daemon-owned agent L1 dirs. Desktop passes a
   *  SILVERHAND_DIR-scoped path so isolated apps do not materialize
   *  agents under the global user profile. */
  agentHomeRootDir?: string | null;
  /** #task:1596 — explicit durable workspace-data root forwarded to the
   *  daemon child (`--workspace-data-root-dir`). */
  workspaceDataRootDir?: string | null;
  /** #task:1598 — explicit global silverhand root (guard root) forwarded
   *  to the daemon child (`--silverhand-state-root-dir`). */
  silverhandStateRootDir?: string | null;
  /** #task:1598 round 4 — explicit persistent identity file forwarded to
   *  the daemon child (`--daemon-identity-path`). Desktop passes the
   *  resolver's `localComputer.run.identity`; omitting it makes the child
   *  fall back to the bare-daemon default (`~/.silverhand/daemon/identity.json`),
   *  NOT to a sibling of the runtime-pid root. */
  daemonIdentityPath?: string | null;
  /** Daemon-local runtime proxy config file. */
  proxyConfigPath?: string | null;
  /** Legacy app-managed proxy config file to migrate into the per-computer profile. */
  legacyProxyConfigPath?: string | null;
  /** Host-local control-plane URL file for runtime CLI env injection. */
  controlPlaneServerUrlPath?: string | null;
  /** Mirror daemon log lines to stderr too. Default true in dev. */
  alsoStderr?: boolean;
  /** Max time to wait for the `ready` handshake. Default 10_000ms. */
  readyTimeoutMs?: number;
  /** Max non-zero exits per restartWindowMs before we give up. Default 5. */
  maxRestarts?: number;
  /** Sliding window for `maxRestarts`. Default 60_000ms. */
  restartWindowMs?: number;
  /** Per-attempt restart delay schedule. See `DEFAULT_BACKOFF_SCHEDULE_MS`. */
  backoffSchedule?: ReadonlyArray<number>;
  /** Successful-run threshold for backoff reset. See `DEFAULT_SUCCESS_RESET_MS`. */
  successResetMs?: number;
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
  /** Test seam — see `SpawnClock`. Production paths use real timers. */
  clock?: SpawnClock;
  /** Test seam — see `SpawnProcessImpl`. Production paths use `node:child_process.spawn`. */
  spawnProcess?: SpawnProcessImpl;
}

export interface DaemonGenerationInfo {
  /** OS pid of the freshly-spawned daemon. macOS pids are reusable,
   *  so do NOT use this for generation dedup — use `instanceId`. */
  pid: number;
  /** Daemon version string from the new handshake. Constant across
   *  restarts of the same binary; useful for diagnostic logs but
   *  not a generation discriminator. */
  daemonVersion: string;
  /**
   * Handshake `instance_id` — the canonical daemon-generation id.
   * Changes on every daemon boot. Consumers should dedupe their
   * generation-change reactions by this field; pid is reusable and
   * daemonVersion doesn't move across restarts.
   */
  instanceId: string;
  /** Handshake `started_at` (ms epoch). Diagnostic only. */
  startedAt: number;
  /**
   * 1-indexed consecutive crash-restart counter inside the current
   * `restartWindowMs` sliding window. Resets to 0 after the
   * supervisor observes `successResetMs` of healthy uptime; the next
   * crash after a reset fires with `attempt=1` again. This is NOT a
   * lifetime restart count — it's the supervisor's local view of
   * "how aggressive should backoff be right now?".
   */
  attempt: number;
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
   * restart so the daemon stays down. Idempotent. Cancels any
   * pending restart-backoff timer and success-reset timer so a
   * delayed respawn cannot resurrect the daemon after quit.
   */
  kill(opts?: { gracefulMs?: number }): Promise<void>;
  /**
   * Subscribe to fatal-exit notifications. The supervisor distinguishes
   * `kind: 'restart_budget_exhausted'` (gave up after exceeding
   * `maxRestarts` within `restartWindowMs`) from
   * `kind: 'respawn_handshake_failed'` (a single respawn attempt
   * couldn't reach a healthy daemon — non-zero exit before
   * handshake, or `readyTimeoutMs` elapsed). See {@link
   * DaemonFatalExitInfo}. NOT fired on intentional `kill()` or
   * transient crashes that are recovered by
   * `onDaemonGenerationChanged`.
   */
  onExit(handler: (info: DaemonFatalExitInfo) => void): () => void;
  /**
   * Subscribe to daemon-generation-change notifications: fired AFTER
   * a crash-triggered restart's handshake succeeds. Used by the
   * desktop supervisor to re-fire post-login `host_outbound_attach`
   * — the fresh daemon has no outbound supervisor running until
   * main re-attaches.
   *
   * NOT fired for the initial spawn (use the resolved `DaemonHandle`
   * for that), NOT fired on `kill()`, and NOT fired when a respawn
   * attempt fails (those go to `onExit`).
   *
   * Consumers should dedupe reactions by `info.instanceId`. This hook
   * is a V1 local-supervisor adapter — it is NOT part of the
   * server↔daemon protocol and will disappear with `spawnDaemonChild`
   * when local daemon is managed by launchd in the terminal state.
   */
  onDaemonGenerationChanged(handler: (info: DaemonGenerationInfo) => void): () => void;
}

export async function spawnDaemonChild(opts: SpawnDaemonOptions): Promise<DaemonHandle> {
  const maxRestarts = opts.maxRestarts ?? 5;
  const restartWindowMs = opts.restartWindowMs ?? 60_000;
  const readyTimeoutMs = opts.readyTimeoutMs ?? 10_000;
  const alsoStderr = opts.alsoStderr ?? true;
  const backoffSchedule = opts.backoffSchedule ?? DEFAULT_BACKOFF_SCHEDULE_MS;
  const successResetMs = opts.successResetMs ?? DEFAULT_SUCCESS_RESET_MS;
  const clock = opts.clock ?? REAL_CLOCK;
  const spawnImpl = opts.spawnProcess ?? (nodeSpawn as SpawnProcessImpl);
  if (backoffSchedule.length === 0) {
    throw new Error('spawnDaemonChild: backoffSchedule must not be empty');
  }
  const exitHandlers = new Set<(info: DaemonFatalExitInfo) => void>();
  const generationHandlers = new Set<(info: DaemonGenerationInfo) => void>();
  const exitTimes: number[] = [];

  let child: ChildProcess | null = null;
  let lastHandshake: Extract<EventFrame, { event: 'ready' }> | null = null;
  let killed = false;
  let killResolve: (() => void) | null = null;
  /** Pending restart-backoff timer; cleared on kill() or when fired. */
  let pendingRestartTimer: SpawnTimer | null = null;
  /** Pending success-reset timer; cleared on next exit, on kill(), or
   *  when fired (which resets the backoff state). */
  let pendingSuccessResetTimer: SpawnTimer | null = null;

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
      ...(opts.localOutboundSocketPath
        ? ['--local-outbound-socket-path', opts.localOutboundSocketPath]
        : []),
      ...(opts.runtimePidRootDir
        ? ['--runtime-pid-root-dir', opts.runtimePidRootDir]
        : []),
      ...(opts.workspaceDataRootDir
        ? ['--workspace-data-root-dir', opts.workspaceDataRootDir]
        : []),
      ...(opts.silverhandStateRootDir
        ? ['--silverhand-state-root-dir', opts.silverhandStateRootDir]
        : []),
      ...(opts.daemonIdentityPath
        ? ['--daemon-identity-path', opts.daemonIdentityPath]
        : []),
      ...(opts.agentHomeRootDir
        ? ['--agent-home-root-dir', opts.agentHomeRootDir]
        : []),
      ...(opts.proxyConfigPath
        ? ['--proxy-config-path', opts.proxyConfigPath]
        : []),
      ...(opts.legacyProxyConfigPath
        ? ['--legacy-proxy-config-path', opts.legacyProxyConfigPath]
        : []),
      ...(opts.controlPlaneServerUrlPath
        ? ['--control-plane-server-url-path', opts.controlPlaneServerUrlPath]
        : []),
      ...(alsoStderr ? ['--stderr'] : []),
    ];
    const proc = spawnImpl(
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

  /** Arm a fresh success-reset timer. Called after every successful
   *  handshake (initial + each respawn). Cancels any prior pending
   *  one so a fast crash-restart-crash cycle never has two armed at
   *  once. */
  const armSuccessReset = (): void => {
    pendingSuccessResetTimer?.clear();
    pendingSuccessResetTimer = clock.setTimeout(() => {
      pendingSuccessResetTimer = null;
      // We ran successfully for `successResetMs` without crashing →
      // wipe the consecutive-crash bookkeeping so the next isolated
      // crash starts at backoff[0] again.
      exitTimes.length = 0;
    }, successResetMs);
  };

  /** Fire fatal `onExit` handlers with the given info. Idempotent
   *  callers must already have decided this exit is terminal.
   *  Callers must classify the failure via `DaemonFatalExitInfo.kind`
   *  so consumers can apply different recovery semantics. */
  const emitFatalExit = (info: DaemonFatalExitInfo): void => {
    for (const h of exitHandlers) {
      try { h(info); } catch { /* swallow */ }
    }
  };

  /** Attempt a respawn: spawnOnce, on success update handle + arm
   *  success-reset + notify onDaemonGenerationChanged; on failure
   *  emit fatal exit. `attempt` is the consecutive-restart counter
   *  (1-indexed) used by the generation hook's consumer. */
  const tryRespawn = async (attempt: number): Promise<void> => {
    try {
      const handshake = await spawnOnce();
      lastHandshake = handshake;
      handle.pid = handshake.daemon_pid;
      handle.daemonVersion = handshake.daemon_version;
      attachExit();
      armSuccessReset();
      for (const h of generationHandlers) {
        try {
          h({
            pid: handshake.daemon_pid,
            daemonVersion: handshake.daemon_version,
            instanceId: handshake.instance_id,
            startedAt: handshake.started_at,
            attempt,
          });
        } catch { /* swallow */ }
      }
    } catch (err) {
      emitFatalExit({
        kind: 'respawn_handshake_failed',
        reason: `daemon restart failed: ${(err as Error).message}`,
        code: null,
      });
    }
  };

  const onExit = (code: number | null): void => {
    if (killed) {
      killResolve?.();
      return;
    }
    // The previous incarnation exited before its success-reset
    // window elapsed → cancel the pending reset so we DON'T clear
    // the consecutive-crash counter (this exit is one of those
    // consecutive crashes).
    pendingSuccessResetTimer?.clear();
    pendingSuccessResetTimer = null;

    const now = clock.now();
    exitTimes.push(now);
    // Trim sliding window
    while (exitTimes.length > 0 && exitTimes[0]! < now - restartWindowMs) {
      exitTimes.shift();
    }
    if (exitTimes.length > maxRestarts) {
      emitFatalExit({
        kind: 'restart_budget_exhausted',
        reason: `daemon crashed ${exitTimes.length} times within ${restartWindowMs}ms; giving up`,
        code,
      });
      return;
    }
    // attempt = consecutive-crash counter; equals exitTimes.length
    // immediately after the push above. backoffSchedule indexed by
    // (attempt-1) clamped to last entry.
    const attempt = exitTimes.length;
    const idx = Math.min(attempt - 1, backoffSchedule.length - 1);
    const delayMs = backoffSchedule[idx]!;
    pendingRestartTimer = clock.setTimeout(() => {
      pendingRestartTimer = null;
      // Defensive: if kill() ran between schedule and fire, abort.
      if (killed) return;
      void tryRespawn(attempt);
    }, delayMs);
  };

  const attachExit = (): void => {
    child?.once('exit', code => onExit(code));
  };

  const firstHandshake = await spawnOnce();
  lastHandshake = firstHandshake;
  attachExit();
  armSuccessReset();

  const handle: DaemonHandle = {
    pid: firstHandshake.daemon_pid,
    socketPath: firstHandshake.socket_path,
    daemonVersion: firstHandshake.daemon_version,
    async kill(killOpts) {
      if (killed) return;
      killed = true;
      // Cancel pending restart + success-reset so a delayed respawn
      // can't resurrect the daemon after the host has decided to quit.
      pendingRestartTimer?.clear();
      pendingRestartTimer = null;
      pendingSuccessResetTimer?.clear();
      pendingSuccessResetTimer = null;
      const proc = child;
      if (!proc) return;
      // Cindy `#task:627` P1: if the current child has already exited
      // (typical scenario: daemon crashed → backoff timer pending →
      // app quit calls kill()), the real Node `ChildProcess` will NOT
      // re-emit `exit` for a freshly-registered `once('exit')` listener
      // and `proc.kill(SIGTERM)` is a no-op false return. Without this
      // early exit, the Promise below would wait forever for an event
      // that already happened (only the SIGKILL fallback would fire,
      // and it doesn't resolve either). Detecting via `exitCode` /
      // `signalCode` mirrors Node's own ChildProcess state machine.
      if (proc.exitCode !== null || proc.signalCode !== null) {
        return;
      }
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
    onDaemonGenerationChanged(handler) {
      generationHandlers.add(handler);
      return () => { generationHandlers.delete(handler); };
    },
  };
  // Use the captured firstHandshake (`lastHandshake` is updated across
  // restarts but currently equals firstHandshake at return time).
  void lastHandshake;
  return handle;
}
