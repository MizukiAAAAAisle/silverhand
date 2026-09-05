// #task:2343 — the embedded-mode launcher that runs the PREBUILT Rust backend
// (`silverhand-backend`) as a child process, replacing the legacy in-process TypeScript
// backend. This module owns the whole out-of-process embedded lifecycle:
//
//   1. verify the packaged sidecar against its manifest (target/arch + SHA-256) BEFORE
//      spawn — a missing/wrong-arch/corrupt artifact fails loud, never a TS fallback;
//   2. spawn the child with a launcher-owned EXPLICIT env boundary (db, blobs, logs,
//      bootstrap-token, listener, origins, daemon, signup, deployment_profile=embedded)
//      + a launcher-minted `SILVERHAND_STARTUP_GENERATION`;
//   3. read EXACTLY ONE stdout `bound` frame (via `BoundFrameReader`), whose generation
//      must echo the minted value;
//   4. poll the reported URL for `/readyz=200` (the frame is `bound`, not `ready`);
//   5. verify the API-epoch wire-compat from `/api/server/info`;
//   6. publish an `EmbeddedRustBackendHandle { url, port, onTerminal, close }`.
//
// Migration is NOT done here: the caller runs the canonical TS migrator + backup +
// FK/integrity and FULLY closes the DB BEFORE calling this, so the child is the only
// opener of the SQLite file (no dual-open). Compatibility is the independent `api_epoch`;
// this module performs NO version-equality check.
//
// #task:2343 seq362 hardening:
//   - P0-1: a SECOND stdout line arriving DURING the ready/epoch probe (after the frame,
//     before publish) rejects the in-flight startup promise IMMEDIATELY and reclaims the
//     child BEFORE any handle/URL is published — never a set-flag-then-return-then-async-
//     close race.
//   - P0-2: every HTTP probe (`/readyz` single fetch, server-info fetch) runs under ONE
//     shared startup deadline + a per-attempt AbortSignal, and races child-exit and a
//     shutdown signal, so a never-resolving fetch can never bypass the budget.
//   - P0-4: the published handle exposes a TYPED terminal surface (`onTerminal`): a
//     post-publish fatal (child crash, stray/duplicate stdout line, stdout stream error)
//     fires it exactly once so the Desktop main can invalidate the backend + control-plane
//     URL and route the renderer through the visible runtime-failure path — not a silent
//     background `void close()` while the app still believes it is healthy.
//   - P0-5: child reclaim settles on `exit` OR `error` (Node can emit `error` WITHOUT a
//     following `exit`, e.g. ENOENT), and never waits forever for an exit that will not
//     come — SIGKILL falls through to resolve on a bounded grace.

import type { ChildProcess } from 'node:child_process';

import { classifyDesktopServerApiCompatibility } from '@silverhand/shared';

import { BoundFrameReader } from './rust-backend-frame.js';
import type { VerifiedSidecar } from './rust-backend-sidecar.js';

/** The launcher-owned explicit configuration boundary handed to the child as env. The
 * backend never self-derives any of these (no app-data root, no profile guess). */
export interface EmbeddedRustBackendConfig {
  /** Desktop shutdown cancels startup before any handle is published. */
  signal?: AbortSignal;
  /** Absolute path to the canonical SQLite database (already migrated + closed). */
  databasePath: string;
  /** Absolute path to the blob storage root. */
  blobsRoot: string;
  /** Absolute path to the categorized-log directory. */
  logDir: string;
  /** Absolute path the one-shot embedded bootstrap token is written to. */
  bootstrapTokenPath: string;
  /** The loopback listener the child binds. Use port 0 for an ephemeral port. */
  listen: { hostname: string; port: number };
  /** The event-WS allowed origins (non-empty). */
  allowedOrigins: string[];
  /** The daemon package spec the backend resolves for runtime, when set. */
  daemonNpmSpec?: string;
  /** Whether public signup is disabled. */
  disableSignup: boolean;
  /** The Desktop's own compiled desktop↔server API epoch range (#task:2343 P0). After
   * `/readyz`, the launcher reads `/api/server/info.desktop_api` and requires the
   * embedded backend to be epoch-COMPATIBLE with this range before publishing the
   * handle. This is the SAME wire-compat gate the REST/WS layers enforce — kept
   * independent of (and NOT replaced by) any version notion. */
  apiEpoch: {
    /** The Desktop build's own current API epoch (`DESKTOP_SERVER_API_EPOCH`). */
    clientEpoch: number;
    /** The Desktop build's minimum acceptable server epoch (`MINIMUM_SERVER_API_EPOCH`). */
    minimumServerEpoch: number;
  };
}

