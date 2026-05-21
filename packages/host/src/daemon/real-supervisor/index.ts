/**
 * RealSupervisor — production supervisor for the silverhand daemon.
 *
 * Step 2 commit 3a scope (locked with Cindy in
 * `wjay-7-ARIgrFzOf` → `jhH-vC1s_1J_jTLu`):
 *
 *   - spawn agent runtime via `child_process.spawn` using the driver's
 *     `buildArgs` / `applyEnv`
 *   - own the `ChildProcess` lifecycle (stdout / stderr / exit)
 *   - pump raw stdout/stderr to `runtime_output` events (per-chunk;
 *     no parse-line in 3a)
 *   - hard stop: SIGTERM → 5s → SIGKILL → 10s cascade, emitting
 *     `runtime_state` (draining) then `runtime_exit` on close
 *   - `status()` returns a per-(conv, agent) snapshot
 *   - `pauseOutput` / `resumeOutput` flip a flag + emit ack events
 *     (raw output drops while paused; 3b will revisit buffering)
 *
 * Explicitly NOT in 3a (will land in 3b/3c per the agreed split):
 *
 *   - `wake()` — stdin write of delivery_ids payload + gating
 *   - `stop({ mode: 'soft' })` — driver.encodeInterruptControl path
 *   - `clearSession()` — hard stop + resume-state clear
 *   - parse-line fanout (driver.parseLine → ParsedEvent stream)
 *   - AgentRunState lifecycle (thinking / tool_running / ...)
 *   - 3-tier init watchdog + retry/cooldown loop
 *   - compaction watchdog
 *   - lifecycle-lock atomicity for concurrent start/stop
 *
 * Those intents return typed `driver_refused` / `not_initialized`
 * stubs from 3a until 3b/3c implement them, so the protocol surface
 * stays honest about what works today.
 *
 * Wiring: NOT wired into `runDaemon` yet — FakeSupervisor stays the
 * default until commit 5's atomic flip. 3a tests instantiate
 * RealSupervisor directly to validate execution-plane behavior in
 * isolation.
 */
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { setTimeout as setTimer } from 'node:timers';
import type { AgentRunState, RuntimeKind } from '@silverhand/shared';

