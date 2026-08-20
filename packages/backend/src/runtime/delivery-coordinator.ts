/**
 * `RuntimeDeliveryCoordinator` — backend's live-delivery decision module
 * for daemon-mode runtime.
 *
 * ## Why this exists as its own module
 *
 * Cindy `SG1-ZTOUKLvs1A6G` rejected my first sub-2b plan that piled
 * busy-tracking + pending queue + delivery dispatch into `RuntimeEventHandler`
 * (would have made it a mini-CM). The four-module split for daemon-mode
 * runtime is:
 *
 *   - `RuntimeBridge`      — command side (typed proxy over `runtimeDeliver`,
 *                            `runtimeStart`, …; no state)
 *   - `RuntimeEventHandler`— event fan-out (subscribes to daemon events,
 *                            updates cache + SSE; narrow callbacks for
 *                            anything beyond the projection — does NOT
 *                            hold queues or issue deliveries)
 *   - `RunStateCache`      — passive projection of daemon-reported state
 *   - **THIS FILE**         — delivery decisions: when to call
 *                            `bridge.runtimeDeliver`, when to queue, when to
 *                            mark inbox rows delivered, when to ask
 *                            DaemonHost to respawn a dead oneShot
 *
 * Putting the deliver / mark / queue / respawn logic here keeps each of the
 * other three modules unaware of inbox state and driver policy. Tests
 * here run against a mock bridge + mock inbox sink without any DB.
 *
 * ## What the coordinator owns
 *
 *   1. **Delivery dispatch** via `bridge.runtimeDeliver` (#task:1417
 *      Stage 2b — the SOLE message delivery command). The sync result is
 *      a custody DISPOSITION (`spawning`/`admitted`/`deferred`/`refused`)
 *      that carries NO ack: the coordinator NEVER moves `delivered_at`.
 *      `dispatched` (spawning/admitted/deferred) transfers custody to the
 *      daemon and rows stay in-flight until the async
 *      `runtime_delivery_consumed` lands (event-handler acks); `refused` /
 *      oneShot-live roll back to pending.
 *
 *   2. **oneShot auto-respawn** on `runtime_exit`. Gated by the trio
 *      Cindy `BYHZJI9ALSVmmlFr` pin c: `intentional === false` AND
 *      exit was not init_timeout / fatal AND `hasPendingInbox` is true.
 *      Respawn goes through the fanout's `deliverPending` callback (a
 *      spawn-with-batch `runtime_deliver`), NEVER a bare lifecycle start —
 *      the fresh runtime must drain the pending inbox in its init phase.
 *
 *   3. **P2 live-delivery stuck watchdog.** After an immediate write
 *      (`admitted`/`spawning`), if no parsed event arrives within the
 *      threshold, publish a synthetic `thinking` run state so the UI does
 *      not look idle. This is projection, not delivery scheduling.
 *
 * ## Retired here (#task:1417 Stage 3, §11.8/§11.9)
 *
 *   - The **busy tracker** and the **mid-turn pending-delivery queue**
 *     moved INTO the daemon, which owns the runtime handle and already
 *     tracks `handle.busy` byte-for-byte. The coordinator no longer gates
 *     on a safe boundary or holds a volatile queue: every submit dispatches
 *     `runtime_deliver` unconditionally and the daemon answers `deferred`
 *     when it enqueues mid-turn. This removes the second queue Cindy's
 *     Stage 3 gate 6 forbids.
 *   - **Gated-batch combining** moved with the queue (`combineGatedBatch`
 *     now lives in the host's `combineDeferredBatch`). Backend submit paths
 *     pre-combine claimed rows into ONE `text`, so the coordinator ships a
 *     single text and never combines.
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
 *   - General SSE / DB writes. EventHandler owns daemon-projected SSE and
 *     the sole inbox ack (`runtime_delivery_consumed` → `markDelivered`);
 *     clearSession-style DB writes live in `AgentService`. The
 *     coordinator touches NO inbox state — it only publishes the P2
 *     synthetic stuck indicator via an injected `publishActivity`
 *     callback.
 *
 * ## Test scope (Cindy `3l4bZ5vaMvlC9DVS`)
 *
 * Tests in `delivery-coordinator.test.ts` cover the delivery matrix with a
 * mock `runtimeDeliver` bridge + synthetic ParsedEvents. No fanout
 * integration here — the fanout owns fs guards, spawn_options, and inbox
 * custody rollback.
 */
