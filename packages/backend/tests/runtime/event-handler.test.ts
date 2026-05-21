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
