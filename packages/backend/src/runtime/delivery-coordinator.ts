/**
 * `RuntimeDeliveryCoordinator` — backend's live-delivery decision module
 * for daemon-mode runtime.
 *
 * ## Why this exists as its own module
 *
 * Cindy `SG1-ZTOUKLvs1A6G` rejected my first sub-2b plan that piled
 * busy-tracking + pending queue + wake dispatch into `RuntimeEventHandler`
 * (would have made it a mini-CM). The four-module split for daemon-mode
 * runtime is:
 *
 *   - `RuntimeBridge`      — command side (typed proxy over `runtimeWake`,
 *                            `runtimeStart`, …; no state)
 *   - `RuntimeEventHandler`— event fan-out (subscribes to daemon events,
 *                            updates cache + SSE; narrow callbacks for
 *                            anything beyond the projection — does NOT
 *                            hold queues or issue wakes)
 *   - `RunStateCache`      — passive projection of daemon-reported state
 *   - **THIS FILE**         — delivery decisions: when to call
 *                            `bridge.runtimeWake`, when to queue, when to
 *                            mark inbox rows delivered, when to ask
 *                            DaemonHost to respawn a dead oneShot
 *
 * Putting the wake / mark / queue / respawn logic here keeps each of the
 * other three modules unaware of inbox state and driver policy. Tests
 * here run against a mock bridge + mock inbox sink without any DB.
 *
 * ## What the coordinator owns
 *
 *   1. **Busy tracker** per (conv, agent). Read from RAW `ParsedEvent`
 *      (Cindy `BYHZJI9ALSVmmlFr` pin b — the sanitized agent_event drops
 *      input bytes, but `outstandingToolUses` only needs `kind` so either
 *      would work; using raw matches CM's source of truth and avoids
 *      coupling delivery semantics to the UI sanitizer).
 *
 *   2. **Pending-delivery queue** per (conv, agent) for `gated` drivers
 *      caught mid-turn. Flushes when the boundary reopens
 *      (`outstandingToolUses === 0 && !compacting`) — same predicate as
 *      CM's `isSafeBoundary`.
 *
 *   3. **Live wake dispatch** via `bridge.runtimeWake`. Inbox-ack timing
 *      is locked here: `markDelivered` runs ONLY on
 *      `{delivered: true}`; refused / busy / queued paths leave rows
 *      pending so the next safe boundary or next `start()` re-tries.
 *
 *   4. **oneShot auto-respawn** on `runtime_exit`. Gated by the trio
 *      Cindy `BYHZJI9ALSVmmlFr` pin c: `intentional === false` AND
 *      exit was not init_timeout / fatal AND `hasPendingInbox` is true.
 *      Respawn goes through DaemonHost's `start()` callback, NEVER via a
 *      direct wake — the rationale is that startup_delivery is the only
 *      path that can drain pending rows before the runtime advances
 *      past its init phase.
 *
 * ## What the coordinator does NOT own
 *
 *   - Inbox row creation / lookup — DaemonHost calls
 *     `ConversationInboxRepo.ensureDelivery` BEFORE handing the request
 *     here. Reasoning: ensureDelivery is a write that may be a no-op
 *     (already delivered); coordinator should not double-write.
 *
 *   - Message formatting / driver `encodeStdinMessage`. DaemonHost owns
 *     these because they need `MessageRepo` + `AgentRepo` + `UserRepo`
 *     lookups + the per-driver `Driver` instance. The coordinator
 *     receives the pre-formatted payload string and a `DriverDeliveryView`
 *     capability snapshot.
 *
 *   - Issuing `runtime_start`. DaemonHost owns `start()`; coordinator
 *     calls back into a `respawn` function to ask for one.
 *
 *   - SSE / DB writes. EventHandler owns SSE for the cache-projection
 *     events; clearSession-style DB writes live in `AgentService`. The
 *     coordinator only touches inbox-ack (`markDelivered`).
 *
 * ## Test scope (sub-2b-i, Cindy `3l4bZ5vaMvlC9DVS`)
 *
 * Tests in `delivery-coordinator.test.ts` cover the 7-case matrix with
 * mock-bridge + mock-inbox-sink + synthetic ParsedEvents. No DaemonHost
 * integration in 2b-i — that's 2b-ii.
 */