import type {
  RuntimeDeliverResult,
  RuntimeDeliverRefusedReason,
} from '@silverhand/host';
import type {
  AgentRunState,
  AgentRunStatus,
  AgentRunTerminalReason,
  ParsedEvent,
} from '@silverhand/shared';
import type { RuntimeSessionClearReceipt } from './persistence-ports.js';
import type { RuntimePhase } from './run-state-cache.js';
import type {
  RuntimeCustody,
  RuntimePrincipalScope,
} from '../auth/runtime-principal.js';

/**
 * Capability snapshot a driver exposes to the coordinator. We do NOT
 * import the full `Driver` interface here — the coordinator only needs
 * these fields, and narrowing the type makes the test seam smaller.
 *
 * Source: `Driver.releaseProfile` + `Driver.oneShot` + `Driver.kickoffMode`
 * from `@silverhand/host/drivers`.
 */
export interface DriverDeliveryView {
  /** Runtime label used only for user-visible stuck-watchdog copy.
   *  Optional so tests can keep small fixtures; boundary-releasing
   *  profiles default to `claude`, immediate ones to `runtime`. */
  runtime?: string;
  /** Release profile (docs/runtime-input-design.md §3.2). The
   *  coordinator only uses it for the cosmetic watchdog label
   *  fallback; release scheduling is daemon-owned. */
  releaseProfile:
    | 'native-steer'
    | 'tool-boundary-steer'
    | 'next-turn-batch'
    | 'prompt-boundary'
    | 'one-shot';
  /** True if the runtime exits after a single turn (cursor). */
  oneShot: boolean;
  /** `requires_first_message` (claude — `system.init` only fires once
   *  the runtime has received its first user message; B3 gate defers
   *  inbox `markDelivered` until that parsed `session_init` is observed)
   *  or `self_inits` (codex / cursor — daemon-side init proves the
   *  runtime is alive before backend issues any delivery; ack on
   *  `{delivered:true}` is safe). */
  kickoffMode: 'self_inits' | 'requires_first_message';
}

/**
 * A live-delivery request. DaemonHost builds these after
 * `inboxes.ensureDelivery`. The coordinator decides whether to
 * `deliver`, queue, or refuse.
 *
 * # Daemon owns encode (Option A v2 — Cindy `UMGu36zoTDVuKWXi`)
 *
 * `text` is the UN-ENCODED human-readable message body (from
 * `formatInboxBatch`). The daemon's in-process
 * driver instance — whose runtime state (codex `threadId` etc.) is
 * authoritative — encodes via `encodeStdinMessage(text, cliSessionId)`
 * just before writing to stdin. Backend MUST NOT pre-encode: doing so
 * would spin up a STATELESS driver instance whose `encodeStdinMessage`
 * returns null for codex (no `threadId` yet), silently killing every
 * delivery. This was the codex daemon-mode delivery blocker (see commit
 * 2b-iii log).
 *
 * # Combine-before-encode invariant (still holds; combine now daemon-side)
 *
 * Combination still happens BEFORE encode. #task:1417 Stage 3 moved the
 * combining itself into the daemon (`combineDeferredBatch` folds a deferred
 * batch, calling `combineGatedBatch` for gated multi-entry batches). The
 * backend submit paths pre-combine their claimed rows into ONE `text`, so
 * a `LiveDeliveryRequest` batch reaching the coordinator carries exactly
 * one request; the coordinator ships that single un-encoded text and the
 * daemon encodes once. Feeding encoded JSON lines through the combiner
 * would produce a payload that is not a legal driver stdin line (claude's
 * `--input-format stream-json` would see malformed input) — which is why
 * combine stays on un-encoded text on the daemon side.
 *
 * # Atomic delivery groups (`deliveryIds`)
 *
 * Most requests cover a single inbox row → `deliveryIds = [inboxId]`.
 * For caller pre-combined groups (e.g. `DaemonHost.drainPending` using
 * `formatInboxBatch`) `text` is already the combined text and
 * `deliveryIds` carries every inbox row the combined text covers.
 * Coordinator treats them as one atomic ack group.
 */
/** Per-delivery wire metadata carried alongside a delivery / startup batch.
 *  One entry per delivered inbox row, and its three fields are exactly the
 *  daemon's three readers: per-delivery dedup (`delivery_id`) plus
 *  novel-remainder presentation rebuild (`presentation`, `seq`).
 *
 *  #task:2097 net-dropped `message_id` / `thread_root_id` / `delivery_kind`:
 *  they fed the daemon's per-stream observed boundary (§6.4), which #task:2095
 *  deleted, and nothing on the host side read them afterwards. The facts
 *  themselves did not move here — the reply-cluster coordinate travels in the
 *  stdin header's absolute `target` (`RuntimeInboxMessage.thread_root_id`) and
 *  the turn/observe decision is made backend-side off
 *  `conversation_inboxes.delivery_kind` before a batch is assembled. */
