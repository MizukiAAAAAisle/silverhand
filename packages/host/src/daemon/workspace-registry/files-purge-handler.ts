import { promises as fs } from 'node:fs';
import type {
  AgentFilesPurgeErrorCode,
  AgentFilesPurgeParams,
} from '../../protocol.js';
import { DaemonTypedError } from '../typed-error.js';
import { resolveAgentDir } from '../agent-materialize/handler.js';

/**
 * D4.e-4 daemon handler for `agent_files_purge` — removes an agent's
 * host-local files on the OWNING host. Replaces the backend
 * `DELETE /api/agents/:id` `fs.rm(l1_path / l2_paths)` block (gap G3): the
 * backend forwards only `{ agent_id }`, the daemon resolves the agent home
 * itself — no fs path crosses the wire (I1).
 *
 * Semantics (design §3.3 fail-fast commit boundary; relocation-v1 §3.2 / §7
 * task 4 registry demotion):
 *   - Purge the agent's TERMINAL MANAGED footprint: the agent home tree
 *     (`<agent home>` = L1 + every nested `workspaces/<id>` L2 bundle). One
 *     `rm -rf` of the home removes all of it, so the purge neither enumerates
 *     per-workspace targets nor consults any registry.
 *   - Idempotent: a target already gone (ENOENT) is success, not failure,
 *     and is NOT counted in `purged_count`.
 *   - A HARD fs error (perm/IO/EROFS/ENOSPC) → typed `partial_purge`; the
 *     route then keeps the DB row for retry.
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
  /**
   * The EXACT agents root L1 is computed under, from the composition
   * root. Required — no implicit default (#task:1813).
   */
  agentHomeRootDir: string;
}

/** Filesystem-layer result only; quiescence is composed by dispatcher. */
export interface PurgeAgentFilesResult {
  ok: true;
  purged_count: number;
}

export async function purgeAgentFiles(
  params: AgentFilesPurgeParams,
  deps: PurgeAgentFilesDeps,
): Promise<PurgeAgentFilesResult> {
  // The agent's TERMINAL MANAGED footprint is a single tree: the agent home
  // holds L1 AND every per-workspace L2 bundle, nested at
  // `<home>/workspaces/<workspace_id>` (relocation-v1 §3.2). Removing the home
  // removes all of it, so the purge does not enumerate per-workspace targets
  // or consult any registry — an unbound membership can no longer strand a
  // disjoint managed L2 tree (there is none anymore). The legacy relocation
  // SOURCE (`<workspace>/.silverhand/agents/<id>`, copied+retained by the
  // task-2 migration) is DELIBERATELY not touched — shiki ruled it a permanent
  // orphan even across hard-delete (see the file docblock); it is out of scope
  // by product decision, not an omission. (Registry demotion is §7 task 4.)
  const target = resolveAgentDir(params.agent_id, deps);

  // ENOENT = already gone = success (not counted). A hard fs error fails the
  // WHOLE purge (fail-closed) so the route keeps the DB row for retry rather
  // than orphaning an un-removed tree.
  let purgedCount = 0;
  try {
    const existed = await pathExists(target);
    await fs.rm(target, { recursive: true, force: true });
    if (existed) purgedCount += 1;
  } catch (err) {
    // `force:true` already swallows ENOENT, so any throw here is a hard error;
    // guard ENOENT defensively in case a race removed the dir.
    const code = (err as { code?: unknown })?.code;
    if (code !== 'ENOENT') {
      throw new AgentFilesPurgeError(
        'partial_purge',
        `failed to remove ${target}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    ok: true,
    purged_count: purgedCount,
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
