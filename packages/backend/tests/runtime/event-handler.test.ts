/**
 * Unit tests for `RuntimeEventHandler` — the daemon-event-side seam.
 *
 * Coverage targets (commit-4 boundaries from Cindy `KMJFmcS4hf_tJ5hj`):
 *
 *   - Hydrate-on-subscribe: `start()` calls `bridge.runtimeStatus()`
 *     and replays the snapshot into the cache.
 *   - Hydrate-on-reconnect: HostClient's `onReconnect` handler fires
 *     `cache.clearAll()` + hydrate.
 *   - Daemon-pid change: a `ready` event with a new pid wipes cache
 *     and re-hydrates under the new key.
 *   - Inbox ack timing: `runtime_delivery_consumed` →
 *     `inboxAck.markDelivered`; `runtime_delivery_failed` → `markUndelivered(reason)`.
 *   - Event routing: `runtime_state` → cache + SSE `agent_activity`;
 *     `runtime_exit` → cache + SSE `agent_status` with `intentional`-derived
 *     status; `runtime_init_*` → SSE projection without cache mutation.
 *   - Cache-not-ready safety: events arriving before any daemon key
 *     latched are dropped (no cache mutation, no SSE noise) until
 *     hydrate completes.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  HOST_PROTOCOL_VERSION,
  KNOWN_CAPABILITIES_V1,
  type EventFrame,
  type RuntimeStatusResult as WireRuntimeStatusResult,
} from '@silverhand/host';
import type { AgentRunState } from '@silverhand/shared';
import { RunStateCache } from '../../src/runtime/run-state-cache.js';
import {
  HYDRATE_RETRY_DELAYS_MS,
  RuntimeEventHandler,
  type ConversationActivitySink,
  type EventPublisher,
  type InboxAckSink,
  type RuntimeEventHandlerDeps,
  type RuntimeEventSource,
  type RuntimeStatusBridge,
} from '../../src/runtime/event-handler.js';
import type { RuntimeStatusProjector } from '../../src/runtime/status-projector.js';

type LegacyRuntimeStatusResult = {
  runtimes: Array<
    Omit<WireRuntimeStatusResult['runtimes'][number], 'runtime_scope'> & {
      runtime_scope?: WireRuntimeStatusResult['runtimes'][number]['runtime_scope'];
    }
  >;
};
type RuntimeStatusResult = LegacyRuntimeStatusResult;

function normalizeStatusSnapshot(
  snapshot: RuntimeStatusResult,
): WireRuntimeStatusResult {
  return {
    runtimes: snapshot.runtimes.map(runtime => ({
      ...runtime,
      runtime_scope: runtime.runtime_scope ?? {
        kind: 'conversation',
        conversation_id: runtime.conversation_id,
        agent_id: runtime.agent_id,
      },
    })),
  };
}

function makeFakeClient(): {
  client: RuntimeEventSource;
  emit: (frame: Record<string, unknown>) => void;
  triggerReconnect: () => void;
} {
  const eventHandlers = new Set<(frame: EventFrame) => void>();
  const reconnectHandlers = new Set<() => void>();
  const fake: RuntimeEventSource = {
    subscribe(handler: (frame: EventFrame) => void) {
      eventHandlers.add(handler);
      return () => eventHandlers.delete(handler);
    },
    onReconnect(handler: () => void) {
      reconnectHandlers.add(handler);
      return () => reconnectHandlers.delete(handler);
    },
  };
  return {
    client: fake,
    emit(frame) {
      const scopedFrame =
        'conversation_id' in frame
        && typeof frame.conversation_id === 'string'
        && 'agent_id' in frame
        && typeof frame.agent_id === 'string'
        && !('runtime_scope' in frame)
          ? {
              ...frame,
              runtime_scope: {
                kind: 'conversation',
                conversation_id: frame.conversation_id,
                agent_id: frame.agent_id,
              },
            }
          : frame;
      const generationBoundEvents = new Set([
        'runtime_state',
        'runtime_exit',
        'runtime_ready_for_drain',
        'runtime_init_timeout',
        'runtime_init_retrying',
        'runtime_init_cooldown',
        'runtime_parsed_event',
        'runtime_delivery_consumed',
        'runtime_delivery_failed',
      ]);
      const boundFrame = generationBoundEvents.has(String(scopedFrame.event))
        && !('runtime_generation' in scopedFrame)
        ? { ...scopedFrame, runtime_generation: 1 } as unknown as EventFrame
        : scopedFrame as EventFrame;
      for (const h of eventHandlers) h(boundFrame);
    },
    triggerReconnect() {
      for (const h of reconnectHandlers) h();
    },
  };
}

function makeBridge(snapshot: RuntimeStatusResult): {
  bridge: RuntimeStatusBridge;
  statusCalls: () => number;
} {
  let count = 0;
  const bridge = {
    runtimeStatus: async () => {
      count += 1;
      return normalizeStatusSnapshot(snapshot);
    },
  } as unknown as RuntimeStatusBridge;
  return { bridge, statusCalls: () => count };
}

function makePublisher(): {
  publisher: EventPublisher;
  published: Array<{ conv: string; kind: string; payload: unknown }>;
} {
  const published: Array<{ conv: string; kind: string; payload: unknown }> = [];
  const publisher: EventPublisher = {
    publish(conv, payload) {
      published.push({ conv, kind: payload.kind, payload: payload.payload });
    },
    // Stage-2 P2: agent-runtime / activity kinds route to the side-channel
    // scope. Capture identically so behavioral assertions are channel-agnostic;
    // scope routing is locked in scope-event-bus / ws-server tests.
    publishSide(conv, payload) {
      published.push({ conv, kind: payload.kind, payload: payload.payload });
    },
  };
  return { publisher, published };
}

function makeInboxAck(): {
  sink: InboxAckSink;
  delivered: number[][];
  undelivered: Array<{ ids: number[]; reason: string }>;
} {
  const delivered: number[][] = [];
  const undelivered: Array<{ ids: number[]; reason: string }> = [];
  const sink: InboxAckSink = {
    markDelivered(settlement) {
      delivered.push([...settlement.deliveryIds]);
    },
    markUndelivered(settlement, reason) {
      undelivered.push({ ids: [...settlement.deliveryIds], reason });
    },
  };
  return { sink, delivered, undelivered };
}

/**
 * Forwarding projector: publishes the same `agent_status` SSE shape
 * that the EventHandler used to emit inline (pre-B1) so the existing
 * 38 SSE-shape tests keep passing without rewriting every fixture.
 * Production wires `DbRuntimeStatusProjector` which ALSO writes
 * `agent_runtime_slots`; tests that need to assert the DB side use the
 * production class directly (see status-projector.test.ts).
 */
function makeForwardingProjector(publisher: EventPublisher): RuntimeStatusProjector {
  return {
    publishStatus({ conversationId, agentId, payload }) {
      if (conversationId === null) return;
      publisher.publish(conversationId, {
        kind: 'agent_status',
        payload: { agent_id: agentId, ...payload },
      });
    },
    sessionInit({ conversationId, agentId, cliSessionId }) {
      publisher.publish(conversationId, {
        kind: 'agent_status',
        payload: {
          agent_id: agentId,
          status: 'active',
          cli_session_id: cliSessionId,
        },
      });
    },
    runtimeReady({ conversationId, agentId }) {
      publisher.publish(conversationId, {
        kind: 'agent_status',
        payload: {
          agent_id: agentId,
          status: 'active',
        },
      });
    },
    runtimeExit({ conversationId, agentId, intentional, code, initTimedOut, fatalError, runState }) {
      const status: 'idle' | 'crashed' =
        initTimedOut || fatalError ? 'crashed' : intentional || code === 0 ? 'idle' : 'crashed';
      publisher.publish(conversationId, {
        kind: 'agent_status',
        payload: {
          agent_id: agentId,
          status,
          exit_code: code,
          intentional,
          run_state: runState,
        },
      });
      return null;
    },
    initRetrying({ conversationId, agentId, retryAttempt, maxRetries, timeoutReason }) {
      publisher.publish(conversationId, {
        kind: 'agent_status',
        payload: {
          agent_id: agentId,
          status: 'starting',
          reason: 'init_timeout_retrying',
          retry_attempt: retryAttempt,
          max_retries: maxRetries,
          ...(timeoutReason ? { timeout_reason: timeoutReason } : {}),
        },
      });
    },
    initCooldown({ conversationId, agentId, cooldownUntil, attemptsExhausted }) {
      publisher.publish(conversationId, {
        kind: 'agent_status',
        payload: {
          agent_id: agentId,
          status: 'crashed',
          reason: 'init_cooldown',
          cooldown_until: cooldownUntil,
          attempts_exhausted: attemptsExhausted,
        },
      });
    },
  };
}

/**
 * Thin wrapper around `new RuntimeEventHandler({...})` that injects a
 * forwarding projector pulled from `deps.events`. Lets every test
 * site keep its existing constructor shape (5-line `{client, bridge,
 * cache, events, inboxAck}`) without manual projector wiring.
 */
function makeHandler(deps: Omit<RuntimeEventHandlerDeps, 'statusProjector'>): RuntimeEventHandler {
  return new RuntimeEventHandler({
    ...deps,
    daemonInstanceId: deps.daemonInstanceId ?? (() => 'daemon-test'),
    deliveryOwner: deps.deliveryOwner ?? (() => 'connection-test'),
    statusProjector: makeForwardingProjector(deps.events),
  });
}

function readyFrame(daemonPid: number, startedAt: number): EventFrame {
  return {
    event: 'ready',
    protocol_version: HOST_PROTOCOL_VERSION,
    socket_path: '/tmp/sock',
    daemon_pid: daemonPid,
    daemon_version: '0.0.0-test',
    daemon_id: 'local',
    instance_id: `${startedAt}-${daemonPid}`,
    host_descriptor: { name: 'local', kind: 'local' },
    capabilities: [...KNOWN_CAPABILITIES_V1],
    started_at: startedAt,
  };
}

function runStateFrame(conversationId: string, agentId: string, state: AgentRunState, ts = 1700000000000): EventFrame {
  return {
    event: 'runtime_state',
    runtime_scope: {
      kind: 'conversation',
      conversation_id: conversationId,
      agent_id: agentId,
    },
    conversation_id: conversationId,
    agent_id: agentId,
    state,
    runtime_generation: 1,
    ts,
  };
}

function exitFrame(
  conversationId: string,
  agentId: string,
  intentional: boolean,
  code: number | null = 0,
  ts = 1700000000000,
): EventFrame {
  return {
    event: 'runtime_exit',
    runtime_scope: {
      kind: 'conversation',
      conversation_id: conversationId,
      agent_id: agentId,
    },
    conversation_id: conversationId,
    agent_id: agentId,
    code,
    intentional,
    runtime_generation: 1,
    ts,
  };
}

const RUN_STATE: AgentRunState = {
  runId: 'r1',
  agentId: 'a1',
  conversationId: 'c1',
  status: 'thinking',
  startedAt: 1700000000000,
  updatedAt: 1700000000000,
  lastActivityAt: 1700000000000,
};

describe('RuntimeEventHandler.start — hydrate on initial subscribe', () => {
  it('calls bridge.runtimeStatus and replays snapshot into the cache', async () => {
    const cache = new RunStateCache();
    const { client } = makeFakeClient();
    const { bridge } = makeBridge({
      runtimes: [
        {
          conversation_id: 'c1',
          agent_id: 'a1',
          runtime_generation: 1,
          pid: 1234,
          phase: 'ready',
          run_state: RUN_STATE,
          started_at: 1700000000000,
        },
      ],
    });
    const { publisher } = makePublisher();
    const { sink } = makeInboxAck();
    const handler = makeHandler({
      client,
      bridge,
      cache,
      events: publisher,
      inboxAck: sink,
    });
    await handler.start();
    expect(cache.list().length).toBe(1);
    const entry = cache.get('c1', 'a1')!;
    expect(entry.phase).toBe('ready');
    expect(entry.runState?.runId).toBe('r1');
    expect(cache.daemonInstanceKey).not.toBeNull();
  });

  it('is idempotent — duplicate start() does not re-subscribe', async () => {
    const cache = new RunStateCache();
    const { client } = makeFakeClient();
    const subscribe = vi.spyOn(client, 'subscribe');
    const onReconnect = vi.spyOn(client, 'onReconnect');
    const { bridge } = makeBridge({ runtimes: [] });
    const { publisher } = makePublisher();
    const { sink } = makeInboxAck();
    const handler = makeHandler({
      client,
      bridge,
      cache,
      events: publisher,
      inboxAck: sink,
    });
    await handler.start();
    await handler.start();
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });
});

