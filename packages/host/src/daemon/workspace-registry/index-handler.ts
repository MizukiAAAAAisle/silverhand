import { join } from 'node:path';
import { isAgentHomeWorkspaceId } from '@silverhand/shared';
import type {
  AgentWorkspaceIndexErrorCode,
  AgentWorkspaceIndexParams,
  AgentWorkspaceIndexResult,
} from '../../protocol.js';
import { DaemonTypedError } from '../typed-error.js';
import { resolveAgentDir } from '../agent-materialize/index.js';
import { WorkspaceRegistry, WorkspaceRegistryError } from './registry.js';

/**
 * D4.e-1 daemon handler for `agent_workspace_index` — the route-time
 * `agent_dir` resolver (design §3.4). `list_workspaces` stays a backend
 * route that does ACL/DB list, then dispatches this to stamp each
 * `agent_dir` daemon-side, so the backend never assembles a path from
 * `workspace_path`.
 *
 * agent-home detection is structural (the pinned `wsah_<agent_id>`
 * convention, via the shared `isAgentHomeWorkspaceId` single source) — so
 * the backend sends only `{ agent_id, workspace_ids }`: no path AND no
 * kind crosses from the backend.
 */

export class AgentWorkspaceIndexError extends DaemonTypedError {
  constructor(
    readonly code: AgentWorkspaceIndexErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AgentWorkspaceIndexError';
  }
}

export interface IndexAgentWorkspacesDeps {
  registry: WorkspaceRegistry;
  /** Parent dir for agent-home resolution. Default: daemon's homedir(). */
  homeDir?: string;
  /** Exact root for agent-home resolution. Takes precedence over homeDir. */
  agentHomeRootDir?: string;
}

export async function indexAgentWorkspaces(
  params: AgentWorkspaceIndexParams,
  deps: IndexAgentWorkspacesDeps,
): Promise<AgentWorkspaceIndexResult> {
  const entries: AgentWorkspaceIndexResult['entries'] = [];
  const unresolved: string[] = [];

  for (const workspaceId of params.workspace_ids) {
    // Agent-home (DM): the L1 dir, derived from the daemon's own homedir
    // — never in the registry. Structural match on the canonical id.
    if (isAgentHomeWorkspaceId(workspaceId, params.agent_id)) {
      entries.push({
        workspace_id: workspaceId,
        agent_dir: resolveAgentDir(params.agent_id, deps),
      });
      continue;
    }

    // Regular workspace: resolve via the registry (fail-closed).
    let workspacePath: string;
    try {
      workspacePath = deps.registry.resolve(workspaceId);
    } catch (err) {
      if (err instanceof WorkspaceRegistryError) {
        if (err.code === 'not_provisioned') {
          // Read fail-closed: neither provisioned nor adopted. Surface as
          // unresolved; the backend MUST NOT fall back to a
          // workspace_path-derived path (would re-pierce I1).
          unresolved.push(workspaceId);
          continue;
        }
        if (err.code === 'registry_foreign' ||
        err.code === 'registry_corrupt' ||
        err.code === 'migration_blocked') {
          // Whole-registry failure → fail the call (typed).
          throw new AgentWorkspaceIndexError('registry_unavailable', err.message);
        }
      }
      throw new AgentWorkspaceIndexError(
        'internal_error',
        err instanceof Error ? err.message : String(err),
      );
    }

    entries.push({
      workspace_id: workspaceId,
      agent_dir: join(workspacePath, '.silverhand', 'agents', params.agent_id),
    });
  }

  return { ok: true, entries, unresolved };
}
