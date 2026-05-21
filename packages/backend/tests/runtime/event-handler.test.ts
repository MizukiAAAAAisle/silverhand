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
 *   - Inbox ack timing: `runtime_startup_delivery_consumed` →
 *     `inboxAck.markDelivered`; `_failed` → `markUndelivered(reason)`.
 *   - Event routing: `runtime_state` → cache + SSE `agent_activity`;
 *     `runtime_exit` → cache + SSE `agent_status` with `intentional`-derived
 *     status; `runtime_init_*` → SSE projection without cache mutation.
 *   - Cache-not-ready safety: events arriving before any daemon key
 *     latched are dropped (no cache mutation, no SSE noise) until
 *     hydrate completes.
 */
import { describe, expect, it, vi } from 'vitest';
import type { EventFrame, HostClient, RuntimeStatusResult } from '@silverhand/host';
import type { AgentRunState } from '@silverhand/shared';
import { RunStateCache } from '../../src/runtime/run-state-cache.js';
import { RuntimeBridge } from '../../src/runtime/bridge.js';
import {
  RuntimeEventHandler,
  type EventPublisher,
  type InboxAckSink,
} from '../../src/runtime/event-handler.js';

function makeFakeClient(): {
  client: HostClient;
  emit: (frame: EventFrame) => void;
  triggerReconnect: () => void;
} {
  const eventHandlers = new Set<(frame: EventFrame) => void>();
  const reconnectHandlers = new Set<() => void>();
  const fake = {
    subscribe(handler: (frame: EventFrame) => void) {
      eventHandlers.add(handler);
      return () => eventHandlers.delete(handler);
    },
    onReconnect(handler: () => void) {
      reconnectHandlers.add(handler);
      return () => reconnectHandlers.delete(handler);
    },
  } as unknown as HostClient;
  return {
    client: fake,
    emit(frame) {
      for (const h of eventHandlers) h(frame);
    },
    triggerReconnect() {
      for (const h of reconnectHandlers) h();
    },
  };
}

function makeBridge(snapshot: RuntimeStatusResult): {
  bridge: RuntimeBridge;
  statusCalls: () => number;
} {
  let count = 0;
  const bridge = {
    runtimeStatus: async () => {
      count += 1;
      return snapshot;
    },
  } as unknown as RuntimeBridge;
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
    markDelivered(ids) {
      delivered.push([...ids]);
    },
    markUndelivered(ids, reason) {
      undelivered.push({ ids: [...ids], reason });
    },
  };
  return { sink, delivered, undelivered };
}

function readyFrame(daemonPid: number, startedAt: number): EventFrame {
  return {
    event: 'ready',
    socket_path: '/tmp/sock',
    daemon_pid: daemonPid,
    daemon_version: '0.0.0-test',
    started_at: startedAt,
  };
}

