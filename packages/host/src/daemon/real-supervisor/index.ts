/**
 * RealSupervisor — production supervisor for the silverhand daemon.
 *
 * Step 2 commit 3a/3b scope (locked with Cindy in
 * `wjay-7-ARIgrFzOf` → `jhH-vC1s_1J_jTLu` →
 * `OQCA05pivtB8nSTC` → `C2BZGDbQWfnq-bKJ`):
 *
 * 3a (committed `82230e2`):
 *   - spawn agent runtime via `child_process.spawn` using the driver's
 *     `buildArgs` / `applyEnv`
 *   - own the `ChildProcess` lifecycle (stdout / stderr / exit)
 *   - pump raw stdout/stderr to `runtime_output` events (per-chunk)
 *   - hard stop: SIGTERM → 5s → SIGKILL → 10s cascade, emitting
 *     `runtime_state` (draining) then `runtime_exit` on close
 *   - `status()` returns a per-(conv, agent) snapshot
 *   - `pauseOutput` / `resumeOutput` flip a flag + emit ack events
 *     (raw output drops while paused)
 *
 * 3b (this commit):
 *   - line-buffered stdout → `driver.parseLine` → per-event fanout
 *     onto `runtime_parsed_event`. Raw `runtime_output` is unchanged
 *     (Cindy `C2BZGDbQWfnq-bKJ`: parsed_event is a sidecar, not a
 *     replacement). Frame-too-large parsed events surface as
 *     `runtime_parsed_event_dropped` metadata-only frames.
 *   - per-handle `AgentRunState` lifecycle driven by parsed events
 *     (thinking / tool_running / compacting / idle), with `runId`
 *     stable across the run.
 *   - `wake()` writes the opaque stream-json payload to stdin with
 *     step-0 mutex gating (`startup_pending` rejection while the
 *     start batch is still in flight).
 *   - `stop({ mode: 'soft' })` writes the backend-supplied directive
 *     payload to stdin and reports `{directive_delivered, reason?}`.
 *   - `start()` now accepts `startup_delivery` — phase pins to
 *     `startup_pending`, the supervisor consumes the payload, emits
 *     `runtime_startup_delivery_consumed` or `_failed`, then clears
 *     the gate. Only AFTER the gate clears AND the runtime is `ready`
 *     does `runtime_ready_for_drain` fire (single, idempotent emit).
 *
 * Explicitly NOT in 3a/3b (will land in 3c):
 *   - 3-tier init watchdog (silence / pre-protocol-cap / post-protocol)
 *   - retry / cooldown loop on init failure
 *   - compaction watchdog
 *   - lifecycle-lock atomicity for concurrent start/stop
 *   - host-side resume-state clear (`driver` API to invalidate
 *     `claude --resume` after `clearSession`)
 *
 * Wiring: NOT wired into `runDaemon` yet — FakeSupervisor stays the
 * default until commit 5's atomic flip. 3a/3b tests instantiate
 * RealSupervisor directly to validate execution-plane behavior in
 * isolation.
 */
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { setTimeout as setTimer } from 'node:timers';
import { randomUUID } from 'node:crypto';
import {
  type AgentRunState,
  type ParsedEvent,
  ParsedEventSchema,
  type RuntimeKind,
} from '@silverhand/shared';

import { getDriver as getDefaultDriver, type Driver } from '../../drivers/index.js';
import { detectRuntimes } from '../../runtimes.js';
import {
  encodeFrame,
  MAX_FRAME_BYTES,
  type EventFrame,
  type RuntimeClearSessionParams,
  type RuntimeClearSessionResult,
  type RuntimeCloseActivityLogParams,
  type RuntimeCloseActivityLogResult,
  type RuntimeOutputPauseParams,
  type RuntimeOutputPauseResult,
  type RuntimeOutputResumeParams,
  type RuntimeOutputResumeResult,
  type RuntimeStartParams,
  type RuntimeStartResult,
  type RuntimeStateDto,
  type RuntimeStatusParams,
  type RuntimeStatusResult,
  type RuntimeStopAllParams,
  type RuntimeStopAllResult,
  type RuntimeStopParams,
  type RuntimeStopResult,
  type RuntimeWakeParams,
  type RuntimeWakeResult,
} from '../../protocol.js';
import type { DaemonLogger } from '../logger.js';
import type { Supervisor } from '../supervisor.js';
import type { InitTimeoutReason, RuntimeHandle, RuntimePhase } from './handle.js';

// ── Configurable timing knobs ──────────────────────────────────────
//
// These match CM's defaults (`packages/backend/src/conversation-
// manager.ts` `stopSigtermMs` / `stopSigkillMs`). Pulling them out
// as constructor options keeps tests fast (typically override to
// 50ms + 50ms) without re-validating the same cascade behavior at
// production timings.

/** Default time we wait after SIGTERM before escalating to SIGKILL. */
export const DEFAULT_SIGTERM_TO_SIGKILL_MS = 5_000;
/** Default upper bound on the SIGKILL wait before we mark the handle
 *  exited regardless of the OS's response. Real `kill -9` lands
 *  within ms; this is a safety budget for stuck zombies. */
export const DEFAULT_SIGKILL_TIMEOUT_MS = 10_000;

// ── 3c-b init watchdog + retry/cooldown + compaction knobs ─────────
//
// These mirror CM's defaults (`packages/backend/src/conversation-
// manager.ts` lines 57-66) byte-for-byte. The override precedence
// inside `initTimeoutFor` is locked by Cindy (`-pdNvRYOWip5e9yA`):
//
//   opts.initWatchdogMs (global override across all 3 tiers)
//     > opts.init<Tier>Ms                         (per-tier override)
//       > driver.<tier>                           (driver opinion)
//         > DEFAULT_INIT_<TIER>_MS                (this constant)
//
// `opts.initWatchdogMs` exists for the "I want fast tests" knob CM
// already exposes (one number, applies to all three timers); when it's
// set the per-tier values are deliberately ignored.

export const DEFAULT_INIT_LIVENESS_SILENCE_MS = 30 * 1000;
export const DEFAULT_INIT_PRE_PROTOCOL_CAP_MS = 5 * 60 * 1000;
export const DEFAULT_INIT_POST_PROTOCOL_MS = 30 * 1000;
export const DEFAULT_INIT_TIMEOUT_MAX_RETRIES = 1;
export const DEFAULT_INIT_FAILURE_COOLDOWN_THRESHOLD = 3;
export const DEFAULT_INIT_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;
/** Watchdog window from `compaction_started` to `compaction_finished`.
 *  Past this the daemon emits `runtime_compaction_stale` and stacks
 *  `compactionStale: true` onto the run state — but does NOT kill
 *  the child or change phase. Matches CM's `COMPACTION_STALE_MS`. */
export const DEFAULT_COMPACTION_STALE_MS = 5 * 60 * 1000;

type InitTimeoutTier =
  | 'initLivenessSilenceMs'
  | 'initPreProtocolCapMs'
  | 'initPostProtocolMs';

/** Per-(conv,agent) init-failure counter + cooldown clock. Sticky
 *  across attempts within the same incident window — cleared on a
 *  successful init or on the cooldown clock fully elapsing without
 *  the entry being touched. */
interface InitRetryState {
  failures: number;
  cooldownUntil: number;
}

export interface RealSupervisorOptions {
  /** Sink for outgoing events; wired by `runDaemon` to the per-socket
   *  broadcaster (with output backpressure applied per §2.2.2). */
  emit: (event: EventFrame) => void;
  /** Daemon-side structured logger (§3.4). Used for spawn / signal /
   *  exit lifecycle lines. */
  logger: DaemonLogger;
  /** Optional injection for tests:
   *   - `driverFor` lets tests substitute a fake `Driver` so they can
   *     drive `RealSupervisor` against a controlled binary;
   *   - `resolveBinary` lets tests pin the binary path without
   *     touching PATH;
   *   - `spawnFn` lets tests fully stub `child_process.spawn`.
   *
   *  Production wiring leaves them undefined → default
   *  `getDriver(kind)` + `detectRuntimes` + node's spawn.
   */
  driverFor?: (kind: RuntimeKind) => Driver;
  resolveBinary?: (kind: RuntimeKind, fallback: string) => Promise<string | null>;
  spawnFn?: (
    binary: string,
    args: ReadonlyArray<string>,
    options: SpawnOptions,
  ) => ChildProcess;
  /** Time supplier override; lets tests pin `started_at` / event
   *  timestamps. */
  now?: () => number;
  sigtermToSigkillMs?: number;
  sigkillTimeoutMs?: number;
  // ── 3c-b init watchdog + retry/cooldown + compaction knobs ──────
  //
  // Override precedence is fixed (Cindy `-pdNvRYOWip5e9yA`):
  //   opts.initWatchdogMs > opts.init<Tier>Ms > driver.<tier> > DEFAULT_*
  // See `initTimeoutFor` for the implementation. Constructor knobs
  // are optional so production wiring can omit them and inherit the
  // CM-aligned defaults verbatim.
  /** Global override for all 3 init timers (silence, pre-protocol
   *  cap, post-protocol). When set, per-tier overrides are ignored
   *  per the precedence table above. Maps 1:1 onto CM's
   *  `ConversationManager.initWatchdogMs`. */
  initWatchdogMs?: number | null;
  initLivenessSilenceMs?: number;
  initPreProtocolCapMs?: number;
  initPostProtocolMs?: number;
  initMaxRetries?: number;
  initFailureCooldownThreshold?: number;
  initFailureCooldownMs?: number;
  compactionStaleMs?: number;
}

/** Composite key for `Map<key, RuntimeHandle>` — null byte separator
 *  matches `FakeSupervisor` so log diffs across the two
 *  implementations stay clean. */
function key(conversationId: string, agentId: string): string {
  return `${conversationId}\x00${agentId}`;
}

/** Required spawn-context fields the host receives from backend on
 *  `runtime_start`. We narrow them with this shape so type errors
 *  surface if the protocol changes underneath the supervisor. */
interface StartOptionsFromWire {
  runtime?: RuntimeKind;
  cwd?: string;
  env?: Record<string, string>;
  agent_name?: string;
  cli_session_id?: string | null;
  model?: string | null;
  reasoning_effort?: string | null;
  fast_mode?: boolean | null;
  system_prompt_path?: string;
  initial_prompt?: string;
}

export class RealSupervisor implements Supervisor {
  private readonly handles = new Map<string, RuntimeHandle>();
  private readonly emit: (event: EventFrame) => void;
  private readonly logger: DaemonLogger;
  private readonly driverFor: (kind: RuntimeKind) => Driver;
  private readonly resolveBinary: (
    kind: RuntimeKind,
    fallback: string,
  ) => Promise<string | null>;
  private readonly spawnFn: NonNullable<RealSupervisorOptions['spawnFn']>;
  private readonly now: () => number;
  private readonly sigtermToSigkillMs: number;
  private readonly sigkillTimeoutMs: number;

