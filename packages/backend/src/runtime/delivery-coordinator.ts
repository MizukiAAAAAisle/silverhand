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
 *     receives the pre-formatted raw text and a `DriverDeliveryView`
 *     capability snapshot.
 *
 *   - Issuing `runtime_start`. DaemonHost owns `start()`; coordinator
 *     calls back into a `respawn` function to ask for one.
 *
 *   - General SSE / DB writes. EventHandler owns daemon-projected SSE;
 *     clearSession-style DB writes live in `AgentService`. The
 *     coordinator only touches inbox-ack (`markDelivered`) plus the P2
 *     synthetic stuck indicator via an injected `publishActivity`
 *     callback.
 *
 * ## Test scope (sub-2b-i, Cindy `3l4bZ5vaMvlC9DVS`)
 *
 * Tests in `delivery-coordinator.test.ts` cover the 7-case matrix with
 * mock-bridge + mock-inbox-sink + synthetic ParsedEvents. No DaemonHost
 * integration in 2b-i — that's 2b-ii.
 */
import type { RuntimeWakeResult } from '@silverhand/host';
import type {
  AgentRunState,
  AgentRunStatus,
  AgentRunTerminalReason,
  ParsedEvent,
} from '@silverhand/shared';
import type { RunStateCache, RuntimePhase } from './run-state-cache.js';

/**
 * Capability snapshot a driver exposes to the coordinator. We do NOT
 * import the full `Driver` interface here — the coordinator only needs
 * these fields, and narrowing the type makes the test seam smaller.
 *
 * Source: `Driver.busyDeliveryMode` + `Driver.oneShot` + `Driver.kickoffMode`
 * from `@silverhand/host/drivers`.
 */
export interface DriverDeliveryView {
  /** Runtime label used only for user-visible stuck-watchdog copy.
   *  Optional so tests can keep small fixtures; gated drivers default
   *  to `claude`, direct drivers to `runtime`. */
  runtime?: string;
  /** `gated` (Claude — only at safe boundaries), `direct` (Codex —
   *  push immediately), or `none` (Cursor / oneShot — never push, must
   *  respawn). */
  busyDeliveryMode: 'gated' | 'direct' | 'none';
  /** True if the runtime exits after a single turn (cursor). */
  oneShot: boolean;
  /** `requires_first_message` (claude — `system.init` only fires once
   *  the runtime has received its first user message; B3 gate defers
   *  inbox `markDelivered` until that parsed `session_init` is observed)
   *  or `self_inits` (codex / cursor — daemon-side init proves the
   *  runtime is alive before backend issues any wake; ack on
   *  `{delivered:true}` is safe). */
  kickoffMode: 'self_inits' | 'requires_first_message';
}

/**
 * A live-delivery request. DaemonHost builds these after
 * `inboxes.ensureDelivery`. The coordinator decides whether to call
 * `wake`, queue, or refuse.
 *
 * # Daemon owns encode (Option A v2 — Cindy `UMGu36zoTDVuKWXi`)
 *
 * `text` is the UN-ENCODED human-readable message body (from
 * `formatLiveMessage` or `formatInboxBatch`). The daemon's in-process
 * driver instance — whose runtime state (codex `threadId` etc.) is
 * authoritative — encodes via `encodeStdinMessage(text, cliSessionId)`
 * just before writing to stdin. Backend MUST NOT pre-encode: doing so
 * would spin up a STATELESS driver instance whose `encodeStdinMessage`
 * returns null for codex (no `threadId` yet), silently killing every
 * wake. This was the codex daemon-mode delivery blocker (see commit
 * 2b-iii log).
 *
 * # Combine-before-encode invariant (still holds)
 *
 * Combination still happens BEFORE the daemon encodes. The coordinator
 * combines multiple `text` fields via `combineGated` when batch.length
 * > 1 and ships ONE combined text to the daemon. The daemon then
 * encodes once. Feeding encoded JSON lines through `combineGated`
 * would produce a payload that is not a legal driver stdin line
 * (claude's `--input-format stream-json` would see malformed input).
 *
 * # Atomic delivery groups (`deliveryIds`)
 *
 * Most requests cover a single inbox row → `deliveryIds = [inboxId]`.
 * For caller pre-combined groups (e.g. `DaemonHost.drainPending` using
 * `formatInboxBatch` because the inbox-drain wrapper differs from the
 * gated-busy wrapper) `text` is already the combined text and
 * `deliveryIds` carries every inbox row the combined text covers.
 * Coordinator treats them as one atomic ack group.
 */
