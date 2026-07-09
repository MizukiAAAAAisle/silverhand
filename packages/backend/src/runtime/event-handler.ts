/**
 * `RuntimeEventHandler` — backend's event-side seam to silverhand-daemon.
 *
 * Subscribes to `HostClient` events, drives `RunStateCache`, and fans
 * each event out to its backend-side consumers (SSE, inbox-ack, an
 * optional drain trigger). The handler does NOT issue commands
 * (`RuntimeBridge` owns that) and does NOT hold the cache state
 * (`RunStateCache` does).
 *
 * ## Module boundary (Cindy `KMJFmcS4hf_tJ5hj`)
 *
 *   - Command side:    `RuntimeBridge` (this file does NOT call
 *                      `bridge.runtimeStart/Stop/Deliver/etc.` directly —
 *                      callers do; the handler only invokes
 *                      `bridge.runtimeStatus` for hydrate, which is a
 *                      pure read)
 *   - Cache projection: `RunStateCache`
 *   - Event side:      THIS FILE
 *
 * Splitting these out keeps each piece testable with a fake of its
 * single dependency. The previous CM design collapsed all three into
 * one class and the test scaffolding had to mock spawn AND DB AND
 * SSE AND inbox all at once.
 *
 * ## Hydrate-on-subscribe contract (Cindy `KMJFmcS4hf_tJ5hj` boundary 5)
 *
 * On three trigger points the handler asks the daemon for the current
 * runtime set and replays it into the cache:
 *
 *   1. **Initial subscribe** — fired after `start()` completes.
 *   2. **Reconnect** — fired by `HostClient.onReconnect`.
 *   3. **Daemon pid change** — detected from the daemon's `ready`
 *      event. If we see a `ready` whose `daemon_pid` differs from
 *      what the cache last latched onto, that's a daemon swap and we
 *      MUST hydrate before any further events are accepted.
 *
 * Hydrate is async; events that arrive between trigger and completion
 * are dropped by the cache (mismatched `daemonInstanceKey`) and will
 * be re-supplied by the hydrate's `runtime_status` snapshot. This is
 * intentional: a partial event stream from a daemon we haven't yet
 * confirmed identity with would risk projecting stale state onto a
 * brand-new daemon.
 *
 * ## Inbox-ack timing (#task:1417 Stage 2b)
 *
 *   - **Sole production ack**: `delivered_at` moves ONLY on the async
 *     `runtime_delivery_consumed{delivery_ids}` event (→ `markDelivered`).
 *     The sync `runtime_deliver` disposition (`spawning`/`admitted`/
 *     `refused`) carries NO ack — "sent to daemon" ≠ ack. This is the sole
 *     `delivered_at` mover on the production fanout/coordinator path.
 *   - **Failure**: `runtime_delivery_failed{delivery_ids, reason}` hands
 *     rows back to the inbox sink (rollback to pending) so a later deliver
 *     replays them.
 */
import type { EventFrame, RuntimeStatusResult } from '@silverhand/host';
import type {
  AgentRunState,
  ConversationActivityEvent,
  ParsedEvent,
  ParsedEventKind,
} from '@silverhand/shared';
import type { ActivityLogWriter } from './activity-log-writer.js';
import { makeDaemonInstanceKey } from './daemon-instance-key.js';
import type { RunStateCache } from './run-state-cache.js';
import { sanitizeParsedEventForBroadcast } from './event-sanitize.js';
import { NOOP_STATUS_PROJECTOR, type RuntimeStatusProjector } from './status-projector.js';

/**
 * Backend-side SSE publisher contract — matches the existing
 * `BackendContext.events.publish(conversationId, {kind, payload})`
 * shape so commit 5's flip is a re-wire, not a refactor.
 *
 * `publish` routes to the resume-governed message-stream scope
 * (`conversation:{id}`); `publishSide` routes to the cursor-inert
 * side-channel scope (`conversation-side:{id}`) for agent-runtime /
 * activity / members kinds. See docs/event-ws-recovery-class-scope-v1.md.
 */
export interface EventPublisher {
  publish(conversationId: string, payload: { kind: string; payload: unknown }): void;
  publishSide(conversationId: string, payload: { kind: string; payload: unknown }): void;
}

/**
 * Inbox ack sink. Two methods — one for the success path (mark rows
 * delivered + advance outbox), one for the failure path (clear the
 * delivering flag so the next spawn re-picks them).
 *
 * Kept narrow so tests don't have to instantiate
 * `ConversationInboxRepo`.
 */
export interface InboxAckSink {
  markDelivered(deliveryIds: readonly number[]): void;
  markUndelivered(
    deliveryIds: readonly number[],
    reason: 'child_exit' | 'init_watchdog' | 'write_failed' | 'driver_refused',
  ): void;
}

export interface RuntimeStatusBridge {
  runtimeStatus(): Promise<RuntimeStatusResult>;
}

/**
 * Narrow event-source the handler subscribes to. This is the subset of
 * the old `HostClient` the handler ever used (`subscribe` + `onReconnect`)
 * — extracted so backend `src/` carries ZERO `HostClient` imports (D5.a
 * A1). The embedded path is now an outbound-frame transport like
 * standalone, not a `HostClient`; `OutboundRuntimeEventFanout` dispatches
 * events directly via `handler.dispatch(...)` and supplies a noop source
 * (it never calls `start()`), so this interface is the only coupling the
 * handler keeps to "where events come from".
 */
export interface RuntimeEventSource {
  subscribe(onFrame: (frame: EventFrame) => void): () => void;
  onReconnect(onReconnect: () => void): () => void;
}

