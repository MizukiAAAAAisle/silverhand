/**
 * End-to-end test for the PR-2 step 1 surface: runtime_* intents
 * dispatched through a HostClient over a real Unix socket, hitting a
 * `FakeSupervisor` plugged into the daemon, and unsolicited events
 * coming back through HostClient.subscribe.
 *
 * Protocol-side coverage: the fake supervisor models driver state
 * deterministically while the socket / dispatcher / subscription path
 * is real. Production supervisor behavior is covered separately by
 * `supervisor.test.ts`.
 *
 * What this test covers:
 *
 *  - Wire path: HostClient → SocketTransport → daemon socket → server →
 *    dispatcher → supervisor.start() → emit() → server.broadcast() →
 *    backpressure → live socket → HostClient.handleFrame →
 *    eventHandlers.
 *  - Each step-1 intent (start, deliver, status, stop) returns its
 *    declared shape and produces the expected event sequence.
 *  - Two HostClient connections to the same daemon both receive the
 *    same broadcast events.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runDaemon, type RunningDaemon } from '../src/daemon/index.js';
import { FakeSupervisor } from './_helpers/fake-supervisor.js';
import { testStartOptions } from './_helpers/runtime-start-options.js';
import { HostClient } from '../src/client/index.js';
import type { EventFrame, RuntimeStartResult } from '../src/protocol.js';

/** Narrow a `RuntimeStartResult` to the success arm; throws on the
 *  cooldown arm — every e2e-supervisor test expects success.
 *  (3c added the discriminated-union shape; see supervisor.test.ts
 *  for the longer explanation.) */
function assertStarted(
  res: RuntimeStartResult,
): asserts res is Extract<RuntimeStartResult, { started: true }> {
  if (!res.started) {
    throw new Error(`expected start() to succeed: ${JSON.stringify(res)}`);
  }
}

interface E2eFixture {
  dir: string;
  socketPath: string;
  pidFilePath: string;
  logDir: string;
  daemon: RunningDaemon;
}

async function setupFixture(opts?: { failStartupDelivery?: boolean }): Promise<E2eFixture> {
  const dir = mkdtempSync(join(tmpdir(), 'silverhand-e2e-supervisor-'));
  const socketPath = join(dir, 'daemon.sock');
  const pidFilePath = join(dir, 'daemon.pid');
  const logDir = join(dir, 'logs');
  const runtimePidRootDir = join(dir, 'runtime-pids');
  const daemon = await runDaemon({
    socketPath,
    pidFilePath,
    logDir,
    daemonIdentityPath: join(dir, 'identity.json'),
    agentHomeRootDir: join(dir, 'agents'),
    runtimePidRootDir,
    installSignals: false,
    writeStdoutHandshake: false,
    alsoStderr: false,
    supervisorFactory: ({ emit }) =>
      new FakeSupervisor({
        emit,
        failStartupDelivery: opts?.failStartupDelivery,
      }),
  });
  return { dir, socketPath, pidFilePath, logDir, daemon };
}

/** Wait until at least one event matching `predicate` arrived in
 *  `events`, or fail after `timeoutMs`. Uses vi.waitFor so test
 *  fixture noise (unrelated events) doesn't break the assertion. */
async function waitForEvent<T extends EventFrame>(
  events: EventFrame[],
  predicate: (e: EventFrame) => e is T,
  timeoutMs = 1000,
): Promise<T> {
  let hit: T | undefined;
  await vi.waitFor(
    () => {
      hit = events.find(predicate);
      expect(hit).toBeDefined();
    },
    { timeout: timeoutMs },
  );
  return hit!;
}