  // ── 3c-b state ─────────────────────────────────────────────────
  /** Sticky per-(conv, agent) init failure counter + cooldown clock.
   *  Survives across watchdog-triggered respawns within the same
   *  incident window. Cleared by a successful `session_init`. */
  private readonly initRetryStates = new Map<string, InitRetryState>();
  /** Per-(conv, agent) lifecycle serialization (Cindy plan v2 issue
   *  #6 + tightening `ixAq6GPTn4fVSpCF`). Each entry is the tail
   *  promise for the *most recent* lifecycle operation on that key;
   *  new ops queue behind it. wake/soft-stop intentionally DO NOT
   *  participate — they gate via `handle.startupDelivery` / `phase`
   *  instead. */
  private readonly lifecycleTails = new Map<string, Promise<void>>();
  private readonly initWatchdogMs: number | null;
  private readonly initLivenessSilenceMs?: number;
  private readonly initPreProtocolCapMs?: number;
  private readonly initPostProtocolMs?: number;
  private readonly initMaxRetries: number;
  private readonly initFailureCooldownThreshold: number;
  private readonly initFailureCooldownMs: number;
  private readonly compactionStaleMs: number;

  constructor(opts: RealSupervisorOptions) {
    this.emit = opts.emit;
    this.logger = opts.logger;
    this.driverFor = opts.driverFor ?? getDefaultDriver;
    this.resolveBinary = opts.resolveBinary ?? defaultResolveBinary;
    this.spawnFn = opts.spawnFn ?? nodeSpawn;
    this.now = opts.now ?? Date.now;
    this.sigtermToSigkillMs =
      opts.sigtermToSigkillMs ?? DEFAULT_SIGTERM_TO_SIGKILL_MS;
    this.sigkillTimeoutMs = opts.sigkillTimeoutMs ?? DEFAULT_SIGKILL_TIMEOUT_MS;
    this.initWatchdogMs = opts.initWatchdogMs ?? null;
    this.initLivenessSilenceMs = opts.initLivenessSilenceMs;
    this.initPreProtocolCapMs = opts.initPreProtocolCapMs;
    this.initPostProtocolMs = opts.initPostProtocolMs;
    this.initMaxRetries = opts.initMaxRetries ?? DEFAULT_INIT_TIMEOUT_MAX_RETRIES;
    this.initFailureCooldownThreshold =
      opts.initFailureCooldownThreshold ?? DEFAULT_INIT_FAILURE_COOLDOWN_THRESHOLD;
    this.initFailureCooldownMs =
      opts.initFailureCooldownMs ?? DEFAULT_INIT_FAILURE_COOLDOWN_MS;
    this.compactionStaleMs = opts.compactionStaleMs ?? DEFAULT_COMPACTION_STALE_MS;
  }

  // ── runtime_start ──────────────────────────────────────────────

  /**
   * Public start entry — funnels every (conv, agent) start through
   * the lifecycle lock, then the cooldown gate, then the actual
   * spawn path. Cindy plan v2:
   *   - Lock granularity: per-(conv, agent), not global. Different
   *     keys spawn in parallel; same key serializes start↔stop↔
   *     clearSession↔internal-retry-respawn.
   *   - Cooldown gate scope: ONLY for fresh user-initiated starts
   *     (`initAttempt === 0`) AND only when no live handle exists.
   *     Idempotent return for an already-running handle is the
   *     success arm even if cooldown would otherwise apply, and
   *     daemon-internal retry respawns (attempt > 0) bypass the gate
   *     entirely so an in-flight retry can complete.
   */
  async start(params: RuntimeStartParams): Promise<RuntimeStartResult> {
    return this.startWithLock(params, 0);
  }

  private startWithLock(
    params: RuntimeStartParams,
    initAttempt: number,
  ): Promise<RuntimeStartResult> {
    const k = key(params.conversation_id, params.agent_id);
    return this.withLifecycleLock(k, () => this.startUnlocked(params, initAttempt));
  }

  private async startUnlocked(
    params: RuntimeStartParams,
    initAttempt: number,
  ): Promise<RuntimeStartResult> {
    const k = key(params.conversation_id, params.agent_id);
    const hasStartupDelivery = !!params.startup_delivery;

    // Idempotent on (conv, agent) — second start while running
    // returns the existing pid + started_at, matching CM today.
    // A dead handle (phase === 'exited') is treated as gone; we
    // re-spawn. The repeat call's `startup_delivery` (if any) is
    // ignored: the original startup batch is the authoritative one
    // (start is not a wake substitute). Callers wanting to push a
    // new batch after start must use `runtime_wake`.
    //
    // `startup_delivery_accepted` (Cindy `YW2BGWryWjfymPkU` nit):
    // protocol comment says "Absent when `startup_delivery` was not
    // provided in params". We surface it ONLY when the caller actually
    // supplied a batch — false on repeat (the batch was not used),
    // true on the first call that consumed it.
    const existing = this.handles.get(k);
    if (existing && existing.phase !== 'exited') {
      return {
        started: true,
        pid: existing.pid,
        started_at: existing.startedAt,
        ...(hasStartupDelivery ? { startup_delivery_accepted: false } : {}),
      };
    }
    if (existing && existing.phase === 'exited') {
      this.handles.delete(k);
    }

    // 3c-b cooldown gate (Cindy plan v2 issue #3). Fires only when:
    //   - this is a fresh user-initiated start (initAttempt === 0), AND
    //   - no live handle remains (idempotent success returned above).
    // Internal retry respawns (initAttempt > 0) bypass — the watchdog
    // already decided retry eligibility at the moment of failure;
    // re-gating here would deadlock a half-spawned retry against its
    // own cooldown clock.
    if (initAttempt === 0 && this.isInitCoolingDown(k)) {
      const state = this.initRetryStates.get(k);
      const cooldownUntil = state?.cooldownUntil ?? this.now();
      this.logger.info(
        {
          kind: 'process',
          action: 'start_blocked_by_cooldown',
          conv_id: params.conversation_id,
          agent_id: params.agent_id,
          cooldown_until: cooldownUntil,
        },
        'start refused: init failure cooldown active',
      );
      return {
        started: false,
        reason: 'init_cooldown',
        cooldown_until: cooldownUntil,
      };
    }

    const wire = (params.options ?? {}) as StartOptionsFromWire;
    const runtimeKind = wire.runtime;
    if (!runtimeKind) {
      // The backend always populates `options.runtime`; if it's
      // missing the request is malformed. Throwing surfaces as
      // `internal_error` via the dispatcher.
      throw new Error('runtime_start: options.runtime is required');
    }

    const driver = this.driverFor(runtimeKind);
    const binary = await this.resolveBinary(runtimeKind, driver.binary);
    if (!binary) {
      throw new Error(
        `runtime_start: binary "${driver.binary}" for runtime "${runtimeKind}" not found on PATH`,
      );
    }

    const spawnCtx = {
      agentId: params.agent_id,
      agentName: wire.agent_name ?? params.agent_id,
      workspacePath: wire.cwd ?? process.cwd(),
      cliSessionId: wire.cli_session_id ?? null,
      model: wire.model ?? null,
      reasoningEffort: wire.reasoning_effort ?? null,
      fastMode: wire.fast_mode ?? null,
      systemPromptPath: wire.system_prompt_path ?? '',
      initialPrompt: wire.initial_prompt ?? '',
    };

    const args = driver.buildArgs(spawnCtx);
    const env = driver.applyEnv({ ...process.env, ...(wire.env ?? {}) });
    const startedAt = this.now();

    const child = this.spawnFn(binary, args, {
      cwd: spawnCtx.workspacePath,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // detached:false so SIGTERM on the daemon group reaches the
      // child without an explicit groupkill. CM uses the same.
    });

    const pid = child.pid;
    if (typeof pid !== 'number') {
      throw new Error(
        `runtime_start: child spawned without a pid for runtime "${runtimeKind}"`,
      );
    }

    // Step-0 mutex (Cindy `_JjyK8UrpcmYA5Iu`): if backend supplied a
    // startup_delivery, the runtime starts in `startup_pending` and
    // the gate stays closed until the supervisor settles the batch.
    // Without startup_delivery the gate is already open.
    const startupBatch = params.startup_delivery
      ? { deliveryIds: [...params.startup_delivery.delivery_ids] }
      : null;

    const handle: RuntimeHandle = {
      conversationId: params.conversation_id,
      agentId: params.agent_id,
      pid,
      startedAt,
      driver,
      child,
      phase: startupBatch ? 'startup_pending' : 'spawning',
      outputPaused: false,
      exitCode: null,
      intentionalExit: false,
      sigkillTimer: null,
      // 3b additions
      startupDelivery: startupBatch,
      startupAwaitingInit: false,
      readyForDrainEmitted: false,
      initObserved: false,
      cliSessionId: spawnCtx.cliSessionId,
      stdoutLineBuffer: '',
      runState: null,
      busy: { outstandingToolUses: 0, compacting: false },
      // 3c-b additions
      // Strip `startup_delivery` from the cached params so an internal
      // retry respawn doesn't try to replay a payload the previous
      // attempt already consumed (or already failed). Backend re-pumps
      // pending inbox rows via `runtime_wake` against the new handle.
      spawnParams: {
        conversation_id: params.conversation_id,
        agent_id: params.agent_id,
        options: params.options,
      },
      initWatchdogArmed: false,
      initStartedAt: startedAt,
      initProtocolObserved: false,
      initTimedOut: false,
      initTimeoutReason: null,
      initLivenessSilenceTimer: null,
      initPreProtocolCapTimer: null,
      initPostProtocolTimer: null,
      initAttempt,
      initRetryPlanned: false,
      compactionWatchdog: null,
    };
    this.handles.set(k, handle);

    this.logger.info(
      {
        kind: 'process',
        action: 'spawn',
        pid,
        conv_id: handle.conversationId,
        agent_id: handle.agentId,
        runtime: runtimeKind,
        startup_delivery: startupBatch ? startupBatch.deliveryIds : null,
      },
      'spawned agent runtime',
    );

    // Initial phase emit — same contract as FakeSupervisor.
    this.emitState(handle);

    this.attachChildListeners(handle);

    // 3c-b: driver-side init handshake. Codex needs `bindIO` to send
    // its JSON-RPC `initialize` → `thread/start` immediately after
    // spawn — without it the child never reaches `thread/started` and
    // every spawn hits the post-protocol watchdog. Drivers without a
    // handshake (claude, cursor) leave `bindIO` undefined.
    //
    // The writeLine wrapper (a) routes through `writeStdinPayload`
    // which is the single point of stdin writes (preserves the
    // backpressure / drain semantics) and (b) asserts the driver did
    // NOT include a trailing `\n` — `writeStdinPayload` always appends
    // one, so a driver that already terminates would emit a
    // double-newline frame. Cindy `-pdNvRYOWip5e9yA` flagged this as
    // the bindIO failure mode worth catching at the seam, not at the
    // child.
    if (handle.driver.bindIO) {
      handle.driver.bindIO({
        writeLine: (line: string) => {
          if (line.endsWith('\n')) {
            return Promise.reject(
              new Error(
                'driver.writeLine: line must not end with "\\n" (writeStdinPayload appends the newline)',
              ),
            );
          }
          return this.writeStdinPayload(handle, line);
        },
        spawnCtx,
      });
    }

    // 3c-b: 3-tier init watchdog. Two arming paths (Cindy plan v2
    // issue #1 + CM's `deferInitWatchdog` rule, lines 678-682):
    //
    //   - DEFAULT: arm immediately at spawn. Covers claude with a
    //     kickoff inbox, codex (self_inits), cursor (oneShot — but
    //     oneShot drivers exit before the watchdog usually matters,
    //     so this is cheap belt-and-suspenders).
    //   - DEFERRED: `requires_first_message` + no startup_delivery +
    //     `initAttempt === 0`. Empty-inbox claude does not emit
    //     `system.init` until something actually appears on stdin, so
    //     arming at spawn would guarantee a `silence` timeout on
    //     every dormant agent. We defer to `wake()`'s post-write
    //     `ensureInitWatchdogArmed()`. On retry (`initAttempt > 0`)
    //     we ALWAYS arm: a failed first attempt with empty inbox
    //     should not silently turn into an unguarded live process.
    const deferInitWatchdog =
      initAttempt === 0 &&
      handle.driver.kickoffMode === 'requires_first_message' &&
      !startupBatch;
    if (!deferInitWatchdog) this.startInitWatchdog(handle);

    // Optimistic ready transition. 3a/3b do NOT implement the init
    // watchdog (that's 3c-b above) — for now we mark the runtime `ready`
    // after a single tick. The startup_delivery write below settles
    // asynchronously; until it settles, `maybeEmitReadyForDrain` is
    // gated by `handle.startupDelivery !== null` and will not emit.
    // (Cindy `_JjyK8UrpcmYA5Iu`: pending startup batch keeps
    // ready_for_drain bottled up; `runtime_wake` returns
    // `startup_pending` during the same window.)
    setImmediate(() => {
      if (handle.phase !== 'spawning' && handle.phase !== 'startup_pending') {
        return;
      }
      handle.phase = 'ready';
      this.emitState(handle);
      this.maybeEmitReadyForDrain(handle);
    });

    // Consume startup_delivery asynchronously — settle order (Cindy
    // `wuiwdLKrLFyGip_s`):
    //   1. write payload to stdin (or fail)
    //   2. emit `runtime_startup_delivery_consumed` OR `_failed`
    //   3. clear `handle.startupDelivery = null`
    //   4. THEN re-evaluate ready_for_drain
    // We don't `await` here — start() must return promptly so backend
    // can move on; the settle continues on the next microtask.
    if (startupBatch) {
      void this.consumeStartupDelivery(handle, startupBatch.deliveryIds, params.startup_delivery!.payload);
    }

    return {
      started: true,
      pid,
      started_at: startedAt,
      ...(hasStartupDelivery ? { startup_delivery_accepted: true } : {}),
    };
  }

