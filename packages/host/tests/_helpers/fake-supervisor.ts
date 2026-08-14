/**
 * FakeSupervisor — test-only in-memory implementation of the
 * daemon-side runtime contract.
 *
 * It exists for protocol / dispatcher / socket e2e tests that need
 * deterministic `runtime_*` responses and broadcast events without
 * spawning a real agent CLI. Production wiring uses
 * `src/daemon/supervisor/index.ts`; this helper deliberately lives
 * under `tests/_helpers` so it cannot be imported by the daemon entry.
 *
 * State machine (matches design doc §3.2.1):
 *
 *   ┌───────┐  runtime_start (pure lifecycle)
 *   │ idle  │ ───────────────────────────►  spawning ──► ready
 *   └───────┘
 *       │  runtime_deliver (no live runtime → spawn-with-batch)
 *       ▼
 *   startup_pending ──── consumed ────►  ready
 *       │
 *       │  failed
 *       ▼
 *     exited
 *
 *   ready ── stop / runtime_exit ──► draining ──► exited
 *
 * Events the fake emits, in the order a real driver would emit them:
 *
 *  - `runtime_state` after every phase change (mirrors the
 *    AgentRunState transitions a real driver parses out of CLI
 *    output).
 *  - `runtime_delivery_consumed` once the simulated driver
 *    "consumes" a `runtime_deliver` batch (spawn-with-batch or the
 *    ready-write arm).
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
  AgentMessageSendParams,
  AgentMessageSendResult,
  AgentStaleReceiveParams,
  AgentStaleReceiveResult,
  AgentStaleResolveParams,
  AgentStaleResolveResult,
  AgentStreamObservedParams,
  AgentStreamObservedResult,
  EventFrame,
  RuntimeClearSessionParams,
  RuntimeClearSessionResult,
  RuntimeCloseActivityLogParams,
  RuntimeCloseActivityLogResult,
  RuntimeDeliverParams,
  RuntimeDeliverResult,
  RuntimeOutputPauseParams,
  RuntimeOutputPauseResult,
  RuntimeOutputResumeParams,
  RuntimeOutputResumeResult,
  RuntimeStartParams,
  RuntimeStartResult,
  RuntimeScope,
  RuntimeStateDto,
  RuntimeStatusParams,
  RuntimeStatusResult,
  RuntimeStopAllParams,
  RuntimeStopAllResult,
  RuntimeStopParams,
  RuntimeStopResult,
} from '../../src/protocol.js';
import type { DeliveryOwnerContext } from '../../src/daemon/supervisor-contract.js';

export type FakeSupervisorPhase =
  | 'idle'
  | 'spawning'
  | 'startup_pending'
  | 'ready'
  | 'draining'
  | 'exited';

interface FakeRuntime {
  runtime_scope: RuntimeScope;
  conversation_id: string;
  agent_id: string;
  runtime_generation: number;
  pid: number;
  phase: FakeSupervisorPhase;
  started_at: number;
  pending_startup_delivery_ids?: number[];
  /** Output flow-control flag. Set by `pauseOutput`, cleared by
   *  `resumeOutput`. The fake doesn't gate any actual stdout pump on
   *  this. We track it here so
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
   * Whether the supervisor's simulated driver consumes a
   * `runtime_deliver` spawn-with-batch successfully. Production fake
   * always succeeds (deterministic happy path); tests flip this to
   * exercise the `runtime_delivery_failed` arm without needing a real
   * watchdog.
   */
  failStartupDelivery?: boolean;
}

const DEFAULT_SCHEDULE = (cb: () => void): void => {
  setImmediate(cb);
};

function key(conv: string, agent: string): string {
  return scopeKey({ kind: 'conversation', conversation_id: conv, agent_id: agent });
}

function scopeKey(scope: RuntimeScope): string {
  return scope.kind === 'agent'
    ? `agent\x00${scope.agent_id}`
    : `conversation\x00${scope.conversation_id}\x00${scope.agent_id}`;
}

