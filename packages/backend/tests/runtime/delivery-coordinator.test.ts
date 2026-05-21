/**
 * Sub-2b-i tests for `RuntimeDeliveryCoordinator`.
 *
 * Cindy `3l4bZ5vaMvlC9DVS` scope: review **coordinator boundary + 7
 * delivery cases**; DaemonHost integration is not in scope for 2b-i.
 * EventHandler hooks are pure forwarders here — these tests do not go
 * through EventHandler; they call coordinator methods directly with
 * synthetic ParsedEvents / cache entries to keep each case independent.
 *
 * The 7 cases (locked with Cindy `BYHZJI9ALSVmmlFr`):
 *
 *   1. runtime not running (no cache entry)
 *   2. startup_pending (no wake; row stays pending; daemon side will
 *      drive a `runtime_ready_for_drain` later)
 *   3. draining (no wake; row stays pending; next `start()` consumes
 *      via startup_delivery)
 *   4. ready + driver `direct` (immediate wake → markDelivered)
 *   5. ready + driver `gated` + busy mid-turn (enqueue → safe-boundary
 *      flush wakes)
 *   6. ready + driver `none` (oneShot live; never push via wake)
 *   7. oneShot exit auto-respawn (intentional=false ∧ ¬initTimedOut ∧
 *      ¬fatalError ∧ hasPendingInbox → respawn callback fires)
 *
 * Additional coverage:
 *   - Idempotent enqueue (same messageId pushed twice → queue length 1)
 *   - Wake refused (delivered:false, reason) → no markDelivered, row
 *     stays pending
 *   - Transport throw → propagates, no markDelivered
 *   - Init-timeout / fatal-error / no-pending suppress oneShot respawn
 *   - State scoped per (conv, agent) — events on c1/a1 don't poison c2/a2
 */
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeWakeResult } from '@silverhand/host';
import type { ParsedEvent } from '@silverhand/shared';
import {
  RuntimeDeliveryCoordinator,
  type CoordinatorBridge,
  type CoordinatorCacheView,
  type CoordinatorInboxSink,
  type DriverDeliveryView,
  type LiveDeliveryRequest,
} from '../../src/runtime/delivery-coordinator.js';
import type { RuntimePhase } from '../../src/runtime/run-state-cache.js';

// ── helpers ────────────────────────────────────────────────────────

function makeBridge(
  results:
    | RuntimeWakeResult
    | RuntimeWakeResult[]
    | ((call: CoordinatorBridgeCall) => RuntimeWakeResult | Error),
): {
  bridge: CoordinatorBridge;
  calls: CoordinatorBridgeCall[];
} {
  const calls: CoordinatorBridgeCall[] = [];
  const resultQueue: RuntimeWakeResult[] = Array.isArray(results)
    ? [...results]
    : typeof results === 'function'
      ? []
      : [results];
  const bridge: CoordinatorBridge = {
    runtimeWake: vi.fn(async params => {
      const call: CoordinatorBridgeCall = {
        conversationId: params.conversation_id,
        agentId: params.agent_id,
        deliveryIds: [...params.delivery_ids],
        kind: params.kind,
        payload: params.payload,
      };
      calls.push(call);
      if (typeof results === 'function') {
        const r = results(call);
        if (r instanceof Error) throw r;
        return r;
      }
      if (resultQueue.length === 0) {
        throw new Error(
          `runtimeWake called more times than results queued; call #${calls.length}`,
        );
      }
      return resultQueue.shift()!;
    }),
  };
  return { bridge, calls };
}

interface CoordinatorBridgeCall {
  conversationId: string;
  agentId: string;
  deliveryIds: number[];
  kind: 'message' | 'schedule_fire';
  payload: string;
}

function makeCacheView(
  entries: Array<{ conv: string; agent: string; phase: RuntimePhase }>,
): CoordinatorCacheView {
  const map = new Map<string, { phase: RuntimePhase }>();
  for (const e of entries) {
    map.set(`${e.conv}|${e.agent}`, { phase: e.phase });
  }
  return {
    get(conv, agent) {
      return map.get(`${conv}|${agent}`);
    },
  };
}

