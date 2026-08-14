/**
 * #task:1417 tests for `RuntimeDeliveryCoordinator`.
 *
 * Stage 2b made delivery go through ONE command, `bridge.runtimeDeliver`,
 * whose sync result is a custody DISPOSITION. Stage 3 then moved the
 * mid-turn queue INTO the daemon, so this suite reflects the reduced
 * coordinator:
 *
 *   - Delivery goes through `bridge.runtimeDeliver`; the sync result is a
 *     custody DISPOSITION (`spawning` / `admitted` / `deferred` /
 *     `refused`) — the daemon owns spawn-vs-admit-vs-defer-vs-refuse.
 *   - The coordinator NO LONGER reads the cache, NO LONGER tracks busy /
 *     safe-boundary, holds NO pending queue, and NEVER combines. Every
 *     submit dispatches unconditionally. `deferred` (daemon enqueued in its
 *     own mid-turn queue) collapses to `dispatched` from the fanout's
 *     custody view.
 *   - The coordinator NO LONGER acks the inbox; `delivered_at` moves solely
 *     on the async `runtime_delivery_consumed` (event-handler's job).
 *   - `LiveDeliveryDecision` is `dispatched` | `refused`. The fanout maps
 *     these to inbox custody (keep-in-flight vs rollback); that mapping is
 *     tested in `outbound-event-fanout.test.ts`, not here.
 *
 * Coverage:
 *   - direct driver, ready → dispatched (spawning + admitted arms)
 *   - refused arms (startup_pending / draining / cooldown) → refused
 *   - gated driver mid-turn → still dispatched (no coordinator busy gate)
 *   - daemon `deferred` → dispatched; does NOT arm the delivery watchdog
 *   - multi-request batch → throws (combining moved to the daemon)
 *   - oneShot (`none`) → dispatched like any non-gated driver (no local
 *     short-circuit); the daemon decides spawn-with-batch vs sync-refuse
 *   - transport throw → propagates (fanout rolls back)
 *   - submitReadyForDrainDeliveryBatch dispatches unconditionally
 *   - oneShot exit auto-respawn matrix (no coordinator-side rollback)
 *   - empty batch throws
 *   - state scoped per (conv, agent)
 *   - delivery stuck watchdog fires / is cancelled by a parsed event
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  RuntimeDeliverResult,
  RuntimeDeliverRefusedReason,
} from '@silverhand/host';
import type { AgentRunState, ParsedEvent } from '@silverhand/shared';
import {
  RuntimeDeliveryCoordinator,
  type CoordinatorBridge,
  type CoordinatorCacheView,
  type DriverDeliveryView,
  type LiveDeliveryRequest,
  type RuntimeDelivery,
} from '../../src/runtime/delivery-coordinator.js';
import type { RuntimePhase } from '../../src/runtime/run-state-cache.js';

// ── helpers ────────────────────────────────────────────────────────

afterEach(() => {
  vi.useRealTimers();
});

interface CoordinatorBridgeCall {
  conversationId: string;
  agentId: string;
  deliveryIds: number[];
  deliveries?: RuntimeDelivery[];
  deliveredUpToSeq?: number;
  kind: 'message' | 'schedule_fire';
  text: string;
}

/** Custody-disposition result builders (Stage 2b wire shape). */
function admitted(): RuntimeDeliverResult {
  return { disposition: 'admitted', pid: 4242, started_at: 1_000 };
}
function spawning(): RuntimeDeliverResult {
  return { disposition: 'spawning', pid: 4242, started_at: 1_000 };
}
function deferredResult(): RuntimeDeliverResult {
  return { disposition: 'deferred', pid: 4242, started_at: 1_000 };
}
function refusedResult(
  reason: RuntimeDeliverRefusedReason,
  cooldownUntil?: number,
): RuntimeDeliverResult {
  if (reason === 'cooldown') {
    return {
      disposition: 'refused',
      reason: 'cooldown',
      cooldown_until: cooldownUntil ?? 9_999_999,
    };
  }
  return { disposition: 'refused', reason };
}