describe('RuntimeEventHandler — hydrate on reconnect', () => {
  it('wipes cache and re-hydrates when HostClient reconnects', async () => {
    const cache = new RunStateCache();
    const { client, triggerReconnect } = makeFakeClient();
    // First snapshot: c1/a1 only.
    let snapshot: RuntimeStatusResult = {
      runtimes: [
        {
          conversation_id: 'c1',
          agent_id: 'a1',
          runtime_generation: 1,
          pid: 1234,
          phase: 'ready',
          run_state: null,
          started_at: 1700000000000,
        },
      ],
    };
    const bridge = {
      runtimeStatus: async () => normalizeStatusSnapshot(snapshot),
    } as unknown as RuntimeStatusBridge;
    const { publisher } = makePublisher();
    const { sink } = makeInboxAck();
    const handler = makeHandler({
      client,
      bridge,
      cache,
      events: publisher,
      inboxAck: sink,
    });
    await handler.start();
    expect(cache.list().length).toBe(1);
    // Second snapshot for the reconnect: now empty.
    snapshot = { runtimes: [] };
    triggerReconnect();
    // Allow microtask queue to drain the async hydrate.
    await Promise.resolve();
    await Promise.resolve();
    expect(cache.list().length).toBe(0);
  });
});

describe('RuntimeEventHandler — daemon pid change (daemon swap)', () => {
  it('wipes cache and re-hydrates when ready event reports a different pid', async () => {
    const cache = new RunStateCache();
    const { client, emit } = makeFakeClient();
    let snapshot: RuntimeStatusResult = {
      runtimes: [
        {
          conversation_id: 'c1',
          agent_id: 'a1',
          runtime_generation: 1,
          pid: 1234,
          phase: 'ready',
          run_state: null,
          started_at: 1700000000000,
        },
      ],
    };
    const bridge = {
      runtimeStatus: async () => normalizeStatusSnapshot(snapshot),
    } as unknown as RuntimeStatusBridge;
    const { publisher } = makePublisher();
    const { sink } = makeInboxAck();
    const handler = makeHandler({
      client,
      bridge,
      cache,
      events: publisher,
      inboxAck: sink,
    });
    await handler.start();
    // Daemon A latched.
    const beforeKey = cache.daemonInstanceKey;
    expect(beforeKey).not.toBeNull();

    // Daemon swap: ready with new pid.
    snapshot = { runtimes: [] };
    emit(readyFrame(99, 2700000000000));
    await Promise.resolve();
    await Promise.resolve();
    expect(cache.list().length).toBe(0);
    expect(cache.daemonInstanceKey).toBe('pid:99@2700000000000');
  });

  it('no-ops when ready event reports the same pid as already latched', async () => {
    const cache = new RunStateCache();
    const { client, emit } = makeFakeClient();
    let statusCalls = 0;
    const bridge = {
      runtimeStatus: async () => {
        statusCalls += 1;
        // First call (initial) — we want exactly 1; second call only
        // happens if we mistakenly hydrate on the duplicate ready.
        return normalizeStatusSnapshot({
          runtimes: [
            {
              conversation_id: 'c1',
              agent_id: 'a1',
              runtime_generation: 1,
              pid: 1234,
              phase: 'ready',
              run_state: null,
              started_at: 1700000000000,
            },
          ],
        });
      },
    } as unknown as RuntimeStatusBridge;
    const { publisher } = makePublisher();
    const { sink } = makeInboxAck();
    const handler = makeHandler({
      client,
      bridge,
      cache,
      events: publisher,
      inboxAck: sink,
    });
    await handler.start();
    expect(statusCalls).toBe(1);
    const key = cache.daemonInstanceKey;
    // Same daemon's ready (e.g. retransmitted on resubscribe) — no
    // wipe, no second hydrate. We need to know what key was set; it's
    // synthesized from the snapshot's runtimes since the initial path
    // had no ready event. To exercise the same-pid branch, we set a
    // known key first by emitting a ready BEFORE further calls.
    emit(readyFrame(99, 1700000000000));
    await Promise.resolve();
    await Promise.resolve();
    // Now key should be pid:99@... and another status call has fired.
    expect(cache.daemonInstanceKey).toBe('pid:99@1700000000000');
    expect(statusCalls).toBe(2);
    // Re-emit the SAME ready — must NOT trigger another hydrate.
    emit(readyFrame(99, 1700000000000));
    await Promise.resolve();
    await Promise.resolve();
    expect(statusCalls).toBe(2);
    expect(cache.daemonInstanceKey).toBe('pid:99@1700000000000');
    // Smoke: original key was the synthesized one, not equal to the
    // post-ready key.
    expect(key).not.toBe('pid:99@1700000000000');
  });
});

describe('RuntimeEventHandler — inbox ack timing', () => {
  it('runtime_delivery_consumed → markDelivered(ids)', async () => {
    const cache = new RunStateCache();
    const { client, emit } = makeFakeClient();
    const { bridge } = makeBridge({ runtimes: [] });
    const { publisher } = makePublisher();
    const { sink, delivered } = makeInboxAck();
    const handler = makeHandler({
      client,
      bridge,
      cache,
      events: publisher,
      inboxAck: sink,
    });
    await handler.start();
    emit({
      event: 'runtime_delivery_consumed',
      conversation_id: 'c1',
      agent_id: 'a1',
      delivery_ids: [10, 11, 12],
      ts: 1700000001000,
    });
    expect(delivered).toEqual([[10, 11, 12]]);
  });

  it('runtime_delivery_failed → markUndelivered(ids, reason)', async () => {
    const cache = new RunStateCache();
    const { client, emit } = makeFakeClient();
    const { bridge } = makeBridge({ runtimes: [] });
    const { publisher } = makePublisher();
    const { sink, undelivered } = makeInboxAck();
    const handler = makeHandler({
      client,
      bridge,
      cache,
      events: publisher,
      inboxAck: sink,
    });
    await handler.start();
    emit({
      event: 'runtime_delivery_failed',
      conversation_id: 'c1',
      agent_id: 'a1',
      delivery_ids: [42],
      reason: 'init_watchdog',
      ts: 1700000001000,
    });
    expect(undelivered).toEqual([{ ids: [42], reason: 'init_watchdog' }]);
  });
});

