/**
 * Fake supervisor unit tests — exercise the state machine in
 * isolation, no socket / dispatcher / network involvement. Tests use
 * a synchronous schedule override so each `start/stop/wake` call's
 * side-effects are observable on the next line.
 */
import { describe, expect, it } from 'vitest';
import {
  FakeSupervisor,
  type FakeSupervisorOptions,
  type FakeSupervisorPhase,
} from '../src/daemon/fake-supervisor.js';
import type { EventFrame } from '../src/protocol.js';

interface Harness {
  supervisor: FakeSupervisor;
  events: EventFrame[];
  /** Drain all pending scheduled callbacks. The harness uses a
   *  manual queue so tests can advance time deterministically. */
  flush: () => void;
}

function makeHarness(
  override: Partial<FakeSupervisorOptions> = {},
): Harness {
  const events: EventFrame[] = [];
  const queue: Array<() => void> = [];
  const supervisor = new FakeSupervisor({
    emit: e => {
      events.push(e);
    },
    now: () => 1_000,
    schedule: cb => {
      queue.push(cb);
    },
    ...override,
  });
  const flush = (): void => {
    // Run queued callbacks until the queue is empty; new items may
    // be appended as side-effects (none currently, but defensive).
    while (queue.length) {
      const cb = queue.shift()!;
      cb();
    }
  };
  return { supervisor, events, flush };
}

describe('FakeSupervisor — start without startup_delivery', () => {
  it('transitions spawning → ready and emits runtime_ready_for_drain', () => {
    const h = makeHarness();
    const r = h.supervisor.start({
      conversation_id: 'c1',
      agent_id: 'a1',
      options: {},
    });
    expect(r.pid).toBeGreaterThan(0);
    expect(r.startup_delivery_accepted).toBeUndefined();
    expect(h.supervisor.__getPhase('c1', 'a1')).toBe<FakeSupervisorPhase>(
      'spawning',
    );
    expect(h.events).toEqual([]);

    h.flush();
    expect(h.supervisor.__getPhase('c1', 'a1')).toBe<FakeSupervisorPhase>(
      'ready',
    );
    expect(h.events).toEqual([
      {
        event: 'runtime_ready_for_drain',
        conversation_id: 'c1',
        agent_id: 'a1',
        ts: 1_000,
      },
    ]);
  });

  it('is idempotent on (conv, agent) — second start returns same pid + no double-spawn', () => {
    const h = makeHarness();
    const first = h.supervisor.start({
      conversation_id: 'c1',
      agent_id: 'a1',
      options: {},
    });
    h.flush();
    const second = h.supervisor.start({
      conversation_id: 'c1',
      agent_id: 'a1',
      options: {},
    });
    expect(second.pid).toBe(first.pid);
    expect(second.started_at).toBe(first.started_at);
    h.flush();
    // Only the first start should have caused a ready_for_drain
    // emit; the second was a no-op.
    expect(h.events.filter(e => e.event === 'runtime_ready_for_drain')).toHaveLength(
      1,
    );
  });
});

describe('FakeSupervisor — start with startup_delivery (happy path)', () => {
  it('emits consumed → ready_for_drain and pins delivery_ids verbatim', () => {
    const h = makeHarness();
    const r = h.supervisor.start({
      conversation_id: 'c1',
      agent_id: 'a1',
      options: {},
      startup_delivery: {
        delivery_ids: [101, 102, 103],
        payload: { type: 'user', message: { content: 'hi' } },
      },
    });
    expect(r.startup_delivery_accepted).toBe(true);
    expect(h.supervisor.__getPhase('c1', 'a1')).toBe<FakeSupervisorPhase>(
      'startup_pending',
    );

    h.flush();
    expect(h.supervisor.__getPhase('c1', 'a1')).toBe<FakeSupervisorPhase>(
      'ready',
    );
    expect(h.events.map(e => e.event)).toEqual([
      'runtime_startup_delivery_consumed',
      'runtime_ready_for_drain',
    ]);
    const consumed = h.events[0];
    if (!consumed || consumed.event !== 'runtime_startup_delivery_consumed') {
      throw new Error('discriminant mismatch');
    }
    expect(consumed.delivery_ids).toEqual([101, 102, 103]);
  });
});

