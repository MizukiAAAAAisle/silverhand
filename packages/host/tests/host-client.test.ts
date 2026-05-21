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
