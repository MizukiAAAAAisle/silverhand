/**
 * Fake supervisor — daemon-side in-memory mock of the (conversation,
 * agent) execution-plane runtime that PR-2 step 2 will carve out of
 * `packages/backend/src/conversation-manager.ts`.
 *
 * Why fake instead of real for step 1:
 *
 *  - Step 1 review boundary (per Cindy `1vRk1SIAFfa1x10t`) is the
 *    PROTOCOL — wire shapes, dispatcher routing, kill-and-reclaim
 *    semantics, output backpressure, logging contract. Behavioral
 *    equivalence with real CM is step 2's review boundary.
 *  - The CM file is large and load-bearing. Lifting it in step 1
 *    would mix two unrelated reviews and risk regressing the 820
 *    backend tests on a protocol-only change.
 *  - The fake exercises every code path the real supervisor will
 *    need: state machine transitions, event emission, batch wake
 *    semantics, startup/live exclusivity, clean teardown.
 *
 * State machine (matches design doc §3.2.1):
 *
 *   ┌───────┐  start (no startup_delivery)
 *   │ idle  │ ───────────────────────────►  ready
 *   └───────┘                                ▲
 *       │  start (with startup_delivery)     │  consumed
 *       ▼                                    │
 *   startup_pending ─────────────────────────┤
 *       │                                    │
 *       │  failed                            │
 *       ▼                                    │
 *     exited                                 │
 *                                            │
 *   ready ── stop / runtime_exit ──► draining ──► exited
 *
 * Events the fake emits, in the order a real driver would emit them:
 *
 *  - `runtime_state` after every phase change (mirrors the
 *    AgentRunState transitions a real driver parses out of CLI
 *    output).
 *  - `runtime_startup_delivery_consumed` once the simulated driver
 *    "consumes" a startup_delivery batch.
 *  - `runtime_ready_for_drain` once the runtime is live-drainable.
 *  - `runtime_exit` on stop / SIGKILL / simulated crash.
 *
 * Scheduling discipline: every event the fake emits is queued via
 * `setImmediate` so it fires AFTER the originating intent's response
 * has been written. This matches the real driver — process events
 * are async — and prevents the test from receiving an event before
 * the synchronous response.
 */
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
} from '../protocol.js';

export type FakeSupervisorPhase =
  | 'idle'
  | 'spawning'
  | 'startup_pending'
  | 'ready'
  | 'draining'
  | 'exited';

interface FakeRuntime {
  conversation_id: string;
  agent_id: string;
  pid: number;
  phase: FakeSupervisorPhase;
  started_at: number;
  pending_startup_delivery_ids?: number[];
  /** Output flow-control flag. Set by `pauseOutput`, cleared by
   *  `resumeOutput`. The fake doesn't gate any actual stdout pump on
   *  this — step 2's real supervisor will. We track it here so
   *  duplicate pause/resume calls don't re-emit ack events. */
  output_paused: boolean;
}

export interface FakeSupervisorOptions {
  /** Sink for outgoing events. The daemon server connects this to
   *  its `broadcastEvent` method so events reach every live socket. */
  emit: (event: EventFrame) => void;
  /** Test override for `Date.now()` so tests can pin deterministic
   *  `ts` fields. */
  now?: () => number;
  /**
   * Test override for the async event scheduler. Production uses
   * `setImmediate` so events fire after the current tick; tests can
   * pass a synchronous scheduler to assert ordering without a real
   * event loop.
   */
  schedule?: (cb: () => void) => void;
  /**
   * Whether the supervisor's simulated driver consumes
   * startup_delivery successfully. Production fake always succeeds
   * (deterministic happy path); tests flip this to exercise the
   * `runtime_startup_delivery_failed` arm without needing a real
   * watchdog.
   */
  failStartupDelivery?: boolean;
}

const DEFAULT_SCHEDULE = (cb: () => void): void => {
  setImmediate(cb);
};

function key(conv: string, agent: string): string {
  return `${conv}\x00${agent}`;
}

export class FakeSupervisor {
  private readonly runtimes = new Map<string, FakeRuntime>();
  private readonly emit: (event: EventFrame) => void;
  private readonly now: () => number;
  private readonly schedule: (cb: () => void) => void;
  private readonly failStartupDelivery: boolean;
  /** Pid counter starts well above any plausible real pid range to
   *  make logs visually distinct from real ConversationManager
   *  output during step-1 dev. */
  private nextPid = 900_000;

  constructor(opts: FakeSupervisorOptions) {
    this.emit = opts.emit;
    this.now = opts.now ?? Date.now;
    this.schedule = opts.schedule ?? DEFAULT_SCHEDULE;
    this.failStartupDelivery = opts.failStartupDelivery ?? false;
  }