  private async consumeStartupDelivery(
    handle: RuntimeHandle,
    deliveryIds: readonly number[],
    payload: unknown,
  ): Promise<void> {
    // The pending settle path. Possible outcomes:
    //   - child already exited before we got here → `child_exit`
    //   - encode/write succeeds → may settle immediately as
    //     `_consumed`, OR (for `requires_first_message` drivers
    //     pre-`session_init`) defer consumed until the runtime
    //     confirms by emitting session_init. Cindy `YW2BGWryWjfymPkU`
    //     B2: write success ≠ runtime consumed the turn; CM's
    //     `initPendingInboxIds` defers `markDelivered` for codex-like
    //     drivers until `session_init` arrives, and the daemon must
    //     mirror that or `runtime_ready_for_drain` would fire while
    //     the runtime is still pre-init.
    //   - stdin write fails synchronously → `_failed (write_failed)`
    // After ANY of those, the gate clears via `clearStartupGate`
    // (settle path emits the consumed/failed event first) and we
    // re-evaluate `ready_for_drain` exactly once.
    if (handle.phase === 'exited' || handle.phase === 'draining') {
      this.emitStartupDeliveryFailed(handle, deliveryIds, 'child_exit');
      this.clearStartupGate(handle);
      this.maybeEmitReadyForDrain(handle);
      return;
    }

    try {
      await this.writeStdinPayload(handle, payload);
    } catch (err) {
      this.logger.warn(
        {
          kind: 'process',
          action: 'startup_delivery_write_failed',
          pid: handle.pid,
          conv_id: handle.conversationId,
          agent_id: handle.agentId,
          delivery_ids: [...deliveryIds],
          error_message: (err as Error).message,
        },
        'startup_delivery stdin write failed',
      );
      this.emitStartupDeliveryFailed(handle, deliveryIds, 'write_failed');
      this.clearStartupGate(handle);
      this.maybeEmitReadyForDrain(handle);
      return;
    }

    // Write succeeded. For `requires_first_message` drivers we must
    // defer the consumed emit until `session_init` confirms the
    // runtime actually accepted the turn — `startupAwaitingInit`
    // marks this sub-state. The gate (`startupDelivery !== null`)
    // stays closed, so wake → `startup_pending` and
    // `runtime_ready_for_drain` remain blocked until session_init.
    // For `self_inits` drivers (claude), or when initObserved is
    // already true (e.g. resume path), settle now.
    if (
      handle.driver.kickoffMode === 'requires_first_message' &&
      !handle.initObserved
    ) {
      handle.startupAwaitingInit = true;
      this.logger.info(
        {
          kind: 'process',
          action: 'startup_delivery_awaiting_init',
          pid: handle.pid,
          conv_id: handle.conversationId,
          agent_id: handle.agentId,
          delivery_ids: [...deliveryIds],
        },
        'startup_delivery written; deferring consumed until session_init',
      );
      return;
    }
    this.emitStartupDeliveryConsumed(handle, deliveryIds);
    this.clearStartupGate(handle);
    this.maybeEmitReadyForDrain(handle);
  }

  /**
   * Clear the step-0 gate. ALWAYS clears both `startupDelivery`
   * AND `startupAwaitingInit` in the same critical section so the
   * `(startupDelivery=null, startupAwaitingInit=true)` interleaving
   * is impossible (Cindy `GMbjEkGUHrB1BBMe`). Callers must emit
   * the appropriate `_consumed` / `_failed` BEFORE calling this so
   * the wire order stays "settle event → clear gate → maybe ready".
   */
  private clearStartupGate(handle: RuntimeHandle): void {
    handle.startupDelivery = null;
    handle.startupAwaitingInit = false;
  }

  private emitStartupDeliveryConsumed(
    handle: RuntimeHandle,
    deliveryIds: readonly number[],
  ): void {
    this.emit({
      event: 'runtime_startup_delivery_consumed',
      conversation_id: handle.conversationId,
      agent_id: handle.agentId,
      delivery_ids: [...deliveryIds],
      ts: this.now(),
    });
  }

  private emitStartupDeliveryFailed(
    handle: RuntimeHandle,
    deliveryIds: readonly number[],
    reason: 'child_exit' | 'write_failed' | 'driver_refused' | 'init_watchdog',
  ): void {
    this.emit({
      event: 'runtime_startup_delivery_failed',
      conversation_id: handle.conversationId,
      agent_id: handle.agentId,
      delivery_ids: [...deliveryIds],
      reason,
      ts: this.now(),
    });
  }

  /**
   * Step-0 ready_for_drain gate. The single arbiter of when this
   * event fires; called from (a) start()'s setImmediate ready
   * transition and (b) every startup_delivery settle. Idempotent
   * via `handle.readyForDrainEmitted` so re-entry is harmless.
   *
   * Conditions (Cindy `wuiwdLKrLFyGip_s`):
   *   - phase === 'ready'                 (runtime is live)
   *   - startupDelivery === null          (no pending batch)
   *   - !readyForDrainEmitted             (one-shot per run)
   */
  private maybeEmitReadyForDrain(handle: RuntimeHandle): void {
    if (handle.readyForDrainEmitted) return;
    if (handle.phase !== 'ready') return;
    if (handle.startupDelivery !== null) return;
    handle.readyForDrainEmitted = true;
    this.emit({
      event: 'runtime_ready_for_drain',
      conversation_id: handle.conversationId,
      agent_id: handle.agentId,
      ts: this.now(),
    });
  }

  // ── runtime_stop ───────────────────────────────────────────────

  async stop(params: RuntimeStopParams): Promise<RuntimeStopResult> {
    if (params.mode === 'soft') {
      // Soft stop bypasses the lifecycle lock (Cindy plan v2 issue
      // #6): soft is a directive WRITE, not a lifecycle transition,
      // so it must be deliverable mid-start / mid-stop / mid-retry
      // without blocking on the lock. The write itself gates on
      // `handle.phase` (`not_running` / `draining` arms) which is
      // already the right interlock.
      return this.softStopHandle(params);
    }
    const k = key(params.conversation_id, params.agent_id);
    return this.withLifecycleLock(k, async () => {
      const handle = this.handles.get(k);
      if (!handle || handle.phase === 'exited') {
        return { mode: 'hard', stopped: false, exit_code: null };
      }
      return this.hardStopHandle(handle);
    });
  }

  /**
   * Soft stop: write the backend-supplied opaque directive payload
   * to the child's stdin so the agent can finish the current turn
   * gracefully. The runtime is NOT terminated — backend reacts to
   * the next `turn_end` or `runtime_exit` (Cindy: result must not
   * conflate "process stopped" with "directive written"; the
   * .superRefine on RuntimeStopResultSchema enforces the
   * `directive_delivered` ↔ `reason` pairing at the protocol layer).
   *
   * `driver.encodeInterruptControl` is intentionally NOT called
   * here: backend already encodes the directive into stream-json
   * bytes via the driver on its side before this call. Daemon's
   * contract is "I write whatever bytes you give me" (protocol
   * Step 1 `StreamJsonPayload` doc).
   */
  private async softStopHandle(
    params: RuntimeStopParams,
  ): Promise<RuntimeStopResult> {
    const k = key(params.conversation_id, params.agent_id);
    const handle = this.handles.get(k);
    if (!handle || handle.phase === 'exited' || handle.phase === 'draining') {
      return {
        mode: 'soft',
        directive_delivered: false,
        reason: 'not_running',
      };
    }
    if (params.soft_directive === undefined) {
      // Schema disallows this at parse time, but defend at runtime
      // too in case a caller bypassed validation.
      return {
        mode: 'soft',
        directive_delivered: false,
        reason: 'driver_refused',
      };
    }
    try {
      await this.writeStdinPayload(handle, params.soft_directive);
    } catch (err) {
      this.logger.warn(
        {
          kind: 'process',
          action: 'soft_stop_write_failed',
          pid: handle.pid,
          conv_id: handle.conversationId,
          agent_id: handle.agentId,
          error_message: (err as Error).message,
        },
        'soft stop directive write failed',
      );
      return {
        mode: 'soft',
        directive_delivered: false,
        reason: 'write_failed',
      };
    }
    return { mode: 'soft', directive_delivered: true };
  }

