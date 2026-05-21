import { describe, expect, it, vi } from 'vitest';
import { HostClient, HostClientError } from '../src/client/index.js';
import { createFakeTransportPair } from './_helpers/fake-transport.js';

const FIXED_RNG = () => 0.5; // deterministic backoff jitter

describe('HostClient — happy path', () => {
  it('round-trips ping against a fake daemon', async () => {
    const { transport, peer } = createFakeTransportPair();
    const client = new HostClient({
      transportFactory: () => transport,
      rng: FIXED_RNG,
    });
    await client.connect();
    const promise = client.ping();
    // Drain one tick so the request is on the wire
    await new Promise(setImmediate);
    expect(peer.received).toHaveLength(1);
    const req = peer.received[0]!;
    expect(req.intent).toBe('ping');
    peer.send({
      id: req.id,
      result: {
        pong: true,
        daemon_pid: 1234,
        daemon_version: '0.1.0',
        started_at: 1_700_000_000_000,
      },
    });
    const res = await promise;
    expect(res.pong).toBe(true);
    expect(res.daemon_pid).toBe(1234);
    await client.close();
  });

  it('rejects with a typed error when daemon returns ResponseError', async () => {
    const { transport, peer } = createFakeTransportPair();
    const client = new HostClient({ transportFactory: () => transport, rng: FIXED_RNG });
    await client.connect();
    const promise = client.echo('msg');
    await new Promise(setImmediate);
    peer.send({
      id: peer.received[0]!.id,
      error: { code: 'internal_error', message: 'handler explosion' },
    });
    await expect(promise).rejects.toBeInstanceOf(HostClientError);
    await expect(promise).rejects.toMatchObject({
      code: 'internal_error',
      message: 'handler explosion',
    });
    await client.close();
  });

  it('does not echo back duplicate frames', async () => {
    const { transport, peer } = createFakeTransportPair();
    const client = new HostClient({ transportFactory: () => transport, rng: FIXED_RNG });
    await client.connect();
    const promise = client.echo('hi');
    await new Promise(setImmediate);
    const id = peer.received[0]!.id;
    peer.send({ id, result: { echoed: 'hi' } });
    // Late duplicate should be silently dropped (no double-resolve crash).
    peer.send({ id, result: { echoed: 'hi (late)' } });
    await expect(promise).resolves.toEqual({ echoed: 'hi' });
    await client.close();
  });
});

describe('HostClient — disconnect & reconnect', () => {
  it('rejects all pending requests with `disconnected` when transport drops', async () => {
    const { transport, peer } = createFakeTransportPair();
    const client = new HostClient({
      transportFactory: () => transport,
      rng: FIXED_RNG,
      initialBackoffMs: 1_000_000, // suppress automatic reconnect for this test
    });
    await client.connect();
    const promise = client.ping();
    await new Promise(setImmediate);
    peer.disconnect('test_drop');
    await expect(promise).rejects.toMatchObject({ code: 'disconnected' });
    await client.close();
  });

  it('reconnects via the factory and invokes onReconnect handlers', async () => {
    // Each connect call MUST yield a fresh transport, mirroring the
    // production contract. Otherwise the second openTransport() would
    // try to reuse a closed socket.
    const peers: ReturnType<typeof createFakeTransportPair>[] = [];
    const client = new HostClient({
      transportFactory: () => {
        const pair = createFakeTransportPair();
        peers.push(pair);
        return pair.transport;
      },
      rng: FIXED_RNG,
      initialBackoffMs: 1, // schedule reconnect immediately
      maxBackoffMs: 5,
    });
    await client.connect();
    const reconnectFn = vi.fn();
    client.onReconnect(reconnectFn);
    // Drop the first transport
    peers[0]!.peer.disconnect('drop1');
    // Wait for reconnect attempt
    await vi.waitFor(() => {
      expect(peers.length).toBeGreaterThanOrEqual(2);
    });
    await vi.waitFor(() => {
      expect(client.isConnected()).toBe(true);
    });
    expect(reconnectFn).toHaveBeenCalledTimes(1);
    await client.close();
  });

  it('keeps retrying until success when initial reconnect attempt fails', async () => {
    let attempt = 0;
    const peers: ReturnType<typeof createFakeTransportPair>[] = [];
    const client = new HostClient({
      transportFactory: () => {
        attempt++;
        const pair = createFakeTransportPair({
          // First post-drop attempt fails to connect; second succeeds.
          connectErrorOnce: attempt === 2 ? new Error('ECONNREFUSED') : undefined,
        });
        peers.push(pair);
        return pair.transport;
      },
      rng: FIXED_RNG,
      initialBackoffMs: 1,
      maxBackoffMs: 5,
    });
    await client.connect();
    peers[0]!.peer.disconnect('drop');
    await vi.waitFor(() => {
      expect(client.isConnected()).toBe(true);
    }, { timeout: 1_000 });
    expect(attempt).toBeGreaterThanOrEqual(3);
    await client.close();
  });
});