describe('RuntimeEventHandler — event routing', () => {
  it('runtime_state → cache mutation + SSE agent_activity publish', async () => {
    const cache = new RunStateCache();
    const { client, emit } = makeFakeClient();
    const { bridge } = makeBridge({
      runtimes: [
        {
          conversation_id: 'c1',
          agent_id: 'a1',
          runtime_generation: 1,
          pid: 1234,
          phase: 'ready',
          run_state: null,
          started_at: 1700000000000,
        },
      ],
    });
    const { publisher, published } = makePublisher();
    const { sink } = makeInboxAck();
    const activityLogWrites: AgentRunState[] = [];
    const handler = makeHandler({
      client,
      bridge,
      cache,
      events: publisher,
      inboxAck: sink,
      activityLog: {
        write: state => activityLogWrites.push(state),
        close: async () => {},
      },
    });
    await handler.start();
    emit(runStateFrame('c1', 'a1', RUN_STATE));
    expect(cache.get('c1', 'a1')?.runState?.runId).toBe('r1');
    const activity = published.find(p => p.kind === 'agent_activity');
    expect(activity).toBeDefined();
    expect((activity!.payload as AgentRunState).runId).toBe('r1');
    expect(activityLogWrites).toEqual([RUN_STATE]);
  });

  it('runtime_exit (intentional=false, non-zero code) → SSE agent_status crashed', async () => {
    const cache = new RunStateCache();
    const { client, emit } = makeFakeClient();
    const { bridge } = makeBridge({
      runtimes: [
        {
          conversation_id: 'c1',
          agent_id: 'a1',
          runtime_generation: 1,
          pid: 1234,
          phase: 'ready',
          run_state: null,
          started_at: 1700000000000,
        },
      ],
    });
    const { publisher, published } = makePublisher();
    const { sink } = makeInboxAck();
    const handler = makeHandler({
      client,
      bridge,
      cache,
      events: publisher,
      inboxAck: sink,
    });
    await handler.start();
    emit(exitFrame('c1', 'a1', false, 137));
    expect(cache.get('c1', 'a1')?.phase).toBe('exited');
    const status = published.find(p => p.kind === 'agent_status');
    expect(status).toBeDefined();
    const sp = status!.payload as {
      status: string;
      exit_code: number | null;
      intentional: boolean;
    };
    expect(sp.status).toBe('crashed');
    expect(sp.exit_code).toBe(137);
    expect(sp.intentional).toBe(false);
  });

  it('runtime_exit (intentional=true) → SSE agent_status idle (NOT stopped, schema only allows idle|starting|active|crashed)', async () => {
    const cache = new RunStateCache();
    const { client, emit } = makeFakeClient();
    const { bridge } = makeBridge({
      runtimes: [
        {
          conversation_id: 'c1',
          agent_id: 'a1',
          runtime_generation: 1,
          pid: 1234,
          phase: 'ready',
          run_state: null,
          started_at: 1700000000000,
        },
      ],
    });
    const { publisher, published } = makePublisher();
    const { sink } = makeInboxAck();
    const handler = makeHandler({
      client,
      bridge,
      cache,
      events: publisher,
      inboxAck: sink,
    });
    await handler.start();
    emit(exitFrame('c1', 'a1', true, 0));
    const status = published.find(p => p.kind === 'agent_status');
    expect((status!.payload as { status: string }).status).toBe('idle');
  });

  it('runtime_exit (intentional=false, code=0) → SSE agent_status idle (normal session end)', async () => {
    // CM contract: `intentionallyStopped || code === 0 -> idle`. A
    // CLI that exits with 0 on its own (e.g. claude wrapping up a
    // session) is a clean shutdown, not a crash.
    const cache = new RunStateCache();
    const { client, emit } = makeFakeClient();
    const { bridge } = makeBridge({
      runtimes: [
        {
          conversation_id: 'c1',
          agent_id: 'a1',
          runtime_generation: 1,
          pid: 1234,
          phase: 'ready',
          run_state: null,
          started_at: 1700000000000,
        },
      ],
    });
    const { publisher, published } = makePublisher();
    const { sink } = makeInboxAck();
    const handler = makeHandler({
      client,
      bridge,
      cache,
      events: publisher,
      inboxAck: sink,
    });
    await handler.start();
    emit(exitFrame('c1', 'a1', false, 0));
    const status = published.find(p => p.kind === 'agent_status');
    expect((status!.payload as { status: string }).status).toBe('idle');
  });

  it('runtime_exit emits SSE even before hydrate completes (non-replayable)', async () => {
    // runtime_exit is the one event we MUST publish even in the
    // pre-hydrate window: a `runtime_status` snapshot only carries
    // active runtimes, so it can NEVER resurrect a missed exit. If
    // we dropped, the renderer would be stranded showing "active"
    // forever. Cindy `ch9ZsU0v0ATr6tr8` blocker 3.
    const cache = new RunStateCache();
    const { client, emit } = makeFakeClient();
    // Hold hydrate open so we can fire an exit in between.
    let resolveStatus: ((value: RuntimeStatusResult) => void) | null = null;
    const bridge = {
      runtimeStatus: () =>
        new Promise<RuntimeStatusResult>(resolve => {
          resolveStatus = resolve;
        }),
    } as unknown as RuntimeStatusBridge;
    const { publisher, published } = makePublisher();
    const { sink } = makeInboxAck();
    const handler = makeHandler({
      client,
      bridge,
      cache,
      events: publisher,
      inboxAck: sink,
    });
    const startPromise = handler.start();
    // Before hydrate resolves: cache has no daemon key, but exit
    // must still surface a status event.
    emit(exitFrame('c1', 'a1', false, 137));
    const status = published.find(p => p.kind === 'agent_status');
    expect(status).toBeDefined();
    const sp = status!.payload as { status: string; exit_code: number | null };
    expect(sp.status).toBe('crashed');
    expect(sp.exit_code).toBe(137);
    // Cache was NOT mutated — gated on daemon key latch.
    expect(cache.list().length).toBe(0);
    // Clean up.
    resolveStatus!({ runtimes: [] });
    await startPromise;
  });

  it('runtime_init_timeout → agent_init_timeout SSE; runtime_init_retrying → agent_status starting (joined with last timeout_reason); runtime_init_cooldown → agent_status crashed', async () => {
    const cache = new RunStateCache();
    const { client, emit } = makeFakeClient();
    const { bridge } = makeBridge({ runtimes: [] });
    const { publisher, published } = makePublisher();
    const { sink } = makeInboxAck();
    const handler = makeHandler({
      client,
      bridge,
      cache,
      events: publisher,
      inboxAck: sink,
    });
    await handler.start();
    emit({
      runtime_generation: 1,
      event: 'runtime_init_timeout',
      conversation_id: 'c1',
      agent_id: 'a1',
      timeout_reason: 'silence',
      elapsed_ms: 500,
      timeout_ms: 300,
      retrying: true,
      retry_attempt: 0,
      max_retries: 2,
      ts: 1700000001000,
    });
    emit({
      runtime_generation: 1,
      event: 'runtime_init_retrying',
      conversation_id: 'c1',
      agent_id: 'a1',
      retry_attempt: 1,
      max_retries: 2,
      delay_ms: 100,
      ts: 1700000001100,
    });
    emit({
      runtime_generation: 1,
      event: 'runtime_init_cooldown',
      conversation_id: 'c1',
      agent_id: 'a1',
      cooldown_until: 1700000099000,
      attempts_exhausted: 2,
      ts: 1700000002000,
    });
    expect(published.map(p => p.kind)).toEqual(['agent_init_timeout', 'agent_status', 'agent_status']);
    // runtime_init_retrying → CM-shaped agent_status starting payload.
    // Frontend status patcher only reads agent_status; a new SSE kind
    // would leave the UI stuck. Cindy `ch9ZsU0v0ATr6tr8` blocker 2.
    const retrying = published[1]!.payload as Record<string, unknown>;
    expect(retrying.status).toBe('starting');
    expect(retrying.reason).toBe('init_timeout_retrying');
    expect(retrying.retry_attempt).toBe(1);
    expect(retrying.max_retries).toBe(2);
    expect(retrying.timeout_reason).toBe('silence');
    // runtime_init_cooldown → crashed.
    const cooldown = published[2]!.payload as Record<string, unknown>;
    expect(cooldown.status).toBe('crashed');
    expect(cooldown.reason).toBe('init_cooldown');
    expect(cooldown.cooldown_until).toBe(1700000099000);
    // Cache untouched by init events.
    expect(cache.list().length).toBe(0);
  });

  it('runtime_init_retrying without a prior runtime_init_timeout omits timeout_reason (still well-formed agent_status)', async () => {
    const cache = new RunStateCache();
    const { client, emit } = makeFakeClient();
    const { bridge } = makeBridge({ runtimes: [] });
    const { publisher, published } = makePublisher();
    const { sink } = makeInboxAck();
    const handler = makeHandler({
      client,
      bridge,
      cache,
      events: publisher,
      inboxAck: sink,
    });
    await handler.start();
    emit({
      runtime_generation: 1,
      event: 'runtime_init_retrying',
      conversation_id: 'c1',
      agent_id: 'a1',
      retry_attempt: 1,
      max_retries: 2,
      delay_ms: 100,
      ts: 1700000001100,
    });
    const status = published.find(p => p.kind === 'agent_status');
    const payload = status!.payload as Record<string, unknown>;
    expect(payload.status).toBe('starting');
    expect(payload.reason).toBe('init_timeout_retrying');
    expect(payload).not.toHaveProperty('timeout_reason');
  });

  it('runtime_exit clears the stashed timeout_reason (no stale bleed into a later unrelated retry)', async () => {
    // Cindy `dMNdrYH0KK1VbDqs` cleanup: exhausted-without-cooldown
    // or fatal-exit paths can produce a runtime_exit without a
    // matching runtime_init_cooldown. Without this clear, the stale
    // reason would wait forever for a runtime_init_retrying that
    // never comes — and if a fresh start later DOES timeout+retry
    // for an unrelated cause, it could inherit the old reason.
    const cache = new RunStateCache();
    const { client, emit } = makeFakeClient();
    const { bridge } = makeBridge({
      runtimes: [
        {
          conversation_id: 'c1',
          agent_id: 'a1',
          runtime_generation: 1,
          pid: 1234,
          phase: 'ready',
          run_state: null,
          started_at: 1700000000000,
        },
      ],
    });
    const { publisher, published } = makePublisher();
    const { sink } = makeInboxAck();
    const handler = makeHandler({
      client,
      bridge,
      cache,
      events: publisher,
      inboxAck: sink,
    });
    await handler.start();
    // Stash a reason …
    emit({
      runtime_generation: 1,
      event: 'runtime_init_timeout',
      conversation_id: 'c1',
      agent_id: 'a1',
      timeout_reason: 'silence',
      elapsed_ms: 500,
      timeout_ms: 300,
      retrying: false,
      retry_attempt: 0,
      max_retries: 0,
      ts: 1700000001000,
    });
    // … then exit without cooldown (e.g. max_retries=0 path).
    emit(exitFrame('c1', 'a1', false, 1));
    // A subsequent unrelated retry on the SAME key must NOT inherit
    // the stale reason.
    emit({
      runtime_generation: 1,
      event: 'runtime_init_retrying',
      conversation_id: 'c1',
      agent_id: 'a1',
      retry_attempt: 1,
      max_retries: 2,
      delay_ms: 100,
      ts: 1700000002000,
    });
    const retrying = published.find(
      p => p.kind === 'agent_status' && (p.payload as Record<string, unknown>).reason === 'init_timeout_retrying',
    );
    expect(retrying!.payload).not.toHaveProperty('timeout_reason');
  });

  it('runtime_state clears stashed timeout_reason (init recovered → next retry would write fresh)', async () => {
    const cache = new RunStateCache();
    const { client, emit } = makeFakeClient();
    const { bridge } = makeBridge({
      runtimes: [
        {
          conversation_id: 'c1',
          agent_id: 'a1',
          runtime_generation: 1,
          pid: 1234,
          phase: 'ready',
          run_state: null,
          started_at: 1700000000000,
        },
      ],
    });
    const { publisher, published } = makePublisher();
    const { sink } = makeInboxAck();
    const handler = makeHandler({
      client,
      bridge,
      cache,
      events: publisher,
      inboxAck: sink,
    });
    await handler.start();
    // Stash a timeout reason …
    emit({
      runtime_generation: 1,
      event: 'runtime_init_timeout',
      conversation_id: 'c1',
      agent_id: 'a1',
      timeout_reason: 'post_protocol',
      elapsed_ms: 1000,
      timeout_ms: 800,
      retrying: true,
      retry_attempt: 0,
      max_retries: 2,
      ts: 1700000001000,
    });
    // … then init recovers (runtime_state arrives).
    emit(runStateFrame('c1', 'a1', RUN_STATE));
    // A later, unrelated retry must NOT inherit the stale reason.
    emit({
      runtime_generation: 1,
      event: 'runtime_init_retrying',
      conversation_id: 'c1',
      agent_id: 'a1',
      retry_attempt: 2,
      max_retries: 2,
      delay_ms: 100,
      ts: 1700000002000,
    });
    const retrying = published.find(
      p => p.kind === 'agent_status' && (p.payload as Record<string, unknown>).reason === 'init_timeout_retrying',
    );
    const payload = retrying!.payload as Record<string, unknown>;
    expect(payload).not.toHaveProperty('timeout_reason');
  });

  it('runtime_ready_for_drain → projects active and invokes onReadyForDrain callback', async () => {
    const cache = new RunStateCache();
    const { client, emit } = makeFakeClient();
    const { bridge } = makeBridge({
      runtimes: [
        {
          conversation_id: 'c1',
          agent_id: 'a1',
          runtime_generation: 1,
          pid: 1234,
          phase: 'startup_pending',
          run_state: null,
          started_at: 1700000000000,
        },
      ],
    });
    const { publisher, published } = makePublisher();
    const { sink } = makeInboxAck();
    const calls: Array<[string, string]> = [];
    const handler = makeHandler({
      client,
      bridge,
      cache,
      events: publisher,
      inboxAck: sink,
      onReadyForDrain(conv, agent) {
        calls.push([conv, agent]);
      },
    });
    await handler.start();
    emit({
      runtime_generation: 1,
      event: 'runtime_ready_for_drain',
      conversation_id: 'c1',
      agent_id: 'a1',
      ts: 1700000001000,
    });
    expect(calls).toEqual([['c1', 'a1']]);
    expect(cache.get('c1', 'a1')?.phase).toBe('ready');
    expect(published).toContainEqual({
      conv: 'c1',
      kind: 'agent_status',
      payload: {
        agent_id: 'a1',
        status: 'active',
      },
    });
  });
});