  // ── runtime_start ──────────────────────────────────────────────

  start(params: RuntimeStartParams): RuntimeStartResult {
    const k = key(params.conversation_id, params.agent_id);
    // Idempotent on (conv, agent) — second start while running is a
    // no-op that returns the existing pid + started_at, matching CM
    // today.
    const existing = this.runtimes.get(k);
    if (existing && existing.phase !== 'exited') {
      return {
        pid: existing.pid,
        started_at: existing.started_at,
        startup_delivery_accepted: params.startup_delivery
          ? false
          : undefined,
      };
    }
    const pid = this.nextPid++;
    const startedAt = this.now();
    const rt: FakeRuntime = {
      conversation_id: params.conversation_id,
      agent_id: params.agent_id,
      pid,
      phase: params.startup_delivery ? 'startup_pending' : 'spawning',
      started_at: startedAt,
      pending_startup_delivery_ids: params.startup_delivery?.delivery_ids,
      output_paused: false,
    };
    this.runtimes.set(k, rt);
    // Initial phase emit — review fix Cindy `ihw5XHpjldmEc-wt`. Step 1
    // locks the protocol event surface, so the fake MUST emit the
    // declared `runtime_state` transitions; tests / e2e + future
    // integrations rely on them.
    this.emitState(rt);

    if (params.startup_delivery) {
      // Startup-pending path: simulate driver consuming the batch
      // (or refusing it if the test asks for the failure arm), then
      // transition to ready and emit ready_for_drain.
      this.scheduleStartupSettle(rt, params.startup_delivery.delivery_ids);
    } else {
      // No startup_delivery: simulate the driver coming up directly
      // ready (matches kickoffMode='requires_first_message' empty
      // inbox — no spawn-time stdin write). For claude-family this
      // still means session_init waits for the first runtime_wake;
      // the fake collapses that gap to "ready immediately" since
      // nothing about the wire contract requires the wait.
      this.scheduleReady(rt);
    }

    return {
      pid,
      started_at: startedAt,
      startup_delivery_accepted: params.startup_delivery ? true : undefined,
    };
  }

  // ── runtime_stop ───────────────────────────────────────────────

  stop(params: RuntimeStopParams): RuntimeStopResult {
    const k = key(params.conversation_id, params.agent_id);
    const rt = this.runtimes.get(k);

    // Soft stop = inject directive on stdin; runtime stays alive.
    // Fake doesn't model an actual driver, so we just simulate a
    // successful write when the runtime exists in a writable phase.
    if (params.mode === 'soft') {
      if (!rt || rt.phase === 'exited' || rt.phase === 'idle') {
        return {
          mode: 'soft',
          directive_delivered: false,
          reason: 'not_running',
        };
      }
      if (rt.phase !== 'ready') {
        // spawning / startup_pending / draining → driver can't accept
        // new stdin yet (or anymore).
        return {
          mode: 'soft',
          directive_delivered: false,
          reason: 'driver_refused',
        };
      }
      // Successful directive write — runtime keeps running; no exit
      // scheduled, no state change.
      return { mode: 'soft', directive_delivered: true };
    }

    // Hard stop = SIGTERM/SIGKILL cascade.
    if (!rt || rt.phase === 'exited') {
      return { mode: 'hard', stopped: false, exit_code: null };
    }
    rt.phase = 'draining';
    this.emitState(rt);
    const exitCode = 137;
    this.scheduleExit(rt, exitCode, /* intentional */ true);
    return { mode: 'hard', stopped: true, exit_code: exitCode };
  }

  // ── runtime_wake ───────────────────────────────────────────────

  wake(params: RuntimeWakeParams): RuntimeWakeResult {
    const k = key(params.conversation_id, params.agent_id);
    const rt = this.runtimes.get(k);
    if (!rt || rt.phase === 'exited' || rt.phase === 'idle') {
      return {
        delivered: false,
        reason: 'not_running',
        delivery_ids: params.delivery_ids,
      };
    }
    if (rt.phase === 'spawning') {
      return {
        delivered: false,
        reason: 'not_initialized',
        delivery_ids: params.delivery_ids,
      };
    }
    if (rt.phase === 'startup_pending') {
      return {
        delivered: false,
        reason: 'startup_pending',
        delivery_ids: params.delivery_ids,
      };
    }
    if (rt.phase === 'draining') {
      return {
        delivered: false,
        reason: 'draining',
        delivery_ids: params.delivery_ids,
      };
    }
    // phase === 'ready' — happy path.
    return { delivered: true, delivery_ids: params.delivery_ids };
  }