export interface LiveDeliveryRequest {
  /** Atomic group of inbox row ids this single `text` covers. Singleton
   *  for live deliverMessage; multi when the caller pre-combined. All
   *  ids in the group are acked together (or stashed together for the
   *  B3 init gate). */
  deliveryIds: readonly number[];
  /** Highest message seq covered by this text payload. */
  deliveredUpToSeq?: number;
  /** Stable dedup key. For singleton groups, the row's message id; for
   *  pre-combined groups, an arbitrary key the caller picks (typically
   *  the first row's message id). Coordinator's enqueue skips a new
   *  request whose key already exists in the pending queue. */
  dedupKey: string;
  /** Un-encoded human-readable text. Combined with sibling requests
   *  via `combineGated` before the daemon encodes when batch.length > 1. */
  text: string;
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
        | 'driver_not_ready'
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
 *
 * `text` is the unencoded message text the daemon will hand to its
 * in-process driver's `encodeStdinMessage(text, cliSessionId)` (Option
 * A v2 — Cindy `UMGu36zoTDVuKWXi`). Backend NEVER pre-encodes.
 */
export interface CoordinatorBridge {
  runtimeWake(params: {
    conversation_id: string;
    agent_id: string;
    delivery_ids: number[];
    delivered_up_to_seq?: number;
    kind: 'message' | 'schedule_fire';
    text: string;
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
  ): { phase: RuntimePhase; runState?: AgentRunState | null } | undefined;
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
  /** Called when the coordinator must combine multiple un-encoded
   *  message texts into one gated-batch text BEFORE the per-driver
   *  encode step. DaemonHost wires this to `combineGatedBatch(texts,
   *  'silverhand message send')`. Without it the coordinator cannot
   *  produce a semantically-equivalent batch text, and silently
   *  degrading to `texts.join(...)` would violate the "no silent
   *  degradation" contract (Cindy `rrF2L1RmWq5JFH3m` B3 /
   *  `0G5uJBydO_4qt_2r`). When omitted, multi-text batches throw at
   *  flush/dispatch time and the rows stay pending; single-text paths
   *  still work. Note the critical contract (Cindy `Mqf1h-FKudtEbH1O`):
   *  the input is un-encoded message text, NOT driver-encoded stdin
   *  lines — daemon encodes once after the combined text crosses the
   *  wire. */
  combineGated?(texts: readonly string[]): string;
  /** Optional backend-side `agent_activity` publisher. Used only for
   *  the P2 live-wake stuck indicator: after daemon accepted a live
   *  wake, if no parsed event arrives within the threshold, publish a
   *  synthetic `thinking` run state so the UI doesn't look idle while
   *  the child process is stuck before its first observable event. */
  publishActivity?(state: AgentRunState): void;
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
  /** Wake→first-parsed watchdog threshold. Defaults to 30s, per P2
   *  review. Set <=0 to disable in tests. */
  wakeStuckMs?: number;
  /** Test seam for deterministic timestamps. Production uses Date.now. */
  now?: () => number;
}

interface BusyState {
  outstandingToolUses: number;
  compacting: boolean;
}

interface PendingDelivery {
  /** Inbox row ids covered by this pending request. Singleton for most
   *  enqueued requests; multi for caller pre-combined groups. */
  deliveryIds: readonly number[];
  deliveredUpToSeq?: number;
  dedupKey: string;
  /** Un-encoded human-readable text. Combined with sibling pendings at
   *  flush time via `combineGated` (when length > 1); daemon encodes. */
  text: string;
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
  /**
   * B3 (Cindy `usjxj8AxX4AvJ5E-`): set when we observe a parsed
   * `session_init` for this (conv, agent). Cleared on `runtime_exit`
   * via `state.delete`. Used to gate `markDelivered` for live wakes
   * dispatched against `kickoffMode='requires_first_message'` runtimes
   * that haven't surfaced `session_init` yet. Pre-B3 the daemon
   * reporting `{delivered:true}` on the wake was treated as proof of
   * delivery — but for claude the wake landing in stdin only proves
   * the BYTES were written; the child must then parse it and emit
   * `system.init` to prove it's actually consuming input. If the child
   * dies in the window between "stdin written" and "session_init
   * parsed", we'd have marked the row delivered while the message was
   * lost.
   */
  initObserved: boolean;
  /**
   * Wake delivery IDs that were accepted by the daemon (`delivered:true`)
   * but NOT yet acked to the inbox because `initObserved` was false
   * at wake-time. Marked delivered on `session_init`; cleared (without
   * marking) on `runtime_exit` so the rows replay via
   * `startup_delivery` on the next spawn.
   */
  initPendingDeliveryIds: number[];
  wakeWatchdog: WakeWatchdogState | null;
}

interface WakeWatchdogState {
  timer: ReturnType<typeof setTimeout> | null;
  token: number;
  baseRunId: string;
  baseUpdatedAt: number;
  fired: boolean;
  syntheticState: AgentRunState | null;
}

const DEFAULT_WAKE_STUCK_MS = 30_000;

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
  private readonly wakeStuckMs: number;
  private readonly now: () => number;
  private readonly state = new Map<string, PerAgentState>();
  private nextWakeWatchdogToken = 0;