describe('RuntimeEventHandler — runtime_parsed_event → agent_event projection', () => {
  // Cindy carried-forward commit-5 hard blocker
  // (`ch9ZsU0v0ATr6tr8` + `gePj5qOffE7rDlGw`):
  // - publish under SSE kind `agent_event` (NOT a new kind)
  // - payload shape matches CM `:1338-1341`:
  //   { agent_id, event: ParsedEvent }
  // - tool_call.input MUST flow through sanitizeParsedEventForBroadcast
  //   so large payloads / cycles / depth don't reach the wire

  it('text event passes through as-is on agent_event', async () => {
    const cache = new RunStateCache();
    const { client, emit } = makeFakeClient();
    const { bridge } = makeBridge({
      runtimes: [
        {
          conversation_id: 'c1',
          agent_id: 'a1',
          runtime_generation: 1,
          pid: 1234,
          phase: 'ready',
          run_state: null,
          started_at: 1700000000000,
        },
      ],
    });
    const { publisher, published } = makePublisher();
    const { sink } = makeInboxAck();
    const handler = makeHandler({
      client,
      bridge,
      cache,
      events: publisher,
      inboxAck: sink,
    });
    await handler.start();
    emit({
      runtime_generation: 1,
      event: 'runtime_parsed_event',
      conversation_id: 'c1',
      agent_id: 'a1',
      parsed: { kind: 'text', text: 'hello world' } as never,
      ts: 1700000001000,
    });
    const agentEvent = published.find(p => p.kind === 'agent_event');
    expect(agentEvent).toBeDefined();
    const payload = agentEvent!.payload as {
      agent_id: string;
      event: { kind: string; text?: string };
    };
    expect(payload.agent_id).toBe('a1');
    expect(payload.event.kind).toBe('text');
    expect(payload.event.text).toBe('hello world');
  });

  it('input_lifecycle is diagnostics-only: no agent_event SSE, no activity, no callbacks (#task:1557)', async () => {
    const cache = new RunStateCache();
    const { client, emit } = makeFakeClient();
    const { bridge } = makeBridge({
      runtimes: [
        {
          conversation_id: 'c1',
          agent_id: 'a1',
          runtime_generation: 1,
          pid: 1234,
          phase: 'ready',
          run_state: null,
          started_at: 1700000000000,
        },
      ],
    });
    const { publisher, published } = makePublisher();
    const { sink } = makeInboxAck();
    const activityCalls: unknown[] = [];
    const conversationActivity: ConversationActivitySink = {
      recordParsedEvent(params) {
        activityCalls.push(params);
        return null;
      },
      upsertTextBlock() {
        throw new Error('not used');
      },
      recordParsedEventDropped() {
        throw new Error('not used');
      },
      recordMessageStale() {
        throw new Error('not used');
      },
      refineToolCallInput() {
        throw new Error('not used');
      },
    };
    const logs: Array<Record<string, unknown>> = [];
    const handler = makeHandler({
      client,
      bridge,
      cache,
      events: publisher,
      inboxAck: sink,
      conversationActivity,
      logger: {
        info: (fields: Record<string, unknown>) => {
          logs.push(fields);
        },
        warn: () => {},
        error: () => {},
      } as never,
    });
    await handler.start();
    for (const state of ['queued', 'started', 'completed'] as const) {
      emit({
        runtime_generation: 1,
        event: 'runtime_parsed_event',
        conversation_id: 'c1',
        agent_id: 'a1',
        parsed: { kind: 'input_lifecycle', commandUuid: 'uuid-9', state } as never,
        ts: 1700000001000,
      });
    }
    // Nothing user-visible: no agent_event publish, no activity row.
    expect(published.filter(p => p.kind === 'agent_event')).toEqual([]);
    expect(activityCalls).toEqual([]);
    // Diagnostics exist: one sanitized structured log per frame.
    const lifecycleLogs = logs.filter(l => l['action'] === 'input_lifecycle');
    expect(lifecycleLogs).toHaveLength(3);
    expect(lifecycleLogs[0]).toMatchObject({
      conversationId: 'c1',
      agentId: 'a1',
      state: 'queued',
      command_uuid: 'uuid-9',
    });
  });

  it('persists parsed event before publishing canonical conversation_activity', async () => {
    const cache = new RunStateCache();
    const { client, emit } = makeFakeClient();
    const { bridge } = makeBridge({
      runtimes: [
        {
          conversation_id: 'c1',
          agent_id: 'a1',
          runtime_generation: 1,
          pid: 1234,
          phase: 'ready',
          run_state: null,
          started_at: 1700000000000,
        },
      ],
    });
    const { publisher, published } = makePublisher();
    const { sink } = makeInboxAck();
    const activityCalls: Array<Parameters<ConversationActivitySink['recordParsedEvent']>[0]> = [];
    const conversationActivity: ConversationActivitySink = {
      recordParsedEvent(params) {
        activityCalls.push(params);
        return {
          id: 42,
          conversation_id: params.conversationId,
          agent_id: params.agentId,
          kind: 'tool_call',
          payload: { name: 'Bash' },
          created_at: params.createdAt,
        };
      },
      upsertTextBlock() {
        throw new Error('not used');
      },
      recordParsedEventDropped() {
        throw new Error('not used');
      },
      recordMessageStale() {
        throw new Error('not used');
      },
      refineToolCallInput() {
        throw new Error('not used');
      },
    };
    const handler = makeHandler({
      client,
      bridge,
      cache,
      events: publisher,
      inboxAck: sink,
      conversationActivity,
    });
    await handler.start();
    emit({
      runtime_generation: 1,
      event: 'runtime_parsed_event',
      conversation_id: 'c1',
      agent_id: 'a1',
      parsed: { kind: 'tool_call', name: 'Bash', input: { command: 'pwd' } } as never,
      ts: 1700000001000,
    });

    expect(activityCalls).toEqual([
      {
        conversationId: 'c1',
        agentId: 'a1',
        event: { kind: 'tool_call', name: 'Bash', input: { command: 'pwd' } },
        createdAt: 1700000001000,
      },
    ]);
    expect(published.map(p => p.kind)).toEqual([
      'agent_event',
      'conversation_activity',
    ]);
    expect(published[1]).toEqual({
      conv: 'c1',
      kind: 'conversation_activity',
      payload: {
        id: 42,
        conversation_id: 'c1',
        agent_id: 'a1',
        kind: 'tool_call',
        payload: { name: 'Bash' },
        created_at: 1700000001000,
      },
    });
  });

  it('coalesces consecutive thinking/text fragments and flushes before boundary events', async () => {
    const cache = new RunStateCache();
    const { client, emit } = makeFakeClient();
    const { bridge } = makeBridge({
      runtimes: [
        {
          conversation_id: 'c1',
          agent_id: 'a1',
          runtime_generation: 1,
          pid: 1234,
          phase: 'ready',
          run_state: null,
          started_at: 1700000000000,
        },
      ],
    });
    const { publisher, published } = makePublisher();
    const { sink } = makeInboxAck();
    let nextId = 1;
    const recordCalls: Array<Parameters<ConversationActivitySink['recordParsedEvent']>[0]> = [];
    const textBlockCalls: Array<Parameters<ConversationActivitySink['upsertTextBlock']>[0]> = [];
    const conversationActivity: ConversationActivitySink = {
      recordParsedEvent(params) {
        recordCalls.push(params);
        if (params.event.kind === 'unknown') return null;
        const payload =
          params.event.kind === 'thinking' || params.event.kind === 'text'
            ? { text: params.event.text }
            : params.event.kind === 'tool_call'
              ? { name: params.event.name }
              : null;
        return {
          id: nextId++,
          conversation_id: params.conversationId,
          agent_id: params.agentId,
          kind: params.event.kind as never,
          payload,
          created_at: params.createdAt,
        };
      },
      upsertTextBlock(params) {
        textBlockCalls.push(params);
        return {
          id: params.previousEventId ?? nextId++,
          conversation_id: params.conversationId,
          agent_id: params.agentId,
          kind: params.kind,
          payload: { text: params.text },
          created_at: params.createdAt,
        };
      },
      recordParsedEventDropped() {
        throw new Error('not used');
      },
      recordMessageStale() {
        throw new Error('not used');
      },
      refineToolCallInput() {
        throw new Error('not used');
      },
    };
    const handler = makeHandler({
      client,
      bridge,
      cache,
      events: publisher,
      inboxAck: sink,
      conversationActivity,
    });
    await handler.start();

    emit({
      runtime_generation: 1,
      event: 'runtime_parsed_event',
      conversation_id: 'c1',
      agent_id: 'a1',
      parsed: { kind: 'thinking', text: 'find' } as never,
      ts: 1700000001000,
    });
    emit({
      runtime_generation: 1,
      event: 'runtime_parsed_event',
      conversation_id: 'c1',
      agent_id: 'a1',
      parsed: { kind: 'thinking', text: 'ing' } as never,
      ts: 1700000001001,
    });
    expect(recordCalls).toEqual([]);
    expect(textBlockCalls.map(call => ({
      kind: call.kind,
      text: call.text,
      previousEventId: call.previousEventId ?? null,
    }))).toEqual([
      { kind: 'thinking', text: 'find', previousEventId: null },
    ]);

    emit({
      runtime_generation: 1,
      event: 'runtime_parsed_event',
      conversation_id: 'c1',
      agent_id: 'a1',
      parsed: { kind: 'text', text: 'answer ' } as never,
      ts: 1700000001002,
    });
    expect(recordCalls).toEqual([]);
    emit({
      runtime_generation: 1,
      event: 'runtime_parsed_event',
      conversation_id: 'c1',
      agent_id: 'a1',
      parsed: { kind: 'text', text: 'body' } as never,
      ts: 1700000001003,
    });

    emit({
      runtime_generation: 1,
      event: 'runtime_parsed_event',
      conversation_id: 'c1',
      agent_id: 'a1',
      parsed: { kind: 'tool_call', name: 'Bash', input: { command: 'pwd' } } as never,
      ts: 1700000001004,
    });

    expect(textBlockCalls.map(call => ({
      kind: call.kind,
      text: call.text,
      previousEventId: call.previousEventId ?? null,
    }))).toEqual([
      { kind: 'thinking', text: 'find', previousEventId: null },
      { kind: 'thinking', text: 'finding', previousEventId: 1 },
      { kind: 'text', text: 'answer ', previousEventId: null },
      { kind: 'text', text: 'answer body', previousEventId: 2 },
    ]);
    expect(recordCalls.map(call => call.event)).toEqual([
      { kind: 'tool_call', name: 'Bash', input: { command: 'pwd' } },
    ]);
    expect(textBlockCalls[0]!.createdAt).toBe(1700000001000);
    expect(textBlockCalls[2]!.createdAt).toBe(1700000001002);
    const activityPublishes = published.filter(p => p.kind === 'conversation_activity');
    expect(activityPublishes.map(p => (p.payload as { id: number; kind: string }).id)).toEqual([
      1,
      1,
      2,
      2,
      3,
    ]);
    expect(activityPublishes.map(p => (p.payload as { kind: string }).kind)).toEqual([
      'thinking',
      'thinking',
      'text',
      'text',
      'tool_call',
    ]);
  });

  it('flushes a pending text block when the runtime exits', async () => {
    const cache = new RunStateCache();
    const { client, emit } = makeFakeClient();
    const { bridge } = makeBridge({
      runtimes: [
        {
          conversation_id: 'c1',
          agent_id: 'a1',
          runtime_generation: 1,
          pid: 1234,
          phase: 'ready',
          run_state: null,
          started_at: 1700000000000,
        },
      ],
    });
    const { publisher, published } = makePublisher();
    const { sink } = makeInboxAck();
    const recordCalls: Array<Parameters<ConversationActivitySink['recordParsedEvent']>[0]> = [];
    const textBlockCalls: Array<Parameters<ConversationActivitySink['upsertTextBlock']>[0]> = [];
    const conversationActivity: ConversationActivitySink = {
      recordParsedEvent(params) {
        recordCalls.push(params);
        return {
          id: 7,
          conversation_id: params.conversationId,
          agent_id: params.agentId,
          kind: params.event.kind as never,
          payload: { text: params.event.kind === 'text' ? params.event.text : '' },
          created_at: params.createdAt,
        };
      },
      upsertTextBlock(params) {
        textBlockCalls.push(params);
        return {
          id: params.previousEventId ?? 7,
          conversation_id: params.conversationId,
          agent_id: params.agentId,
          kind: params.kind,
          payload: { text: params.text },
          created_at: params.createdAt,
        };
      },
      recordParsedEventDropped() {
        throw new Error('not used');
      },
      recordMessageStale() {
        throw new Error('not used');
      },
      refineToolCallInput() {
        throw new Error('not used');
      },
    };
    const handler = makeHandler({
      client,
      bridge,
      cache,
      events: publisher,
      inboxAck: sink,
      conversationActivity,
    });
    await handler.start();

    emit({
      runtime_generation: 1,
      event: 'runtime_parsed_event',
      conversation_id: 'c1',
      agent_id: 'a1',
      parsed: { kind: 'text', text: 'partial reply' } as never,
      ts: 1700000001000,
    });
    emit(exitFrame('c1', 'a1', false, 1, 1700000002000));

    expect(textBlockCalls.map(call => ({ kind: call.kind, text: call.text }))).toEqual([
      { kind: 'text', text: 'partial reply' },
      { kind: 'text', text: 'partial reply' },
    ]);
    expect(recordCalls).toEqual([]);
    expect(published.filter(p => p.kind === 'conversation_activity')).toHaveLength(2);
  });

  // #task:2099 (Cindy review point 2): `conversation_events` is a single-author
  // aggregate whose ordering state is the pending text-block buffer. A
  // `message_stale` row written WITHOUT flushing that buffer first would land
  // ahead of prose the agent had already streamed — the row would read as
  // "refused, then spoke". This pins flush-then-record inside ONE
  // `recordConversationActivity` call, published in that order.
  it('#task:2099: message_stale flushes the pending text block first and publishes both rows in order', async () => {
    const cache = new RunStateCache();
    const { client, emit } = makeFakeClient();
    const { bridge } = makeBridge({
      runtimes: [
        {
          conversation_id: 'c1',
          agent_id: 'a1',
          runtime_generation: 1,
          pid: 1234,
          phase: 'ready',
          run_state: null,
          started_at: 1700000000000,
        },
      ],
    });
    const { publisher, published } = makePublisher();
    const { sink } = makeInboxAck();
    const calls: string[] = [];
    const staleCalls: Array<Parameters<ConversationActivitySink['recordMessageStale']>[0]> = [];
    const conversationActivity: ConversationActivitySink = {
      recordParsedEvent() {
        throw new Error('not used');
      },
      upsertTextBlock(params) {
        calls.push(`upsertTextBlock:${params.text}`);
        return {
          id: params.previousEventId ?? 11,
          conversation_id: params.conversationId,
          agent_id: params.agentId,
          kind: params.kind,
          payload: { text: params.text },
          created_at: params.createdAt,
        };
      },
      recordParsedEventDropped() {
        throw new Error('not used');
      },
      recordMessageStale(params) {
        calls.push('recordMessageStale');
        staleCalls.push(params);
        return {
          id: 12,
          conversation_id: params.conversationId,
          agent_id: params.agentId,
          kind: 'message_stale',
          payload: null,
          created_at: params.createdAt,
        };
      },
      refineToolCallInput() {
        throw new Error('not used');
      },
    };
    const handler = makeHandler({
      client,
      bridge,
      cache,
      events: publisher,
      inboxAck: sink,
      conversationActivity,
    });
    await handler.start();

    // Two fragments 1ms apart: the second is buffered WITHOUT a publish (inside
    // the throttle interval), so the only thing that can commit `answer body` is
    // the flush the stale row performs.
    emit({
      runtime_generation: 1,
      event: 'runtime_parsed_event',
      conversation_id: 'c1',
      agent_id: 'a1',
      parsed: { kind: 'text', text: 'answer ' } as never,
      ts: 1700000001000,
    });
    emit({
      runtime_generation: 1,
      event: 'runtime_parsed_event',
      conversation_id: 'c1',
      agent_id: 'a1',
      parsed: { kind: 'text', text: 'body' } as never,
      ts: 1700000001001,
    });
    expect(calls).toEqual(['upsertTextBlock:answer ']);
    const beforeStale = published.length;

    emit({
      event: 'runtime_message_stale',
      runtime_scope: { kind: 'conversation', conversation_id: 'c1', agent_id: 'a1' },
      conversation_id: 'c1',
      agent_id: 'a1',
      runtime_generation: 1,
      ts: 1700000002000,
    });

    expect(calls).toEqual([
      'upsertTextBlock:answer ',
      'upsertTextBlock:answer body',
      'recordMessageStale',
    ]);
    // `createdAt` is the FRAME's ts — the moment the backend refused the send,
    // not when the surrounding turn started.
    expect(staleCalls).toEqual([
      { conversationId: 'c1', agentId: 'a1', createdAt: 1700000002000 },
    ]);
    const activity = published.filter(p => p.kind === 'conversation_activity');
    expect(activity.map(p => (p.payload as { kind: string }).kind)).toEqual([
      'text',
      'text',
      'message_stale',
    ]);
    // Marker-only: no ids, no counts, no refused target on the row.
    expect(activity.at(-1)?.payload).toEqual({
      id: 12,
      conversation_id: 'c1',
      agent_id: 'a1',
      kind: 'message_stale',
      payload: null,
      created_at: 1700000002000,
    });
    // The stale fact is NOT a run-state input: the frame publishes activity only,
    // never an `agent_event` (that lane is the driver's parsed stream).
    expect(published.slice(beforeStale).map(p => p.kind)).toEqual([
      'conversation_activity',
      'conversation_activity',
    ]);
  });

  // #task:2101: a `tool_call_input` frame is a REFINEMENT of a row already in the
  // timeline, so it must not travel the insert path. Same single-author ordering
  // argument as the `message_stale` test above: republishing the older tool_call
  // row while newer prose sits unflushed in the buffer would let the renderer
  // order the refreshed call after text that came later.
  it('#task:2101: tool_call_input refines the existing row, flushing pending text first, and never inserts', async () => {
    const cache = new RunStateCache();
    const { client, emit } = makeFakeClient();
    const { bridge } = makeBridge({
      runtimes: [
        {
          conversation_id: 'c1',
          agent_id: 'a1',
          runtime_generation: 1,
          pid: 1234,
          phase: 'ready',
          run_state: null,
          started_at: 1700000000000,
        },
      ],
    });
    const { publisher, published } = makePublisher();
    const { sink } = makeInboxAck();
    const calls: string[] = [];
    const refineCalls: Array<
      Parameters<ConversationActivitySink['refineToolCallInput']>[0]
    > = [];
    let refineResult: ReturnType<
      ConversationActivitySink['refineToolCallInput']
    > = null;
    const conversationActivity: ConversationActivitySink = {
      recordParsedEvent(params) {
        calls.push(`recordParsedEvent:${params.event.kind}`);
        return null;
      },
      upsertTextBlock(params) {
        calls.push(`upsertTextBlock:${params.text}`);
        return {
          id: params.previousEventId ?? 11,
          conversation_id: params.conversationId,
          agent_id: params.agentId,
          kind: params.kind,
          payload: { text: params.text },
          created_at: params.createdAt,
        };
      },
      recordParsedEventDropped() {
        throw new Error('not used');
      },
      recordMessageStale() {
        throw new Error('not used');
      },
      refineToolCallInput(params) {
        calls.push('refineToolCallInput');
        refineCalls.push(params);
        return refineResult;
      },
    };
    const handler = makeHandler({
      client,
      bridge,
      cache,
      events: publisher,
      inboxAck: sink,
      conversationActivity,
    });
    await handler.start();

    // Two fragments 1ms apart: the second is buffered without a publish, so the
    // only thing that can commit `answer body` is the flush the refinement does.
    emit({
      runtime_generation: 1,
      event: 'runtime_parsed_event',
      conversation_id: 'c1',
      agent_id: 'a1',
      parsed: { kind: 'text', text: 'answer ' } as never,
      ts: 1700000001000,
    });
    emit({
      runtime_generation: 1,
      event: 'runtime_parsed_event',
      conversation_id: 'c1',
      agent_id: 'a1',
      parsed: { kind: 'text', text: 'body' } as never,
      ts: 1700000001001,
    });
    expect(calls).toEqual(['upsertTextBlock:answer ']);

    // The refinement lands on tool_call row id 42 — republished with the SAME
    // id so a live timeline re-renders that line in place.
    refineResult = {
      id: 42,
      conversation_id: 'c1',
      agent_id: 'a1',
      kind: 'tool_call',
      payload: {
        name: 'bash',
        tool_call_id: 'tc-1',
        input: { command: 'silverhand message send' },
      },
      created_at: 1700000000500,
    };
    const beforeRefine = published.length;
    emit({
      runtime_generation: 1,
      event: 'runtime_parsed_event',
      conversation_id: 'c1',
      agent_id: 'a1',
      parsed: {
        kind: 'tool_call_input',
        toolCallId: 'tc-1',
        input: { command: 'silverhand message send' },
      } as never,
      ts: 1700000002000,
    });

    expect(calls).toEqual([
      'upsertTextBlock:answer ',
      'upsertTextBlock:answer body',
      'refineToolCallInput',
    ]);
    // Never the insert path — that would mint a duplicate tool call.
    expect(calls.some(c => c.startsWith('recordParsedEvent:'))).toBe(false);
    expect(refineCalls).toEqual([
      {
        conversationId: 'c1',
        agentId: 'a1',
        toolCallId: 'tc-1',
        input: { command: 'silverhand message send' },
      },
    ]);
    const afterRefine = published.slice(beforeRefine);
    // Unlike `message_stale`, this frame IS driver output, so it rides the
    // `agent_event` lane too — and, as for every parsed event, that publish
    // precedes the activity lane. Within the activity lane the load-bearing
    // order holds: flush first, refreshed row second.
    expect(afterRefine.map(p => p.kind)).toEqual([
      'agent_event',
      'conversation_activity',
      'conversation_activity',
    ]);
    expect(afterRefine.at(-1)?.payload).toEqual(refineResult);

    // A refinement with nothing to refine (row paged out) publishes no activity.
    refineResult = null;
    const beforeMiss = published.length;
    emit({
      runtime_generation: 1,
      event: 'runtime_parsed_event',
      conversation_id: 'c1',
      agent_id: 'a1',
      parsed: {
        kind: 'tool_call_input',
        toolCallId: 'tc-gone',
        input: { command: 'ls' },
      } as never,
      ts: 1700000003000,
    });
    expect(
      published
        .slice(beforeMiss)
        .filter(p => p.kind === 'conversation_activity'),
    ).toHaveLength(0);
  });

  it('final flush reconciles the full text block even when an intermediate upsert is lost', async () => {
    const cache = new RunStateCache();
    const { client, emit } = makeFakeClient();
    const { bridge } = makeBridge({
      runtimes: [
        {
          conversation_id: 'c1',
          agent_id: 'a1',
          runtime_generation: 1,
          pid: 1234,
          phase: 'ready',
          run_state: null,
          started_at: 1700000000000,
        },
      ],
    });
    const { publisher, published } = makePublisher();
    const { sink } = makeInboxAck();
    const upserts: Array<Parameters<ConversationActivitySink['upsertTextBlock']>[0]> = [];
    const conversationActivity: ConversationActivitySink = {
      recordParsedEvent(params) {
        return {
          id: 9,
          conversation_id: params.conversationId,
          agent_id: params.agentId,
          kind: params.event.kind as never,
          payload: null,
          created_at: params.createdAt,
        };
      },
      upsertTextBlock(params) {
        upserts.push(params);
        if (upserts.length === 2) return null;
        return {
          id: params.previousEventId ?? 7,
          conversation_id: params.conversationId,
          agent_id: params.agentId,
          kind: params.kind,
          payload: { text: params.text },
          created_at: params.createdAt,
        };
      },
      recordParsedEventDropped() {
        throw new Error('not used');
      },
      recordMessageStale() {
        throw new Error('not used');
      },
      refineToolCallInput() {
        throw new Error('not used');
      },
    };
    const handler = makeHandler({
      client,
      bridge,
      cache,
      events: publisher,
      inboxAck: sink,
      conversationActivity,
    });
    await handler.start();

    emit({
      runtime_generation: 1,
      event: 'runtime_parsed_event',
      conversation_id: 'c1',
      agent_id: 'a1',
      parsed: { kind: 'thinking', text: 'find' } as never,
      ts: 1700000001000,
    });
    emit({
      runtime_generation: 1,
      event: 'runtime_parsed_event',
      conversation_id: 'c1',
      agent_id: 'a1',
      parsed: { kind: 'thinking', text: 'ing' } as never,
      ts: 1700000002000,
    });
    emit({
      runtime_generation: 1,
      event: 'runtime_parsed_event',
      conversation_id: 'c1',
      agent_id: 'a1',
      parsed: { kind: 'turn_end' } as never,
      ts: 1700000002001,
    });

    expect(upserts.map(u => ({
      text: u.text,
      previousEventId: u.previousEventId ?? null,
    }))).toEqual([
      { text: 'find', previousEventId: null },
      { text: 'finding', previousEventId: 7 },
      { text: 'finding', previousEventId: 7 },
    ]);
    const finalTextBlock = published
      .filter(p => p.kind === 'conversation_activity')
      .map(p => p.payload as { kind: string; payload: { text?: string } | null })
      .reverse()
      .find(p => p.kind === 'thinking');
    expect(finalTextBlock?.payload).toEqual({ text: 'finding' });
  });

  it('caps coalesced text blocks independently of tool input sanitization', async () => {
    const cache = new RunStateCache();
    const { client, emit } = makeFakeClient();
    const { bridge } = makeBridge({
      runtimes: [
        {
          conversation_id: 'c1',
          agent_id: 'a1',
          runtime_generation: 1,
          pid: 1234,
          phase: 'ready',
          run_state: null,
          started_at: 1700000000000,
        },
      ],
    });
    const { publisher } = makePublisher();
    const { sink } = makeInboxAck();
    const activityCalls: Array<
      | { source: 'record'; event: Parameters<ConversationActivitySink['recordParsedEvent']>[0]['event'] }
      | { source: 'text-block'; event: { kind: 'thinking' | 'text'; text: string } }
    > = [];
    const conversationActivity: ConversationActivitySink = {
      recordParsedEvent(params) {
        activityCalls.push({ source: 'record', event: params.event });
        return {
          id: activityCalls.length,
          conversation_id: params.conversationId,
          agent_id: params.agentId,
          kind: params.event.kind as never,
          payload: null,
          created_at: params.createdAt,
        };
      },
      upsertTextBlock(params) {
        activityCalls.push({
          source: 'text-block',
          event: { kind: params.kind, text: params.text },
        });
        return {
          id: params.previousEventId ?? 1,
          conversation_id: params.conversationId,
          agent_id: params.agentId,
          kind: params.kind,
          payload: { text: params.text },
          created_at: params.createdAt,
        };
      },
      recordParsedEventDropped() {
        throw new Error('not used');
      },
      recordMessageStale() {
        throw new Error('not used');
      },
      refineToolCallInput() {
        throw new Error('not used');
      },
    };
    const handler = makeHandler({
      client,
      bridge,
      cache,
      events: publisher,
      inboxAck: sink,
      conversationActivity,
    });
    await handler.start();

    emit({
      runtime_generation: 1,
      event: 'runtime_parsed_event',
      conversation_id: 'c1',
      agent_id: 'a1',
      parsed: { kind: 'thinking', text: 'x'.repeat(10_000) } as never,
      ts: 1700000001000,
    });
    emit({
      runtime_generation: 1,
      event: 'runtime_parsed_event',
      conversation_id: 'c1',
      agent_id: 'a1',
      parsed: { kind: 'thinking', text: 'y'.repeat(10_000) } as never,
      ts: 1700000001001,
    });
    emit({
      runtime_generation: 1,
      event: 'runtime_parsed_event',
      conversation_id: 'c1',
      agent_id: 'a1',
      parsed: { kind: 'turn_end' } as never,
      ts: 1700000001002,
    });

    const block = activityCalls[1]!.event as { kind: 'thinking'; text: string };
    expect(block.kind).toBe('thinking');
    expect(block.text).toContain('<truncated 3616 chars>');
    expect(block.text.length).toBeGreaterThan(16_384);
    expect(activityCalls[2]!.event).toEqual({ kind: 'turn_end' });
  });

  it('large tool_call.input is sanitized BEFORE publish (truncation marker present)', async () => {
    const cache = new RunStateCache();
    const { client, emit } = makeFakeClient();
    const { bridge } = makeBridge({
      runtimes: [
        {
          conversation_id: 'c1',
          agent_id: 'a1',
          runtime_generation: 1,
          pid: 1234,
          phase: 'ready',
          run_state: null,
          started_at: 1700000000000,
        },
      ],
    });
    const { publisher, published } = makePublisher();
    const { sink } = makeInboxAck();
    const handler = makeHandler({
      client,
      bridge,
      cache,
      events: publisher,
      inboxAck: sink,
    });
    await handler.start();
    const huge = 'x'.repeat(2000); // exceeds 500-char cap
    emit({
      runtime_generation: 1,
      event: 'runtime_parsed_event',
      conversation_id: 'c1',
      agent_id: 'a1',
      parsed: {
        kind: 'tool_call',
        toolUseId: 'tu-1',
        name: 'bash',
        input: { command: huge },
      } as never,
      ts: 1700000001100,
    });
    const agentEvent = published.find(p => p.kind === 'agent_event');
    expect(agentEvent).toBeDefined();
    const payload = agentEvent!.payload as {
      event: { input: { command: string } };
    };
    expect(payload.event.input.command.length).toBeLessThan(huge.length);
    expect(payload.event.input.command).toContain('<truncated');
  });

  it('runtime_parsed_event_dropped does NOT produce a fake agent_event', async () => {
    const cache = new RunStateCache();
    const { client, emit } = makeFakeClient();
    const { bridge } = makeBridge({
      runtimes: [
        {
          conversation_id: 'c1',
          agent_id: 'a1',
          runtime_generation: 1,
          pid: 1234,
          phase: 'ready',
          run_state: null,
          started_at: 1700000000000,
        },
      ],
    });
    const { publisher, published } = makePublisher();
    const { sink } = makeInboxAck();
    const warns: object[] = [];
    const handler = makeHandler({
      client,
      bridge,
      cache,
      events: publisher,
      inboxAck: sink,
      logger: {
        info: () => {},
        warn: m => warns.push(m),
        error: () => {},
      },
    });
    await handler.start();
    emit({
      event: 'runtime_parsed_event_dropped',
      conversation_id: 'c1',
      agent_id: 'a1',
      parsed_kind: 'tool_call',
      encoded_bytes: 2_000_000,
      reason: 'frame_too_large',
      ts: 1700000001200,
    });
    // No fake parsed event publish.
    expect(published.find(p => p.kind === 'agent_event')).toBeUndefined();
    // But the operator-visible warn lands so SREs can see it in logs.
    expect(warns.some(w => (w as { event?: string }).event === 'runtime_parsed_event_dropped')).toBe(true);
  });

  it('runtime_parsed_event_dropped projects metadata-only loss onto existing run state', async () => {
    const cache = new RunStateCache();
    const { client, emit } = makeFakeClient();
    const runState = {
      ...RUN_STATE,
      conversationId: 'c1',
      agentId: 'a1',
      status: 'tool_running' as const,
    };
    const { bridge } = makeBridge({
      runtimes: [
        {
          conversation_id: 'c1',
          agent_id: 'a1',
          runtime_generation: 1,
          pid: 1234,
          phase: 'ready',
          run_state: runState,
          started_at: 1700000000000,
        },
      ],
    });
    const { publisher, published } = makePublisher();
    const { sink } = makeInboxAck();
    const handler = makeHandler({
      client,
      bridge,
      cache,
      events: publisher,
      inboxAck: sink,
    });
    await handler.start();

    emit({
      event: 'runtime_parsed_event_dropped',
      conversation_id: 'c1',
      agent_id: 'a1',
      parsed_kind: 'tool_call',
      encoded_bytes: 2_000_000,
      reason: 'frame_too_large',
      ts: 1700000001200,
    });

    expect(published.find(p => p.kind === 'agent_event')).toBeUndefined();
    const activity = published.find(p => p.kind === 'agent_activity');
    expect(activity?.payload).toMatchObject({
      status: 'tool_running',
      detail: 'parsed_event_dropped:tool_call:frame_too_large:2000000',
    });
  });
});