  // ── runtime_status ─────────────────────────────────────────────

  status(params: RuntimeStatusParams): RuntimeStatusResult {
    const out: RuntimeStateDto[] = [];
    for (const rt of this.runtimes.values()) {
      if (
        params.conversation_id &&
        params.conversation_id !== rt.conversation_id
      ) {
        continue;
      }
      if (params.agent_id && params.agent_id !== rt.agent_id) continue;
      out.push({
        conversation_id: rt.conversation_id,
        agent_id: rt.agent_id,
        pid: rt.phase === 'exited' ? null : rt.pid,
        phase: rt.phase,
        run_state: null,
        started_at: rt.started_at,
      });
    }
    return { runtimes: out };
  }

  // ── runtime_clear_session ──────────────────────────────────────

  clearSession(params: RuntimeClearSessionParams): RuntimeClearSessionResult {
    const k = key(params.conversation_id, params.agent_id);
    const rt = this.runtimes.get(k);
    if (!rt || rt.phase === 'exited') return { cleared: false };
    rt.phase = 'draining';
    // Phase change → emit runtime_state so backend snapshot reconcile
    // sees the draining intermediate (Cindy `9rxtrdT2NXfX2zEs`
    // blocker — the fake's doc comment promises "runtime_state after
    // every phase change"; clearSession and stopAll need the same
    // treatment as stop()).
    this.emitState(rt);
    // Hard kill semantics: emit exit immediately, no graceful wait.
    this.scheduleExit(rt, 137, /* intentional */ true);
    return { cleared: true };
  }

  // ── runtime_stop_all ───────────────────────────────────────────

  stopAll(_params: RuntimeStopAllParams): RuntimeStopAllResult {
    let count = 0;
    for (const rt of this.runtimes.values()) {
      if (rt.phase === 'exited') continue;
      rt.phase = 'draining';
      // Same phase-change emit as clearSession / stop — keep the
      // runtime_state stream consistent across every intent that
      // moves a runtime into draining.
      this.emitState(rt);
      this.scheduleExit(rt, 0, /* intentional */ true);
      count++;
    }
    return { stopped_count: count };
  }

  // ── runtime_close_activity_log ─────────────────────────────────

  closeActivityLog(
    _params: RuntimeCloseActivityLogParams,
  ): RuntimeCloseActivityLogResult {
    // Fake supervisor doesn't write any activity log file (per
    // §3.4 + §4.3, the activity-log JSONL writer stays in backend).
    // The intent exists to flush daemon-side outbound buffers, which
    // for the fake is a no-op — return flushed=true.
    return { flushed: true };
  }

  // ── runtime_output_pause / runtime_output_resume ───────────────
  //
  // Cindy `_YD0KJF-YAQXlcki` requires these to flow through the
  // Supervisor interface (NOT inline dispatcher emit) so step 2's
  // real flow-control wiring doesn't reshape the protocol boundary.
  //
  // Semantics:
  //  - On unknown / exited (conv, agent): return paused=false
  //    (resumed=false) and emit nothing. Backend snapshot reconciles
  //    via the result, no event is needed.
  //  - On a live runtime in a non-paused state: flip the flag, emit
  //    `runtime_output_paused`, return paused=true.
  //  - On a live runtime that's already paused: return paused=true
  //    (idempotent) and skip the emit so the wire isn't spammed.
  //  - resume() is the mirror.

  pauseOutput(params: RuntimeOutputPauseParams): RuntimeOutputPauseResult {
    const k = key(params.conversation_id, params.agent_id);
    const rt = this.runtimes.get(k);
    if (!rt || rt.phase === 'exited') return { paused: false };
    if (rt.output_paused) return { paused: true };
    rt.output_paused = true;
    this.emit({
      event: 'runtime_output_paused',
      conversation_id: rt.conversation_id,
      agent_id: rt.agent_id,
    });
    return { paused: true };
  }

  resumeOutput(params: RuntimeOutputResumeParams): RuntimeOutputResumeResult {
    const k = key(params.conversation_id, params.agent_id);
    const rt = this.runtimes.get(k);
    if (!rt || rt.phase === 'exited') return { resumed: false };
    if (!rt.output_paused) return { resumed: true };
    rt.output_paused = false;
    this.emit({
      event: 'runtime_output_resumed',
      conversation_id: rt.conversation_id,
      agent_id: rt.agent_id,
    });
    return { resumed: true };
  }

  // ── private scheduling helpers ─────────────────────────────────

