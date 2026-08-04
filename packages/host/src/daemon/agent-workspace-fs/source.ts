import { isAgentHomeWorkspaceId } from '@silverhand/shared';
import {
  resolveAgentDir,
  resolveAgentWorkspaceBundleDir,
} from '../agent-materialize/index.js';
import { WorkspaceIdSegmentError } from '../workspace-path-authority.js';
import { AgentWorkspaceFsError } from './error.js';

export interface ResolveAgentWorkspaceBaseDeps {
  /** Parent dir for agent-home resolution. Default: daemon's homedir. */
  homeDir?: string;
  /** Exact root for agent-home resolution. Takes precedence over homeDir. */
  agentHomeRootDir?: string;
}

/**
 * Resolve the semantic agent workspace source to a host-local base dir.
 *
 * Omitted `workspace_id` preserves the original #task:811 meaning: the agent
 * home/L1 dir. Present `workspace_id` means "the agent's memory dir for this
 * workspace"; agent-home/DM ids intentionally resolve to the same home dir,
 * while regular workspace ids resolve to the deterministic agent-centric
 * bundle root (`computers/<cid>/agents/<agent_id>/workspaces/<workspace_id>/`,
 * relocation-v1 §3.2/§3.4).
 *
 * relocation-v1 §7 task 4 (registry demotion): resolution is PURELY by the
 * deterministic (computer, agent, workspace) coordinate — the registry is no
 * longer a runtime establishment gate. A regular workspace whose bundle has
 * not yet been materialized (its member agent has never spawned there) is NOT
 * fail-closed here: the coordinate is always computable, and a not-yet-present
 * bundle surfaces as an ordinary filesystem absence (`not_found`) downstream,
 * never a `workspace_not_provisioned` refusal. The sole surviving registry
 * reader is the marker-absent startup preflight, which reads the registry file
 * directly and never dispatches through this data-plane resolver.
 *
 * The backend must already have done authz/membership gates. This helper is
 * intentionally path-only and still never accepts a server-supplied path.
 */
export function resolveAgentWorkspaceBaseDir(
  params: { agent_id: string; workspace_id?: string },
  deps: ResolveAgentWorkspaceBaseDeps = {},
): string {
  const workspaceId = params.workspace_id;
  if (!workspaceId || isAgentHomeWorkspaceId(workspaceId, params.agent_id)) {
    return resolveAgentDir(params.agent_id, deps);
  }

  // Deterministic agent-centric bundle root; NO registry lookup. The only
  // failure mode is an unsafe id segment — a path-traversal guard baked into
  // `resolveAgentWorkspaceBundleDir`, not an establishment gate — which we keep
  // fail-closed as `forbidden_path` rather than let it leak as internal_error.
  try {
    return resolveAgentWorkspaceBundleDir(params.agent_id, workspaceId, deps);
  } catch (err) {
    if (err instanceof WorkspaceIdSegmentError) {
      throw new AgentWorkspaceFsError('forbidden_path', err.message);
    }
    throw err;
  }
}