  /**
   * Internal helper shared by `stop({mode:'hard'})` and `stopAll`.
   * Initiates the SIGTERM → SIGKILL cascade and resolves only AFTER
   * the child has actually exited (or the SIGKILL timeout fired).
   * The returned `exit_code` is whatever the OS surfaced via the
   * `'exit'` event; the cascade timer is cleared in the exit
   * handler.
   */
  private hardStopHandle(handle: RuntimeHandle): Promise<RuntimeStopResult> {
    handle.intentionalExit = true;
    handle.phase = 'draining';
    this.emitState(handle);

    const exitPromise = new Promise<RuntimeStopResult>(resolve => {
      const onExit = (code: number | null): void => {
        // The actual exit emit is handled by `attachChildListeners`;
        // we only resolve the stop() promise here.
        resolve({ mode: 'hard', stopped: true, exit_code: code });
      };
      // Listen on a dedicated channel — handle.child.once('exit') is
      // already bound by attachChildListeners (which emits the
      // runtime_exit event); we add a second listener whose only job
      // is to resolve this promise.
      handle.child.once('exit', onExit);

      // Safety net: if the child somehow never fires 'exit' inside
      // our SIGKILL window the dispatcher cannot hang waiting on us,
      // so we resolve — but Cindy `OQCA05pivtB8nSTC` B2: we must NOT
      // claim `stopped: true`. The child is still alive (or in an
      // unknown zombie state); pretending it was reaped would let the
      // caller mark cleanup done and free downstream resources while
      // the OS-level handle persists. The honest answer is
      // `stopped: false, exit_code: null` with the handle left in
      // `draining` — when/if the child eventually exits, the primary
      // `attachChildListeners.once('exit')` will still fire and emit
      // `runtime_exit`, and the second `onExit` listener resolving
      // again is a harmless no-op on an already-settled promise.
      const timeout = setTimer(() => {
        if (handle.phase !== 'exited') {
          this.logger.warn(
            {
              kind: 'process',
              action: 'sigkill_timeout',
              pid: handle.pid,
              conv_id: handle.conversationId,
              agent_id: handle.agentId,
              timeout_ms: this.sigkillTimeoutMs,
            },
            'child did not exit within sigkill timeout',
          );
          resolve({ mode: 'hard', stopped: false, exit_code: null });
        }
      }, this.sigkillTimeoutMs);
      timeout.unref();
    });

    // Send SIGTERM immediately; escalate to SIGKILL after the
    // configured grace period. This is the same cascade CM uses
    // (`stopSigtermMs` → `stopSigkillMs`).
    this.logger.info(
      {
        kind: 'process',
        action: 'sigterm',
        pid: handle.pid,
        conv_id: handle.conversationId,
        agent_id: handle.agentId,
      },
      'sending SIGTERM to runtime',
    );
    try {
      handle.child.kill('SIGTERM');
    } catch {
      // Process already gone — exit listener will resolve us.
    }
    handle.sigkillTimer = setTimer(() => {
      handle.sigkillTimer = null;
      if (handle.phase === 'exited') return;
      this.logger.warn(
        {
          kind: 'process',
          action: 'sigkill',
          pid: handle.pid,
          conv_id: handle.conversationId,
          agent_id: handle.agentId,
        },
        'escalating to SIGKILL after grace period',
      );
      try {
        handle.child.kill('SIGKILL');
      } catch {
        // Process already gone — exit listener will resolve us.
      }
    }, this.sigtermToSigkillMs);
    handle.sigkillTimer.unref();

    return exitPromise;
  }

  // ── runtime_wake ───────────────────────────────────────────────

  async wake(params: RuntimeWakeParams): Promise<RuntimeWakeResult> {
    // Wake gating (Cindy `_JjyK8UrpcmYA5Iu`):
    //   - no handle / exited     → not_running
    //   - startup_delivery in flight → startup_pending
    //   - draining (hard stop in flight) → draining
    //   - otherwise               → write payload + return delivered
    //
    // 3b deliberately does NOT gate on `initObserved` / driver
    // kickoff mode (Cindy: `not_initialized` arm exists in the
    // reason enum but its policy lives with 3c's init-watchdog
    // awareness). For self_inits drivers like claude the FIRST
    // write IS what makes session_init come back, so a pre-init
    // gate would deadlock the deferred-init flow.
    const k = key(params.conversation_id, params.agent_id);
    const handle = this.handles.get(k);
    const passthroughDeliveryIds = [...params.delivery_ids];
    if (!handle || handle.phase === 'exited') {
      return {
        delivered: false,
        reason: 'not_running',
        delivery_ids: passthroughDeliveryIds,
      };
    }
    if (handle.startupDelivery !== null) {
      return {
        delivered: false,
        reason: 'startup_pending',
        delivery_ids: passthroughDeliveryIds,
      };
    }
    if (handle.phase === 'draining') {
      return {
        delivered: false,
        reason: 'draining',
        delivery_ids: passthroughDeliveryIds,
      };
    }
    try {
      await this.writeStdinPayload(handle, params.payload);
    } catch (err) {
      this.logger.warn(
        {
          kind: 'process',
          action: 'wake_write_failed',
          pid: handle.pid,
          conv_id: handle.conversationId,
          agent_id: handle.agentId,
          delivery_ids: passthroughDeliveryIds,
          error_message: (err as Error).message,
        },
        'wake stdin write failed',
      );
      return {
        delivered: false,
        reason: 'driver_refused',
        delivery_ids: passthroughDeliveryIds,
      };
    }
    // 3c-b deferred-init arm: the first real stdin write to a
    // `requires_first_message` driver (claude) is what makes the
    // runtime ultimately emit `session_init`. The watchdog was NOT
    // armed at spawn time for empty-inbox starts (see
    // `deferInitWatchdog` in startUnlocked); arm it NOW so a runtime
    // that accepts the write but never reaches init still gets the
    // same silence/pre-protocol/post-protocol coverage. `ensureInitWatchdog`
    // is a no-op if a watchdog is already armed or init was already
    // observed, so this is safe to call unconditionally on every wake.
    this.ensureInitWatchdogArmed(handle);
    return {
      delivered: true,
      delivery_ids: passthroughDeliveryIds,
    };
  }

  // ── runtime_status ─────────────────────────────────────────────

  status(params: RuntimeStatusParams): RuntimeStatusResult {
    const out: RuntimeStateDto[] = [];
    for (const handle of this.handles.values()) {
      if (
        params.conversation_id &&
        params.conversation_id !== handle.conversationId
      ) {
        continue;
      }
      if (params.agent_id && params.agent_id !== handle.agentId) continue;
      out.push({
        conversation_id: handle.conversationId,
        agent_id: handle.agentId,
        pid: handle.phase === 'exited' ? null : handle.pid,
        phase: handle.phase,
        run_state: handle.runState,
        started_at: handle.startedAt,
      });
    }
    return { runtimes: out };
  }

  // ── runtime_clear_session ──────────────────────────────────────

  async clearSession(
    params: RuntimeClearSessionParams,
  ): Promise<RuntimeClearSessionResult> {
    // 3a semantics (per Cindy `OQCA05pivtB8nSTC` clarification note):
    // `cleared: true` here means **the host-side runtime was hard-
    // stopped** — the runtime handle is gone, so any subsequent
    // `wake` would have to re-spawn. It does NOT mean the
    // backend-owned resume-state / cli_session_id projection has
    // been wiped; that is downstream of this call. Backend treats
    // `cleared: true` as a signal to nullify its own resume bookkeeping
    // (`agents.cli_session_id`) after this resolves. 3b will add the
    // explicit resume-state path on the host side (driver-mediated
    // `claude --resume` invalidation) and tighten this contract.
    //
    // 3c-b: runs under the per-(conv, agent) lifecycle lock so a
    // concurrent start / hardStop trigger serializes behind it. The
    // wrapped block does ALL the handle bookkeeping (read + hard
    // stop) inside the critical section so a race with start cannot
    // observe `clearSession` mid-stop.
    const k = key(params.conversation_id, params.agent_id);
    return this.withLifecycleLock(k, async () => {
      const handle = this.handles.get(k);
      if (!handle || handle.phase === 'exited') return { cleared: false };
      await this.hardStopHandle(handle);
      return { cleared: true };
    });
  }

  // ── runtime_stop_all ───────────────────────────────────────────

  async stopAll(_params: RuntimeStopAllParams): Promise<RuntimeStopAllResult> {
    // 3c-b (Cindy tightening `ixAq6GPTn4fVSpCF`): fan out one
    // lifecycle-lock acquisition per (conv, agent) and wait on all
    // of them in parallel. Different keys spawn / stop independently,
    // so the natural shape is `Promise.all` over per-key entries —
    // a single global lock would queue every stop behind every other,
    // turning stopAll into a serial drain.
    //
    // Snapshot the keys BEFORE awaiting any lock so we don't iterate
    // a Map that's being mutated by concurrent `onChildExit` cleanups
    // or by another in-flight stop completing under one of our lock
    // sections.
    const livingKeys: string[] = [];
    for (const [k, handle] of this.handles) {
      if (handle.phase !== 'exited') livingKeys.push(k);
    }
    const count = livingKeys.length;
    await Promise.all(
      livingKeys.map(k =>
        this.withLifecycleLock(k, async () => {
          const handle = this.handles.get(k);
          if (!handle || handle.phase === 'exited') return;
          await this.hardStopHandle(handle);
        }),
      ),
    );
    return { stopped_count: count };
  }

  // ── runtime_close_activity_log ─────────────────────────────────

  closeActivityLog(
    _params: RuntimeCloseActivityLogParams,
  ): RuntimeCloseActivityLogResult {
    // The activity-log JSONL writer is backend-owned (per §3.4 /
    // §4.3); host has nothing to flush. Returning flushed=true keeps
    // backend's intent loop honest — if anything is in flight inside
    // OutputBackpressure, the server-level recovery summary mechanism
    // is the right place to drain it.
    return { flushed: true };
  }

  // ── runtime_output_pause / runtime_output_resume ───────────────

  pauseOutput(params: RuntimeOutputPauseParams): RuntimeOutputPauseResult {
    const k = key(params.conversation_id, params.agent_id);
    const handle = this.handles.get(k);
    if (!handle || handle.phase === 'exited') return { paused: false };
    if (handle.outputPaused) return { paused: true };
    handle.outputPaused = true;
    this.emit({
      event: 'runtime_output_paused',
      conversation_id: handle.conversationId,
      agent_id: handle.agentId,
    });
    return { paused: true };
  }

  resumeOutput(params: RuntimeOutputResumeParams): RuntimeOutputResumeResult {
    const k = key(params.conversation_id, params.agent_id);
    const handle = this.handles.get(k);
    if (!handle || handle.phase === 'exited') return { resumed: false };
    if (!handle.outputPaused) return { resumed: true };
    handle.outputPaused = false;
    this.emit({
      event: 'runtime_output_resumed',
      conversation_id: handle.conversationId,
      agent_id: handle.agentId,
    });
    return { resumed: true };
  }

  // ── private: child lifecycle wiring ────────────────────────────