  constructor(deps: RuntimeDeliveryCoordinatorDeps) {
    this.bridge = deps.bridge;
    this.cache = deps.cache;
    this.inboxAck = deps.inboxAck;
    this.callbacks = deps.callbacks ?? {};
    this.logger = deps.logger ?? NOOP_LOGGER;
    this.wakeStuckMs = deps.wakeStuckMs ?? DEFAULT_WAKE_STUCK_MS;
    this.now = deps.now ?? (() => Date.now());
  }

  // ── public surface ───────────────────────────────────────────────

  /**
   * Decide how to handle a single live delivery. DaemonHost calls this
   * AFTER `inboxes.ensureDelivery` returned a fresh (not-yet-delivered)
   * row and AFTER `driver.encodeStdinMessage` returned a non-null
   * payload.
   *
   * The return value is informational — coordinator already advanced
   * state / acks as needed. DaemonHost can use it for logging /
   * metrics; the inbox is the source of truth for retry.
   *
   * Thin convenience over `submitLiveDeliveryBatch([req])`.
   */
  async submitLiveDelivery(
    conversationId: string,
    agentId: string,
    req: LiveDeliveryRequest,
  ): Promise<LiveDeliveryDecision> {
    return this.submitLiveDeliveryBatch(conversationId, agentId, [req]);
  }