import type { RuntimeWakeResult } from '@silverhand/host';
import type { ParsedEvent } from '@silverhand/shared';
import type { RunStateCache, RuntimePhase } from './run-state-cache.js';

/**
 * Capability snapshot a driver exposes to the coordinator. We do NOT
 * import the full `Driver` interface here — the coordinator only needs
 * these two fields, and narrowing the type makes the test seam smaller.
 *
 * Source: `Driver.busyDeliveryMode` + `Driver.oneShot` from
 * `@silverhand/host/drivers`.
 */
export interface DriverDeliveryView {
  /** `gated` (Claude — only at safe boundaries), `direct` (Codex —
   *  push immediately), or `none` (Cursor / oneShot — never push, must
   *  respawn). */
  busyDeliveryMode: 'gated' | 'direct' | 'none';
  /** True if the runtime exits after a single turn (cursor). */
  oneShot: boolean;
}

/**
 * A live-delivery request. DaemonHost builds these after
 * `inboxes.ensureDelivery` + `driver.encodeStdinMessage`. The
 * coordinator decides whether to call `wake`, queue, or refuse.
 *
 * `payload` is the FINAL stream-json line the daemon will write to the
 * child's stdin (driver-encoded). Coordinator does not re-format it.
 *
 * `driver` is a capability snapshot — it MUST match the driver currently
 * bound to (conv, agent) on the host side. Coordinator does not
 * re-look-up.
 */
export interface LiveDeliveryRequest {
  inboxId: number;
  messageId: string;
  payload: string;
  driver: DriverDeliveryView;
}

/**
 * Outcome of a `submitLiveDelivery` call. Returned so DaemonHost can
 * log the route taken; coordinator already advanced the state /
 * inbox-ack as needed.
 *
 *   - `wake_dispatched`     — bridge.runtimeWake returned
 *                             `{delivered: true}`; markDelivered ran.
 *   - `wake_refused`        — bridge.runtimeWake returned
 *                             `{delivered: false, reason}`; row left
 *                             pending.
 *   - `queued_mid_turn`     — gated driver caught mid-turn; payload
 *                             pushed to pending queue, flush will fire
 *                             on next safe boundary.
 *   - `noop_oneshot_live`   — driver.busyDeliveryMode === 'none' and
 *                             runtime is live; pending row will be
 *                             picked up on next respawn.
 *   - `noop_phase`          — phase is startup_pending / draining /
 *                             exited; daemon-side path will deliver
 *                             via startup_delivery on next start.
 *   - `noop_no_runtime`     — no cache entry at all; DaemonHost is
 *                             responsible for calling `start()` upstream
 *                             when first delivery arrives for an idle
 *                             agent.
 */
export type LiveDeliveryDecision =
  | { kind: 'wake_dispatched'; deliveryIds: readonly number[] }
  | {
      kind: 'wake_refused';
      reason:
        | 'not_running'
        | 'not_initialized'
        | 'startup_pending'
        | 'draining'
        | 'driver_refused';
    }
  | { kind: 'queued_mid_turn'; pendingCount: number }
  | { kind: 'noop_oneshot_live' }
  | { kind: 'noop_phase'; phase: RuntimePhase }
  | { kind: 'noop_no_runtime' };

/**
 * Metadata accompanying the `onRuntimeExit` callback. EventHandler
 * derives `initTimedOut` from observing prior
 * `runtime_init_timeout` / `runtime_init_cooldown` events for the same
 * (conv, agent); derives `fatalError` from prior parsed `error` events
 * with `fatal: true`. Coordinator uses these to gate the oneShot
 * auto-respawn (Cindy `BYHZJI9ALSVmmlFr` pin a).
 */
export interface RuntimeExitMeta {
  intentional: boolean;
  code: number | null;
  /** True iff the exit was preceded by `runtime_init_cooldown` (i.e.
   *  init watchdog exhausted retries). Auto-respawn is suppressed. */
  initTimedOut: boolean;
  /** True iff the exit was preceded by a parsed `error` event with
   *  `fatal: true` (e.g. `thread_not_found`). Auto-respawn is
   *  suppressed. */
  fatalError: boolean;
}

