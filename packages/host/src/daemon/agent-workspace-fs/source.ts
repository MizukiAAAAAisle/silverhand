import { isAgentHomeWorkspaceId } from '@silverhand/shared';
import {
  resolveAgentDir,
  resolveAgentWorkspaceBundleDir,
} from '../agent-materialize/index.js';
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
 * while regular workspace ids resolve to the deterministic agent-centric
 * bundle root (`computers/<cid>/agents/<agent_id>/workspaces/<workspace_id>/`,
 * relocation-v1 §3.2) — the registry is consulted only as the establishment
 * gate (fail-closed when the workspace was never realized here).
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

  // Establishment gate stays with the registry (fail-closed when the
  // workspace was never realized here); the resolved base is now the
  // deterministic agent-centric bundle root, not the registry's old shared
  // path (relocation-v1 §7 task 1; registry demotion is §7 task 4).
  try {
    deps.registry.resolve(workspaceId);
  } catch (err) {
    if (err instanceof WorkspaceRegistryError) {
      if (err.code === 'not_provisioned') {
        throw new AgentWorkspaceFsError(
          'workspace_not_provisioned',
          `workspace ${workspaceId} is not provisioned; cannot resolve agent workspace`,
        );
      }
      if (
        err.code === 'registry_foreign' ||
        err.code === 'registry_corrupt' ||
        // relocation-v1 §7 task 1 — an unsafe id segment is a corrupt/unusable
        // registry entry for this workspace; fail closed rather than let it
        // reach the path resolver.
        err.code === 'invalid_path'
      ) {
        throw new AgentWorkspaceFsError('registry_unavailable', err.message);
      }
    }
    throw new AgentWorkspaceFsError(
      'internal_error',
      err instanceof Error ? err.message : String(err),
    );
  }
  return resolveAgentWorkspaceBundleDir(params.agent_id, workspaceId, deps);
}
