import type {
  AgentDto,
  HostAgentResource,
  HostResourcesResponse,
  HostWorkspaceResource,
  WorkspaceDto,
  WorkspaceRoleDto,
} from '@silverhand/shared';
import type { BackendContext } from '../context.js';
import type { UserPrincipal } from '../auth/principal.js';
import type { AgentRepo } from '../repos/agent-repo.js';
import type { WorkspaceRepo } from '../repos/workspace-repo.js';
import { workspaceRole } from '../permissions.js';

/**
 * Read-model for `GET /api/hosts/:id/resources` — what is persistently rooted on
 * one Computer.
 *
 * This is an ordinary Computer-domain query, NOT a delete preview. It answers
 * "which agents are placed here and which `regular` workspaces keep their files
 * here", and it carries resource facts only — no `can_delete`, no
 * "would-succeed" prediction. Deciding what the list means belongs to the
 * caller: the delete dialog reads it as the impact it must show before asking
 * for confirmation, and the DELETE route re-derives its own authoritative set
 * inside its transaction rather than trusting this projection (#task:1617).
 *
 * Deliberately distinct from `GET /api/hosts/:id/status`, which reports the
 * DYNAMIC availability of the daemon and its live runtimes. Availability and
 * ownership answer different questions and must not be merged into one payload:
 * a lost computer reports every agent `offline` on `/status` while still OWNING
 * all of them here — and it is exactly that computer the delete flow is for.
 */
export interface HostResourcesDeps {
  ctx: BackendContext;
  agents: AgentRepo;
  workspaces: WorkspaceRepo;
}

export function listHostResources(
  deps: HostResourcesDeps,
  hostId: string,
  principal: UserPrincipal,
): HostResourcesResponse {
  const { ctx, agents, workspaces } = deps;
  return {
    agents: agents.listByHost(hostId).map(toHostAgentResource),
    workspaces: workspaces
      .listRegularByHost(hostId)
      .map(workspace =>
        toHostWorkspaceResource(
          workspace,
          workspaceRole(ctx, principal, workspace.id),
        ),
      ),
  };
}

export function toHostAgentResource(agent: AgentDto): HostAgentResource {
  return {
    id: agent.id,
    name: agent.name,
    display_name: agent.display_name,
    runtime: agent.runtime,
  };
}

export function toHostWorkspaceResource(
  workspace: WorkspaceDto,
  viewerRole: WorkspaceRoleDto | null,
): HostWorkspaceResource {
  return {
    id: workspace.id,
    name: workspace.name,
    workspace_path: workspace.workspace_path,
    viewer_role: viewerRole,
  };
}