function makeInboxSink(): {
  sink: CoordinatorInboxSink;
  delivered: number[][];
} {
  const delivered: number[][] = [];
  const sink: CoordinatorInboxSink = {
    markDelivered(ids) {
      delivered.push([...ids]);
    },
  };
  return { sink, delivered };
}

const DRIVER_DIRECT: DriverDeliveryView = {
  busyDeliveryMode: 'direct',
  oneShot: false,
};
const DRIVER_GATED: DriverDeliveryView = {
  busyDeliveryMode: 'gated',
  oneShot: false,
};
const DRIVER_NONE: DriverDeliveryView = {
  busyDeliveryMode: 'none',
  oneShot: true,
};

function req(
  overrides: Partial<LiveDeliveryRequest> = {},
): LiveDeliveryRequest {
  return {
    inboxId: 1,
    messageId: 'm1',
    payload: '{"type":"user","message":"hi"}',
    driver: DRIVER_GATED,
    ...overrides,
  };
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
    case 'unknown':
      return { kind, raw: '' };
  }
}

// ── case 1 — runtime not running ───────────────────────────────────

describe('case 1: runtime not running (no cache entry)', () => {
  it('noop_no_runtime; no wake, no markDelivered', async () => {
    const { bridge, calls } = makeBridge([]);
    const cache = makeCacheView([]); // empty cache
    const { sink, delivered } = makeInboxSink();
    const c = new RuntimeDeliveryCoordinator({ bridge, cache, inboxAck: sink });

    const decision = await c.submitLiveDelivery('c1', 'a1', req());

    expect(decision).toEqual({ kind: 'noop_no_runtime' });
    expect(calls).toHaveLength(0);
    expect(delivered).toHaveLength(0);
  });
});

// ── case 2 — startup_pending ───────────────────────────────────────

describe('case 2: phase=startup_pending', () => {
  it('noop_phase; row stays pending', async () => {
    const { bridge, calls } = makeBridge([]);
    const cache = makeCacheView([
      { conv: 'c1', agent: 'a1', phase: 'startup_pending' },
    ]);
    const { sink, delivered } = makeInboxSink();
    const c = new RuntimeDeliveryCoordinator({ bridge, cache, inboxAck: sink });

    const decision = await c.submitLiveDelivery('c1', 'a1', req());

    expect(decision).toEqual({ kind: 'noop_phase', phase: 'startup_pending' });
    expect(calls).toHaveLength(0);
    expect(delivered).toHaveLength(0);
  });
});

// ── case 3 — draining ──────────────────────────────────────────────

describe('case 3: phase=draining', () => {
  it('noop_phase; row stays pending for next start', async () => {
    const { bridge, calls } = makeBridge([]);
    const cache = makeCacheView([
      { conv: 'c1', agent: 'a1', phase: 'draining' },
    ]);
    const { sink, delivered } = makeInboxSink();
    const c = new RuntimeDeliveryCoordinator({ bridge, cache, inboxAck: sink });

    const decision = await c.submitLiveDelivery('c1', 'a1', req());

    expect(decision).toEqual({ kind: 'noop_phase', phase: 'draining' });
    expect(calls).toHaveLength(0);
    expect(delivered).toHaveLength(0);
  });

  it('also noop on phase=exited (stale cache projection)', async () => {
    const { bridge, calls } = makeBridge([]);
    const cache = makeCacheView([
      { conv: 'c1', agent: 'a1', phase: 'exited' },
    ]);
    const { sink, delivered } = makeInboxSink();
    const c = new RuntimeDeliveryCoordinator({ bridge, cache, inboxAck: sink });

    const decision = await c.submitLiveDelivery('c1', 'a1', req());

    expect(decision).toEqual({ kind: 'noop_phase', phase: 'exited' });
    expect(calls).toHaveLength(0);
    expect(delivered).toHaveLength(0);
  });
});

// ── case 4 — ready + direct driver ─────────────────────────────────

