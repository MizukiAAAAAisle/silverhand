import type {
  WorkspaceUnbindErrorCode,
  WorkspaceUnbindParams,
  WorkspaceUnbindResult,
} from '../../protocol.js';
import { DaemonTypedError } from '../typed-error.js';
import { WorkspaceRegistry, WorkspaceRegistryError } from './registry.js';

export class WorkspaceUnbindError extends DaemonTypedError {
  constructor(
    readonly code: WorkspaceUnbindErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceUnbindError';
  }
}

export interface UnbindWorkspacesDeps {
  registry: WorkspaceRegistry;
}

/**
 * #task:1719 — remove this daemon's registry mappings for backend-deleted
 * workspaces. When the backend deletes a workspace row, the daemon-side
 * `workspace-registry.json` entry becomes a ghost that wrongly participates
 * in path-overlap validation; this handler deletes ONLY that mapping.
 *
 * Contract:
 * - Mapping removal ONLY — never touches any directory or file contents
 *   (zero implicit deletion of user data, #1594).
 * - Idempotent: an id that was never bound / already unbound is SUCCESS,
 *   reported in `absent` — the backend's delete is fire-and-forget
 *   best-effort, so re-dispatch must not error.
 * - True batch (P1-2): the whole request is ONE `registry.unbindMany` —
 *   one load, one removed/absent partition, at most one persist (none when
 *   nothing was removed). Duplicate ids are reported once.
 * - A foreign/corrupt registry fails the whole call closed
 *   (`registry_unavailable`) — we never guess about someone else's file.
 */
export async function unbindWorkspaces(
  params: WorkspaceUnbindParams,
  deps: UnbindWorkspacesDeps,
): Promise<WorkspaceUnbindResult> {
  try {
    const { removed, absent } = deps.registry.unbindMany(params.workspace_ids);
    return { ok: true, removed, absent };
  } catch (err) {
    if (
      err instanceof WorkspaceRegistryError &&
      (err.code === 'registry_foreign' || err.code === 'registry_corrupt')
    ) {
      throw new WorkspaceUnbindError('registry_unavailable', err.message);
    }
    throw new WorkspaceUnbindError(
      'internal_error',
      err instanceof Error ? err.message : String(err),
    );
  }
}