describe('RuntimeEventHandler — cache-not-ready safety', () => {
  it('runtime_state arriving before hydrate completes is dropped (no cache mutation)', async () => {
    const cache = new RunStateCache();
    const { client, emit } = makeFakeClient();
    // Defer the hydrate snapshot so we can fire an event in between.
    let resolveStatus: ((value: RuntimeStatusResult) => void) | null = null;
    const bridge = {
      runtimeStatus: () =>
        new Promise<RuntimeStatusResult>(resolve => {
          resolveStatus = resolve;
        }),
    } as unknown as RuntimeStatusBridge;
    const { publisher, published } = makePublisher();
    const { sink } = makeInboxAck();
    const handler = makeHandler({
      client,
      bridge,
      cache,
      events: publisher,
      inboxAck: sink,
    });
    // Kick start but do NOT await — we want to fire an event before
    // hydrate resolves.
    const startPromise = handler.start();
    // Cache has no daemon key yet; runtime_state must be dropped.
    emit(runStateFrame('c1', 'a1', RUN_STATE));
    expect(cache.list().length).toBe(0);
    expect(published.find(p => p.kind === 'agent_activity')).toBeUndefined();
    // Resolve hydrate to clean up.
    resolveStatus!({ runtimes: [] });
    await startPromise;
  });
});

