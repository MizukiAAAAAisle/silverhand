import { promises as fs } from 'node:fs';
import type {
  AgentFilesPurgeErrorCode,
  AgentFilesPurgeParams,
  AgentFilesPurgeResult,
} from '../../protocol.js';
import { DaemonTypedError } from '../typed-error.js';
import {
  resolveAgentDir,
  resolveAgentWorkspaceBundleDir,
} from '../agent-materialize/handler.js';
import { WorkspaceRegistry, WorkspaceRegistryError } from './registry.js';

/**
 * D4.e-4 daemon handler for `agent_files_purge` — removes an agent's
 * host-local files on the OWNING host. Replaces the backend
 * `DELETE /api/agents/:id` `fs.rm(l1_path / l2_paths)` block (gap G3): the
 * backend forwards only `{ agent_id, scope, workspace_ids }`, the daemon
 * resolves L1 (its agent home) and each L2 (the deterministic bundle root)
 * itself — no fs path crosses the wire (I1).
 *
 * Semantics (design §3.3 fail-fast commit boundary; relocation-v1 §3.2):
 *   - `scope:'all'` → purge the agent's TERMINAL MANAGED footprint: the agent
 *     home tree (`<agent home>` = L1 + every nested `workspaces/<id>` L2
 *     bundle). One `rm -rf` of the home removes all of it, so `workspace_ids`
 *     is not needed to enumerate managed L2 and the registry is NOT consulted
 *     for it.
 *   - `scope:'l2'`  → purge only the listed workspaces' L2 bundles (L1 and
 *     unlisted workspaces untouched).
 *   - Idempotent: a target already gone (ENOENT) is success, not failure,
 *     and is NOT counted in `purged_count`.
 *   - A HARD fs error on ANY target (perm/IO/EROFS/ENOSPC) → typed
 *     `partial_purge`; the route then keeps the DB row for retry.
 *   - Under `scope:'l2'` a workspace with no registry binding has no daemon-
 *     managed L2 dir to purge → counted in `skipped_unprovisioned`, never
 *     silently dropped; whole-registry failure (foreign/corrupt) →
 *     `registry_unavailable`.
 *
 * LEGACY RELOCATION SOURCE IS DELIBERATELY OUT OF SCOPE — PRODUCT-DECIDED
 * (shiki, relocation-v1). The task-2 migration COPIES each old disjoint
 * `<workspace>/.silverhand/agents/<agent_id>` L2 into the new bundle and
 * RETAINS the source (terminal, inert). shiki has ruled that this retained
 * source is PERMANENTLY kept as an orphan even across a user hard-delete of
 * the agent: Silverhand never touches it again. So `scope:'all'` cleaning ONLY
 * the terminal managed footprint (new agent home) is intentional and complete
 * for what Silverhand manages — it is NOT the agent's entire on-disk footprint,
 * and the surviving legacy L2 is a sanctioned data-retention outcome, NOT a
 * cleanup gap. Do not "fix" it by re-adding deletion of the legacy source.
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
    // The agent's TERMINAL MANAGED footprint is a single tree: the agent home
    // holds L1 AND every per-workspace L2 bundle, nested at
    // `<home>/workspaces/<workspace_id>` (relocation-v1 §3.2). Removing the
    // home removes all of it, so `scope:'all'` does not enumerate per-workspace
    // targets or consult the registry: an unbound membership can no longer
    // strand a disjoint managed L2 tree (there is none anymore), so the pre-
    // relocation per-workspace establishment gate would only spuriously fail-
    // close a delete whose managed cleanup already fully succeeded.
    // `workspace_ids` is ignored for `scope:'all'` and `skipped_unprovisioned`
    // stays 0. The legacy relocation SOURCE (`<workspace>/.silverhand/agents/
    // <id>`, copied+retained by the task-2 migration) is DELIBERATELY not
    // touched — shiki ruled it a permanent orphan even across hard-delete (see
    // the file docblock); it is out of scope by product decision, not an
    // omission. (Registry demotion overall is §7 task 4.)
    targets.push(resolveAgentDir(params.agent_id, deps));
  } else {
    // `scope:'l2'` — remove only the listed workspaces' L2 bundles, keeping L1
    // and every unlisted workspace. The registry stays the establishment gate
    // for task 1 (an unbound id → nothing daemon-managed → counted in
    // `skipped_unprovisioned`, never silently dropped); the L2 target is the
    // deterministic agent-centric bundle root (relocation-v1 §7 task 1;
    // registry demotion is §7 task 4).
    for (const workspaceId of params.workspace_ids) {
      try {
        deps.registry.resolve(workspaceId);
      } catch (err) {
        if (err instanceof WorkspaceRegistryError) {
          if (err.code === 'not_provisioned') {
            // No daemon-managed L2 dir for this workspace — nothing to purge.
            // Reported (not silently dropped) so the route can log it.
            skippedUnprovisioned += 1;
            continue;
          }
          if (
            err.code === 'registry_foreign' ||
            err.code === 'registry_corrupt' ||
            // relocation-v1 §7 task 1 — an unsafe id segment is a
            // corrupt/unusable registry entry; map it to the same
            // registry_unavailable as the other consumers (l2-seed / index /
            // agent-workspace-fs) rather than letting it fall to internal_error.
            err.code === 'invalid_path'
          ) {
            throw new AgentFilesPurgeError('registry_unavailable', err.message);
          }
        }
        throw new AgentFilesPurgeError(
          'internal_error',
          err instanceof Error ? err.message : String(err),
        );
      }
      targets.push(
        resolveAgentWorkspaceBundleDir(params.agent_id, workspaceId, deps),
      );
    }
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