  private attachChildListeners(handle: RuntimeHandle): void {
    const { child } = handle;

    if (child.stdout) {
      child.stdout.on('data', (chunk: Buffer | string) => {
        this.onChildBytes(handle, 'stdout', chunk);
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk: Buffer | string) => {
        this.onChildBytes(handle, 'stderr', chunk);
      });
    }

    child.once('exit', (code, signal) => {
      this.onChildExit(handle, code, signal);
    });

    child.on('error', err => {
      // `error` fires for ENOENT / EACCES on spawn (rare here since
      // resolveBinary already verified existence) and for stdin write
      // failures (3b will tolerate those when it lands wake()). Log
      // for triage; the exit event still drives state transitions.
      this.logger.warn(
        {
          kind: 'process',
          action: 'child_error',
          pid: handle.pid,
          conv_id: handle.conversationId,
          agent_id: handle.agentId,
          error_message: (err as Error).message,
        },
        'child process emitted error',
      );
    });
  }

  private onChildBytes(
    handle: RuntimeHandle,
    stream: 'stdout' | 'stderr',
    chunk: Buffer | string,
  ): void {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    if (text.length === 0) return;

    // 3c-b: any byte from the child (stdout OR stderr) refreshes the
    // pre-protocol silence watchdog. Matches CM (`conversation-manager.ts`
    // lines 785-787, 796-797). Refresh is a no-op once `initProtocolObserved`
    // or `initObserved` has flipped — the silence tier is only active
    // pre-first-protocol-frame.
    this.refreshInitLiveness(handle);

    // Raw `runtime_output` is the only droppable wire frame and ALWAYS
    // reflects exactly what the child wrote. Per Cindy `C2BZGDbQWfnq-bKJ`,
    // parse fanout is a strict sidecar: we never consume or replace
    // the raw stream. We still respect `outputPaused` for this arm.
    if (!handle.outputPaused) {
      this.emit({
        event: 'runtime_output',
        conversation_id: handle.conversationId,
        agent_id: handle.agentId,
        stream,
        chunk: text,
        ts: this.now(),
      });
    }

    // Parse fanout only feeds off stdout — stderr is treated as raw
    // diagnostic output (CM same). Even when output is paused, we
    // continue to feed parseLine because parsed events drive
    // host-internal AgentRunState and the wake gate, which are
    // not droppable concerns. (`runtime_parsed_event` may still be
    // skipped at the broadcaster's discretion — but that's frame-level
    // backpressure, not pause semantics.)
    if (stream !== 'stdout') return;
    this.consumeStdoutForParse(handle, text);
  }

  /**
   * Line-buffer stdout and dispatch each complete line to
   * `driver.parseLine`. Mirrors CM's readline-based pump
   * (`conversation-manager.ts` ~line 789) but inlined here so the
   * supervisor owns the buffer.
   *
   * Lines that arrive partial across chunks are stitched via
   * `handle.stdoutLineBuffer`. A trailing partial fragment at child
   * exit IS flushed — `onChildExit` hands the leftover buffer to
   * `dispatchParsedLine` before flipping `phase='exited'`, matching
   * Node's `readline.createInterface` behavior of emitting a final
   * `line` when input ends without a newline (Cindy
   * `5nruk1IPaEHSab0T` B5). Without that flush the last complete-
   * but-unterminated JSON frame (typically the child's final
   * session_init / turn_end / error on quick exit) would silently
   * disappear from the parsed-event stream.
   */
  private consumeStdoutForParse(handle: RuntimeHandle, text: string): void {
    if (handle.phase === 'exited') return;
    const combined = handle.stdoutLineBuffer + text;
    const newlineIdx = combined.lastIndexOf('\n');
    if (newlineIdx === -1) {
      handle.stdoutLineBuffer = combined;
      return;
    }
    const completePart = combined.slice(0, newlineIdx);
    handle.stdoutLineBuffer = combined.slice(newlineIdx + 1);

    const lines = completePart.split('\n');
    for (const line of lines) {
      if (line.length === 0) continue;
      this.dispatchParsedLine(handle, line);
    }
  }

  private dispatchParsedLine(handle: RuntimeHandle, line: string): void {
    // 3c-b: observe init-progress BEFORE parseLine so a driver's
    // classifyInitProgress (pure line classifier) can advance the
    // watchdog state machine even if parseLine returns no events for
    // this specific frame (drivers occasionally emit protocol
    // bookkeeping that maps to no ParsedEvent). Order matches CM
    // (`conversation-manager.ts` lines 789-794): observe → parse →
    // fanout.
    this.observeInitProgress(handle, line);

    let events: ParsedEvent[];
    try {
      events = handle.driver.parseLine(line);
    } catch (err) {
      this.logger.warn(
        {
          kind: 'process',
          action: 'parse_line_threw',
          pid: handle.pid,
          conv_id: handle.conversationId,
          agent_id: handle.agentId,
          error_message: (err as Error).message,
        },
        'driver.parseLine threw on stdout line',
      );
      return;
    }
    for (const ev of events) {
      // Validate before emitting so the daemon never puts an
      // ill-typed parsed event on the wire. Drivers shouldn't
      // produce them, but a future driver update could regress
      // without this guard. Defense in depth — backend re-validates
      // on its side too (Cindy `OQCA05pivtB8nSTC`: zod schema is
      // bilateral).
      const validated = ParsedEventSchema.safeParse(ev);
      if (!validated.success) {
        this.logger.warn(
          {
            kind: 'process',
            action: 'parse_event_invalid',
            pid: handle.pid,
            conv_id: handle.conversationId,
            agent_id: handle.agentId,
            issue: validated.error.issues[0]?.message ?? 'unknown',
          },
          'driver.parseLine produced event that fails ParsedEventSchema',
        );
        continue;
      }
      // RUN-STATE FIRST. Per Cindy `C2BZGDbQWfnq-bKJ`:
      // frame-too-large is a broadcast concern only — host-internal
      // AgentRunState derivation must happen even if the wire frame
      // is too large to emit. Run-state updates emit `runtime_state`
      // separately (non-droppable, payload-bounded).
      this.updateRunStateFromParsed(handle, validated.data);
      this.emitParsedEvent(handle, validated.data);
    }
  }

  /**
   * Emit `runtime_parsed_event` for `parsed`. If the encoded frame
   * would exceed `MAX_FRAME_BYTES`, fall back to
   * `runtime_parsed_event_dropped` — a strict metadata-only frame
   * (Cindy `C2BZGDbQWfnq-bKJ`: NO payload, NO raw line, NO partial
   * fields). We pre-encode the candidate frame to measure its
   * actual wire size; the protocol layer's `encodeFrame` would
   * throw otherwise, which would drop the parsed event silently
   * (worse than honest reporting).
   */
  private emitParsedEvent(handle: RuntimeHandle, parsed: ParsedEvent): void {
    const candidate: EventFrame = {
      event: 'runtime_parsed_event',
      conversation_id: handle.conversationId,
      agent_id: handle.agentId,
      parsed,
      ts: this.now(),
    };
    let encoded: string | null = null;
    try {
      encoded = encodeFrame(candidate);
    } catch (err) {
      // `encodeFrame` throws on MAX_FRAME_BYTES violation. Fall
      // through to the dropped-frame path.
      this.logger.warn(
        {
          kind: 'process',
          action: 'parse_event_too_large',
          pid: handle.pid,
          conv_id: handle.conversationId,
          agent_id: handle.agentId,
          parsed_kind: parsed.kind,
          error_message: (err as Error).message,
        },
        'parsed event exceeds frame cap; emitting dropped marker',
      );
    }
    if (encoded !== null) {
      this.emit(candidate);
      return;
    }
    // Compute an honest byte count for the dropped marker. Use the
    // length the encoder would have produced (sans the payload-bearing
    // frame). We approximate via Buffer.byteLength of a probe encoding
    // — the dropped frame itself is tiny so it always fits.
    const probe = JSON.stringify({
      event: 'runtime_parsed_event',
      conversation_id: handle.conversationId,
      agent_id: handle.agentId,
      parsed,
      ts: this.now(),
    });
    const encodedBytes = Buffer.byteLength(probe, 'utf-8') + 1; // + '\n'
    this.emit({
      event: 'runtime_parsed_event_dropped',
      conversation_id: handle.conversationId,
      agent_id: handle.agentId,
      parsed_kind: parsed.kind,
      encoded_bytes: encodedBytes,
      reason: 'frame_too_large',
      ts: this.now(),
    });
  }

  /**
   * Mutate `handle.runState` based on `parsed`. The transition table
   * mirrors CM's `handleParsedEvent` switch + `recordTool*` /
   * `recordCompaction*` helpers (`conversation-manager.ts`
   * ~lines 1230, 1470-1516). Only the status-shaping subset lives
   * here in 3b; backend keeps owning the activity-snippet ring
   * buffer, tool-call counters, and SSE projection (those are UX,
   * not execution-plane).
   *
   * `session_init` is special: it flips `initObserved` (drives the
   * 3c wake gate) and updates `cliSessionId`. No run-state change
   * here — run-state lifecycle starts when the agent actually does
   * something (text/thinking/tool_call/turn_end).
   */
  private updateRunStateFromParsed(
    handle: RuntimeHandle,
    parsed: ParsedEvent,
  ): void {
    if (parsed.kind === 'session_init') {
      if (!handle.initObserved) {
        handle.initObserved = true;
        handle.cliSessionId = parsed.sessionId;
        // 3c-b: stop every init watchdog timer now that init has
        // landed AND clear the (conv, agent) retry/cooldown bucket.
        // The cooldown counter is sticky across attempts within an
        // incident window; a successful init is the explicit reset.
        this.clearInitWatchdog(handle);
        this.clearInitRetryState(handle.conversationId, handle.agentId);
        this.logger.info(
          {
            kind: 'process',
            action: 'session_init',
            pid: handle.pid,
            conv_id: handle.conversationId,
            agent_id: handle.agentId,
            cli_session_id: parsed.sessionId,
          },
          'agent: session_init received',
        );
        // Cindy `YW2BGWryWjfymPkU` B2: settle the deferred consumed
        // emit if `consumeStartupDelivery` parked the batch awaiting
        // init. Settle order — emit consumed FIRST, then clear gate,
        // then re-evaluate ready_for_drain — same as the non-deferred
        // path inside `consumeStartupDelivery`. The `startupDelivery
        // !== null` precondition guarantees we only fire for batches
        // that are still pending (no double-emit on a re-consumed
        // race).
        if (handle.startupAwaitingInit && handle.startupDelivery) {
          const ids = handle.startupDelivery.deliveryIds;
          this.emitStartupDeliveryConsumed(handle, ids);
          this.clearStartupGate(handle);
          this.maybeEmitReadyForDrain(handle);
        }
      }
      return;
    }

    switch (parsed.kind) {
      case 'thinking':
      case 'text':
        this.transitionRunState(handle, { status: 'thinking', detail: null });
        break;
      case 'tool_call':
        handle.busy.outstandingToolUses += 1;
        this.transitionRunState(handle, {
          status: 'tool_running',
          detail: parsed.name,
        });
        break;
      case 'tool_output':
        handle.busy.outstandingToolUses = Math.max(
          0,
          handle.busy.outstandingToolUses - 1,
        );
        if (handle.busy.outstandingToolUses === 0 && !handle.busy.compacting) {
          this.transitionRunState(handle, {
            status: 'thinking',
            detail: null,
          });
        }
        break;
      case 'compaction_started':
        handle.busy.compacting = true;
        // 3c-b: arm the compaction watchdog. Cleared on
        // compaction_finished, child exit, or hard stop. Watchdog
        // fire path stacks `compactionStale: true` on the run state
        // and emits `runtime_compaction_stale` — but does NOT change
        // phase or kill the child (Cindy plan v2 issue #4).
        this.startCompactionWatchdog(handle);
        this.transitionRunState(handle, {
          compacting: true,
          compactingSince: this.now(),
          // Clear any prior `compactionStale` flag so the next stale
          // window starts fresh and the wire-visible diff fires
          // again if the new compaction also stalls.
          compactionStale: false,
        });
        break;
      case 'compaction_finished':
        handle.busy.compacting = false;
        this.clearCompactionWatchdog(handle);
        this.transitionRunState(handle, {
          compacting: false,
          compactingSince: null,
          compactionStale: false,
          ...(handle.busy.outstandingToolUses === 0
            ? { status: 'thinking', detail: null }
            : {}),
        });
        break;
      case 'turn_end':
        handle.busy.outstandingToolUses = 0;
        handle.busy.compacting = false;
        // Cindy `YW2BGWryWjfymPkU` B3: turn_end is a terminal
        // transition — go through `resolveRun` so the terminal
        // state lands, then `handle.runState` is cleared so the
        // next activity creates a fresh runId with no stale
        // terminalReason.
        this.resolveRun(handle, 'turn_ended');
        break;
      case 'error':
        // Errors don't mutate run-state directly in 3b — backend
        // owns the user-visible error projection. 3c may add a
        // fatal-error → terminalReason path.
        break;
      case 'unknown':
        // No-op; backend may decide what to do with it.
        break;
    }
  }

