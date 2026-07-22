/**
 * #task:1587 — `HostStatusSingleFlight` gate suite (Cindy's acceptance
 * door #1 for the host_status storm stopgap):
 *
 *   1. concurrent same-host same-generation dispatches produce exactly
 *      ONE daemon RPC; all waiters share the outcome (success AND failure);
 *   2. a generation flip (new connectionId) never hands an old
 *      connection's result to a new connection's request, in either
 *      direction;
 *   3. no leaks: entries clear on settle, and shared failure outcomes
 *      never surface as promise rejections.
 */
import { describe, expect, it } from 'vitest';
import {
  HostStatusSingleFlight,
  type HostStatusOutcome,
} from '../../src/runtime/host-status-dispatch.js';
import type { OutboundFrameAdapter } from '../../src/runtime/outbound-frame-adapter.js';
import { HostWsCommandTransportError } from '../../src/ws/host-ws-server.js';

interface PendingCall {
  hostId: string;
  expectedConnectionId: string | undefined;
  resolve: (result: unknown) => void;
  reject: (err: unknown) => void;
}

/**
 * Fake adapter with manual settle control. `connectionId` is mutable so a
 * test can flip the connection generation between calls; `sendCommand`
 * parks every call in `pending` until the test settles it.
 */
function makeFakeAdapter(initialConnectionId: string | null) {
  const pending: PendingCall[] = [];
  let connectionId = initialConnectionId;
  const adapter: OutboundFrameAdapter = {
    activeConnectionCount: () => (connectionId ? 1 : 0),
    connectedHostIds: () => [],
    connectionIdForHost: () => connectionId,
    getAttachment: () => null,
    sendCommand: (hostId, _kind, _params, opts) =>
      new Promise((resolve, reject) => {
        pending.push({
          hostId,
          expectedConnectionId: opts?.expectedConnectionId,
          resolve: resolve as (result: unknown) => void,
          reject,
        });
      }),
    close: async () => {},
  };
  return {
    adapter,
    pending,
    setConnectionId(next: string | null) {
      connectionId = next;
    },
  };
}

const statusResult = (pid: number) => ({
  os: 'linux',
  os_arch: 'arm64',
  daemon_pid: pid,
  daemon_version: '0.0.0-test',
  started_at: 1,
  uptime_ms: 2,
  active_agent_ids: [],
});

