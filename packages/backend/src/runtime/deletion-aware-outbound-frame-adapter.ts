import {
  agentHomeCommandEffect,
  commandAgentId,
  isAgentHomeMutatorEffect,
  type OutboundServerCommandKind,
  type OutboundServerCommandParams,
  type OutboundServerCommandResult,
} from '@silverhand/host';
import type { AgentTeardownReadPort } from '../application/agent-teardown-ports.js';
import type { HostWsAttachment } from '../ws/host-ws-server.js';
import type { OutboundFrameAdapter } from './outbound-frame-adapter.js';

export class AgentDeletionPendingError extends Error {
  readonly code = 'agent_deleting';

  constructor(readonly agentId: string) {
    super(`agent ${agentId} is being deleted`);
    this.name = 'AgentDeletionPendingError';
  }
}

/**
 * Persistent backend admission gate. The daemon coordinator closes work that
 * was already admitted or spawned; this wrapper blocks every new mutator send
 * after `beginDeletion` using the same exhaustive command-effect catalogue.
 */
export class DeletionAwareOutboundFrameAdapter implements OutboundFrameAdapter {
  constructor(
    private readonly inner: OutboundFrameAdapter,
    private readonly agents: Pick<AgentTeardownReadPort, 'isDeletionPending'>,
  ) {}

  activeConnectionCount(): number {
    return this.inner.activeConnectionCount();
  }

  connectedHostIds(): string[] {
    return this.inner.connectedHostIds();
  }

  connectionIdForHost(hostId: string): string | null {
    return this.inner.connectionIdForHost(hostId);
  }

  getAttachment(hostId: string): HostWsAttachment | null {
    return this.inner.getAttachment(hostId);
  }

  sendCommand<K extends OutboundServerCommandKind>(
    hostId: string,
    kind: K,
    params: OutboundServerCommandParams<K>,
    opts?: { timeoutMs?: number; expectedConnectionId?: string },
  ): Promise<OutboundServerCommandResult<K>> {
    const effect = agentHomeCommandEffect(kind);
    const agentId = commandAgentId(params);
    if (
      agentId !== null &&
      isAgentHomeMutatorEffect(effect) &&
      this.agents.isDeletionPending(agentId)
    ) {
      return Promise.reject(new AgentDeletionPendingError(agentId));
    }
    return this.inner.sendCommand(hostId, kind, params, opts);
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}