describe('case 4: phase=ready + driver=direct (immediate wake)', () => {
  it('wake_dispatched; markDelivered on success', async () => {
    const { bridge, calls } = makeBridge({
      delivered: true,
      delivery_ids: [42],
    });
    const cache = makeCacheView([
      { conv: 'c1', agent: 'a1', phase: 'ready' },
    ]);
    const { sink, delivered } = makeInboxSink();
    const c = new RuntimeDeliveryCoordinator({ bridge, cache, inboxAck: sink });

    const decision = await c.submitLiveDelivery(
      'c1',
      'a1',
      req({ inboxId: 42, driver: DRIVER_DIRECT }),
    );

    expect(decision).toEqual({
      kind: 'wake_dispatched',
      deliveryIds: [42],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      conversationId: 'c1',
      agentId: 'a1',
      deliveryIds: [42],
      kind: 'message',
    });
    expect(delivered).toEqual([[42]]);
  });

  it('wake_refused; NO markDelivered, NO row mutation', async () => {
    const { bridge, calls } = makeBridge({
      delivered: false,
      reason: 'driver_refused',
      delivery_ids: [42],
    });
    const cache = makeCacheView([
      { conv: 'c1', agent: 'a1', phase: 'ready' },
    ]);
    const { sink, delivered } = makeInboxSink();
    const c = new RuntimeDeliveryCoordinator({ bridge, cache, inboxAck: sink });

    const decision = await c.submitLiveDelivery(
      'c1',
      'a1',
      req({ inboxId: 42, driver: DRIVER_DIRECT }),
    );

    expect(decision).toEqual({
      kind: 'wake_refused',
      reason: 'driver_refused',
    });
    expect(calls).toHaveLength(1);
    expect(delivered).toHaveLength(0);
  });

  it('bridge throws (transport error) → no markDelivered, propagates', async () => {
    const { bridge, calls } = makeBridge(() => new Error('socket closed'));
    const cache = makeCacheView([
      { conv: 'c1', agent: 'a1', phase: 'ready' },
    ]);
    const { sink, delivered } = makeInboxSink();
    const c = new RuntimeDeliveryCoordinator({ bridge, cache, inboxAck: sink });

    await expect(
      c.submitLiveDelivery(
        'c1',
        'a1',
        req({ inboxId: 42, driver: DRIVER_DIRECT }),
      ),
    ).rejects.toThrow(/socket closed/);

    expect(calls).toHaveLength(1);
    expect(delivered).toHaveLength(0);
  });
});

// ── case 5 — ready + gated + busy ──────────────────────────────────

