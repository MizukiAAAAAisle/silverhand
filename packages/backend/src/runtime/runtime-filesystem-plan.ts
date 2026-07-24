import type { WorkspaceRegistryBackfillRow } from './workspace-registry-backfill.js';

/**
 * Cross-computer slice 1 (#task:1596) — the PURE planning half of the
 * pre-dispatch runtime filesystem ensure. Only the conversation's ACTIVE
 * workspace is ever ensured before a spawn (#task:1594 final contract;
 * Cindy review round 1 removed the peer pre-spawn backfill entirely —
 * peers resolve-or-degrade daemon-side and same-host legacy migration is
 * owned by the hydrate-time registry audit, not the spawn path):
 *
 * - `primaryRow` — the BLOCKING provision for the active workspace, whose
 *   `id` is also the (only) L2 seed target for the spawning agent (seed is
 *   BLOCKING too, ordered after provision).
 *   Same-host: re-bind with the legacy home `workspace_path` (unchanged
 *   migration behavior). Cross-host guest: `workspace_path: null` so the
 *   daemon self-picks its managed root — the home computer's path never
 *   crosses to a guest daemon.
 *
 * `agent_home` workspaces never produce a row or a seed — the daemon
 * resolves them homedir-side, never via the registry.
 */

export interface EnsurePlanWorkspace {
  id: string;
  workspace_kind: string;
  workspace_host_id: string;
  workspace_path: string;
}

export interface RuntimeStartFilesystemPlan {
  /**
   * The blocking provision row for the active workspace, or `null` when
   * nothing needs ensuring (agent_home / missing row). This row's `id` is
   * also the (only) L2 seed target — one source, no separate field.
   */
  primaryRow: WorkspaceRegistryBackfillRow | null;
}

export function planRuntimeStartFilesystemEnsure(
  hostId: string,
  primary: EnsurePlanWorkspace | undefined,
): RuntimeStartFilesystemPlan {
  if (!primary || primary.workspace_kind !== 'regular') {
    return { primaryRow: null };
  }
  return {
    primaryRow: {
      id: primary.id,
      workspace_path:
        primary.workspace_host_id === hostId ? primary.workspace_path : null,
    },
  };
}
