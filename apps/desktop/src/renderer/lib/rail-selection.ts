import type { FavoriteKind } from '@silverhand/shared';

/**
 * Unified rail-row selection tier — the single source of truth for which rail
 * row is highlighted (#task:1254, exclusive-Favorites pivot 2026-07-01).
 *
 * Before this, three surfaces computed selection independently and DISAGREED for
 * the same entity: the rail `WorkspaceRow` (`id === selectedWorkspaceId`, no
 * channel guard), the STARRED favorites row, and the channel sidebar — producing
 * the double / wrong highlight shiki hit. Every rail/sidebar row now goes through
 * THIS one function.
 *
 * RULE (shiki, refined by Cindy): the current LEAF owns the single rail
 * highlight — "if the leaf has its own row in STARRED, STARRED owns the
 * highlight; otherwise its workspace does".
 *   - open a STARRED channel → that favorite channel row is `primary`; its parent
 *     workspace row is `none` (single selection, no second highlight in the rail).
 *   - open a NON-starred channel → there is no STARRED row for it, so its parent
 *     workspace row is `primary` (keeps the "which workspace am I in" cue while
 *     the channel itself highlights in the channel sidebar, a separate column).
 *   - select a workspace/dm directly (no channel) → that workspace/dm is `primary`.
 * There is no "ambient"/faint tier — the rail shows exactly one strong highlight.
 *
 * `selectedChannelStarred` is whether the open channel is a starred (favorite)
 * channel — derived from the current workspace channel payload's
 * `viewer_sort.entries[].starred_at` (same single source as the home projection),
 * NOT by joining `/api/favorites`. It is TRI-STATE:
 *   - `true`  → the open channel is starred.
 *   - `false` → the open channel is known NOT starred.
 *   - `null`  → a channel is open but its workspace's channel `viewer_sort` is not
 *     in cache yet (cross-workspace nav load window). Treated FAIL-CLOSED: the
 *     workspace row does NOT highlight while unknown, so the STARRED channel row
 *     never briefly shares a highlight with its parent workspace (the transient
 *     double-highlight shiki hit). Once data arrives it settles to true/false.
 *
 * Callers pass selection ids already suppressed to `null` when a top-level view
 * (Activity / Saved / Search / Archived) owns selection, so nothing in the rail
 * highlights then.
 */
export type RowSelectionTier = 'primary' | 'none';

/** Minimal identity a rail/sidebar row needs to resolve its tier. `kind` mirrors
 *  `FavoriteKind` so a STARRED row and its home-list twin describe themselves
 *  identically. For a channel, `workspaceId` is its PARENT workspace. */
export type RailRowRef =
  | { kind: Extract<FavoriteKind, 'workspace' | 'dm'>; workspaceId: string }
  | { kind: Extract<FavoriteKind, 'channel'>; channelId: string | null; workspaceId: string };

export function railSelectionTier(
  row: RailRowRef,
  selectedWorkspaceId: string | null,
  selectedChannelId: string | null,
  selectedChannelStarred: boolean | null,
): RowSelectionTier {
  if (row.kind === 'channel') {
    // A channel row (STARRED or channel sidebar) is primary when it is the open
    // channel — this is the STARRED row that owns the highlight for a starred leaf.
    return row.channelId !== null && row.channelId === selectedChannelId
      ? 'primary'
      : 'none';
  }
  // workspace / dm row: must be the active workspace to highlight at all.
  if (selectedWorkspaceId === null || row.workspaceId !== selectedWorkspaceId) {
    return 'none';
  }
  // The active workspace owns the highlight ONLY when the open leaf is a KNOWN
  // non-starred channel (or no channel). A starred channel (`true`) hands the
  // single highlight to its STARRED row; an unknown-yet channel (`null`, load
  // window) fails closed so the workspace can't double-highlight with a starred
  // leaf mid-navigation. So: highlight iff no channel, else iff known-not-starred.
  return selectedChannelId !== null && selectedChannelStarred !== false
    ? 'none'
    : 'primary';
}

/**
 * The row's visual treatment for a selection tier — the single class vocabulary
 * every rail/sidebar row shares (#task:1254). Binary: the rail shows exactly one
 * strong highlight, no faint/ambient tier.
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