describe('HostClient — timeouts and lifecycle', () => {
  it('rejects pending requests with `timeout` when no response arrives', async () => {
    const { transport } = createFakeTransportPair();
    const client = new HostClient({
      transportFactory: () => transport,
      requestTimeoutMs: 20,
      rng: FIXED_RNG,
    });
    await client.connect();
    await expect(client.ping()).rejects.toMatchObject({ code: 'timeout' });
    await client.close();
  });

  it('rejects pending requests with `closed` on explicit close', async () => {
    const { transport, peer } = createFakeTransportPair();
    const client = new HostClient({ transportFactory: () => transport, rng: FIXED_RNG });
    await client.connect();
    const p = client.ping();
    await new Promise(setImmediate);
    expect(peer.received).toHaveLength(1);
    await client.close();
    await expect(p).rejects.toMatchObject({ code: 'closed' });
  });

  it('throws on call after close', async () => {
    const { transport } = createFakeTransportPair();
    const client = new HostClient({ transportFactory: () => transport, rng: FIXED_RNG });
    await client.connect();
    await client.close();
    await expect(client.ping()).rejects.toMatchObject({ code: 'closed' });
  });

  it('surfaces initial connect failure on connect()', async () => {
    const transport = createFakeTransportPair({
      connectErrorOnce: new Error('ENOENT: daemon socket missing'),
    }).transport;
    const client = new HostClient({ transportFactory: () => transport, rng: FIXED_RNG });
    await expect(client.connect()).rejects.toThrow(/ENOENT/);
    await client.close();
  });
});

describe('HostClient — schema drift guard (review fix B2)', () => {
  it('rejects with `internal_error` when daemon returns a result that fails its intent schema', async () => {
    // Simulates a future drift: a daemon (older or buggy) returns a
    // ping response missing `daemon_pid`. The client's mirror
    // validation catches it before resolving the caller, so the
    // caller never has to handle a half-shaped object at runtime.
    const { transport, peer } = createFakeTransportPair();
    const client = new HostClient({ transportFactory: () => transport, rng: FIXED_RNG });
    await client.connect();
    const promise = client.ping();
    await new Promise(setImmediate);
    peer.send({
      id: peer.received[0]!.id,
      result: {
        pong: true,
        // daemon_pid intentionally omitted
        daemon_version: '0.1.0',
        started_at: 0,
      },
    });
    await expect(promise).rejects.toMatchObject({ code: 'internal_error' });
    await expect(promise).rejects.toThrow(/drift/);
    await client.close();
  });

  it('still passes a well-shaped result through unmodified', async () => {
    const { transport, peer } = createFakeTransportPair();
    const client = new HostClient({ transportFactory: () => transport, rng: FIXED_RNG });
    await client.connect();
    const promise = client.echo('ok');
    await new Promise(setImmediate);
    peer.send({ id: peer.received[0]!.id, result: { echoed: 'ok' } });
    await expect(promise).resolves.toEqual({ echoed: 'ok' });
    await client.close();
  });
});