  /**
   * Batch sibling of `submitLiveDelivery`. Two callers:
   *
   *   1. **`DaemonHost.drainPending`** (Cindy `nKFVSvx4CyBLxPNq` blocker 2):
   *      multi-row inbox drain on `runtime_ready_for_drain`. The caller
   *      pre-combines via `formatInboxBatch` and submits ONE request
   *      with multi `deliveryIds`; coordinator dispatches once and acks
   *      all ids atomically.
   *   2. **Mid-turn gated flush** (internal): single-message requests
   *      enqueued via `submitLiveDelivery` get re-collected by `flush`
   *      when the safe boundary reopens; if multiple are pending the
   *      coordinator combines their `text` fields via `combineGated`
   *      (Cindy `Mqf1h-FKudtEbH1O`: combine BEFORE encode — feeding
   *      encoded JSON lines through `combineGated` would produce
   *      malformed claude stdin).
   *
   * Ack contract — all-or-nothing across the batch:
   *   - on `{delivered:true}` → `markDelivered` runs once with EVERY id
   *     across the entire batch (or the entire batch is stashed into
   *     `initPendingDeliveryIds` for the B3 init gate; that stash also
   *     flushes as one ack);
   *   - on `{delivered:false}` or throw → NO ids are acked; every row
   *     stays pending so the next ready_for_drain (or live arrival)
   *     replays the whole batch.
   *
   * Per-row `deliverMessage` looping would change the agent's visible
   * turn boundary (one wake per row → claude treats each as its own
   * user turn) and would degrade batch ack into partial-success — both
   * forbidden by Cindy's contract.
   *
   * Invariants the caller must uphold:
   *   1. All requests share the same (conv, agent) → same driver +
   *      same daemon-owned driver state. The coordinator reads
   *      `driver` from `batch[0]` after the empty check.
   *   2. The batch is non-empty. Empty batches throw — callers should
   *      no-op upstream when their listPending returned nothing.
   *   3. Each `req` already passed `inboxes.ensureDelivery` (so every
   *      `inboxId` in `deliveryIds` is a fresh, not-yet-delivered row).
   *
   * Decision semantics for the batch return value (since the function
   * returns a single decision rather than per-row):
   *   - `wake_dispatched` carries every `result.delivery_ids` from the
   *     single wake.
   *   - `wake_refused` / `noop_*` apply to the batch uniformly.
   *   - `queued_mid_turn.pendingCount` reflects the queue size after
   *     enqueuing the entire batch.
   */
  async submitLiveDeliveryBatch(
    conversationId: string,
    agentId: string,
    batch: readonly LiveDeliveryRequest[],
  ): Promise<LiveDeliveryDecision> {
    if (batch.length === 0) {
      throw new Error(
        'submitLiveDeliveryBatch: empty batch — caller must no-op when ' +
          'listPending is empty rather than calling through with [].',
      );
    }
    const deliveryIds = batch.flatMap(item => [...item.deliveryIds]);
    const head = batch[0]!;
    const entry = this.cache.get(conversationId, agentId);
    if (!entry) {
      this.logger.info(
        { conversationId, agentId, deliveryIds, batchSize: batch.length },
        'deliver: no cache entry; rows stay pending until next start',
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
          deliveryIds,
          batchSize: batch.length,
          phase: entry.phase,
        },
        'deliver: runtime not in ready phase; rows stay pending',
      );
      return { kind: 'noop_phase', phase: entry.phase };
    }

    // From here, phase is `idle` or `ready`. Daemon side only emits
    // ready_for_drain / accepts wakes once `ready`; `idle` here means
    // we have a stale projection (rare — would imply backend issued
    // start but daemon hasn't ack-fired `runtime_state` yet). We still
    // route by driver policy so the test matrix doesn't have to enumerate
    // every transient phase variant.

    if (head.driver.busyDeliveryMode === 'none') {
      // oneShot live: never push via wake. Rows stay pending; the
      // next respawn (on runtime_exit) drains via startup_delivery.
      this.logger.info(
        { conversationId, agentId, deliveryIds, batchSize: batch.length },
        'deliver: oneShot driver live, rows queued for next respawn',
      );
      return { kind: 'noop_oneshot_live' };
    }

    const st = this.ensureState(conversationId, agentId);

    if (head.driver.busyDeliveryMode === 'direct' || isSafeBoundary(st.busy)) {
      return this.dispatchWake(conversationId, agentId, [...batch]);
    }