describe('RuntimeEventHandler — coordinator forwarding hooks (sub-2b-i)', () => {
  // Cindy `3l4bZ5vaMvlC9DVS`: EventHandler hooks ONLY forward events;
  // they must NOT hold queues or issue deliveries. These tests pin the
  // forward-only contract for `onParsedEvent` and `onRuntimeExit`.

  function setup(opts: { withCallbacks?: boolean } = {}): {
    cache: RunStateCache;
    emit: (frame: Record<string, unknown>) => void;
    handler: RuntimeEventHandler;
    parsedCalls: Array<{ conv: string; agent: string; event: unknown }>;
    exitCalls: Array<{
      conv: string;
      agent: string;
      meta: {
        intentional: boolean;
        code: number | null;
        initTimedOut: boolean;
        fatalError: boolean;
      };
    }>;
    initTimeoutCalls: Array<{ conv: string; agent: string }>;
    publishedAgentStatus: () => Array<{ conv: string; payload: unknown }>;
  } {
    const cache = new RunStateCache();
    const { client, emit } = makeFakeClient();
    const { bridge } = makeBridge({
      runtimes: [
        {
          conversation_id: 'c1',
          agent_id: 'a1',
          runtime_generation: 1,
          pid: 1234,
          phase: 'ready',
          run_state: null,
          started_at: 1700000000000,
        },
      ],
    });
    const { publisher, published } = makePublisher();
    const { sink } = makeInboxAck();
    const parsedCalls: Array<{ conv: string; agent: string; event: unknown }> = [];
    const exitCalls: Array<{
      conv: string;
      agent: string;
      meta: {
        intentional: boolean;
        code: number | null;
        initTimedOut: boolean;
        fatalError: boolean;
      };
    }> = [];
    const initTimeoutCalls: Array<{ conv: string; agent: string }> = [];
    const handler = makeHandler({
      client,
      bridge,
      cache,
      events: publisher,
      inboxAck: sink,
      ...(opts.withCallbacks === false
        ? {}
        : {
            onParsedEvent: (conv, agent, event) => parsedCalls.push({ conv, agent, event }),
            onRuntimeExit: (conv, agent, meta) => exitCalls.push({ conv, agent, meta }),
            onInitTimeout: (conv, agent) => initTimeoutCalls.push({ conv, agent }),
          }),
    });
    return {
      cache,
      emit,
      handler,
      parsedCalls,
      exitCalls,
      initTimeoutCalls,
      publishedAgentStatus: () =>
        published.filter(p => p.kind === 'agent_status').map(p => ({ conv: p.conv, payload: p.payload })),
    };
  }

  it('onParsedEvent receives RAW parsed payload (not sanitized)', async () => {
    const { handler, emit, parsedCalls } = setup();
    await handler.start();
    const hugeInput = 'x'.repeat(2000); // would be truncated by the sanitizer
    emit({
      runtime_generation: 1,
      event: 'runtime_parsed_event',
      conversation_id: 'c1',
      agent_id: 'a1',
      parsed: {
        kind: 'tool_call',
        name: 'bash',
        input: { command: hugeInput },
      } as never,
      ts: 1700000001100,
    });
    expect(parsedCalls).toHaveLength(1);
    const ev = parsedCalls[0]!.event as {
      kind: string;
      input: { command: string };
    };
    expect(ev.kind).toBe('tool_call');
    // Raw payload preserved verbatim — sanitization is a UI boundary.
    expect(ev.input.command).toBe(hugeInput);
    expect(ev.input.command.length).toBe(2000);
  });

  it('onRuntimeExit fires AFTER agent_status publish; carries derived flags', async () => {
    const { handler, emit, exitCalls, publishedAgentStatus } = setup();
    await handler.start();
    emit({
      runtime_generation: 1,
      event: 'runtime_exit',
      conversation_id: 'c1',
      agent_id: 'a1',
      code: 0,
      intentional: true,
      ts: 1700000002000,
    });
    expect(publishedAgentStatus()).toHaveLength(1);
    expect(exitCalls).toHaveLength(1);
    expect(exitCalls[0]).toEqual({
      conv: 'c1',
      agent: 'a1',
      meta: {
        scope: {
          kind: 'conversation',
          conversationId: 'c1',
          agentId: 'a1',
        },
        custody: {
          generation: 1,
          daemonInstanceId: 'daemon-test',
        },
        projectionFinalized: false,
        intentional: true,
        code: 0,
        initTimedOut: false,
        fatalError: false,
      },
    });
  });

  it('initTimedOut derived from runtime_init_cooldown before exit', async () => {
    const { handler, emit, exitCalls } = setup();
    await handler.start();
    emit({
      runtime_generation: 1,
      event: 'runtime_init_cooldown',
      conversation_id: 'c1',
      agent_id: 'a1',
      cooldown_until: 1700000003000,
      attempts_exhausted: 3,
      ts: 1700000002500,
    });
    emit({
      runtime_generation: 1,
      event: 'runtime_exit',
      conversation_id: 'c1',
      agent_id: 'a1',
      code: 1,
      intentional: false,
      ts: 1700000002600,
    });
    expect(exitCalls[0]!.meta.initTimedOut).toBe(true);
    expect(exitCalls[0]!.meta.fatalError).toBe(false);
  });

  it('initTimedOut also derived from runtime_init_timeout with retrying=false', async () => {
    const { handler, emit, exitCalls } = setup();
    await handler.start();
    emit({
      runtime_generation: 1,
      event: 'runtime_init_timeout',
      conversation_id: 'c1',
      agent_id: 'a1',
      timeout_reason: 'silence',
      elapsed_ms: 30000,
      timeout_ms: 30000,
      retrying: false,
      retry_attempt: 2,
      max_retries: 2,
      ts: 1700000002400,
    });
    emit({
      runtime_generation: 1,
      event: 'runtime_exit',
      conversation_id: 'c1',
      agent_id: 'a1',
      code: null,
      intentional: false,
      ts: 1700000002500,
    });
    expect(exitCalls[0]!.meta.initTimedOut).toBe(true);
  });

  it('runtime_init_timeout and runtime_init_cooldown forward to onInitTimeout', async () => {
    const { handler, emit, initTimeoutCalls } = setup();
    await handler.start();
    emit({
      runtime_generation: 1,
      event: 'runtime_init_timeout',
      conversation_id: 'c1',
      agent_id: 'a1',
      timeout_reason: 'silence',
      elapsed_ms: 30000,
      timeout_ms: 30000,
      retrying: true,
      retry_attempt: 0,
      max_retries: 1,
      ts: 1700000002400,
    });
    emit({
      runtime_generation: 1,
      event: 'runtime_init_cooldown',
      conversation_id: 'c1',
      agent_id: 'a1',
      cooldown_until: 1700000003000,
      attempts_exhausted: 2,
      ts: 1700000002500,
    });
    expect(initTimeoutCalls).toEqual([
      { conv: 'c1', agent: 'a1' },
      { conv: 'c1', agent: 'a1' },
    ]);
  });

  it('runtime_init_timeout with retrying=true does NOT set initTimedOut', async () => {
    const { handler, emit, exitCalls } = setup();
    await handler.start();
    emit({
      runtime_generation: 1,
      event: 'runtime_init_timeout',
      conversation_id: 'c1',
      agent_id: 'a1',
      timeout_reason: 'silence',
      elapsed_ms: 30000,
      timeout_ms: 30000,
      retrying: true,
      retry_attempt: 0,
      max_retries: 2,
      ts: 1700000002400,
    });
    emit({
      runtime_generation: 1,
      event: 'runtime_exit',
      conversation_id: 'c1',
      agent_id: 'a1',
      code: 1,
      intentional: false,
      ts: 1700000002500,
    });
    expect(exitCalls[0]!.meta.initTimedOut).toBe(false);
  });

  it('fatalError derived from parsed error event with fatal=true', async () => {
    const { handler, emit, exitCalls } = setup();
    await handler.start();
    emit({
      runtime_generation: 1,
      event: 'runtime_parsed_event',
      conversation_id: 'c1',
      agent_id: 'a1',
      parsed: {
        kind: 'error',
        message: 'thread not found',
        code: 'thread_not_found',
        fatal: true,
      } as never,
      ts: 1700000002400,
    });
    emit({
      runtime_generation: 1,
      event: 'runtime_exit',
      conversation_id: 'c1',
      agent_id: 'a1',
      code: 1,
      intentional: false,
      ts: 1700000002500,
    });
    expect(exitCalls[0]!.meta.fatalError).toBe(true);
    expect(exitCalls[0]!.meta.initTimedOut).toBe(false);
  });

  it('parsed error with fatal omitted does NOT set fatalError', async () => {
    const { handler, emit, exitCalls } = setup();
    await handler.start();
    emit({
      runtime_generation: 1,
      event: 'runtime_parsed_event',
      conversation_id: 'c1',
      agent_id: 'a1',
      parsed: {
        kind: 'error',
        message: 'recoverable error',
      } as never,
      ts: 1700000002400,
    });
    emit({
      runtime_generation: 1,
      event: 'runtime_exit',
      conversation_id: 'c1',
      agent_id: 'a1',
      code: 1,
      intentional: false,
      ts: 1700000002500,
    });
    expect(exitCalls[0]!.meta.fatalError).toBe(false);
  });

  it('flags do not leak between (conv, agent) pairs', async () => {
    const { handler, emit, exitCalls } = setup();
    await handler.start();
    // Init failure on c1/a1.
    emit({
      runtime_generation: 1,
      event: 'runtime_init_cooldown',
      conversation_id: 'c1',
      agent_id: 'a1',
      cooldown_until: 1700000003000,
      attempts_exhausted: 3,
      ts: 1700000002500,
    });
    // Exit on c2/a2 must NOT inherit c1/a1's flag.
    emit({
      runtime_generation: 1,
      event: 'runtime_exit',
      conversation_id: 'c2',
      agent_id: 'a2',
      code: 0,
      intentional: false,
      ts: 1700000002600,
    });
    const c2Exit = exitCalls.find(e => e.conv === 'c2');
    expect(c2Exit?.meta.initTimedOut).toBe(false);
  });

  it('throwing onParsedEvent callback is logged and does NOT break SSE projection', async () => {
    const cache = new RunStateCache();
    const { client, emit } = makeFakeClient();
    const { bridge } = makeBridge({
      runtimes: [
        {
          conversation_id: 'c1',
          agent_id: 'a1',
          runtime_generation: 1,
          pid: 1234,
          phase: 'ready',
          run_state: null,
          started_at: 1700000000000,
        },
      ],
    });
    const { publisher, published } = makePublisher();
    const { sink } = makeInboxAck();
    const errorLogs: Array<{ meta: unknown; msg: string }> = [];
    const logger = {
      info: () => {},
      warn: () => {},
      error: (meta: object, msg: string) => errorLogs.push({ meta, msg }),
    };
    const handler = makeHandler({
      client,
      bridge,
      cache,
      events: publisher,
      inboxAck: sink,
      onParsedEvent: () => {
        throw new Error('boom');
      },
      logger,
    });
    await handler.start();
    emit({
      runtime_generation: 1,
      event: 'runtime_parsed_event',
      conversation_id: 'c1',
      agent_id: 'a1',
      parsed: { kind: 'text', text: 'hi' } as never,
      ts: 1700000001000,
    });
    // SSE projection still ran.
    expect(published.find(p => p.kind === 'agent_event')).toBeDefined();
    // Error was logged.
    expect(errorLogs).toHaveLength(1);
    expect(errorLogs[0]!.msg).toContain('onParsedEvent');
  });

  it('omitting callbacks is allowed — no crash, projection unchanged', async () => {
    const { handler, emit, publishedAgentStatus } = setup({
      withCallbacks: false,
    });
    await handler.start();
    emit({
      runtime_generation: 1,
      event: 'runtime_parsed_event',
      conversation_id: 'c1',
      agent_id: 'a1',
      parsed: { kind: 'text', text: 'hi' } as never,
      ts: 1700000001000,
    });
    emit({
      runtime_generation: 1,
      event: 'runtime_exit',
      conversation_id: 'c1',
      agent_id: 'a1',
      code: 0,
      intentional: true,
      ts: 1700000002000,
    });
    expect(publishedAgentStatus()).toHaveLength(1);
  });

  // ── Cindy `rrF2L1RmWq5JFH3m` B1 regression: terminal runtime_state
  //    must NOT clear gate flags. RealSupervisor emits terminal state
  //    BEFORE the matching runtime_exit; clearing flags on terminal
  //    state would mislead the coordinator's auto-respawn gate.
  it('B1: terminal runtime_state preserves initTimedOut flag for the trailing exit', async () => {
    const { handler, emit, exitCalls } = setup();
    await handler.start();
    emit({
      runtime_generation: 1,
      event: 'runtime_init_timeout',
      conversation_id: 'c1',
      agent_id: 'a1',
      timeout_reason: 'silence',
      elapsed_ms: 30000,
      timeout_ms: 30000,
      retrying: false,
      retry_attempt: 2,
      max_retries: 2,
      ts: 1700000002300,
    });
    // RealSupervisor publishes a terminal `runtime_state` BEFORE the
    // matching `runtime_exit` to flush the run resolution. Terminal
    // state must NOT strip the flag.
    emit(runStateFrame('c1', 'a1', { ...RUN_STATE, status: 'failed', terminalReason: 'timeout' }, 1700000002400));
    emit({
      runtime_generation: 1,
      event: 'runtime_exit',
      conversation_id: 'c1',
      agent_id: 'a1',
      code: null,
      intentional: false,
      ts: 1700000002500,
    });
    expect(exitCalls[0]!.meta.initTimedOut).toBe(true);
  });

  it('B1: terminal runtime_state preserves fatalError flag for the trailing exit', async () => {
    const { handler, emit, exitCalls } = setup();
    await handler.start();
    emit({
      runtime_generation: 1,
      event: 'runtime_parsed_event',
      conversation_id: 'c1',
      agent_id: 'a1',
      parsed: {
        kind: 'error',
        message: 'thread not found',
        fatal: true,
      } as never,
      ts: 1700000002300,
    });
    emit(runStateFrame('c1', 'a1', { ...RUN_STATE, status: 'failed', terminalReason: 'crashed' }, 1700000002400));
    emit({
      runtime_generation: 1,
      event: 'runtime_exit',
      conversation_id: 'c1',
      agent_id: 'a1',
      code: 1,
      intentional: false,
      ts: 1700000002500,
    });
    expect(exitCalls[0]!.meta.fatalError).toBe(true);
  });

  it('B1: non-terminal runtime_state still clears flags (recovery semantics)', async () => {
    const { handler, emit, exitCalls } = setup();
    await handler.start();
    emit({
      runtime_generation: 1,
      event: 'runtime_parsed_event',
      conversation_id: 'c1',
      agent_id: 'a1',
      parsed: {
        kind: 'error',
        message: 'fatal',
        fatal: true,
      } as never,
      ts: 1700000002300,
    });
    // Non-terminal state (no terminalReason) — agent recovered.
    emit(runStateFrame('c1', 'a1', RUN_STATE, 1700000002400));
    emit({
      runtime_generation: 1,
      event: 'runtime_exit',
      conversation_id: 'c1',
      agent_id: 'a1',
      code: 0,
      intentional: false,
      ts: 1700000002500,
    });
    expect(exitCalls[0]!.meta.fatalError).toBe(false);
  });

  // ── Cindy `rrF2L1RmWq5JFH3m` B2 regression: agent_status SSE must
  //    use the derived flags. fatal-error + exit code 0 must publish
  //    'crashed', not 'idle'.
  it('B2: fatal-error then exit code=0 publishes agent_status crashed', async () => {
    const { handler, emit, exitCalls, publishedAgentStatus } = setup();
    await handler.start();
    emit({
      runtime_generation: 1,
      event: 'runtime_parsed_event',
      conversation_id: 'c1',
      agent_id: 'a1',
      parsed: {
        kind: 'error',
        message: 'thread not found',
        fatal: true,
      } as never,
      ts: 1700000002300,
    });
    emit({
      runtime_generation: 1,
      event: 'runtime_exit',
      conversation_id: 'c1',
      agent_id: 'a1',
      code: 0, // exit 0 would normally be 'idle' — fatalError forces crashed
      intentional: false,
      ts: 1700000002500,
    });
    const statuses = publishedAgentStatus();
    expect(statuses).toHaveLength(1);
    const payload = statuses[0]!.payload as { status: string };
    expect(payload.status).toBe('crashed');
    expect(exitCalls[0]!.meta.fatalError).toBe(true);
  });

  it('B2: init-cooldown then exit code=0 publishes agent_status crashed', async () => {
    const { handler, emit, publishedAgentStatus } = setup();
    await handler.start();
    emit({
      runtime_generation: 1,
      event: 'runtime_init_cooldown',
      conversation_id: 'c1',
      agent_id: 'a1',
      cooldown_until: 1700000003000,
      attempts_exhausted: 3,
      ts: 1700000002400,
    });
    // Drop the init_cooldown SSE event so we can inspect just the exit
    // status mapping; clear out anything published so far.
    const baseline = publishedAgentStatus().length;
    emit({
      runtime_generation: 1,
      event: 'runtime_exit',
      conversation_id: 'c1',
      agent_id: 'a1',
      code: 0,
      intentional: false,
      ts: 1700000002500,
    });
    const statuses = publishedAgentStatus();
    expect(statuses.length).toBe(baseline + 1);
    const payload = statuses[statuses.length - 1]!.payload as {
      status: string;
    };
    expect(payload.status).toBe('crashed');
  });

  it('B2: benign exit (intentional=true) still maps to idle', async () => {
    const { handler, emit, publishedAgentStatus } = setup();
    await handler.start();
    emit({
      runtime_generation: 1,
      event: 'runtime_exit',
      conversation_id: 'c1',
      agent_id: 'a1',
      code: 0,
      intentional: true,
      ts: 1700000002500,
    });
    const statuses = publishedAgentStatus();
    expect(statuses).toHaveLength(1);
    const payload = statuses[0]!.payload as { status: string };
    expect(payload.status).toBe('idle');
  });
});

