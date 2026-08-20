import { describe, expect, it, vi } from 'vitest';
import {
  HostClient,
  HostClientError,
  ProtocolVersionMismatchError,
} from '../src/client/index.js';
import { createFakeTransportPair } from './_helpers/fake-transport.js';
import { testStartOptions } from './_helpers/runtime-start-options.js';
import { HOST_PROTOCOL_VERSION, KNOWN_CAPABILITIES_V1 } from '../src/protocol.js';

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

describe('HostClient — protocol handshake', () => {
  it('negotiates hello during connect and exposes a readonly capability snapshot', async () => {
    const { transport } = createFakeTransportPair();
    const client = new HostClient({ transportFactory: () => transport, rng: FIXED_RNG });
    await client.connect();

    expect(client.negotiated).toMatchObject({
      protocolVersion: HOST_PROTOCOL_VERSION,
      daemonVersion: '0.0.0-test-daemon',
      daemonId: 'local',
      instanceId: 'test-instance',
      hostDescriptor: { name: 'local', kind: 'local' },
    });
    expect(client.capabilities.has('runtime.cursor')).toBe(true);
    expect([...client.capabilities]).toEqual([...KNOWN_CAPABILITIES_V1]);
    expect(Object.isFrozen(client.capabilities)).toBe(true);
    expect('add' in client.capabilities).toBe(false);
    await client.close();
  });

  it('throws ProtocolVersionMismatchError on protocol version mismatch and closes the transport', async () => {
    const { transport, peer } = createFakeTransportPair({ autoHello: false });
    const client = new HostClient({ transportFactory: () => transport, rng: FIXED_RNG });
    const connect = client.connect();
    await vi.waitFor(() => {
      expect(peer.received[0]?.intent).toBe('hello');
    });
    peer.send({
      id: peer.received[0]!.id,
      result: {
        protocol_version: HOST_PROTOCOL_VERSION + 1,
        daemon_version: 'future-daemon',
        daemon_id: 'local',
        instance_id: 'future-instance',
        host_descriptor: { name: 'local', kind: 'local' },
        capabilities: [...KNOWN_CAPABILITIES_V1],
      },
    });

    await expect(connect).rejects.toBeInstanceOf(ProtocolVersionMismatchError);
    await expect(connect).rejects.toMatchObject({
      code: 'protocol_mismatch',
      expected: HOST_PROTOCOL_VERSION,
      actual: HOST_PROTOCOL_VERSION + 1,
      daemonVersion: 'future-daemon',
      reason: 'version_mismatch',
    });
    expect(client.isConnected()).toBe(false);
    await client.close();
  });

  it('allows unknown capability strings without schema drift', async () => {
    const { transport, peer } = createFakeTransportPair({ autoHello: false });
    const client = new HostClient({ transportFactory: () => transport, rng: FIXED_RNG });
    const connect = client.connect();
    await vi.waitFor(() => {
      expect(peer.received[0]?.intent).toBe('hello');
    });
    peer.send({
      id: peer.received[0]!.id,
      result: {
        protocol_version: HOST_PROTOCOL_VERSION,
        daemon_version: 'newer-daemon',
        daemon_id: 'local',
        instance_id: 'newer-instance',
        host_descriptor: { name: 'local', kind: 'local' },
        capabilities: ['runtime.future_thing'],
      },
    });

    await expect(connect).resolves.toBeUndefined();
    expect(client.capabilities.has('runtime.future_thing')).toBe(true);
    await client.close();
  });

  it('maps schema-invalid hello results to invalid_hello and closes the transport', async () => {
    const { transport, peer } = createFakeTransportPair({ autoHello: false });
    const client = new HostClient({ transportFactory: () => transport, rng: FIXED_RNG });
    const connect = client.connect();
    await vi.waitFor(() => {
      expect(peer.received[0]?.intent).toBe('hello');
    });
    peer.send({
      id: peer.received[0]!.id,
      result: {
        protocol_version: HOST_PROTOCOL_VERSION,
        daemon_version: 'broken-daemon',
        daemon_id: 'local',
        instance_id: 'broken-instance',
        host_descriptor: { name: 'local', kind: 'local' },
        // capabilities deliberately omitted — must fail schema validation.
      },
    });

    await expect(connect).rejects.toBeInstanceOf(ProtocolVersionMismatchError);
    await expect(connect).rejects.toMatchObject({
      code: 'protocol_mismatch',
      expected: HOST_PROTOCOL_VERSION,
      actual: null,
      daemonVersion: null,
      reason: 'invalid_hello',
    });
    expect(client.isConnected()).toBe(false);
    expect(client.negotiated).toBeNull();
    await client.close();
  });

  it('maps missing hello support to daemon_protocol_missing and closes the transport', async () => {
    const { transport, peer } = createFakeTransportPair({ autoHello: false });
    const client = new HostClient({ transportFactory: () => transport, rng: FIXED_RNG });
    const connect = client.connect();
    await vi.waitFor(() => {
      expect(peer.received[0]?.intent).toBe('hello');
    });
    peer.send({
      id: peer.received[0]!.id,
      error: { code: 'unknown_intent', message: 'unknown intent: hello' },
    });

    await expect(connect).rejects.toBeInstanceOf(ProtocolVersionMismatchError);
    await expect(connect).rejects.toMatchObject({
      code: 'protocol_mismatch',
      expected: HOST_PROTOCOL_VERSION,
      actual: null,
      daemonVersion: null,
      reason: 'daemon_protocol_missing',
    });
    expect(client.isConnected()).toBe(false);
    expect(client.negotiated).toBeNull();
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
      runtime_generation: 1,
      conversation_id: 'conv1',
      agent_id: 'agent1',
      options: testStartOptions(),
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
      result: { started: true, pid: 4242, started_at: 1_700_000_000_000 },
    });
    await expect(promise).resolves.toMatchObject({
      started: true,
      pid: 4242,
      started_at: 1_700_000_000_000,
    });
    await client.close();
  });

  it('runtimeDeliver sends runtime_deliver with params and resolves on the disposition result', async () => {
    const { transport, peer } = createFakeTransportPair();
    const client = new HostClient({ transportFactory: () => transport, rng: FIXED_RNG });
    await client.connect();
    const promise = client.runtimeDeliver({
      runtime_generation: 1,
      conversation_id: 'conv1',
      target: { conversation_id: 'conv1', workspace: null },
      agent_id: 'agent1',
      delivery_ids: [101, 102],
      kind: 'message',
      text: 'hello',
      deliveries: [
        { delivery_id: 101, seq: 101, presentation: { body: 'hello', instruction: 'other' } },
        { delivery_id: 102, seq: 102, presentation: { body: 'hello', instruction: 'other' } },
      ],
      spawn_options: testStartOptions(),
    });
    await new Promise(setImmediate);
    expect(peer.received).toHaveLength(1);
    expect(peer.received[0]!.intent).toBe('runtime_deliver');
    expect(peer.received[0]!.params).toMatchObject({
      conversation_id: 'conv1',
      agent_id: 'agent1',
      delivery_ids: [101, 102],
      kind: 'message',
    });
    peer.send({
      id: peer.received[0]!.id,
      result: { disposition: 'admitted', pid: 4242, started_at: 1_700_000_000_000 },
    });
    await expect(promise).resolves.toEqual({
      disposition: 'admitted',
      pid: 4242,
      started_at: 1_700_000_000_000,
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
      runtime_scope: {
        kind: 'conversation',
        conversation_id: 'c1',
        agent_id: 'a1',
      },
      conversation_id: 'c1',
      agent_id: 'a1',
      runtime_generation: 1,
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

/**
 * Cindy D2 P1-1: typed per-intent error codes must survive the
 * local IPC adapter, not be silently dropped at the transport
 * layer.
 *
 * Before the loose-transport refactor:
 *   - Transport validated frames with `AnyFrameSchema`, whose
 *     error arm narrows `code` to the 5 generic `ResponseError`
 *     codes.
 *   - A daemon returning `agent_dir_collision` for
 *     `agent_materialize` would emit a frame whose `error.code`
 *     fails that narrow validation → transport drops the frame
 *     → pending request times out (the actual P1-1 bug).
 *
 * After the refactor:
 *   - Transport uses `LooseAnyFrameSchema` (`error.code: string`)
 *     so the frame reaches `HostClient.handleFrame`.
 *   - `handleFrame` validates `error.code` against
 *     `intentErrorSchema(pending.intent)`. For agent_materialize
 *     that schema admits the 5 generic + 6 materialize-typed
 *     codes.
 *   - Match → typed `HostClientError` with the verbatim code.
 *   - Mismatch (drift) → typed `internal_error` (no silent drop).
 */
describe('HostClient — per-intent typed error scoping (Cindy D2 P1-1)', () => {
  const materializeParams = {
    agent_id: 'aid_local_ipc',
    agent_home_workspace_id: 'wsah_aid_local_ipc',
    name: 'IPC Test Agent',
    runtime: 'claude' as const,
    template_choice: 'default' as const,
  };

  it('surfaces agent_materialize typed error codes verbatim (not dropped at transport)', async () => {
    const { transport, peer } = createFakeTransportPair();
    const client = new HostClient({
      transportFactory: () => transport,
      rng: FIXED_RNG,
    });
    await client.connect();

    const promise = client.call('agent_materialize', materializeParams);
    await new Promise(setImmediate);
    expect(peer.received).toHaveLength(1);
    const req = peer.received[0]!;

    peer.send({
      id: req.id,
      // Typed code — not in the 5-generic ResponseError enum. This
      // is the frame the transport must NOT drop (P1-1 bug case).
      error: {
        code: 'agent_dir_collision',
        message: 'sentinel runtime mismatch',
      },
    });

    await expect(promise).rejects.toBeInstanceOf(HostClientError);
    await expect(promise).rejects.toMatchObject({
      code: 'agent_dir_collision',
      message: 'sentinel runtime mismatch',
    });

    await client.close();
  });

  it.each([
    'fs_quota_exceeded',
    'fs_unavailable',
    'unsupported_template',
    'unsupported_runtime',
    'internal_error',
  ] as const)(
    'surfaces agent_materialize typed code: %s',
    async code => {
      const { transport, peer } = createFakeTransportPair();
      const client = new HostClient({
        transportFactory: () => transport,
        rng: FIXED_RNG,
      });
      await client.connect();

      const promise = client.call('agent_materialize', materializeParams);
      await new Promise(setImmediate);
      peer.send({
        id: peer.received[0]!.id,
        error: { code, message: `seeded ${code}` },
      });
      await expect(promise).rejects.toMatchObject({ code });

      await client.close();
    },
  );

  it('rejects unknown typed code with internal_error (drift catch on the client side)', async () => {
    const { transport, peer } = createFakeTransportPair();
    const client = new HostClient({
      transportFactory: () => transport,
      rng: FIXED_RNG,
    });
    await client.connect();

    const promise = client.call('agent_materialize', materializeParams);
    await new Promise(setImmediate);
    peer.send({
      id: peer.received[0]!.id,
      // This code is NOT in agent_materialize's error taxonomy
      // (and not in the 5 generic). A real-world scenario: client
      // is older than daemon, daemon added a new typed code that
      // this client doesn't know about yet.
      error: {
        code: 'future_taxonomy_code_v2',
        message: 'daemon got ahead of client',
      },
    });

    await expect(promise).rejects.toMatchObject({
      code: 'internal_error',
      // The message preserves the offending code so an operator
      // can trace the skew across daemon and client builds.
      message: expect.stringContaining('future_taxonomy_code_v2'),
    });

    await client.close();
  });

  it('does NOT widen the error surface for echo (non-typed intent)', async () => {
    // Pin the per-intent scoping (Cindy D2 P1-1 fix vs D1 round-1 P1
    // regression): a daemon that mistakenly emits an agent_materialize
    // typed code on an `echo` response MUST surface as drift on the
    // client side, not as a typed echo error.
    const { transport, peer } = createFakeTransportPair();
    const client = new HostClient({
      transportFactory: () => transport,
      rng: FIXED_RNG,
    });
    await client.connect();

    const promise = client.echo('hi');
    await new Promise(setImmediate);
    peer.send({
      id: peer.received[0]!.id,
      error: {
        code: 'agent_dir_collision', // typed for materialize, NOT for echo
        message: 'wrong arm',
      },
    });

    await expect(promise).rejects.toMatchObject({
      code: 'internal_error',
      message: expect.stringContaining('agent_dir_collision'),
    });

    await client.close();
  });
});