    // Gated driver mid-turn. Enqueue every row; flush will fire when
    // outstandingToolUses returns to 0 + compacting clears, and will
    // combine texts via `combineGated` then encode once.
    for (const req of batch) {
      this.enqueue(st, req);
    }
    this.logger.info(
      {
        conversationId,
        agentId,
        deliveryIds,
        batchSize: batch.length,
        pendingCount: st.pending.length,
        outstandingToolUses: st.busy.outstandingToolUses,
        compacting: st.busy.compacting,
      },
      'deliver: gated driver busy, batch queued for next safe boundary',
    );
    return { kind: 'queued_mid_turn', pendingCount: st.pending.length };
  }

  /**
   * Replay DB-owned inbox rows after daemon emitted `runtime_ready_for_drain`.
   * This path intentionally bypasses the coordinator's process-local gated
   * pending queue: the durable DB claim already owns ordering/idempotency, and
   * ready_for_drain is the daemon's explicit signal that a wake may be sent.
   */
  async submitReadyForDrainDeliveryBatch(
    conversationId: string,
    agentId: string,
    batch: readonly LiveDeliveryRequest[],
  ): Promise<LiveDeliveryDecision> {
    if (batch.length === 0) {
      throw new Error(
        'submitReadyForDrainDeliveryBatch: empty batch — caller must no-op ' +
          'when listPending is empty rather than calling through with [].',
      );
    }
    const deliveryIds = batch.flatMap(item => [...item.deliveryIds]);
    const head = batch[0]!;
    const entry = this.cache.get(conversationId, agentId);
    if (!entry) {
      this.logger.info(
        { conversationId, agentId, deliveryIds, batchSize: batch.length },
        'deliver: ready_for_drain replay saw no cache entry; rows stay pending',
      );
      return { kind: 'noop_no_runtime' };
    }
    if (entry.phase !== 'ready') {
      this.logger.info(
        {
          conversationId,
          agentId,
          deliveryIds,
          batchSize: batch.length,
          phase: entry.phase,
        },
        'deliver: ready_for_drain replay saw non-ready phase; rows stay pending',
      );
      return { kind: 'noop_phase', phase: entry.phase };
    }
    if (head.driver.busyDeliveryMode === 'none') {
      this.logger.info(
        { conversationId, agentId, deliveryIds, batchSize: batch.length },
        'deliver: oneShot driver ready_for_drain replay refused; rows stay pending',
      );
      return { kind: 'noop_oneshot_live' };
    }
    return this.dispatchWake(conversationId, agentId, [...batch]);
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
    // Any parsed signal means the child has moved past the silent
    // wake→first-event window. Cancel the P2 watchdog before applying
    // busy-state transitions; if the synthetic bubble already fired,
    // clear it unless a real runtime_state has already superseded it.
    this.clearWakeWatchdog(conversationId, agentId, 'replaced');
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
      case 'session_init':
        // B3 (Cindy `usjxj8AxX4AvJ5E-`): claude's `system.init` is the
        // proof that the runtime has parsed our first user message and
        // is actively consuming input. Pre-init wakes that landed in
        // `initPendingDeliveryIds` are now safe to ack.
        //
        // Idempotence: claude emits `system.init` at the start of every
        // turn. The first observation latches `initObserved` and
        // flushes the queue; subsequent observations find an empty
        // queue and are no-ops. We deliberately leave `initObserved`
        // sticky for the lifetime of this runtime (until
        // `runtime_exit` clears state.delete) so a later wake landing
        // before the NEXT turn's `system.init` doesn't get deferred.
        if (!st.initObserved) {
          st.initObserved = true;
          if (st.initPendingDeliveryIds.length > 0) {
            const ids = st.initPendingDeliveryIds.splice(0);
            this.inboxAck.markDelivered(ids);
            this.logger.info(
              {
                conversationId,
                agentId,
                deliveryIds: ids,
              },
              'deliver: session_init observed, flushing init-pending acks',
            );
          }
        }
        return;
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
    this.clearWakeWatchdog(
      conversationId,
      agentId,
      meta.initTimedOut
        ? 'timeout'
        : meta.fatalError
          ? 'crashed'
          : meta.intentional || meta.code === 0
            ? 'stopped'
            : 'crashed',
    );
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

  /**
   * Clear the live-wake stuck watchdog for a single runtime. Used by
   * EventHandler's init-timeout path and DaemonHost.clearSession. Does
   * NOT clear pending deliveries or busy state; use `clearRuntime` for
   * full session teardown.
   */
  clearWakeWatchdog(
    conversationId: string,
    agentId: string,
    reason: AgentRunTerminalReason = 'replaced',
  ): void {
    const st = this.state.get(key(conversationId, agentId));
    if (!st?.wakeWatchdog) return;
    const watchdog = st.wakeWatchdog;
    if (watchdog.timer) clearTimeout(watchdog.timer);
    st.wakeWatchdog = null;
    if (!watchdog.fired) return;
    this.publishSyntheticClear(conversationId, agentId, watchdog, reason);
  }

  /** Clear every coordinator-owned bit for a runtime. This is the
   * clearSession-side equivalent of `onRuntimeExit`: cancel the stuck
   * watchdog, remove busy/pending state, and leave DB inbox rows as
   * the durable source of truth. */
  clearRuntime(
    conversationId: string,
    agentId: string,
    reason: AgentRunTerminalReason = 'stopped',
  ): void {
    this.clearWakeWatchdog(conversationId, agentId, reason);
    this.state.delete(key(conversationId, agentId));
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
      st = {
        busy: makeBusy(),
        pending: [],
        flushing: false,
        initObserved: false,
        initPendingDeliveryIds: [],
        wakeWatchdog: null,
      };
      this.state.set(k, st);
    }
    return st;
  }

  private enqueue(st: PerAgentState, req: LiveDeliveryRequest): void {
    // Idempotent push — re-delivery of the same dedupKey at the same
    // boundary should not double-write.
    if (st.pending.some(item => item.dedupKey === req.dedupKey)) return;
    st.pending.push({
      deliveryIds: req.deliveryIds,
      deliveredUpToSeq: req.deliveredUpToSeq,
      dedupKey: req.dedupKey,
      text: req.text,
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
    const batch = st.pending.splice(0);
    try {
      let text: string;
      try {
        text = this.combineText(batch);
      } catch (err) {
        // No combineGated callback for a multi-text flush. Push the
        // rows back and rethrow — silent degradation is forbidden
        // (Cindy `rrF2L1RmWq5JFH3m` B3 / `0G5uJBydO_4qt_2r`;
        // `Mqf1h-FKudtEbH1O` combine-before-encode is preserved by the
        // coordinator combining text BEFORE shipping to daemon).
        st.pending.unshift(...batch);
        this.logger.error(
          {
            conversationId,
            agentId,
            batchSize: batch.length,
            err: (err as Error).message,
          },
          'deliver: flush combine refused; rows remain queued',
        );
        throw err;
      }
      const deliveryIds = batch.flatMap(item => [...item.deliveryIds]);
      const result = await this.bridge.runtimeWake({
        conversation_id: conversationId,
        agent_id: agentId,
        delivery_ids: deliveryIds,
        delivered_up_to_seq: maxDeliveredUpToSeq(batch),
        kind: 'message',
        text,
      });
      if (result.delivered) {
        this.startWakeWatchdog(conversationId, agentId, batch[0]!.driver);
        // B3: same gate as dispatchWake — defer ack for
        // requires_first_message + !initObserved. Flush only fires for
        // gated drivers (busyDeliveryMode === 'gated'), and `gated`
        // implies claude — so kickoffMode='requires_first_message' is
        // the common case. Re-check on `batch[0]` for symmetry; all
        // rows in a flushed batch share the same agent → same driver.
        const initGated =
          batch[0]!.driver.kickoffMode === 'requires_first_message' &&
          !st.initObserved;
        if (initGated) {
          st.initPendingDeliveryIds.push(...result.delivery_ids);
          this.logger.info(
            {
              conversationId,
              agentId,
              batchSize: batch.length,
              deliveryIds: result.delivery_ids,
            },
            'deliver: flushed batch, ack deferred until session_init (B3 gate)',
          );
        } else {
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
        }
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
      // Transport / internal_error path. Push the batch back so a
      // future safe boundary can retry — without this the in-memory
      // queue would silently leak (Cindy `rrF2L1RmWq5JFH3m` B4). DB
      // rows are still pending (no markDelivered ran) so a fresh
      // `start()` or `ready_for_drain` would also redeliver, but the
      // in-memory queue is the path that fires on the NEXT in-process
      // safe boundary — losing it would mean a transport blip turns a
      // mid-turn defer into "wait for the next runtime restart".
      //
      // Guard the unshift so the combine/encode branch (which already
      // unshifted before rethrowing) doesn't double-push.
      const k = key(conversationId, agentId);
      const stNow = this.state.get(k);
      if (
        stNow &&
        !stNow.pending.some(item => item.dedupKey === batch[0]?.dedupKey)
      ) {
        stNow.pending.unshift(...batch);
      }
      this.logger.error(
        {
          conversationId,
          agentId,
          batchSize: batch.length,
          err: (err as Error).message,
        },
        'deliver: flush threw; rows remain queued',
      );
    } finally {
      st.flushing = false;
    }
  }

  private async dispatchWake(
    conversationId: string,
    agentId: string,
    batch: LiveDeliveryRequest[],
  ): Promise<LiveDeliveryDecision> {
    const text = this.combineText(batch);
    const deliveryIds = batch.flatMap(item => [...item.deliveryIds]);
    let result: RuntimeWakeResult;
    try {
      result = await this.bridge.runtimeWake({
        conversation_id: conversationId,
        agent_id: agentId,
        delivery_ids: deliveryIds,
        delivered_up_to_seq: maxDeliveredUpToSeq(batch),
        kind: 'message',
        text,
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
      this.startWakeWatchdog(conversationId, agentId, batch[0]!.driver);
      // B3 (Cindy `usjxj8AxX4AvJ5E-`): for `requires_first_message`
      // drivers (claude), `delivered:true` from the daemon only proves
      // the bytes hit stdin — the child may still die before parsing
      // them. Defer the ack until the parsed `session_init` proves
      // consumption. Other kickoffMode='self_inits' drivers
      // (codex/cursor) prove init via daemon-side phase=ready before
      // any wake reaches them, so the ack on `delivered:true` is safe.
      const initGated =
        batch[0]!.driver.kickoffMode === 'requires_first_message' &&
        !this.ensureState(conversationId, agentId).initObserved;
      if (initGated) {
        const st = this.ensureState(conversationId, agentId);
        st.initPendingDeliveryIds.push(...result.delivery_ids);
        this.logger.info(
          {
            conversationId,
            agentId,
            deliveryIds: result.delivery_ids,
            batchSize: batch.length,
          },
          'deliver: wake dispatched, ack deferred until session_init (B3 gate)',
        );
      } else {
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
      }
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

  private startWakeWatchdog(
    conversationId: string,
    agentId: string,
    driver: DriverDeliveryView,
  ): void {
    if (this.wakeStuckMs <= 0) return;
    if (!this.callbacks.publishActivity) return;
    const base = this.cache.get(conversationId, agentId)?.runState;
    if (!base) {
      this.logger.info(
        { conversationId, agentId },
        'deliver: wake stuck watchdog skipped; no base runState',
      );
      return;
    }
    const st = this.ensureState(conversationId, agentId);
    // Reset to the latest delivered wake. If an older synthetic bubble
    // had already fired, explicitly tombstone it before starting the
    // next window; otherwise the stale "waiting" row can remain visible.
    this.clearWakeWatchdog(conversationId, agentId, 'replaced');
    const token = ++this.nextWakeWatchdogToken;
    const timer = setTimeout(() => {
      this.fireWakeWatchdog(conversationId, agentId, token, driver);
    }, this.wakeStuckMs);
    st.wakeWatchdog = {
      timer,
      token,
      baseRunId: base.runId,
      baseUpdatedAt: base.updatedAt,
      fired: false,
      syntheticState: null,
    };
  }

  private fireWakeWatchdog(
    conversationId: string,
    agentId: string,
    token: number,
    driver: DriverDeliveryView,
  ): void {
    const st = this.state.get(key(conversationId, agentId));
    const watchdog = st?.wakeWatchdog;
    if (!watchdog || watchdog.token !== token) return;
    watchdog.timer = null;
    const current = this.cache.get(conversationId, agentId)?.runState;
    if (!current || current.runId !== watchdog.baseRunId) {
      st.wakeWatchdog = null;
      return;
    }
    // A real runtime_state already arrived after the wake. The parsed
    // hook should normally have cancelled us first; this guard keeps
    // timer ordering from publishing a stale synthetic bubble.
    if (current.updatedAt > watchdog.baseUpdatedAt) {
      st.wakeWatchdog = null;
      return;
    }

    const now = this.now();
    const { terminalReason: _terminalReason, ...base } = current;
    const synthetic: AgentRunState = {
      ...base,
      status: 'thinking',
      activitySnippet: waitingSnippet(driver, this.wakeStuckMs),
      updatedAt: now,
      lastActivityAt: now,
    };
    watchdog.fired = true;
    watchdog.syntheticState = synthetic;
    this.callbacks.publishActivity?.(synthetic);
    this.logger.warn(
      {
        conversationId,
        agentId,
        runId: synthetic.runId,
        thresholdMs: this.wakeStuckMs,
      },
      'deliver: wake accepted but no parsed event observed before watchdog threshold',
    );
  }

  private publishSyntheticClear(
    conversationId: string,
    agentId: string,
    watchdog: WakeWatchdogState,
    reason: AgentRunTerminalReason,
  ): void {
    const current = this.cache.get(conversationId, agentId)?.runState;
    // If the daemon has already sent a newer real state for the same
    // run, that real state has either replaced the synthetic bubble or
    // will be the source of truth for the renderer. Do not tombstone it.
    if (current && current.runId === watchdog.baseRunId && current.updatedAt > watchdog.baseUpdatedAt) {
      return;
    }
    const source = watchdog.syntheticState ?? current;
    if (!source || source.runId !== watchdog.baseRunId) return;
    const now = this.now();
    const { activitySnippet: _activitySnippet, ...base } = source;
    const terminal: AgentRunState = {
      ...base,
      status: terminalStatusForReason(reason),
      terminalReason: reason,
      updatedAt: now,
      lastActivityAt: now,
      compacting: false,
      compactingSince: undefined,
      compactionStale: false,
    };
    this.callbacks.publishActivity?.(terminal);
  }

  /**
   * Combine un-encoded message texts BEFORE the daemon encodes (Cindy
   * `Mqf1h-FKudtEbH1O` + Option A v2 `UMGu36zoTDVuKWXi`: combine BEFORE
   * encode is preserved by the coordinator never encoding at all —
   * combination happens here on text, the daemon's in-process driver
   * instance encodes once after receiving the combined text). Feeding
   * encoded JSON lines through `combineGated` would yield a payload
   * that is not a valid driver stdin line — claude's
   * `--input-format stream-json` parses it as malformed.
   *
   * Single-request batches return the text verbatim; multi-request
   * batches combine via `combineGated` (DaemonHost wires this to
   * `combineGatedBatch`).
   *
   * Throws if:
   *   - batch is empty;
   *   - multi-text batch was submitted without a `combineGated`
   *     callback wired on the coordinator.
   *
   * The "encode returned null" failure mode no longer exists at this
   * layer — the daemon's `runtimeWake` decides between `driver_not_ready`
   * (recoverable; row stays pending) and `driver_refused` (driver bug;
   * fail loudly). Both arms keep the inbox row pending.
   */
  private combineText(batch: readonly { text: string }[]): string {
    if (batch.length === 0) {
      throw new Error('combineText: empty batch');
    }
    if (batch.length === 1) {
      return batch[0]!.text;
    }
    if (!this.callbacks.combineGated) {
      throw new Error(
        'RuntimeDeliveryCoordinator: combineGated callback is required ' +
          'for multi-text batches (received ' +
          batch.length +
          ' texts). Silent join-fallback is forbidden — DaemonHost ' +
          'must provide a CM-equivalent combineGatedBatch formatter ' +
          'when wiring the coordinator.',
      );
    }
    return this.callbacks.combineGated(batch.map(item => item.text));
  }
}

function maxDeliveredUpToSeq(
  batch: ReadonlyArray<{ deliveredUpToSeq?: number }>,
): number | undefined {
  let max = 0;
  for (const item of batch) {
    const value = item.deliveredUpToSeq ?? 0;
    if (value > max) max = value;
  }
  return max > 0 ? max : undefined;
}

function waitingSnippet(driver: DriverDeliveryView, thresholdMs: number): string {
  const seconds = Math.max(1, Math.round(thresholdMs / 1000));
  const runtime = driver.runtime ?? (driver.busyDeliveryMode === 'gated' ? 'claude' : 'runtime');
  return `Waiting for ${runtime} response (${seconds}s+)`;
}

function terminalStatusForReason(reason: AgentRunTerminalReason): AgentRunStatus {
  return reason === 'replied' || reason === 'turn_ended' || reason === 'replaced' ? 'idle' : 'failed';
}
