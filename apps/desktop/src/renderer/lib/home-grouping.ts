/**
 * Home-list projections under the Favorites model (#task:1254, final 2026-07-01).
 *
 * Two DISTINCT star semantics, one predicate (`starred_at`):
 *   - workspace / DM — star MOVES the row out of its home rail group into the
 *     GLOBAL STARRED overlay (Slack "move", not the old additive overlay that
 *     produced shiki's duplicate / drifting-badge bugs). See
 *     `partitionRailWorkspaces`.
 *   - channel — star does NOT leave the workspace: the channel STAYS in its own
 *     channel sidebar and is PINNED to a local `starred` group at the top (a
 *     workspace-nested leaf keeps its parent context; hoisting it into a flat
 *     global peer-group read as weird — shiki dogfood). See
 *     `partitionHomeChannels`. A starred channel NEVER enters global STARRED.
 *
 * Both reduce to: star = "pin in this entity's home surface". The home surface of
 * a workspace/DM is the global rail → global STARRED; the home surface of a
 * channel is its own sidebar → local starred group.
 *
 * SINGLE SOURCE, NO DRIFT: every projection reads each item's `starred_at`, which
 * the composition root (App.tsx) joins onto every item from the SAME
 * `viewer_sort.entries[].starred_at` the backend's reorder validation uses
 * (`SortRepo.listStarredEntityIds`). Display membership and server validation
 * therefore agree by construction — the renderer never joins `GET /api/favorites`
 * or keeps a second starred set.
 *
 * RAW vs HOME: the underlying list query / cache still carries starred entities
 * (Events / Activity and name resolution consume the full visible set). For
 * workspace/DM these projections HIDE the starred ones (they render in STARRED
 * instead) — so "the endpoint returns a starred workspace but the home group
 * doesn't show it" is BY DESIGN. For channels nothing is hidden; the split is
 * only ordering (starred group pinned above unstarred).
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
 * clusters, never nodes) split into a local `starred | unstarred` partition.
 *
 * Unlike workspace/DM, a starred channel is NOT hoisted out — it STAYS in this
 * sidebar, just pinned into the `starred` group above `unstarred`. Both groups
 * are hard sort groups (each its own recent/manual + drag scope, wired in
 * ChannelsSidebar); within a group the viewer's sort mode orders the rows. The
 * input order is preserved within each group, so an upstream sort still holds.
 * Legacy thread fossils (non-null `parent_channel_id`) are dropped from both.
 */
export function partitionHomeChannels<T extends HomeChannelItem>(
  items: readonly T[],
): { starred: T[]; unstarred: T[] } {
  const starred: T[] = [];
  const unstarred: T[] = [];
  for (const c of items) {
    if (c.parent_channel_id !== null) continue;
    if (isStarredAt(c.starred_at)) starred.push(c);
    else unstarred.push(c);
  }
  return { starred, unstarred };
}