describe('case 5: phase=ready + driver=gated + busy mid-turn', () => {
  it('queued_mid_turn; no wake until safe boundary; flush wakes', async () => {
    const { bridge, calls } = makeBridge({
      delivered: true,
      delivery_ids: [7],
    });
    const cache = makeCacheView([
      { conv: 'c1', agent: 'a1', phase: 'ready' },
    ]);
    const { sink, delivered } = makeInboxSink();
    const c = new RuntimeDeliveryCoordinator({ bridge, cache, inboxAck: sink });

    // Simulate a tool_call to drive busy → 1.
    c.onParsedEvent('c1', 'a1', parsed('tool_call'));
    expect(c.busySnapshot('c1', 'a1')).toEqual({
      outstandingToolUses: 1,
      compacting: false,
    });

    const decision = await c.submitLiveDelivery(
      'c1',
      'a1',
      req({ inboxId: 7, driver: DRIVER_GATED }),
    );

    expect(decision).toEqual({ kind: 'queued_mid_turn', pendingCount: 1 });
    expect(calls).toHaveLength(0); // no wake yet
    expect(delivered).toHaveLength(0);
    expect(c.pendingCount('c1', 'a1')).toBe(1);

    // Tool output closes the call; busy → 0 → safe boundary opens →
    // flush scheduled. Wait a microtask for the async flush.
    c.onParsedEvent('c1', 'a1', parsed('tool_output'));
    await new Promise(resolve => setImmediate(resolve));

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ deliveryIds: [7] });
    expect(delivered).toEqual([[7]]);
    expect(c.pendingCount('c1', 'a1')).toBe(0);
  });

  it('compaction blocks flush even when outstandingToolUses=0', async () => {
    const { bridge, calls } = makeBridge({
      delivered: true,
      delivery_ids: [9],
    });
    const cache = makeCacheView([
      { conv: 'c1', agent: 'a1', phase: 'ready' },
    ]);
    const { sink, delivered } = makeInboxSink();
    const c = new RuntimeDeliveryCoordinator({ bridge, cache, inboxAck: sink });

    // Compaction without any outstanding tool uses → still not a safe
    // boundary; submit should queue.
    c.onParsedEvent('c1', 'a1', parsed('compaction_started'));

    const decision = await c.submitLiveDelivery(
      'c1',
      'a1',
      req({ inboxId: 9, driver: DRIVER_GATED }),
    );
    expect(decision.kind).toBe('queued_mid_turn');
    expect(calls).toHaveLength(0);

    // Finish compaction → flush.
    c.onParsedEvent('c1', 'a1', parsed('compaction_finished'));
    await new Promise(resolve => setImmediate(resolve));

    expect(calls).toHaveLength(1);
    expect(delivered).toEqual([[9]]);
  });

  it('turn_end flushes (clamps outstandingToolUses to 0)', async () => {
    const { bridge, calls } = makeBridge({
      delivered: true,
      delivery_ids: [11],
    });
    const cache = makeCacheView([
      { conv: 'c1', agent: 'a1', phase: 'ready' },
    ]);
    const { sink, delivered } = makeInboxSink();
    const c = new RuntimeDeliveryCoordinator({ bridge, cache, inboxAck: sink });

    // Drive busy → 2 (two tool_calls), then queue, then turn_end.
    c.onParsedEvent('c1', 'a1', parsed('tool_call'));
    c.onParsedEvent('c1', 'a1', parsed('tool_call'));
    await c.submitLiveDelivery(
      'c1',
      'a1',
      req({ inboxId: 11, driver: DRIVER_GATED }),
    );
    expect(calls).toHaveLength(0);

    c.onParsedEvent('c1', 'a1', parsed('turn_end'));
    await new Promise(resolve => setImmediate(resolve));

    expect(calls).toHaveLength(1);
    expect(delivered).toEqual([[11]]);
    expect(c.busySnapshot('c1', 'a1').outstandingToolUses).toBe(0);
  });

  it('multiple queued items flush as one batch via combineBatch', async () => {
    const { bridge, calls } = makeBridge({
      delivered: true,
      delivery_ids: [1, 2],
    });
    const cache = makeCacheView([
      { conv: 'c1', agent: 'a1', phase: 'ready' },
    ]);
    const { sink, delivered } = makeInboxSink();
    const combineBatch = vi.fn((payloads: readonly string[]) =>
      payloads.join('|'),
    );
    const c = new RuntimeDeliveryCoordinator({
      bridge,
      cache,
      inboxAck: sink,
      callbacks: { combineBatch },
    });

    c.onParsedEvent('c1', 'a1', parsed('tool_call'));
    await c.submitLiveDelivery(
      'c1',
      'a1',
      req({ inboxId: 1, messageId: 'm-a', payload: 'A', driver: DRIVER_GATED }),
    );
    await c.submitLiveDelivery(
      'c1',
      'a1',
      req({ inboxId: 2, messageId: 'm-b', payload: 'B', driver: DRIVER_GATED }),
    );
    expect(c.pendingCount('c1', 'a1')).toBe(2);

    c.onParsedEvent('c1', 'a1', parsed('tool_output'));
    await new Promise(resolve => setImmediate(resolve));

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      deliveryIds: [1, 2],
      payload: 'A|B',
    });
    expect(combineBatch).toHaveBeenCalledTimes(1);
    expect(delivered).toEqual([[1, 2]]);
  });

  it('idempotent enqueue: same messageId twice → pending stays 1', async () => {
    const { bridge } = makeBridge([]);
    const cache = makeCacheView([
      { conv: 'c1', agent: 'a1', phase: 'ready' },
    ]);
    const { sink } = makeInboxSink();
    const c = new RuntimeDeliveryCoordinator({ bridge, cache, inboxAck: sink });

    c.onParsedEvent('c1', 'a1', parsed('tool_call'));
    const r = req({ inboxId: 5, driver: DRIVER_GATED });
    await c.submitLiveDelivery('c1', 'a1', r);
    await c.submitLiveDelivery('c1', 'a1', r);

    expect(c.pendingCount('c1', 'a1')).toBe(1);
  });

  it('flush refused: rows pushed back onto the queue, no markDelivered', async () => {
    const { bridge, calls } = makeBridge({
      delivered: false,
      reason: 'driver_refused',
      delivery_ids: [13],
    });
    const cache = makeCacheView([
      { conv: 'c1', agent: 'a1', phase: 'ready' },
    ]);
    const { sink, delivered } = makeInboxSink();
    const c = new RuntimeDeliveryCoordinator({ bridge, cache, inboxAck: sink });

    c.onParsedEvent('c1', 'a1', parsed('tool_call'));
    await c.submitLiveDelivery(
      'c1',
      'a1',
      req({ inboxId: 13, driver: DRIVER_GATED }),
    );
    c.onParsedEvent('c1', 'a1', parsed('tool_output'));
    await new Promise(resolve => setImmediate(resolve));

    expect(calls).toHaveLength(1);
    expect(delivered).toHaveLength(0);
    expect(c.pendingCount('c1', 'a1')).toBe(1);
  });
});

