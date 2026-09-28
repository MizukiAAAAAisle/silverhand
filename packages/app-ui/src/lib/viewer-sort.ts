// Channel/favorites sorting over their sparse viewer-sort entries.
import type { ViewerSortStateDto } from "@silverhand/shared";
import { sortByMode, type ListSortMode, type SortableEntry } from "./list-sort";

export type SortEntryLookup = (id: string) => {
  rank: number | null;
  lastAccessedAt: number | null;
};

/** Build a join function over the sparse `entries` — an id absent from the
 *  list joins as both-null (never ranked / never opened). */
export function sortEntryLookup(viewerSort: ViewerSortStateDto | undefined): SortEntryLookup {
  const map = new Map<string, { rank: number | null; lastAccessedAt: number | null }>();
  for (const e of viewerSort?.entries ?? []) {
    map.set(e.entity_id, { rank: e.rank, lastAccessedAt: e.last_accessed_at });
  }
  return (id) => map.get(id) ?? { rank: null, lastAccessedAt: null };
}

/** Channel/favorites use one list-wide mode; absent state defaults to recent. */
export function sortModeOf(viewerSort: ViewerSortStateDto | undefined): ListSortMode {
  return viewerSort?.modes[""] ?? "recent";
}

/** Sort one already-partitioned live group of domain items by the viewer's
 *  mode, joining each item's sparse per-entity state. `getId` / `getCreatedAt`
 *  adapt the item type (ChannelListItem, …). */
export function sortGroup<T>(
  items: readonly T[],
  mode: ListSortMode,
  getId: (t: T) => string,
  getCreatedAt: (t: T) => number,
  lookup: SortEntryLookup,
): T[] {
  return sortByMode(items, mode, (item): SortableEntry => {
    const id = getId(item);
    const e = lookup(id);
    return {
      id,
      rank: e.rank,
      lastAccessedAt: e.lastAccessedAt,
      createdAt: getCreatedAt(item),
    };
  });
}
