/**
 * Cross-computer slice 1 (#task:1596) / #task:1612 — the PURE planning
 * half of the pre-dispatch runtime filesystem ensure. Only the
 * conversation's ACTIVE regular workspace ever produces a seed target
 * before a spawn (#task:1594 final contract). The registry is the sole
 * authority (#task:1612): the spawn path performs NO workspace provision
 * and never consults the DB `workspace_path` — a missing registry
 * binding surfaces as the seed's typed `workspace_not_provisioned`, and
 * the spawn stays pending. `agent_home` workspaces never produce a seed
 * target — the daemon resolves them homedir-side, never via the
 * registry.
 */

export interface EnsurePlanWorkspace {
  id: string;
  workspace_kind: string;
}

export interface RuntimeStartFilesystemPlan {
  /** The BLOCKING L2 seed target for the spawning agent, or null when
   *  nothing needs ensuring (agent_home / missing row). */
  seedWorkspaceId: string | null;
}

export function planRuntimeStartFilesystemEnsure(
  primary: EnsurePlanWorkspace | undefined,
): RuntimeStartFilesystemPlan {
  if (!primary || primary.workspace_kind !== 'regular') {
    return { seedWorkspaceId: null };
  }
  return { seedWorkspaceId: primary.id };
}