export interface RuntimeDelivery {
  delivery_id: number;
  seq: number;
  /** Presentation fragment used to rebuild only a novel retry remainder. */
  presentation: import('@silverhand/shared').RuntimeDeliveryPresentation;
}

export interface LiveDeliveryRequest {
  /** Atomic group of inbox row ids this single `text` covers. Singleton
   *  for live deliverMessage; multi when the caller pre-combined. All
   *  ids in the group are acked together (or stashed together for the
   *  B3 init gate). */
  deliveryIds: readonly number[];
  /** Per-delivery metadata (see `RuntimeDelivery`). Its live readers are the
   *  daemon's per-delivery dedup and novel-remainder presentation rebuild;
   *  the `delivered_up_to_seq` sidecar is derived from the max `seq` here
   *  (#task:2106 removed the wire scalar, so this array is its sole source).
   *  Required: every production and test path populates it. */
  deliveries: readonly RuntimeDelivery[];
  /** Stable dedup key. For singleton groups, the row's message id; for
   *  pre-combined groups, an arbitrary key the caller picks (typically
   *  the first row's message id). Carried on the request for parity with
   *  the daemon-side dedup, which now owns mid-turn de-duplication. */
  dedupKey: string;
  /** Un-encoded human-readable text. The daemon encodes once (and combines
   *  deferred entries) — the coordinator ships this verbatim. */
  text: string;
  driver: DriverDeliveryView;
}

/**
 * Outcome of a `submitLiveDelivery` call. Returned so the fanout can
 * decide inbox custody; the coordinator has already dispatched as needed.
 *
 * #task:1417 custody contract — the fanout rolls the batch back to pending
 * ONLY on `refused` (and on a thrown dispatch). `dispatched` KEEPS the rows
 * in-flight (owner=connection): custody is with the daemon (ack awaits the
 * async `runtime_delivery_consumed`), whether the daemon wrote now
 * (`admitted`/`spawning`) or holds the batch in its own mid-turn queue
 * (`deferred`). A disconnect rolls in-flight rows back via
 * `rollbackInFlightForOwner` (paired with the daemon's owner-scoped
 * `cleanupDeferredForOwner`).
 *
 * The coordinator no longer short-circuits oneShot (`releaseProfile
 * === 'none'`) locally: after Stage 2b removed the cache lifecycle
 * projection the coordinator has NO live proof, so a oneShot batch is
 * dispatched like any non-gated driver and the daemon decides —
 * spawn-with-batch when there is no live handle, sync `refused` when a
 * live oneShot handle can't take stdin. The retired `noop_oneshot_live`
 * decision (a coordinator-local guess with no live proof) would have
 * made a no-live oneShot never spawn.
 *
 *   - `dispatched`          — daemon accepted custody (`spawning`,
 *                             `admitted`, or `deferred`). Rows stay
 *                             in-flight; ack is the async
 *                             `runtime_delivery_consumed`.
 *   - `refused`             — daemon took nothing (`startup_pending` /
 *                             `draining` / `cooldown`, incl. a live
 *                             oneShot that can't take stdin). Roll back
 *                             to pending (retriable); a oneShot drains
 *                             on its next respawn-with-batch.
 *
 * #task:1417 Stage 3 — the retired `queued_mid_turn` decision (and the
 * whole coordinator-side busy tracker / pending queue / flush) moved to
 * the daemon (§11.8/§11.9). Every submit now dispatches unconditionally;
 * the daemon returns `deferred` when it enqueues the batch in its OWN
 * per-handle mid-turn queue. `deferred` is a custody transfer exactly like
 * `admitted`/`spawning`, so from the fanout's custody view it collapses to
 * `dispatched`.
 */
export type LiveDeliveryDecision =
  | { kind: 'dispatched'; deliveryIds: readonly number[] }
  | { kind: 'refused'; reason: RuntimeDeliverRefusedReason };

/**
 * Metadata accompanying the `onRuntimeExit` callback. EventHandler
 * derives `initTimedOut` from observing prior
 * `runtime_init_timeout` / `runtime_init_cooldown` events for the same
 * (conv, agent); derives `fatalError` from prior parsed `error` events
 * with `fatal: true`. Coordinator uses these to gate the oneShot
 * auto-respawn (Cindy `BYHZJI9ALSVmmlFr` pin a).
 */
