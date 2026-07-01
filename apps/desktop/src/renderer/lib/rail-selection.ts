import type { FavoriteKind } from '@silverhand/shared';

/**
 * Unified rail-row selection tier — the single source of truth for which rail
 * row is highlighted (#task:1254, exclusive-Favorites, final model 2026-07-01).
 *
 * Before this, three surfaces computed selection independently and DISAGREED for
 * the same entity: the rail `WorkspaceRow` (`id === selectedWorkspaceId`, no
 * channel guard), the STARRED favorites row, and the channel sidebar — producing
 * the double / wrong highlight shiki hit. Every rail/STARRED row now goes through
 * THIS one function.
 *
 * SCOPE: the rail + the global STARRED overlay hold WORKSPACE / DM rows ONLY. A
 * channel is a workspace-nested leaf — it lives in its own channel sidebar (a
 * separate column) and never appears in the rail or STARRED, so there is never a
 * competing rail row for it. That collapses the rule to its essence:
 *
 *   a workspace/DM row is `primary` iff it is the selected workspace.
 *
 * Opening any channel under the active workspace keeps that workspace `primary`
 * (the "which workspace am I in" cue) while the channel itself highlights in the
 * channel sidebar. Selecting a workspace/DM directly makes it `primary`. Callers
 * pass `selectedWorkspaceId = null` when a top-level view (Activity / Saved /
 * Search / Archived) owns selection, so nothing in the rail highlights then.
 *
 * (History: a prior revision threaded `selectedChannelId` + a tri-state
 * `selectedChannelStarred` to decide whether an open STARRED channel row stole
 * the highlight from its parent workspace. Channels never enter STARRED in the
 * final model, so that whole apparatus is gone.)
 */
export type RowSelectionTier = 'primary' | 'none';

/** Minimal identity a rail/STARRED row needs to resolve its tier. `kind` mirrors
 *  the workspace/DM subset of `FavoriteKind` so a STARRED row and its home-list
 *  twin describe themselves identically. */
export type RailRowRef = {
  kind: Extract<FavoriteKind, 'workspace' | 'dm'>;
  workspaceId: string;
};

export function railSelectionTier(
  row: RailRowRef,
  selectedWorkspaceId: string | null,
): RowSelectionTier {
  return selectedWorkspaceId !== null && row.workspaceId === selectedWorkspaceId
    ? 'primary'
    : 'none';
}

/**
 * The row's visual treatment for a selection tier — the single class vocabulary
 * every rail/STARRED row shares (#task:1254). Binary: exactly one strong
 * highlight, no faint/ambient tier.
 *   - `primary` → solid selected fill + accent border + on-selected text. The
 *     `.text-text-on-selected` class is the hook the per-theme border contract
 *     keys on (`aside[data-sidebar] .sidebar-row-border.text-text-on-selected`
 *     → `--border-row-selected`), so it MUST stay on the primary row only.
 *   - `none` → resting + hover only.
 */
export function railRowTierClass(tier: RowSelectionTier): string {
  return tier === 'primary'
    ? 'border-accent bg-[var(--bg-row-selected,var(--bg-selected))] text-text-on-selected'
    : 'border-transparent text-text-secondary hover:border-accent hover:bg-[var(--bg-row-hover,rgba(255,255,255,0.7))] hover:text-text-primary';
}