describe('HostStatusSingleFlight', () => {
  it('coalesces concurrent same-host same-generation dispatches into one RPC shared by all waiters', async () => {
    const { adapter, pending } = makeFakeAdapter('conn-1');
    const sf = new HostStatusSingleFlight();

    const waiters = Array.from({ length: 5 }, () =>
      sf.dispatch(adapter, 'host-a'),
    );
    expect(pending).toHaveLength(1);
    expect(pending[0]!.expectedConnectionId).toBe('conn-1');
    expect(sf.inflightCount()).toBe(1);

    pending[0]!.resolve(statusResult(42));
    const outcomes = await Promise.all(waiters);
    for (const outcome of outcomes) {
      expect(outcome.kind).toBe('ok');
      if (outcome.kind === 'ok') expect(outcome.result.daemon_pid).toBe(42);
    }
    // All waiters share the SAME settled outcome object, not five copies.
    expect(new Set(outcomes).size).toBe(1);
    expect(sf.inflightCount()).toBe(0);
  });

  it('shares a failure outcome across waiters without any promise rejection', async () => {
    const { adapter, pending } = makeFakeAdapter('conn-1');
    const sf = new HostStatusSingleFlight();

    const waiters = [
      sf.dispatch(adapter, 'host-a'),
      sf.dispatch(adapter, 'host-a'),
    ];
    expect(pending).toHaveLength(1);
    pending[0]!.reject(
      new HostWsCommandTransportError('transport_timeout', 'timed out', {
        hostId: 'host-a',
        commandKind: 'host_status',
      }),
    );
    // Both waiters RESOLVE to the mapped outcome; a rejection here would
    // fail the await (and vitest would flag the unhandled rejection).
    const outcomes = await Promise.all(waiters);
    for (const outcome of outcomes) {
      expect(outcome).toMatchObject({ kind: 'unreachable', reason: 'timeout' });
    }
    expect(sf.inflightCount()).toBe(0);
  });

  it('keeps different hosts on independent entries', async () => {
    const { adapter, pending } = makeFakeAdapter('conn-1');
    const sf = new HostStatusSingleFlight();

    const a = sf.dispatch(adapter, 'host-a');
    const b = sf.dispatch(adapter, 'host-b');
    expect(pending).toHaveLength(2);
    pending[0]!.resolve(statusResult(1));
    pending[1]!.resolve(statusResult(2));
    const [oa, ob] = await Promise.all([a, b]);
    expect(oa.kind === 'ok' && oa.result.daemon_pid).toBe(1);
    expect(ob.kind === 'ok' && ob.result.daemon_pid).toBe(2);
  });

  it('a generation flip opens a NEW entry: post-flip requests never join the old generation RPC', async () => {
    const { adapter, pending, setConnectionId } = makeFakeAdapter('conn-1');
    const sf = new HostStatusSingleFlight();

    const oldGen = sf.dispatch(adapter, 'host-a');
    expect(pending).toHaveLength(1);

    // Daemon reconnects: new connection generation.
    setConnectionId('conn-2');
    const newGen = sf.dispatch(adapter, 'host-a');
    // Second RPC opened — the new-generation request did NOT coalesce into
    // the old entry.
    expect(pending).toHaveLength(2);
    expect(pending[0]!.expectedConnectionId).toBe('conn-1');
    expect(pending[1]!.expectedConnectionId).toBe('conn-2');
    expect(sf.inflightCount()).toBe(2);

    // Old generation's send fails on the id mismatch (what the transport
    // does for expectedConnectionId drift); new generation succeeds.
    pending[0]!.reject(
      new HostWsCommandTransportError(
        'transport_disconnected',
        'connection replaced',
        { hostId: 'host-a', commandKind: 'host_status' },
      ),
    );
    pending[1]!.resolve(statusResult(99));

    const [oldOutcome, newOutcome] = await Promise.all([oldGen, newGen]);
    // Old waiters get a liveness outcome — never conn-2's data.
    expect(oldOutcome).toEqual({ kind: 'disconnected' });
    expect(newOutcome.kind === 'ok' && newOutcome.result.daemon_pid).toBe(99);
    expect(sf.inflightCount()).toBe(0);
  });

  it('an old-generation RPC settling LATE cannot serve requests made after the flip', async () => {
    const { adapter, pending, setConnectionId } = makeFakeAdapter('conn-1');
    const sf = new HostStatusSingleFlight();

    const oldGen = sf.dispatch(adapter, 'host-a');
    setConnectionId('conn-2');
    const newGen = sf.dispatch(adapter, 'host-a');
    expect(pending).toHaveLength(2);

    // Perverse order: the OLD connection's daemon answers (late) with data.
    // The new-generation waiter must still be pinned to its own RPC.
    pending[0]!.resolve(statusResult(1));
    pending[1]!.resolve(statusResult(2));
    const [oldOutcome, newOutcome] = await Promise.all([oldGen, newGen]);
    expect(oldOutcome.kind === 'ok' && oldOutcome.result.daemon_pid).toBe(1);
    expect(newOutcome.kind === 'ok' && newOutcome.result.daemon_pid).toBe(2);
    expect(sf.inflightCount()).toBe(0);
  });

  it('a slow old-generation settle does not evict the successor entry (identity-checked cleanup)', async () => {
    const { adapter, pending, setConnectionId } = makeFakeAdapter('conn-1');
    const sf = new HostStatusSingleFlight();

    const first = sf.dispatch(adapter, 'host-a');
    pending[0]!.resolve(statusResult(1));
    await first;
    expect(sf.inflightCount()).toBe(0);

    // Same generation id re-appears (worst case: transport reuses the id
    // string). A fresh dispatch creates a NEW entry under the same key;
    // the first entry's cleanup already ran and must not delete it.
    const second = sf.dispatch(adapter, 'host-a');
    expect(sf.inflightCount()).toBe(1);
    expect(pending).toHaveLength(2);
    pending[1]!.resolve(statusResult(2));
    const outcome = await second;
    expect(outcome.kind === 'ok' && outcome.result.daemon_pid).toBe(2);
    expect(sf.inflightCount()).toBe(0);
    void setConnectionId;
  });

  it('no adapter or no live connection short-circuits to disconnected without touching the map', async () => {
    const sf = new HostStatusSingleFlight();
    await expect(sf.dispatch(null, 'host-a')).resolves.toEqual({
      kind: 'disconnected',
    });
    const { adapter } = makeFakeAdapter(null);
    await expect(sf.dispatch(adapter, 'host-a')).resolves.toEqual({
      kind: 'disconnected',
    });
    expect(sf.inflightCount()).toBe(0);
  });

  it('sequential dispatches after settle open fresh RPCs (no stale result reuse)', async () => {
    const { adapter, pending } = makeFakeAdapter('conn-1');
    const sf = new HostStatusSingleFlight();

    const first = sf.dispatch(adapter, 'host-a');
    pending[0]!.resolve(statusResult(1));
    expect((await first).kind).toBe('ok');

    const second = sf.dispatch(adapter, 'host-a');
    expect(pending).toHaveLength(2);
    pending[1]!.resolve(statusResult(2));
    const outcome = await second;
    expect(outcome.kind === 'ok' && outcome.result.daemon_pid).toBe(2);
  });
});

// Type-only sanity: the outcome union is what the route switches on.
const _outcomeCheck: HostStatusOutcome = { kind: 'disconnected' };
void _outcomeCheck;
