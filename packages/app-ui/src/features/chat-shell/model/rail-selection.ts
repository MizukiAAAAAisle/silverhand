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
 * CONVERSATION and nothing else. A container header row is pure chrome (a collapse
 * toggle) and never highlights, so the container rule — and the `RailRowRef` shape it
 * needed — is gone; "which workspace am I in" is answered by which subtree is
 * expanded around the filled row, not by a second highlight.
 *
 * Why the conversation rule lives here (#task:1888): a starred channel MOVED into
 * STARRED, so it renders in a different section from its unstarred peers. Two
 * sections painting "is this the open one?" with their own expressions is exactly the
 * drift this module was created to end — and the acceptance contract is that a
 * channel looks identical before and after the move.
 *
 * This module decides the tier ONLY; the paint lives in `sidebarRowStateClass`
 * (`components/layout/sidebar-shared.tsx`). It used to own a second copy of that
 * paint (`railRowTierClass`, for STARRED) until #task:1957 put both rows on the
 * shared `ConversationRowLayout` — the same split-authority the tier itself exists
 * to prevent.
 */
export type RowSelectionTier = "primary" | "none";

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
    ? "primary"
    : "none";
}