  /**
   * Apply a transition to `handle.runState`. Lazily creates the
   * state on first transition (so `runId` is stable from the
   * moment the agent starts emitting events). Patch semantics:
   *
   *   - `undefined` field        → leave existing value untouched
   *   - explicit `null` field    → clear (drop optional field)
   *   - any other value          → set
   *
   * Emits `runtime_state` only when something visible to the wire
   * changes (status, detail, compacting, terminalReason) — repeated
   * text/thinking deltas don't spam the wire.
   */
  private transitionRunState(
    handle: RuntimeHandle,
    patch: {
      status?: AgentRunState['status'];
      detail?: string | null;
      terminalReason?: AgentRunState['terminalReason'];
      compacting?: boolean;
      compactingSince?: number | null;
      /** 3c-b: stacked stale flag from the compaction watchdog. Must
       *  be set in the same patch that DOES NOT touch `compacting` so
       *  the run-state keeps `compacting: true` alongside
       *  `compactionStale: true` (Cindy plan v2 issue #4). */
      compactionStale?: boolean;
    },
  ): void {
    const ts = this.now();
    if (!handle.runState) {
      const status = patch.status ?? 'thinking';
      handle.runState = {
        runId: randomUUID(),
        agentId: handle.agentId,
        conversationId: handle.conversationId,
        status,
        startedAt: ts,
        updatedAt: ts,
        lastActivityAt: ts,
        ...(patch.detail && patch.detail !== null
          ? { detail: patch.detail }
          : {}),
        ...(patch.terminalReason ? { terminalReason: patch.terminalReason } : {}),
        ...(patch.compacting !== undefined ? { compacting: patch.compacting } : {}),
        ...(patch.compactingSince !== undefined && patch.compactingSince !== null
          ? { compactingSince: patch.compactingSince }
          : {}),
        ...(patch.compactionStale === true ? { compactionStale: true } : {}),
      };
      this.emitState(handle);
      return;
    }
    const prev = handle.runState;
    const next: AgentRunState = {
      ...prev,
      updatedAt: ts,
      lastActivityAt: ts,
    };
    if (patch.status !== undefined) next.status = patch.status;
    if (patch.detail === null) {
      delete next.detail;
    } else if (patch.detail !== undefined) {
      next.detail = patch.detail;
    }
    if (patch.terminalReason !== undefined) {
      next.terminalReason = patch.terminalReason;
    }
    if (patch.compacting !== undefined) next.compacting = patch.compacting;
    if (patch.compactingSince === null) {
      delete next.compactingSince;
    } else if (patch.compactingSince !== undefined) {
      next.compactingSince = patch.compactingSince;
    }
    if (patch.compactionStale === true) {
      next.compactionStale = true;
    } else if (patch.compactionStale === false) {
      delete next.compactionStale;
    }
    handle.runState = next;
    // Emit when wire-visible field changed.
    const shouldEmit =
      prev.status !== next.status ||
      prev.detail !== next.detail ||
      prev.terminalReason !== next.terminalReason ||
      prev.compacting !== next.compacting ||
      prev.compactionStale !== next.compactionStale;
    if (shouldEmit) this.emitState(handle);
  }

  /**
   * Terminal-resolve `handle.runState`. Three responsibilities,
   * matching CM's `resolveRunByKey` + `publishTerminalRunState`
   * (Cindy `YW2BGWryWjfymPkU` B3):
   *
   *   1. Map `reason` to the canonical terminal status. CM rule
   *      (`terminalStatus`): `replied | turn_ended | replaced` →
   *      `idle`; every other terminal reason
   *      (`stopped | crashed | timeout | conversation_closed`) →
   *      `failed`. Note `stopped` is FAILED, not idle — hard stop
   *      during tool_running surfaces as `{status:'failed',
   *      terminalReason:'stopped'}` so backend's RunStateCache and
   *      UI both project the correct "ended on a hard stop" arm.
   *   2. Emit ONE `runtime_state` carrying the terminal status +
   *      terminalReason. Uses the existing runState if present
   *      (preserves the runId so the consumer can correlate);
   *      synthesizes a phase-derived state otherwise so we always
   *      surface the terminal transition.
   *   3. Null out `handle.runState` + reset busy/compacting so the
   *      next observable activity (a fresh thinking/tool_call) gets
   *      a brand-new runId and no leaked terminalReason.
   */
  private resolveRun(
    handle: RuntimeHandle,
    reason: NonNullable<AgentRunState['terminalReason']>,
  ): void {
    const terminalStatus: AgentRunState['status'] =
      reason === 'replied' || reason === 'turn_ended' || reason === 'replaced'
        ? 'idle'
        : 'failed';
    const ts = this.now();
    const base: AgentRunState = handle.runState
      ? {
          ...handle.runState,
          status: terminalStatus,
          updatedAt: ts,
          lastActivityAt: ts,
          terminalReason: reason,
          // Clear transient activity fields on terminal emit so the
          // wire shape matches CM's terminal projection.
          compacting: false,
        }
      : {
          runId: `real-${handle.pid}-${handle.startedAt}`,
          agentId: handle.agentId,
          conversationId: handle.conversationId,
          status: terminalStatus,
          startedAt: handle.startedAt,
          updatedAt: ts,
          lastActivityAt: ts,
          terminalReason: reason,
        };
    this.emit({
      event: 'runtime_state',
      conversation_id: handle.conversationId,
      agent_id: handle.agentId,
      state: base,
      ts,
    });
    // Clear so the next activity starts a fresh run. busy is reset
    // here too — turn_end already does it, but exit/crash paths
    // benefit from the safety net.
    handle.runState = null;
    handle.busy.outstandingToolUses = 0;
    handle.busy.compacting = false;
  }