/**
 * Bridge subset the coordinator needs. Kept narrow so tests can pass
 * an `{ runtimeWake: vi.fn() }` literal without instantiating
 * `RuntimeBridge`.
 */
export interface CoordinatorBridge {
  runtimeWake(params: {
    conversation_id: string;
    agent_id: string;
    delivery_ids: number[];
    kind: 'message' | 'schedule_fire';
    payload: string;
  }): Promise<RuntimeWakeResult>;
}

/**
 * Inbox ack sink — narrow on purpose so tests can supply a literal.
 * Coordinator calls `markDelivered` only on a successful wake; failure
 * paths leave rows pending so the inbox replay handles them.
 */
export interface CoordinatorInboxSink {
  markDelivered(deliveryIds: readonly number[]): void;
}

/**
 * Cache view the coordinator needs. Kept narrow so tests can pass a
 * `Map`-backed mock without instantiating `RunStateCache`.
 */
export interface CoordinatorCacheView {
  get(
    conversationId: string,
    agentId: string,
  ): { phase: RuntimePhase } | undefined;
}

/**
 * DaemonHost-supplied callbacks the coordinator needs at the
 * non-projection edges. Both default to no-ops so 2b-i tests can drive
 * the coordinator standalone.
 */
export interface CoordinatorCallbacks {
  /** Called from `onRuntimeExit` when the oneShot auto-respawn trio is
   *  satisfied. DaemonHost binds this to its own `start(conv, agent)`.
   *  Errors are swallowed + logged here — auto-respawn is best-effort. */
  respawn?(conversationId: string, agentId: string): Promise<void> | void;
  /** Called from `onRuntimeExit` to check whether any pending inbox
   *  rows exist before auto-respawning. DaemonHost wires this to
   *  `ConversationInboxRepo.listPending(conv, agent).length > 0`. */
  hasPendingInbox?(conversationId: string, agentId: string): boolean;
  /** Called when the coordinator must flush a queued batch (gated
   *  driver, safe boundary opened). DaemonHost provides the combine
   *  function because batch formatting needs `Driver.encodeStdinMessage`
   *  semantics. If absent, the coordinator falls back to wake-per-item
   *  (functionally correct but less efficient). */
  combineBatch?(payloads: readonly string[]): string;
}

export interface CoordinatorLogger {
  info(meta: object, msg: string): void;
  warn(meta: object, msg: string): void;
  error(meta: object, msg: string): void;
}

const NOOP_LOGGER: CoordinatorLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

export interface RuntimeDeliveryCoordinatorDeps {
  bridge: CoordinatorBridge;
  cache: CoordinatorCacheView;
  inboxAck: CoordinatorInboxSink;
  callbacks?: CoordinatorCallbacks;
  logger?: CoordinatorLogger;
}

interface BusyState {
  outstandingToolUses: number;
  compacting: boolean;
}

interface PendingDelivery {
  inboxId: number;
  messageId: string;
  payload: string;
  /** The driver capability the request was submitted under. Stored so
   *  the flush path can pick the right routing (in practice a single
   *  agent's driver doesn't change mid-session, but storing per-row
   *  removes a class of "what if driver flipped" footguns). */
  driver: DriverDeliveryView;
}

interface PerAgentState {
  busy: BusyState;
  pending: PendingDelivery[];
  /** True iff a flush is currently in-flight for this (conv, agent).
   *  Prevents a second `tool_output → turn_end` cascade from racing
   *  itself when wake's await yields. CM serializes via `drainChain`;
   *  we use a simpler boolean because the coordinator never reads from
   *  the daemon side post-wake (no second-leg event to interleave). */
  flushing: boolean;
}

function key(conversationId: string, agentId: string): string {
  return `${conversationId}|${agentId}`;
}

function makeBusy(): BusyState {
  return { outstandingToolUses: 0, compacting: false };
}

function isSafeBoundary(busy: BusyState): boolean {
  return busy.outstandingToolUses === 0 && !busy.compacting;
}