// B1 (Cindy `usjxj8AxX4AvJ5E-`): the handler routes
// status-mutating events to the `RuntimeStatusProjector` sink. These
// tests pin the routing contract — they don't re-test the sink's
// DB+SSE behavior (that's in status-projector.test.ts) — only that
// the handler hands the projector the right input for each event.
describe('RuntimeEventHandler — projector routing (B1)', () => {
  interface ProjectorCall {
    kind: 'sessionInit' | 'runtimeReady' | 'runtimeExit' | 'initRetrying' | 'initCooldown';
    input: Record<string, unknown>;
  }

  function makeRecordingProjector(): {
    projector: RuntimeStatusProjector;
    calls: ProjectorCall[];
  } {
    const calls: ProjectorCall[] = [];
    const projector: RuntimeStatusProjector = {
      publishStatus: () => {},
      sessionInit: input => calls.push({ kind: 'sessionInit', input: { ...input } }),
      runtimeReady: input => calls.push({ kind: 'runtimeReady', input: { ...input } }),
      runtimeExit: input => {
        calls.push({ kind: 'runtimeExit', input: { ...input } });
        return null;
      },
      initRetrying: input => calls.push({ kind: 'initRetrying', input: { ...input } }),
      initCooldown: input => calls.push({ kind: 'initCooldown', input: { ...input } }),
    };
    return { projector, calls };
  }

  it('drops a stale generation before projection, SSE, or coordinator callbacks', async () => {
    const cache = new RunStateCache();
    const { client, emit } = makeFakeClient();
    const { bridge } = makeBridge({ runtimes: [] });
    const { publisher, published } = makePublisher();
    const { sink } = makeInboxAck();
    const { projector, calls } = makeRecordingProjector();
    const parsedCalls: unknown[] = [];
    const handler = new RuntimeEventHandler({
      client,
      bridge,
      cache,
      events: publisher,
      inboxAck: sink,
      statusProjector: projector,
      daemonInstanceId: () => 'daemon-test',
      acceptRuntimeCustody: () => false,
      onParsedEvent: (...input) => parsedCalls.push(input),
    });
    await handler.start();
    emit({
      event: 'runtime_parsed_event',
      conversation_id: 'c1',
      agent_id: 'a1',
      runtime_generation: 1,
      parsed: { kind: 'session_init', sessionId: 'late-session' },
      ts: 1700000001000,
    });
    expect(calls).toEqual([]);
    expect(published).toEqual([]);
    expect(parsedCalls).toEqual([]);
  });

  it('rejects an origin outside a ConversationSlot scope before delivery ack side effects', async () => {
    const cache = new RunStateCache();
    const { client, emit } = makeFakeClient();
    const { bridge } = makeBridge({ runtimes: [] });
    const { publisher } = makePublisher();
    const { sink, delivered } = makeInboxAck();
    const handler = makeHandler({
      client,
      bridge,
      cache,
      events: publisher,
      inboxAck: sink,
    });
    await handler.start();

    emit({
      event: 'runtime_delivery_consumed',
      runtime_scope: {
        kind: 'conversation',
        conversation_id: 'c1',
        agent_id: 'a1',
      },
      conversation_id: 'c2',
      agent_id: 'a1',
      delivery_ids: [41],
      ts: 1700000001000,
    });
    expect(delivered).toEqual([]);

    emit({
      event: 'runtime_delivery_consumed',
      runtime_scope: { kind: 'agent', agent_id: 'a1' },
      conversation_id: 'c2',
      agent_id: 'a1',
      delivery_ids: [42],
      ts: 1700000001001,
    });
    expect(delivered).toEqual([[42]]);
  });

  it('runtime_parsed_event(session_init) → projector.sessionInit with cliSessionId', async () => {
    const cache = new RunStateCache();
    const { client, emit } = makeFakeClient();
    const { bridge } = makeBridge({ runtimes: [] });
    const { publisher } = makePublisher();
    const { sink } = makeInboxAck();
    const { projector, calls } = makeRecordingProjector();
    const handler = new RuntimeEventHandler({
      client,
      bridge,
      cache,
      events: publisher,
      inboxAck: sink,
      statusProjector: projector,
      daemonInstanceId: () => 'daemon-test',
    });
    await handler.start();
    emit({
      event: 'runtime_parsed_event',
      conversation_id: 'c1',
      agent_id: 'a1',
      parsed: { kind: 'session_init', sessionId: 'sess-routed-9999' },
      runtime_generation: 1,
      ts: 1700000001000,
    });
    expect(calls).toEqual([
      {
        kind: 'sessionInit',
        input: {
          scope: {
            kind: 'conversation',
            conversationId: 'c1',
            agentId: 'a1',
          },
          conversationId: 'c1',
          agentId: 'a1',
          cliSessionId: 'sess-routed-9999',
          custody: { generation: 1, daemonInstanceId: 'daemon-test' },
        },
      },
    ]);
  });

  it('runtime_parsed_event(non-session_init) → projector.sessionInit NOT called', async () => {
    const cache = new RunStateCache();
    const { client, emit } = makeFakeClient();
    const { bridge } = makeBridge({ runtimes: [] });
    const { publisher } = makePublisher();
    const { sink } = makeInboxAck();
    const { projector, calls } = makeRecordingProjector();
    const handler = new RuntimeEventHandler({
      client,
      bridge,
      cache,
      events: publisher,
      inboxAck: sink,
      statusProjector: projector,
      daemonInstanceId: () => 'daemon-test',
    });
    await handler.start();
    emit({
      runtime_generation: 1,
      event: 'runtime_parsed_event',
      conversation_id: 'c1',
      agent_id: 'a1',
      parsed: { kind: 'thinking', text: 'pondering' },
      ts: 1700000001000,
    });
    expect(calls).toHaveLength(0);
  });

  it('runtime_ready_for_drain → projector.runtimeReady before first session_init', async () => {
    const cache = new RunStateCache();
    const { client, emit } = makeFakeClient();
    const { bridge } = makeBridge({ runtimes: [] });
    const { publisher } = makePublisher();
    const { sink } = makeInboxAck();
    const { projector, calls } = makeRecordingProjector();
    const handler = new RuntimeEventHandler({
      client,
      bridge,
      cache,
      events: publisher,
      inboxAck: sink,
      statusProjector: projector,
      daemonInstanceId: () => 'daemon-test',
    });
    await handler.start();
    emit({
      event: 'runtime_ready_for_drain',
      conversation_id: 'c1',
      agent_id: 'a1',
      runtime_generation: 1,
      ts: 1700000001000,
    });
    expect(calls).toEqual([
      {
        kind: 'runtimeReady',
        input: {
          scope: {
            kind: 'conversation',
            conversationId: 'c1',
            agentId: 'a1',
          },
          conversationId: 'c1',
          agentId: 'a1',
          custody: { generation: 1, daemonInstanceId: 'daemon-test' },
        },
      },
    ]);
  });

  it('runtime_exit → projector.runtimeExit with intentional+code+initTimedOut+fatalError+runState', async () => {
    const cache = new RunStateCache();
    const { client, emit } = makeFakeClient();
    const { bridge } = makeBridge({
      runtimes: [
        {
          conversation_id: 'c1',
          agent_id: 'a1',
          runtime_generation: 1,
          pid: 1234,
          phase: 'ready',
          run_state: RUN_STATE,
          started_at: 1700000000000,
        },
      ],
    });
    const { publisher } = makePublisher();
    const { sink } = makeInboxAck();
    const { projector, calls } = makeRecordingProjector();
    const handler = new RuntimeEventHandler({
      client,
      bridge,
      cache,
      events: publisher,
      inboxAck: sink,
      statusProjector: projector,
      daemonInstanceId: () => 'daemon-test',
    });
    await handler.start();
    emit(exitFrame('c1', 'a1', false, 137));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.kind).toBe('runtimeExit');
    expect(calls[0]!.input).toMatchObject({
      conversationId: 'c1',
      agentId: 'a1',
      intentional: false,
      code: 137,
      initTimedOut: false,
      fatalError: false,
    });
    // Handler MUST NOT compute status itself — the input carries the
    // raw fields plus the gating flags it snapshotted; the projector
    // owns the status mapping.
    expect(calls[0]!.input).not.toHaveProperty('status');
  });

  it('runtime_exit clears cli_session_id after stale resume-target fatal errors', async () => {
    const cache = new RunStateCache();
    const { client, emit } = makeFakeClient();
    const { bridge } = makeBridge({ runtimes: [] });
    const { publisher } = makePublisher();
    const { sink } = makeInboxAck();
    const { projector, calls } = makeRecordingProjector();
    const handler = new RuntimeEventHandler({
      client,
      bridge,
      cache,
      events: publisher,
      inboxAck: sink,
      statusProjector: projector,
      daemonInstanceId: () => 'daemon-test',
    });
    await handler.start();

    emit({
      event: 'runtime_parsed_event',
      conversation_id: 'c1',
      agent_id: 'a1',
      parsed: {
        kind: 'error',
        message: 'session sess-old is archived',
        code: 'session_archived',
        fatal: true,
      },
      runtime_generation: 1,
      ts: 1700000001000,
    });
    emit(exitFrame('c1', 'a1', false, 1, 1700000001100));

    expect(calls.find(c => c.kind === 'runtimeExit')?.input).toMatchObject({
      conversationId: 'c1',
      agentId: 'a1',
      fatalError: true,
      clearCliSessionId: true,
    });
  });

  it('runtime_exit preserves cli_session_id for other fatal runtime errors', async () => {
    const cache = new RunStateCache();
    const { client, emit } = makeFakeClient();
    const { bridge } = makeBridge({ runtimes: [] });
    const { publisher } = makePublisher();
    const { sink } = makeInboxAck();
    const { projector, calls } = makeRecordingProjector();
    const handler = new RuntimeEventHandler({
      client,
      bridge,
      cache,
      events: publisher,
      inboxAck: sink,
      statusProjector: projector,
      daemonInstanceId: () => 'daemon-test',
    });
    await handler.start();

    emit({
      event: 'runtime_parsed_event',
      conversation_id: 'c1',
      agent_id: 'a1',
      parsed: {
        kind: 'error',
        message: 'provider rejected request',
        code: 'provider_error',
        fatal: true,
      },
      runtime_generation: 1,
      ts: 1700000001000,
    });
    emit(exitFrame('c1', 'a1', false, 1, 1700000001100));

    expect(calls.find(c => c.kind === 'runtimeExit')?.input).toMatchObject({
      fatalError: true,
    });
    expect(calls.find(c => c.kind === 'runtimeExit')?.input).not.toHaveProperty(
      'clearCliSessionId',
    );
  });

  it('runtime_init_retrying → projector.initRetrying with retry_attempt + timeout_reason (re-joined)', async () => {
    const cache = new RunStateCache();
    const { client, emit } = makeFakeClient();
    const { bridge } = makeBridge({ runtimes: [] });
    const { publisher } = makePublisher();
    const { sink } = makeInboxAck();
    const { projector, calls } = makeRecordingProjector();
    const handler = new RuntimeEventHandler({
      client,
      bridge,
      cache,
      events: publisher,
      inboxAck: sink,
      statusProjector: projector,
      daemonInstanceId: () => 'daemon-test',
    });
    await handler.start();
    // Seed lastTimeoutReason via the prior init_timeout event.
    emit({
      event: 'runtime_init_timeout',
      conversation_id: 'c1',
      agent_id: 'a1',
      timeout_reason: 'silence',
      elapsed_ms: 30000,
      timeout_ms: 30000,
      retrying: true,
      retry_attempt: 1,
      max_retries: 3,
      runtime_generation: 1,
      ts: 1700000001000,
    });
    emit({
      event: 'runtime_init_retrying',
      conversation_id: 'c1',
      agent_id: 'a1',
      retry_attempt: 2,
      max_retries: 3,
      delay_ms: 1000,
      runtime_generation: 1,
      ts: 1700000002000,
    });
    const retryCall = calls.find(c => c.kind === 'initRetrying');
    expect(retryCall).toBeDefined();
    expect(retryCall!.input).toEqual({
      scope: {
        kind: 'conversation',
        conversationId: 'c1',
        agentId: 'a1',
      },
      conversationId: 'c1',
      agentId: 'a1',
      retryAttempt: 2,
      maxRetries: 3,
      timeoutReason: 'silence',
      custody: { generation: 1, daemonInstanceId: 'daemon-test' },
    });
  });

  it('runtime_init_cooldown → projector.initCooldown with cooldown_until + attempts_exhausted', async () => {
    const cache = new RunStateCache();
    const { client, emit } = makeFakeClient();
    const { bridge } = makeBridge({ runtimes: [] });
    const { publisher } = makePublisher();
    const { sink } = makeInboxAck();
    const { projector, calls } = makeRecordingProjector();
    const handler = new RuntimeEventHandler({
      client,
      bridge,
      cache,
      events: publisher,
      inboxAck: sink,
      statusProjector: projector,
      daemonInstanceId: () => 'daemon-test',
    });
    await handler.start();
    emit({
      event: 'runtime_init_cooldown',
      conversation_id: 'c1',
      agent_id: 'a1',
      cooldown_until: 1700000999000,
      attempts_exhausted: 3,
      runtime_generation: 1,
      ts: 1700000001000,
    });
    expect(calls).toEqual([
      {
        kind: 'initCooldown',
        input: {
          scope: {
            kind: 'conversation',
            conversationId: 'c1',
            agentId: 'a1',
          },
          conversationId: 'c1',
          agentId: 'a1',
          cooldownUntil: 1700000999000,
          attemptsExhausted: 3,
          custody: { generation: 1, daemonInstanceId: 'daemon-test' },
        },
      },
    ]);
  });
});