  /**
   * Write `payload` to the child's stdin as a single NDJSON line.
   * The wire `StreamJsonPayload` is opaque (zod `z.unknown()`),
   * but the daemon's contract is "I write whatever bytes you give
   * me + a trailing newline". Two encodings are accepted:
   *
   *   - `string` → written verbatim + '\n'
   *   - object   → `JSON.stringify(payload) + '\n'`
   *
   * Both match CM's `writeLine` semantics — encoded line, single
   * trailing newline. Backpressure: if `stdin.write` returns false
   * we wait for `'drain'` before resolving (matches CM
   * `conversation-manager.ts` ~2322).
   */
  private writeStdinPayload(handle: RuntimeHandle, payload: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      const stdin = handle.child.stdin;
      if (!stdin || stdin.destroyed) {
        reject(new Error('child stdin is not writable'));
        return;
      }
      const line =
        typeof payload === 'string' ? payload : JSON.stringify(payload);
      const ok = stdin.write(line + '\n', err =>
        err ? reject(err) : resolve(),
      );
      if (!ok) {
        stdin.once('drain', () => resolve());
      }
    });
  }

  private onChildExit(
    handle: RuntimeHandle,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (handle.phase === 'exited') return; // double-fire guard

    if (handle.sigkillTimer) {
      clearTimeout(handle.sigkillTimer);
      handle.sigkillTimer = null;
    }
    // 3c-b: stop any pending init / compaction timers attached to
    // this handle BEFORE the retry-respawn branch fires, otherwise a
    // stray `failInitWatchdog` callback could race the new handle and
    // observe the old one mid-cleanup.
    this.clearInitWatchdog(handle);
    this.clearCompactionWatchdog(handle);

    // Cindy `5nruk1IPaEHSab0T` B5: Node's `readline.createInterface`
    // (which CM uses) emits a final `line` for input that ended
    // without a trailing `\n` (verified locally:
    // `Readable.from(['abc'])` → `line: 'abc'`). The supervisor's
    // chunk-buffered pump was discarding that tail — meaning the
    // last complete-but-unterminated JSON frame (typically the
    // child's final session_init / turn_end / error line on quick
    // exit) would silently vanish from the parsed-event stream.
    // Flush it BEFORE setting `phase='exited'`, because
    // `consumeStdoutForParse` early-returns on `phase==='exited'`
    // — but `dispatchParsedLine` itself has no phase guard, so we
    // hand the tail to it directly. Cleared so the double-fire guard
    // above stays correct on the (impossible-by-contract) re-entry.
    if (handle.stdoutLineBuffer.length > 0) {
      const tail = handle.stdoutLineBuffer;
      handle.stdoutLineBuffer = '';
      this.dispatchParsedLine(handle, tail);
    }

    handle.phase = 'exited';
    handle.exitCode = code;

    const intentional = handle.intentionalExit;
    const ts = this.now();
    const k = key(handle.conversationId, handle.agentId);

    this.logger.info(
      {
        kind: 'process',
        action: 'exit',
        pid: handle.pid,
        conv_id: handle.conversationId,
        agent_id: handle.agentId,
        exit_code: code,
        signal: signal ?? null,
        intentional,
        init_timed_out: handle.initTimedOut,
        init_retry_planned: handle.initRetryPlanned,
      },
      'child exited',
    );

    // If a startup batch was still pending at exit, settle it as
    // `child_exit` so backend's startup_delivery handler isn't left
    // hanging. (Cindy: failed settle must still clear the gate so
    // run-state / wake gating stays coherent.) `clearStartupGate`
    // wipes both `startupDelivery` and `startupAwaitingInit` in the
    // same critical section so no `(null, true)` interleaving
    // appears.
    if (handle.startupDelivery !== null) {
      this.emitStartupDeliveryFailed(
        handle,
        handle.startupDelivery.deliveryIds,
        handle.initTimedOut ? 'init_watchdog' : 'child_exit',
      );
      this.clearStartupGate(handle);
    }

    // 3c-b retry branch (Cindy plan v2 issue #3 + override precedence
    // `-pdNvRYOWip5e9yA`): if the init watchdog killed the child AND
    // it decided retry was eligible, respawn under the lifecycle
    // lock with `initAttempt + 1`. Daemon-internal retry SKIPS the
    // start-time cooldown gate (`startWithLock` is the gated entry
    // — internalRespawnForRetry calls it WITHOUT bypassing because
    // `startUnlocked` does its own gate check that distinguishes
    // `initAttempt === 0` vs `> 0`).
    if (
      handle.initTimedOut &&
      handle.initRetryPlanned &&
      !handle.intentionalExit
    ) {
      const newAttempt = handle.initAttempt + 1;
      this.emit({
        event: 'runtime_init_retrying',
        conversation_id: handle.conversationId,
        agent_id: handle.agentId,
        retry_attempt: newAttempt,
        max_retries: this.initMaxRetries,
        delay_ms: 0,
        ts: this.now(),
      });
      // Emit terminal runtime_state for the failed attempt and the
      // accompanying runtime_exit, then drop the handle and respawn.
      this.handles.delete(k);
      this.resolveRun(handle, 'timeout');
      this.emit({
        event: 'runtime_exit',
        conversation_id: handle.conversationId,
        agent_id: handle.agentId,
        code,
        intentional: false,
        ts,
      });
      void this.internalRespawnForRetry(handle.spawnParams, newAttempt);
      return;
    }

    // 3c-b cooldown branch: init failed, no retry. If a fresh
    // cooldown window engaged in this incident, surface it on the
    // wire so backend can project `agent_status crashed
    // reason=init_cooldown` for the now-dead handle. `cooldownUntil > now`
    // is the only "really cooling down right now" check (Cindy plan
    // v2 issue #2 — cooldown ≠ retry-exhausted; the two are
    // independent state).
    if (handle.initTimedOut) {
      const state = this.initRetryStates.get(k);
      if (state && state.cooldownUntil > this.now()) {
        this.emit({
          event: 'runtime_init_cooldown',
          conversation_id: handle.conversationId,
          agent_id: handle.agentId,
          cooldown_until: state.cooldownUntil,
          attempts_exhausted: state.failures,
          ts: this.now(),
        });
      }
    }

    // Cindy `YW2BGWryWjfymPkU` B3 + `5nruk1IPaEHSab0T` B4: terminal
    // cleanup goes through `resolveRun`, which (a) maps the reason to
    // the correct terminal status per CM, (b) emits the terminal
    // `runtime_state`, and (c) clears `handle.runState` so the next
    // run starts with a fresh `runId` and no stale terminalReason.
    //
    // Reason mapping (matches CM `conversation-manager.ts` lines
    // 856-907):
    //   init watchdog killed it → `timeout` (precedence over intentional)
    //   intentional stop request → `stopped`
    //   clean exit (code === 0)  → `replied`  (oneShot/cursor critical)
    //   non-zero / signal exit   → `crashed`
    // `replied → idle`, `timeout|stopped|crashed → failed` per CM's
    // terminalStatus table (Cindy `GMbjEkGUHrB1BBMe`).
    const reason: NonNullable<AgentRunState['terminalReason']> =
      handle.initTimedOut
        ? 'timeout'
        : intentional
          ? 'stopped'
          : code === 0
            ? 'replied'
            : 'crashed';
    this.resolveRun(handle, reason);
    this.emit({
      event: 'runtime_exit',
      conversation_id: handle.conversationId,
      agent_id: handle.agentId,
      code,
      intentional,
      ts,
    });
  }

  // ── private: state emitter ─────────────────────────────────────

  /**
   * Emit a `runtime_state` reflecting `handle`'s current phase /
   * run-state. Two layers:
   *
   *   1. Phase-derived (starting/idle) — used when there's no
   *      handle.runState yet. Synthesizes a stable runId from
   *      pid+startedAt so consecutive phase emits correlate.
   *   2. Run-state-derived — when 3b's parsed-event lifecycle has
   *      produced a real AgentRunState we project it as-is.
   *
   * NOTE (Cindy `YW2BGWryWjfymPkU` B3): this method does NOT carry
   * `terminalReason`. Every terminal transition (turn_end, hard
   * stop, crash, soft-stop-induced replied) MUST go through
   * `resolveRun` instead, which (a) maps reason → terminal status
   * per CM and (b) clears `handle.runState` so the next run starts
   * fresh. Passing terminalReason through here would let a
   * tool_running state get a `terminalReason` patched on without
   * the status flip, which is exactly the bug B3 is fixing.
   */
  private emitState(handle: RuntimeHandle): void {
    const ts = this.now();
    const base: AgentRunState = handle.runState
      ? {
          ...handle.runState,
          updatedAt: ts,
        }
      : {
          runId: `real-${handle.pid}-${handle.startedAt}`,
          agentId: handle.agentId,
          conversationId: handle.conversationId,
          status: phaseToStatus(handle.phase),
          startedAt: handle.startedAt,
          updatedAt: ts,
          lastActivityAt: ts,
        };
    this.emit({
      event: 'runtime_state',
      conversation_id: handle.conversationId,
      agent_id: handle.agentId,
      state: base,
      ts,
    });
  }

  // ── 3c-b: init watchdog + retry/cooldown + lifecycle lock ──────

  /**
   * Override-resolution for one init watchdog tier. Cindy
   * `-pdNvRYOWip5e9yA` locked precedence:
   *
   *   1. `opts.initWatchdogMs` (global override; one number applies
   *      to all three tiers — matches CM `ConversationManager.initWatchdogMs`)
   *   2. `opts.init<Tier>Ms`   (per-tier override on the supervisor)
   *   3. `driver.<tier>`       (driver opinion — claude/codex/cursor
   *      each declare their own defaults)
   *   4. `DEFAULT_INIT_<TIER>_MS`
   *
   * The global override exists specifically for tests that want one
   * tiny number for all three timers without overriding the per-tier
   * fields one by one.
   */
  private initTimeoutFor(driver: Driver, tier: InitTimeoutTier, fallback: number): number {
    if (this.initWatchdogMs !== null) return this.initWatchdogMs;
    const overrideMap: Record<InitTimeoutTier, number | undefined> = {
      initLivenessSilenceMs: this.initLivenessSilenceMs,
      initPreProtocolCapMs: this.initPreProtocolCapMs,
      initPostProtocolMs: this.initPostProtocolMs,
    };
    const override = overrideMap[tier];
    if (override !== undefined) return override;
    return driver[tier] ?? fallback;
  }

  /** Arm both the silence-tier and the pre-protocol-cap timer for
   *  this handle. Idempotent: clears any prior timers first so retries
   *  / wake-driven deferred arming don't pile up. */
  private startInitWatchdog(handle: RuntimeHandle): void {
    this.clearInitWatchdog(handle);
    handle.initWatchdogArmed = true;
    handle.initStartedAt = this.now();
    this.armInitLivenessSilenceWatchdog(handle);
    const timeoutMs = this.initTimeoutFor(
      handle.driver,
      'initPreProtocolCapMs',
      DEFAULT_INIT_PRE_PROTOCOL_CAP_MS,
    );
    handle.initPreProtocolCapTimer = setTimer(() => {
      handle.initPreProtocolCapTimer = null;
      this.failInitWatchdog(handle, 'pre_protocol_cap', timeoutMs);
    }, timeoutMs);
    handle.initPreProtocolCapTimer.unref();
  }

  /** Clear every init-watchdog timer attached to this handle. Called
   *  from clearSession, hard stop, child exit, AND when init lands. */
  private clearInitWatchdog(handle: RuntimeHandle): void {
    if (handle.initLivenessSilenceTimer) {
      clearTimeout(handle.initLivenessSilenceTimer);
      handle.initLivenessSilenceTimer = null;
    }
    if (handle.initPreProtocolCapTimer) {
      clearTimeout(handle.initPreProtocolCapTimer);
      handle.initPreProtocolCapTimer = null;
    }
    if (handle.initPostProtocolTimer) {
      clearTimeout(handle.initPostProtocolTimer);
      handle.initPostProtocolTimer = null;
    }
  }

  /** (Re-)arm the silence-tier timer. Called on watchdog start AND on
   *  every refresh (raw byte arrival pre-protocol). */
  private armInitLivenessSilenceWatchdog(handle: RuntimeHandle): void {
    if (handle.initLivenessSilenceTimer) {
      clearTimeout(handle.initLivenessSilenceTimer);
      handle.initLivenessSilenceTimer = null;
    }
    const timeoutMs = this.initTimeoutFor(
      handle.driver,
      'initLivenessSilenceMs',
      DEFAULT_INIT_LIVENESS_SILENCE_MS,
    );
    handle.initLivenessSilenceTimer = setTimer(() => {
      handle.initLivenessSilenceTimer = null;
      this.failInitWatchdog(handle, 'silence', timeoutMs);
    }, timeoutMs);
    handle.initLivenessSilenceTimer.unref();
  }

  /** Reset the silence-tier debounce on every raw byte from the
   *  child. No-op once protocol or session ready has been observed —
   *  silence is only meaningful pre-first-frame. */
  private refreshInitLiveness(handle: RuntimeHandle): void {
    if (!handle.initWatchdogArmed) return;
    if (handle.initObserved || handle.initProtocolObserved || handle.initTimedOut) return;
    this.armInitLivenessSilenceWatchdog(handle);
  }

  /** Driver's pure line classifier advances the watchdog state
   *  machine. `protocol_ready` cancels silence + pre-protocol cap and
   *  arms the post-protocol timer; `session_ready` cancels every
   *  timer outright (the parsed `session_init` branch then flips
   *  `initObserved` + clears the retry bucket). */
  private observeInitProgress(handle: RuntimeHandle, line: string): void {
    if (!handle.initWatchdogArmed) return;
    if (handle.initObserved || handle.initTimedOut) return;
    const progress = handle.driver.classifyInitProgress(line);
    if (!progress) return;
    this.markInitProtocolReady(handle);
    if (progress === 'session_ready') this.clearInitWatchdog(handle);
  }

  private markInitProtocolReady(handle: RuntimeHandle): void {
    if (handle.initProtocolObserved) return;
    handle.initProtocolObserved = true;
    // Cancel the pre-protocol-only timers; arm the post-protocol
    // timer to bound the silence between first protocol frame and
    // session ready.
    if (handle.initLivenessSilenceTimer) {
      clearTimeout(handle.initLivenessSilenceTimer);
      handle.initLivenessSilenceTimer = null;
    }
    if (handle.initPreProtocolCapTimer) {
      clearTimeout(handle.initPreProtocolCapTimer);
      handle.initPreProtocolCapTimer = null;
    }
    const timeoutMs = this.initTimeoutFor(
      handle.driver,
      'initPostProtocolMs',
      DEFAULT_INIT_POST_PROTOCOL_MS,
    );
    handle.initPostProtocolTimer = setTimer(() => {
      handle.initPostProtocolTimer = null;
      this.failInitWatchdog(handle, 'post_protocol', timeoutMs);
    }, timeoutMs);
    handle.initPostProtocolTimer.unref();
  }

  /** Deferred-init arming for `requires_first_message` drivers. Called
   *  from `wake()` after a successful stdin write. No-op if watchdog
   *  already armed, init already observed, or init already timed out. */
  private ensureInitWatchdogArmed(handle: RuntimeHandle): void {
    if (handle.initWatchdogArmed || handle.initObserved || handle.initTimedOut) return;
    this.startInitWatchdog(handle);
  }

  /**
   * Watchdog fired. Emit `runtime_init_timeout`, decide retry vs
   * cooldown, then SIGTERM → SIGKILL the child. The exit handler
   * picks up the retry branch from `handle.initRetryPlanned`.
   *
   * Idempotent: bails if the handle is already gone, already init'd,
   * or already marked init-timed-out. This matters because three
   * timers race the same flag; only the first to fire counts.
   */
  private failInitWatchdog(
    handle: RuntimeHandle,
    reason: InitTimeoutReason,
    timeoutMs: number,
  ): void {
    const k = key(handle.conversationId, handle.agentId);
    if (!this.handles.has(k) || handle.initObserved || handle.initTimedOut) return;

    this.clearInitWatchdog(handle);
    handle.initTimedOut = true;
    handle.initTimeoutReason = reason;
    const { retry, cooldownUntilOnEvent } = this.recordInitTimeout(handle);
    handle.initRetryPlanned = retry;

    const elapsedMs = this.now() - handle.initStartedAt;
    this.logger.warn(
      {
        kind: 'process',
        action: 'init_watchdog_fired',
        pid: handle.pid,
        conv_id: handle.conversationId,
        agent_id: handle.agentId,
        timeout_reason: reason,
        elapsed_ms: elapsedMs,
        timeout_ms: timeoutMs,
        retry_attempt: handle.initAttempt,
        retrying: retry,
      },
      'init watchdog fired; killing child',
    );
    this.emit({
      event: 'runtime_init_timeout',
      conversation_id: handle.conversationId,
      agent_id: handle.agentId,
      timeout_reason: reason,
      elapsed_ms: elapsedMs,
      timeout_ms: timeoutMs,
      retrying: retry,
      retry_attempt: handle.initAttempt,
      max_retries: this.initMaxRetries,
      ...(cooldownUntilOnEvent !== null
        ? { cooldown_until: cooldownUntilOnEvent }
        : {}),
      ts: this.now(),
    });

    // SIGTERM → SIGKILL cascade. Use the supervisor's grace-period
    // knob so test runs stay snappy.
    try {
      handle.child.kill('SIGTERM');
    } catch {
      // Already gone — exit listener fires the cleanup either way.
    }
    setTimer(() => {
      if (!this.handles.has(k)) return;
      if (handle.phase === 'exited') return;
      try {
        handle.child.kill('SIGKILL');
      } catch {
        // Already gone — same.
      }
    }, this.sigtermToSigkillMs).unref();
  }

  /** Bump the failure counter, engage cooldown if threshold crossed,
   *  decide retry eligibility. Cindy plan v2 issue #2: cooldown vs
   *  retry-exhausted are independent — return cooldownUntilOnEvent
   *  only when cooldown is genuinely active right now. */
  private recordInitTimeout(handle: RuntimeHandle): {
    retry: boolean;
    cooldownUntilOnEvent: number | null;
  } {
    const k = key(handle.conversationId, handle.agentId);
    const now = this.now();
    const state = this.initRetryStates.get(k) ?? { failures: 0, cooldownUntil: 0 };
    state.failures += 1;
    if (state.failures >= this.initFailureCooldownThreshold) {
      state.cooldownUntil = now + this.initFailureCooldownMs;
    }
    this.initRetryStates.set(k, state);
    const cooldownActive = state.cooldownUntil > now;
    const retry =
      !cooldownActive &&
      handle.initAttempt < this.initMaxRetries &&
      !handle.intentionalExit;
    return {
      retry,
      cooldownUntilOnEvent: cooldownActive ? state.cooldownUntil : null,
    };
  }

  /** Wipe the failure counter + cooldown clock. Called on successful
   *  `session_init` AND when start_unlocked observes a no-op
   *  idempotent return — neither of those cases should keep an old
   *  incident window alive. */
  private clearInitRetryState(conversationId: string, agentId: string): void {
    this.initRetryStates.delete(key(conversationId, agentId));
  }

  /** Is the (conv, agent) currently inside an active cooldown window? */
  private isInitCoolingDown(k: string): boolean {
    const state = this.initRetryStates.get(k);
    return !!state && state.cooldownUntil > this.now();
  }

  /**
   * Daemon-internal retry respawn. Called from the child-exit handler
   * when `initRetryPlanned` was true. Goes through `startWithLock` so
   * the per-(conv, agent) lifecycle lock serializes the respawn
   * against any concurrent user-initiated start / stop / clearSession.
   * Errors are logged but not propagated — the retry already emitted
   * `runtime_init_retrying`; a failed respawn surfaces as the next
   * watchdog firing or a different `runtime_exit`.
   */
  private async internalRespawnForRetry(
    originalParams: RuntimeStartParams,
    newAttempt: number,
  ): Promise<void> {
    try {
      await this.startWithLock(originalParams, newAttempt);
    } catch (err) {
      this.logger.error(
        {
          kind: 'process',
          action: 'init_retry_respawn_failed',
          conv_id: originalParams.conversation_id,
          agent_id: originalParams.agent_id,
          retry_attempt: newAttempt,
          error_message: (err as Error).message,
        },
        'init watchdog retry respawn failed',
      );
    }
  }

  /**
   * Per-(conv, agent) lifecycle serialization. Cindy plan v2 issue
   * #6 + tightening `ixAq6GPTn4fVSpCF`:
   *
   *   - Covers ONLY lifecycle mutations: start, hard stop, clearSession,
   *     internal retry respawn. wake/soft-stop/output-pause go around.
   *   - Per-key, not global — different (conv, agent) ops parallelize.
   *   - Survives previous-op failure: a rejected predecessor must not
   *     wedge the queue. We swallow the previous tail's rejection at
   *     the await site.
   *
   * The map entry holds the *latest tail* so subsequent calls queue
   * behind every in-flight op for that key.
   */
  private async withLifecycleLock<T>(k: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.lifecycleTails.get(k);
    let resolveTail!: () => void;
    const tail = new Promise<void>(r => {
      resolveTail = r;
    });
    this.lifecycleTails.set(k, tail);
    try {
      if (prev) {
        // Tolerate previous-op failure — the queue keeps moving even
        // if an earlier start threw or a stop rejected.
        try {
          await prev;
        } catch {
          /* swallow — see comment */
        }
      }
      return await fn();
    } finally {
      resolveTail();
      // Only clear the map entry if we're still the tail. A faster
      // follow-up op may have already overwritten it with its own
      // tail; in that case the map should keep the newer reference.
      if (this.lifecycleTails.get(k) === tail) {
        this.lifecycleTails.delete(k);
      }
    }
  }

  // ── 3c-b: compaction watchdog ──────────────────────────────────

  /**
   * Arm the compaction watchdog. On fire: emit
   * `runtime_compaction_stale` AND stack `compactionStale: true` on
   * the run state (Cindy plan v2 issue #4 — observational only;
   * preserve `compacting: true`; do NOT kill the child or change
   * phase). Idempotent: clears any prior timer first.
   */
  private startCompactionWatchdog(handle: RuntimeHandle): void {
    this.clearCompactionWatchdog(handle);
    const startedAt = this.now();
    handle.compactionWatchdog = setTimer(() => {
      handle.compactionWatchdog = null;
      this.fireCompactionStale(handle, startedAt);
    }, this.compactionStaleMs);
    handle.compactionWatchdog.unref();
  }

  private clearCompactionWatchdog(handle: RuntimeHandle): void {
    if (handle.compactionWatchdog) {
      clearTimeout(handle.compactionWatchdog);
      handle.compactionWatchdog = null;
    }
  }

  private fireCompactionStale(handle: RuntimeHandle, startedAt: number): void {
    // Defense in depth: a finish that lands in the same tick as the
    // timer would clear the watchdog but we'd still be inside the
    // callback. Bail if compaction is no longer active.
    if (!handle.busy.compacting) return;
    if (handle.phase === 'exited' || handle.phase === 'draining') return;
    const elapsedMs = this.now() - startedAt;
    this.logger.warn(
      {
        kind: 'process',
        action: 'compaction_stale',
        pid: handle.pid,
        conv_id: handle.conversationId,
        agent_id: handle.agentId,
        elapsed_ms: elapsedMs,
      },
      'compaction has been running past the stale window with no finish event',
    );
    this.emit({
      event: 'runtime_compaction_stale',
      conversation_id: handle.conversationId,
      agent_id: handle.agentId,
      elapsed_ms: elapsedMs,
      ts: this.now(),
    });
    // Stack stale onto the run state; explicitly do NOT touch
    // `compacting` — the UI must still show "compacting (stale)",
    // not "no longer compacting".
    this.transitionRunState(handle, { compactionStale: true });
  }
}

