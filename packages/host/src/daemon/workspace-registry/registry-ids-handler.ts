import type {
  WorkspaceRegistryIdsErrorCode,
  WorkspaceRegistryIdsParams,
  WorkspaceRegistryIdsResult,
} from '../../protocol.js';
import { DaemonTypedError } from '../typed-error.js';
import { WorkspaceRegistry, WorkspaceRegistryError } from './registry.js';

export class WorkspaceRegistryIdsError extends DaemonTypedError {
  constructor(
    readonly code: WorkspaceRegistryIdsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceRegistryIdsError';
  }
}

export interface ListWorkspaceRegistryIdsDeps {
  registry: WorkspaceRegistry;
}

/**
 * #task:1719 — `workspace_registry_ids`: the ready-generation reconcile
 * PULL. Returns every workspace id currently bound in this daemon's
 * registry under its current control-plane binding, and NOTHING else —
 * ids only, never paths (I1: the daemon is the sole path authority; the
 * backend diffs ids against its DB and has no use for local paths).
 *
 * Contract:
 * - Read-only: never mutates the registry, never touches any directory.
 * - An absent/empty registry file is SUCCESS with `[]` — "nothing bound"
 *   is a normal state on a fresh computer, not an error.
 * - A foreign/corrupt registry fails the whole call closed
 *   (`registry_unavailable`) — reporting `[]` for someone else's file
 *   would make the backend treat every real binding as a ghost.
 */
export async function listWorkspaceRegistryIds(
  _params: WorkspaceRegistryIdsParams,
  deps: ListWorkspaceRegistryIdsDeps,
): Promise<WorkspaceRegistryIdsResult> {
  try {
    return {
      ok: true,
      workspace_ids: deps.registry.list().map(entry => entry.workspace_id),
    };
  } catch (err) {
    if (
      err instanceof WorkspaceRegistryError &&
      (err.code === 'registry_foreign' || err.code === 'registry_corrupt')
    ) {
      throw new WorkspaceRegistryIdsError('registry_unavailable', err.message);
    }
    throw new WorkspaceRegistryIdsError(
      'internal_error',
      err instanceof Error ? err.message : String(err),
    );
  }
}
