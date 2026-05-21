/**
 * End-to-end test for the PR-2 step 1 surface: runtime_* intents
 * dispatched through a HostClient over a real Unix socket, hitting a
 * `FakeSupervisor` plugged into the daemon, and unsolicited events
 * coming back through HostClient.subscribe.
 *
 * Step 1 review boundary (Cindy `1vRk1SIAFfa1x10t`): protocol-side
 * correctness only — the fake supervisor models driver state
 * deterministically; PR-2 step 2 will validate behavioral
 * equivalence with the real CM-derived supervisor.
 *
 * What this test covers:
 *
 *  - Wire path: HostClient → SocketTransport → daemon socket → server →
 *    dispatcher → supervisor.start() → emit() → server.broadcast() →
 *    backpressure → live socket → HostClient.handleFrame →
 *    eventHandlers.
 *  - Each step-1 intent (start, wake, status, stop) returns its
 *    declared shape and produces the expected event sequence.
 *  - Two HostClient connections to the same daemon both receive the
 *    same broadcast events.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDaemon, type RunningDaemon } from '../src/daemon/index.js';
import { FakeSupervisor } from '../src/daemon/fake-supervisor.js';
import { HostClient } from '../src/client/index.js';
import type { EventFrame } from '../src/protocol.js';

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
  const daemon = await runDaemon({
    socketPath,
    pidFilePath,
    logDir,
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
  await vi.waitFor(() => {
    hit = events.find(predicate);
    expect(hit).toBeDefined();
  }, { timeout: timeoutMs });
  return hit!;
}

describe('e2e — runtime_* through HostClient + FakeSupervisor', () => {
  const fixtures: E2eFixture[] = [];
  const clients: HostClient[] = [];

  afterEach(async () => {
    while (clients.length) await clients.pop()!.close().catch(() => {});
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
    client.subscribe(e => events.push(e));

    const r = await client.runtimeStart({
      conversation_id: 'conv-1',
      agent_id: 'agent-1',
      options: {},
    });
    expect(r.pid).toBeGreaterThan(0);
    expect(typeof r.started_at).toBe('number');
    expect(r.startup_delivery_accepted).toBeUndefined();

    // FakeSupervisor schedules ready_for_drain via setImmediate.
    const ready = await waitForEvent(
      events,
      (e): e is Extract<EventFrame, { event: 'runtime_ready_for_drain' }> =>
        e.event === 'runtime_ready_for_drain' && e.conversation_id === 'conv-1',
    );
    expect(ready.agent_id).toBe('agent-1');
  });

  it('runtime_start with startup_delivery emits runtime_startup_delivery_consumed on success', async () => {
    const f = await setupFixture();
    fixtures.push(f);
    const client = new HostClient({ socketPath: f.socketPath });
    clients.push(client);
    await client.connect();
    const events: EventFrame[] = [];
    client.subscribe(e => events.push(e));

    const r = await client.runtimeStart({
      conversation_id: 'conv-2',
      agent_id: 'agent-2',
      options: {},
      startup_delivery: {
        delivery_ids: [101, 102],
        payload: '{"role":"user","content":"hello"}\n',
      },
    });
    expect(r.startup_delivery_accepted).toBe(true);

    const consumed = await waitForEvent(
      events,
      (e): e is Extract<EventFrame, { event: 'runtime_startup_delivery_consumed' }> =>
        e.event === 'runtime_startup_delivery_consumed',
    );
    expect(consumed.delivery_ids).toEqual([101, 102]);
    expect(consumed.conversation_id).toBe('conv-2');
  });

  it('runtime_start with startup_delivery emits runtime_startup_delivery_failed when driver refuses', async () => {
    const f = await setupFixture({ failStartupDelivery: true });
    fixtures.push(f);
    const client = new HostClient({ socketPath: f.socketPath });
    clients.push(client);
    await client.connect();
    const events: EventFrame[] = [];
    client.subscribe(e => events.push(e));

    await client.runtimeStart({
      conversation_id: 'conv-3',
      agent_id: 'agent-3',
      options: {},
      startup_delivery: { delivery_ids: [200], payload: '{}\n' },
    });
    const failed = await waitForEvent(
      events,
      (e): e is Extract<EventFrame, { event: 'runtime_startup_delivery_failed' }> =>
        e.event === 'runtime_startup_delivery_failed',
    );
    expect(failed.delivery_ids).toEqual([200]);
    expect(['child_exit', 'init_watchdog', 'write_failed', 'driver_refused']).toContain(
      failed.reason,
    );
  });

  it('runtime_wake to a ready runtime returns delivered=true with original delivery_ids', async () => {
    const f = await setupFixture();
    fixtures.push(f);
    const client = new HostClient({ socketPath: f.socketPath });
    clients.push(client);
    await client.connect();
    const events: EventFrame[] = [];
    client.subscribe(e => events.push(e));

    await client.runtimeStart({
      conversation_id: 'conv-4',
      agent_id: 'agent-4',
      options: {},
    });
    await waitForEvent(
      events,
      (e): e is Extract<EventFrame, { event: 'runtime_ready_for_drain' }> =>
        e.event === 'runtime_ready_for_drain' && e.conversation_id === 'conv-4',
    );
    const r = await client.runtimeWake({
      conversation_id: 'conv-4',
      agent_id: 'agent-4',
      delivery_ids: [50, 51, 52],
      kind: 'message',
      payload: '{"role":"user","content":"batch"}\n',
    });
    expect(r).toEqual({ delivered: true, delivery_ids: [50, 51, 52] });
  });

  it('runtime_wake to non-existent runtime returns delivered=false reason=not_running', async () => {
    const f = await setupFixture();
    fixtures.push(f);
    const client = new HostClient({ socketPath: f.socketPath });
    clients.push(client);
    await client.connect();
    const r = await client.runtimeWake({
      conversation_id: 'no-such-conv',
      agent_id: 'no-such-agent',
      delivery_ids: [1],
      kind: 'message',
      payload: '{}\n',
    });
    expect(r).toEqual({
      delivered: false,
      reason: 'not_running',
      delivery_ids: [1],
    });
  });

  it('runtime_status snapshot reflects all live runtimes', async () => {
    const f = await setupFixture();
    fixtures.push(f);
    const client = new HostClient({ socketPath: f.socketPath });
    clients.push(client);
    await client.connect();
    await client.runtimeStart({ conversation_id: 'c-A', agent_id: 'ag-A', options: {} });
    await client.runtimeStart({ conversation_id: 'c-B', agent_id: 'ag-B', options: {} });
    const snap = await client.runtimeStatus();
    expect(snap.runtimes).toHaveLength(2);
    const convs = snap.runtimes.map(r => r.conversation_id).sort();
    expect(convs).toEqual(['c-A', 'c-B']);
  });

  it('runtime_stop emits runtime_exit with intentional=true', async () => {
    const f = await setupFixture();
    fixtures.push(f);
    const client = new HostClient({ socketPath: f.socketPath });
    clients.push(client);
    await client.connect();
    const events: EventFrame[] = [];
    client.subscribe(e => events.push(e));
    await client.runtimeStart({ conversation_id: 'c-X', agent_id: 'ag-X', options: {} });
    await waitForEvent(
      events,
      (e): e is Extract<EventFrame, { event: 'runtime_ready_for_drain' }> =>
        e.event === 'runtime_ready_for_drain' && e.conversation_id === 'c-X',
    );
    const r = await client.runtimeStop({
      conversation_id: 'c-X',
      agent_id: 'ag-X',
      mode: 'soft',
    });
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
    a.subscribe(e => evA.push(e));
    b.subscribe(e => evB.push(e));
    await a.runtimeStart({ conversation_id: 'c-Y', agent_id: 'ag-Y', options: {} });
    const has = (events: EventFrame[]): boolean =>
      events.some(
        e => e.event === 'runtime_ready_for_drain' && e.conversation_id === 'c-Y',
      );
    await vi.waitFor(() => {
      expect(has(evA)).toBe(true);
      expect(has(evB)).toBe(true);
    }, { timeout: 1000 });
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
