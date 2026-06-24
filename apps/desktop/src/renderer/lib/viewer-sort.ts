// Adapter between the wire `viewer_sort` DTO (sparse per-entity state) and the
// DTO-agnostic pure sorter in `./list-sort`. Components call `sortGroup` per
// live hard group (channel: starred/unstarred; rail: starred/dm/regular) with
// the viewer's per-SCOPE mode (see `sortModeOf`). Keeping this here lets the
// sorter stay free of the sorter's own `@silverhand/shared` dependency. See
// docs/list-sort-v1.md (#task:1146).
import type { SortGroup, ViewerSortStateDto } from '@silverhand/shared';
import { sortByMode, type ListSortMode, type SortableEntry } from './list-sort';

export type SortEntryLookup = (id: string) => {
  rank: number | null;
  lastAccessedAt: number | null;
};

/** Build a join function over the sparse `entries` — an id absent from the
 *  list joins as both-null (never ranked / never opened). */
export function sortEntryLookup(
  viewerSort: ViewerSortStateDto | undefined,
): SortEntryLookup {
  const map = new Map<string, { rank: number | null; lastAccessedAt: number | null }>();
  for (const e of viewerSort?.entries ?? []) {
    map.set(e.entity_id, { rank: e.rank, lastAccessedAt: e.last_accessed_at });
  }
  return id => map.get(id) ?? { rank: null, lastAccessedAt: null };
}

/** The viewer's mode for one SCOPE of a list. A scope is an independently
 *  toggleable [recent|manual] axis:
 *    - workspace rail : scope = the hard group (`'starred' | 'dm' | 'regular'`).
 *    - channel sidebar: scope = `''` (list-wide) — pass no `group`.
 *  Absent stored mode = the default, `recent`. */
export function sortModeOf(
  viewerSort: ViewerSortStateDto | undefined,
  group?: SortGroup,
): ListSortMode {
  return viewerSort?.modes[group ?? ''] ?? 'recent';
}

/** Sort one already-partitioned live group of domain items by the viewer's
 *  mode, joining each item's sparse per-entity state. `getId` / `getCreatedAt`
 *  adapt the item type (WorkspaceListItem, ChannelListItem, …). */
export function sortGroup<T>(
  items: readonly T[],
  mode: ListSortMode,
  getId: (t: T) => string,
  getCreatedAt: (t: T) => number,
  lookup: SortEntryLookup,
): T[] {
  return sortByMode(
    items,
    mode,
    (item): SortableEntry => {
      const id = getId(item);
      const e = lookup(id);
      return {
        id,
        rank: e.rank,
        lastAccessedAt: e.lastAccessedAt,
        createdAt: getCreatedAt(item),
      };
    },
  );
}
