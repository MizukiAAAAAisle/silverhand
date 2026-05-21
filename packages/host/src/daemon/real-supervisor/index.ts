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
import type { RuntimeHandle, RuntimePhase } from './handle.js';

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
  }

  // ── runtime_start ──────────────────────────────────────────────

  async start(params: RuntimeStartParams): Promise<RuntimeStartResult> {
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

    // Optimistic ready transition. 3a/3b do NOT implement the init
    // watchdog (that's 3c) — for now we mark the runtime `ready`
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
      return this.softStopHandle(params);
    }
    const k = key(params.conversation_id, params.agent_id);
    const handle = this.handles.get(k);
    if (!handle || handle.phase === 'exited') {
      return { mode: 'hard', stopped: false, exit_code: null };
    }
    return this.hardStopHandle(handle);
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
    const k = key(params.conversation_id, params.agent_id);
    const handle = this.handles.get(k);
    if (!handle || handle.phase === 'exited') return { cleared: false };
    await this.hardStopHandle(handle);
    return { cleared: true };
  }

  // ── runtime_stop_all ───────────────────────────────────────────

  async stopAll(_params: RuntimeStopAllParams): Promise<RuntimeStopAllResult> {
    const pending: Array<Promise<unknown>> = [];
    let count = 0;
    for (const handle of this.handles.values()) {
      if (handle.phase === 'exited') continue;
      count++;
      pending.push(this.hardStopHandle(handle));
    }
    await Promise.all(pending);
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
        this.transitionRunState(handle, {
          compacting: true,
          compactingSince: this.now(),
        });
        break;
      case 'compaction_finished':
        handle.busy.compacting = false;
        this.transitionRunState(handle, {
          compacting: false,
          compactingSince: null,
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
    handle.runState = next;
    // Emit when wire-visible field changed.
    const shouldEmit =
      prev.status !== next.status ||
      prev.detail !== next.detail ||
      prev.terminalReason !== next.terminalReason ||
      prev.compacting !== next.compacting;
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
        'child_exit',
      );
      this.clearStartupGate(handle);
    }

    // Cindy `YW2BGWryWjfymPkU` B3 + `5nruk1IPaEHSab0T` B4: terminal
    // cleanup goes through `resolveRun`, which (a) maps the reason to
    // the correct terminal status per CM, (b) emits the terminal
    // `runtime_state`, and (c) clears `handle.runState` so the next
    // run starts with a fresh `runId` and no stale terminalReason.
    //
    // Reason mapping (matches CM `conversation-manager.ts` lines
    // 856-907 with what 3b can know — `init_timeout` and fatal-error
    // reasons land in 3c):
    //   intentional stop request → `stopped`
    //   clean exit (code === 0)  → `replied`  (oneShot/cursor critical)
    //   non-zero / signal exit   → `crashed`
    // `replied → idle`, `stopped|crashed → failed` per CM's
    // terminalStatus table (Cindy `GMbjEkGUHrB1BBMe`).
    const reason: NonNullable<AgentRunState['terminalReason']> = intentional
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