/** Why a PUBLISHED embedded backend terminated. Fired at most once through
 * `onTerminal`. Distinct from a startup failure (which throws before publish). */
export type EmbeddedRustBackendTerminalReason =
  /** The child process exited on its own after publish (crash / unexpected exit). */
  | { kind: 'child-exited'; code: number | null; signal: NodeJS.Signals | null }
  /** The child emitted a stray/duplicate non-blank stdout line after publish — stdout
   * carries ONLY the one bound frame, so this is a fatal protocol violation. */
  | { kind: 'protocol-violation'; detail: string }
  /** The child's stdout stream errored/closed unexpectedly after publish. */
  | { kind: 'stream-fatal'; detail: string };

/** The published handle for a running embedded Rust backend. Deliberately narrower than
 * the in-process `RunningBackend` (no `context`): the launcher owns the config it wrote,
 * and the renderer talks to `url` over HTTP+WS. */
export interface EmbeddedRustBackendHandle {
  readonly url: string;
  readonly port: number;
  /** #task:2343 P0-4 — register the SINGLE owner notified when a PUBLISHED backend dies
   * for any reason (crash, post-publish protocol violation, stdout stream fatal). Fires
   * at most once; if the backend already terminated, the callback is invoked
   * synchronously on the next microtask with the recorded reason. The main process uses
   * this to invalidate the global backend + clear the control-plane URL + route the
   * renderer through the visible runtime-failure path. */
  onTerminal(listener: (reason: EmbeddedRustBackendTerminalReason) => void): void;
  /** Graceful shutdown: signal the child, await exit within a bound, hard-kill on
   * timeout, and best-effort remove the bootstrap token. Idempotent. */
  close(): Promise<void>;
}

/** The verified sidecar artifact (its resolved executable path), produced by
 * `verifySidecar` in `./rust-backend-sidecar` BEFORE this module spawns. Re-exported
 * type for callers threading it in. */
export type { VerifiedSidecar } from './rust-backend-sidecar.js';

export type EmbeddedRustBackendFailureKind =
  | 'spawn-failed'
  | 'eof-before-frame'
  | 'invalid-frame'
  | 'duplicate-frame'
  | 'readiness-timeout'
  | 'child-exited-early'
  | 'server-info-unavailable'
  | 'epoch-incompatible'
  | 'shutdown-during-startup';

export class EmbeddedRustBackendStartError extends Error {
  constructor(
    readonly kind: EmbeddedRustBackendFailureKind,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'EmbeddedRustBackendStartError';
  }
}

/** Injection seams so the orchestration is unit-testable without a real child. */
export interface EmbeddedRustBackendDeps {
  /** Spawn the child; the default binds `node:child_process.spawn`. stdout is piped for
   * the frame; stderr is the child's log stream (inherited or piped by the caller). */
  spawn: (
    executablePath: string,
    env: Record<string, string>,
  ) => ChildProcess;
  /** Probe `${url}/readyz` under the supplied AbortSignal; resolves `true` iff HTTP 200.
   * Never throws (a transport error or abort resolves `false`). Default uses `fetch`
   * with the signal so a hung socket is cancelled by the launcher's deadline. */
  probeReadyz: (url: string, signal: AbortSignal) => Promise<boolean>;
  /** Read + validate `${url}/api/server/info` under the supplied AbortSignal, returning
   * the parsed `desktop_api` epoch advertisement, or `null` when the response is
   * unreachable/non-200/malformed/aborted (#task:2343 P0). */
  probeServerInfoEpoch: (
    url: string,
    signal: AbortSignal,
  ) => Promise<{ currentEpoch: number; minimumClientEpoch: number } | null>;
  /** Mint the per-spawn opaque generation token. Default is a random uuid. */
  mintGeneration: () => string;
  /** Best-effort removal of the bootstrap token file on teardown. */
  removeBootstrapToken: (path: string) => Promise<void>;
  clock: {
    now(): number;
    sleep(ms: number): Promise<void>;
  };
  logger?: { warn(payload: Record<string, unknown>, message: string): void };
}

