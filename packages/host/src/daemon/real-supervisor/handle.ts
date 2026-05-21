/**
 * RuntimeHandle — per-(conversation, agent) execution-plane state
 * owned by `RealSupervisor`.
 *
 * 3a scope: spawn / output / hard-stop / exit. 3b adds parse-fanout
 * state (line buffer + per-handle AgentRunState), startup-delivery
 * step-0 gating, and the `initObserved` flag the wake gate keys off.
 * 3c-b adds the init-watchdog timers, retry/cooldown bookkeeping,
 * and the compaction watchdog. The lifecycle-lock lives on the
 * supervisor (`lifecycleTails: Map<key, Promise<void>>`) rather than
 * the handle so that operations on a (conv, agent) with no handle yet
 * (e.g. a fresh `start`) still queue correctly.
 *
 * Consumers reach the handle only through `RealSupervisor` methods.
 */
import type { ChildProcess } from 'node:child_process';
import type { AgentRunState } from '@silverhand/shared';
import type { Driver } from '../../drivers/index.js';
import type { RuntimeStartParams } from '../../protocol.js';

/** Tier name for the 3-tier init watchdog. Matches CM's
 *  `InitTimeoutReason` so the wire `runtime_init_timeout.timeout_reason`
 *  can carry these values through unmodified. */
export type InitTimeoutReason =
  | 'silence'
  | 'pre_protocol_cap'
  | 'post_protocol';

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
  /**
   * Option A v2 (Cindy `UMGu36zoTDVuKWXi`): the unencoded text the
   * daemon will encode + write at consume time using its in-process
   * `handle.driver.encodeStdinMessage(text, handle.cliSessionId)`.
   * Held on the gate (not in a separate field) so there is exactly
   * ONE source of truth for the pending batch: clearing the gate
   * also drops the text. Stateful drivers (codex) consume only after
   * `driver.readyToEncode()` flips true; stateless drivers (claude)
   * consume immediately.
   */
  readonly text: string;
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

  // ── 3c-b additions ───────────────────────────────────────────────

  /** Cached original `RuntimeStartParams` minus `startup_delivery`,
   *  used by `internalRespawnForRetry` so a watchdog-triggered
   *  re-spawn re-runs `start()` with the same `options` and the same
   *  (conv, agent). startup_delivery is intentionally NOT carried —
   *  the original payload was either consumed or failed before the
   *  timeout fired, and the daemon cannot reliably replay it. Backend's
   *  inbox path handles redelivery via `runtime_wake` on the new
   *  handle. */
  spawnParams: RuntimeStartParams;

  /** Init watchdog state — three timers (silence / pre-protocol cap /
   *  post-protocol) plus the cross-cutting bookkeeping. `armed`
   *  protects against double-arming on the deferred-init path
   *  (claude empty-inbox: arm only when wake actually writes). All
   *  three timers are independently cleared once `initObserved` flips
   *  (session_init parsed). */
  initWatchdogArmed: boolean;
  initStartedAt: number;
  initProtocolObserved: boolean;
  initTimedOut: boolean;
  initTimeoutReason: InitTimeoutReason | null;
  initLivenessSilenceTimer: NodeJS.Timeout | null;
  initPreProtocolCapTimer: NodeJS.Timeout | null;
  initPostProtocolTimer: NodeJS.Timeout | null;

  /** 0-indexed attempt counter for this (conv, agent). `0` = first
   *  user-initiated start; daemon-internal retry respawns bump it.
   *  The cooldown gate in `start()` only fires for `initAttempt === 0`
   *  per Cindy plan v2 issue #3. */
  initAttempt: number;
  /** Decided at the moment `failInitWatchdog` fires: whether the
   *  child-exit handler should respawn (`true`) or finalize as a
   *  terminal init failure (`false` → may also engage cooldown). */
  initRetryPlanned: boolean;

  /** Compaction watchdog. Set when `compaction_started` parsed event
   *  arrives; cleared on `compaction_finished` or on exit. When it
   *  fires we emit `runtime_compaction_stale` (observational only —
   *  does NOT kill the child) and stack `compactionStale: true` onto
   *  the runState while preserving `compacting: true` (Cindy plan
   *  v2 issue #4). */
  compactionWatchdog: NodeJS.Timeout | null;
}

