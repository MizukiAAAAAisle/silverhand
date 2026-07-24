/**
 * Cross-computer slice 1 (#task:1596) — pre-spawn L2 seed ensurer on the
 * dispatch host (hoisted out of the retired workspace-registry-backfill
 * file, #task:1612). Pins: per-(host, workspace, agent) success memo,
 * typed non-memoized failures with retry, and in-flight collapse.
 */
import { describe, expect, it } from 'vitest';
import type {
  OutboundServerCommandKind,
  OutboundServerCommandParams,
  OutboundServerCommandResult,
} from '@silverhand/host';
import { HostWsCommandResponseError } from '../../src/ws/host-ws-server.js';
import type { OutboundFrameAdapter } from '../../src/runtime/outbound-frame-adapter.js';
import { AgentL2SeedEnsurer } from '../../src/runtime/agent-l2-seed-ensurer.js';

describe('AgentL2SeedEnsurer (#task:1596 pre-spawn L2 seed on the dispatch host)', () => {
  type SeedCall = { agent_id: string; workspace_id: string };

  function makeSeedAdapter(opts: {
    connectionId: string | null;
    error?: Error;
  }): { adapter: OutboundFrameAdapter; calls: SeedCall[] } {
    const calls: SeedCall[] = [];
    const adapter: OutboundFrameAdapter = {
      activeConnectionCount: () => (opts.connectionId ? 1 : 0),
      connectedHostIds: () => (opts.connectionId ? ['local'] : []),
      connectionIdForHost: () => opts.connectionId,
      getAttachment: () => null,
      async sendCommand<K extends OutboundServerCommandKind>(
        _hostId: string,
        kind: K,
        params: OutboundServerCommandParams<K>,
      ): Promise<OutboundServerCommandResult<K>> {
        expect(kind).toBe('agent_l2_seed');
        const p = params as { agent_id: string; workspace_id: string };
        calls.push({ agent_id: p.agent_id, workspace_id: p.workspace_id });
        if (opts.error) throw opts.error;
        return {
          ok: true,
          seeded: true,
          l2_present: true,
        } as OutboundServerCommandResult<K>;
      },
      async close() {},
    };
    return { adapter, calls };
  }

  it('seeds once and memoizes per (host, workspace, agent)', async () => {
    const { adapter, calls } = makeSeedAdapter({ connectionId: 'conn-1' });
    const ensurer = new AgentL2SeedEnsurer({ outboundFrameAdapter: () => adapter });

    expect(await ensurer.ensure('h1', 'ws1', 'a1')).toEqual({ ok: true });
    expect(await ensurer.ensure('h1', 'ws1', 'a1')).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    // A different agent / workspace / host is a separate key.
    await ensurer.ensure('h1', 'ws1', 'a2');
    await ensurer.ensure('h1', 'ws2', 'a1');
    await ensurer.ensure('h2', 'ws1', 'a1');
    expect(calls).toHaveLength(4);
  });

  it('daemon offline → typed failure, NOT memoized; next ensure retries', async () => {
    let adapterRef: OutboundFrameAdapter | null = null;
    const ensurer = new AgentL2SeedEnsurer({
      outboundFrameAdapter: () => adapterRef,
    });
    const first = await ensurer.ensure('h1', 'ws1', 'a1');
    expect(first.ok).toBe(false);
    if (!first.ok) {
      expect(first.failure.code).toBe('host_attach_pending');
      expect(first.failure.retriable).toBe(true);
    }
    const { adapter, calls } = makeSeedAdapter({ connectionId: 'conn-1' });
    adapterRef = adapter;
    expect(await ensurer.ensure('h1', 'ws1', 'a1')).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
  });

  it('typed daemon failure surfaces and is retried on the next ensure', async () => {
    const failing = makeSeedAdapter({
      connectionId: 'conn-1',
      error: new HostWsCommandResponseError(
        'workspace_not_provisioned' as never,
        'ws1 not bound',
        { hostId: 'h1', commandKind: 'agent_l2_seed', requestId: 'r' },
      ),
    });
    let adapter = failing.adapter;
    const ensurer = new AgentL2SeedEnsurer({
      outboundFrameAdapter: () => adapter,
    });
    const res = await ensurer.ensure('h1', 'ws1', 'a1');
    expect(res.ok).toBe(false);
    const healthy = makeSeedAdapter({ connectionId: 'conn-1' });
    adapter = healthy.adapter;
    expect(await ensurer.ensure('h1', 'ws1', 'a1')).toEqual({ ok: true });
    expect(healthy.calls).toHaveLength(1);
  });

  it('concurrent ensure() for the same key collapse onto one dispatch', async () => {
    let resolveSend: (() => void) | null = null;
    let sendCount = 0;
    const adapter: OutboundFrameAdapter = {
      activeConnectionCount: () => 1,
      connectedHostIds: () => ['local'],
      connectionIdForHost: () => 'conn-1',
      getAttachment: () => null,
      sendCommand: ((..._args: unknown[]) => {
        sendCount += 1;
        return new Promise<unknown>(resolve => {
          resolveSend = () =>
            resolve({ ok: true, seeded: true, l2_present: true });
        });
      }) as OutboundFrameAdapter['sendCommand'],
      async close() {},
    };
    const ensurer = new AgentL2SeedEnsurer({ outboundFrameAdapter: () => adapter });
    const p1 = ensurer.ensure('h1', 'ws1', 'a1');
    const p2 = ensurer.ensure('h1', 'ws1', 'a1');
    await new Promise(r => setTimeout(r, 0));
    expect(sendCount).toBe(1);
    resolveSend!();
    expect(await Promise.all([p1, p2])).toEqual([{ ok: true }, { ok: true }]);
  });
});