describe('hydrate retry — #task:1588 P1-3 (bounded same-generation recovery)', () => {
  function makeFlakyBridge(failures: number): {
    bridge: RuntimeStatusBridge;
    statusCalls: () => number;
  } {
    let count = 0;
    const bridge = {
      runtimeStatus: async () => {
        count += 1;
        if (count <= failures) throw new Error(`hydrate boom #${count}`);
        return normalizeStatusSnapshot({
          runtimes: [
            {
              conversation_id: 'c1',
              agent_id: 'a1',
              runtime_generation: 1,
              pid: 42,
              phase: 'ready',
              run_state: null,
              started_at: 1700000000000,
            },
          ],
        });
      },
    } as unknown as RuntimeStatusBridge;
    return { bridge, statusCalls: () => count };
  }

  it('a failed hydrate retries on the bounded backoff and recovers within the same generation', async () => {
    vi.useFakeTimers();
    try {
      const cache = new RunStateCache();
      const { client } = makeFakeClient();
      const { bridge, statusCalls } = makeFlakyBridge(2);
      const { publisher } = makePublisher();
      const { sink } = makeInboxAck();
      const hydrateCompletes: string[] = [];
      const handler = makeHandler({
        client,
        bridge,
        cache,
        events: publisher,
        inboxAck: sink,
        onHydrateComplete: trigger => {
          hydrateCompletes.push(trigger);
        },
      });

      await handler.start(); // attempt 0 fails
      expect(statusCalls()).toBe(1);
      expect(cache.list()).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(HYDRATE_RETRY_DELAYS_MS[0]!); // attempt 1 fails
      expect(statusCalls()).toBe(2);
      expect(cache.list()).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(HYDRATE_RETRY_DELAYS_MS[1]!); // attempt 2 succeeds
      expect(statusCalls()).toBe(3);
      expect(cache.list()).toHaveLength(1);
      expect(hydrateCompletes).toEqual(['initial']);

      // No further probes after success.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(statusCalls()).toBe(3);
      handler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retry schedule is bounded: exhaustion stops probing until the next external trigger', async () => {
    vi.useFakeTimers();
    try {
      const cache = new RunStateCache();
      const { client, triggerReconnect } = makeFakeClient();
      const { bridge, statusCalls } = makeFlakyBridge(Number.POSITIVE_INFINITY);
      const { publisher } = makePublisher();
      const { sink } = makeInboxAck();
      const handler = makeHandler({
        client,
        bridge,
        cache,
        events: publisher,
        inboxAck: sink,
      });

      await handler.start();
      for (const delay of HYDRATE_RETRY_DELAYS_MS) {
        await vi.advanceTimersByTimeAsync(delay);
      }
      const attempts = statusCalls();
      expect(attempts).toBe(1 + HYDRATE_RETRY_DELAYS_MS.length);

      // Exhausted: no more probes, however long we wait.
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(statusCalls()).toBe(attempts);

      // A new external trigger (reconnect) starts a fresh epoch.
      triggerReconnect();
      await vi.advanceTimersByTimeAsync(0);
      expect(statusCalls()).toBe(attempts + 1);
      handler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a newer trigger supersedes a pending retry (no cross-generation hydrate)', async () => {
    vi.useFakeTimers();
    try {
      const cache = new RunStateCache();
      const { client, emit } = makeFakeClient();
      let count = 0;
      const bridge = {
        runtimeStatus: async () => {
          count += 1;
          if (count === 1) throw new Error('first hydrate fails');
          return { runtimes: [] };
        },
      } as unknown as RuntimeStatusBridge;
      const { publisher } = makePublisher();
      const { sink } = makeInboxAck();
      const handler = makeHandler({
        client,
        bridge,
        cache,
        events: publisher,
        inboxAck: sink,
      });

      await handler.start(); // fails, schedules retry at +1s
      expect(count).toBe(1);

      // daemon_ready arrives before the retry timer fires: new epoch.
      emit(readyFrame(4242, 1700000000001));
      await vi.advanceTimersByTimeAsync(0);
      expect(count).toBe(2); // the daemon_ready hydrate ran immediately

      // The superseded epoch's pending retry must NOT fire a third probe.
      await vi.advanceTimersByTimeAsync(HYDRATE_RETRY_DELAYS_MS[0]!);
      expect(count).toBe(2);
      handler.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