// ── case 6 — ready + driver=none (oneShot live) ────────────────────

describe('case 6: phase=ready + driver=none (oneShot live)', () => {
  it('noop_oneshot_live; never wakes', async () => {
    const { bridge, calls } = makeBridge([]);
    const cache = makeCacheView([
      { conv: 'c1', agent: 'a1', phase: 'ready' },
    ]);
    const { sink, delivered } = makeInboxSink();
    const c = new RuntimeDeliveryCoordinator({ bridge, cache, inboxAck: sink });

    const decision = await c.submitLiveDelivery(
      'c1',
      'a1',
      req({ driver: DRIVER_NONE }),
    );

    expect(decision).toEqual({ kind: 'noop_oneshot_live' });
    expect(calls).toHaveLength(0);
    expect(delivered).toHaveLength(0);
  });
});

// ── case 7 — oneShot exit auto-respawn ─────────────────────────────

describe('case 7: oneShot exit auto-respawn (intentional=false, no failure, pending)', () => {
  function setup({
    hasPending,
  }: {
    hasPending: boolean;
  }) {
    const { bridge } = makeBridge([]);
    const cache = makeCacheView([]);
    const { sink } = makeInboxSink();
    const respawn = vi.fn(() => Promise.resolve());
    const hasPendingInbox = vi.fn(() => hasPending);
    const c = new RuntimeDeliveryCoordinator({
      bridge,
      cache,
      inboxAck: sink,
      callbacks: { respawn, hasPendingInbox },
    });
    return { c, respawn, hasPendingInbox };
  }

  it('respawns on intentional=false, no init/fatal, hasPendingInbox=true', async () => {
    const { c, respawn } = setup({ hasPending: true });

    c.onRuntimeExit('c1', 'a1', {
      intentional: false,
      code: 0,
      initTimedOut: false,
      fatalError: false,
    });
    await new Promise(resolve => setImmediate(resolve));

    expect(respawn).toHaveBeenCalledWith('c1', 'a1');
  });

  it('does NOT respawn when intentional=true', async () => {
    const { c, respawn, hasPendingInbox } = setup({ hasPending: true });

    c.onRuntimeExit('c1', 'a1', {
      intentional: true,
      code: 0,
      initTimedOut: false,
      fatalError: false,
    });
    await new Promise(resolve => setImmediate(resolve));

    expect(respawn).not.toHaveBeenCalled();
    expect(hasPendingInbox).not.toHaveBeenCalled(); // short-circuit
  });

  it('does NOT respawn when initTimedOut=true', async () => {
    const { c, respawn } = setup({ hasPending: true });

    c.onRuntimeExit('c1', 'a1', {
      intentional: false,
      code: 1,
      initTimedOut: true,
      fatalError: false,
    });
    await new Promise(resolve => setImmediate(resolve));

    expect(respawn).not.toHaveBeenCalled();
  });

  it('does NOT respawn when fatalError=true', async () => {
    const { c, respawn } = setup({ hasPending: true });

    c.onRuntimeExit('c1', 'a1', {
      intentional: false,
      code: 1,
      initTimedOut: false,
      fatalError: true,
    });
    await new Promise(resolve => setImmediate(resolve));

    expect(respawn).not.toHaveBeenCalled();
  });

  it('does NOT respawn when no pending inbox', async () => {
    const { c, respawn, hasPendingInbox } = setup({ hasPending: false });

    c.onRuntimeExit('c1', 'a1', {
      intentional: false,
      code: 0,
      initTimedOut: false,
      fatalError: false,
    });
    await new Promise(resolve => setImmediate(resolve));

    expect(hasPendingInbox).toHaveBeenCalledWith('c1', 'a1');
    expect(respawn).not.toHaveBeenCalled();
  });

  it('respawn callback throws → logged but swallowed', async () => {
    const { bridge } = makeBridge([]);
    const cache = makeCacheView([]);
    const { sink } = makeInboxSink();
    const respawn = vi.fn(() => Promise.reject(new Error('start refused')));
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const c = new RuntimeDeliveryCoordinator({
      bridge,
      cache,
      inboxAck: sink,
      callbacks: { respawn, hasPendingInbox: () => true },
      logger,
    });

    c.onRuntimeExit('c1', 'a1', {
      intentional: false,
      code: 0,
      initTimedOut: false,
      fatalError: false,
    });
    // Wait for the Promise.resolve().then(...) microtask + the
    // subsequent rejection .catch to run.
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));

    expect(respawn).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'c1',
        agentId: 'a1',
        err: 'start refused',
      }),
      expect.stringContaining('oneShot auto-respawn failed'),
    );
  });

  it('clears per-agent state on exit (busy + pending dropped)', async () => {
    const { bridge } = makeBridge([]);
    const cache = makeCacheView([
      { conv: 'c1', agent: 'a1', phase: 'ready' },
    ]);
    const { sink } = makeInboxSink();
    const c = new RuntimeDeliveryCoordinator({ bridge, cache, inboxAck: sink });

    // Build up some state.
    c.onParsedEvent('c1', 'a1', parsed('tool_call'));
    c.onParsedEvent('c1', 'a1', parsed('compaction_started'));
    await c.submitLiveDelivery(
      'c1',
      'a1',
      req({ inboxId: 99, driver: DRIVER_GATED }),
    );
    expect(c.pendingCount('c1', 'a1')).toBe(1);
    expect(c.busySnapshot('c1', 'a1')).toEqual({
      outstandingToolUses: 1,
      compacting: true,
    });

    c.onRuntimeExit('c1', 'a1', {
      intentional: true, // suppress respawn so we isolate the state-clear assertion
      code: 0,
      initTimedOut: false,
      fatalError: false,
    });

    expect(c.pendingCount('c1', 'a1')).toBe(0);
    expect(c.busySnapshot('c1', 'a1')).toEqual({
      outstandingToolUses: 0,
      compacting: false,
    });
  });
});