export interface EmbeddedRustBackendTimings {
  /** Max wait for the stdout `bound` frame after spawn. */
  frameTimeoutMs: number;
  /** Total startup budget from entry through frame, readiness and epoch verification. */
  readyTimeoutMs: number;
  /** `/readyz` poll interval. */
  readyPollIntervalMs: number;
  /** Grace period for a graceful child exit before SIGKILL on `close()`. */
  shutdownGraceMs: number;
  /** Per-HTTP-attempt timeout (bounds a single `/readyz` or server-info fetch so one hung
   * request cannot consume the whole ready budget). */
  httpAttemptTimeoutMs: number;
}

export const DEFAULT_TIMINGS: EmbeddedRustBackendTimings = {
  frameTimeoutMs: 30_000,
  readyTimeoutMs: 30_000,
  readyPollIntervalMs: 100,
  shutdownGraceMs: 5_000,
  httpAttemptTimeoutMs: 5_000,
};

/**
 * Launch the embedded Rust backend child and return a handle once it is BOUND,
 * `/readyz`-confirmed, and epoch-compatible. The DB migration MUST already be done and
 * the DB fully closed by the caller (no dual-open). Any failure reclaims the child +
 * token and throws a typed `EmbeddedRustBackendStartError` — no handle/URL is ever
 * published on a failure path.
 */
export async function startEmbeddedRustBackend(
  sidecar: VerifiedSidecar,
  config: EmbeddedRustBackendConfig,
  deps: EmbeddedRustBackendDeps,
  timings: EmbeddedRustBackendTimings = DEFAULT_TIMINGS,
): Promise<EmbeddedRustBackendHandle> {
  const deadline = deps.clock.now() + timings.readyTimeoutMs;
  await deps.removeBootstrapToken(config.bootstrapTokenPath);
  if (config.signal?.aborted) {
    throw new EmbeddedRustBackendStartError('shutdown-during-startup', 'startup cancelled');
  }
  const generation = deps.mintGeneration();
  const env = buildChildEnv(config, generation);

  let child: ChildProcess;
  try {
    child = deps.spawn(sidecar.executablePath, env);
  } catch (err) {
    // A synchronous spawn throw means the child never existed; only the token could be
    // stale from a prior run, so best-effort clean it and fail loud.
    await deps
      .removeBootstrapToken(config.bootstrapTokenPath)
      .catch(() => undefined);
    throw new EmbeddedRustBackendStartError(
      'spawn-failed',
      'failed to spawn the embedded Rust backend',
      err,
    );
  }

  // The persistent monitor drains the child's stdout for its WHOLE lifetime.
  const monitor = new StartupProtocolMonitor(child, generation);

  // A single owner for teardown across every failure path — no orphan, token cleaned.
  const reclaim = async (): Promise<void> => {
    monitor.dispose();
    await terminateChild(child, timings.shutdownGraceMs, deps.clock);
    await deps
      .removeBootstrapToken(config.bootstrapTokenPath)
      .catch((err) =>
        deps.logger?.warn(
          { err },
          'embedded Rust backend: bootstrap token cleanup failed on reclaim',
        ),
      );
  };

  try {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    config.signal?.addEventListener('abort', abort, { once: true });
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let bound = false;
    const cancelled = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(
        new EmbeddedRustBackendStartError('shutdown-during-startup', 'startup cancelled'),
      ), { once: true });
      deadlineTimer = setTimeout(() => reject(new EmbeddedRustBackendStartError(
        bound ? 'readiness-timeout' : 'eof-before-frame', 'embedded backend exceeded the total startup deadline',
      )), Math.max(0, deadline - deps.clock.now()));
    });
    try {
      const frame = await Promise.race([monitor.awaitBoundFrame(timings, deps), cancelled]);
      bound = true;
      // Probe work and terminal events share the deadline established at startup entry.
      await Promise.race([
        runReadyAndEpochGate(frame.url, config, child, monitor, timings, deps, controller.signal),
        cancelled,
      ]);
      monitor.assertLive();
      if (config.signal?.aborted) {
        throw new EmbeddedRustBackendStartError('shutdown-during-startup', 'startup cancelled');
      }
      return buildHandle(child, frame, config, timings, deps, monitor);
    } finally {
      clearTimeout(deadlineTimer);
      controller.abort();
      config.signal?.removeEventListener('abort', abort);
    }
  } catch (err) {
    await reclaim();
    throw err;
  }
}

/** The explicit env boundary — the SINGLE place the launcher hands the child its config.
 * Names mirror the Rust `AppConfig::from_env` contract. */