export interface RuntimeExitMeta {
  /** Exact event custody derived from generation + attached daemon. Missing
   * only for legacy/invalid frames, which must never settle a clear waiter. */
  custody?: RuntimeCustody;
  /** True only when the DB accepted this exit as the current generation. */
  projectionFinalized?: boolean;
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
 * an `{ runtimeDeliver: vi.fn() }` literal without instantiating the
 * fanout.
 *
 * `text` is the unencoded message text the daemon will hand to its
 * in-process driver's `encodeStdinMessage(text, cliSessionId)` (Option
 * A v2 — Cindy `UMGu36zoTDVuKWXi`). Backend NEVER pre-encodes.
 *
 * #task:1417 Stage 2b — this is `runtime_deliver`, the SOLE message
 * delivery command. `spawn_options` is NOT part of this signature: the
 * fanout's bridge closure injects it (it needs conversation/workspace
 * lookups) and runs the fs guards (host-consistency + pre-spawn L2
 * seed) before dispatch, because the daemon owns the spawn-vs-admit
 * decision and any deliver may spawn. The sync result is a custody
 * DISPOSITION (`spawning`/`admitted`/`refused`) that carries NO ack —
 * `delivered_at` moves ONLY on the async `runtime_delivery_consumed`
 * event.
 */
export interface CoordinatorBridge {
  runtimeDeliver(params: {
    conversation_id: string;
    agent_id: string;
    delivery_ids: number[];
    deliveries: RuntimeDelivery[];
    kind: 'message' | 'schedule_fire';
    text: string;
  }): Promise<RuntimeDeliverResult>;
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
  /** Optional backend-side `agent_activity` publisher. Used only for
   *  the P2 live-delivery stuck indicator: after daemon accepted a live
   *  delivery, if no parsed event arrives within the threshold, publish a
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
  callbacks?: CoordinatorCallbacks;
  logger?: CoordinatorLogger;
  /** Delivery→first-parsed watchdog threshold. Defaults to 30s, per P2
   *  review. Set <=0 to disable in tests. */
  deliveryWatchdogMs?: number;
  /** Test seam for deterministic timestamps. Production uses Date.now. */
  now?: () => number;
}

interface PerAgentState {
  conversationId: string;
  agentId: string;
  /**
   * #task:1417 Stage 3 — the coordinator no longer holds a busy tracker
   * or pending queue. Mid-turn deferral moved into the daemon
   * (§11.8/§11.9), so the ONLY per-agent state left here is the P2
   * live-delivery stuck watchdog (a projection concern, not delivery
   * scheduling).
   */
  deliveryWatchdog: DeliveryWatchdogState | null;
}

interface DeliveryWatchdogState {
  timer: ReturnType<typeof setTimeout> | null;
  token: number;
  baseRunId: string;
  baseUpdatedAt: number;
  fired: boolean;
  syntheticState: AgentRunState | null;
}

// UI placeholder watchdog: how long to wait for the first parsed event
// after admission before publishing a synthetic "thinking" bubble. This is
// an observation/UX aid, not a delivery-correctness signal — a slow first
// token (large prompt, cold start, model queue) can trip it while delivery
// is perfectly healthy. Kept generous so it rarely fires on legitimate
// slow starts; the fire is logged at info, not warn.
const DEFAULT_DELIVERY_WATCHDOG_MS = 45_000;

function key(conversationId: string, agentId: string): string {
  return `${conversationId}|${agentId}`;
}

export class RuntimeDeliveryCoordinator {
  private readonly bridge: CoordinatorBridge;
  private readonly cache: CoordinatorCacheView;
  private readonly callbacks: CoordinatorCallbacks;
  private readonly logger: CoordinatorLogger;
  private readonly deliveryWatchdogMs: number;
  private readonly now: () => number;
  private readonly state = new Map<string, PerAgentState>();
  private nextDeliveryWatchdogToken = 0;