function makeBridge(
  results:
    | RuntimeDeliverResult
    | RuntimeDeliverResult[]
    | ((call: CoordinatorBridgeCall) => RuntimeDeliverResult | Error),
): {
  bridge: CoordinatorBridge;
  calls: CoordinatorBridgeCall[];
} {
  const calls: CoordinatorBridgeCall[] = [];
  const resultQueue: RuntimeDeliverResult[] = Array.isArray(results)
    ? [...results]
    : typeof results === 'function'
      ? []
      : [results];
  const bridge: CoordinatorBridge = {
    runtimeDeliver: vi.fn(async params => {
      const call: CoordinatorBridgeCall = {
        conversationId: params.conversation_id,
        agentId: params.agent_id,
        deliveryIds: [...params.delivery_ids],
        deliveries: params.deliveries?.map((d: RuntimeDelivery) => ({ ...d })),
        deliveredUpToSeq: params.delivered_up_to_seq,
        kind: params.kind,
        text: params.text,
      };
      calls.push(call);
      if (typeof results === 'function') {
        const r = results(call);
        if (r instanceof Error) throw r;
        return r;
      }
      if (resultQueue.length === 0) {
        throw new Error(
          `runtimeDeliver called more times than results queued; call #${calls.length}`,
        );
      }
      return resultQueue.shift()!;
    }),
  };
  return { bridge, calls };
}

function makeCacheView(
  entries: Array<{
    conv: string;
    agent: string;
    phase: RuntimePhase;
    runState?: AgentRunState | null;
  }> = [],
): CoordinatorCacheView {
  const map = new Map<
    string,
    { phase: RuntimePhase; runState?: AgentRunState | null }
  >();
  for (const e of entries) {
    map.set(`${e.conv}|${e.agent}`, { phase: e.phase, runState: e.runState ?? null });
  }
  return {
    get(conv, agent) {
      return map.get(`${conv}|${agent}`);
    },
  };
}

const DRIVER_DIRECT: DriverDeliveryView = {
  runtime: 'codex',
  releaseProfile: 'native-steer',
  oneShot: false,
  kickoffMode: 'self_inits',
};
const DRIVER_GATED: DriverDeliveryView = {
  runtime: 'claude',
  releaseProfile: 'tool-boundary-steer',
  oneShot: false,
  kickoffMode: 'requires_first_message',
};
const DRIVER_NONE: DriverDeliveryView = {
  runtime: 'cursor',
  releaseProfile: 'one-shot',
  oneShot: true,
  kickoffMode: 'self_inits',
};

function runState(overrides: Partial<AgentRunState> = {}): AgentRunState {
  return {
    runId: 'run-1',
    agentId: 'a1',
    conversationId: 'c1',
    status: 'idle',
    startedAt: 1_000,
    updatedAt: 2_000,
    lastActivityAt: 2_000,
    ...overrides,
  };
}

/**
 * Build a `LiveDeliveryRequest`. `inboxId` → `deliveryIds: [N]`,
 * `messageId` → `dedupKey`, `payload` → `text`.
 */
function req(
  overrides: Partial<LiveDeliveryRequest> & {
    inboxId?: number;
    messageId?: string;
    payload?: string;
  } = {},
): LiveDeliveryRequest {
  const { inboxId, messageId, payload, ...rest } = overrides;
  const base: LiveDeliveryRequest = {
    deliveryIds: inboxId !== undefined ? [inboxId] : [1],
    dedupKey: messageId ?? 'm1',
    text: payload ?? '{"type":"user","message":"hi"}',
    driver: DRIVER_GATED,
  };
  return { ...base, ...rest };
}

function parsed(kind: ParsedEvent['kind']): ParsedEvent {
  switch (kind) {
    case 'tool_call':
      return { kind, name: 'Bash', input: { command: 'ls' } };
    case 'tool_output':
      return { kind };
    case 'turn_end':
      return { kind };
    case 'compaction_started':
      return { kind };
    case 'compaction_finished':
      return { kind };
    case 'thinking':
      return { kind, text: '' };
    case 'text':
      return { kind, text: '' };
    case 'session_init':
      return { kind, sessionId: 's1' };
    case 'error':
      return { kind, message: 'oops' };
    case 'input_lifecycle':
      return { kind, commandUuid: 'uuid-1', state: 'started' };
    case 'api_response':
      return { kind, status: 'waiting', message: 'model request queued' };
    case 'unknown':
      return { kind, raw: '' };
  }
}

