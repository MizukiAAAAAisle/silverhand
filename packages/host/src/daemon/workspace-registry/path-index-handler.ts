import { statSync } from 'node:fs';
import { isAgentHomeWorkspaceId } from '@silverhand/shared';
import type {
  WorkspacePathIndexErrorCode,
  WorkspacePathIndexParams,
  WorkspacePathIndexResult,
} from '../../protocol.js';
import { resolveAgentDir } from '../agent-materialize/index.js';
import { DaemonTypedError } from '../typed-error.js';
import { WorkspaceRegistry, WorkspaceRegistryError } from './registry.js';

export class WorkspacePathIndexError extends DaemonTypedError {
  constructor(
    readonly code: WorkspacePathIndexErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorkspacePathIndexError';
  }
}

export interface IndexWorkspacePathsDeps {
  registry: WorkspaceRegistry;
  /** Parent dir for agent-home resolution. Default: daemon's homedir(). */
  homeDir?: string;
  /** Exact root for agent-home resolution. Takes precedence over homeDir. */
  agentHomeRootDir?: string;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve workspace roots from this daemon's local authority. Missing bindings,
 * missing directories, and malformed agent-home refs degrade per entry; a
 * foreign/corrupt registry fails the whole snapshot.
 */
export async function indexWorkspacePaths(
  params: WorkspacePathIndexParams,
  deps: IndexWorkspacePathsDeps,
): Promise<WorkspacePathIndexResult> {
  const entries: WorkspacePathIndexResult['entries'] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();

  for (const workspace of params.workspaces) {
    if (seen.has(workspace.workspace_id)) continue;
    seen.add(workspace.workspace_id);

    if (workspace.kind === 'agent_home') {
      const agentId = workspace.owner_agent_id;
      if (
        agentId === null ||
        !isAgentHomeWorkspaceId(workspace.workspace_id, agentId)
      ) {
        unresolved.push(workspace.workspace_id);
        continue;
      }
      const path = resolveAgentDir(agentId, deps);
      if (!isDirectory(path)) {
        unresolved.push(workspace.workspace_id);
        continue;
      }
      entries.push({ workspace_id: workspace.workspace_id, path });
      continue;
    }

    let path: string;
    try {
      path = deps.registry.resolve(workspace.workspace_id);
    } catch (err) {
      if (err instanceof WorkspaceRegistryError) {
        if (err.code === 'not_provisioned') {
          unresolved.push(workspace.workspace_id);
          continue;
        }
        if (
          err.code === 'registry_foreign' ||
          err.code === 'registry_corrupt'
        ) {
          throw new WorkspacePathIndexError(
            'registry_unavailable',
            err.message,
          );
        }
      }
      throw new WorkspacePathIndexError(
        'internal_error',
        err instanceof Error ? err.message : String(err),
      );
    }

    if (!isDirectory(path)) {
      unresolved.push(workspace.workspace_id);
      continue;
    }
    entries.push({ workspace_id: workspace.workspace_id, path });
  }

  return { ok: true, entries, unresolved };
}