  constructor(deps: RuntimeDeliveryCoordinatorDeps) {
    this.bridge = deps.bridge;
    this.cache = deps.cache;
    this.callbacks = deps.callbacks ?? {};
    this.logger = deps.logger ?? NOOP_LOGGER;
    this.deliveryWatchdogMs = deps.deliveryWatchdogMs ?? DEFAULT_DELIVERY_WATCHDOG_MS;
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
   * Batch sibling of `submitLiveDelivery`. Callers pre-combine their
   * claimed inbox rows into ONE request (`formatInboxBatch`) with a multi
   * `deliveryIds` group; the coordinator dispatches once and the daemon
   * acks all ids atomically via the async `runtime_delivery_consumed`.
   * (#task:1417 Stage 3 retired the internal mid-turn gated flush that used
   * to submit its own multi-request batch — the daemon owns that queue and
   * its combining now.)
   *
   * Ack contract — all-or-nothing across the batch:
   *   - custody transfer (`dispatched`, i.e. admitted/spawning/deferred) →
   *     rows stay in-flight; `delivered_at` moves once, for EVERY id, only
   *     when the daemon emits `runtime_delivery_consumed`;
   *   - `refused` or a thrown dispatch → NO ids are acked; every row stays
   *     pending so the next ready_for_drain (or live arrival) replays the
   *     whole batch.
   *
   * Per-row `deliverMessage` looping would change the agent's visible
   * turn boundary (one delivery per row → claude treats each as its own
   * user turn) and would degrade batch ack into partial-success — both
   * forbidden by Cindy's contract.
   *
   * Invariants the caller must uphold:
   *   1. All requests share the same (conv, agent) → same driver +
   *      same daemon-owned driver state.
   *   2. The batch is non-empty. Empty batches throw — callers should
   *      no-op upstream when their listPending returned nothing.
   *   3. Each `req` already passed `inboxes.ensureDelivery` (so every
   *      `inboxId` in `deliveryIds` is a fresh, not-yet-delivered row).
   *   4. The batch carries exactly one request (callers pre-combine). A
   *      multi-request batch throws in `combineText` — combining moved to
   *      the daemon.
   *
   * Decision semantics for the batch return value:
   *   - `dispatched` carries every `deliveryIds` from the single dispatch;
   *   - `refused` applies to the batch uniformly.
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

    // #task:1417 Stage 3 — NO cache read AND no busy check for the delivery
    // decision. Every submit dispatches `runtime_deliver` unconditionally;
    // the daemon owns spawn-vs-admit-vs-defer-vs-refuse:
    //   - spawns when there is no live handle (batch = startup delivery);
    //   - admits when the handle is ready and can take the write now;
    //   - `deferred` when a `gated` handle is mid-turn OR a prior write is
    //     still in flight — the daemon enqueues in its OWN per-handle
    //     mid-turn queue and flushes at the next safe boundary;
    //   - refuses while initializing / draining / cooldown (or a live
    //     oneShot that can't take stdin).
    // The coordinator-side busy tracker + volatile pending queue are gone
    // (§11.8): the daemon holds the only mid-turn queue, so there is no
    // second queue here and no gated fork. `deferred` collapses to
    // `dispatched` for the fanout's custody view (rows stay in-flight).
    return this.dispatchDeliver(conversationId, agentId, [...batch]);
  }

  /**
   * Replay DB-owned inbox rows after daemon emitted `runtime_ready_for_drain`.
   * This path intentionally bypasses the coordinator's process-local gated
   * pending queue: the durable DB claim already owns ordering/idempotency, and
   * ready_for_drain is the daemon's explicit signal that a delivery may be sent.
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
    // #task:1417 Stage 2b — no cache read. This path is entered from the
    // daemon's own `runtime_ready_for_drain` (or a reattach re-drive of a
    // hydrated-live runtime), so the handle is drainable; `runtime_deliver`
    // admits it, or refuses if the daemon has since moved on (rows roll
    // back to pending, retriable). oneShot is not special-cased here either:
    // a oneShot has no live stdin, so the daemon sync-refuses and the rows
    // roll back for the next respawn-with-batch.
    return this.dispatchDeliver(conversationId, agentId, [...batch]);
  }

  /**
   * Parsed-event hook called by EventHandler on every
   * `runtime_parsed_event`. #task:1417 Stage 3 — the busy tracker and
   * safe-boundary flush moved to the daemon (§11.8), so this hook's ONLY
   * remaining job is to cancel the P2 live-delivery stuck watchdog: any parsed
   * signal proves the child moved past the silent delivery→first-event window.
   *
   * `ev` is unused for delivery now, but the hook stays wired (and keeps
   * receiving the RAW `ParsedEvent`) so the watchdog clears on the very
   * first sign of life.
   */
  onParsedEvent(
    conversationId: string,
    agentId: string,
    _ev: ParsedEvent,
  ): void {
    // Any parsed signal means the child has moved past the silent
    // delivery→first-event window. If the synthetic bubble already fired,
    // clear it unless a real runtime_state has already superseded it.
    this.clearDeliveryWatchdog(conversationId, agentId, 'replaced');
  }