// ── the coordinator has NO ack sink at all in Stage 2b ─────────────
//
// `RuntimeDeliveryCoordinatorDeps` is `{ bridge, cache, callbacks?, ... }`.
// There is no `inboxAck` field; the type below is a compile-time pin that
// the coordinator can be constructed with exactly those deps.
function makeCoordinator(
  bridge: CoordinatorBridge,
  cache: CoordinatorCacheView = makeCacheView(),
  extra: {
    callbacks?: ConstructorParameters<
      typeof RuntimeDeliveryCoordinator
    >[0]['callbacks'];
    deliveryWatchdogMs?: number;
    now?: () => number;
  } = {},
): RuntimeDeliveryCoordinator {
  return new RuntimeDeliveryCoordinator({ bridge, cache, ...extra });
}

// ── direct driver, ready → dispatched ──────────────────────────────

describe('direct driver ready → dispatched (no ack)', () => {
  it('admitted disposition → dispatched with delivery ids', async () => {
    const { bridge, calls } = makeBridge(admitted());
    const c = makeCoordinator(bridge);

    const decision = await c.submitLiveDelivery(
      'c1',
      'a1',
      req({ inboxId: 7, driver: DRIVER_DIRECT }),
    );

    expect(decision).toEqual({ kind: 'dispatched', deliveryIds: [7] });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      conversationId: 'c1',
      agentId: 'a1',
      deliveryIds: [7],
      kind: 'message',
    });
  });

  it('spawning disposition → dispatched', async () => {
    const { bridge, calls } = makeBridge(spawning());
    const c = makeCoordinator(bridge);

    const decision = await c.submitLiveDelivery(
      'c1',
      'a1',
      req({ inboxId: 9, driver: DRIVER_DIRECT }),
    );

    expect(decision).toEqual({ kind: 'dispatched', deliveryIds: [9] });
    expect(calls).toHaveLength(1);
  });

  it('forwards deliveries + delivered_up_to_seq to the daemon', async () => {
    const { bridge, calls } = makeBridge(admitted());
    const c = makeCoordinator(bridge);

    const deliveries: RuntimeDelivery[] = [
      {
        delivery_id: 3,
        message_id: 'm3',
        seq: 42,
        thread_root_id: null,
        delivery_kind: 'turn',
        presentation: {
          body: '[msg_id=m3 sender=system type=system target=#conv:coordinatorConv1 time=2026-01-01T00:00:00+00:00]\ndelivery-text',
          instruction: 'system',
        },
      },
    ];
    await c.submitLiveDelivery(
      'c1',
      'a1',
      req({
        inboxId: 3,
        driver: DRIVER_DIRECT,
        deliveredUpToSeq: 42,
        deliveries,
      }),
    );

    expect(calls[0]).toMatchObject({ deliveredUpToSeq: 42, deliveries });
  });
});

// ── refused arms ───────────────────────────────────────────────────

describe('refused disposition → refused decision (row rolls back)', () => {
  it.each([
    ['startup_pending' as const],
    ['draining' as const],
  ])('%s', async reason => {
    const { bridge, calls } = makeBridge(refusedResult(reason));
    const c = makeCoordinator(bridge);

    const decision = await c.submitLiveDelivery(
      'c1',
      'a1',
      req({ driver: DRIVER_DIRECT }),
    );

    expect(decision).toEqual({ kind: 'refused', reason });
    expect(calls).toHaveLength(1);
  });

  it('cooldown', async () => {
    const { bridge } = makeBridge(refusedResult('cooldown', 5_000));
    const c = makeCoordinator(bridge);

    const decision = await c.submitLiveDelivery(
      'c1',
      'a1',
      req({ driver: DRIVER_DIRECT }),
    );

    // The refused decision carries only `reason`; the fanout does not need
    // cooldown_until at the coordinator layer (rollback is the same).
    expect(decision).toEqual({ kind: 'refused', reason: 'cooldown' });
  });
});

// ── gated driver dispatches unconditionally (daemon owns the queue) ──

