/**
 * #task:1588 — `HostStatusReadModel` gate suite (slice 1 + slice 2
 * re-review):
 *
 *   - gate #4: `read()` is memory-only — NO code path from the HTTP
 *     read surface calls `sendCommand` (no seed, failed seed, exhausted
 *     retries: all return explicit non-available arms with zero RPC);
 *   - all dispatch is owned by the `seedEagerly` chain: bounded retry,
 *     generation-guarded, single-flighted, cancelled by `close()`;
 *   - generation binding: a late old-generation settle can neither
 *     publish over a successor seed nor be served; reconnect re-seeds;
 *   - active-set precedence: seed ids before the current generation's
 *     hydrate, event-maintained cache after — never a merge;
 *   - `onSeeded` fires exactly once per published seed.
 *
 * Plus the pure liveness fold (`activeAgentIdsFromCacheEntries`).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  HostStatusReadModel,
  SEED_RETRY_DELAYS_MS,
  type HostRuntimeActivityView,
} from '../../src/runtime/host-status-read-model.js';
import {
  activeAgentIdsFromCacheEntries,
} from '../../src/runtime/outbound-event-fanout.js';
import { HOST_ACTIVE_RUNTIME_PHASES } from '@silverhand/host';
import type { CachedRuntimeEntry } from '../../src/runtime/run-state-cache.js';
import type { OutboundFrameAdapter } from '../../src/runtime/outbound-frame-adapter.js';
import { HostWsCommandTransportError } from '../../src/ws/host-ws-server.js';

function makeAdapter(opts: {
  connectionId: () => string | null;
  onHostStatus: () => Promise<unknown>;
}) {
  let calls = 0;
  const adapter: OutboundFrameAdapter = {
    activeConnectionCount: () => (opts.connectionId() ? 1 : 0),
    connectedHostIds: () => [],
    connectionIdForHost: () => opts.connectionId(),
    getAttachment: () => null,
    sendCommand: async (_hostId, kind) => {
      expect(kind).toBe('host_status');
      calls += 1;
      return (await opts.onHostStatus()) as never;
    },
    close: async () => {},
  };
  return { adapter, rpcCalls: () => calls };
}

const statusResult = (overrides?: Partial<Record<string, unknown>>) => ({
  os: 'linux',
  os_arch: 'arm64',
  daemon_pid: 42,
  daemon_version: '1.0.0',
  started_at: 1_000,
  uptime_ms: 5_000,
  active_agent_ids: ['agent-seed'],
  ...overrides,
});

const timeoutError = () =>
  new HostWsCommandTransportError('transport_timeout', 'boom', {
    hostId: 'host-a',
    commandKind: 'host_status',
  });

describe('HostStatusReadModel — memory-only read surface (gate #4)', () => {
  it('a pre-seed read returns the pending arm and performs ZERO RPC', () => {
    const { adapter, rpcCalls } = makeAdapter({
      connectionId: () => 'conn-1',
      onHostStatus: async () => statusResult(),
    });
    const model = new HostStatusReadModel({ adapter: () => adapter });

    const outcome = model.read('host-a');
    expect(outcome).toMatchObject({
      kind: 'unreachable',
      reason: 'daemon_unreachable',
    });
    expect(rpcCalls()).toBe(0);
  });

  it('reads after exhausted seed retries still perform ZERO RPC', async () => {
    vi.useFakeTimers();
    try {
      const { adapter, rpcCalls } = makeAdapter({
        connectionId: () => 'conn-1',
        onHostStatus: async () => {
          throw timeoutError();
        },
      });
      const warns: string[] = [];
      const model = new HostStatusReadModel({
        adapter: () => adapter,
        logger: { warn: (_meta, msg) => warns.push(msg) },
      });

      void model.seedEagerly('host-a');
      for (const delay of SEED_RETRY_DELAYS_MS) {
        await vi.advanceTimersByTimeAsync(delay);
      }
      const attempts = rpcCalls();
      expect(attempts).toBe(1 + SEED_RETRY_DELAYS_MS.length);
      // The rollout observable: exhaustion is logged exactly once.
      expect(warns.filter(m => m.includes('seed retries exhausted'))).toHaveLength(1);

      expect(model.read('host-a').kind).toBe('unreachable');
      expect(model.read('host-a').kind).toBe('unreachable');
      expect(rpcCalls()).toBe(attempts); // GET never dispatches
    } finally {
      vi.useRealTimers();
    }
  });

  it('no connection reads disconnected and drops the seed', async () => {
    let connectionId: string | null = 'conn-1';
    const { adapter, rpcCalls } = makeAdapter({
      connectionId: () => connectionId,
      onHostStatus: async () => statusResult(),
    });
    const model = new HostStatusReadModel({ adapter: () => adapter });
    await model.seedEagerly('host-a');
    expect(model.read('host-a').kind).toBe('ok');

    connectionId = null;
    expect(model.read('host-a')).toEqual({ kind: 'disconnected' });

    // Reattach under the same id string: the seed was dropped, so the
    // read stays pending until a fresh seeding chain runs.
    connectionId = 'conn-1';
    expect(model.read('host-a').kind).toBe('unreachable');
    expect(rpcCalls()).toBe(1);
  });
});

describe('HostStatusReadModel — seedEagerly owns all dispatch', () => {
  it('seeds once per generation; subsequent reads and re-seeds are free', async () => {
    let now = 100_000;
    const seeded: string[] = [];
    const { adapter, rpcCalls } = makeAdapter({
      connectionId: () => 'conn-1',
      onHostStatus: async () => statusResult(),
    });
    const model = new HostStatusReadModel({
      adapter: () => adapter,
      monotonicNow: () => now,
      onSeeded: hostId => seeded.push(hostId),
    });

    await model.seedEagerly('host-a');
    expect(rpcCalls()).toBe(1);
    expect(seeded).toEqual(['host-a']);

    now += 7_000;
    const outcome = model.read('host-a');
    expect(outcome.kind === 'ok' && outcome.snapshot).toMatchObject({
      os: 'linux',
      daemon_pid: 42,
      uptime_ms: 5_000 + 7_000,
    });

    // A duplicate ready for the SAME generation is a no-op.
    await model.seedEagerly('host-a');
    expect(rpcCalls()).toBe(1);
    expect(seeded).toEqual(['host-a']);
  });

  it('a generation flip re-seeds; a late old-generation settle neither overwrites nor is served', async () => {
    let connectionId = 'conn-1';
    const pending: Array<{ resolve: (v: unknown) => void }> = [];
    const adapter: OutboundFrameAdapter = {
      activeConnectionCount: () => 1,
      connectedHostIds: () => [],
      connectionIdForHost: () => connectionId,
      getAttachment: () => null,
      sendCommand: () =>
        new Promise(resolve => {
          pending.push({ resolve: resolve as (v: unknown) => void });
        }),
      close: async () => {},
    };
    const seeded: string[] = [];
    const model = new HostStatusReadModel({
      adapter: () => adapter,
      onSeeded: hostId => seeded.push(hostId),
    });

    const oldChain = model.seedEagerly('host-a'); // conn-1 RPC pending
    connectionId = 'conn-2';
    const newChain = model.seedEagerly('host-a'); // conn-2 RPC pending
    expect(pending).toHaveLength(2);

    pending[1]!.resolve(statusResult({ daemon_pid: 2 }));
    await newChain;
    const afterNew = model.read('host-a');
    expect(afterNew.kind === 'ok' && afterNew.snapshot.daemon_pid).toBe(2);

    // Old generation settles late with data: publish-time recheck drops it.
    pending[0]!.resolve(statusResult({ daemon_pid: 1 }));
    await oldChain;
    const afterOld = model.read('host-a');
    expect(afterOld.kind === 'ok' && afterOld.snapshot.daemon_pid).toBe(2);
    expect(seeded).toEqual(['host-a']); // exactly one publish
  });

  it('failed seeds retry on the bounded backoff and recover within the generation', async () => {
    vi.useFakeTimers();
    try {
      let failures = 2;
      const { adapter, rpcCalls } = makeAdapter({
        connectionId: () => 'conn-1',
        onHostStatus: async () => {
          if (failures > 0) {
            failures -= 1;
            throw timeoutError();
          }
          return statusResult({ daemon_pid: 7 });
        },
      });
      const model = new HostStatusReadModel({ adapter: () => adapter });

      void model.seedEagerly('host-a');
      await vi.advanceTimersByTimeAsync(0);
      expect(rpcCalls()).toBe(1);
      expect(model.read('host-a').kind).toBe('unreachable');

      await vi.advanceTimersByTimeAsync(SEED_RETRY_DELAYS_MS[0]!);
      expect(rpcCalls()).toBe(2);

      await vi.advanceTimersByTimeAsync(SEED_RETRY_DELAYS_MS[1]!);
      expect(rpcCalls()).toBe(3);
      const outcome = model.read('host-a');
      expect(outcome.kind === 'ok' && outcome.snapshot.daemon_pid).toBe(7);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(rpcCalls()).toBe(3); // no probes after success
    } finally {
      vi.useRealTimers();
    }
  });

  it('pending retries abort on generation change and on close()', async () => {
    vi.useFakeTimers();
    try {
      let connectionId: string | null = 'conn-1';
      const { adapter, rpcCalls } = makeAdapter({
        connectionId: () => connectionId,
        onHostStatus: async () => {
          throw timeoutError();
        },
      });
      const model = new HostStatusReadModel({ adapter: () => adapter });

      void model.seedEagerly('host-a');
      await vi.advanceTimersByTimeAsync(0);
      expect(rpcCalls()).toBe(1);

      connectionId = 'conn-2'; // flip before the retry fires
      await vi.advanceTimersByTimeAsync(SEED_RETRY_DELAYS_MS[0]!);
      expect(rpcCalls()).toBe(1);

      connectionId = 'conn-3';
      void model.seedEagerly('host-a');
      await vi.advanceTimersByTimeAsync(0);
      expect(rpcCalls()).toBe(2);
      model.close(); // cancels the pending retry
      await vi.advanceTimersByTimeAsync(60_000);
      expect(rpcCalls()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps hosts independent', async () => {
    const { adapter, rpcCalls } = makeAdapter({
      connectionId: () => 'conn-1',
      onHostStatus: async () => statusResult(),
    });
    const model = new HostStatusReadModel({ adapter: () => adapter });
    await model.seedEagerly('host-a');
    await model.seedEagerly('host-b');
    expect(rpcCalls()).toBe(2);
    expect(model.read('host-a').kind).toBe('ok');
    expect(model.read('host-b').kind).toBe('ok');
    expect(rpcCalls()).toBe(2);
  });
});

describe('HostStatusReadModel — active-set precedence & uptime', () => {
  it('serves the seed active set before hydrate, the fanout view after (including a CONTRACTING set)', async () => {
    let view: HostRuntimeActivityView | null = null;
    const { adapter } = makeAdapter({
      connectionId: () => 'conn-1',
      onHostStatus: async () =>
        statusResult({ active_agent_ids: ['agent-seed'] }),
    });
    const model = new HostStatusReadModel({
      adapter: () => adapter,
      runtimeView: () => view,
    });
    await model.seedEagerly('host-a');

    // No view / un-hydrated view → seed ids.
    let outcome = model.read('host-a');
    expect(outcome.kind === 'ok' && [...outcome.activeAgentIds]).toEqual([
      'agent-seed',
    ]);
    view = {
      connectionId: 'conn-1',
      hydratedForCurrentDaemon: false,
      activeAgentIds: [],
    };
    outcome = model.read('host-a');
    expect(outcome.kind === 'ok' && [...outcome.activeAgentIds]).toEqual([
      'agent-seed',
    ]);

    // Hydrated for the SAME generation → cache wins unconditionally —
    // the Cindy P1-2 shape: seed {A} → hydrate {} serves EMPTY.
    view = {
      connectionId: 'conn-1',
      hydratedForCurrentDaemon: true,
      activeAgentIds: [],
    };
    outcome = model.read('host-a');
    expect(outcome.kind === 'ok' && [...outcome.activeAgentIds]).toEqual([]);

    // A hydrated view from a DIFFERENT generation is ignored.
    view = {
      connectionId: 'conn-0',
      hydratedForCurrentDaemon: true,
      activeAgentIds: ['agent-stale'],
    };
    outcome = model.read('host-a');
    expect(outcome.kind === 'ok' && [...outcome.activeAgentIds]).toEqual([
      'agent-seed',
    ]);
  });

  it('uptime_ms is always an integer and never falls below the seed base', async () => {
    let now = 100.25; // fractional, like performance.now()
    const { adapter } = makeAdapter({
      connectionId: () => 'conn-1',
      onHostStatus: async () => statusResult({ uptime_ms: 5_000 }),
    });
    const model = new HostStatusReadModel({
      adapter: () => adapter,
      monotonicNow: () => now,
    });
    await model.seedEagerly('host-a');

    now = 138.7;
    const later = model.read('host-a');
    expect(later.kind === 'ok' && Number.isInteger(later.snapshot.uptime_ms)).toBe(
      true,
    );
    expect(later.kind === 'ok' && later.snapshot.uptime_ms).toBe(
      Math.round(5_000 + (138.7 - 100.25)),
    );

    // A (theoretically impossible) monotonic regression clamps at the
    // seed base rather than shrinking reported uptime.
    now = 50;
    const clamped = model.read('host-a');
    expect(clamped.kind === 'ok' && clamped.snapshot.uptime_ms).toBe(5_000);
  });
});

describe('activeAgentIdsFromCacheEntries', () => {
  const entry = (
    overrides: Partial<CachedRuntimeEntry> & Pick<CachedRuntimeEntry, 'agentId'>,
  ): CachedRuntimeEntry => ({
    runtimeScope: {
      kind: 'conversation',
      conversation_id: overrides.conversationId ?? 'conv-1',
      agent_id: overrides.agentId,
    },
    conversationId: 'conv-1',
    runtimeGeneration: 1,
    phase: 'ready',
    pid: 1,
    startedAt: 1,
    runState: null,
    daemonInstanceKey: 'daemon-1',
    updatedAt: 1,
    ...overrides,
  });

  it('aggregates per (host, agent) across conversations: one exit does not kill a live sibling runtime', () => {
    const ids = activeAgentIdsFromCacheEntries(
      [
        entry({ agentId: 'a', conversationId: 'conv-1', phase: 'exited' }),
        entry({ agentId: 'a', conversationId: 'conv-2', phase: 'ready' }),
        entry({ agentId: 'b', conversationId: 'conv-3', phase: 'exited' }),
      ],
      'daemon-1',
    );
    expect(ids).toEqual(['a']);
  });

  it('mirrors the daemon phase whitelist and fails closed on unknown phases', () => {
    expect([...HOST_ACTIVE_RUNTIME_PHASES].sort()).toEqual([
      'draining',
      'ready',
      'spawning',
      'startup_pending',
    ]);
    const ids = activeAgentIdsFromCacheEntries(
      [
        entry({ agentId: 'spawning', phase: 'spawning' }),
        entry({ agentId: 'startup', phase: 'startup_pending' }),
        entry({ agentId: 'ready', phase: 'ready' }),
        entry({ agentId: 'draining', phase: 'draining' }),
        entry({ agentId: 'idle', phase: 'idle' }),
        entry({ agentId: 'exited', phase: 'exited' }),
        entry({
          agentId: 'future',
          phase: 'some_future_phase' as CachedRuntimeEntry['phase'],
        }),
      ],
      'daemon-1',
    );
    expect(ids.sort()).toEqual(['draining', 'ready', 'spawning', 'startup']);
  });

  it('scopes to the current daemon generation', () => {
    const entries = [
      entry({ agentId: 'old', daemonInstanceKey: 'daemon-0' }),
      entry({ agentId: 'new', daemonInstanceKey: 'daemon-1' }),
    ];
    expect(activeAgentIdsFromCacheEntries(entries, 'daemon-1')).toEqual(['new']);
    expect(activeAgentIdsFromCacheEntries(entries, null)).toEqual([]);
  });
});