function buildChildEnv(
  config: EmbeddedRustBackendConfig,
  generation: string,
): Record<string, string> {
  const env: Record<string, string> = {
    SILVERHAND_DATABASE_PATH: config.databasePath,
    SILVERHAND_BLOBS_ROOT: config.blobsRoot,
    SILVERHAND_LOG_DIR: config.logDir,
    SILVERHAND_BOOTSTRAP_TOKEN_PATH: config.bootstrapTokenPath,
    SILVERHAND_LISTEN_ADDR: `${config.listen.hostname}:${config.listen.port}`,
    SILVERHAND_ALLOWED_ORIGINS: config.allowedOrigins.join(','),
    SILVERHAND_DEPLOYMENT_PROFILE: 'embedded',
    SILVERHAND_STARTUP_GENERATION: generation,
  };
  if (config.daemonNpmSpec) env.SILVERHAND_DAEMON_NPM_SPEC = config.daemonNpmSpec;
  if (config.disableSignup) env.SILVERHAND_DISABLE_SIGNUP = '1';
  return env;
}

/**
 * #task:2343 P1 — a persistent startup-protocol monitor that CONTINUOUSLY drains the
 * child's stdout for its whole lifetime, and owns the child's exit/error/stream events.
 * stdout carries ONLY the one bound frame — a second non-blank line is never valid.
 *
 * Phases:
 *  - `awaiting`: `awaitBoundFrame` resolves on the first `bound` frame, rejects on
 *    invalid/duplicate/early-exit/error/timeout (each typed).
 *  - `bound` (frame accepted, handle NOT yet published): a second non-blank line, a child
 *    exit, or a stdout stream error is a PRE-PUBLISH violation — it settles the
 *    `prepublish` waiter so the startup promise rejects and the child is reclaimed BEFORE
 *    any handle/URL exists (P0-1). No pending-flag-then-return race.
 *  - `published`: the same events fire the TYPED terminal callback exactly once (P0-4),
 *    so the Desktop main invalidates the backend rather than silently dropping the line.
 */
class StartupProtocolMonitor {
  private readonly reader: BoundFrameReader;
  private phase: 'awaiting' | 'bound' | 'published' | 'disposed' = 'awaiting';
  private onData: ((chunk: Buffer | string) => void) | null = null;
  private onExit: ((code: number | null, signal: NodeJS.Signals | null) => void) | null =
    null;
  private onError: ((err: Error) => void) | null = null;
  private onStdoutError: ((err: Error) => void) | null = null;
  private onStdoutEnd: (() => void) | null = null;
  private boundTimer: { clear(): void } | null = null;

  /** Pre-publish (phase `bound`) waiter: resolved with a terminal reason if the child
   * dies or violates the protocol before the handle is published. */
  private prepublishWaiter: {
    resolve: (reason: EmbeddedRustBackendTerminalReason) => void;
  } | null = null;

  /** Post-publish terminal state (P0-4). */
  private terminalReason: EmbeddedRustBackendTerminalReason | null = null;
  private terminalListener:
    | ((reason: EmbeddedRustBackendTerminalReason) => void)
    | null = null;

  constructor(
    private readonly child: ChildProcess,
    generation: string,
  ) {
    this.reader = new BoundFrameReader(generation);
  }

