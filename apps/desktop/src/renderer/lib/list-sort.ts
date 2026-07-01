/**
 * Pure within-group sort for the user-selectable list ordering feature
 * (#task:1146). The renderer partitions a list into its live hard groups
 * (channel sidebar: `starred` / `unstarred`; workspace rail: `dm` / `regular` —
 * star is the global Favorites overlay, NOT a rail group, see #task:1252) and
 * applies this helper to EACH
 * group independently, then concatenates the groups in their fixed order.
 * Star / group membership is therefore NOT this helper's concern — it only
 * orders the items handed to it, by the viewer's chosen sort mode.
 *
 * Two modes (server-persisted per viewer + list, see Alice's #task:1147):
 *  - `recent`  — most recently opened/selected by the viewer floats to the
 *                top (`lastAccessedAt` DESC). NOT "most recent activity" —
 *                another person/agent posting must not reorder my sidebar.
 *  - `manual`  — the viewer's drag order (`rank` ASC).
 *
 * Items with no signal for the active mode (a brand-new channel never
 * opened, or never dragged so `rank` is null) sort AFTER the items that do,
 * by `createdAt` ASC — i.e. they fall back to the app's existing default
 * order (oldest-first) instead of jumping to the top. In manual mode such
 * an item gets a real `rank` the first time it's dragged.
 *
 * Fully deterministic: every comparison ends in a `createdAt` then `id`
 * tiebreak, so the result never depends on the engine's sort stability or
 * on input order.
 */

export type ListSortMode = 'recent' | 'manual';

export interface SortableEntry {
  /** Stable identity — final tiebreak so equal-rank/equal-time items have a
   *  deterministic order. */
  id: string;
  /** Viewer's manual drag rank within this group; null = never ranked. */
  rank: number | null;
  /** Epoch ms the viewer last opened/selected this item; null = never. */
  lastAccessedAt: number | null;
  /** Epoch ms the item was created — stable fallback + tiebreak. */
  createdAt: number;
}

function byCreatedThenId(a: SortableEntry, b: SortableEntry): number {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/** Items with a present signal sort before items missing it (null last). */
function presentFirst(aHas: boolean, bHas: boolean): number | null {
  if (aHas === bHas) return null;
  return aHas ? -1 : 1;
}

function compareRecent(a: SortableEntry, b: SortableEntry): number {
  const presence = presentFirst(a.lastAccessedAt !== null, b.lastAccessedAt !== null);
  if (presence !== null) return presence;
  if (a.lastAccessedAt !== null && b.lastAccessedAt !== null && a.lastAccessedAt !== b.lastAccessedAt) {
    return b.lastAccessedAt - a.lastAccessedAt; // most-recent first
  }
  return byCreatedThenId(a, b);
}

function compareManual(a: SortableEntry, b: SortableEntry): number {
  const presence = presentFirst(a.rank !== null, b.rank !== null);
  if (presence !== null) return presence;
  if (a.rank !== null && b.rank !== null && a.rank !== b.rank) {
    return a.rank - b.rank; // ascending drag order
  }
  return byCreatedThenId(a, b);
}

/** The comparator for a mode, over the normalized `SortableEntry` shape. */
export function modeComparator(
  mode: ListSortMode,
): (a: SortableEntry, b: SortableEntry) => number {
  return mode === 'manual' ? compareManual : compareRecent;
}

/**
 * Sort one already-partitioned group by the viewer's chosen mode. Pure and
 * non-mutating — returns a new array.
 */
export function sortGroupByMode<T extends SortableEntry>(
  items: readonly T[],
  mode: ListSortMode,
): T[] {
  return [...items].sort(modeComparator(mode));
}

/**
 * Same ordering as `sortGroupByMode`, but over arbitrary domain items via a
 * `project` adapter that derives the normalized `SortableEntry` (id +
 * rank/last-accessed joined from the sparse `viewer_sort.entries`, plus the
 * item's `created_at`). This is what the rail / channel components call — the
 * sort logic stays decoupled from the wire DTO shape.
 */
export function sortByMode<T>(
  items: readonly T[],
  mode: ListSortMode,
  project: (item: T) => SortableEntry,
): T[] {
  const compare = modeComparator(mode);
  return [...items].sort((a, b) => compare(project(a), project(b)));
}