/**
 * Optional drain-coordinator callback. Fires on
 * `runtime_ready_for_drain`. Caller is whatever owns the live-delivery
 * loop (post-flip: a thin CM successor; commit-4 default: undefined).
 *
 * `null` return means "no rows pending"; a handle return means "the
 * caller has scheduled a drain and will issue `bridge.runtimeDeliver`".
 * We do NOT do drain ourselves because the cache+inbox state needed
 * to decide what to send lives outside this module.
 */
export type ReadyForDrainHandler = (conversationId: string, agentId: string) => void | Promise<void>;

/**
 * Parsed-event forwarder. Fires on every `runtime_parsed_event` with
 * the RAW `frame.parsed` value — Cindy `BYHZJI9ALSVmmlFr` pin b: the
 * delivery coordinator's busy tracker must read from raw, not from the
 * SSE-sanitized payload (sanitization is a UI boundary; tracking
 * outstanding tool_uses is a delivery boundary).
 *
 * Hook contract is "forward only" — the handler MUST NOT keep its own
 * queue or call `bridge.runtimeDeliver` (Cindy `3l4bZ5vaMvlC9DVS`).
 */
export type ParsedEventHandler = (conversationId: string, agentId: string, event: ParsedEvent) => void;

/**
 * Runtime-exit forwarder. Fires AFTER the handler has updated cache +
 * SSE, with the `intentional` / `code` fields from the wire plus two
 * derived flags the wire doesn't carry directly:
 *
 *   - `initTimedOut` — true iff the (conv, agent) had a
 *     `runtime_init_cooldown` event observed before this exit, OR a
 *     `runtime_init_timeout` with `retrying: false`. Marker for the
 *     coordinator's oneShot-respawn gate (Cindy `BYHZJI9ALSVmmlFr`
 *     pin c — do NOT auto-respawn after an init failure; that would
 *     thrash a permanently-broken runtime).
 *   - `fatalError` — true iff a parsed `error` event with `fatal: true`
 *     was observed before this exit (e.g. `thread_not_found`). Same
 *     gate rationale.
 *
 * Hook contract is "forward only" — see ParsedEventHandler.
 */
export type RuntimeExitHandler = (
  conversationId: string,
  agentId: string,
  meta: {
    intentional: boolean;
    code: number | null;
    initTimedOut: boolean;
    fatalError: boolean;
  },
) => void;

/** Init-timeout forwarder. Used by the daemon-mode delivery coordinator
 * to cancel live-delivery stuck watchdogs when startup failure supersedes
 * the pending-delivery window. */
export type RuntimeInitTimeoutHandler = (conversationId: string, agentId: string) => void;

export interface ConversationActivitySink {
  recordParsedEvent(params: {
    conversationId: string;
    agentId: string;
    event: ParsedEvent;
    createdAt: number;
  }): ConversationActivityEvent | null;
  upsertTextBlock(params: {
    conversationId: string;
    agentId: string;
    kind: TextActivityKind;
    text: string;
    createdAt: number;
    previousEventId?: number | null;
  }): ConversationActivityEvent | null;
  recordParsedEventDropped(params: {
    conversationId: string;
    agentId: string;
    parsedKind: ParsedEventKind;
    encodedBytes: number;
    reason: string;
    createdAt: number;
  }): ConversationActivityEvent;
}

type ConversationActivityRecordResult =
  | ConversationActivityEvent
  | ConversationActivityEvent[]
  | null;

export type TextActivityKind = 'thinking' | 'text';

interface PendingTextActivityBlock {
  kind: TextActivityKind;
  text: string;
  omittedChars: number;
  createdAt: number;
  eventId: number | null;
  lastPublishedAt: number | null;
}

export interface RuntimeEventHandlerLogger {
  info(meta: object, msg: string): void;
  warn(meta: object, msg: string): void;
  error(meta: object, msg: string): void;
}

const NOOP_LOGGER: RuntimeEventHandlerLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const CONVERSATION_ACTIVITY_TEXT_BLOCK_MAX_CHARS = 16 * 1024;
const CONVERSATION_ACTIVITY_TEXT_BLOCK_PUBLISH_INTERVAL_MS = 1_000;

export interface RuntimeEventHandlerDeps {
  client: RuntimeEventSource;
  bridge: RuntimeStatusBridge;
  cache: RunStateCache;
  events: EventPublisher;
  inboxAck: InboxAckSink;
  /** Sink for events that mutate `conversation_agents` AND
   *  publish `agent_status` SSE. Default is the noop projector — tests
   *  that don't exercise DB projection don't need to inject one.
   *  Production wires `DbRuntimeStatusProjector` in `index.ts`. See
   *  `runtime/status-projector.ts` for the rationale. */
  statusProjector?: RuntimeStatusProjector;
  /** Fires on `runtime_ready_for_drain`. Optional in commit 4 since
   *  the drain coordinator may not be wired yet. */
  onReadyForDrain?: ReadyForDrainHandler;
  /** Fires on `runtime_parsed_event` with the RAW parsed payload —
   *  see `ParsedEventHandler` for the rationale and contract. */
  onParsedEvent?: ParsedEventHandler;
  /** Fires on `runtime_exit` AFTER the handler's cache/SSE updates,
   *  enriched with `initTimedOut` / `fatalError` derivations. See
   *  `RuntimeExitHandler` for the contract. */
  onRuntimeExit?: RuntimeExitHandler;
  /** Fires on runtime init-timeout/cooldown paths so the delivery
   *  coordinator can clear any live-delivery stuck indicator. */
  onInitTimeout?: RuntimeInitTimeoutHandler;
  /**
   * D4.b P1-2 (Cindy round-2 `0Hd5ComnzYxHJ6Rk` P1): fires AFTER a
   * `runtime_status` hydrate completes (cache reflects the
   * daemon's authoritative snapshot). Used by
   * `OutboundRuntimeEventFanout` to drive automatic drain of
   * pending inbox rows on daemon reattach — deferring the drain
   * to post-hydrate is required so the per-pair `startDeliveryBacked`
   * sees the right cache phase (`ready` → delivery path; absent → spawn
   * path). Firing on `ready` (pre-hydrate) would race the hydrate
   * and take the wrong branch.
   *
   * `trigger` mirrors `hydrateSafely`'s trigger argument so the
   * callback can distinguish initial-attach drain from
   * reconnect-recovery drain if needed.
   */
  onHydrateComplete?: (
    trigger: 'initial' | 'reconnect' | 'daemon_ready',
  ) => void | Promise<void>;
  /** Optional backend-owned JSONL sink for `agent_activity` parity
   * with the original ConversationManager runtime contract. Writing
   * must never block or fail the SSE publish path. */
  activityLog?: ActivityLogWriter;
  /** Optional product activity sink. When present, parsed runtime events
   *  are written into `conversation_events` and the resulting row DTO is
   *  published as `conversation_activity` on the conversation scope. */
  conversationActivity?: ConversationActivitySink;
  logger?: RuntimeEventHandlerLogger;
}

