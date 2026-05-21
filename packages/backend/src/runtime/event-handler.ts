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
 *                      `bridge.runtimeStart/Stop/Wake/etc.` directly —
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
 * ## Inbox-ack timing (Cindy `KMJFmcS4hf_tJ5hj` boundary 6)
 *
 *   - **Startup delivery** (spawn-time inbox drain): backend marks
 *     rows delivered ONLY after `runtime_startup_delivery_consumed`
 *     fires for those `delivery_ids`. The daemon's
 *     `runtime_start` reply's `startup_delivery_accepted` flag is
 *     "accepted for attempt", NOT "consumed" — backend MUST NOT mark
 *     delivered on the reply alone.
 *   - **Live delivery** (running runtime wake): the caller (CM-style
 *     drain coordinator) marks rows delivered on the
 *     `runtime_wake` success result `{delivered: true, delivery_ids}`.
 *     The handler does NOT touch live-delivery ack — that path is
 *     synchronous via the bridge.
 *   - **Failure**: `runtime_startup_delivery_failed` carries a typed
 *     reason. Handler hands rows back to the inbox sink so the next
 *     spawn replays them.
 */
import type { EventFrame, HostClient } from '@silverhand/host';
import type { RuntimeBridge } from './bridge.js';
import type { RunStateCache } from './run-state-cache.js';

/**
 * Backend-side SSE publisher contract — matches the existing
 * `BackendContext.events.publish(conversationId, {kind, payload})`
 * shape so commit 5's flip is a re-wire, not a refactor.
 */
export interface EventPublisher {
  publish(conversationId: string, payload: { kind: string; payload: unknown }): void;
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

/**
 * Optional drain-coordinator callback. Fires on
 * `runtime_ready_for_drain`. Caller is whatever owns the live-delivery
 * loop (post-flip: a thin CM successor; commit-4 default: undefined).
 *
 * `null` return means "no rows pending"; a handle return means "the
 * caller has scheduled a drain and will issue `bridge.runtimeWake`".
 * We do NOT do drain ourselves because the cache+inbox state needed
 * to decide what to send lives outside this module.
 */
export type ReadyForDrainHandler = (
  conversationId: string,
  agentId: string,
) => void | Promise<void>;

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

export interface RuntimeEventHandlerDeps {
  client: HostClient;
  bridge: RuntimeBridge;
  cache: RunStateCache;
  events: EventPublisher;
  inboxAck: InboxAckSink;
  /** Fires on `runtime_ready_for_drain`. Optional in commit 4 since
   *  the drain coordinator may not be wired yet. */
  onReadyForDrain?: ReadyForDrainHandler;
  logger?: RuntimeEventHandlerLogger;
}

/**
 * Build a daemon-instance key from a `ready` event. Both fields are
 * required to disambiguate "same pid recycled across restarts" — pid
 * alone is not unique enough on long-lived hosts.
 */
function makeDaemonInstanceKey(daemonPid: number, startedAt: number): string {
  return `pid:${daemonPid}@${startedAt}`;
}

export class RuntimeEventHandler {
  private readonly client: HostClient;
  private readonly bridge: RuntimeBridge;
  private readonly cache: RunStateCache;
  private readonly events: EventPublisher;
  private readonly inboxAck: InboxAckSink;
  private readonly onReadyForDrain?: ReadyForDrainHandler;
  private readonly logger: RuntimeEventHandlerLogger;

  private unsubscribeEvents: (() => void) | null = null;
  private unsubscribeReconnect: (() => void) | null = null;
  private started = false;

