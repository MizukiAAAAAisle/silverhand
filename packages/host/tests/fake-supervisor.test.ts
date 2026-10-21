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
} from './_helpers/fake-supervisor.js';
import { testStartOptions } from './_helpers/runtime-start-options.js';
import type { EventFrame, RuntimeStartResult } from '../src/protocol.js';

/** Narrow a `RuntimeStartResult` to the success arm; throws on the
 *  cooldown arm — every fake-supervisor test expects success. See
 *  the longer explanation in `supervisor.test.ts`. */
function assertStarted(
  res: RuntimeStartResult,
): asserts res is Extract<RuntimeStartResult, { started: true }> {
  if (!res.started) {
    throw new Error(`expected start() to succeed: ${JSON.stringify(res)}`);
  }
}

function outputScope(conversationId: string, agentId: string) {
  return {
    runtime_scope: {
      kind: 'conversation' as const,
      conversation_id: conversationId,
      agent_id: agentId,
    },
  };
}

interface Harness {
  supervisor: FakeSupervisor;
  events: EventFrame[];
  /** Drain all pending scheduled callbacks. The harness uses a
   *  manual queue so tests can advance time deterministically. */
  flush: () => void;
}

function makeHarness(override: Partial<FakeSupervisorOptions> = {}): Harness {
  const events: EventFrame[] = [];
  const queue: Array<() => void> = [];
  const supervisor = new FakeSupervisor({
    emit: (e) => {
      events.push(e);
    },
    now: () => 1_000,
    schedule: (cb) => {
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
  it('transitions spawning → ready and emits runtime_state + runtime_ready_for_drain', () => {
    const h = makeHarness();
    const r = h.supervisor.start({
      runtime_generation: 1,
      conversation_id: 'c1',
      agent_id: 'a1',
      options: testStartOptions(),
    });
    assertStarted(r);
    expect(r.pid).toBeGreaterThan(0);
    expect(h.supervisor.__getPhase('c1', 'a1')).toBe<FakeSupervisorPhase>('spawning');
    // Initial runtime_state(starting) is emitted synchronously inside
    // start() so backend snapshot reconciles never see a "missing
    // initial state" gap.
    expect(h.events.map((e) => e.event)).toEqual(['runtime_state']);
    const initial = h.events[0];
    if (!initial || initial.event !== 'runtime_state') throw new Error('shape');
    expect(initial.state.status).toBe('starting');

    h.flush();
    expect(h.supervisor.__getPhase('c1', 'a1')).toBe<FakeSupervisorPhase>('ready');
    // Phase change to ready emits another runtime_state(idle) before
    // ready_for_drain.
    expect(h.events.map((e) => e.event)).toEqual([
      'runtime_state',
      'runtime_state',
      'runtime_ready_for_drain',
    ]);
    const ready = h.events[1];
    if (!ready || ready.event !== 'runtime_state') throw new Error('shape');
    expect(ready.state.status).toBe('idle');
  });

  it('is idempotent on (conv, agent) — second start returns same pid + no double-spawn', () => {
    const h = makeHarness();
    const first = h.supervisor.start({
      runtime_generation: 1,
      conversation_id: 'c1',
      agent_id: 'a1',
      options: testStartOptions(),
    });
    h.flush();
    const second = h.supervisor.start({
      runtime_generation: 1,
      conversation_id: 'c1',
      agent_id: 'a1',
      options: testStartOptions(),
    });
    assertStarted(first);
    assertStarted(second);
    expect(second.pid).toBe(first.pid);
    expect(second.started_at).toBe(first.started_at);
    h.flush();
    // Only the first start should have caused a ready_for_drain
    // emit; the second was a no-op.
    expect(h.events.filter((e) => e.event === 'runtime_ready_for_drain')).toHaveLength(1);
  });
});

describe('FakeSupervisor — deliver spawn-with-batch (happy path)', () => {
  it('no live runtime → spawning; emits state → consumed → state → ready_for_drain, pinning delivery_ids', () => {
    const h = makeHarness();
    const r = h.supervisor.deliver({
      runtime_generation: 1,
      conversation_id: 'c1',
      target: { conversation_id: 'c1', workspace: null },
      agent_id: 'a1',
      delivery_ids: [101, 102, 103],
      kind: 'message',
      text: 'hi',
      deliveries: [
        { delivery_id: 101, seq: 101, presentation: { body: 'hi', instruction: 'other' } },
        { delivery_id: 102, seq: 102, presentation: { body: 'hi', instruction: 'other' } },
        { delivery_id: 103, seq: 103, presentation: { body: 'hi', instruction: 'other' } },
      ],
      spawn_options: testStartOptions(),
    });
    expect(r.disposition).toBe('spawning');
    if (r.disposition === 'spawning') expect(r.pid).toBeGreaterThan(0);
    expect(h.supervisor.__getPhase('c1', 'a1')).toBe<FakeSupervisorPhase>('startup_pending');
    expect(h.events.map((e) => e.event)).toEqual(['runtime_state']);

    h.flush();
    expect(h.supervisor.__getPhase('c1', 'a1')).toBe<FakeSupervisorPhase>('ready');
    expect(h.events.map((e) => e.event)).toEqual([
      'runtime_state',
      'runtime_state',
      'runtime_delivery_consumed',
      'runtime_ready_for_drain',
    ]);
    const consumed = h.events[2];
    if (!consumed || consumed.event !== 'runtime_delivery_consumed') {
      throw new Error('discriminant mismatch');
    }
    expect(consumed.delivery_ids).toEqual([101, 102, 103]);
  });
});

describe('FakeSupervisor — deliver spawn-with-batch (failure path)', () => {
  it('emits state + failed + exit; runtime left exited; no ready_for_drain', () => {
    const h = makeHarness({ failStartupDelivery: true });
    h.supervisor.deliver({
      runtime_generation: 1,
      conversation_id: 'c1',
      target: { conversation_id: 'c1', workspace: null },
      agent_id: 'a1',
      delivery_ids: [1, 2],
      kind: 'message',
      text: 'stub',
      deliveries: [
        { delivery_id: 1, seq: 1, presentation: { body: 'stub', instruction: 'other' } },
        { delivery_id: 2, seq: 2, presentation: { body: 'stub', instruction: 'other' } },
      ],
      spawn_options: testStartOptions(),
    });
    h.flush();
    expect(h.supervisor.__getPhase('c1', 'a1')).toBe<FakeSupervisorPhase>('exited');
    expect(h.events.map((e) => e.event)).toEqual([
      'runtime_state', // initial starting
      'runtime_state', // exited (terminalReason=crashed)
      'runtime_delivery_failed',
      'runtime_exit',
    ]);
    // Terminal state line carries the terminalReason for the exit.
    const terminal = h.events[1];
    if (!terminal || terminal.event !== 'runtime_state') throw new Error('shape');
    expect(terminal.state.terminalReason).toBe('crashed');

    const failed = h.events[2];
    if (!failed || failed.event !== 'runtime_delivery_failed') {
      throw new Error('discriminant mismatch');
    }
    expect(failed.delivery_ids).toEqual([1, 2]);
    expect(failed.reason).toBe('init_watchdog');
  });
});

describe('FakeSupervisor — deliver (custody dispositions per §10.3)', () => {
  it('refused startup_pending while phase=spawning', () => {
    const h = makeHarness();
    h.supervisor.start({
      runtime_generation: 1,
      conversation_id: 'c1',
      agent_id: 'a1',
      options: testStartOptions(),
    });
    // Do NOT flush — runtime is still in spawning.
    const r = h.supervisor.deliver({
      runtime_generation: 1,
      conversation_id: 'c1',
      target: { conversation_id: 'c1', workspace: null },
      agent_id: 'a1',
      delivery_ids: [42],
      kind: 'message',
      text: 'stub',
      deliveries: [
        { delivery_id: 42, seq: 42, presentation: { body: 'stub', instruction: 'other' } },
      ],
      spawn_options: testStartOptions(),
    });
    expect(r.disposition).toBe('refused');
    if (r.disposition === 'refused') expect(r.reason).toBe('startup_pending');
  });

  it('refused startup_pending while a spawn-with-batch is still settling', () => {
    const h = makeHarness();
    h.supervisor.deliver({
      runtime_generation: 1,
      conversation_id: 'c1',
      target: { conversation_id: 'c1', workspace: null },
      agent_id: 'a1',
      delivery_ids: [1],
      kind: 'message',
      text: 'stub',
      deliveries: [
        { delivery_id: 1, seq: 1, presentation: { body: 'stub', instruction: 'other' } },
      ],
      spawn_options: testStartOptions(),
    });
    // Do NOT flush — the spawned runtime is still in startup_pending.
    const r = h.supervisor.deliver({
      runtime_generation: 1,
      conversation_id: 'c1',
      target: { conversation_id: 'c1', workspace: null },
      agent_id: 'a1',
      delivery_ids: [42],
      kind: 'message',
      text: 'stub',
      deliveries: [
        { delivery_id: 42, seq: 42, presentation: { body: 'stub', instruction: 'other' } },
      ],
      spawn_options: testStartOptions(),
    });
    expect(r.disposition).toBe('refused');
    if (r.disposition === 'refused') expect(r.reason).toBe('startup_pending');
  });

  it('admitted with async runtime_delivery_consumed on ready phase', () => {
    const h = makeHarness();
    h.supervisor.start({
      runtime_generation: 1,
      conversation_id: 'c1',
      agent_id: 'a1',
      options: testStartOptions(),
    });
    h.flush();
    const r = h.supervisor.deliver({
      runtime_generation: 1,
      conversation_id: 'c1',
      target: { conversation_id: 'c1', workspace: null },
      agent_id: 'a1',
      delivery_ids: [10, 11, 12],
      kind: 'message',
      text: 'stub',
      deliveries: [
        { delivery_id: 10, seq: 10, presentation: { body: 'stub', instruction: 'other' } },
        { delivery_id: 11, seq: 11, presentation: { body: 'stub', instruction: 'other' } },
        { delivery_id: 12, seq: 12, presentation: { body: 'stub', instruction: 'other' } },
      ],
      spawn_options: testStartOptions(),
    });
    expect(r.disposition).toBe('admitted');
    h.flush();
    const consumed = h.events.find((e) => e.event === 'runtime_delivery_consumed');
    if (!consumed || consumed.event !== 'runtime_delivery_consumed') {
      throw new Error('expected a runtime_delivery_consumed ack');
    }
    expect(consumed.delivery_ids).toEqual([10, 11, 12]);
  });

  it('refused draining once stop has begun but exit has not yet fired', () => {
    const h = makeHarness();
    h.supervisor.start({
      runtime_generation: 1,
      conversation_id: 'c1',
      agent_id: 'a1',
      options: testStartOptions(),
    });
    h.flush();
    h.supervisor.stop({
      conversation_id: 'c1',
      agent_id: 'a1',
      runtime_generation: 1,
      mode: 'hard',
    });
    const r = h.supervisor.deliver({
      runtime_generation: 1,
      conversation_id: 'c1',
      target: { conversation_id: 'c1', workspace: null },
      agent_id: 'a1',
      delivery_ids: [1],
      kind: 'message',
      text: 'stub',
      deliveries: [
        { delivery_id: 1, seq: 1, presentation: { body: 'stub', instruction: 'other' } },
      ],
      spawn_options: testStartOptions(),
    });
    expect(r.disposition).toBe('refused');
    if (r.disposition === 'refused') expect(r.reason).toBe('draining');
  });

  it('exited runtime → re-spawns (spawning), not refused', () => {
    const h = makeHarness();
    h.supervisor.start({
      runtime_generation: 1,
      conversation_id: 'c1',
      agent_id: 'a1',
      options: testStartOptions(),
    });
    h.flush();
    h.supervisor.stop({
      conversation_id: 'c1',
      agent_id: 'a1',
      runtime_generation: 1,
      mode: 'hard',
    });
    h.flush();
    const r = h.supervisor.deliver({
      runtime_generation: 1,
      conversation_id: 'c1',
      target: { conversation_id: 'c1', workspace: null },
      agent_id: 'a1',
      delivery_ids: [1],
      kind: 'message',
      text: 'stub',
      deliveries: [
        { delivery_id: 1, seq: 1, presentation: { body: 'stub', instruction: 'other' } },
      ],
      spawn_options: testStartOptions(),
    });
    // A dead handle is gone; deliver spawns-with-batch rather than refusing.
    expect(r.disposition).toBe('spawning');
  });
});

describe('FakeSupervisor — stop / clearSession / stopAll', () => {
  it('stop transitions ready → draining → exited and emits runtime_exit', () => {
    const h = makeHarness();
    h.supervisor.start({
      runtime_generation: 1,
      conversation_id: 'c1',
      agent_id: 'a1',
      options: testStartOptions(),
    });
    h.flush();
    const r = h.supervisor.stop({
      conversation_id: 'c1',
      agent_id: 'a1',
      runtime_generation: 1,
      mode: 'hard',
    });
    expect(r).toEqual({ mode: 'hard', stopped: true, exit_code: 137 });
    expect(h.supervisor.__getPhase('c1', 'a1')).toBe<FakeSupervisorPhase>('draining');
    h.flush();
    expect(h.supervisor.__getPhase('c1', 'a1')).toBe<FakeSupervisorPhase>('exited');
    const exitEvent = h.events.find((e) => e.event === 'runtime_exit');
    expect(exitEvent).toBeDefined();
    if (exitEvent && exitEvent.event === 'runtime_exit') {
      expect(exitEvent.intentional).toBe(true);
    }
  });

  it('hard stop on a never-started runtime is a no-op', () => {
    const h = makeHarness();
    const r = h.supervisor.stop({
      conversation_id: 'c1',
      agent_id: 'a1',
      runtime_generation: 1,
      mode: 'hard',
    });
    expect(r).toEqual({ mode: 'hard', stopped: false, exit_code: null });
  });

  it('stopAll counts only live runtimes', () => {
    const h = makeHarness();
    h.supervisor.start({
      runtime_generation: 1,
      conversation_id: 'c1',
      agent_id: 'a1',
      options: testStartOptions(),
    });
    h.supervisor.start({
      runtime_generation: 1,
      conversation_id: 'c2',
      agent_id: 'a2',
      options: testStartOptions({ conversationId: 'c2', agentId: 'a2' }),
    });
    h.flush();
    h.supervisor.stop({
      conversation_id: 'c2',
      agent_id: 'a2',
      runtime_generation: 1,
      mode: 'hard',
    });
    h.flush();
    const r = h.supervisor.stopAll({});
    // c2 already exited; only c1 was still live → count=1.
    expect(r.stopped_count).toBe(1);
  });

  it('clearSession emits runtime_state on the draining transition (Cindy `9rxtrdT2NXfX2zEs`)', () => {
    // Doc comment promises runtime_state after every phase change.
    // Mirror what stop() already does so backend snapshot reconcile
    // sees the same wire stream regardless of which hard-kill intent
    // landed.
    const h = makeHarness();
    h.supervisor.start({
      runtime_generation: 1,
      conversation_id: 'c1',
      agent_id: 'a1',
      options: testStartOptions(),
    });
    h.flush();
    const eventsBefore = h.events.length;
    const result = h.supervisor.clearSession({
      conversation_id: 'c1',
      agent_id: 'a1',
      runtime_generation: 1,
    });
    expect(result).toEqual({ cleared: true });
    // Synchronous emit: state(draining) before the scheduled exit.
    expect(h.events.slice(eventsBefore).map((e) => e.event)).toEqual(['runtime_state']);
    h.flush();
    // After the scheduled exit: another runtime_state + runtime_exit.
    expect(h.events.slice(eventsBefore).map((e) => e.event)).toEqual([
      'runtime_state',
      'runtime_state',
      'runtime_exit',
    ]);
    const terminal = h.events[h.events.length - 2];
    if (!terminal || terminal.event !== 'runtime_state') throw new Error('shape');
    expect(terminal.state.terminalReason).toBe('stopped');
    expect(h.supervisor.__getPhase('c1', 'a1')).toBe<FakeSupervisorPhase>('exited');
  });

  it('stopAll emits runtime_state on each draining transition (Cindy `9rxtrdT2NXfX2zEs`)', () => {
    const h = makeHarness();
    h.supervisor.start({
      runtime_generation: 1,
      conversation_id: 'c1',
      agent_id: 'a1',
      options: testStartOptions(),
    });
    h.supervisor.start({
      runtime_generation: 1,
      conversation_id: 'c2',
      agent_id: 'a2',
      options: testStartOptions({ conversationId: 'c2', agentId: 'a2' }),
    });
    h.flush();
    const eventsBefore = h.events.length;
    h.supervisor.stopAll({});
    // Two synchronous state(draining) emits — one per live runtime.
    const synchronous = h.events.slice(eventsBefore);
    expect(synchronous.map((e) => e.event)).toEqual(['runtime_state', 'runtime_state']);
    expect(
      new Set(
        synchronous
          .filter(
            (e): e is Extract<typeof e, { event: 'runtime_state' }> => e.event === 'runtime_state',
          )
          .map((e) => e.conversation_id),
      ),
    ).toEqual(new Set(['c1', 'c2']));
    h.flush();
    // After scheduled exits: each runtime adds state(exited) + exit.
    const after = h.events.slice(eventsBefore);
    expect(after.filter((e) => e.event === 'runtime_state')).toHaveLength(4);
    expect(after.filter((e) => e.event === 'runtime_exit')).toHaveLength(2);
  });
});

describe('FakeSupervisor — status', () => {
  it('returns one row per live runtime with phase + pid + started_at', () => {
    const h = makeHarness();
    h.supervisor.start({
      runtime_generation: 1,
      conversation_id: 'c1',
      agent_id: 'a1',
      options: testStartOptions(),
    });
    h.supervisor.start({
      runtime_generation: 1,
      conversation_id: 'c2',
      agent_id: 'a2',
      options: testStartOptions({ conversationId: 'c2', agentId: 'a2' }),
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
      runtime_generation: 1,
      conversation_id: 'c1',
      agent_id: 'a1',
      options: testStartOptions(),
    });
    h.supervisor.start({
      runtime_generation: 1,
      conversation_id: 'c2',
      agent_id: 'a2',
      options: testStartOptions({ conversationId: 'c2', agentId: 'a2' }),
    });
    h.flush();
    const r = h.supervisor.status({ conversation_id: 'c1' });
    expect(r.runtimes).toHaveLength(1);
    expect(r.runtimes[0]?.conversation_id).toBe('c1');
  });

  it('reports phase=exited and pid=null after exit', () => {
    const h = makeHarness();
    h.supervisor.start({
      runtime_generation: 1,
      conversation_id: 'c1',
      agent_id: 'a1',
      options: testStartOptions(),
    });
    h.flush();
    h.supervisor.stop({
      conversation_id: 'c1',
      agent_id: 'a1',
      runtime_generation: 1,
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

describe('FakeSupervisor — pauseOutput / resumeOutput', () => {
  // Cindy `_YD0KJF-YAQXlcki` requires pause/resume to flow through
  // the Supervisor interface (not inline dispatcher emit) AND to emit
  // `runtime_output_paused` / `_resumed` ack events on the wire.
  it('on a live runtime: emits paused, then resumed; idempotent on repeats', () => {
    const h = makeHarness();
    h.supervisor.start({
      runtime_generation: 1,
      conversation_id: 'c1',
      agent_id: 'a1',
      options: testStartOptions(),
    });
    h.flush();
    const eventsBefore = h.events.length;

    const r1 = h.supervisor.pauseOutput(outputScope('c1', 'a1'));
    expect(r1).toEqual({ paused: true });
    expect(h.events.slice(eventsBefore).map((e) => e.event)).toEqual(['runtime_output_paused']);

    // Idempotent: repeat pause returns paused=true but does NOT emit
    // a second event (avoids spamming the wire).
    const r2 = h.supervisor.pauseOutput(outputScope('c1', 'a1'));
    expect(r2).toEqual({ paused: true });
    expect(h.events.slice(eventsBefore).map((e) => e.event)).toEqual(['runtime_output_paused']);

    const r3 = h.supervisor.resumeOutput(outputScope('c1', 'a1'));
    expect(r3).toEqual({ resumed: true });
    expect(h.events.slice(eventsBefore).map((e) => e.event)).toEqual([
      'runtime_output_paused',
      'runtime_output_resumed',
    ]);

    // Repeat resume also idempotent — no second resumed event.
    const r4 = h.supervisor.resumeOutput(outputScope('c1', 'a1'));
    expect(r4).toEqual({ resumed: true });
    expect(h.events.slice(eventsBefore).map((e) => e.event)).toEqual([
      'runtime_output_paused',
      'runtime_output_resumed',
    ]);
  });

  it('on an unknown (conv, agent): returns paused=false / resumed=false with no emit', () => {
    const h = makeHarness();
    const eventsBefore = h.events.length;
    expect(h.supervisor.pauseOutput(outputScope('no-such', 'no-such'))).toEqual({ paused: false });
    expect(h.supervisor.resumeOutput(outputScope('no-such', 'no-such'))).toEqual({
      resumed: false,
    });
    expect(h.events.length).toBe(eventsBefore);
  });

  it('on an exited runtime: returns paused=false / resumed=false with no emit', () => {
    const h = makeHarness();
    h.supervisor.start({
      runtime_generation: 1,
      conversation_id: 'c1',
      agent_id: 'a1',
      options: testStartOptions(),
    });
    h.flush();
    h.supervisor.stop({
      conversation_id: 'c1',
      agent_id: 'a1',
      runtime_generation: 1,
      mode: 'hard',
    });
    h.flush();
    const eventsBefore = h.events.length;
    expect(h.supervisor.pauseOutput(outputScope('c1', 'a1'))).toEqual({ paused: false });
    expect(h.supervisor.resumeOutput(outputScope('c1', 'a1'))).toEqual({ resumed: false });
    expect(h.events.length).toBe(eventsBefore);
  });
});