export class RuntimeDeliveryCoordinator {
  private readonly bridge: CoordinatorBridge;
  private readonly cache: CoordinatorCacheView;
  private readonly inboxAck: CoordinatorInboxSink;
  private readonly callbacks: CoordinatorCallbacks;
  private readonly logger: CoordinatorLogger;
  private readonly state = new Map<string, PerAgentState>();

  constructor(deps: RuntimeDeliveryCoordinatorDeps) {
    this.bridge = deps.bridge;
    this.cache = deps.cache;
    this.inboxAck = deps.inboxAck;
    this.callbacks = deps.callbacks ?? {};
    this.logger = deps.logger ?? NOOP_LOGGER;
  }

  // ── public surface ───────────────────────────────────────────────

  /**
   * Decide how to handle a live delivery. DaemonHost calls this AFTER
   * `inboxes.ensureDelivery` returned a fresh (not-yet-delivered) row
   * and AFTER `driver.encodeStdinMessage` returned a non-null payload.
   *
   * The return value is informational — coordinator already advanced
   * state / acks as needed. DaemonHost can use it for logging /
   * metrics; the inbox is the source of truth for retry.
   */
  async submitLiveDelivery(
    conversationId: string,
    agentId: string,
    req: LiveDeliveryRequest,
  ): Promise<LiveDeliveryDecision> {
    const entry = this.cache.get(conversationId, agentId);
    if (!entry) {
      this.logger.info(
        { conversationId, agentId, inboxId: req.inboxId },
        'deliver: no cache entry; row stays pending until next start',
      );
      return { kind: 'noop_no_runtime' };
    }

    if (
      entry.phase === 'startup_pending' ||
      entry.phase === 'draining' ||
      entry.phase === 'exited'
    ) {
      this.logger.info(
        {
          conversationId,
          agentId,
          inboxId: req.inboxId,
          phase: entry.phase,
        },
        'deliver: runtime not in ready phase; row stays pending',
      );
      return { kind: 'noop_phase', phase: entry.phase };
    }

    // From here, phase is `idle` or `ready`. Daemon side only emits
    // ready_for_drain / accepts wakes once `ready`; `idle` here means
    // we have a stale projection (rare — would imply backend issued
    // start but daemon hasn't ack-fired `runtime_state` yet). We still
    // route by driver policy so the test matrix doesn't have to enumerate
    // every transient phase variant.

    if (req.driver.busyDeliveryMode === 'none') {
      // oneShot live: never push via wake. Row stays pending; the
      // next respawn (on runtime_exit) drains via startup_delivery.
      this.logger.info(
        { conversationId, agentId, inboxId: req.inboxId },
        'deliver: oneShot driver live, row queued for next respawn',
      );
      return { kind: 'noop_oneshot_live' };
    }

    const st = this.ensureState(conversationId, agentId);

    if (req.driver.busyDeliveryMode === 'direct' || isSafeBoundary(st.busy)) {
      return this.dispatchWake(conversationId, agentId, [req]);
    }

    // Gated driver mid-turn. Enqueue; flush will fire when
    // outstandingToolUses returns to 0 + compacting clears.
    this.enqueue(st, req);
    this.logger.info(
      {
        conversationId,
        agentId,
        inboxId: req.inboxId,
        pendingCount: st.pending.length,
        outstandingToolUses: st.busy.outstandingToolUses,
        compacting: st.busy.compacting,
      },
      'deliver: gated driver busy, queued for next safe boundary',
    );
    return { kind: 'queued_mid_turn', pendingCount: st.pending.length };
  }