function activityBlockKey(conversationId: string, agentId: string): string {
  return `${conversationId}|${agentId}`;
}

function truncateTextActivityFragment(text: string): {
  text: string;
  omittedChars: number;
} {
  if (text.length <= CONVERSATION_ACTIVITY_TEXT_BLOCK_MAX_CHARS) {
    return { text, omittedChars: 0 };
  }
  return {
    text: text.slice(0, CONVERSATION_ACTIVITY_TEXT_BLOCK_MAX_CHARS),
    omittedChars: text.length - CONVERSATION_ACTIVITY_TEXT_BLOCK_MAX_CHARS,
  };
}

function appendTextActivityFragment(
  block: PendingTextActivityBlock,
  fragment: string,
): void {
  if (fragment.length === 0) return;
  if (block.omittedChars > 0) {
    block.omittedChars += fragment.length;
    return;
  }
  const available = CONVERSATION_ACTIVITY_TEXT_BLOCK_MAX_CHARS - block.text.length;
  if (available <= 0) {
    block.omittedChars += fragment.length;
    return;
  }
  block.text += fragment.slice(0, available);
  block.omittedChars += Math.max(0, fragment.length - available);
}

export class RuntimeEventHandler {
  private readonly client: RuntimeEventSource;
  private readonly bridge: RuntimeStatusBridge;
  private readonly cache: RunStateCache;
  private readonly events: EventPublisher;
  private readonly inboxAck: InboxAckSink;
  private readonly statusProjector: RuntimeStatusProjector;
  private readonly onReadyForDrain?: ReadyForDrainHandler;
  private readonly onParsedEventCb?: ParsedEventHandler;
  private readonly onRuntimeExitCb?: RuntimeExitHandler;
  private readonly onInitTimeoutCb?: RuntimeInitTimeoutHandler;
  private readonly onHydrateCompleteCb?: (
    trigger: 'initial' | 'reconnect' | 'daemon_ready',
  ) => void | Promise<void>;
  private readonly activityLog?: ActivityLogWriter;
  private readonly conversationActivity?: ConversationActivitySink;
  private readonly logger: RuntimeEventHandlerLogger;
  private readonly pendingTextActivityBlocks = new Map<string, PendingTextActivityBlock>();

  private unsubscribeEvents: (() => void) | null = null;
  private unsubscribeReconnect: (() => void) | null = null;
  private started = false;
  /**
   * Last seen `runtime_init_timeout.timeout_reason` per (conv,agent),
   * stashed so we can attach it to the matching `runtime_init_retrying`
   * projection (CM publishes `agent_status starting reason=init_timeout_retrying
   * timeout_reason=...` — the daemon event surfaces the two halves
   * separately, so we re-join them here). Cleared on
   * `runtime_init_cooldown` (terminal failure) and on
   * `runtime_state` (a normal state event after retry means init
   * succeeded; the next timeout would write a fresh value anyway).
   */
  private readonly lastTimeoutReason = new Map<string, 'silence' | 'pre_protocol_cap' | 'post_protocol'>();
  /**
   * Per-(conv,agent) markers the coordinator uses to gate oneShot
   * auto-respawn on `runtime_exit`. We set the marker when we see an
   * init-failure terminal (`runtime_init_cooldown`, or
   * `runtime_init_timeout` with `retrying: false`) and clear it on a
   * fresh `runtime_state` so a successful re-init resets the gate.
   * Cleared on `runtime_exit` too — the next runtime starts clean.
   */
  private readonly initFailureFlag = new Set<string>();
  /**
   * Same shape as `initFailureFlag` but for parsed `error` events with
   * `fatal: true` (e.g. `thread_not_found`). Set in the parsed-event
   * routing branch; cleared on runtime_state (recovery) and
   * runtime_exit (next runtime starts clean).
   */
  private readonly fatalErrorFlag = new Set<string>();

  constructor(deps: RuntimeEventHandlerDeps) {
    this.client = deps.client;
    this.bridge = deps.bridge;
    this.cache = deps.cache;
    this.events = deps.events;
    this.inboxAck = deps.inboxAck;
    this.statusProjector = deps.statusProjector ?? NOOP_STATUS_PROJECTOR;
    this.onReadyForDrain = deps.onReadyForDrain;
    this.onParsedEventCb = deps.onParsedEvent;
    this.onRuntimeExitCb = deps.onRuntimeExit;
    this.onInitTimeoutCb = deps.onInitTimeout;
    this.onHydrateCompleteCb = deps.onHydrateComplete;
    this.activityLog = deps.activityLog;
    this.conversationActivity = deps.conversationActivity;
    this.logger = deps.logger ?? NOOP_LOGGER;
  }

