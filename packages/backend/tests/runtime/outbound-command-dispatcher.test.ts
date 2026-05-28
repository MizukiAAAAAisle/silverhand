import { describe, expect, it } from 'vitest';
import type { HostRow } from '@silverhand/shared';
import type {
  OutboundServerCommandKind,
  OutboundServerCommandParams,
  OutboundServerCommandResult,
} from '@silverhand/host';
import type { HostWsServerController } from '../../src/ws/host-ws-server.js';
import { RuntimeHostPlacementError } from '../../src/host-placement-errors.js';
import { OutboundRuntimeCommandDispatcher } from '../../src/runtime/outbound-command-dispatcher.js';
import type { RuntimeHostPlacement } from '../../src/runtime/host-placement.js';

describe('OutboundRuntimeCommandDispatcher', () => {
  it('resolves agent placement before sending an outbound runtime command', async () => {
    const transport = new FakeTransport();
    const placement = new FakePlacement({ hostId: 'host-1' });
    const delivered: number[][] = [];
    const dispatcher = new OutboundRuntimeCommandDispatcher({
      transport,
      placement,
      inboxAck: { markDelivered: ids => delivered.push([...ids]) },
    });

    await expect(
      dispatcher.runtimeWake({
        conversation_id: 'c1',
        agent_id: 'a1',
        delivery_ids: [1],
        kind: 'message',
        text: 'hello',
      }),
    ).resolves.toEqual({ delivered: true, delivery_ids: [1] });

    expect(placement.resolveCalls).toEqual(['a1']);
    expect(delivered).toEqual([[1]]);
    expect(transport.calls).toEqual([
      {
        hostId: 'host-1',
        kind: 'runtime_wake',
        params: {
          conversation_id: 'c1',
          agent_id: 'a1',
          delivery_ids: [1],
          kind: 'message',
          text: 'hello',
        },
      },
    ]);
  });

  it('fails before wire send when placement rejects the agent host', async () => {
    const transport = new FakeTransport();
    const placement = new FakePlacement({
      hostId: 'host-1',
      error: new RuntimeHostPlacementError('host_revoked', 'host revoked'),
    });
    const dispatcher = new OutboundRuntimeCommandDispatcher({
      transport,
      placement,
    });

    await expect(
      dispatcher.runtimeStop({
        conversation_id: 'c1',
        agent_id: 'a1',
        mode: 'hard',
      }),
    ).rejects.toMatchObject({ code: 'host_revoked' });
    expect(transport.calls).toEqual([]);
  });

  it('uses the explicit default host only for host-wide commands', async () => {
    const transport = new FakeTransport();
    const dispatcher = new OutboundRuntimeCommandDispatcher({
      transport,
      placement: new FakePlacement({ hostId: 'agent-host' }),
      defaultHostId: () => 'default-host',
    });

    await expect(dispatcher.runtimeStopAll()).resolves.toEqual({
      stopped_count: 0,
    });

    expect(transport.calls).toEqual([
      { hostId: 'default-host', kind: 'runtime_stop_all', params: {} },
    ]);
  });
});

class FakeTransport implements HostWsServerController {
  readonly calls: Array<{ hostId: string; kind: string; params: unknown }> = [];

  activeConnectionCount(): number {
    return 1;
  }

  connectedHostIds(): string[] {
    return ['host-1'];
  }

  connectionIdForHost(_hostId: string): string | null {
    return 'conn-1';
  }

  getAttachment(): null {
    // Dispatcher tests don't depend on boot-readiness wiring.
    return null;
  }

  sendCommand<K extends OutboundServerCommandKind>(
    hostId: string,
    kind: K,
    params: OutboundServerCommandParams<K>,
  ): Promise<OutboundServerCommandResult<K>> {
    this.calls.push({ hostId, kind, params });
    if (kind === 'runtime_wake') {
      return Promise.resolve({ delivered: true, delivery_ids: [1] }) as Promise<
        OutboundServerCommandResult<K>
      >;
    }
    if (kind === 'runtime_stop_all') {
      return Promise.resolve({ stopped_count: 0 }) as Promise<
        OutboundServerCommandResult<K>
      >;
    }
    return Promise.resolve({}) as Promise<OutboundServerCommandResult<K>>;
  }

  // D4.c C2 — dispatcher tests don't drive the revoke route.
  disconnectHost(_hostId: string): boolean {
    return false;
  }

  async close(): Promise<void> {
    // no-op
  }
}

class FakePlacement implements RuntimeHostPlacement {
  readonly resolveCalls: string[] = [];

  constructor(
    private readonly opts: {
      hostId: string;
      error?: Error;
    },
  ) {}

  assertActiveHost(hostId: string): HostRow {
    return host(hostId);
  }

  resolveForAgent(agentId: string): { host: HostRow } {
    this.resolveCalls.push(agentId);
    if (this.opts.error) throw this.opts.error;
    return { host: host(this.opts.hostId) };
  }
}

function host(id: string): HostRow {
  return {
    id,
    name: 'host',
    kind: 'local',
    user_id: 'local',
    installation_id: 'install',
    created_at: 1,
    last_seen_at: 1,
    revoked_at: null,
  } as HostRow;
}