  /**
   * Parsed-event hook called by EventHandler on every
   * `runtime_parsed_event`. Updates busy tracker; if the boundary
   * just reopened, schedules a flush.
   *
   * MUST be called with the RAW `ParsedEvent` from
   * `frame.parsed`, NOT the sanitized agent_event payload (Cindy
   * `BYHZJI9ALSVmmlFr` pin b).
   */
  onParsedEvent(
    conversationId: string,
    agentId: string,
    ev: ParsedEvent,
  ): void {
    const st = this.ensureState(conversationId, agentId);
    const wasSafe = isSafeBoundary(st.busy);
    switch (ev.kind) {
      case 'tool_call':
        st.busy.outstandingToolUses += 1;
        break;
      case 'tool_output':
        st.busy.outstandingToolUses = Math.max(
          0,
          st.busy.outstandingToolUses - 1,
        );
        break;
      case 'turn_end':
        // CM clamps to 0 on turn_end to recover from any drift (e.g.
        // tool_call without matching tool_output, which we occasionally
        // observed on claude pre-PR-A). Same here.
        st.busy.outstandingToolUses = 0;
        break;
      case 'compaction_started':
        st.busy.compacting = true;
        break;
      case 'compaction_finished':
        st.busy.compacting = false;
        break;
      // session_init / thinking / text / error / unknown have no busy
      // impact — they're either init-only or content-only signals.
      case 'session_init':
      case 'thinking':
      case 'text':
      case 'error':
      case 'unknown':
        return;
      default: {
        // Exhaustiveness check: if shared `ParsedEvent` gains a variant
        // and we forgot to handle it, this branch flags at typecheck.
        const _exhaustive: never = ev;
        void _exhaustive;
        return;
      }
    }
    const nowSafe = isSafeBoundary(st.busy);
    if (!wasSafe && nowSafe && st.pending.length > 0) {
      void this.flush(conversationId, agentId);
    }
  }

  /**
   * Runtime-exit hook called by EventHandler. Drops per-agent
   * state and, when the oneShot trio is satisfied, asks DaemonHost to
   * respawn.
   *
   * Pin c gate: `intentional === false` AND NOT init-timeout AND NOT
   * fatal AND pending inbox exists. Direct wake is NEVER used here —
   * the only correct path for oneShot redelivery is `start()` +
   * startup_delivery, because the new daemon-side runtime drains the
   * inbox in its init phase.
   */
  onRuntimeExit(
    conversationId: string,
    agentId: string,
    meta: RuntimeExitMeta,
  ): void {
    // Clear per-agent state regardless of whether we respawn — any
    // queue state belongs to the dead runtime; a fresh start owns its
    // own queue.
    this.state.delete(key(conversationId, agentId));

    if (meta.intentional) return;
    if (meta.initTimedOut) return;
    if (meta.fatalError) return;
    if (this.callbacks.hasPendingInbox?.(conversationId, agentId) !== true) {
      return;
    }
    const respawn = this.callbacks.respawn;
    if (!respawn) {
      this.logger.warn(
        { conversationId, agentId },
        'deliver: oneShot exit with pending inbox but no respawn callback wired',
      );
      return;
    }
    Promise.resolve()
      .then(() => respawn(conversationId, agentId))
      .catch(err => {
        this.logger.error(
          {
            conversationId,
            agentId,
            err: (err as Error).message,
          },
          'deliver: oneShot auto-respawn failed',
        );
      });
  }

  // ── test inspection ──────────────────────────────────────────────

  /** Read-only view of the pending queue. Test-only convenience. */
  pendingCount(conversationId: string, agentId: string): number {
    return this.state.get(key(conversationId, agentId))?.pending.length ?? 0;
  }

  /** Read-only view of the busy tracker. Test-only convenience. */
  busySnapshot(
    conversationId: string,
    agentId: string,
  ): { outstandingToolUses: number; compacting: boolean } {
    const st = this.state.get(key(conversationId, agentId));
    return {
      outstandingToolUses: st?.busy.outstandingToolUses ?? 0,
      compacting: st?.busy.compacting ?? false,
    };
  }

  // ── internals ────────────────────────────────────────────────────

  private ensureState(conversationId: string, agentId: string): PerAgentState {
    const k = key(conversationId, agentId);
    let st = this.state.get(k);
    if (!st) {
      st = { busy: makeBusy(), pending: [], flushing: false };
      this.state.set(k, st);
    }
    return st;
  }

  private enqueue(st: PerAgentState, req: LiveDeliveryRequest): void {
    // Idempotent push — re-delivery of the same messageId at the same
    // boundary should not double-write. CM uses messageId as the dedup
    // key (inboxId is also unique per delivery, but messageId is what
    // the caller knows).
    if (st.pending.some(item => item.messageId === req.messageId)) return;
    st.pending.push({
      inboxId: req.inboxId,
      messageId: req.messageId,
      payload: req.payload,
      driver: req.driver,
    });
  }

