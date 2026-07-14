import { describe, expect, it, vi } from 'vitest';
import type {
  OutboundServerCommandKind,
  OutboundServerCommandParams,
  OutboundServerCommandResult,
} from '@silverhand/host';
import {
  CompositeOutboundFrameAdapter,
  type OutboundFrameAdapter,
} from '../../src/runtime/outbound-frame-adapter.js';
import type { HostWsAttachment } from '../../src/ws/host-ws-server.js';

describe('CompositeOutboundFrameAdapter', () => {
  it('routes commands to the transport that owns the live host connection', async () => {
    const local = fakeAdapter({ hostId: 'local-host', connectionId: 'local-conn' });
    const remote = fakeAdapter({ hostId: 'remote-host', connectionId: 'remote-conn' });
    const adapter = new CompositeOutboundFrameAdapter([local, remote]);

    expect(adapter.activeConnectionCount()).toBe(2);
    expect(adapter.connectedHostIds()).toEqual(['local-host', 'remote-host']);
    expect(adapter.connectionIdForHost('remote-host')).toBe('remote-conn');
    expect(adapter.getAttachment('remote-host')).toMatchObject({
      hostId: 'remote-host',
      connectionId: 'remote-conn',
    });

    await expect(
      adapter.sendCommand('remote-host', 'host_status', {}, { timeoutMs: 10 }),
    ).resolves.toMatchObject({ daemon_pid: 123 });
    expect(local.calls).toHaveLength(0);
    expect(remote.calls).toEqual([
      {
        hostId: 'remote-host',
        kind: 'host_status',
        params: {},
        opts: { timeoutMs: 10 },
      },
    ]);
  });

  it('fails closed for host ids no underlying transport currently owns', async () => {
    const adapter = new CompositeOutboundFrameAdapter([
      fakeAdapter({ hostId: 'local-host', connectionId: 'local-conn' }),
    ]);

    await expect(
      adapter.sendCommand('remote-host', 'host_status', {}),
    ).rejects.toMatchObject({
      code: 'transport_no_connection',
    });
  });
});

function fakeAdapter(input: {
  hostId: string;
  connectionId: string;
}): OutboundFrameAdapter & {
  calls: Array<{
    hostId: string;
    kind: OutboundServerCommandKind;
    params: unknown;
    opts: unknown;
  }>;
} {
  const calls: Array<{
    hostId: string;
    kind: OutboundServerCommandKind;
    params: unknown;
    opts: unknown;
  }> = [];
  return {
    calls,
    activeConnectionCount: () => 1,
    connectedHostIds: () => [input.hostId],
    connectionIdForHost: (hostId: string) =>
      hostId === input.hostId ? input.connectionId : null,
    getAttachment: (hostId: string): HostWsAttachment | null =>
      hostId === input.hostId
        ? {
            hostId: input.hostId,
            connectionId: input.connectionId,
            attachedAt: 1_700_000_000_000,
            hostname: `${input.hostId}.local`,
            capabilities: [],
          }
        : null,
    sendCommand: vi.fn(
      async <K extends OutboundServerCommandKind>(
        hostId: string,
        kind: K,
        params: OutboundServerCommandParams<K>,
        opts?: { timeoutMs?: number; expectedConnectionId?: string },
      ): Promise<OutboundServerCommandResult<K>> => {
        calls.push({ hostId, kind, params, opts });
        return {
          os: 'darwin 26.0.0',
          os_arch: 'arm64',
          daemon_pid: 123,
          daemon_version: 'test',
          started_at: 1_700_000_000_000,
          uptime_ms: 10,
          active_agent_ids: [],
        } as OutboundServerCommandResult<K>;
      },
    ) as OutboundFrameAdapter['sendCommand'],
    close: async () => {},
  };
}
