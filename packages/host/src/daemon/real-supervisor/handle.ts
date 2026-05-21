/**
 * RuntimeHandle — per-(conversation, agent) execution-plane state
 * owned by `RealSupervisor`.
 *
 * 3a scope: spawn / output / hard-stop / exit. 3b adds parse-fanout
 * state (line buffer + per-handle AgentRunState), startup-delivery
 * step-0 gating, and the `initObserved` flag the wake gate keys off.
 * 3c will add watchdog timers, retry/cooldown bookkeeping, and the
 * lifecycle-lock. Each addition stays inside this file; consumers
 * reach the handle only through `RealSupervisor` methods.
 */
import type { ChildProcess } from 'node:child_process';
import type { AgentRunState } from '@silverhand/shared';
import type { Driver } from '../../drivers/index.js';

export type RuntimePhase =
  | 'spawning'
  | 'startup_pending'
  | 'ready'
  | 'draining'
  | 'exited';

/**
 * Step-0 startup-delivery gating state. Presence of this object is
 * the SINGLE source of truth for "this runtime has a startup batch
 * still in flight" — `null` means no batch pending (whether because
 * `start()` was called without `startup_delivery`, or because the
 * batch settled and the supervisor cleared this field).
 *
 * Cindy `_JjyK8UrpcmYA5Iu` + `wuiwdLKrLFyGip_s`: keep this a
 * separate, explicit field (not derived from a `Set<number>` of
 * delivery ids) so the state machine bit and the idempotency-ids
 * cannot drift. Settle order is fixed:
 *   1. stdin write resolves (success or failure determined)
 *   2. emit `runtime_startup_delivery_consumed` OR `_failed`
 *   3. set `startupDelivery = null`
 *   4. only NOW can `maybeEmitReadyForDrain` fire
 * This prevents a stray `runtime_wake` from sneaking past the gate
 * between "consumed/failed event sent" and "pending cleared".
 */
export interface StartupDeliveryState {
  readonly deliveryIds: readonly number[];
}

export interface RuntimeHandle {
  readonly conversationId: string;
  readonly agentId: string;
  /** OS process id. Stable for the lifetime of the handle; `null` is
   *  not legal — if we don't have a pid the handle never gets
   *  created. */
  readonly pid: number;
  /** Wall-clock ms at spawn. Combined with `pid` to derive a stable
   *  `runId` for `runtime_state` events. */
  readonly startedAt: number;
  /** Live driver instance (per-spawn factory output). Holds any
   *  per-handle protocol counters codex/cursor accumulate. */
  readonly driver: Driver;
  /** The actual child process. Owned by the handle; cleanup releases
   *  stdio streams + removes listeners. */
  readonly child: ChildProcess;
  /** Current execution phase. Updated in-place by RealSupervisor as
   *  the process moves through its lifecycle. */
  phase: RuntimePhase;
  /** Output flow-control flag. `true` while `pauseOutput()` is in
   *  effect; raw stdout/stderr chunks are dropped silently while
   *  paused (no buffer-and-replay in 3a — 3b will revisit). */
  outputPaused: boolean;
  /** Final exit code observed via the child's `exit` event, or `null`
   *  if the process exited via signal without a code. Populated when
   *  phase transitions to `'exited'`; before then it is `null`. */
  exitCode: number | null;
  /** Whether the most recent transition to `draining` was caused by
   *  an intentional stop() / clearSession() / stopAll() request. Drives
   *  the `intentional` field on `runtime_exit`. Set true on stop;
   *  defaults to false (crash interpretation). */
  intentionalExit: boolean;
  /** Pending SIGTERM → SIGKILL timer, if a hard stop is in progress.
   *  Cleared when the child exits or the timer fires. */
  sigkillTimer: NodeJS.Timeout | null;

  // ── 3b additions ─────────────────────────────────────────────────

  /** Step-0 startup-delivery gating; see `StartupDeliveryState`. */
  startupDelivery: StartupDeliveryState | null;
  /** Sub-relation of `startupDelivery !== null` (Cindy
   *  `GMbjEkGUHrB1BBMe`): when true, the stdin write succeeded but
   *  the daemon is holding the consumed-emit until the runtime
   *  confirms via `session_init` (mirrors CM's
   *  `initPendingInboxIds` defer-markDelivered path for
   *  `requires_first_message` drivers). NOT a second source of
   *  truth — `runtime_wake` / `maybeEmitReadyForDrain` still gate
   *  ONLY on `startupDelivery !== null`. Cleared in the same
   *  critical section as `startupDelivery` via `clearStartupGate`,
   *  so the `(null, true)` interleaving is impossible. */
  startupAwaitingInit: boolean;
  /** Whether `runtime_ready_for_drain` has been emitted for this run.
   *  Step-0 mutex (Cindy): we emit at most one per (conv,agent,run);
   *  re-spawn resets via a fresh handle. */
  readyForDrainEmitted: boolean;
  /** True once a parsed `session_init` event has been observed.
   *  Drives the wake gate's `not_initialized` arm and the future
   *  3c init-watchdog cancellation. */
  initObserved: boolean;
  /** Cached cli session id from the latest `session_init`. Backend
   *  re-uses it on resume; daemon holds it so wake/soft-stop can
   *  surface its presence (3c gating). */
  cliSessionId: string | null;
  /** Residue from line-splitting stdout chunks. The daemon hands
   *  driver.parseLine complete lines only; bytes not terminated by
   *  `\n` accumulate here until the next chunk arrives or the child
   *  exits (a half-line at exit is forwarded as a trailing parse). */
  stdoutLineBuffer: string;
  /** Per-handle AgentRunState. Initialized lazily when the first
   *  parsed event arrives (or at start()) so `status()` always has
   *  a meaningful `run_state` to project. */
  runState: AgentRunState | null;
  /** Per-handle tool-call bookkeeping so `tool_output` knows when to
   *  drop status back to `thinking`. Mirrors CM's `handle.busy`. */
  busy: { outstandingToolUses: number; compacting: boolean };
}