  awaitBoundFrame(
    timings: EmbeddedRustBackendTimings,
    deps: EmbeddedRustBackendDeps,
  ): Promise<{ url: string; port: number }> {
    return new Promise((resolve, reject) => {
      let done = false;
      const settleReject = (err: EmbeddedRustBackendStartError): void => {
        if (done) return;
        done = true;
        timeout.clear();
        reject(err);
      };
      const settleResolve = (frame: { url: string; port: number }): void => {
        if (done) return;
        done = true;
        timeout.clear();
        this.phase = 'bound';
        resolve(frame);
      };
      const onData = (chunk: Buffer | string): void => {
        const outcome = this.reader.push(chunk);
        if (outcome === null) return;
        if (this.phase === 'awaiting') {
          if (outcome.status === 'bound') {
            settleResolve(outcome.frame);
          } else if (outcome.status === 'duplicate') {
            settleReject(
              new EmbeddedRustBackendStartError(
                'duplicate-frame',
                'embedded Rust backend emitted more than one stdout frame before bound',
              ),
            );
          } else {
            settleReject(
              new EmbeddedRustBackendStartError(
                'invalid-frame',
                `embedded Rust backend startup frame invalid: ${outcome.reason}`,
                outcome.reason,
              ),
            );
          }
        } else {
          // phase `bound` (pre-publish) or `published`: a further non-blank line is a
          // protocol violation — stdout carries ONLY the one frame.
          if (outcome.status !== 'bound') {
            this.fireViolation('a second stdout line after the bound frame');
          }
        }
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (this.phase === 'awaiting') {
          settleReject(
            new EmbeddedRustBackendStartError(
              'child-exited-early',
              `embedded Rust backend exited before its bound frame (code=${code}, signal=${signal})`,
            ),
          );
        } else {
          this.fireTerminal({ kind: 'child-exited', code, signal });
        }
      };
      const onError = (err: Error): void => {
        if (this.phase === 'awaiting') {
          settleReject(
            new EmbeddedRustBackendStartError(
              'spawn-failed',
              'embedded Rust backend process error before its bound frame',
              err,
            ),
          );
        } else {
          this.fireTerminal({ kind: 'stream-fatal', detail: `process error: ${err.message}` });
        }
      };
      const onStdoutError = (err: Error): void => {
        if (this.phase === 'awaiting') {
          settleReject(
            new EmbeddedRustBackendStartError(
              'eof-before-frame',
              `embedded Rust backend stdout errored before its bound frame: ${err.message}`,
              err,
            ),
          );
        } else {
          this.fireTerminal({ kind: 'stream-fatal', detail: `stdout stream error: ${err.message}` });
        }
      };
      const timeout = setTimeoutHandle(deps.clock, timings.frameTimeoutMs, () => {
        settleReject(
          new EmbeddedRustBackendStartError(
            'eof-before-frame',
            `embedded Rust backend did not emit its bound frame within ${timings.frameTimeoutMs}ms`,
          ),
        );
      });
      this.boundTimer = timeout;
      this.onData = onData;
      this.onExit = onExit;
      this.onError = onError;
      this.onStdoutError = onStdoutError;
      this.onStdoutEnd = () => onStdoutError(new Error('stdout EOF'));
      this.child.stdout?.on('data', onData);
      this.child.stdout?.on('error', onStdoutError);
      this.child.stdout?.on('end', this.onStdoutEnd);
      this.child.on('exit', onExit);
      this.child.on('error', onError);
    });
  }

  /**
   * #task:2343 P0-1 — wait for a PRE-PUBLISH terminal event (child exit / protocol
   * violation / stdout stream error) that arrives between the bound frame and publish.
   * Resolves with the reason; the readiness gate races this so a mid-probe violation
   * rejects the startup promise and reclaims the child before any handle is published.
   */
  awaitPrepublishTerminal(): Promise<EmbeddedRustBackendTerminalReason> {
    return new Promise((resolve) => {
      if (this.terminalReason) { resolve(this.terminalReason); return; }
      this.prepublishWaiter = { resolve };
    });
  }

  assertLive(): void {
    if (!this.terminalReason) return;
    const reason = this.terminalReason;
    throw new EmbeddedRustBackendStartError(
      reason.kind === 'child-exited' ? 'child-exited-early' : reason.kind === 'protocol-violation' ? 'duplicate-frame' : 'eof-before-frame',
      'embedded backend terminated before publication', reason,
    );
  }

  /** Transition to `published`; register the typed terminal owner. If the backend
   * already terminated between resolve and publish, the reason is delivered on the next
   * microtask. */
  publish(listener: (reason: EmbeddedRustBackendTerminalReason) => void): void {
    this.phase = 'published';
    this.terminalListener = listener;
    this.prepublishWaiter = null;
    if (this.terminalReason) {
      const reason = this.terminalReason;
      queueMicrotask(() => {
        if (this.terminalListener) {
          this.terminalListener = null;
          listener(reason);
        }
      });
    }
  }

  private fireViolation(detail: string): void {
    this.deliverTerminal({ kind: 'protocol-violation', detail });
  }

  private fireTerminal(reason: EmbeddedRustBackendTerminalReason): void {
    this.deliverTerminal(reason);
  }

  private deliverTerminal(reason: EmbeddedRustBackendTerminalReason): void {
    if (this.phase === 'bound') {
      if (this.terminalReason) return;
      this.terminalReason = reason;
      // Pre-publish: reject the in-flight startup through the readiness-gate race.
      if (this.prepublishWaiter) {
        const w = this.prepublishWaiter;
        this.prepublishWaiter = null;
        w.resolve(reason);
      } else if (!this.terminalReason) {
        // No waiter yet (shouldn't happen — gate installs it synchronously) — stash.
        this.terminalReason = reason;
      }
      return;
    }
    if (this.phase === 'published') {
      if (this.terminalReason) return; // fire once
      this.terminalReason = reason;
      const listener = this.terminalListener;
      this.terminalListener = null;
      listener?.(reason);
    }
    // phase awaiting/disposed: awaiting is handled by awaitBoundFrame's own settles;
    // disposed ignores.
  }