function runStateFrame(
  conversationId: string,
  agentId: string,
  state: AgentRunState,
  ts = 1700000000000,
): EventFrame {
  return {
    event: 'runtime_state',
    conversation_id: conversationId,
    agent_id: agentId,
    state,
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
    conversation_id: conversationId,
    agent_id: agentId,
    code,
    intentional,
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
          pid: 1234,
          phase: 'ready',
          run_state: RUN_STATE,
          started_at: 1700000000000,
        },
      ],
    });
    const { publisher } = makePublisher();
    const { sink } = makeInboxAck();
    const handler = new RuntimeEventHandler({
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
    const handler = new RuntimeEventHandler({
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
          pid: 1234,
          phase: 'ready',
          run_state: null,
          started_at: 1700000000000,
        },
      ],
    };
    const bridge = {
      runtimeStatus: async () => snapshot,
    } as unknown as RuntimeBridge;
    const { publisher } = makePublisher();
    const { sink } = makeInboxAck();
    const handler = new RuntimeEventHandler({
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
          pid: 1234,
          phase: 'ready',
          run_state: null,
          started_at: 1700000000000,
        },
      ],
    };
    const bridge = {
      runtimeStatus: async () => snapshot,
    } as unknown as RuntimeBridge;
    const { publisher } = makePublisher();
    const { sink } = makeInboxAck();
    const handler = new RuntimeEventHandler({
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
        return {
          runtimes: [
            {
              conversation_id: 'c1',
              agent_id: 'a1',
              pid: 1234,
              phase: 'ready',
              run_state: null,
              started_at: 1700000000000,
            },
          ],
        } as RuntimeStatusResult;
      },
    } as unknown as RuntimeBridge;
    const { publisher } = makePublisher();
    const { sink } = makeInboxAck();
    const handler = new RuntimeEventHandler({
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
  it('startup_delivery_consumed → markDelivered(ids)', async () => {
    const cache = new RunStateCache();
    const { client, emit } = makeFakeClient();
    const { bridge } = makeBridge({ runtimes: [] });
    const { publisher } = makePublisher();
    const { sink, delivered } = makeInboxAck();
    const handler = new RuntimeEventHandler({
      client,
      bridge,
      cache,
      events: publisher,
      inboxAck: sink,
    });
    await handler.start();
    emit({
      event: 'runtime_startup_delivery_consumed',
      conversation_id: 'c1',
      agent_id: 'a1',
      delivery_ids: [10, 11, 12],
      ts: 1700000001000,
    });
    expect(delivered).toEqual([[10, 11, 12]]);
  });

  it('startup_delivery_failed → markUndelivered(ids, reason)', async () => {
    const cache = new RunStateCache();
    const { client, emit } = makeFakeClient();
    const { bridge } = makeBridge({ runtimes: [] });
    const { publisher } = makePublisher();
    const { sink, undelivered } = makeInboxAck();
    const handler = new RuntimeEventHandler({
      client,
      bridge,
      cache,
      events: publisher,
      inboxAck: sink,
    });
    await handler.start();
    emit({
      event: 'runtime_startup_delivery_failed',
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
          pid: 1234,
          phase: 'ready',
          run_state: null,
          started_at: 1700000000000,
        },
      ],
    });
    const { publisher, published } = makePublisher();
    const { sink } = makeInboxAck();
    const handler = new RuntimeEventHandler({
      client,
      bridge,
      cache,
      events: publisher,
      inboxAck: sink,
    });
    await handler.start();
    emit(runStateFrame('c1', 'a1', RUN_STATE));
    expect(cache.get('c1', 'a1')?.runState?.runId).toBe('r1');
    const activity = published.find(p => p.kind === 'agent_activity');
    expect(activity).toBeDefined();
    expect((activity!.payload as AgentRunState).runId).toBe('r1');
  });

  it('runtime_exit (intentional=false, non-zero code) → SSE agent_status crashed', async () => {
    const cache = new RunStateCache();
    const { client, emit } = makeFakeClient();
    const { bridge } = makeBridge({
      runtimes: [
        {
          conversation_id: 'c1',
          agent_id: 'a1',
          pid: 1234,
          phase: 'ready',
          run_state: null,
          started_at: 1700000000000,
        },
      ],
    });
    const { publisher, published } = makePublisher();
    const { sink } = makeInboxAck();
    const handler = new RuntimeEventHandler({
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
          pid: 1234,
          phase: 'ready',
          run_state: null,
          started_at: 1700000000000,
        },
      ],
    });
    const { publisher, published } = makePublisher();
    const { sink } = makeInboxAck();
    const handler = new RuntimeEventHandler({
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
          pid: 1234,
          phase: 'ready',
          run_state: null,
          started_at: 1700000000000,
        },
      ],
    });
    const { publisher, published } = makePublisher();
    const { sink } = makeInboxAck();
    const handler = new RuntimeEventHandler({
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
    } as unknown as RuntimeBridge;
    const { publisher, published } = makePublisher();
    const { sink } = makeInboxAck();
    const handler = new RuntimeEventHandler({
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
    const handler = new RuntimeEventHandler({
      client,
      bridge,
      cache,
      events: publisher,
      inboxAck: sink,
    });
    await handler.start();
    emit({
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
      event: 'runtime_init_retrying',
      conversation_id: 'c1',
      agent_id: 'a1',
      retry_attempt: 1,
      max_retries: 2,
      delay_ms: 100,
      ts: 1700000001100,
    });
    emit({
      event: 'runtime_init_cooldown',
      conversation_id: 'c1',
      agent_id: 'a1',
      cooldown_until: 1700000099000,
      attempts_exhausted: 2,
      ts: 1700000002000,
    });
    expect(published.map(p => p.kind)).toEqual([
      'agent_init_timeout',
      'agent_status',
      'agent_status',
    ]);
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
    const handler = new RuntimeEventHandler({
      client,
      bridge,
      cache,
      events: publisher,
      inboxAck: sink,
    });
    await handler.start();
    emit({
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
          pid: 1234,
          phase: 'ready',
          run_state: null,
          started_at: 1700000000000,
        },
      ],
    });
    const { publisher, published } = makePublisher();
    const { sink } = makeInboxAck();
    const handler = new RuntimeEventHandler({
      client,
      bridge,
      cache,
      events: publisher,
      inboxAck: sink,
    });
    await handler.start();
    // Stash a reason …
    emit({
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
      event: 'runtime_init_retrying',
      conversation_id: 'c1',
      agent_id: 'a1',
      retry_attempt: 1,
      max_retries: 2,
      delay_ms: 100,
      ts: 1700000002000,
    });
    const retrying = published.find(
      p =>
        p.kind === 'agent_status' &&
        (p.payload as Record<string, unknown>).reason === 'init_timeout_retrying',
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
          pid: 1234,
          phase: 'ready',
          run_state: null,
          started_at: 1700000000000,
        },
      ],
    });
    const { publisher, published } = makePublisher();
    const { sink } = makeInboxAck();
    const handler = new RuntimeEventHandler({
      client,
      bridge,
      cache,
      events: publisher,
      inboxAck: sink,
    });
    await handler.start();
    // Stash a timeout reason …
    emit({
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
      event: 'runtime_init_retrying',
      conversation_id: 'c1',
      agent_id: 'a1',
      retry_attempt: 2,
      max_retries: 2,
      delay_ms: 100,
      ts: 1700000002000,
    });
    const retrying = published.find(
      p =>
        p.kind === 'agent_status' &&
        (p.payload as Record<string, unknown>).reason === 'init_timeout_retrying',
    );
    const payload = retrying!.payload as Record<string, unknown>;
    expect(payload).not.toHaveProperty('timeout_reason');
  });

  it('runtime_ready_for_drain → invokes onReadyForDrain callback (cache phase updated)', async () => {
    const cache = new RunStateCache();
    const { client, emit } = makeFakeClient();
    const { bridge } = makeBridge({
      runtimes: [
        {
          conversation_id: 'c1',
          agent_id: 'a1',
          pid: 1234,
          phase: 'startup_pending',
          run_state: null,
          started_at: 1700000000000,
        },
      ],
    });
    const { publisher } = makePublisher();
    const { sink } = makeInboxAck();
    const calls: Array<[string, string]> = [];
    const handler = new RuntimeEventHandler({
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
      event: 'runtime_ready_for_drain',
      conversation_id: 'c1',
      agent_id: 'a1',
      ts: 1700000001000,
    });
    expect(calls).toEqual([['c1', 'a1']]);
    expect(cache.get('c1', 'a1')?.phase).toBe('ready');
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
          pid: 1234,
          phase: 'ready',
          run_state: null,
          started_at: 1700000000000,
        },
      ],
    });
    const { publisher, published } = makePublisher();
    const { sink } = makeInboxAck();
    const handler = new RuntimeEventHandler({
      client,
      bridge,
      cache,
      events: publisher,
      inboxAck: sink,
    });
    await handler.start();
    emit({
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

  it('large tool_call.input is sanitized BEFORE publish (truncation marker present)', async () => {
    const cache = new RunStateCache();
    const { client, emit } = makeFakeClient();
    const { bridge } = makeBridge({
      runtimes: [
        {
          conversation_id: 'c1',
          agent_id: 'a1',
          pid: 1234,
          phase: 'ready',
          run_state: null,
          started_at: 1700000000000,
        },
      ],
    });
    const { publisher, published } = makePublisher();
    const { sink } = makeInboxAck();
    const handler = new RuntimeEventHandler({
      client,
      bridge,
      cache,
      events: publisher,
      inboxAck: sink,
    });
    await handler.start();
    const huge = 'x'.repeat(2000); // exceeds 500-char cap
    emit({
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

  it('runtime_parsed_event_dropped does NOT produce an agent_event (logged-only)', async () => {
    const cache = new RunStateCache();
    const { client, emit } = makeFakeClient();
    const { bridge } = makeBridge({
      runtimes: [
        {
          conversation_id: 'c1',
          agent_id: 'a1',
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
    const handler = new RuntimeEventHandler({
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
    // No SSE publish (renderer has no UI for dropped frames yet).
    expect(published.find(p => p.kind === 'agent_event')).toBeUndefined();
    // But the operator-visible warn lands so SREs can see it in logs.
    expect(warns.some(w => (w as { event?: string }).event === 'runtime_parsed_event_dropped')).toBe(
      true,
    );
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
    } as unknown as RuntimeBridge;
    const { publisher, published } = makePublisher();
    const { sink } = makeInboxAck();
    const handler = new RuntimeEventHandler({
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
  // they must NOT hold queues or call wake. These tests pin the
  // forward-only contract for `onParsedEvent` and `onRuntimeExit`.

  function setup(opts: { withCallbacks?: boolean } = {}): {
    cache: RunStateCache;
    emit: (frame: EventFrame) => void;
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
    publishedAgentStatus: () => Array<{ conv: string; payload: unknown }>;
  } {
    const cache = new RunStateCache();
    const { client, emit } = makeFakeClient();
    const { bridge } = makeBridge({
      runtimes: [
        {
          conversation_id: 'c1',
          agent_id: 'a1',
          pid: 1234,
          phase: 'ready',
          run_state: null,
          started_at: 1700000000000,
        },
      ],
    });
    const { publisher, published } = makePublisher();
    const { sink } = makeInboxAck();
    const parsedCalls: Array<{ conv: string; agent: string; event: unknown }> =
      [];
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
    const handler = new RuntimeEventHandler({
      client,
      bridge,
      cache,
      events: publisher,
      inboxAck: sink,
      ...(opts.withCallbacks === false
        ? {}
        : {
            onParsedEvent: (conv, agent, event) =>
              parsedCalls.push({ conv, agent, event }),
            onRuntimeExit: (conv, agent, meta) =>
              exitCalls.push({ conv, agent, meta }),
          }),
    });
    return {
      cache,
      emit,
      handler,
      parsedCalls,
      exitCalls,
      publishedAgentStatus: () =>
        published
          .filter(p => p.kind === 'agent_status')
          .map(p => ({ conv: p.conv, payload: p.payload })),
    };
  }

  it('onParsedEvent receives RAW parsed payload (not sanitized)', async () => {
    const { handler, emit, parsedCalls } = setup();
    await handler.start();
    const hugeInput = 'x'.repeat(2000); // would be truncated by the sanitizer
    emit({
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
      event: 'runtime_init_cooldown',
      conversation_id: 'c1',
      agent_id: 'a1',
      cooldown_until: 1700000003000,
      attempts_exhausted: 3,
      ts: 1700000002500,
    });
    emit({
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
      event: 'runtime_exit',
      conversation_id: 'c1',
      agent_id: 'a1',
      code: null,
      intentional: false,
      ts: 1700000002500,
    });
    expect(exitCalls[0]!.meta.initTimedOut).toBe(true);
  });

  it('runtime_init_timeout with retrying=true does NOT set initTimedOut', async () => {
    const { handler, emit, exitCalls } = setup();
    await handler.start();
    emit({
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
      event: 'runtime_exit',
      conversation_id: 'c1',
      agent_id: 'a1',
      code: 1,
      intentional: false,
      ts: 1700000002500,
    });
    expect(exitCalls[0]!.meta.fatalError).toBe(false);
  });

  it('fatalError clears after a fresh runtime_state (recovery)', async () => {
    const { handler, emit, exitCalls } = setup();
    await handler.start();
    emit({
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
    emit(runStateFrame('c1', 'a1', RUN_STATE, 1700000002400));
    emit({
      event: 'runtime_exit',
      conversation_id: 'c1',
      agent_id: 'a1',
      code: 0,
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
      event: 'runtime_init_cooldown',
      conversation_id: 'c1',
      agent_id: 'a1',
      cooldown_until: 1700000003000,
      attempts_exhausted: 3,
      ts: 1700000002500,
    });
    // Exit on c2/a2 must NOT inherit c1/a1's flag.
    emit({
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
    const handler = new RuntimeEventHandler({
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
      event: 'runtime_parsed_event',
      conversation_id: 'c1',
      agent_id: 'a1',
      parsed: { kind: 'text', text: 'hi' } as never,
      ts: 1700000001000,
    });
    emit({
      event: 'runtime_exit',
      conversation_id: 'c1',
      agent_id: 'a1',
      code: 0,
      intentional: true,
      ts: 1700000002000,
    });
    expect(publishedAgentStatus()).toHaveLength(1);
  });
});