describe('gated driver → dispatched unconditionally (Stage 3)', () => {
  it('dispatches even mid-turn — NO coordinator busy gate anymore', async () => {
    const { bridge, calls } = makeBridge(admitted());
    const c = makeCoordinator(bridge);

    // A tool_call used to raise the coordinator's busy tracker and defer
    // the delivery. Stage 3 removed that tracker: onParsedEvent is now a
    // pure watchdog-clear no-op for delivery, so the submit still
    // dispatches immediately and the DAEMON decides whether to defer.
    c.onParsedEvent('c1', 'a1', parsed('tool_call'));

    const decision = await c.submitLiveDelivery(
      'c1',
      'a1',
      req({ inboxId: 11, driver: DRIVER_GATED }),
    );

    expect(decision).toEqual({ kind: 'dispatched', deliveryIds: [11] });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ deliveryIds: [11], kind: 'message' });
  });

  it('daemon `deferred` disposition collapses to `dispatched` (custody transferred, no ack)', async () => {
    const { bridge, calls } = makeBridge(deferredResult());
    const c = makeCoordinator(bridge);

    // The daemon held a ready handle but could not take the write now
    // (mid-turn gated, or a prior write in flight) and enqueued it in its
    // OWN queue. Custody is with the daemon exactly like `admitted`: the
    // fanout keeps the rows in-flight; ack awaits the async consumed event.
    const decision = await c.submitLiveDelivery(
      'c1',
      'a1',
      req({ inboxId: 12, driver: DRIVER_GATED }),
    );

    expect(decision).toEqual({ kind: 'dispatched', deliveryIds: [12] });
    expect(calls).toHaveLength(1);
  });

  it('deferred does NOT arm the delivery watchdog (write deferred to daemon)', async () => {
    vi.useFakeTimers();
    const { bridge } = makeBridge(deferredResult());
    const published: AgentRunState[] = [];
    const cache = makeCacheView([
      { conv: 'c1', agent: 'a1', phase: 'ready', runState: runState() },
    ]);
    const c = makeCoordinator(bridge, cache, {
      deliveryWatchdogMs: 1_000,
      now: () => 5_000,
      callbacks: { publishActivity: s => published.push(s) },
    });

    await c.submitLiveDelivery('c1', 'a1', req({ driver: DRIVER_GATED }));
    // A deferred write has no known write moment on the backend side, so
    // arming a delivery watchdog would fire spuriously during a legit long
    // turn. Advancing past the threshold must publish NOTHING.
    vi.advanceTimersByTime(5_000);
    expect(published).toHaveLength(0);
  });

  it('multi-request batch throws — combining moved to the daemon', async () => {
    const { bridge } = makeBridge(admitted());
    const c = makeCoordinator(bridge);

    // Callers must pre-combine into ONE request; a multi-request batch is a
    // caller bug now that the coordinator no longer combines (the daemon
    // combines deferred entries at flush). Fail LOUD, never silently join.
    await expect(
      c.submitLiveDeliveryBatch('c1', 'a1', [
        req({ inboxId: 1, messageId: 'm1', payload: 'first', driver: DRIVER_GATED }),
        req({ inboxId: 2, messageId: 'm2', payload: 'second', driver: DRIVER_GATED }),
      ]),
    ).rejects.toThrow(/multi-request batch/);
  });
});

// ── oneShot (`none`) dispatches; daemon decides ────────────────────

describe('oneShot driver → dispatched (no local short-circuit)', () => {
  it('no live handle → daemon spawns-with-batch → dispatched', async () => {
    const { bridge, calls } = makeBridge(spawning());
    const c = makeCoordinator(bridge);

    const decision = await c.submitLiveDelivery(
      'c1',
      'a1',
      req({ inboxId: 7, driver: DRIVER_NONE }),
    );

    // The coordinator no longer guesses `noop_oneshot_live`: it has no
    // live proof, so it dispatches and the daemon spawns-with-batch.
    expect(decision).toEqual({ kind: 'dispatched', deliveryIds: [7] });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.deliveryIds).toEqual([7]);
  });

  it('live oneShot → daemon sync-refuses (startup_pending) → refused', async () => {
    const { bridge, calls } = makeBridge(refusedResult('startup_pending'));
    const c = makeCoordinator(bridge);

    const decision = await c.submitLiveDelivery(
      'c1',
      'a1',
      req({ inboxId: 7, driver: DRIVER_NONE }),
    );

    // A live oneShot can't take stdin; the daemon refuses SYNC (no async
    // admitted→driver_refused). The fanout rolls the rows back to pending;
    // the respawn-on-exit path drains them.
    expect(decision).toEqual({ kind: 'refused', reason: 'startup_pending' });
    expect(calls).toHaveLength(1);
  });
});

// ── transport throw propagates ─────────────────────────────────────