  dispose(): void {
    this.phase = 'disposed';
    this.boundTimer?.clear();
    this.boundTimer = null;
    if (this.onData) this.child.stdout?.off('data', this.onData);
    if (this.onStdoutError) this.child.stdout?.off('error', this.onStdoutError);
    if (this.onStdoutEnd) this.child.stdout?.off('end', this.onStdoutEnd);
    if (this.onExit) this.child.off('exit', this.onExit);
    if (this.onError) this.child.off('error', this.onError);
    this.onData = null;
    this.onStdoutError = null;
    this.onExit = null;
    this.onError = null;
    this.terminalListener = null;
    this.prepublishWaiter = null;
  }
}

/**
 * #task:2343 P0-1/P0-2 — run the readiness poll then the epoch check under ONE shared,
 * cancelable startup deadline, racing:
 *   - a PRE-PUBLISH protocol violation / child exit / stream fatal (rejects immediately),
 *   - the bounded HTTP work (each attempt under its own AbortSignal),
 * so a never-resolving fetch cannot bypass the budget and a second stdout line during the
 * probe cancels startup before any handle/URL is published.
 */
async function runReadyAndEpochGate(
  url: string,
  config: EmbeddedRustBackendConfig,
  child: ChildProcess,
  monitor: StartupProtocolMonitor,
  timings: EmbeddedRustBackendTimings,
  deps: EmbeddedRustBackendDeps,
  signal: AbortSignal,
): Promise<void> {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) controller.abort();
  // The pre-publish terminal race: if the child dies or violates the protocol during the
  // probe, reject the whole gate (and abort any in-flight fetch).
  const violation = monitor.awaitPrepublishTerminal().then((reason) => {
    controller.abort();
    if (reason.kind === 'child-exited') {
      throw new EmbeddedRustBackendStartError(
        'child-exited-early',
        `embedded Rust backend exited during startup readiness (code=${reason.code}, signal=${reason.signal})`,
      );
    }
    if (reason.kind === 'protocol-violation') {
      throw new EmbeddedRustBackendStartError(
        'duplicate-frame',
        `embedded Rust backend protocol violation during startup: ${reason.detail}`,
      );
    }
    throw new EmbeddedRustBackendStartError(
      'eof-before-frame',
      `embedded Rust backend stdout fatal during startup: ${reason.detail}`,
    );
  });

  const work = (async () => {
    await awaitReadyz(url, child, controller.signal, timings, deps);
    await awaitEpochCheck(url, config, child, controller.signal, timings, deps);
  })();

  try {
    await Promise.race([work, violation]);
  } finally {
    controller.abort();
    signal.removeEventListener('abort', abort);
  }
}

/** Poll `${url}/readyz` until 200 within the ready timeout, aborting if the child exits or
 * the shared controller aborts. Each probe attempt is itself bounded. */
async function awaitReadyz(
  url: string,
  child: ChildProcess,
  signal: AbortSignal,
  timings: EmbeddedRustBackendTimings,
  deps: EmbeddedRustBackendDeps,
): Promise<void> {
  const deadline = deps.clock.now() + timings.readyTimeoutMs;
  for (;;) {
    if (signal.aborted) {
      throw new EmbeddedRustBackendStartError(
        'shutdown-during-startup',
        'embedded Rust backend readiness aborted',
      );
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new EmbeddedRustBackendStartError(
        'child-exited-early',
        `embedded Rust backend exited before /readyz (code=${child.exitCode}, signal=${child.signalCode})`,
      );
    }
    if (await probeWithAttemptTimeout((s) => deps.probeReadyz(url, s), signal, timings, deps)) {
      return;
    }
    if (deps.clock.now() >= deadline) {
      throw new EmbeddedRustBackendStartError(
        'readiness-timeout',
        `embedded Rust backend /readyz not 200 within ${timings.readyTimeoutMs}ms`,
      );
    }
    await deps.clock.sleep(timings.readyPollIntervalMs);
  }
}

/**
 * #task:2343 P0 — the API-epoch compatibility gate. AFTER `/readyz=200` and BEFORE the
 * handle is published, read `/api/server/info.desktop_api` and require the embedded
 * backend to be wire-compatible with the Desktop's compiled epoch range. A missing/
 * malformed/aborted server-info, or an incompatible epoch, is a hard startup failure
 * (the caller reclaims the child + token) — never a fallback.
 */
