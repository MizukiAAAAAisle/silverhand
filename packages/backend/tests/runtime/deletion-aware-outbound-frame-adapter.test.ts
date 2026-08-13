import { describe, expect, it, vi } from 'vitest';
import type {
  OutboundServerCommandKind,
  OutboundServerCommandResult,
} from '@silverhand/host';
import {
  AgentDeletionPendingError,
  DeletionAwareOutboundFrameAdapter,
} from '../../src/runtime/deletion-aware-outbound-frame-adapter.js';
import type { OutboundFrameAdapter } from '../../src/runtime/outbound-frame-adapter.js';

function fixture(deleting: boolean) {
  const sends: OutboundServerCommandKind[] = [];
  const inner: OutboundFrameAdapter = {
    activeConnectionCount: () => 1,
    connectedHostIds: () => ['host-1'],
    connectionIdForHost: () => 'generation-1',
    getAttachment: () => null,
    sendCommand: async <K extends OutboundServerCommandKind>(
      _hostId: string,
      kind: K,
    ) => {
      sends.push(kind);
      return {} as OutboundServerCommandResult<K>;
    },
    close: vi.fn(async () => {}),
  };
  return {
    adapter: new DeletionAwareOutboundFrameAdapter(inner, {
      isDeletionPending: () => deleting,
    }),
    sends,
  };
}

describe('DeletionAwareOutboundFrameAdapter', () => {
  it('blocks every catalogued mutator before wire, including nested MCP scope', async () => {
    const { adapter, sends } = fixture(true);
    const directKinds = [
      'runtime_start',
      'runtime_deliver',
      'agent_materialize',
      'agent_l2_seed',
      'agent_profile_mcp_write',
    ] as const;
    for (const kind of directKinds) {
      await expect(
        adapter.sendCommand('host-1', kind, { agent_id: 'agent-1' } as never),
      ).rejects.toBeInstanceOf(AgentDeletionPendingError);
    }
    await expect(
      adapter.sendCommand(
        'host-1',
        'mcp_probe',
        {
          source: { kind: 'profile', agent_id: 'agent-1' },
          server_name: 'demo',
        },
      ),
    ).rejects.toBeInstanceOf(AgentDeletionPendingError);
    expect(sends).toEqual([]);
  });

  it('allows purge, teardown control and reads through a terminal marker', async () => {
    const { adapter, sends } = fixture(true);
    await adapter.sendCommand('host-1', 'agent_files_purge', {
      agent_id: 'agent-1',
    });
    await adapter.sendCommand(
      'host-1',
      'runtime_stop',
      { conversation_id: 'conversation-1', agent_id: 'agent-1', mode: 'hard' },
    );
    await adapter.sendCommand('host-1', 'agent_profile_mcp_read', {
      agent_id: 'agent-1',
    });
    expect(sends).toEqual([
      'agent_files_purge',
      'runtime_stop',
      'agent_profile_mcp_read',
    ]);
  });

  it('passes mutators through while the agent is active', async () => {
    const { adapter, sends } = fixture(false);
    await adapter.sendCommand('host-1', 'agent_profile_mcp_write', {
      agent_id: 'agent-1',
      raw: '{}',
    });
    expect(sends).toEqual(['agent_profile_mcp_write']);
  });
});