describe('transport / fs-guard throw', () => {
  it('propagates so the fanout rolls the in-flight rows back', async () => {
    const { bridge } = makeBridge(() => new Error('transport_no_connection'));
    const c = makeCoordinator(bridge);

    await expect(
      c.submitLiveDelivery('c1', 'a1', req({ driver: DRIVER_DIRECT })),
    ).rejects.toThrow('transport_no_connection');
  });
});

// ── ready_for_drain replay bypasses the busy tracker ───────────────

describe('submitReadyForDrainDeliveryBatch', () => {
  it('dispatches unconditionally (no coordinator busy gate)', async () => {
    const { bridge, calls } = makeBridge(admitted());
    const c = makeCoordinator(bridge);

    // A prior parsed tool_call no longer changes anything on the backend
    // side (Stage 3 removed the busy tracker); this path always dispatches.
    c.onParsedEvent('c1', 'a1', parsed('tool_call'));

    const decision = await c.submitReadyForDrainDeliveryBatch('c1', 'a1', [
      req({ inboxId: 21, driver: DRIVER_GATED }),
    ]);

    expect(decision).toEqual({ kind: 'dispatched', deliveryIds: [21] });
    expect(calls).toHaveLength(1);
  });

  it('oneShot driver on ready_for_drain → dispatched (daemon decides)', async () => {
    const { bridge, calls } = makeBridge(spawning());
    const c = makeCoordinator(bridge);

    const decision = await c.submitReadyForDrainDeliveryBatch('c1', 'a1', [
      req({ inboxId: 31, driver: DRIVER_NONE }),
    ]);

    // No local oneShot short-circuit here either — dispatch and let the
    // daemon spawn-with-batch (or sync-refuse a still-live oneShot).
    expect(decision).toEqual({ kind: 'dispatched', deliveryIds: [31] });
    expect(calls).toHaveLength(1);
  });

  it('empty batch throws', async () => {
    const { bridge } = makeBridge([]);
    const c = makeCoordinator(bridge);

    await expect(
      c.submitReadyForDrainDeliveryBatch('c1', 'a1', []),
    ).rejects.toThrow(/empty batch/);
  });
});

describe('submitLiveDeliveryBatch empty', () => {
  it('throws', async () => {
    const { bridge } = makeBridge([]);
    const c = makeCoordinator(bridge);
    await expect(
      c.submitLiveDeliveryBatch('c1', 'a1', []),
    ).rejects.toThrow(/empty batch/);
  });
});

// ── oneShot exit auto-respawn matrix ───────────────────────────────

describe('oneShot exit auto-respawn', () => {
  function meta(overrides: Partial<Parameters<RuntimeDeliveryCoordinator['onRuntimeExit']>[2]> = {}) {
    return {
      intentional: false,
      code: 1,
      initTimedOut: false,
      fatalError: false,
      ...overrides,
    };
  }

  it('fires respawn when intentional=false ∧ ¬initTimedOut ∧ ¬fatal ∧ hasPendingInbox', async () => {
    const { bridge } = makeBridge([]);
    const respawn = vi.fn(async () => {});
    const c = makeCoordinator(bridge, makeCacheView(), {
      callbacks: { respawn, hasPendingInbox: () => true },
    });

    c.onRuntimeExit('c1', 'a1', meta());
    await vi.waitFor(() => expect(respawn).toHaveBeenCalledWith('c1', 'a1'));
  });

  type ExitMeta = ReturnType<typeof meta>;
  it.each([
    ['intentional', (m: ExitMeta) => ({ ...m, intentional: true })],
    ['initTimedOut', (m: ExitMeta) => ({ ...m, initTimedOut: true })],
    ['fatalError', (m: ExitMeta) => ({ ...m, fatalError: true })],
  ] as const)('suppressed when %s', async (_label, mutate) => {
    const { bridge } = makeBridge([]);
    const respawn = vi.fn(async () => {});
    const c = makeCoordinator(bridge, makeCacheView(), {
      callbacks: { respawn, hasPendingInbox: () => true },
    });

    c.onRuntimeExit('c1', 'a1', mutate(meta()));
    await new Promise(r => setTimeout(r, 0));
    expect(respawn).not.toHaveBeenCalled();
  });

  it('suppressed when no pending inbox', async () => {
    const { bridge } = makeBridge([]);
    const respawn = vi.fn(async () => {});
    const c = makeCoordinator(bridge, makeCacheView(), {
      callbacks: { respawn, hasPendingInbox: () => false },
    });

    c.onRuntimeExit('c1', 'a1', meta());
    await new Promise(r => setTimeout(r, 0));
    expect(respawn).not.toHaveBeenCalled();
  });

  it('does NOT roll back on exit — the daemon owns the mid-turn queue now', async () => {
    // #task:1417 Stage 3. The coordinator no longer holds a volatile queue,
    // so `onRuntimeExit` has nothing to roll back. Mid-turn deferred rows
    // live in the DAEMON's per-handle queue; on child exit the daemon emits
    // `runtime_delivery_failed{child_exit}` and the backend's failed-delivery
    // handler (not the coordinator) returns those rows to pending. Exit here
    // only tears down the coordinator's own per-agent (watchdog) state and
    // runs the respawn gate.
    const { bridge, calls } = makeBridge(deferredResult());
    const respawn = vi.fn(async () => {});
    const c = makeCoordinator(bridge, makeCacheView(), {
      callbacks: { respawn, hasPendingInbox: () => true },
    });

    c.onParsedEvent('c1', 'a1', parsed('tool_call'));
    const decision = await c.submitLiveDelivery(
      'c1',
      'a1',
      req({ inboxId: 5, driver: DRIVER_GATED }),
    );
    // Dispatched to the daemon (deferred → dispatched); the daemon holds it.
    expect(decision.kind).toBe('dispatched');
    expect(calls).toHaveLength(1);

    c.onRuntimeExit('c1', 'a1', meta());
    // Respawn gate still fires; no coordinator-side rollback happens.
    await vi.waitFor(() => expect(respawn).toHaveBeenCalledWith('c1', 'a1'));
  });
});