describe('e2e — runtime_* through HostClient + FakeSupervisor', () => {
  const fixtures: E2eFixture[] = [];
  const clients: HostClient[] = [];

  afterEach(async () => {
    while (clients.length)
      await clients
        .pop()!
        .close()
        .catch(() => {});
    while (fixtures.length) {
      const f = fixtures.pop()!;
      await f.daemon.stop('test_done').catch(() => {});
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it('runtime_start without startup_delivery emits ready_for_drain', async () => {
    const f = await setupFixture();
    fixtures.push(f);
    const client = new HostClient({ socketPath: f.socketPath });
    clients.push(client);
    await client.connect();
    const events: EventFrame[] = [];
    client.subscribe((e) => events.push(e));

    const r = await client.runtimeStart({
      runtime_generation: 1,
      conversation_id: 'conv-1',
      agent_id: 'agent-1',
      options: testStartOptions({ conversationId: 'conv-1', agentId: 'agent-1' }),
    });
    assertStarted(r);
    expect(r.pid).toBeGreaterThan(0);
    expect(typeof r.started_at).toBe('number');

    // FakeSupervisor schedules ready_for_drain via setImmediate.
    const ready = await waitForEvent(
      events,
      (e): e is Extract<EventFrame, { event: 'runtime_ready_for_drain' }> =>
        e.event === 'runtime_ready_for_drain' && e.conversation_id === 'conv-1',
    );
    expect(ready.agent_id).toBe('agent-1');
  });

  it('runtime_deliver SPAWN arm emits runtime_delivery_consumed on success', async () => {
    const f = await setupFixture();
    fixtures.push(f);
    const client = new HostClient({ socketPath: f.socketPath });
    clients.push(client);
    await client.connect();
    const events: EventFrame[] = [];
    client.subscribe((e) => events.push(e));

    const r = await client.runtimeDeliver({
      runtime_generation: 1,
      conversation_id: 'conv-2',
      target: { conversation_id: 'conv-2', workspace: null },
      agent_id: 'agent-2',
      delivery_ids: [101, 102],
      kind: 'message',
      text: 'hello',
      deliveries: [
        { delivery_id: 101, seq: 101, presentation: { body: 'hello', instruction: 'other' } },
        { delivery_id: 102, seq: 102, presentation: { body: 'hello', instruction: 'other' } },
      ],
      spawn_options: testStartOptions({ conversationId: 'conv-2', agentId: 'agent-2' }),
    });
    expect(r.disposition).toBe('spawning');

    const consumed = await waitForEvent(
      events,
      (e): e is Extract<EventFrame, { event: 'runtime_delivery_consumed' }> =>
        e.event === 'runtime_delivery_consumed',
    );
    expect(consumed.delivery_ids).toEqual([101, 102]);
    expect(consumed.conversation_id).toBe('conv-2');
  });

  it('runtime_deliver SPAWN arm emits runtime_delivery_failed when driver refuses', async () => {
    const f = await setupFixture({ failStartupDelivery: true });
    fixtures.push(f);
    const client = new HostClient({ socketPath: f.socketPath });
    clients.push(client);
    await client.connect();
    const events: EventFrame[] = [];
    client.subscribe((e) => events.push(e));

    await client.runtimeDeliver({
      runtime_generation: 1,
      conversation_id: 'conv-3',
      target: { conversation_id: 'conv-3', workspace: null },
      agent_id: 'agent-3',
      delivery_ids: [200],
      kind: 'message',
      text: 'stub',
      deliveries: [
        { delivery_id: 200, seq: 200, presentation: { body: 'stub', instruction: 'other' } },
      ],
      spawn_options: testStartOptions({ conversationId: 'conv-3', agentId: 'agent-3' }),
    });
    const failed = await waitForEvent(
      events,
      (e): e is Extract<EventFrame, { event: 'runtime_delivery_failed' }> =>
        e.event === 'runtime_delivery_failed',
    );
    expect(failed.delivery_ids).toEqual([200]);
    expect(['child_exit', 'init_watchdog', 'write_failed', 'driver_refused']).toContain(
      failed.reason,
    );
  });

  it('runtime_deliver WRITE arm to a ready runtime returns admitted + settles on runtime_delivery_consumed', async () => {
    const f = await setupFixture();
    fixtures.push(f);
    const client = new HostClient({ socketPath: f.socketPath });
    clients.push(client);
    await client.connect();
    const events: EventFrame[] = [];
    client.subscribe((e) => events.push(e));

    await client.runtimeStart({
      runtime_generation: 1,
      conversation_id: 'conv-4',
      agent_id: 'agent-4',
      options: testStartOptions({ conversationId: 'conv-4', agentId: 'agent-4' }),
    });
    await waitForEvent(
      events,
      (e): e is Extract<EventFrame, { event: 'runtime_ready_for_drain' }> =>
        e.event === 'runtime_ready_for_drain' && e.conversation_id === 'conv-4',
    );
    const r = await client.runtimeDeliver({
      runtime_generation: 1,
      conversation_id: 'conv-4',
      target: { conversation_id: 'conv-4', workspace: null },
      agent_id: 'agent-4',
      delivery_ids: [50, 51, 52],
      kind: 'message',
      text: 'batch',
      deliveries: [
        { delivery_id: 50, seq: 50, presentation: { body: 'batch', instruction: 'other' } },
        { delivery_id: 51, seq: 51, presentation: { body: 'batch', instruction: 'other' } },
        { delivery_id: 52, seq: 52, presentation: { body: 'batch', instruction: 'other' } },
      ],
      spawn_options: testStartOptions({ conversationId: 'conv-4', agentId: 'agent-4' }),
    });
    expect(r.disposition).toBe('admitted');
    const consumed = await waitForEvent(
      events,
      (e): e is Extract<EventFrame, { event: 'runtime_delivery_consumed' }> =>
        e.event === 'runtime_delivery_consumed' && e.conversation_id === 'conv-4',
    );
    expect(consumed.delivery_ids).toEqual([50, 51, 52]);
  });

  it('runtime_status snapshot reflects all live runtimes', async () => {
    const f = await setupFixture();
    fixtures.push(f);
    const client = new HostClient({ socketPath: f.socketPath });
    clients.push(client);
    await client.connect();
    await client.runtimeStart({
      runtime_generation: 1,
      conversation_id: 'c-A',
      agent_id: 'ag-A',
      options: testStartOptions({ conversationId: 'c-A', agentId: 'ag-A' }),
    });
    await client.runtimeStart({
      runtime_generation: 1,
      conversation_id: 'c-B',
      agent_id: 'ag-B',
      options: testStartOptions({ conversationId: 'c-B', agentId: 'ag-B' }),
    });
    const snap = await client.runtimeStatus();
    expect(snap.runtimes).toHaveLength(2);
    const convs = snap.runtimes.map((r) => r.conversation_id).sort();
    expect(convs).toEqual(['c-A', 'c-B']);
  });

  it('runtime_stop emits runtime_exit with intentional=true', async () => {
    const f = await setupFixture();
    fixtures.push(f);
    const client = new HostClient({ socketPath: f.socketPath });
    clients.push(client);
    await client.connect();
    const events: EventFrame[] = [];
    client.subscribe((e) => events.push(e));
    await client.runtimeStart({
      runtime_generation: 1,
      conversation_id: 'c-X',
      agent_id: 'ag-X',
      options: testStartOptions({ conversationId: 'c-X', agentId: 'ag-X' }),
    });
    await waitForEvent(
      events,
      (e): e is Extract<EventFrame, { event: 'runtime_ready_for_drain' }> =>
        e.event === 'runtime_ready_for_drain' && e.conversation_id === 'c-X',
    );
    const r = await client.runtimeStop({
      runtime_scope: {
        kind: 'conversation',
        conversation_id: 'c-X',
        agent_id: 'ag-X',
      },
      runtime_generation: 1,
      mode: 'hard',
    });
    if (r.mode !== 'hard') throw new Error('expected hard stop result');
    expect(r.stopped).toBe(true);
    const exit = await waitForEvent(
      events,
      (e): e is Extract<EventFrame, { event: 'runtime_exit' }> =>
        e.event === 'runtime_exit' && e.conversation_id === 'c-X',
    );
    expect(exit.intentional).toBe(true);
  });

  it('two clients on the same daemon both receive broadcast events', async () => {
    const f = await setupFixture();
    fixtures.push(f);
    const a = new HostClient({ socketPath: f.socketPath });
    const b = new HostClient({ socketPath: f.socketPath });
    clients.push(a, b);
    await Promise.all([a.connect(), b.connect()]);
    const evA: EventFrame[] = [];
    const evB: EventFrame[] = [];
    a.subscribe((e) => evA.push(e));
    b.subscribe((e) => evB.push(e));
    await a.runtimeStart({
      runtime_generation: 1,
      conversation_id: 'c-Y',
      agent_id: 'ag-Y',
      options: testStartOptions({ conversationId: 'c-Y', agentId: 'ag-Y' }),
    });
    const has = (events: EventFrame[]): boolean =>
      events.some((e) => e.event === 'runtime_ready_for_drain' && e.conversation_id === 'c-Y');
    await vi.waitFor(
      () => {
        expect(has(evA)).toBe(true);
        expect(has(evB)).toBe(true);
      },
      { timeout: 1000 },
    );
  });

  it('runtime_state events stream through subscribe across the start/stop lifecycle', async () => {
    // Cindy `POiN_oGtyDjr3Sni` blocker 3: step 1 locks the protocol
    // event surface, so the fake supervisor MUST emit `runtime_state`
    // on every phase transition AND that emission must reach a
    // subscribed HostClient through the real wire.
    const f = await setupFixture();
    fixtures.push(f);
    const client = new HostClient({ socketPath: f.socketPath });
    clients.push(client);
    await client.connect();
    const events: EventFrame[] = [];
    client.subscribe((e) => events.push(e));

    await client.runtimeStart({
      runtime_generation: 1,
      conversation_id: 'c-state',
      agent_id: 'ag-state',
      options: testStartOptions({ conversationId: 'c-state', agentId: 'ag-state' }),
    });
    // Wait for ready so we know both starting + idle states have been
    // emitted (FakeSupervisor emits state(starting) on start() and
    // state(idle) on the scheduled ready transition).
    await waitForEvent(
      events,
      (e): e is Extract<EventFrame, { event: 'runtime_ready_for_drain' }> =>
        e.event === 'runtime_ready_for_drain' && e.conversation_id === 'c-state',
    );
    const stateEvents = events.filter(
      (e): e is Extract<EventFrame, { event: 'runtime_state' }> =>
        e.event === 'runtime_state' && e.conversation_id === 'c-state',
    );
    expect(stateEvents).toHaveLength(2);
    expect(stateEvents[0]?.state.status).toBe('starting');
    expect(stateEvents[1]?.state.status).toBe('idle');
    // runId is stable across emits within one runtime lifetime so the
    // backend can correlate the wire transitions to a single run.
    expect(stateEvents[0]?.state.runId).toBe(stateEvents[1]?.state.runId);

    await client.runtimeStop({
      runtime_scope: {
        kind: 'conversation',
        conversation_id: 'c-state',
        agent_id: 'ag-state',
      },
      runtime_generation: 1,
      mode: 'hard',
    });
    await waitForEvent(
      events,
      (e): e is Extract<EventFrame, { event: 'runtime_exit' }> =>
        e.event === 'runtime_exit' && e.conversation_id === 'c-state',
    );
    const final = events.filter(
      (e): e is Extract<EventFrame, { event: 'runtime_state' }> =>
        e.event === 'runtime_state' && e.conversation_id === 'c-state',
    );
    // Two more state emits appear: draining (still status=idle, no
    // terminalReason) and exited (status=idle, terminalReason='stopped').
    expect(final).toHaveLength(4);
    expect(final[3]?.state.terminalReason).toBe('stopped');
  });

  it('runtime_state on deliver-spawn failure carries terminalReason=crashed', async () => {
    // Failure path of blocker 3: the terminal `runtime_state` line for
    // an init-failed runtime must encode `terminalReason: 'crashed'`
    // so backend snapshots reconcile to the correct AgentRunState.
    const f = await setupFixture({ failStartupDelivery: true });
    fixtures.push(f);
    const client = new HostClient({ socketPath: f.socketPath });
    clients.push(client);
    await client.connect();
    const events: EventFrame[] = [];
    client.subscribe((e) => events.push(e));

    await client.runtimeDeliver({
      runtime_generation: 1,
      conversation_id: 'c-crash',
      target: { conversation_id: 'c-crash', workspace: null },
      agent_id: 'ag-crash',
      delivery_ids: [1],
      kind: 'message',
      text: 'stub',
      deliveries: [
        { delivery_id: 1, seq: 1, presentation: { body: 'stub', instruction: 'other' } },
      ],
      spawn_options: testStartOptions({ conversationId: 'c-crash', agentId: 'ag-crash' }),
    });
    await waitForEvent(
      events,
      (e): e is Extract<EventFrame, { event: 'runtime_exit' }> =>
        e.event === 'runtime_exit' && e.conversation_id === 'c-crash',
    );
    const stateEvents = events.filter(
      (e): e is Extract<EventFrame, { event: 'runtime_state' }> =>
        e.event === 'runtime_state' && e.conversation_id === 'c-crash',
    );
    // starting (start()) + crashed terminal (scheduleStartupSettle fail).
    expect(stateEvents).toHaveLength(2);
    expect(stateEvents[0]?.state.status).toBe('starting');
    expect(stateEvents[1]?.state.terminalReason).toBe('crashed');
  });

  it('runtime_output_pause / runtime_output_resume route through supervisor and emit ack events', async () => {
    // Cindy `_YD0KJF-YAQXlcki` blocker 4: pause/resume must flow
    // through the Supervisor interface (NOT inline dispatcher emit)
    // AND emit `runtime_output_paused` / `_resumed` so subscribers
    // observe the flow-control transition.
    const f = await setupFixture();
    fixtures.push(f);
    const client = new HostClient({ socketPath: f.socketPath });
    clients.push(client);
    await client.connect();
    const events: EventFrame[] = [];
    client.subscribe((e) => events.push(e));

    await client.runtimeStart({
      runtime_generation: 1,
      conversation_id: 'c-flow',
      agent_id: 'ag-flow',
      options: testStartOptions({ conversationId: 'c-flow', agentId: 'ag-flow' }),
    });
    await waitForEvent(
      events,
      (e): e is Extract<EventFrame, { event: 'runtime_ready_for_drain' }> =>
        e.event === 'runtime_ready_for_drain' && e.conversation_id === 'c-flow',
    );

    const pause = await client.call('runtime_output_pause', {
      runtime_scope: {
        kind: 'conversation',
        conversation_id: 'c-flow',
        agent_id: 'ag-flow',
      },
    });
    expect(pause).toEqual({ paused: true });
    await waitForEvent(
      events,
      (e): e is Extract<EventFrame, { event: 'runtime_output_paused' }> =>
        e.event === 'runtime_output_paused' && e.conversation_id === 'c-flow',
    );

    const resume = await client.call('runtime_output_resume', {
      runtime_scope: {
        kind: 'conversation',
        conversation_id: 'c-flow',
        agent_id: 'ag-flow',
      },
    });
    expect(resume).toEqual({ resumed: true });
    await waitForEvent(
      events,
      (e): e is Extract<EventFrame, { event: 'runtime_output_resumed' }> =>
        e.event === 'runtime_output_resumed' && e.conversation_id === 'c-flow',
    );
  });

  it('runtime_output_pause on an unknown runtime returns paused=false with no event', async () => {
    const f = await setupFixture();
    fixtures.push(f);
    const client = new HostClient({ socketPath: f.socketPath });
    clients.push(client);
    await client.connect();
    const events: EventFrame[] = [];
    client.subscribe((e) => events.push(e));

    const r = await client.call('runtime_output_pause', {
      runtime_scope: {
        kind: 'conversation',
        conversation_id: 'no-such-conv',
        agent_id: 'no-such-agent',
      },
    });
    expect(r).toEqual({ paused: false });
    // Settle the event loop briefly; assert no paused event arrived.
    await new Promise((res) => setImmediate(res));
    expect(events.filter((e) => e.event === 'runtime_output_paused')).toHaveLength(0);
  });

  it('shutting_down event lands as a `kind: "event"` log line (Cindy `POiN_oGtyDjr3Sni` note)', async () => {
    // Previously DaemonServer.stop() wrote the shutting_down frame
    // directly to each socket, bypassing logEvent. The fix routes it
    // through `broadcast()` which calls logEvent. Verify by stopping
    // a real daemon and grepping its JSONL log for the kind=event line.
    const f = await setupFixture();
    // Don't push to fixtures[] — we stop manually below, then clean.
    f.daemon.logger.logControl.setGlobalLevel('info');
    const logPath = f.daemon.logger.filePath;
    await f.daemon.stop('test_shutting_down_log').catch(() => {});
    const raw = readFileSync(logPath, 'utf8');
    const lines = raw
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const evLine = lines.find((l) => l.kind === 'event' && l.event === 'shutting_down');
    expect(evLine).toBeDefined();
    rmSync(f.dir, { recursive: true, force: true });
  });

  it("runtime_stop rejects the retired mode='soft' arm as invalid_params at the wire (#task:1558)", async () => {
    const f = await setupFixture();
    fixtures.push(f);
    const client = new HostClient({ socketPath: f.socketPath });
    clients.push(client);
    await client.connect();
    const params = {
      runtime_scope: { kind: 'conversation' as const, conversation_id: 'c-x', agent_id: 'ag-x' },
      runtime_generation: 1,
      mode: 'hard' as const,
    };
    await expect(client.runtimeStop(params)).resolves.toEqual({
      mode: 'hard',
      stopped: false,
      exit_code: null,
    });
    await expect(
      client.runtimeStop({
        ...params,
        // @ts-expect-error — soft mode was deleted from the wire schema
        mode: 'soft',
      }),
    ).rejects.toMatchObject({ code: 'invalid_params' });
  });

  it('runtime_inject_env returns unknown_intent (removed in v0)', async () => {
    const f = await setupFixture();
    fixtures.push(f);
    const client = new HostClient({ socketPath: f.socketPath });
    clients.push(client);
    await client.connect();
    // call() bypasses the typed helpers — needed because runtime_inject_env
    // isn't in the typed registry by design.
    await expect(
      // @ts-expect-error — intentional unknown intent at compile time
      client.call('runtime_inject_env', { conversation_id: 'c1', agent_id: 'a1' }),
    ).rejects.toMatchObject({ code: 'unknown_intent' });
  });
});
