import { describe, expect, it } from 'vitest';
import { IntentDispatcher } from '../src/daemon/dispatcher.js';
import { FakeSupervisor } from '../src/daemon/fake-supervisor.js';
import type { DaemonLogger } from '../src/daemon/logger.js';

function silentLogger(): DaemonLogger {
  return {
    filePath: '/dev/null',
    info: () => {},
    warn: () => {},
    error: () => {},
    close: async () => {},
  };
}

describe('IntentDispatcher', () => {
  it('handles ping with the daemon pid + version', async () => {
    const d = new IntentDispatcher({ logger: silentLogger(), startedAt: 1_700_000_000_000 });
    const r = await d.dispatch('req-1', 'ping', {});
    expect('result' in r).toBe(true);
    if (!('result' in r)) return;
    expect(r.result).toMatchObject({
      pong: true,
      daemon_pid: process.pid,
      started_at: 1_700_000_000_000,
    });
  });

  it('handles echo round-trip', async () => {
    const d = new IntentDispatcher({ logger: silentLogger() });
    const r = await d.dispatch('req-2', 'echo', { message: 'hi' });
    expect('result' in r).toBe(true);
    if ('result' in r) expect(r.result).toEqual({ echoed: 'hi' });
  });

  it('rejects unknown intents', async () => {
    const d = new IntentDispatcher({ logger: silentLogger() });
    const r = await d.dispatch('req-3', 'not_a_real_intent', {});
    expect('error' in r).toBe(true);
    if ('error' in r) {
      expect(r.error.code).toBe('unknown_intent');
      expect(r.error.message).toContain('not_a_real_intent');
    }
  });

  it('rejects malformed params', async () => {
    const d = new IntentDispatcher({ logger: silentLogger() });
    const r = await d.dispatch('req-4', 'echo', { wrong_field: 1 });
    expect('error' in r).toBe(true);
    if ('error' in r) expect(r.error.code).toBe('invalid_params');
  });

  it('refuses intents once marked as shutting_down', async () => {
    const d = new IntentDispatcher({ logger: silentLogger() });
    d.markShuttingDown();
    const r = await d.dispatch('req-5', 'ping', {});
    expect('error' in r).toBe(true);
    if ('error' in r) expect(r.error.code).toBe('shutting_down');
  });

  it('increments intent_count on success and includes it in status', async () => {
    let now = 1_000;
    const d = new IntentDispatcher({
      logger: silentLogger(),
      startedAt: 0,
      now: () => now,
    });
    await d.dispatch('req-a', 'ping', {});
    await d.dispatch('req-b', 'echo', { message: 'x' });
    now = 5_000;
    const r = await d.dispatch('req-c', 'status', {});
    expect('result' in r).toBe(true);
    if (!('result' in r)) return;
    expect(r.result).toMatchObject({
      uptime_ms: 5_000,
      intent_count: 3,
      runtimes: [],
    });
  });

  it('does NOT increment intent_count on validation failure', async () => {
    let now = 1_000;
    const d = new IntentDispatcher({ logger: silentLogger(), startedAt: 0, now: () => now });
    await d.dispatch('req-x', 'unknown', {});
    await d.dispatch('req-y', 'echo', { wrong: 1 });
    // intent_count should still be 0; reading via status increments it.
    const r = await d.dispatch('req-z', 'status', {});
    if (!('result' in r)) return;
    expect(r.result).toMatchObject({ intent_count: 1 });
  });

  it('rejects handler output that does not match the declared result schema (review fix B2)', async () => {
    // Subclass override forces the echo handler to emit a
    // contract-breaking shape. The base class's post-handler
    // safeParse should catch it and return `internal_error` with a
    // drift-flavored message — the malformed object never reaches
    // the wire.
    class DriftingDispatcher extends IntentDispatcher {
      protected override async runHandler(
        intent: Parameters<IntentDispatcher['dispatch']>[1] extends string
          ? string
          : never,
        params: unknown,
      ): Promise<unknown> {
        if (intent === 'echo') return { wrong_field: 1 };
        // Cast back to the wider union the parent expects; we
        // narrowed only to express "any registered intent name" in
        // a test-only subclass.
        return super.runHandler(intent as never, params);
      }
    }
    const d = new DriftingDispatcher({ logger: silentLogger() });
    const r = await d.dispatch('req-drift', 'echo', { message: 'hi' });
    expect('error' in r).toBe(true);
    if ('error' in r) {
      expect(r.error.code).toBe('internal_error');
      expect(r.error.message).toContain('drift');
    }
  });
});