// ── cross-(conv,agent) isolation ───────────────────────────────────

describe('per-(conv,agent) isolation', () => {
  it('busy state on (c1,a1) does not affect (c2,a2)', async () => {
    const { bridge, calls } = makeBridge({
      delivered: true,
      delivery_ids: [200],
    });
    const cache = makeCacheView([
      { conv: 'c1', agent: 'a1', phase: 'ready' },
      { conv: 'c2', agent: 'a2', phase: 'ready' },
    ]);
    const { sink, delivered } = makeInboxSink();
    const c = new RuntimeDeliveryCoordinator({ bridge, cache, inboxAck: sink });

    // (c1, a1) goes busy.
    c.onParsedEvent('c1', 'a1', parsed('tool_call'));

    // (c2, a2) is still at safe boundary → direct wake fires.
    const decision = await c.submitLiveDelivery(
      'c2',
      'a2',
      req({ inboxId: 200, driver: DRIVER_GATED }),
    );

    expect(decision.kind).toBe('wake_dispatched');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      conversationId: 'c2',
      agentId: 'a2',
    });
    expect(delivered).toEqual([[200]]);
  });

  it('exit on (c1,a1) does not clear (c2,a2) busy state', async () => {
    const { bridge } = makeBridge([]);
    const cache = makeCacheView([
      { conv: 'c1', agent: 'a1', phase: 'ready' },
      { conv: 'c2', agent: 'a2', phase: 'ready' },
    ]);
    const { sink } = makeInboxSink();
    const c = new RuntimeDeliveryCoordinator({ bridge, cache, inboxAck: sink });

    c.onParsedEvent('c2', 'a2', parsed('tool_call'));
    expect(c.busySnapshot('c2', 'a2').outstandingToolUses).toBe(1);

    c.onRuntimeExit('c1', 'a1', {
      intentional: true,
      code: 0,
      initTimedOut: false,
      fatalError: false,
    });

    expect(c.busySnapshot('c2', 'a2').outstandingToolUses).toBe(1);
  });
});