  /**
   * Subscribe to the client and issue an initial hydrate. Call once
   * after `HostClient.connect()` resolves. Idempotent — duplicate
   * calls are no-ops.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.unsubscribeEvents = this.client.subscribe(frame => this.dispatch(frame));
    this.unsubscribeReconnect = this.client.onReconnect(() => {
      // Reconnect to (possibly different) daemon. Wipe the cache so
      // mismatched-key events between now and hydrate resolution get
      // dropped, then re-latch via runtime_status. Also clear the
      // projection-side timeout-reason stash + coordinator gate flags
      // — old (conv,agent) entries no longer correspond to anything
      // in the new daemon's view. Cindy `dMNdrYH0KK1VbDqs` cleanup.
      this.cache.clearAll();
      this.lastTimeoutReason.clear();
      this.initFailureFlag.clear();
      this.fatalErrorFlag.clear();
      void this.hydrateSafely('reconnect');
    });
    await this.hydrateSafely('initial');
  }

  /** Tear down subscriptions. Does NOT close the underlying client. */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.unsubscribeEvents?.();
    this.unsubscribeReconnect?.();
    this.unsubscribeEvents = null;
    this.unsubscribeReconnect = null;
  }

  /**
   * Pure dispatch table — every event goes through here, no async.
   * Side effects (hydrate) run in fire-and-forget mode. Exposed for
   * test direct-injection; callers should normally let `subscribe`
   * drive it.
   */
  dispatch(frame: EventFrame): void {
    switch (frame.event) {
      case 'ready':
        this.onDaemonReady(frame.daemon_pid, frame.started_at);
        return;
      case 'shutting_down':
        // Daemon is going away. Clear the cache so the renderer
        // doesn't keep showing "ready" runtimes that no longer exist.
        // A subsequent `ready` from the next daemon will re-hydrate.
        this.cache.clearAll();
        // lastTimeoutReason is projection-side temporary state tied
        // to a specific (daemon, conv, agent) life — same daemon
        // going away invalidates every entry. Cindy
        // `dMNdrYH0KK1VbDqs` cleanup.
        this.lastTimeoutReason.clear();
        // Same rationale for the coordinator-gate flags: daemon swap
        // means a fresh runtime under the new daemon must start with
        // a clean gate.
        this.initFailureFlag.clear();
        this.fatalErrorFlag.clear();
        this.logger.warn({ kind: 'daemon', reason: frame.reason }, 'daemon shutting down');
        return;
      case 'runtime_state': {
        const isTerminalState = frame.state.terminalReason !== undefined;
        if (!isTerminalState) {
          // Clear any stale init-timeout reason on a NON-terminal state
          // — a normal mid-run state event means init succeeded (or moved
          // past the failure path); the next timeout would write a fresh
          // value anyway. Same logic for the coordinator gate flags: a
          // benign post-recovery state event resets the gate so a later
          // unrelated exit can still trigger oneShot auto-respawn.
          //
          // Terminal states (`terminalReason` set) MUST preserve these
          // flags — RealSupervisor emits the terminal `runtime_state`
          // BEFORE the matching `runtime_exit`, so clearing here would
          // strip the flag the coordinator needs at exit-time (Cindy
          // `rrF2L1RmWq5JFH3m` B1).
          this.lastTimeoutReason.delete(`${frame.conversation_id}|${frame.agent_id}`);
          this.initFailureFlag.delete(`${frame.conversation_id}|${frame.agent_id}`);
          this.fatalErrorFlag.delete(`${frame.conversation_id}|${frame.agent_id}`);
        }
        this.onRuntimeState(frame);
        return;
      }
      case 'runtime_exit':
        this.onRuntimeExit(frame);
        return;
      case 'runtime_ready_for_drain':
        this.onReadyForDrainEvent(frame);
        return;
      // #task:1417 Stage 2b — unified delivery ack family for
      // `runtime_deliver`. This is the SOLE production mover of
      // `delivered_at`. `consumed` → markDelivered; `failed` → roll the
      // batch back to pending (retriable) or mark failed
      // (`driver_refused`), exactly as `markUndelivered` classifies.
      case 'runtime_delivery_consumed':
        this.inboxAck.markDelivered(frame.delivery_ids);
        return;
      case 'runtime_delivery_failed':
        this.inboxAck.markUndelivered(frame.delivery_ids, frame.reason);
        this.logger.warn(
          {
            kind: 'inbox',
            conversationId: frame.conversation_id,
            agent_id: frame.agent_id,
            reason: frame.reason,
            delivery_ids: frame.delivery_ids,
          },
          'delivery failed',
        );
        return;
      case 'runtime_init_timeout':
        this.forwardInitTimeout(frame.conversation_id, frame.agent_id, frame.event);
        // Stash the timeout_reason so a follow-up runtime_init_retrying
        // can join it into the `agent_status starting reason=init_timeout_retrying`
        // projection (contract preserved from the original
        // ConversationManager runtime).
        this.lastTimeoutReason.set(`${frame.conversation_id}|${frame.agent_id}`, frame.timeout_reason);
        // If the daemon won't retry, this is a terminal init failure
        // that the next runtime_exit will follow. Mark so the
        // coordinator suppresses oneShot auto-respawn.
        if (!frame.retrying) {
          this.initFailureFlag.add(`${frame.conversation_id}|${frame.agent_id}`);
        }
        this.events.publishSide(frame.conversation_id, {
          kind: 'agent_init_timeout',
          payload: {
            agent_id: frame.agent_id,
            reason: frame.timeout_reason,
            elapsed_ms: frame.elapsed_ms,
            timeout_ms: frame.timeout_ms,
            retrying: frame.retrying,
            retry_attempt: frame.retry_attempt,
            max_retries: frame.max_retries,
            cooldown_until: frame.cooldown_until ?? null,
          },
        });
        return;
      case 'runtime_init_retrying': {
        // CM's contract: project to `agent_status` (status=starting,
        // reason=init_timeout_retrying) — NOT a separate SSE kind.
        // Frontend status patcher only listens to `agent_status`; a new
        // kind would leave the runtime stuck in stale status from the
        // pre-retry view. Cindy `ch9ZsU0v0ATr6tr8` blocker 2.
        //
        // B1 (Cindy `usjxj8AxX4AvJ5E-`): the projector owns BOTH the
        // DB write (`status='starting', pid=null`) AND the SSE — status
        // mapping in one place. Handler only fans out the wire fields.
        const key = `${frame.conversation_id}|${frame.agent_id}`;
        const timeoutReason = this.lastTimeoutReason.get(key);
        this.statusProjector.initRetrying({
          conversationId: frame.conversation_id,
          agentId: frame.agent_id,
          retryAttempt: frame.retry_attempt,
          maxRetries: frame.max_retries,
          timeoutReason,
        });
        return;
      }
      case 'runtime_init_cooldown':
        this.forwardInitTimeout(frame.conversation_id, frame.agent_id, frame.event);
        // Terminal init failure — clear the timeout-reason stash so a
        // future fresh start doesn't accidentally inherit it.
        this.lastTimeoutReason.delete(`${frame.conversation_id}|${frame.agent_id}`);
        // Mark the init-failure flag so the next runtime_exit suppresses
        // oneShot auto-respawn (Cindy `BYHZJI9ALSVmmlFr` pin c — don't
        // thrash a runtime the daemon has already given up on).
        this.initFailureFlag.add(`${frame.conversation_id}|${frame.agent_id}`);
        // B1 (Cindy `usjxj8AxX4AvJ5E-`): projector owns DB +
        // `agent_status` SSE for the cooldown projection.
        this.statusProjector.initCooldown({
          conversationId: frame.conversation_id,
          agentId: frame.agent_id,
          cooldownUntil: frame.cooldown_until,
          attemptsExhausted: frame.attempts_exhausted,
        });
        return;
      case 'runtime_compaction_stale':
        this.events.publishSide(frame.conversation_id, {
          kind: 'compaction_stale',
          payload: {
            agent_id: frame.agent_id,
            elapsed_ms: frame.elapsed_ms,
          },
        });
        return;
      case 'runtime_parsed_event':
        // Project to the historical `agent_event` SSE shape so the
        // renderer's Events panel and the agent-event listeners can't
        // tell which runtime produced the publish. MUST run
        // sanitization here (`tool_call.input` size cap + recursion
        // depth + cycle detection) — invariant inherited from the
        // original ConversationManager runtime; Cindy
        // `ch9ZsU0v0ATr6tr8` carried-forward blocker for commit 5
        // unit 1.
        this.events.publishSide(frame.conversation_id, {
          kind: 'agent_event',
          payload: {
            agent_id: frame.agent_id,
            event: sanitizeParsedEventForBroadcast(frame.parsed),
          },
        });
        this.recordConversationActivity({
          conversationId: frame.conversation_id,
          agentId: frame.agent_id,
          createdAt: frame.ts,
          record: sink =>
            this.recordParsedConversationActivity(sink, {
              conversationId: frame.conversation_id,
              agentId: frame.agent_id,
              event: frame.parsed,
              createdAt: frame.ts,
            }),
        });
        // B1 (Cindy `usjxj8AxX4AvJ5E-`): claude's `system.init` arrives
        // as a parsed `session_init` event. Project to DB
        // (`status='active', cli_session_id=<id>`) + `agent_status` SSE
        // via the projector. Claude emits `system.init` at the start of
        // EVERY turn — invariant inherited from the original
        // ConversationManager runtime; projector writes are idempotent
        // at the DB + SSE layer so no dedup here. The coordinator owns
        // dedup of NON-idempotent side effects (init-pending inbox
        // ack, drainInbox) via its own `initObserved` state (B3).
        if (frame.parsed.kind === 'session_init') {
          this.statusProjector.sessionInit({
            conversationId: frame.conversation_id,
            agentId: frame.agent_id,
            cliSessionId: frame.parsed.sessionId,
          });
        }
        // Mark fatal-error flag for the coordinator's exit gate (Cindy
        // `BYHZJI9ALSVmmlFr` pin c). Only fatal errors suppress
        // oneShot auto-respawn; non-fatal `error` events (e.g.
        // recoverable tool errors) leave the gate open.
        if (frame.parsed.kind === 'error' && frame.parsed.fatal === true) {
          this.fatalErrorFlag.add(`${frame.conversation_id}|${frame.agent_id}`);
        }
        // Forward the RAW parsed event to the coordinator (Cindy
        // `BYHZJI9ALSVmmlFr` pin b — busy tracker reads raw, not
        // sanitized). Hook contract is forward-only: the callback MUST
        // NOT hold queues or issue deliveries; that lives in the
        // coordinator. Try/catch keeps a buggy hook from poisoning the
        // SSE projection.
        if (this.onParsedEventCb) {
          try {
            this.onParsedEventCb(frame.conversation_id, frame.agent_id, frame.parsed);
          } catch (err) {
            this.logger.error(
              {
                kind: 'event',
                event: 'runtime_parsed_event',
                conversationId: frame.conversation_id,
                agent_id: frame.agent_id,
                err: (err as Error).message,
              },
              'onParsedEvent callback threw',
            );
          }
        }
        return;
      // `runtime_parsed_event_dropped` carries metadata-only (no
      // payload) when the encoded parsed event exceeded
      // `MAX_FRAME_BYTES`. Never synthesize a fake `agent_event` here:
      // when a cache entry exists we only annotate the existing
      // AgentRunState with a lossy diagnostic in its existing `detail`
      // field, then publish the normal `agent_activity` shape.
      case 'runtime_parsed_event_dropped':
        this.onParsedEventDropped(frame);
        return;
      // Other frames we acknowledge but currently route nowhere —
      // kept here so the exhaustive `switch` doesn't fall through
      // silently and so the list is discoverable for future wire-up.
      case 'runtime_output':
      case 'runtime_output_dropped':
      case 'runtime_output_paused':
      case 'runtime_output_resumed':
        return;
      default: {
        // Exhaustiveness check: if `EventFrame` gains a variant and
        // we forgot to handle it, this branch flags it at typecheck.
        const _exhaustive: never = frame;
        void _exhaustive;
        return;
      }
    }
  }

  private onParsedEventDropped(
    frame: Extract<EventFrame, { event: 'runtime_parsed_event_dropped' }>,
  ): void {
    const key = this.cache.daemonInstanceKey;
    let state: AgentRunState | null = null;
    if (key) {
      state = this.cache.applyParsedEventDropped(
        key,
        frame.conversation_id,
        frame.agent_id,
        {
          parsedKind: frame.parsed_kind,
          encodedBytes: frame.encoded_bytes,
          reason: frame.reason,
          ts: frame.ts,
        },
      );
    }
    if (state) {
      this.events.publishSide(frame.conversation_id, {
        kind: 'agent_activity',
        payload: state,
      });
      this.activityLog?.write(state);
    }
    this.recordConversationActivity({
      conversationId: frame.conversation_id,
      agentId: frame.agent_id,
      createdAt: frame.ts,
      record: sink =>
        [
          ...this.flushTextActivityBlock(
            sink,
            frame.conversation_id,
            frame.agent_id,
          ),
          sink.recordParsedEventDropped({
            conversationId: frame.conversation_id,
            agentId: frame.agent_id,
            parsedKind: frame.parsed_kind,
            encodedBytes: frame.encoded_bytes,
            reason: frame.reason,
            createdAt: frame.ts,
          }),
        ],
    });
    this.logger.warn(
      {
        kind: 'event',
        event: 'runtime_parsed_event_dropped',
        conversationId: frame.conversation_id,
        agent_id: frame.agent_id,
        parsed_kind: frame.parsed_kind,
        bytes: frame.encoded_bytes,
        reason: frame.reason,
        projected_lossy_state: state !== null,
      },
      'parsed event dropped at wire; projected metadata-only run-state loss marker',
    );
  }

  private recordConversationActivity(params: {
    conversationId: string;
    agentId: string;
    createdAt: number;
    record: (sink: ConversationActivitySink) => ConversationActivityRecordResult;
  }): void {
    if (!this.conversationActivity) return;
    try {
      const result = params.record(this.conversationActivity);
      const events = Array.isArray(result)
        ? result
        : result
          ? [result]
          : [];
      for (const event of events) {
        this.events.publishSide(params.conversationId, {
          kind: 'conversation_activity',
          payload: event,
        });
      }
    } catch (err) {
      this.logger.error(
        {
          kind: 'event',
          event: 'conversation_activity_persist_failed',
          conversationId: params.conversationId,
          agent_id: params.agentId,
          created_at: params.createdAt,
          err: (err as Error).message,
        },
        'conversation activity persist failed',
      );
    }
  }

  private recordParsedConversationActivity(
    sink: ConversationActivitySink,
    params: {
      conversationId: string;
      agentId: string;
      event: ParsedEvent;
      createdAt: number;
    },
  ): ConversationActivityEvent[] {
    if (params.event.kind === 'thinking' || params.event.kind === 'text') {
      return this.bufferTextActivityBlock(sink, {
        conversationId: params.conversationId,
        agentId: params.agentId,
        kind: params.event.kind,
        text: params.event.text,
        createdAt: params.createdAt,
      });
    }

    const events = this.flushTextActivityBlock(
      sink,
      params.conversationId,
      params.agentId,
    );
    const current = sink.recordParsedEvent(params);
    if (current) events.push(current);
    return events;
  }

  private bufferTextActivityBlock(
    sink: ConversationActivitySink,
    params: {
      conversationId: string;
      agentId: string;
      kind: TextActivityKind;
      text: string;
      createdAt: number;
    },
  ): ConversationActivityEvent[] {
    const key = activityBlockKey(params.conversationId, params.agentId);
    const previous = this.pendingTextActivityBlocks.get(key);
    const events =
      previous && previous.kind !== params.kind
        ? this.flushTextActivityBlock(sink, params.conversationId, params.agentId)
        : [];

    if (params.text.length === 0) return events;

    const current = this.pendingTextActivityBlocks.get(key);
    if (!current) {
      const block: PendingTextActivityBlock = {
        kind: params.kind,
        ...truncateTextActivityFragment(params.text),
        createdAt: params.createdAt,
        eventId: null,
        lastPublishedAt: null,
      };
      const event = this.persistTextActivityBlock(sink, params, block);
      this.pendingTextActivityBlocks.set(key, block);
      if (event) events.push(event);
      return events;
    }

    appendTextActivityFragment(current, params.text);
    if (this.shouldPublishTextActivityBlock(current, params.createdAt)) {
      const event = this.persistTextActivityBlock(sink, params, current);
      if (event) events.push(event);
    }
    return events;
  }

  private shouldPublishTextActivityBlock(
    block: PendingTextActivityBlock,
    now: number,
  ): boolean {
    if (block.eventId === null || block.lastPublishedAt === null) return true;
    return (
      now - block.lastPublishedAt >=
      CONVERSATION_ACTIVITY_TEXT_BLOCK_PUBLISH_INTERVAL_MS
    );
  }

  private persistTextActivityBlock(
    sink: ConversationActivitySink,
    params: {
      conversationId: string;
      agentId: string;
      kind: TextActivityKind;
      createdAt: number;
    },
    block: PendingTextActivityBlock,
  ): ConversationActivityEvent | null {
    const text =
      block.omittedChars > 0
        ? `${block.text}...<truncated ${block.omittedChars} chars>`
        : block.text;
    const event = sink.upsertTextBlock({
      conversationId: params.conversationId,
      agentId: params.agentId,
      kind: block.kind,
      text,
      createdAt: block.createdAt,
      previousEventId: block.eventId,
    });
    if (event) {
      block.eventId = event.id;
      block.lastPublishedAt = params.createdAt;
    }
    return event;
  }

  private flushTextActivityBlock(
    sink: ConversationActivitySink,
    conversationId: string,
    agentId: string,
  ): ConversationActivityEvent[] {
    const key = activityBlockKey(conversationId, agentId);
    const block = this.pendingTextActivityBlocks.get(key);
    if (!block) return [];
    this.pendingTextActivityBlocks.delete(key);
    if (block.text.length === 0 && block.omittedChars === 0) return [];
    if (block.eventId !== null) {
      const event = this.persistTextActivityBlock(
        sink,
        {
          conversationId,
          agentId,
          kind: block.kind,
          createdAt: block.createdAt,
        },
        block,
      );
      return event ? [event] : [];
    }
    const text =
      block.omittedChars > 0
        ? `${block.text}...<truncated ${block.omittedChars} chars>`
        : block.text;
    const event = sink.recordParsedEvent({
      conversationId,
      agentId,
      event: { kind: block.kind, text },
      createdAt: block.createdAt,
    });
    return event ? [event] : [];
  }

  private forwardInitTimeout(
    conversationId: string,
    agentId: string,
    event: 'runtime_init_timeout' | 'runtime_init_cooldown',
  ): void {
    if (!this.onInitTimeoutCb) return;
    try {
      this.onInitTimeoutCb(conversationId, agentId);
    } catch (err) {
      this.logger.error(
        {
          kind: 'event',
          event,
          conversationId,
          agent_id: agentId,
          err: (err as Error).message,
        },
        'onInitTimeout callback threw',
      );
    }
  }

  private onDaemonReady(daemonPid: number, startedAt: number): void {
    const newKey = makeDaemonInstanceKey(daemonPid, startedAt);
    if (this.cache.daemonInstanceKey === newKey) {
      // Same daemon as before — nothing to do.
      return;
    }
    // Different daemon. Wipe cache + projection-side stash and
    // re-hydrate. We do NOT pre-set the instance key here —
    // `applyRuntimeStatus` will latch it once hydrate succeeds,
    // ensuring all events between now and then are dropped
    // (mismatched key). Cindy `dMNdrYH0KK1VbDqs` cleanup: stash also
    // clears on daemon swap so the old daemon's last-timeout-reason
    // can't bleed into a new daemon's retry projection.
    this.cache.clearAll();
    this.lastTimeoutReason.clear();
    this.initFailureFlag.clear();
    this.fatalErrorFlag.clear();
    void this.hydrateSafely('daemon_ready', daemonPid, startedAt);
  }

  private onRuntimeState(frame: Extract<EventFrame, { event: 'runtime_state' }>): void {
    const key = this.cache.daemonInstanceKey;
    if (!key) {
      // Pre-hydrate: we haven't latched a daemon key yet. Dropping
      // is safe because hydrate's `runtime_status` snapshot will
      // carry the same state. Logging at info so noisy daemons don't
      // flood error logs on initial connect.
      this.logger.info(
        {
          kind: 'event',
          event: 'runtime_state',
          conversationId: frame.conversation_id,
          agent_id: frame.agent_id,
        },
        'dropped event: cache not yet hydrated',
      );
      return;
    }
    this.cache.applyRuntimeState(key, frame.conversation_id, frame.agent_id, frame.state);
    this.events.publishSide(frame.conversation_id, {
      kind: 'agent_activity',
      payload: frame.state,
    });
    this.activityLog?.write(frame.state);
  }

  private onRuntimeExit(frame: Extract<EventFrame, { event: 'runtime_exit' }>): void {
    // Clear the projection-side timeout-reason stash for this
    // (conv, agent). If the runtime exits without going through
    // runtime_init_cooldown (e.g. exhausted retries but daemon
    // didn't engage cooldown, or fatal error path), the stale
    // reason would otherwise wait forever for a matching
    // runtime_init_retrying that never comes. Cindy
    // `dMNdrYH0KK1VbDqs` cleanup.
    this.lastTimeoutReason.delete(`${frame.conversation_id}|${frame.agent_id}`);
    // Snapshot the gating flags BEFORE clearing them — coordinator
    // needs them on the callback. (Clearing after the snapshot keeps
    // the next runtime's gate clean: a fresh start under the same
    // (conv, agent) must not inherit the dead runtime's failure
    // markers.)
    const flagKey = `${frame.conversation_id}|${frame.agent_id}`;
    const initTimedOut = this.initFailureFlag.has(flagKey);
    const fatalError = this.fatalErrorFlag.has(flagKey);
    this.initFailureFlag.delete(flagKey);
    this.fatalErrorFlag.delete(flagKey);
    this.recordConversationActivity({
      conversationId: frame.conversation_id,
      agentId: frame.agent_id,
      createdAt: frame.ts,
      record: sink =>
        this.flushTextActivityBlock(
          sink,
          frame.conversation_id,
          frame.agent_id,
        ),
    });
    const key = this.cache.daemonInstanceKey;
    // Cache mutation is gated on a latched daemon key (events from a
    // pre-hydrate window can't safely write the cache because the
    // daemon identity isn't confirmed). But the SSE publish MUST run
    // regardless: runtime_exit is non-replayable — there is no
    // runtime_status snapshot that can later resurrect a "this runtime
    // exited" notification, because exited runtimes are gone from the
    // daemon's tracked set. Dropping the publish would permanently
    // strand the renderer's status at "active" / "starting".
    // Cindy `ch9ZsU0v0ATr6tr8` blocker 3.
    const entry = key ? this.cache.applyRuntimeExit(key, frame.conversation_id, frame.agent_id) : null;
    // B1 (Cindy `usjxj8AxX4AvJ5E-`): projector owns the DB write
    // (`status='idle'|'crashed', pid=null`) AND the `agent_status`
    // SSE. Status mapping (initTimedOut/fatalError -> 'crashed';
    // intentional || code===0 -> 'idle'; else 'crashed') lives in the
    // projector — see status-projector.ts:runtimeExit. Handler still
    // owns the cache update above + the gating-flag snapshot below
    // because those depend on EventHandler-local state.
    this.statusProjector.runtimeExit({
      conversationId: frame.conversation_id,
      agentId: frame.agent_id,
      intentional: frame.intentional,
      code: frame.code,
      initTimedOut,
      fatalError,
      runState: entry?.runState ?? null,
    });
    // Forward to the coordinator AFTER cache+SSE updates, so the
    // coordinator's auto-respawn doesn't race a stale projection. The
    // callback contract is forward-only — coordinator decides whether
    // to call DaemonHost.start; handler does not.
    if (this.onRuntimeExitCb) {
      try {
        this.onRuntimeExitCb(frame.conversation_id, frame.agent_id, {
          intentional: frame.intentional,
          code: frame.code,
          initTimedOut,
          fatalError,
        });
      } catch (err) {
        this.logger.error(
          {
            kind: 'event',
            event: 'runtime_exit',
            conversationId: frame.conversation_id,
            agent_id: frame.agent_id,
            err: (err as Error).message,
          },
          'onRuntimeExit callback threw',
        );
      }
    }
  }

  private onReadyForDrainEvent(frame: Extract<EventFrame, { event: 'runtime_ready_for_drain' }>): void {
    const key = this.cache.daemonInstanceKey;
    if (key) {
      // Cache hint: daemon just told us this runtime is `ready`.
      // Phase-only patch so we don't clobber the existing runState.
      this.cache.applyPhase(key, frame.conversation_id, frame.agent_id, 'ready');
    }
    this.statusProjector.runtimeReady({
      conversationId: frame.conversation_id,
      agentId: frame.agent_id,
    });
    if (this.onReadyForDrain) {
      try {
        const result = this.onReadyForDrain(frame.conversation_id, frame.agent_id);
        if (result && typeof (result as Promise<void>).then === 'function') {
          (result as Promise<void>).catch(err => {
            this.logger.error(
              {
                kind: 'event',
                event: 'runtime_ready_for_drain',
                conversationId: frame.conversation_id,
                agent_id: frame.agent_id,
                err: (err as Error).message,
              },
              'drain trigger rejected',
            );
          });
        }
      } catch (err) {
        this.logger.error(
          {
            kind: 'event',
            event: 'runtime_ready_for_drain',
            conversationId: frame.conversation_id,
            agent_id: frame.agent_id,
            err: (err as Error).message,
          },
          'drain trigger threw',
        );
      }
    }
  }

  /**
   * Issue `bridge.runtimeStatus()` and replay the snapshot into the
   * cache under a daemon instance key. Any failure is logged + swallowed
   * — caller's `start()` resolves either way so a transient hydrate
   * failure doesn't take down the backend boot.
   *
   * `phase` (the second/third args) is optional metadata used only
   * when hydrate is triggered by a `ready` event so we know which
   * pid/started_at to attribute the snapshot to. For initial /
   * reconnect hydrate paths we synthesize the key from the snapshot's
   * first entry, or fall back to a `ready` event that will arrive
   * shortly.
   */
  private async hydrateSafely(
    trigger: 'initial' | 'reconnect' | 'daemon_ready',
    daemonPid?: number,
    startedAt?: number,
  ): Promise<void> {
    try {
      const snapshot = await this.bridge.runtimeStatus();
      // Source the daemon instance key:
      //   - From the triggering `ready` event when available
      //   - Else from the cache's last latched key (reconnect to
      //     same daemon: harmless)
      //   - Else: synthesize a placeholder from now() so the cache
      //     latches SOMETHING; the next `ready` event will replace it.
      const key =
        daemonPid !== undefined && startedAt !== undefined
          ? makeDaemonInstanceKey(daemonPid, startedAt)
          : this.cache.daemonInstanceKey ?? `unknown@${Date.now()}`;
      this.cache.applyRuntimeStatus(key, snapshot.runtimes);
      this.logger.info(
        {
          kind: 'event',
          action: 'hydrate',
          trigger,
          runtime_count: snapshot.runtimes.length,
          daemon_key: key,
        },
        'cache hydrated from runtime_status',
      );
      // D4.b P1-2: invoke post-hydrate callback now that the cache
      // reflects the daemon's authoritative snapshot. The fanout
      // uses this to re-drive pending inbox rows for runtimes the
      // snapshot reports as already alive on reattach — deferred to
      // post-hydrate so the live-runtime check sees the right state.
      if (this.onHydrateCompleteCb) {
        try {
          await this.onHydrateCompleteCb(trigger);
        } catch (err) {
          this.logger.warn(
            {
              kind: 'event',
              action: 'hydrate_complete_callback',
              trigger,
              err: (err as Error).message,
            },
            'post-hydrate callback threw; reattach re-drive may be incomplete',
          );
        }
      }
    } catch (err) {
      this.logger.error(
        {
          kind: 'event',
          action: 'hydrate',
          trigger,
          err: (err as Error).message,
        },
        'hydrate failed; cache may be stale until next reconnect',
      );
    }
  }
}