type LegacyRuntimeCommand = {
  conversation_id: string;
  agent_id: string;
  runtime_generation: number;
};

function commandScope(
  params: { runtime_scope: RuntimeScope } | LegacyRuntimeCommand,
): RuntimeScope {
  return 'runtime_scope' in params
    ? params.runtime_scope
    : { kind: 'conversation', conversation_id: params.conversation_id, agent_id: params.agent_id };
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

  agentMessageSend(_params: AgentMessageSendParams): AgentMessageSendResult {
    return {
      ok: false,
      status: 500,
      body_text: JSON.stringify({ error: 'fake supervisor send not implemented' }),
    };
  }

  agentStaleResolve(
    _params: AgentStaleResolveParams,
  ): AgentStaleResolveResult {
    return {
      ok: false,
      status: 500,
      body_text: JSON.stringify({
        error: 'fake supervisor stale-resolve not implemented',
      }),
    };
  }

  agentStreamObserved(
    _params: AgentStreamObservedParams,
  ): AgentStreamObservedResult {
    // Daemon-local intent — the fake just acks; per-stream observed state
    // lives on the real Supervisor's handles, not here.
    return { ok: true };
  }

  agentStaleReceive(
    _params: AgentStaleReceiveParams,
    _ctx: DeliveryOwnerContext,
  ): AgentStaleReceiveResult {
    // The fake holds no stale/deferred state; the typed no-op arm is the
    // honest answer. Custody arbitration is exercised against the real
    // Supervisor only.
    return { ok: true, outcome: 'no_pending_stale' };
  }

  // ── runtime_start ──────────────────────────────────────────────

  start(params: RuntimeStartParams): RuntimeStartResult {
    const k = scopeKey(params.options.runtime_scope);
    // Idempotent on (conv, agent) — second start while running is a
    // no-op that returns the existing pid + started_at, matching CM
    // today. #task:1417 Stage 2c: `runtime_start` is pure lifecycle —
    // the result is a bare `{started, pid, started_at}` (no `phase` /
    // `startup_delivery_accepted`), and there is no startup batch here.
    const existing = this.runtimes.get(k);
    if (existing && existing.phase !== 'exited') {
      if (existing.runtime_generation !== params.runtime_generation) {
        throw new Error('runtime generation mismatch');
      }
      return {
        started: true,
        pid: existing.pid,
        started_at: existing.started_at,
      };
    }
    const pid = this.nextPid++;
    const startedAt = this.now();
    const rt: FakeRuntime = {
      runtime_scope: params.options.runtime_scope,
      conversation_id: params.conversation_id,
      agent_id: params.agent_id,
      runtime_generation: params.runtime_generation,
      pid,
      phase: 'spawning',
      started_at: startedAt,
      output_paused: false,
    };
    this.runtimes.set(k, rt);
    // Initial phase emit — review fix Cindy `ihw5XHpjldmEc-wt`. Step 1
    // locks the protocol event surface, so the fake MUST emit the
    // declared `runtime_state` transitions; tests / e2e + future
    // integrations rely on them.
    this.emitState(rt);

    // Pure lifecycle spawn: the driver comes up directly ready (matches
    // an empty-inbox start — no spawn-time stdin write). For
    // claude-family this still means session_init waits for the first
    // `runtime_deliver`; the fake collapses that gap to "ready
    // immediately" since nothing about the wire contract requires the
    // wait. A batch arrives only via `runtime_deliver`.
    this.scheduleReady(rt);

    return {
      started: true,
      pid,
      started_at: startedAt,
    };
  }

  // ── runtime_stop ───────────────────────────────────────────────

  stop(params: RuntimeStopParams | (LegacyRuntimeCommand & { mode: 'hard' })): RuntimeStopResult {
    const k = scopeKey(commandScope(params));
    const rt = this.runtimes.get(k);

    // Hard stop = SIGTERM/SIGKILL cascade.
    if (!rt || rt.phase === 'exited') {
      return { mode: 'hard', stopped: false, exit_code: null };
    }
    if (rt.runtime_generation !== params.runtime_generation) {
      return { mode: 'hard', stopped: false, exit_code: null };
    }
    rt.phase = 'draining';
    this.emitState(rt);
    const exitCode = 137;
    this.scheduleExit(rt, exitCode, /* intentional */ true);
    return { mode: 'hard', stopped: true, exit_code: exitCode };
  }

  // ── runtime_deliver (#task:1417 Stage 2) ───────────────────────
  //
  // Daemon-authoritative delivery. Mirrors the real supervisor's three
  // arms: SPAWN (no live runtime) → `spawning` + async
  // `runtime_delivery_consumed`; WRITE (ready) → `admitted` + async
  // `runtime_delivery_consumed`; REFUSE (draining / still coming up) →
  // `refused`. The disposition transfers/refuses custody only; the DB
  // ack rides the async unified event.

  deliver(params: RuntimeDeliverParams, _ctx?: DeliveryOwnerContext): RuntimeDeliverResult {
    const k = scopeKey(params.spawn_options.runtime_scope);
    const rt = this.runtimes.get(k);

    // SPAWN arm — no live runtime.
    if (!rt || rt.phase === 'exited') {
      const pid = this.nextPid++;
      const startedAt = this.now();
      const next: FakeRuntime = {
        runtime_scope: params.spawn_options.runtime_scope,
        conversation_id: params.conversation_id,
        agent_id: params.agent_id,
        runtime_generation: params.runtime_generation,
        pid,
        phase: 'startup_pending',
        started_at: startedAt,
        pending_startup_delivery_ids: [...params.delivery_ids],
        output_paused: false,
      };
      this.runtimes.set(k, next);
      this.emitState(next);
      this.scheduleDeliverySettle(next, [...params.delivery_ids]);
      return { disposition: 'spawning', pid, started_at: startedAt };
    }

    // REFUSE arms.
    if (rt.phase === 'draining') {
      return { disposition: 'refused', reason: 'draining' };
    }
    if (rt.phase === 'spawning' || rt.phase === 'startup_pending') {
      return { disposition: 'refused', reason: 'startup_pending' };
    }
    if (rt.runtime_generation !== params.runtime_generation) {
      throw new Error('runtime generation mismatch');
    }

    // WRITE arm — phase === 'ready'. Custody transferred; consumed ack
    // fires async.
    this.schedule(() => {
      if (rt.phase !== 'ready') return;
      this.emit({
        event: 'runtime_delivery_consumed',
        runtime_scope: rt.runtime_scope,
        conversation_id: rt.conversation_id,
        agent_id: rt.agent_id,
        runtime_generation: rt.runtime_generation,
        delivery_ids: [...params.delivery_ids],
        ts: this.now(),
      });
    });
    return {
      disposition: 'admitted',
      pid: rt.pid,
      started_at: rt.started_at,
    };
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
        runtime_scope: rt.runtime_scope,
        conversation_id: rt.conversation_id,
        agent_id: rt.agent_id,
        runtime_generation: rt.runtime_generation,
        pid: rt.phase === 'exited' ? null : rt.pid,
        phase: rt.phase,
        run_state: null,
        started_at: rt.started_at,
      });
    }
    return { runtimes: out };
  }

  // ── runtime_clear_session ──────────────────────────────────────

  clearSession(params: RuntimeClearSessionParams | LegacyRuntimeCommand): RuntimeClearSessionResult {
    const k = scopeKey(commandScope(params));
    const rt = this.runtimes.get(k);
    if (!rt || rt.phase === 'exited') return { cleared: false };
    if (rt.runtime_generation !== params.runtime_generation) {
      return { cleared: false };
    }
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
  // SupervisorContract (NOT inline dispatcher emit) so protocol
  // routing stays identical between fake and production supervisors.
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
    const k = scopeKey(params.runtime_scope);
    const rt = this.runtimes.get(k);
    if (!rt || rt.phase === 'exited') return { paused: false };
    if (rt.output_paused) return { paused: true };
    rt.output_paused = true;
    this.emit({
      event: 'runtime_output_paused',
      runtime_scope: rt.runtime_scope,
      conversation_id: rt.conversation_id,
      agent_id: rt.agent_id,
    });
    return { paused: true };
  }

  resumeOutput(params: RuntimeOutputResumeParams): RuntimeOutputResumeResult {
    const k = scopeKey(params.runtime_scope);
    const rt = this.runtimes.get(k);
    if (!rt || rt.phase === 'exited') return { resumed: false };
    if (!rt.output_paused) return { resumed: true };
    rt.output_paused = false;
    this.emit({
      event: 'runtime_output_resumed',
      runtime_scope: rt.runtime_scope,
      conversation_id: rt.conversation_id,
      agent_id: rt.agent_id,
    });
    return { resumed: true };
  }

  cleanupDeferredForOwner(_owner: string): void {}

  // ── private scheduling helpers ─────────────────────────────────

  /**
   * Schedule the "driver consumed the batch" transition for a
   * `runtime_deliver` spawn-with-batch (#task:1417 Stage 2). Settles onto
   * the unified `runtime_delivery_consumed`/`_failed` family — the fake's
   * counterpart to the real supervisor's spawn-with-batch consume path.
   * On `failStartupDelivery=true`, emit `runtime_delivery_failed` instead
   * and move the runtime to `exited` (the real driver would tear down on
   * init failure).
   */
  private scheduleDeliverySettle(
    rt: FakeRuntime,
    deliveryIds: number[],
  ): void {
    this.schedule(() => {
      if (rt.phase !== 'startup_pending') return;
      if (this.failStartupDelivery) {
        rt.phase = 'exited';
        rt.pending_startup_delivery_ids = undefined;
        this.emitState(rt, /* terminalReason */ 'crashed');
        this.emit({
          event: 'runtime_delivery_failed',
          runtime_scope: rt.runtime_scope,
          conversation_id: rt.conversation_id,
          agent_id: rt.agent_id,
          runtime_generation: rt.runtime_generation,
          delivery_ids: deliveryIds,
          reason: 'init_watchdog',
          ts: this.now(),
        });
        this.emit({
          event: 'runtime_exit',
          runtime_scope: rt.runtime_scope,
          conversation_id: rt.conversation_id,
          agent_id: rt.agent_id,
          runtime_generation: rt.runtime_generation,
          code: 1,
          intentional: false,
          ts: this.now(),
        });
        return;
      }
      rt.phase = 'ready';
      rt.pending_startup_delivery_ids = undefined;
      this.emitState(rt);
      this.emit({
        event: 'runtime_delivery_consumed',
        runtime_scope: rt.runtime_scope,
        conversation_id: rt.conversation_id,
        agent_id: rt.agent_id,
        runtime_generation: rt.runtime_generation,
        delivery_ids: deliveryIds,
        ts: this.now(),
      });
      this.emit({
        event: 'runtime_ready_for_drain',
        runtime_scope: rt.runtime_scope,
        conversation_id: rt.conversation_id,
        agent_id: rt.agent_id,
        runtime_generation: rt.runtime_generation,
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
        runtime_scope: rt.runtime_scope,
        conversation_id: rt.conversation_id,
        agent_id: rt.agent_id,
        runtime_generation: rt.runtime_generation,
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
        runtime_scope: rt.runtime_scope,
        conversation_id: rt.conversation_id,
        agent_id: rt.agent_id,
        runtime_generation: rt.runtime_generation,
        code,
        intentional,
        ts: this.now(),
      });
    });
  }

  /**
   * Build + emit a `runtime_state` event reflecting `rt`'s current
   * phase. Phase → `AgentRunStatus` mapping deliberately collapses
   * the production supervisor's richer state machine — the fake is
   * for protocol-surface coverage only:
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
      runtime_scope: rt.runtime_scope,
      conversation_id: rt.conversation_id,
      agent_id: rt.agent_id,
      runtime_generation: rt.runtime_generation,
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