describe('HostClient — runtime_* typed helpers (PR-2 step 1)', () => {
  it('runtimeStart sends runtime_start with params and resolves on result', async () => {
    const { transport, peer } = createFakeTransportPair();
    const client = new HostClient({ transportFactory: () => transport, rng: FIXED_RNG });
    await client.connect();
    const promise = client.runtimeStart({
      conversation_id: 'conv1',
      agent_id: 'agent1',
    });
    await new Promise(setImmediate);
    expect(peer.received).toHaveLength(1);
    expect(peer.received[0]!.intent).toBe('runtime_start');
    expect(peer.received[0]!.params).toMatchObject({
      conversation_id: 'conv1',
      agent_id: 'agent1',
    });
    peer.send({
      id: peer.received[0]!.id,
      result: { pid: 4242, started_at: 1_700_000_000_000 },
    });
    await expect(promise).resolves.toMatchObject({ pid: 4242, started_at: 1_700_000_000_000 });
    await client.close();
  });

  it('runtimeWake sends batch delivery_ids and returns delivered=true result', async () => {
    const { transport, peer } = createFakeTransportPair();
    const client = new HostClient({ transportFactory: () => transport, rng: FIXED_RNG });
    await client.connect();
    const promise = client.runtimeWake({
      conversation_id: 'conv1',
      agent_id: 'agent1',
      delivery_ids: [10, 11, 12],
      kind: 'batch',
      payload: '{"role":"user","content":"hi"}\n',
    });
    await new Promise(setImmediate);
    expect(peer.received[0]!.intent).toBe('runtime_wake');
    expect((peer.received[0]!.params as { delivery_ids: number[] }).delivery_ids).toEqual([10, 11, 12]);
    peer.send({
      id: peer.received[0]!.id,
      result: { delivered: true, delivery_ids: [10, 11, 12] },
    });
    await expect(promise).resolves.toEqual({ delivered: true, delivery_ids: [10, 11, 12] });
    await client.close();
  });

  it('runtimeWake delivered=false branch carries a reason', async () => {
    const { transport, peer } = createFakeTransportPair();
    const client = new HostClient({ transportFactory: () => transport, rng: FIXED_RNG });
    await client.connect();
    const promise = client.runtimeWake({
      conversation_id: 'conv1',
      agent_id: 'agent1',
      delivery_ids: [42],
      kind: 'batch',
      payload: '{}\n',
    });
    await new Promise(setImmediate);
    peer.send({
      id: peer.received[0]!.id,
      result: { delivered: false, delivery_ids: [42], reason: 'not_running' },
    });
    await expect(promise).resolves.toEqual({
      delivered: false,
      delivery_ids: [42],
      reason: 'not_running',
    });
    await client.close();
  });

  it('runtimeStatus accepts no params and merges supervisor runtimes', async () => {
    const { transport, peer } = createFakeTransportPair();
    const client = new HostClient({ transportFactory: () => transport, rng: FIXED_RNG });
    await client.connect();
    const promise = client.runtimeStatus();
    await new Promise(setImmediate);
    expect(peer.received[0]!.intent).toBe('runtime_status');
    expect(peer.received[0]!.params).toEqual({});
    peer.send({
      id: peer.received[0]!.id,
      result: { runtimes: [] },
    });
    await expect(promise).resolves.toEqual({ runtimes: [] });
    await client.close();
  });

  it('runtimeStopAll and runtimeCloseActivityLog send empty params', async () => {
    const { transport, peer } = createFakeTransportPair();
    const client = new HostClient({ transportFactory: () => transport, rng: FIXED_RNG });
    await client.connect();
    const stopAll = client.runtimeStopAll();
    await new Promise(setImmediate);
    peer.send({ id: peer.received[0]!.id, result: { stopped_count: 0 } });
    await expect(stopAll).resolves.toEqual({ stopped_count: 0 });
    const closeLog = client.runtimeCloseActivityLog();
    await new Promise(setImmediate);
    peer.send({ id: peer.received[1]!.id, result: { flushed: true } });
    await expect(closeLog).resolves.toEqual({ flushed: true });
    await client.close();
  });
});

