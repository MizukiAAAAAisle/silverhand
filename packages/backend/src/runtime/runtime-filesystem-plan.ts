/**
 * Cross-computer slice 1 (#task:1596) / #task:1612 — the PURE planning
 * half of the pre-dispatch runtime filesystem ensure. Only the
 * conversation's ACTIVE regular workspace ever produces a seed target
 * before a spawn (#task:1594 final contract).
 *
 * relocation-v1 §7-4 — the plan names a workspace ID, never a path, and it
 * gates nothing: the daemon resolves the deterministic agent-centric bundle
 * coordinate itself (no registry, no DB `workspace_path`), and the seed the
 * plan schedules is BEST-EFFORT enrichment — a failed or skipped seed still
 * spawns (the session cwd is hard-ensured separately, host-side). `agent_home`
 * workspaces never produce a seed target: their L2 IS L1, already materialized
 * by `agent_materialize`.
 */
import { isAgentHomeWorkspace } from '@silverhand/shared';

export interface EnsurePlanWorkspace {
  id: string;
  /** The container's home agent, or `null` for a regular workspace. The plan asks
   *  "does this container have a home agent AT ALL" — not "is it THIS agent's" —
   *  because a foreign agent's home has no L2 to seed either. */
  owner_agent_id: string | null;
}

export interface RuntimeStartFilesystemPlan {
  /** The best-effort L2 seed target for the spawning agent, or null when
   *  nothing needs seeding (an agent home / missing row). Never a spawn gate. */
  seedWorkspaceId: string | null;
}

export function planRuntimeStartFilesystemEnsure(
  primary: EnsurePlanWorkspace | undefined,
): RuntimeStartFilesystemPlan {
  if (!primary || isAgentHomeWorkspace(primary)) {
    return { seedWorkspaceId: null };
  }
  return { seedWorkspaceId: primary.id };
}