  /**
   * Schedule the "driver consumed startup_delivery" transition.
   * On `failStartupDelivery=true`, emit
   * `runtime_startup_delivery_failed` instead and move the runtime
   * to `exited` (the real driver would tear down on init failure).
   */
  private scheduleStartupSettle(
    rt: FakeRuntime,
    deliveryIds: number[],
  ): void {
    this.schedule(() => {
      // Defensive: another intent may have already moved us out of
      // startup_pending (e.g. concurrent stop). Don't emit settle
      // events on a runtime that no longer exists.
      if (rt.phase !== 'startup_pending') return;
      if (this.failStartupDelivery) {
        rt.phase = 'exited';
        rt.pending_startup_delivery_ids = undefined;
        this.emitState(rt, /* terminalReason */ 'crashed');
        this.emit({
          event: 'runtime_startup_delivery_failed',
          conversation_id: rt.conversation_id,
          agent_id: rt.agent_id,
          delivery_ids: deliveryIds,
          reason: 'init_watchdog',
          ts: this.now(),
        });
        this.emit({
          event: 'runtime_exit',
          conversation_id: rt.conversation_id,
          agent_id: rt.agent_id,
          code: 1,
          intentional: false,
          ts: this.now(),
        });
        return;
      }
      // Happy path: consumed → ready → ready_for_drain.
      rt.phase = 'ready';
      rt.pending_startup_delivery_ids = undefined;
      this.emitState(rt);
      this.emit({
        event: 'runtime_startup_delivery_consumed',
        conversation_id: rt.conversation_id,
        agent_id: rt.agent_id,
        delivery_ids: deliveryIds,
        ts: this.now(),
      });
      this.emit({
        event: 'runtime_ready_for_drain',
        conversation_id: rt.conversation_id,
        agent_id: rt.agent_id,
        ts: this.now(),
      });
    });
  }

  private scheduleReady(rt: FakeRuntime): void {
    this.schedule(() => {
      // Same defensive check as above — concurrent stop may have
      // moved us already.
      if (rt.phase !== 'spawning') return;
      rt.phase = 'ready';
      this.emitState(rt);
      this.emit({
        event: 'runtime_ready_for_drain',
        conversation_id: rt.conversation_id,
        agent_id: rt.agent_id,
        ts: this.now(),
      });
    });
  }

  private scheduleExit(
    rt: FakeRuntime,
    code: number,
    intentional: boolean,
  ): void {
    this.schedule(() => {
      if (rt.phase === 'exited') return;
      rt.phase = 'exited';
      this.emitState(rt, intentional ? 'stopped' : 'crashed');
      this.emit({
        event: 'runtime_exit',
        conversation_id: rt.conversation_id,
        agent_id: rt.agent_id,
        code,
        intentional,
        ts: this.now(),
      });
    });
  }

  /**
   * Build + emit a `runtime_state` event reflecting `rt`'s current
   * phase. Phase → `AgentRunStatus` mapping (deliberately collapses
   * ConversationManager's richer state machine — the fake is for
   * protocol-surface coverage only; step 2 wires the real CM-derived
   * state on the wire):
   *
   *   - `spawning`         → `starting`
   *   - `startup_pending`  → `starting`
   *   - `ready` / `idle`   → `idle`
   *   - `draining`         → `idle`  (terminal in flight)
   *   - `exited`           → `idle`  with the supplied `terminalReason`
   *
   * `runId` is synthesized from pid + started_at so it stays stable
   * across phase emits within one runtime lifetime.
   */
  private emitState(
    rt: FakeRuntime,
    terminalReason?:
      | 'replied'
      | 'turn_ended'
      | 'replaced'
      | 'stopped'
      | 'crashed'
      | 'timeout'
      | 'conversation_closed',
  ): void {
    const status: 'starting' | 'idle' | 'failed' =
      rt.phase === 'spawning' || rt.phase === 'startup_pending'
        ? 'starting'
        : 'idle';
    const ts = this.now();
    this.emit({
      event: 'runtime_state',
      conversation_id: rt.conversation_id,
      agent_id: rt.agent_id,
      state: {
        runId: `fake-${rt.pid}-${rt.started_at}`,
        agentId: rt.agent_id,
        conversationId: rt.conversation_id,
        status,
        startedAt: rt.started_at,
        updatedAt: ts,
        lastActivityAt: ts,
        ...(terminalReason ? { terminalReason } : {}),
      },
      ts,
    });
  }

  /** Test helper: synchronously inspect a runtime's current phase. */
  __getPhase(conv: string, agent: string): FakeSupervisorPhase | null {
    const rt = this.runtimes.get(key(conv, agent));
    return rt ? rt.phase : null;
  }
}