async function awaitEpochCheck(
  url: string,
  config: EmbeddedRustBackendConfig,
  child: ChildProcess,
  signal: AbortSignal,
  timings: EmbeddedRustBackendTimings,
  deps: EmbeddedRustBackendDeps,
): Promise<void> {
  if (signal.aborted) {
    throw new EmbeddedRustBackendStartError(
      'shutdown-during-startup',
      'embedded Rust backend epoch check aborted',
    );
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new EmbeddedRustBackendStartError(
      'child-exited-early',
      `embedded Rust backend exited before the epoch check (code=${child.exitCode}, signal=${child.signalCode})`,
    );
  }
  const advertised = await probeAttempt(
    (s) => deps.probeServerInfoEpoch(url, s),
    null,
    signal,
    timings,
    deps,
  );
  if (advertised === null) {
    throw new EmbeddedRustBackendStartError(
      'server-info-unavailable',
      'embedded Rust backend /api/server/info was unreachable or malformed for the epoch check',
    );
  }
  const compatibility = classifyDesktopServerApiCompatibility({
    clientEpoch: config.apiEpoch.clientEpoch,
    minimumClientEpoch: advertised.minimumClientEpoch,
    serverEpoch: advertised.currentEpoch,
    minimumServerEpoch: config.apiEpoch.minimumServerEpoch,
  });
  if (compatibility !== 'compatible') {
    throw new EmbeddedRustBackendStartError(
      'epoch-incompatible',
      `embedded Rust backend API epoch incompatible (${compatibility}): `
        + `client=${config.apiEpoch.clientEpoch} server=${advertised.currentEpoch} `
        + `minClient=${advertised.minimumClientEpoch} minServer=${config.apiEpoch.minimumServerEpoch}`,
      compatibility,
    );
  }
}

/** Run a single HTTP attempt under a per-attempt AbortSignal linked to the shared signal
 * AND a per-attempt timeout, returning `false` (readyz) if it does not complete in time —
 * a hung socket is cancelled rather than consuming the whole budget. */
async function probeWithAttemptTimeout(
  attempt: (signal: AbortSignal) => Promise<boolean>,
  shared: AbortSignal,
  timings: EmbeddedRustBackendTimings,
  deps: EmbeddedRustBackendDeps,
): Promise<boolean> {
  return probeAttempt(attempt, false, shared, timings, deps);
}

/** Generic bounded attempt: races the probe against the per-attempt timeout and the
 * shared abort; on timeout/abort it aborts the attempt's signal and returns `fallback`.
 * The probe implementations never throw. */
async function probeAttempt<T>(
  attempt: (signal: AbortSignal) => Promise<T>,
  fallback: T,
  shared: AbortSignal,
  timings: EmbeddedRustBackendTimings,
  deps: EmbeddedRustBackendDeps,
): Promise<T> {
  const attemptController = new AbortController();
  let resolveAbort!: (value: T) => void;
  const aborted = new Promise<T>(resolve => { resolveAbort = resolve; });
  const onSharedAbort = (): void => { attemptController.abort(); resolveAbort(fallback); };
  if (shared.aborted) onSharedAbort();
  else shared.addEventListener('abort', onSharedAbort, { once: true });
  let timerId: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<T>(resolve => {
    timerId = setTimeout(() => { attemptController.abort(); resolve(fallback); }, timings.httpAttemptTimeoutMs);
  });
  try {
    return await Promise.race([attempt(attemptController.signal), timer, aborted]);
  } finally {
    clearTimeout(timerId);
    shared.removeEventListener('abort', onSharedAbort);
    attemptController.abort();
  }
}