describe('FakeSupervisor — start with startup_delivery (failure path)', () => {
  it('emits failed + exit; runtime is left in exited state; no ready_for_drain', () => {
    const h = makeHarness({ failStartupDelivery: true });
    h.supervisor.start({
      conversation_id: 'c1',
      agent_id: 'a1',
      options: {},
      startup_delivery: { delivery_ids: [1, 2], payload: {} },
    });
    h.flush();
    expect(h.supervisor.__getPhase('c1', 'a1')).toBe<FakeSupervisorPhase>(
      'exited',
    );
    expect(h.events.map(e => e.event)).toEqual([
      'runtime_startup_delivery_failed',
      'runtime_exit',
    ]);
    const failed = h.events[0];
    if (!failed || failed.event !== 'runtime_startup_delivery_failed') {
      throw new Error('discriminant mismatch');
    }
    expect(failed.delivery_ids).toEqual([1, 2]);
    expect(failed.reason).toBe('init_watchdog');
  });
});

describe('FakeSupervisor — wake (state-machine reasons per §3.2.1)', () => {
  it('returns not_running when no start has been issued', () => {
    const h = makeHarness();
    const r = h.supervisor.wake({
      conversation_id: 'c1',
      agent_id: 'a1',
      delivery_ids: [42],
      kind: 'message',
      payload: {},
    });
    expect(r).toEqual({
      delivered: false,
      reason: 'not_running',
      delivery_ids: [42],
    });
  });

  it('returns not_initialized while phase=spawning', () => {
    const h = makeHarness();
    h.supervisor.start({
      conversation_id: 'c1',
      agent_id: 'a1',
      options: {},
    });
    // Do NOT flush — runtime is still in spawning.
    const r = h.supervisor.wake({
      conversation_id: 'c1',
      agent_id: 'a1',
      delivery_ids: [42],
      kind: 'message',
      payload: {},
    });
    expect(r).toEqual({
      delivered: false,
      reason: 'not_initialized',
      delivery_ids: [42],
    });
  });

  it('returns startup_pending while a startup_delivery is in flight', () => {
    const h = makeHarness();
    h.supervisor.start({
      conversation_id: 'c1',
      agent_id: 'a1',
      options: {},
      startup_delivery: { delivery_ids: [1], payload: {} },
    });
    const r = h.supervisor.wake({
      conversation_id: 'c1',
      agent_id: 'a1',
      delivery_ids: [42],
      kind: 'message',
      payload: {},
    });
    expect(r.delivered).toBe(false);
    if (r.delivered === false) expect(r.reason).toBe('startup_pending');
  });

  it('returns delivered=true with delivery_ids round-tripped on ready phase', () => {
    const h = makeHarness();
    h.supervisor.start({
      conversation_id: 'c1',
      agent_id: 'a1',
      options: {},
    });
    h.flush();
    const r = h.supervisor.wake({
      conversation_id: 'c1',
      agent_id: 'a1',
      delivery_ids: [10, 11, 12],
      kind: 'message',
      payload: {},
    });
    expect(r).toEqual({ delivered: true, delivery_ids: [10, 11, 12] });
  });

  it('returns draining once stop has begun but exit has not yet fired', () => {
    const h = makeHarness();
    h.supervisor.start({
      conversation_id: 'c1',
      agent_id: 'a1',
      options: {},
    });
    h.flush();
    h.supervisor.stop({
      conversation_id: 'c1',
      agent_id: 'a1',
      mode: 'soft',
    });
    const r = h.supervisor.wake({
      conversation_id: 'c1',
      agent_id: 'a1',
      delivery_ids: [1],
      kind: 'message',
      payload: {},
    });
    expect(r.delivered).toBe(false);
    if (r.delivered === false) expect(r.reason).toBe('draining');
  });

  it('returns not_running once exit has fired', () => {
    const h = makeHarness();
    h.supervisor.start({
      conversation_id: 'c1',
      agent_id: 'a1',
      options: {},
    });
    h.flush();
    h.supervisor.stop({
      conversation_id: 'c1',
      agent_id: 'a1',
      mode: 'soft',
    });
    h.flush();
    const r = h.supervisor.wake({
      conversation_id: 'c1',
      agent_id: 'a1',
      delivery_ids: [1],
      kind: 'message',
      payload: {},
    });
    expect(r.delivered).toBe(false);
    if (r.delivered === false) expect(r.reason).toBe('not_running');
  });
});

