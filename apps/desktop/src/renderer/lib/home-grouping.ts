/**
 * Home-list projections under the EXCLUSIVE Favorites model (#task:1254).
 *
 * A starred entity lives ONLY in the global STARRED overlay — it is REMOVED from
 * its home group (the rail DM / WORKSPACES groups, the channel sidebar). This is
 * the Slack "move", not the old additive overlay where the same entity appeared
 * in both places (which produced shiki's duplicate / drifting-badge bugs).
 *
 * SINGLE SOURCE, NO DRIFT: the exclusion reads each item's `starred_at`, which
 * the composition root (App.tsx) joins onto every item from the SAME
 * `viewer_sort.entries[].starred_at` the backend's reorder validation uses
 * (`SortRepo.listStarredEntityIds`). Display membership and server validation
 * therefore agree by construction — the renderer never joins `GET /api/favorites`
 * or keeps a second starred set.
 *
 * RAW vs HOME: the underlying list query / cache still carries starred entities
 * (Events / Activity and name resolution consume the full visible set). Only
 * these projections hide them — so "the endpoint returns a starred row but the
 * home group doesn't show it" is BY DESIGN, not a bug.
 */

/** Whether an item is starred — the one predicate the exclusion turns on. */
export function isStarredAt(starredAt: number | null | undefined): boolean {
  return starredAt !== null && starredAt !== undefined;
}

interface RailWorkspaceItem {
  kind: 'regular' | 'dm';
  archived?: boolean;
  starred_at?: number | null;
}

/**
 * Partition the rail's workspaces into the home hard groups by KIND, excluding
 * starred (non-archived) entities — those render only in STARRED. Archived takes
 * precedence (archived workspaces are never starrable, but the ordering keeps the
 * Archived group authoritative regardless). The input order is preserved within
 * each group, so an upstream sort still holds.
 */
export function partitionRailWorkspaces<T extends RailWorkspaceItem>(
  items: readonly T[],
): { dms: T[]; regular: T[]; archived: T[] } {
  const dms: T[] = [];
  const regular: T[] = [];
  const archived: T[] = [];
  for (const w of items) {
    if (w.archived) {
      archived.push(w);
      continue;
    }
    // Exclusive: a starred workspace/DM is hoisted into STARRED, gone from home.
    if (isStarredAt(w.starred_at)) continue;
    if (w.kind === 'dm') dms.push(w);
    else regular.push(w);
  }
  return { dms, regular, archived };
}

interface HomeChannelItem {
  parent_channel_id: string | null;
  starred_at: number | null;
}

/**
 * The channel sidebar's home list: top-level channels (threads are reply
 * clusters, never nodes) with starred channels excluded — a starred channel
 * renders only in STARRED. This is the single group that feeds the sortable
 * list, so the reorder `ordered_ids` it produces inherently contain no starred
 * id (the backend rejects starred ids with a 400). The old `starred` hard
 * sub-group is gone (`legalGroups('channels:*') = ['unstarred']`).
 */
export function homeChannels<T extends HomeChannelItem>(items: readonly T[]): T[] {
  return items.filter(c => c.parent_channel_id === null && !isStarredAt(c.starred_at));
}