/** Phase → AgentRunState.status mapping used when no parsed-event
 *  run-state has been recorded yet. Matches the 3a contract. */
function phaseToStatus(phase: RuntimePhase): AgentRunState['status'] {
  switch (phase) {
    case 'spawning':
    case 'startup_pending':
      return 'starting';
    case 'ready':
    case 'draining':
    case 'exited':
      return 'idle';
  }
}

/**
 * Default binary resolver — wraps `detectRuntimes()` from
 * `packages/host/src/runtimes.ts`. Cached per-instance because
 * `detectRuntimes` shells out to `which` and version-probes each
 * binary; once per supervisor boot is enough.
 */
let detectedBinariesPromise: Promise<Map<RuntimeKind, string>> | null = null;
async function defaultResolveBinary(
  kind: RuntimeKind,
  _fallback: string,
): Promise<string | null> {
  if (!detectedBinariesPromise) {
    detectedBinariesPromise = detectRuntimes().then(infos => {
      const m = new Map<RuntimeKind, string>();
      for (const info of infos) {
        if (info.installed && info.binary) m.set(info.kind, info.binary);
      }
      return m;
    });
  }
  const m = await detectedBinariesPromise;
  return m.get(kind) ?? null;
}

export type { RuntimeHandle, RuntimePhase };