describe('FakeSupervisor — stop / clearSession / stopAll', () => {
  it('stop transitions ready → draining → exited and emits runtime_exit', () => {
    const h = makeHarness();
    h.supervisor.start({
      conversation_id: 'c1',
      agent_id: 'a1',
      options: {},
    });
    h.flush();
    const r = h.supervisor.stop({
      conversation_id: 'c1',
      agent_id: 'a1',
      mode: 'hard',
    });
    expect(r).toEqual({ stopped: true, exit_code: 137 });
    expect(h.supervisor.__getPhase('c1', 'a1')).toBe<FakeSupervisorPhase>(
      'draining',
    );
    h.flush();
    expect(h.supervisor.__getPhase('c1', 'a1')).toBe<FakeSupervisorPhase>(
      'exited',
    );
    const exitEvent = h.events.find(e => e.event === 'runtime_exit');
    expect(exitEvent).toBeDefined();
    if (exitEvent && exitEvent.event === 'runtime_exit') {
      expect(exitEvent.intentional).toBe(true);
    }
  });

  it('stop on a never-started runtime is a no-op', () => {
    const h = makeHarness();
    const r = h.supervisor.stop({
      conversation_id: 'c1',
      agent_id: 'a1',
      mode: 'soft',
    });
    expect(r).toEqual({ stopped: false, exit_code: null });
  });

  it('clearSession hard-kills regardless of mode, returns cleared=true', () => {
    const h = makeHarness();
    h.supervisor.start({
      conversation_id: 'c1',
      agent_id: 'a1',
      options: {},
    });
    h.flush();
    const r = h.supervisor.clearSession({
      conversation_id: 'c1',
      agent_id: 'a1',
    });
    expect(r).toEqual({ cleared: true });
    h.flush();
    expect(h.supervisor.__getPhase('c1', 'a1')).toBe<FakeSupervisorPhase>(
      'exited',
    );
  });

  it('stopAll counts only live runtimes', () => {
    const h = makeHarness();
    h.supervisor.start({
      conversation_id: 'c1',
      agent_id: 'a1',
      options: {},
    });
    h.supervisor.start({
      conversation_id: 'c2',
      agent_id: 'a2',
      options: {},
    });
    h.flush();
    h.supervisor.stop({
      conversation_id: 'c2',
      agent_id: 'a2',
      mode: 'soft',
    });
    h.flush();
    const r = h.supervisor.stopAll({});
    // c2 already exited; only c1 was still live → count=1.
    expect(r.stopped_count).toBe(1);
  });
});

describe('FakeSupervisor — status', () => {
  it('returns one row per live runtime with phase + pid + started_at', () => {
    const h = makeHarness();
    h.supervisor.start({
      conversation_id: 'c1',
      agent_id: 'a1',
      options: {},
    });
    h.supervisor.start({
      conversation_id: 'c2',
      agent_id: 'a2',
      options: {},
    });
    h.flush();
    const r = h.supervisor.status({});
    expect(r.runtimes).toHaveLength(2);
    for (const rt of r.runtimes) {
      expect(rt.phase).toBe('ready');
      expect(rt.pid).toBeGreaterThan(0);
      expect(rt.started_at).toBe(1_000);
    }
  });

  it('filters by conversation_id when supplied', () => {
    const h = makeHarness();
    h.supervisor.start({
      conversation_id: 'c1',
      agent_id: 'a1',
      options: {},
    });
    h.supervisor.start({
      conversation_id: 'c2',
      agent_id: 'a2',
      options: {},
    });
    h.flush();
    const r = h.supervisor.status({ conversation_id: 'c1' });
    expect(r.runtimes).toHaveLength(1);
    expect(r.runtimes[0]?.conversation_id).toBe('c1');
  });

  it('reports phase=exited and pid=null after exit', () => {
    const h = makeHarness();
    h.supervisor.start({
      conversation_id: 'c1',
      agent_id: 'a1',
      options: {},
    });
    h.flush();
    h.supervisor.stop({
      conversation_id: 'c1',
      agent_id: 'a1',
      mode: 'hard',
    });
    h.flush();
    const r = h.supervisor.status({});
    expect(r.runtimes).toHaveLength(1);
    expect(r.runtimes[0]?.phase).toBe('exited');
    expect(r.runtimes[0]?.pid).toBeNull();
  });
});

describe('FakeSupervisor — closeActivityLog', () => {
  it('returns flushed=true (fake holds no log file)', () => {
    const h = makeHarness();
    expect(h.supervisor.closeActivityLog({})).toEqual({ flushed: true });
  });
});