// ── busy tracker invariants ────────────────────────────────────────

describe('busy tracker', () => {
  it('tool_output below 0 clamps to 0', () => {
    const { bridge } = makeBridge([]);
    const cache = makeCacheView([
      { conv: 'c1', agent: 'a1', phase: 'ready' },
    ]);
    const { sink } = makeInboxSink();
    const c = new RuntimeDeliveryCoordinator({ bridge, cache, inboxAck: sink });

    c.onParsedEvent('c1', 'a1', parsed('tool_output'));
    expect(c.busySnapshot('c1', 'a1').outstandingToolUses).toBe(0);

    c.onParsedEvent('c1', 'a1', parsed('tool_output'));
    expect(c.busySnapshot('c1', 'a1').outstandingToolUses).toBe(0);
  });

  it('session_init / thinking / text / error / unknown are noops', () => {
    const { bridge } = makeBridge([]);
    const cache = makeCacheView([
      { conv: 'c1', agent: 'a1', phase: 'ready' },
    ]);
    const { sink } = makeInboxSink();
    const c = new RuntimeDeliveryCoordinator({ bridge, cache, inboxAck: sink });

    c.onParsedEvent('c1', 'a1', parsed('tool_call'));
    c.onParsedEvent('c1', 'a1', parsed('session_init'));
    c.onParsedEvent('c1', 'a1', parsed('thinking'));
    c.onParsedEvent('c1', 'a1', parsed('text'));
    c.onParsedEvent('c1', 'a1', parsed('error'));
    c.onParsedEvent('c1', 'a1', parsed('unknown'));
    // tool_call set it to 1; no other event should have moved it.
    expect(c.busySnapshot('c1', 'a1').outstandingToolUses).toBe(1);
    expect(c.busySnapshot('c1', 'a1').compacting).toBe(false);
  });

  it('boundary re-open does NOT flush when queue is empty', async () => {
    const { bridge, calls } = makeBridge([]);
    const cache = makeCacheView([
      { conv: 'c1', agent: 'a1', phase: 'ready' },
    ]);
    const { sink } = makeInboxSink();
    const c = new RuntimeDeliveryCoordinator({ bridge, cache, inboxAck: sink });

    c.onParsedEvent('c1', 'a1', parsed('tool_call'));
    c.onParsedEvent('c1', 'a1', parsed('tool_output'));
    await new Promise(resolve => setImmediate(resolve));

    expect(calls).toHaveLength(0);
  });
});
