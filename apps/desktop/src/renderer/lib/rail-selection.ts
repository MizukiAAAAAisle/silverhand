/**
 * Unified sidebar-row selection tier — the single source of truth for which row is
 * highlighted (#task:1254, re-scoped by #task:1888, narrowed by #task:1889).
 *
 * Before this, three surfaces computed selection independently and DISAGREED for
 * the same entity: the rail workspace row (`id === selectedWorkspaceId`, no channel
 * guard), the STARRED favorites row, and the channel sidebar — producing the double
 * / wrong highlight shiki hit. Every row now goes through THIS module.
 *
 * ONE row species since #task:1889: the merged tree's selection object is the OPEN
 * CONVERSATION and nothing else. A workspace / DM header is pure chrome (a collapse
 * toggle) and never highlights, so the container rule — and the `RailRowRef` shape it
 * needed — is gone; "which workspace am I in" is answered by which subtree is
 * expanded around the filled row, not by a second highlight.
 *
 * Why the conversation rule lives here (#task:1888): a starred channel MOVED into
 * STARRED, so it renders in a different section from its unstarred peers. Two
 * sections painting "is this the open one?" with their own expressions is exactly the
 * drift this module was created to end — and the acceptance contract is that a
 * channel looks identical before and after the move.
 */
export type RowSelectionTier = 'primary' | 'none';

/**
 * A conversation row's tier: `primary` iff it is the open conversation. Keyed on the
 * conversation id ALONE — deliberately not on its parent workspace, so a starred
 * channel in STARRED and the same channel under its container resolve identically
 * (and a channel does not light up merely because its workspace is selected).
 */
export function conversationSelectionTier(
  conversationId: string,
  selectedConversationId: string | null,
): RowSelectionTier {
  return selectedConversationId !== null && conversationId === selectedConversationId
    ? 'primary'
    : 'none';
}

/**
 * The row's visual treatment for a selection tier — the single class vocabulary
 * every sidebar row shares (#task:1254). Binary: exactly one strong highlight, no
 * faint/ambient tier.
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
