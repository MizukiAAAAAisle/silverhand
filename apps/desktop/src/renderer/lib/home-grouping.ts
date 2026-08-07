/**
 * Home-list projections under the Favorites model (#task:1254, re-scoped to
 * CONVERSATIONS by #task:1888, and to conversations ONLY by #task:1900).
 *
 * `starred_at` now means exactly one thing anywhere in the app: a channel / DM
 * channel star MOVES the row out of its parent's channel list into the GLOBAL
 * STARRED list (`FavoritesPanel`). Exclusive — the row renders THERE only, never in
 * both places. See `excludeStarredChannels`.
 *
 * Containers (workspace / DM) have NO star (shiki, 2026-08-08): their order is
 * `f(mode, rank)` and nothing else, so no projection here ever reads a container's
 * `starred_at`. Why the container reading was retired: docs/app-layout.md §4.5
 * (#task:1900).
 *
 * SINGLE SOURCE, NO DRIFT: every projection reads each item's `starred_at`, which
 * the composition root (App.tsx) joins onto every item from the SAME
 * `viewer_sort.entries[].starred_at` the backend's reorder validation uses
 * (`SortRepo.listStarredEntityIds`). Display membership and server validation
 * therefore agree by construction — the renderer never joins `GET /api/favorites`
 * back onto the channel list or keeps a second starred set.
 *
 * Why this matters to DRAG, not just to looks: `routes/sort.ts` accepts a
 * whole-group reorder only when `ordered_ids` is EXACTLY the group's live members,
 * so the channel exclusion must happen BEFORE `useListDragSort` sees the list.
 */

/** Whether an item is starred — the one predicate the projections turn on. */
export function isStarredAt(starredAt: number | null | undefined): boolean {
  return starredAt !== null && starredAt !== undefined;
}

interface RailWorkspaceItem {
  id: string;
  kind: 'regular' | 'dm';
  archived?: boolean;
}

declare const FAVORITES_WATCH_SCOPE: unique symbol;

/**
 * The STARRED freshness scope, as a NOMINAL type (#task:1889, @Cindy MUST FIX).
 *
 * `FavoritesGroup.watchWorkspaceIds` takes this and nothing else, and the ONLY
 * value of it is `partitionRailWorkspaces().allVisibleIds`. That is the fence:
 * re-deriving the scope from a projection — `homeDms.concat(homeRegular).map(w =>
 * w.id)`, or the favorites rows' own `workspace_id`s — produces a plain
 * `string[]` and fails typecheck at the call site. The earlier claim that this
 * was already unrepresentable was wrong: the shape was structurally identical, so
 * the wrong wiring compiled and every test stayed green (@Cindy proved it by
 * doing exactly that substitution). A brand is what actually makes the two
 * distinguishable.
 *
 * Why the scope must be the raw set: it has to stay armed for a workspace with
 * NOTHING visible in the tree — that is precisely where a hidden star waits, and
 * where a restore arrives. Any projection has already dropped those rows.
 */
export type FavoritesWatchScope = readonly string[] & {
  readonly [FAVORITES_WATCH_SCOPE]: true;
};

/**
 * Partition the rail's workspaces into the home hard groups by KIND. Archived rows
 * are DROPPED, not returned: since #task:1889 the merged tree has no ARCHIVED group
 * at all — the top-level `Archived` page (#task:1890) is the single archive index —
 * so an archived workspace is simply not part of the home tree; everything else is
 * returned. The input order is preserved within each group, so an upstream sort
 * still holds.
 *
 * `allVisibleIds` is the RAW input's id set — every workspace the viewer can see,
 * archived INCLUDED, and deliberately NOT `dms ∪ regular`. It is the scope set for
 * viewer-local projections that must stay armed for a workspace holding nothing
 * visible (STARRED's `useFavorites`, #task:1889): a parent with zero visible rows
 * is exactly the one whose hidden star is waiting to be restored, and an archived
 * parent is exactly where a restore arrives. It is returned from HERE, beside the
 * projections, and typed `FavoritesWatchScope` (above) so a projection-derived
 * substitute cannot reach the consumer.
 */
export function partitionRailWorkspaces<T extends RailWorkspaceItem>(
  items: readonly T[],
): { dms: T[]; regular: T[]; allVisibleIds: FavoritesWatchScope } {
  const dms: T[] = [];
  const regular: T[] = [];
  const allVisibleIds: string[] = [];
  for (const w of items) {
    allVisibleIds.push(w.id);
    if (w.archived) continue;
    if (w.kind === 'dm') dms.push(w);
    else regular.push(w);
  }
  // The one place the brand is minted — it asserts provenance (raw input set),
  // which no runtime check can express.
  return { dms, regular, allVisibleIds: allVisibleIds as unknown as FavoritesWatchScope };
}

interface StarrableItem {
  starred_at?: number | null;
}

/**
 * The channel sidebar's home list: top-level channels (threads are reply clusters,
 * never nodes) MINUS the starred ones, which have moved into global STARRED
 * (#task:1888 — exclusive, so hiding them here is the point, not a bug). One flat
 * group; the pre-#1888 `starred | unstarred` hard split is gone. Must run before
 * `useListDragSort` so the drag group matches the server's live member set.
 */
export function excludeStarredChannels<T extends StarrableItem>(
  items: readonly T[],
): T[] {
  return items.filter(c => !isStarredAt(c.starred_at));
}

/** The open conversation, as the sidebar's containers see it. `starred` is the
 *  SAME fact `excludeStarredChannels` filters on (`user_sort_entry.starred_at`),
 *  reached through STARRED's own list rather than through the parent's channel
 *  query — which is the point: the parent's query is what this decides whether to
 *  mount. Nothing selected → `channelId: null`. */
export interface SelectedConversation {
  channelId: string | null;
  /** The workspace the primary pane is in. */
  workspaceId: string | null;
  /** Whether the open conversation has moved into global STARRED. */
  starred: boolean;
}

/**
 * Does this workspace branch hold the open conversation's ROW — i.e. may a
 * COLLAPSED branch keep that one row on screen, and pay for the three queries that
 * takes (#task:1901, @Cindy MUST FIX)?
 *
 * The criterion is MEMBERSHIP AFTER exclusive-home, not `workspaceId` equality. A
 * starred conversation is no longer a member of its parent's list (#task:1888 —
 * `excludeStarredChannels` drops it) and its row lives in STARRED, so the parent
 * branch has nothing to keep: matching on the parent alone would mount channels /
 * sort / modes / unread only to find no row at the end of it. The row must be kept
 * by exactly the container that actually renders it, which is the same rule that
 * decides where the row IS.
 */
export function branchHoldsSelectedRow(
  workspaceId: string,
  selected: SelectedConversation,
): boolean {
  if (selected.channelId === null || selected.starred) return false;
  return selected.workspaceId === workspaceId;
}