  /**
   * Runtime-exit hook called by EventHandler. Drops per-agent
   * state and, when the oneShot trio is satisfied, asks DaemonHost to
   * respawn.
   *
   * Pin c gate: `intentional === false` AND NOT init-timeout AND NOT
   * fatal AND pending inbox exists. Direct delivery is NEVER used here —
   * the only correct path for oneShot redelivery is `start()` +
   * startup_delivery, because the new daemon-side runtime drains the
   * inbox in its init phase.
   */
  onRuntimeExit(
    conversationId: string,
    agentId: string,
    meta: RuntimeExitMeta,
  ): void {
    this.clearDeliveryWatchdog(
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
    // #task:1417 Stage 3 — the coordinator no longer holds a volatile
    // queue, so there is nothing to roll back here. Mid-turn deferred rows
    // now live in the DAEMON's per-handle queue; on child exit the daemon
    // emits `runtime_delivery_failed{child_exit}` for each queued entry and
    // the backend's failed-delivery handler returns those rows to pending
    // (the same path any `runtime_delivery_failed` takes). We only drop the
    // coordinator's own per-agent state (the P2 watchdog bookkeeping).
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
   * Clear the live-delivery stuck watchdog for a single runtime. Used by
   * EventHandler's init-timeout path and DaemonHost.clearSession. Does
   * NOT tear down the full per-agent state; use `clearRuntime` for full
   * session teardown.
   */
  clearDeliveryWatchdog(
    conversationId: string,
    agentId: string,
    reason: AgentRunTerminalReason = 'replaced',
  ): void {
    const st = this.state.get(key(conversationId, agentId));
    if (!st?.deliveryWatchdog) return;
    const watchdog = st.deliveryWatchdog;
    if (watchdog.timer) clearTimeout(watchdog.timer);
    st.deliveryWatchdog = null;
    if (!watchdog.fired) return;
    this.publishSyntheticClear(conversationId, agentId, watchdog, reason);
  }

  /** Clear every coordinator-owned bit for a runtime. This is the
   * clearSession-side equivalent of `onRuntimeExit`: cancel the stuck
   * watchdog and drop the per-agent state, leaving DB inbox rows as the
   * durable source of truth. #task:1417 Stage 3 — no volatile queue lives
   * here anymore, so there is nothing to roll back (the daemon owns the
   * mid-turn queue and fails its entries on exit / discards them on
   * disconnect via owner-scoped cleanup). */
  clearRuntime(
    scope: RuntimePrincipalScope,
    reason: AgentRunTerminalReason = 'stopped',
  ): void {
    if (scope.kind === 'conversation') {
      this.clearDeliveryWatchdog(scope.conversationId, scope.agentId, reason);
      this.state.delete(key(scope.conversationId, scope.agentId));
      return;
    }
    // AgentSlot owns one runtime across many origin conversations. The
    // watchdog projection remains per origin so A/B freshness cannot collide,
    // but lifecycle teardown must clear every origin owned by the aggregate.
    for (const [stateKey, state] of [...this.state.entries()]) {
      if (state.agentId !== scope.agentId) continue;
      this.clearDeliveryWatchdog(state.conversationId, state.agentId, reason);
      this.state.delete(stateKey);
    }
  }

  /**
   * Settle a user clear only from the receipt minted by the persistence
   * generation CAS. The earlier daemon-bound dispatch operation is not accepted
   * here: daemon identity gates the waiter, while this cleanup is authorized by
   * the durable generation result after v77 forbids daemon rebinding inside a
   * generation. An old N clear that loses its CAS cannot obtain this receipt.
   */
  settleClear(receipt: RuntimeSessionClearReceipt): void {
    this.logger.info(
      {
        runtimeScope: receipt.scope,
        settledGeneration: receipt.generation,
      },
      'clear-session: settling coordinator state from persistence receipt',
    );
    this.clearRuntime(receipt.scope, 'stopped');
  }

  // ── test inspection ──────────────────────────────────────────────

  /** Read-only view of the pending queue. Test-only convenience. */
  // ── internals ────────────────────────────────────────────────────

  private ensureState(conversationId: string, agentId: string): PerAgentState {
    const k = key(conversationId, agentId);
    let st = this.state.get(k);
    if (!st) {
      st = { conversationId, agentId, deliveryWatchdog: null };
      this.state.set(k, st);
    }
    return st;
  }

  private async dispatchDeliver(
    conversationId: string,
    agentId: string,
    batch: LiveDeliveryRequest[],
  ): Promise<LiveDeliveryDecision> {
    const text = this.combineText(batch);
    const deliveryIds = batch.flatMap(item => [...item.deliveryIds]);
    // Flatten the per-delivery entries across the (possibly pre-combined)
    // batch. They carry the daemon's dedup key and presentation fragments —
    // there is no observed/per-stream axis for them to advance (#task:2095
    // deleted it; #task:2097 deleted the fields that described it). Kept
    // consistent with `deliveryIds` — the daemon hard-rejects a deliver whose
    // id sets disagree.
    const deliveries = batch.flatMap(item => [...item.deliveries]);
    let result: RuntimeDeliverResult;
    try {
      result = await this.bridge.runtimeDeliver({
        conversation_id: conversationId,
        agent_id: agentId,
        delivery_ids: deliveryIds,
        deliveries,
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
        'deliver: runtimeDeliver threw; row stays pending',
      );
      // Transport / fs-guard / internal_error fail loudly. Don't pretend
      // delivered, don't mutate inbox. Re-throw so the fanout rolls the
      // in-flight rows back to pending.
      throw err;
    }
    if (
      result.disposition === 'spawning' ||
      result.disposition === 'admitted'
    ) {
      // #task:1417 Stage 2b — the daemon accepted custody (spawned with
      // this batch, or wrote it to a ready handle). NO ack here: the sync
      // disposition transfers ownership only; `delivered_at` moves solely
      // on the async `runtime_delivery_consumed`. Rows stay in-flight
      // (owner=conn) until then; a `runtime_delivery_failed` or a
      // disconnect rolls them back.
      //
      // `spawning`/`admitted` mean the write happened NOW (or will on
      // spawn), so arming the delivery watchdog is honest — a stuck child that
      // produces no parsed event within the threshold gets the synthetic
      // "waiting" bubble.
      this.startDeliveryWatchdog(conversationId, agentId, batch[0]!.driver);
      this.logger.info(
        {
          conversationId,
          agentId,
          deliveryIds,
          batchSize: batch.length,
          disposition: result.disposition,
        },
        'deliver: dispatched via runtime_deliver; custody transferred, ack awaits consumed',
      );
      return { kind: 'dispatched', deliveryIds };
    }
    if (result.disposition === 'deferred') {
      // #task:1417 Stage 3 — the daemon holds a ready handle but could not
      // take the write right now (mid-turn `gated`, or a prior write still
      // in flight). It enqueued the batch in its OWN per-handle mid-turn
      // queue and will flush at the next safe boundary. Custody transferred
      // to the daemon exactly like `admitted` (rows stay in-flight; ack
      // awaits the async `runtime_delivery_consumed`; a
      // `runtime_delivery_failed{child_exit}` on exit, or the daemon's
      // owner-scoped cleanup on disconnect, rolls them back).
      //
      // We deliberately do NOT arm the delivery watchdog here: the stdin write
      // is deferred to the daemon's flush, which the backend cannot time,
      // so a watchdog armed now would fire spuriously during a legitimate
      // long turn. Stuck-turn observability for deferred writes belongs to
      // the daemon-side #1416(b) work, not this backend heuristic.
      this.logger.info(
        {
          conversationId,
          agentId,
          deliveryIds,
          batchSize: batch.length,
          disposition: result.disposition,
        },
        'deliver: deferred by daemon mid-turn queue; custody transferred, ack awaits consumed',
      );
      return { kind: 'dispatched', deliveryIds };
    }
    this.logger.warn(
      {
        conversationId,
        agentId,
        reason: result.reason,
        deliveryIds,
      },
      'deliver: runtime_deliver refused, row rolls back to pending',
    );
    return { kind: 'refused', reason: result.reason };
  }

  private startDeliveryWatchdog(
    conversationId: string,
    agentId: string,
    driver: DriverDeliveryView,
  ): void {
    if (this.deliveryWatchdogMs <= 0) return;
    if (!this.callbacks.publishActivity) return;
    const base = this.cache.get(conversationId, agentId)?.runState;
    if (!base) {
      this.logger.info(
        { conversationId, agentId },
        'deliver: delivery stuck watchdog skipped; no base runState',
      );
      return;
    }
    const st = this.ensureState(conversationId, agentId);
    // Reset to the latest delivery. If an older synthetic bubble
    // had already fired, explicitly tombstone it before starting the
    // next window; otherwise the stale "waiting" row can remain visible.
    this.clearDeliveryWatchdog(conversationId, agentId, 'replaced');
    const token = ++this.nextDeliveryWatchdogToken;
    const timer = setTimeout(() => {
      this.fireDeliveryWatchdog(conversationId, agentId, token, driver);
    }, this.deliveryWatchdogMs);
    st.deliveryWatchdog = {
      timer,
      token,
      baseRunId: base.runId,
      baseUpdatedAt: base.updatedAt,
      fired: false,
      syntheticState: null,
    };
  }

  private fireDeliveryWatchdog(
    conversationId: string,
    agentId: string,
    token: number,
    driver: DriverDeliveryView,
  ): void {
    const st = this.state.get(key(conversationId, agentId));
    const watchdog = st?.deliveryWatchdog;
    if (!watchdog || watchdog.token !== token) return;
    watchdog.timer = null;
    const current = this.cache.get(conversationId, agentId)?.runState;
    if (!current || current.runId !== watchdog.baseRunId) {
      st.deliveryWatchdog = null;
      return;
    }
    // A real runtime_state already arrived after the delivery. The parsed
    // hook should normally have cancelled us first; this guard keeps
    // timer ordering from publishing a stale synthetic bubble.
    if (current.updatedAt > watchdog.baseUpdatedAt) {
      st.deliveryWatchdog = null;
      return;
    }

    const now = this.now();
    const { terminalReason: _terminalReason, ...base } = current;
    const synthetic: AgentRunState = {
      ...base,
      status: 'thinking',
      activitySnippet: waitingSnippet(driver, this.deliveryWatchdogMs),
      updatedAt: now,
      lastActivityAt: now,
    };
    watchdog.fired = true;
    watchdog.syntheticState = synthetic;
    this.callbacks.publishActivity?.(synthetic);
    this.logger.info(
      {
        conversationId,
        agentId,
        runId: synthetic.runId,
        thresholdMs: this.deliveryWatchdogMs,
      },
      'deliver: first parsed event not observed before UI placeholder watchdog threshold',
    );
  }

  private publishSyntheticClear(
    conversationId: string,
    agentId: string,
    watchdog: DeliveryWatchdogState,
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
    const {
      activitySnippet: _activitySnippet,
      activitySnippetKind: _activitySnippetKind,
      ...base
    } = source;
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
   * Resolve the single un-encoded text a submit ships to the daemon.
   *
   * #task:1417 Stage 3 — gated-batch COMBINING moved to the daemon
   * (`combineDeferredBatch` → `combineGatedBatch`, §11.9): the daemon owns
   * the mid-turn queue, so it is the only place multiple messages pile up
   * and need combining. Every backend submit path (`deliverMessage`,
   * `drainPending`, `ready_for_drain`) claims its rows and PRE-COMBINES
   * them into ONE `text` via `formatInboxBatch` before calling the
   * coordinator, so a submitted batch always carries exactly one request.
   *
   * This therefore expects a singleton batch and returns its text verbatim
   * (the daemon's in-process driver encodes once after the text crosses the
   * wire — Option A v2 `UMGu36zoTDVuKWXi`). A multi-request batch is a
   * caller bug now that no coordinator-side combine exists: fail LOUD
   * rather than silently drop or mis-join.
   */
  private combineText(batch: readonly { text: string }[]): string {
    if (batch.length === 0) {
      throw new Error('combineText: empty batch');
    }
    if (batch.length > 1) {
      throw new Error(
        'RuntimeDeliveryCoordinator: multi-request batch reached the ' +
          'coordinator (received ' +
          batch.length +
          '). Since #task:1417 Stage 3 the coordinator no longer combines — ' +
          'callers must pre-combine into one request (the daemon combines ' +
          'deferred entries at flush). Silent join-fallback is forbidden.',
      );
    }
    return batch[0]!.text;
  }
}

function waitingSnippet(driver: DriverDeliveryView, thresholdMs: number): string {
  const seconds = Math.max(1, Math.round(thresholdMs / 1000));
  const runtime =
    driver.runtime ??
    (driver.releaseProfile === 'native-steer' || driver.releaseProfile === 'one-shot'
      ? 'runtime'
      : 'claude');
  return `Waiting for ${runtime} response (${seconds}s+)`;
}

function terminalStatusForReason(reason: AgentRunTerminalReason): AgentRunStatus {
  return reason === 'replied' || reason === 'turn_ended' || reason === 'replaced' ? 'idle' : 'failed';
}
