import type {
  WorkspaceProvisionErrorCode,
  WorkspaceProvisionParams,
  WorkspaceProvisionResult,
} from '../../protocol.js';
import { DaemonTypedError } from '../typed-error.js';
import { WorkspaceRegistry, WorkspaceRegistryError } from './registry.js';
import { initWorkspaceSkeleton } from './workspace-skeleton.js';
import { mapFsErrno } from './fs-errno.js';

/**
 * D4.e-1 daemon handler for `workspace_provision`. Binds a regular
 * workspace into the daemon registry and creates its `.silverhand/`
 * skeleton. ONE operation, two path regimes (A — single intent):
 * - no `requested_path` → daemon self-picks a deterministic managed path;
 * - `requested_path` present → daemon re-validates the caller-proposed
 *   host path (M1 folder picker / sandbox typed path / legacy backfill)
 *   then binds it.
 * The backend dispatches this at workspace-create time and keeps only
 * `workspace_id` (+ caches `bound_workspace_path` into the legacy column).
 */

export class WorkspaceProvisionError extends DaemonTypedError {
  constructor(
    readonly code: WorkspaceProvisionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceProvisionError';
  }
}

export interface ProvisionWorkspaceDeps {
  registry: WorkspaceRegistry;
  /**
   * Optional structured logger (pino-style `warn(obj, msg)`). Used ONLY to
   * warn when compensation (rolling back a half-done registry entry after
   * skeleton failure) itself fails — that path is best-effort and must
   * never mask the original skeleton error, so it cannot throw. Absent in
   * tests that don't assert on the warn.
   */
  logger?: { warn: (obj: unknown, msg?: string) => void };
}

export async function provisionWorkspace(
  params: WorkspaceProvisionParams,
  deps: ProvisionWorkspaceDeps,
): Promise<WorkspaceProvisionResult> {
  if (params.kind === 'agent_home') {
    // agent_home (DM) workspaces are created by `agent_materialize`, which
    // owns the L1 dir. Routing one here is a backend misuse.
    throw new WorkspaceProvisionError(
      'unsupported_kind',
      'agent_home workspaces are materialized via agent_materialize, not workspace_provision',
    );
  }

  let path: string;
  let created: boolean;
  try {
    // `requested_path` absent → daemon-managed default; present → daemon
    // re-validates the caller-proposed path (never trusts the backend).
    ({ path, created } = deps.registry.provision(
      params.workspace_id,
      params.requested_path,
    ));
  } catch (err) {
    // `provision()` validates any requested path AND persists the registry
    // file (mkdir + write + rename), so it can throw a typed path error OR
    // raw fs errno just like skeleton creation — all go through the SAME
    // classifier so a recoverable disk failure during registry write is
    // NOT black-holed into `internal_error` (Cindy P1-1; same gap D4.d
    // closed for agent_materialize).
    throw toProvisionError(err);
  }

  try {
    await initWorkspaceSkeleton(path);
  } catch (err) {
    // Compensation (Cindy P1-1): the registry persisted the id→path mapping
    // BEFORE the skeleton was built, so a skeleton failure (perm/quota/race)
    // would otherwise leave the id stuck pointing at an unusable path — a
    // retry with a corrected path would then hit `path_conflict`. Roll the
    // mapping back, but ONLY when we just created it (an idempotent
    // re-provision of an already-bound id must not be torn down). This is
    // best-effort: a failed rollback must NEVER overwrite the original
    // skeleton error, so swallow it and only warn.
    if (created) {
      try {
        deps.registry.remove(params.workspace_id, path);
      } catch (removeErr) {
        deps.logger?.warn(
          {
            workspace_id: params.workspace_id,
            path,
            error:
              removeErr instanceof Error ? removeErr.message : String(removeErr),
          },
          'workspace_provision: failed to roll back registry entry after skeleton failure',
        );
      }
    }
    throw toProvisionError(err);
  }

  return { ok: true, provisioned: created, bound_workspace_path: path };
}

/**
 * Single error → typed code projection for the provision path. One table
 * for the registry/validation stage and the skeleton stage:
 *   - foreign/corrupt registry        → registry_unavailable
 *   - invalid_path (bad requested path)→ invalid_path
 *   - path_conflict (id/path binding)  → path_conflict
 *   - ENOSPC / EDQUOT                  → fs_quota_exceeded
 *   - EACCES / EPERM / EROFS / ENOENT  → fs_unavailable
 *   - everything else                 → internal_error
 * `ENOENT` is folded into `fs_unavailable` because the only way it
 * surfaces here is a parent-dir race (the managed root is created
 * `recursive` immediately before), i.e. a transient fs condition the
 * route layer can retry, not a logic bug.
 */
function toProvisionError(err: unknown): WorkspaceProvisionError {
  if (err instanceof WorkspaceProvisionError) return err;
  if (err instanceof WorkspaceRegistryError) {
    if (err.code === 'registry_foreign' || err.code === 'registry_corrupt') {
      return new WorkspaceProvisionError('registry_unavailable', err.message);
    }
    // invalid_path / path_conflict are first-class provision codes now that
    // a caller may propose a path (A — single intent).
    if (err.code === 'invalid_path' || err.code === 'path_conflict') {
      return new WorkspaceProvisionError(err.code, err.message);
    }
    // not_provisioned cannot arise on the provision() path; treat as an
    // internal invariant breach.
    return new WorkspaceProvisionError('internal_error', err.message);
  }
  const fsCode = mapFsErrno(err);
  if (fsCode) {
    return new WorkspaceProvisionError(fsCode, (err as Error).message);
  }
  return new WorkspaceProvisionError(
    'internal_error',
    err instanceof Error ? err.message : String(err),
  );
}
