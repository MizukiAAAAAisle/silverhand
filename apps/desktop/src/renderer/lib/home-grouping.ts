/**
 * Home-list projections under the Favorites model (#task:1254, re-scoped to
 * CONVERSATIONS by #task:1888).
 *
 * One predicate (`starred_at`), two DISTINCT semantics — and #1888 SWAPPED which
 * kind gets which:
 *   - channel / DM channel — star MOVES the row out of its parent's channel list
 *     into the GLOBAL STARRED list (`FavoritesPanel`). Exclusive: the row renders
 *     THERE only, never in both places. See `excludeStarredChannels`.
 *   - workspace / DM container — star does NOT leave the rail. The container STAYS
 *     in its own rail kind group and is merely PINNED to the top of it: ordering,
 *     not membership. A container never enters STARRED. See `pinStarredFirst`.
 *
 * SINGLE SOURCE, NO DRIFT: every projection reads each item's `starred_at`, which
 * the composition root (App.tsx) joins onto every item from the SAME
 * `viewer_sort.entries[].starred_at` the backend's reorder validation uses
 * (`SortRepo.listStarredEntityIds`). Display membership and server validation
 * therefore agree by construction — the renderer never joins `GET /api/favorites`
 * back onto the channel list or keeps a second starred set.
 *
 * Why the asymmetry matters to DRAG, not just to looks: `routes/sort.ts` accepts a
 * whole-group reorder only when `ordered_ids` is EXACTLY the group's live members.
 *   - The channel exclusion must therefore happen BEFORE `useListDragSort` sees the
 *     list, so the submitted set matches the group the server computes.
 *   - The rail pin must NOT change the set — it reorders what the sort hook already
 *     ordered, so the submitted ids stay a permutation of the same group and the
 *     server still validates. Pinning is applied at render, so dropping an
 *     unstarred container above a starred one visibly settles back below it.
 */

/** Whether an item is starred — the one predicate the projections turn on. */
export function isStarredAt(starredAt: number | null | undefined): boolean {
  return starredAt !== null && starredAt !== undefined;
}

interface RailWorkspaceItem {
  kind: 'regular' | 'dm';
  archived?: boolean;
  starred_at?: number | null;
}

/**
 * Partition the rail's workspaces into the home hard groups by KIND. Archived rows
 * are DROPPED, not returned: since #task:1889 the merged tree has no ARCHIVED group
 * at all — the top-level `Archived` page (#task:1890) is the single archive index —
 * so an archived workspace is simply not part of the home tree. Starred containers
 * are NOT excluded (#task:1888): they stay in their kind group and only get pinned
 * at render, so unlike the channel projection this returns the full non-archived
 * set. The input order is preserved within each group, so an upstream sort still
 * holds.
 */
export function partitionRailWorkspaces<T extends RailWorkspaceItem>(
  items: readonly T[],
): { dms: T[]; regular: T[] } {
  const dms: T[] = [];
  const regular: T[] = [];
  for (const w of items) {
    if (w.archived) continue;
    if (w.kind === 'dm') dms.push(w);
    else regular.push(w);
  }
  return { dms, regular };
}

interface StarrableItem {
  starred_at?: number | null;
}

/**
 * Hoist starred items to the front of one already-ordered rail group, preserving
 * relative order on both sides. Ordering only — the set is unchanged, which is what
 * keeps a subsequent whole-group reorder valid (see the module header). Apply AFTER
 * the sort hook, never before: the viewer's sort mode orders within the pin, not
 * across it.
 */
export function pinStarredFirst<T extends StarrableItem>(items: readonly T[]): T[] {
  const pinned: T[] = [];
  const rest: T[] = [];
  for (const it of items) {
    if (isStarredAt(it.starred_at)) pinned.push(it);
    else rest.push(it);
  }
  return pinned.length === 0 ? [...rest] : [...pinned, ...rest];
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
