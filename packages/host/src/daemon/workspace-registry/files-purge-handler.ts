import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type {
  AgentFilesPurgeErrorCode,
  AgentFilesPurgeParams,
  AgentFilesPurgeResult,
} from '../../protocol.js';
import { DaemonTypedError } from '../typed-error.js';
import { resolveAgentDir } from '../agent-materialize/handler.js';
import { WorkspaceRegistry, WorkspaceRegistryError } from './registry.js';

/**
 * D4.e-4 daemon handler for `agent_files_purge` — removes an agent's
 * host-local files on the OWNING host. Replaces the backend
 * `DELETE /api/agents/:id` `fs.rm(l1_path / l2_paths)` block (gap G3): the
 * backend forwards only `{ agent_id, scope, workspace_ids }`, the daemon
 * resolves L1 (its homedir) and each L2 (workspace path from the registry)
 * itself — no fs path crosses the wire (I1).
 *
 * Semantics (design §3.3 fail-fast commit boundary):
 *   - `scope:'all'` → purge L1 (`<home>/.silverhand/agents/<agent_id>`) AND
 *     each listed workspace's L2 (`<workspace>/.silverhand/agents/<agent_id>`).
 *   - `scope:'l2'`  → purge only the listed L2 (L1 untouched).
 *   - Idempotent: a target already gone (ENOENT) is success, not failure,
 *     and is NOT counted in `purged_count`.
 *   - A HARD fs error on ANY target (perm/IO/EROFS/ENOSPC) → typed
 *     `partial_purge`; the route then keeps the DB row for retry.
 *   - A workspace with no registry binding has no daemon-managed L2 dir to
 *     purge → counted in `skipped_unprovisioned`, never silently dropped.
 *   - Whole-registry failure (foreign/corrupt) → `registry_unavailable`
 *     (cannot safely resolve any L2 path).
 */

export class AgentFilesPurgeError extends DaemonTypedError {
  constructor(
    readonly code: AgentFilesPurgeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AgentFilesPurgeError';
  }
}

export interface PurgeAgentFilesDeps {
  registry: WorkspaceRegistry;
  /** Parent dir L1 is computed under. Production: `~`. Tests: tmp dir. */
  homeDir?: string;
  /** Exact root L1 is computed under. Takes precedence over homeDir. */
  agentHomeRootDir?: string;
}

export async function purgeAgentFiles(
  params: AgentFilesPurgeParams,
  deps: PurgeAgentFilesDeps,
): Promise<AgentFilesPurgeResult> {
  // 1. Resolve every target path up front (fail-closed on a whole-registry
  //    failure) so a registry problem blocks the purge BEFORE any rm runs.
  const targets: string[] = [];
  let skippedUnprovisioned = 0;

  if (params.scope === 'all') {
    targets.push(resolveAgentDir(params.agent_id, deps));
  }

  for (const workspaceId of params.workspace_ids) {
    let workspacePath: string;
    try {
      workspacePath = deps.registry.resolve(workspaceId);
    } catch (err) {
      if (err instanceof WorkspaceRegistryError) {
        if (err.code === 'not_provisioned') {
          // No daemon-managed L2 dir for this workspace — nothing to purge.
          // Reported (not silently dropped) so the route can log it.
          skippedUnprovisioned += 1;
          continue;
        }
        if (err.code === 'registry_foreign' || err.code === 'registry_corrupt') {
          throw new AgentFilesPurgeError('registry_unavailable', err.message);
        }
      }
      throw new AgentFilesPurgeError(
        'internal_error',
        err instanceof Error ? err.message : String(err),
      );
    }
    targets.push(join(workspacePath, '.silverhand', 'agents', params.agent_id));
  }

  // 2. Remove every resolved target. ENOENT = already gone = success (not
  //    counted). A hard fs error is collected so a partial failure fails the
  //    WHOLE purge (fail-closed) rather than being swallowed per-path.
  let purgedCount = 0;
  const hardFailures: string[] = [];
  for (const target of targets) {
    try {
      const existed = await pathExists(target);
      await fs.rm(target, { recursive: true, force: true });
      if (existed) purgedCount += 1;
    } catch (err) {
      const code = (err as { code?: unknown })?.code;
      // `force:true` already swallows ENOENT, so any throw here is a hard
      // error; guard ENOENT defensively in case a race removed the dir.
      if (code === 'ENOENT') continue;
      hardFailures.push(
        `${target}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (hardFailures.length > 0) {
    throw new AgentFilesPurgeError(
      'partial_purge',
      `failed to remove ${hardFailures.length} target(s): ${hardFailures.join('; ')}`,
    );
  }

  return {
    ok: true,
    purged_count: purgedCount,
    skipped_unprovisioned: skippedUnprovisioned,
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}
