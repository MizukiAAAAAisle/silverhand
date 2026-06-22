import { join } from 'node:path';
import { isAgentHomeWorkspaceId } from '@silverhand/shared';
import { resolveAgentDir } from '../agent-materialize/index.js';
import {
  type WorkspaceRegistry,
  WorkspaceRegistryError,
} from '../workspace-registry/index.js';
import { AgentWorkspaceFsError } from './error.js';

export interface ResolveAgentWorkspaceBaseDeps {
  /** Parent dir for agent-home resolution. Default: daemon's homedir. */
  homeDir?: string;
  /** Exact root for agent-home resolution. Takes precedence over homeDir. */
  agentHomeRootDir?: string;
  /** Registry used only when `workspace_id` is a regular workspace id. */
  registry?: WorkspaceRegistry;
}

/**
 * Resolve the semantic agent workspace source to a host-local base dir.
 *
 * Omitted `workspace_id` preserves the original #task:811 meaning: the agent
 * home/L1 dir. Present `workspace_id` means "the agent's memory dir for this
 * workspace"; agent-home/DM ids intentionally resolve to the same home dir,
 * while regular workspace ids resolve through the daemon registry to
 * `<workspace>/.silverhand/agents/<agent_id>`.
 *
 * The backend must already have done authz/membership gates. This helper is
 * intentionally path-only and still never accepts a server-supplied path.
 */
export function resolveAgentWorkspaceBaseDir(
  params: { agent_id: string; workspace_id?: string },
  deps: ResolveAgentWorkspaceBaseDeps = {},
): string {
  const workspaceId = params.workspace_id;
  if (
    !workspaceId ||
    isAgentHomeWorkspaceId(workspaceId, params.agent_id)
  ) {
    return resolveAgentDir(params.agent_id, deps);
  }

  if (!deps.registry) {
    throw new AgentWorkspaceFsError(
      'registry_unavailable',
      'workspace registry is not available for scoped agent workspace read',
    );
  }

  try {
    const workspacePath = deps.registry.resolve(workspaceId);
    return join(workspacePath, '.silverhand', 'agents', params.agent_id);
  } catch (err) {
    if (err instanceof WorkspaceRegistryError) {
      if (err.code === 'not_provisioned') {
        throw new AgentWorkspaceFsError(
          'workspace_not_provisioned',
          `workspace ${workspaceId} is not provisioned; cannot resolve agent workspace`,
        );
      }
      if (err.code === 'registry_foreign' || err.code === 'registry_corrupt') {
        throw new AgentWorkspaceFsError('registry_unavailable', err.message);
      }
    }
    throw new AgentWorkspaceFsError(
      'internal_error',
      err instanceof Error ? err.message : String(err),
    );
  }
}