  private async flush(conversationId: string, agentId: string): Promise<void> {
    const st = this.state.get(key(conversationId, agentId));
    if (!st) return;
    if (st.flushing) return;
    if (st.pending.length === 0) return;
    if (!isSafeBoundary(st.busy)) return;
    st.flushing = true;
    try {
      const batch = st.pending.splice(0);
      const payloads = batch.map(item => item.payload);
      const combined =
        payloads.length === 1
          ? payloads[0]!
          : this.callbacks.combineBatch
            ? this.callbacks.combineBatch(payloads)
            : // Fallback: join with newline. Practically every batch is
              // 1 item anyway (CM rarely accumulates more than one per
              // safe-boundary window); leaving a textually-degraded
              // multi-item batch is preferable to dropping rows.
              payloads.join('\n');
      const deliveryIds = batch.map(item => item.inboxId);
      const result = await this.bridge.runtimeWake({
        conversation_id: conversationId,
        agent_id: agentId,
        delivery_ids: deliveryIds,
        kind: 'message',
        payload: combined,
      });
      if (result.delivered) {
        this.inboxAck.markDelivered(result.delivery_ids);
        this.logger.info(
          {
            conversationId,
            agentId,
            batchSize: batch.length,
            deliveryIds: result.delivery_ids,
          },
          'deliver: flushed pending batch at safe boundary',
        );
      } else {
        // Refused. Push the batch back at the head so a later flush
        // can re-try. Order preserved because we used splice(0); items
        // go back in their original positions.
        st.pending.unshift(...batch);
        this.logger.warn(
          {
            conversationId,
            agentId,
            reason: result.reason,
            deliveryIds: result.delivery_ids,
          },
          'deliver: flush refused; rows remain queued',
        );
      }
    } catch (err) {
      this.logger.error(
        {
          conversationId,
          agentId,
          err: (err as Error).message,
        },
        'deliver: flush threw; rows remain queued',
      );
      // On a thrown bridge call (transport failure), the batch we
      // spliced is lost from the queue. Re-derive it from the inbox on
      // the next opportunity — which will happen because no
      // markDelivered ran, so listPending will still return them at the
      // next start / ready_for_drain.
    } finally {
      st.flushing = false;
    }
  }

  private async dispatchWake(
    conversationId: string,
    agentId: string,
    batch: LiveDeliveryRequest[],
  ): Promise<LiveDeliveryDecision> {
    const payloads = batch.map(item => item.payload);
    const combined =
      payloads.length === 1
        ? payloads[0]!
        : this.callbacks.combineBatch
          ? this.callbacks.combineBatch(payloads)
          : payloads.join('\n');
    const deliveryIds = batch.map(item => item.inboxId);
    let result: RuntimeWakeResult;
    try {
      result = await this.bridge.runtimeWake({
        conversation_id: conversationId,
        agent_id: agentId,
        delivery_ids: deliveryIds,
        kind: 'message',
        payload: combined,
      });
    } catch (err) {
      this.logger.error(
        {
          conversationId,
          agentId,
          deliveryIds,
          err: (err as Error).message,
        },
        'deliver: runtimeWake threw; row stays pending',
      );
      // Transport / internal_error fail loudly per Cindy's contract on
      // clearSession — same posture applies here: don't pretend
      // delivered, don't mutate inbox. Re-throw so DaemonHost surfaces.
      throw err;
    }
    if (result.delivered) {
      this.inboxAck.markDelivered(result.delivery_ids);
      this.logger.info(
        {
          conversationId,
          agentId,
          deliveryIds: result.delivery_ids,
          batchSize: batch.length,
        },
        'deliver: wake dispatched, rows marked delivered',
      );
      return { kind: 'wake_dispatched', deliveryIds: result.delivery_ids };
    }
    this.logger.warn(
      {
        conversationId,
        agentId,
        reason: result.reason,
        deliveryIds: result.delivery_ids,
      },
      'deliver: wake refused, row stays pending',
    );
    return { kind: 'wake_refused', reason: result.reason };
  }
}