function buildHandle(
  child: ChildProcess,
  frame: { url: string; port: number },
  config: EmbeddedRustBackendConfig,
  timings: EmbeddedRustBackendTimings,
  deps: EmbeddedRustBackendDeps,
  monitor: StartupProtocolMonitor,
): EmbeddedRustBackendHandle {
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= (async () => {
    monitor.dispose();
    await terminateChild(child, timings.shutdownGraceMs, deps.clock);
    await deps
      .removeBootstrapToken(config.bootstrapTokenPath)
      .catch((err) =>
        deps.logger?.warn(
          { err },
          'embedded Rust backend: bootstrap token cleanup failed on close',
        ),
      );
  })();

  // #task:2343 P0-4 — a single external terminal owner. The monitor keeps draining stdout
  // and owns exit/error for the whole child lifetime; a post-publish fatal (child crash,
  // stray/duplicate line, stdout stream error) delivers a TYPED reason here so the Desktop
  // main can invalidate the backend + control-plane URL and route the renderer through the
  // visible runtime-failure path. We do NOT auto-close here: the owner decides (it will
  // call `close()` as part of invalidation), and `close()` is idempotent.
  let externalListener:
    | ((reason: EmbeddedRustBackendTerminalReason) => void)
    | null = null;
  let terminal: EmbeddedRustBackendTerminalReason | null = null;
  monitor.publish((reason) => {
    terminal = reason;
    deps.logger?.warn(
      { url: frame.url, reason },
      'embedded Rust backend terminated after publish — surfacing typed terminal reason',
    );
    externalListener?.(reason);
  });

  return {
    url: frame.url,
    port: frame.port,
    onTerminal: (listener) => {
      externalListener = listener;
      if (terminal) listener(terminal);
    },
    close,
  };
}

/** Signal the child and await its exit within the grace period; SIGKILL on timeout so
 * there is never an orphan. Resolves once the child is gone (or was never alive).
 *
 * #task:2343 P0-5 — Node can emit `error` WITHOUT a following `exit` (e.g. an ENOENT that
 * surfaces asynchronously). We therefore resolve on `exit` OR `error`, and never wait
 * forever: after SIGKILL we await the same exit-or-error race under a final bounded grace
 * so a phantom child (error emitted, exit never coming) still completes reclaim. */
async function terminateChild(
  child: ChildProcess,
  graceMs: number,
  clock: EmbeddedRustBackendDeps['clock'],
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const timers: ReturnType<typeof setTimeout>[] = [];
  const wait = (ms: number): Promise<void> => new Promise(resolve => { timers.push(setTimeout(resolve, ms)); });
  let finish = (): void => {};
  const gone = (): Promise<void> =>
    new Promise<void>((resolve) => {
      let settled = false;
      finish = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      child.once('exit', finish);
      child.once('error', finish);
    });
  const exited = gone();
  try {
  child.kill('SIGTERM');
  const first = await Promise.race([
    exited.then(() => 'exited' as const),
    wait(graceMs).then(() => 'timeout' as const),
  ]);
  if (first === 'exited') return;
  child.kill('SIGKILL');
  // Bounded final wait — do not hang forever on a child that will never emit `exit`.
  await Promise.race([
    exited,
    wait(graceMs),
  ]);
  } finally {
    timers.forEach(clearTimeout);
    child.off('exit', finish);
    child.off('error', finish);
  }
}

/** Bridge the module's minimal clock to a clearable timeout. */
function setTimeoutHandle(
  clock: EmbeddedRustBackendDeps['clock'],
  ms: number,
  fn: () => void,
): { clear(): void } {
  const timer = setTimeout(fn, ms);
  return {
    clear: () => {
      clearTimeout(timer);
    },
  };
}

/**
 * #task:2343 — compose the child's process env: a NARROW inherited-OS allowlist plus the
 * launcher-owned explicit config boundary. #task:2343 P1-7: the child must NOT inherit the
 * parent's whole environment — unknown `SILVERHAND_*` keys, credentials, and injection
 * vectors (`DYLD_*`, `LD_*`, `NODE_OPTIONS`, …) must never reach the backend. Only a
 * fixed allowlist of OS runtime essentials (PATH, locale, temp dir, HOME) is forwarded,
 * and every backend input arrives through the explicit launcher boundary. This is the
 * SINGLE composer; there is no `{...process.env, ...boundary}` path.
 */
export function composeRustBackendChildEnv(
  boundaryEnv: Record<string, string>,
  inheritedEnv: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const composed: Record<string, string | undefined> = {};
  for (const key of INHERITED_ENV_ALLOWLIST) {
    const value = inheritedEnv[key];
    if (value !== undefined) composed[key] = value;
  }
  // The launcher-owned boundary is authoritative and always wins.
  for (const [key, value] of Object.entries(boundaryEnv)) {
    composed[key] = value;
  }
  return composed;
}

/** The fixed set of inherited OS-runtime env keys the child may see. Deliberately narrow:
 * process/loader essentials + locale + temp/home; NOTHING that could carry a credential,
 * a launcher secret, an unmodelled `SILVERHAND_*` input, or a code-injection vector. */
const INHERITED_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  // Windows process essentials (harmless no-ops on POSIX).
  'SystemRoot',
  'SystemDrive',
  'windir',
  'USERPROFILE',
  'PATHEXT',
  'COMSPEC',
];