describe('HostClient — subscribe (unsolicited events)', () => {
  it('delivers runtime_state events to all subscribers in arrival order', async () => {
    const { transport, peer } = createFakeTransportPair();
    const client = new HostClient({ transportFactory: () => transport, rng: FIXED_RNG });
    await client.connect();
    const recvA: string[] = [];
    const recvB: string[] = [];
    client.subscribe(e => {
      if (e.event === 'runtime_state') recvA.push(e.state.status);
    });
    client.subscribe(e => {
      if (e.event === 'runtime_state') recvB.push(e.state.status);
    });
    const stateFrame = (status: 'idle' | 'thinking'): import('../src/protocol.js').EventFrame => ({
      event: 'runtime_state',
      conversation_id: 'c1',
      agent_id: 'a1',
      state: {
        runId: 'run-1',
        agentId: 'a1',
        conversationId: 'c1',
        status,
        startedAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        lastActivityAt: 1_700_000_000_000,
      },
      ts: 1_700_000_000_000,
    });
    peer.send(stateFrame('idle'));
    peer.send(stateFrame('thinking'));
    expect(recvA).toEqual(['idle', 'thinking']);
    expect(recvB).toEqual(['idle', 'thinking']);
    await client.close();
  });

  it('unsubscribe stops further deliveries to that handler', async () => {
    const { transport, peer } = createFakeTransportPair();
    const client = new HostClient({ transportFactory: () => transport, rng: FIXED_RNG });
    await client.connect();
    const recv: string[] = [];
    const off = client.subscribe(e => {
      if (e.event === 'shutting_down') recv.push(e.reason);
    });
    peer.send({ event: 'shutting_down', reason: 'test_1' });
    off();
    peer.send({ event: 'shutting_down', reason: 'test_2' });
    expect(recv).toEqual(['test_1']);
    await client.close();
  });

  it('isolates subscriber errors so other subscribers still receive the event', async () => {
    const { transport, peer } = createFakeTransportPair();
    const client = new HostClient({
      transportFactory: () => transport,
      rng: FIXED_RNG,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    await client.connect();
    const good: string[] = [];
    client.subscribe(() => {
      throw new Error('boom');
    });
    client.subscribe(e => {
      if (e.event === 'shutting_down') good.push(e.reason);
    });
    peer.send({ event: 'shutting_down', reason: 'after_throw' });
    expect(good).toEqual(['after_throw']);
    await client.close();
  });

  it('subscribers persist across reconnect (handler set lives on the client)', async () => {
    const peers: ReturnType<typeof createFakeTransportPair>[] = [];
    const client = new HostClient({
      transportFactory: () => {
        const pair = createFakeTransportPair();
        peers.push(pair);
        return pair.transport;
      },
      rng: FIXED_RNG,
      initialBackoffMs: 1,
      maxBackoffMs: 5,
    });
    await client.connect();
    const recv: string[] = [];
    client.subscribe(e => {
      if (e.event === 'shutting_down') recv.push(e.reason);
    });
    peers[0]!.peer.send({ event: 'shutting_down', reason: 'first' });
    peers[0]!.peer.disconnect('drop');
    await vi.waitFor(() => {
      expect(peers.length).toBeGreaterThanOrEqual(2);
    });
    await vi.waitFor(() => {
      expect(client.isConnected()).toBe(true);
    });
    peers[1]!.peer.send({ event: 'shutting_down', reason: 'after_reconnect' });
    expect(recv).toEqual(['first', 'after_reconnect']);
    await client.close();
  });
});