describe('IntentDispatcher — runtime_* routing', () => {
  it('routes runtime_start through the wired supervisor', async () => {
    const events: unknown[] = [];
    const queue: Array<() => void> = [];
    const supervisor = new FakeSupervisor({
      emit: e => events.push(e),
      now: () => 1_000,
      schedule: cb => queue.push(cb),
    });
    const d = new IntentDispatcher({
      logger: silentLogger(),
      supervisor,
    });
    const r = await d.dispatch('req-1', 'runtime_start', {
      conversation_id: 'c1',
      agent_id: 'a1',
      options: {},
    });
    expect('result' in r).toBe(true);
    if ('result' in r) {
      expect(r.result).toMatchObject({ started: true, started_at: 1_000 });
      expect((r.result as { started: true; pid: number }).pid).toBeGreaterThan(0);
    }
  });

  it('routes runtime_wake → fake supervisor → returns batch result', async () => {
    const queue: Array<() => void> = [];
    const supervisor = new FakeSupervisor({
      emit: () => {},
      schedule: cb => queue.push(cb),
    });
    const d = new IntentDispatcher({
      logger: silentLogger(),
      supervisor,
    });
    await d.dispatch('s', 'runtime_start', {
      conversation_id: 'c1',
      agent_id: 'a1',
      options: {},
    });
    while (queue.length) queue.shift()!(); // flush to ready
    const r = await d.dispatch('w', 'runtime_wake', {
      conversation_id: 'c1',
      agent_id: 'a1',
      delivery_ids: [101, 102],
      kind: 'message',
      text: 'hi',
    });
    expect('result' in r).toBe(true);
    if ('result' in r) {
      expect(r.result).toEqual({
        delivered: true,
        delivery_ids: [101, 102],
      });
    }
  });

  it('runtime_status reflects supervisor snapshot', async () => {
    const queue: Array<() => void> = [];
    const supervisor = new FakeSupervisor({
      emit: () => {},
      schedule: cb => queue.push(cb),
    });
    const d = new IntentDispatcher({
      logger: silentLogger(),
      supervisor,
    });
    await d.dispatch('s', 'runtime_start', {
      conversation_id: 'c1',
      agent_id: 'a1',
      options: {},
    });
    while (queue.length) queue.shift()!();
    const r = await d.dispatch('q', 'runtime_status', {});
    expect('result' in r).toBe(true);
    if ('result' in r) {
      const result = r.result as { runtimes: Array<{ phase: string }> };
      expect(result.runtimes).toHaveLength(1);
      expect(result.runtimes[0]?.phase).toBe('ready');
    }
  });

  it('rejects runtime_* with internal_error when no supervisor wired', async () => {
    const d = new IntentDispatcher({ logger: silentLogger() });
    const r = await d.dispatch('s', 'runtime_start', {
      conversation_id: 'c1',
      agent_id: 'a1',
      options: {},
    });
    expect('error' in r).toBe(true);
    if ('error' in r) {
      expect(r.error.code).toBe('internal_error');
      expect(r.error.message).toContain('no supervisor');
    }
  });

  it('rejects runtime_inject_env (removed v3) as unknown_intent', async () => {
    const supervisor = new FakeSupervisor({ emit: () => {} });
    const d = new IntentDispatcher({
      logger: silentLogger(),
      supervisor,
    });
    const r = await d.dispatch('x', 'runtime_inject_env', {
      conversation_id: 'c1',
      agent_id: 'a1',
      env_patch: {},
    });
    expect('error' in r).toBe(true);
    if ('error' in r) expect(r.error.code).toBe('unknown_intent');
  });

  it('runtime_output_pause / _resume route through supervisor (Cindy `_YD0KJF-YAQXlcki`)', async () => {
    // Pause on an un-started (conv, agent): supervisor returns
    // paused=false with no emit. This proves the dispatcher actually
    // reaches the supervisor (a v0 inline `{paused: true}` no-op
    // would have given the wrong answer).
    const events: import('../src/protocol.js').EventFrame[] = [];
    const supervisor = new FakeSupervisor({
      emit: e => events.push(e),
    });
    const d = new IntentDispatcher({
      logger: silentLogger(),
      supervisor,
    });
    const pauseUnknown = await d.dispatch('p1', 'runtime_output_pause', {
      conversation_id: 'no-such',
      agent_id: 'no-such',
    });
    expect('result' in pauseUnknown).toBe(true);
    if ('result' in pauseUnknown) {
      expect(pauseUnknown.result).toEqual({ paused: false });
    }
    expect(events.filter(e => e.event === 'runtime_output_paused')).toHaveLength(0);

    // Now start a runtime synchronously (no flush — fake's start
    // returns synchronously even before the scheduled ready emit,
    // and pauseOutput accepts any non-exited phase).
    supervisor.start({ conversation_id: 'c1', agent_id: 'a1', options: {} });
    const pauseLive = await d.dispatch('p2', 'runtime_output_pause', {
      conversation_id: 'c1',
      agent_id: 'a1',
    });
    expect('result' in pauseLive).toBe(true);
    if ('result' in pauseLive) expect(pauseLive.result).toEqual({ paused: true });
    expect(events.filter(e => e.event === 'runtime_output_paused')).toHaveLength(1);

    const resumeLive = await d.dispatch('r2', 'runtime_output_resume', {
      conversation_id: 'c1',
      agent_id: 'a1',
    });
    expect('result' in resumeLive).toBe(true);
    if ('result' in resumeLive) expect(resumeLive.result).toEqual({ resumed: true });
    expect(events.filter(e => e.event === 'runtime_output_resumed')).toHaveLength(1);
  });

  it('status intent merges supervisor runtimes into ping-style status', async () => {
    const queue: Array<() => void> = [];
    const supervisor = new FakeSupervisor({
      emit: () => {},
      schedule: cb => queue.push(cb),
    });
    const d = new IntentDispatcher({
      logger: silentLogger(),
      supervisor,
    });
    await d.dispatch('s', 'runtime_start', {
      conversation_id: 'c1',
      agent_id: 'a1',
      options: {},
    });
    while (queue.length) queue.shift()!();
    const r = await d.dispatch('q', 'status', {});
    expect('result' in r).toBe(true);
    if ('result' in r) {
      const result = r.result as { runtimes: unknown[] };
      expect(result.runtimes).toHaveLength(1);
    }
  });
});