  constructor(deps: RuntimeEventHandlerDeps) {
    this.client = deps.client;
    this.bridge = deps.bridge;
    this.cache = deps.cache;
    this.events = deps.events;
    this.inboxAck = deps.inboxAck;
    this.onReadyForDrain = deps.onReadyForDrain;
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
    this.unsubscribeEvents = this.client.subscribe(frame =>
      this.dispatch(frame),
    );
    this.unsubscribeReconnect = this.client.onReconnect(() => {
      // Reconnect to (possibly different) daemon. Wipe the cache so
      // mismatched-key events between now and hydrate resolution get
      // dropped, then re-latch via runtime_status.
      this.cache.clearAll();
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
        this.logger.warn(
          { kind: 'daemon', reason: frame.reason },
          'daemon shutting down',
        );
        return;
      case 'runtime_state':
        this.onRuntimeState(frame);
        return;
      case 'runtime_exit':
        this.onRuntimeExit(frame);
        return;
      case 'runtime_ready_for_drain':
        this.onReadyForDrainEvent(frame);
        return;
      case 'runtime_startup_delivery_consumed':
        this.inboxAck.markDelivered(frame.delivery_ids);
        return;
      case 'runtime_startup_delivery_failed':
        this.inboxAck.markUndelivered(frame.delivery_ids, frame.reason);
        this.logger.warn(
          {
            kind: 'inbox',
            conv_id: frame.conversation_id,
            agent_id: frame.agent_id,
            reason: frame.reason,
            delivery_ids: frame.delivery_ids,
          },
          'startup delivery failed',
        );
        return;
      case 'runtime_init_timeout':
        this.events.publish(frame.conversation_id, {
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
      case 'runtime_init_retrying':
        this.events.publish(frame.conversation_id, {
          kind: 'agent_init_retrying',
          payload: {
            agent_id: frame.agent_id,
            retry_attempt: frame.retry_attempt,
            max_retries: frame.max_retries,
            delay_ms: frame.delay_ms,
          },
        });
        return;
      case 'runtime_init_cooldown':
        this.events.publish(frame.conversation_id, {
          kind: 'agent_status',
          payload: {
            agent_id: frame.agent_id,
            status: 'crashed',
            reason: 'init_cooldown',
            cooldown_until: frame.cooldown_until,
            attempts_exhausted: frame.attempts_exhausted,
          },
        });
        return;
      case 'runtime_compaction_stale':
        this.events.publish(frame.conversation_id, {
          kind: 'compaction_stale',
          payload: {
            agent_id: frame.agent_id,
            elapsed_ms: frame.elapsed_ms,
          },
        });
        return;
      // Frames we acknowledge but currently route nowhere — kept here
      // so the exhaustive `switch` doesn't fall through silently and
      // so the list is discoverable for commit 5's wire-up.
      case 'runtime_output':
      case 'runtime_output_dropped':
      case 'runtime_output_paused':
      case 'runtime_output_resumed':
      case 'runtime_parsed_event':
      case 'runtime_parsed_event_dropped':
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

  private onDaemonReady(daemonPid: number, startedAt: number): void {
    const newKey = makeDaemonInstanceKey(daemonPid, startedAt);
    if (this.cache.daemonInstanceKey === newKey) {
      // Same daemon as before — nothing to do.
      return;
    }
    // Different daemon. Wipe cache and re-hydrate. We do NOT pre-set
    // the instance key here — `applyRuntimeStatus` will latch it once
    // hydrate succeeds, ensuring all events between now and then are
    // dropped (mismatched key).
    this.cache.clearAll();
    void this.hydrateSafely('daemon_ready', daemonPid, startedAt);
  }

  private onRuntimeState(
    frame: Extract<EventFrame, { event: 'runtime_state' }>,
  ): void {
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
          conv_id: frame.conversation_id,
          agent_id: frame.agent_id,
        },
        'dropped event: cache not yet hydrated',
      );
      return;
    }
    this.cache.applyRuntimeState(
      key,
      frame.conversation_id,
      frame.agent_id,
      frame.state,
    );
    this.events.publish(frame.conversation_id, {
      kind: 'agent_activity',
      payload: frame.state,
    });
  }

  private onRuntimeExit(
    frame: Extract<EventFrame, { event: 'runtime_exit' }>,
  ): void {
    const key = this.cache.daemonInstanceKey;
    if (!key) return;
    const entry = this.cache.applyRuntimeExit(
      key,
      frame.conversation_id,
      frame.agent_id,
    );
    // Status payload mirrors CM's existing `agent_status crashed/stopped`
    // contract so commit 5's flip changes the source of the event but
    // not its shape — renderer + bus consumers stay unchanged.
    this.events.publish(frame.conversation_id, {
      kind: 'agent_status',
      payload: {
        agent_id: frame.agent_id,
        status: frame.intentional ? 'stopped' : 'crashed',
        exit_code: frame.code,
        intentional: frame.intentional,
        run_state: entry?.runState ?? null,
      },
    });
  }

  private onReadyForDrainEvent(
    frame: Extract<EventFrame, { event: 'runtime_ready_for_drain' }>,
  ): void {
    const key = this.cache.daemonInstanceKey;
    if (key) {
      // Cache hint: daemon just told us this runtime is `ready`.
      // Phase-only patch so we don't clobber the existing runState.
      this.cache.applyPhase(key, frame.conversation_id, frame.agent_id, 'ready');
    }
    if (this.onReadyForDrain) {
      try {
        const result = this.onReadyForDrain(
          frame.conversation_id,
          frame.agent_id,
        );
        if (result && typeof (result as Promise<void>).then === 'function') {
          (result as Promise<void>).catch(err => {
            this.logger.error(
              {
                kind: 'event',
                event: 'runtime_ready_for_drain',
                conv_id: frame.conversation_id,
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
            conv_id: frame.conversation_id,
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
