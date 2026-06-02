import { describe, expect, it } from 'vitest';
import { IntentDispatcher } from '../src/daemon/dispatcher.js';
import { DAEMON_VERSION } from '../src/daemon/version.js';
import type { SupervisorContract } from '../src/daemon/supervisor-contract.js';
import { FakeSupervisor } from './_helpers/fake-supervisor.js';
import { testStartOptions } from './_helpers/runtime-start-options.js';
import { createDaemonLogControl, type DaemonLogger } from '../src/daemon/logger.js';
import { HOST_PROTOCOL_VERSION, KNOWN_CAPABILITIES_V1 } from '../src/protocol.js';

function silentLogger(): DaemonLogger {
  return {
    filePath: '/dev/null',
    logControl: createDaemonLogControl('debug'),
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    close: async () => {},
  };
}

describe('IntentDispatcher', () => {
  it('handles hello with protocol version and capabilities', async () => {
    const d = new IntentDispatcher({ logger: silentLogger() });
    const r = await d.dispatch('hello-1', 'hello', {});
    expect('result' in r).toBe(true);
    if (!('result' in r)) return;
    expect(r.result).toEqual({
      protocol_version: HOST_PROTOCOL_VERSION,
      daemon_version: DAEMON_VERSION,
      daemon_id: 'local',
      instance_id: '__test_instance__',
      host_descriptor: { name: 'local', kind: 'local' },
      capabilities: [...KNOWN_CAPABILITIES_V1],
    });
  });

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

  it('handles host_status without a supervisor (empty active set)', async () => {
    // #task:808 — protocol-only surface returns the daemon facts and an
    // empty `active_agent_ids` list. The handler must not crash on a
    // null supervisor (matches the same pattern `status` follows) so
    // ComputerPane can still render OS / version even if the daemon's
    // supervisor wiring is in a transient state.
    const d = new IntentDispatcher({
      logger: silentLogger(),
      startedAt: 1_700_000_000_000,
      now: () => 1_700_000_001_500,
    });
    const r = await d.dispatch('req-host-status', 'host_status', {});
    expect('result' in r).toBe(true);
    if (!('result' in r)) return;
    expect(r.result).toMatchObject({
      daemon_pid: process.pid,
      daemon_version: DAEMON_VERSION,
      started_at: 1_700_000_000_000,
      uptime_ms: 1_500,
      active_agent_ids: [],
    });
    // OS string is host-dependent — assert only that the daemon
    // composed SOMETHING (never empty) so renderer doesn't show a blank cell.
    expect(typeof (r.result as { os: unknown }).os).toBe('string');
    expect((r.result as { os: string }).os.length).toBeGreaterThan(0);
  });

  it('handles host_status with a supervisor (active agent_ids deduped, exited filtered)', async () => {
    // Two handles for the same agent in different conversations must
    // collapse to one entry in `active_agent_ids` — the registry list
    // backend joins this against is per-agent, not per-conversation.
    // An exited runtime must drop out so the renderer's `online`
    // enrichment doesn't light up a stale agent. Drive via the public
    // `start` API + a synchronous scheduler so we don't depend on
    // FakeSupervisor internals.
    const supervisor = new FakeSupervisor({
      emit: () => {},
      schedule: cb => cb(),
    });
    const startOne = (conv: string, agent: string): void => {
      supervisor.start({
        conversation_id: conv,
        agent_id: agent,
        options: testStartOptions({ conversationId: conv, agentId: agent }),
      });
    };
    startOne('c1', 'a1');
    startOne('c2', 'a1');
    startOne('c3', 'a2');
    startOne('c4', 'a3');
    // Hard-stop a3 so it transitions to exited (sync schedule runs the
    // exit transition before stop() returns).
    supervisor.stop({ conversation_id: 'c4', agent_id: 'a3', mode: 'hard' });

    const d = new IntentDispatcher({ logger: silentLogger(), supervisor });
    const r = await d.dispatch('req-host-status-2', 'host_status', {});
    expect('result' in r).toBe(true);
    if (!('result' in r)) return;
    const ids = (r.result as { active_agent_ids: string[] }).active_agent_ids
      .slice()
      .sort();
    expect(ids).toEqual(['a1', 'a2']);
  });

  it('host_status excludes idle phases from active_agent_ids (Cindy slice-1 P1 #2)', async () => {
    // The dispatcher's filter is a WHITELIST of active phases
    // (`spawning | startup_pending | ready | draining`), not a denylist
    // of `exited`. A handle parked in `idle` (the protocol phase for
    // "alive but no live work" — backend's wake/start gates treat
    // `idle || exited` identically as non-live) must NOT appear in
    // `active_agent_ids`, or ComputerPane would mark the agent
    // online. FakeSupervisor never exposes `idle` itself, so drive the
    // contract through a stub supervisor that returns every phase the
    // schema admits.
    const stubSupervisor: SupervisorContract = {
      async start() {
        throw new Error('not used');
      },
      async stop() {
        throw new Error('not used');
      },
      async wake() {
        throw new Error('not used');
      },
      async status() {
        return {
          runtimes: [
            { conversation_id: 'c1', agent_id: 'a-spawning', pid: 1, phase: 'spawning', run_state: null, started_at: 1 },
            { conversation_id: 'c2', agent_id: 'a-startup', pid: 2, phase: 'startup_pending', run_state: null, started_at: 2 },
            { conversation_id: 'c3', agent_id: 'a-ready', pid: 3, phase: 'ready', run_state: null, started_at: 3 },
            { conversation_id: 'c4', agent_id: 'a-draining', pid: 4, phase: 'draining', run_state: null, started_at: 4 },
            { conversation_id: 'c5', agent_id: 'a-idle', pid: 5, phase: 'idle', run_state: null, started_at: 5 },
            { conversation_id: 'c6', agent_id: 'a-exited', pid: null, phase: 'exited', run_state: null, started_at: 6 },
          ],
        };
      },
      async clearSession() {
        throw new Error('not used');
      },
      async stopAll() {
        throw new Error('not used');
      },
      async closeActivityLog() {
        throw new Error('not used');
      },
      async pauseOutput() {
        throw new Error('not used');
      },
      async resumeOutput() {
        throw new Error('not used');
      },
    };
    const d = new IntentDispatcher({
      logger: silentLogger(),
      supervisor: stubSupervisor,
    });
    const r = await d.dispatch('req-host-status-idle', 'host_status', {});
    expect('result' in r).toBe(true);
    if (!('result' in r)) return;
    const ids = (r.result as { active_agent_ids: string[] }).active_agent_ids
      .slice()
      .sort();
    expect(ids).toEqual([
      'a-draining',
      'a-ready',
      'a-spawning',
      'a-startup',
    ]);
    expect(ids).not.toContain('a-idle');
    expect(ids).not.toContain('a-exited');
  });
  it('syncs conversation log debug windows into the daemon logger control', async () => {
    const logger = silentLogger();
    const d = new IntentDispatcher({ logger });
    const expiresAt = Date.now() + 60_000;

    const opened = await d.dispatch('req-debug-open', 'conversation_log_debug', {
      conversation_id: 'c1',
      enabled: true,
      expires_at: expiresAt,
    });
    expect(opened).toEqual({
      id: 'req-debug-open',
      result: { ok: true, enabled: true, expires_at: expiresAt },
    });
    expect(logger.logControl.getConversationDebugStatus('c1')).toEqual({
      enabled: true,
      expiresAt,
    });

    const closed = await d.dispatch('req-debug-close', 'conversation_log_debug', {
      conversation_id: 'c1',
      enabled: false,
    });
    expect(closed).toEqual({
      id: 'req-debug-close',
      result: { ok: true, enabled: false, expires_at: null },
    });
    expect(logger.logControl.getConversationDebugStatus('c1')).toEqual({
      enabled: false,
      expiresAt: null,
    });
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
      options: testStartOptions(),
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
      options: testStartOptions(),
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
      options: testStartOptions(),
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
      options: testStartOptions(),
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
    supervisor.start({ conversation_id: 'c1', agent_id: 'a1', options: testStartOptions() });
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
      options: testStartOptions(),
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
