import type { HostRow } from '@silverhand/shared';
import type { AgentRepo } from '../repos/agent-repo.js';
import type { HostRepo } from '../repos/host-repo.js';
import type { WorkspaceRepo } from '../repos/workspace-repo.js';
import { RuntimeHostPlacementError } from '../host-placement-errors.js';

export interface RuntimeHostPlacement {
  assertActiveHost(hostId: string): HostRow;
  resolveForAgent(agentId: string): { host: HostRow };
}

export class RuntimeHostPlacementResolver implements RuntimeHostPlacement {
  constructor(
    private readonly deps: {
      hosts: HostRepo;
      agents: AgentRepo;
      workspaces: WorkspaceRepo;
    },
  ) {}

  assertActiveHost(hostId: string): HostRow {
    const host = this.deps.hosts.get(hostId);
    if (!host) {
      throw new RuntimeHostPlacementError(
        'host_missing',
        `host ${hostId} not found`,
      );
    }
    if (host.revoked_at !== null) {
      throw new RuntimeHostPlacementError(
        'host_revoked',
        `host ${hostId} has been revoked`,
      );
    }
    return host;
  }

  assertOwnedActiveHost(hostId: string, userId: string): HostRow {
    const host = this.assertActiveHost(hostId);
    if (host.user_id !== userId) {
      throw new RuntimeHostPlacementError(
        'host_not_owned',
        `host ${hostId} is not owned by user ${userId}`,
      );
    }
    return host;
  }

  resolveOwnedLocalForUser(userId: string): HostRow {
    const host = this.deps.hosts.getOwnedLocalForUser(userId);
    if (!host) {
      throw new RuntimeHostPlacementError(
        'local_host_unbound',
        `user ${userId} has no active local host`,
      );
    }
    return host;
  }

  resolveForAgent(agentId: string): { host: HostRow } {
    const agent = this.deps.agents.get(agentId);
    if (!agent) {
      throw new RuntimeHostPlacementError(
        'agent_missing',
        `agent ${agentId} not found`,
      );
    }
    return { host: this.assertActiveHost(agent.host_id) };
  }

  assertAgentMatchesHost(agentId: string, hostId: string): void {
    this.deps.workspaces.assertAgentHostMatchesWorkspaceHost(agentId, hostId);
  }

  assertHostEqualityForMembership(agentId: string, workspaceId: string): void {
    this.deps.workspaces.assertHostEqualityForMembership(agentId, workspaceId);
  }
}