import { getDriver as getDefaultDriver, type Driver } from '../../drivers/index.js';
import { detectRuntimes } from '../../runtimes.js';
import type {
  EventFrame,
  RuntimeClearSessionParams,
  RuntimeClearSessionResult,
  RuntimeCloseActivityLogParams,
  RuntimeCloseActivityLogResult,
  RuntimeOutputPauseParams,
  RuntimeOutputPauseResult,
  RuntimeOutputResumeParams,
  RuntimeOutputResumeResult,
  RuntimeStartParams,
  RuntimeStartResult,
  RuntimeStateDto,
  RuntimeStatusParams,
  RuntimeStatusResult,
  RuntimeStopAllParams,
  RuntimeStopAllResult,
  RuntimeStopParams,
  RuntimeStopResult,
  RuntimeWakeParams,
  RuntimeWakeResult,
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

    // 3a does not implement startup_delivery consumption (writing the
    // payload to stdin + emitting `runtime_startup_delivery_consumed`
    // happens in 3b alongside `wake()`). Cindy `OQCA05pivtB8nSTC` B1:
    // accepting startup_delivery in 3a while NOT consuming it would
    // violate the step-0 mutex (no `runtime_ready_for_drain` until
    // the batch settles). The honest 3a answer is to refuse the call
    // outright — backend can switch to no-startup-delivery `start()`
    // + post-init `wake()` until 3b lifts the restriction.
    if (params.startup_delivery) {
      throw new Error(
        'runtime_start: startup_delivery not supported until commit 3b lands wake/stdin write',
      );
    }

    // Idempotent on (conv, agent) — second start while running
    // returns the existing pid + started_at, matching CM today.
    // A dead handle (phase === 'exited') is treated as gone; we
    // re-spawn.
    const existing = this.handles.get(k);
    if (existing && existing.phase !== 'exited') {
      return {
        pid: existing.pid,
        started_at: existing.startedAt,
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

    const handle: RuntimeHandle = {
      conversationId: params.conversation_id,
      agentId: params.agent_id,
      pid,
      startedAt,
      driver,
      child,
      phase: 'spawning',
      outputPaused: false,
      exitCode: null,
      intentionalExit: false,
      sigkillTimer: null,
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
      },
      'spawned agent runtime',
    );

    // Initial phase emit — same contract as FakeSupervisor.
    this.emitState(handle);

    this.attachChildListeners(handle);

    // 3a does NOT implement the init watchdog (that's 3c); for now
    // we optimistically transition to `ready` after a single tick so
    // `runtime_ready_for_drain` and the `runtime_state:ready` events
    // fire. 3c will replace this with the real protocol-observation
    // logic and may keep the handle in `spawning` until init actually
    // completes. The startup_delivery branch is gated above (3a
    // refuses it), so this transition is unconditionally safe — no
    // pending batch can be left half-settled.
    setImmediate(() => {
      if (handle.phase !== 'spawning') return;
      handle.phase = 'ready';
      this.emitState(handle);
      this.emit({
        event: 'runtime_ready_for_drain',
        conversation_id: handle.conversationId,
        agent_id: handle.agentId,
        ts: this.now(),
      });
    });

    return {
      pid,
      started_at: startedAt,
    };
  }

  // ── runtime_stop ───────────────────────────────────────────────

  async stop(params: RuntimeStopParams): Promise<RuntimeStopResult> {
    if (params.mode === 'soft') {
      // 3a does not implement soft stop — 3b will route this through
      // driver.encodeInterruptControl. Return the typed "driver
      // refused" stub so backend gets a coherent answer (rather than
      // a lie) until then.
      return { mode: 'soft', directive_delivered: false, reason: 'driver_refused' };
    }
    const k = key(params.conversation_id, params.agent_id);
    const handle = this.handles.get(k);
    if (!handle || handle.phase === 'exited') {
      return { mode: 'hard', stopped: false, exit_code: null };
    }
    return this.hardStopHandle(handle);
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
    // 3a does not implement wake; 3b will route the payload to
    // stdin and emit `runtime_startup_delivery_consumed/failed`.
    // The typed `driver_refused` arm keeps backend's response handler
    // unsurprised while waiting for 3b.
    const k = key(params.conversation_id, params.agent_id);
    const handle = this.handles.get(k);
    if (!handle || handle.phase === 'exited') {
      return {
        delivered: false,
        reason: 'not_running',
        delivery_ids: params.delivery_ids,
      };
    }
    return {
      delivered: false,
      reason: 'driver_refused',
      delivery_ids: params.delivery_ids,
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
        run_state: null,
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
    if (handle.outputPaused) {
      // 3a drops while paused; no replay-on-resume. 3b will revisit
      // (we may add a small ring buffer keyed to recent output).
      return;
    }
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    if (text.length === 0) return;
    this.emit({
      event: 'runtime_output',
      conversation_id: handle.conversationId,
      agent_id: handle.agentId,
      stream,
      chunk: text,
      ts: this.now(),
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

    this.emitState(handle, intentional ? 'stopped' : 'crashed');
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
   * Emit a `runtime_state` reflecting `handle`'s current phase. The
   * 3a mapping is intentionally narrow — 3b will add `thinking` /
   * `tool_running` once the parse pipeline lands. For 3a:
   *
   *   - `spawning` / `startup_pending` → `starting`
   *   - `ready` / `draining`           → `idle`
   *   - `exited`                       → `idle` + terminalReason
   *
   * `runId` is synthesized from pid + startedAt so it stays stable
   * across phase emits within one runtime lifetime (matches Fake).
   */
  private emitState(
    handle: RuntimeHandle,
    terminalReason?:
      | 'replied'
      | 'turn_ended'
      | 'replaced'
      | 'stopped'
      | 'crashed'
      | 'timeout'
      | 'conversation_closed',
  ): void {
    const status: AgentRunState['status'] =
      handle.phase === 'spawning' || handle.phase === 'startup_pending'
        ? 'starting'
        : 'idle';
    const ts = this.now();
    this.emit({
      event: 'runtime_state',
      conversation_id: handle.conversationId,
      agent_id: handle.agentId,
      state: {
        runId: `real-${handle.pid}-${handle.startedAt}`,
        agentId: handle.agentId,
        conversationId: handle.conversationId,
        status,
        startedAt: handle.startedAt,
        updatedAt: ts,
        lastActivityAt: ts,
        ...(terminalReason ? { terminalReason } : {}),
      },
      ts,
    });
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