// ── state is scoped per (conv, agent) ──────────────────────────────

describe('state scoping', () => {
  it('a parsed event on c1/a1 does not affect c2/a2 dispatch', async () => {
    const { bridge, calls } = makeBridge([admitted(), admitted()]);
    const c = makeCoordinator(bridge);

    c.onParsedEvent('c1', 'a1', parsed('tool_call')); // watchdog-clear only

    // Both pairs dispatch unconditionally now (no busy gate anywhere in the
    // coordinator). The point of this test post-Stage-3 is simply that
    // per-(conv,agent) watchdog state stays isolated and neither dispatch
    // interferes with the other.
    const d = await c.submitLiveDelivery(
      'c2',
      'a2',
      req({ inboxId: 99, driver: DRIVER_GATED }),
    );
    expect(d).toEqual({ kind: 'dispatched', deliveryIds: [99] });

    const d2 = await c.submitLiveDelivery(
      'c1',
      'a1',
      req({ inboxId: 1, driver: DRIVER_GATED }),
    );
    expect(d2).toEqual({ kind: 'dispatched', deliveryIds: [1] });
    expect(calls).toHaveLength(2);
  });
});

// ── delivery stuck watchdog ────────────────────────────────────────────

describe('delivery stuck watchdog', () => {
  it('publishes a synthetic thinking state when no parsed event arrives', async () => {
    vi.useFakeTimers();
    const { bridge } = makeBridge(admitted());
    const published: AgentRunState[] = [];
    const cache = makeCacheView([
      { conv: 'c1', agent: 'a1', phase: 'ready', runState: runState() },
    ]);
    const c = makeCoordinator(bridge, cache, {
      deliveryWatchdogMs: 1_000,
      now: () => 5_000,
      callbacks: { publishActivity: s => published.push(s) },
    });

    await c.submitLiveDelivery('c1', 'a1', req({ driver: DRIVER_DIRECT }));
    expect(published).toHaveLength(0);

    vi.advanceTimersByTime(1_000);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ status: 'thinking' });
  });

  it('is cancelled by an incoming parsed event', async () => {
    vi.useFakeTimers();
    const { bridge } = makeBridge(admitted());
    const published: AgentRunState[] = [];
    const cache = makeCacheView([
      { conv: 'c1', agent: 'a1', phase: 'ready', runState: runState() },
    ]);
    const c = makeCoordinator(bridge, cache, {
      deliveryWatchdogMs: 1_000,
      now: () => 5_000,
      callbacks: { publishActivity: s => published.push(s) },
    });

    await c.submitLiveDelivery('c1', 'a1', req({ driver: DRIVER_DIRECT }));
    c.onParsedEvent('c1', 'a1', parsed('thinking')); // real signal → cancel
    vi.advanceTimersByTime(2_000);

    expect(published).toHaveLength(0);
  });
});
