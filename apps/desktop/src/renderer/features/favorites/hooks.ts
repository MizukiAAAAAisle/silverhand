// Favorites bounded context — renderer read/write hooks (#task:1253).
// Mirrors `@silverhand/shared` `api/favorites.ts`: the left-rail STARRED section
// promoted to a GLOBAL, viewer-scoped FLAT favorites list that UNIONs the
// viewer's `user_sort_entry.starred_at` across every list_key (the workspace
// rail + every workspace's channel sidebar).
//
// Storage split (#task:1252 C — do NOT collapse back to "zero storage"):
//   - MEMBERSHIP is a read projection with NO storage of its own — a row is in
//     Favorites iff its home `user_sort_entry.starred_at` is set (single source).
//   - ORDERING *is* stored: the favorites list has its own `list_key='favorites'`
//     rank + mode in `user_sort_entry`, written through the SHARED sort hooks
//     (useSetSortMode / useReorderSort), NOT here.
// So THIS hook owns: fetch (`useFavorites`) + unstar (`useUnstarFavorite`, a
// per-entity star DELETE). It does not own favorites ordering writes.
// Canonical: docs/list-sort-v1.md.
//
// Favorites is EXCLUSIVE, never an additive overlay (#task:1254): a starred
// entity shows HERE only — it has been MOVED out of its home list. So unstar
// invalidates the home caches not to re-sync a second visible copy, but so the
// entity REAPPEARS in its home group (and the favorites list drops it); star
// does the reverse. Single source of truth is `user_sort_entry.starred_at`.
import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { FavoriteRowDto, ListFavoritesDto } from '@silverhand/shared';
import { apiPaths } from '@silverhand/shared';
import { api } from '@/lib/api';
import {
  isCurrentViewerScope,
  onWsFrame,
  subscribeViewerScope,
} from '@/lib/ws-client';

/** Query key for the viewer's global favorites list. One cache entry (the list
 *  is global, like Activity); `['favorites']` is its prefix for broad
 *  invalidation from the star mutations. */
export const favoritesKey = ['favorites', 'all'] as const;

/**
 * The viewer's GLOBAL favorites (`GET /api/favorites`, no workspace filter).
 * Returns `{ items, viewer_sort }`: rows fully access/archive filtered (the
 * membership contract lives in the shared DTO doc) with every display field
 * server-resolved — the renderer does ZERO local workspace/agent-cache join —
 * plus the favorites ordering state (`list_key='favorites'`). The server does
 * NOT pre-sort authoritatively; the consumer composes the live order from
 * `viewer_sort` via `useListDragSort` (recent → home `last_accessed_at`, manual
 * → `rank`), exactly like the rail / channel sidebar (#task:1254).
 *
 * Freshness: the list's MEMBERSHIP changes only on star/unstar, so the star
 * mutations (here + `features/workspaces`) invalidate `['favorites']`. Order
 * changes (reorder / mode) reconcile via the sort mutations' own cache writes.
 * Archive / access changes are rarer and reconcile on the next refetch (window
 * focus / remount), which is acceptable for a v1 navigation list.
 *
 * UNREAD liveness (#task:1254): each row now carries a server-scored
 * `unread_count`, so the list is an unread-bearing read-model like
 * `useMessageUnreadSummary` — it MUST refresh on the viewer-scoped
 * `unread_updated` / `snapshot_required` WS signals, else the badge renders once
 * and goes stale (a message arriving or being read wouldn't move it). We
 * invalidate on ANY viewer-scoped `unread_updated` rather than filtering to the
 * message sub-type: over-invalidation is at worst one extra refetch of a single
 * cheap global query, and it keeps the favorites context from importing another
 * module's private payload guard. Unread is server-scored — never derived
 * client-side — so this is the only correct freshness path (same as the rail).
 */
export function useFavorites() {
  const qc = useQueryClient();

  useEffect(() => {
    const sub = subscribeViewerScope();
    const unsub = onWsFrame(frame => {
      if (frame.type === 'snapshot_required') {
        if (!isCurrentViewerScope(frame.scope)) return;
        void qc.invalidateQueries({ queryKey: favoritesKey });
        return;
      }
      if (frame.type !== 'event') return;
      if (!isCurrentViewerScope(frame.scope)) return;
      if (frame.kind !== 'unread_updated') return;
      void qc.invalidateQueries({ queryKey: favoritesKey });
    });
    return () => {
      sub.unsubscribe();
      unsub();
    };
  }, [qc]);

  return useQuery<ListFavoritesDto>({
    queryKey: favoritesKey,
    queryFn: ({ signal }) => api<ListFavoritesDto>(apiPaths.favorites, { signal }),
  });
}

/**
 * Unstar one favorite from the rail's context menu. `kind` selects the
 * per-entity star endpoint (`entity_id` is the path param; the list_key is
 * derived server-side), so this is workspace-agnostic — it correctly unstars a
 * favorite channel that lives in a workspace other than the one currently open,
 * which a workspace-scoped `useStarChannel` could not. Invalidates the favorites
 * list plus the home surfaces (rail / channel sidebar) so the entity REAPPEARS in
 * its home group (exclusive move — it was hidden from home while starred) and the
 * Star/Unstar menu state flips in lockstep.
 */
export function useUnstarFavorite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (item: FavoriteRowDto) => {
      const path =
        item.kind === 'channel'
          ? apiPaths.channelStar(item.entity_id)
          : apiPaths.workspaceStar(item.entity_id);
      await api<unknown>(path, { method: 'DELETE' });
    },
    onSuccess: (_res, item) => {
      void qc.invalidateQueries({ queryKey: favoritesKey });
      // Home-surface star indicators. Keys mirror `features/workspaces/hooks`
      // (`['workspaces']` / `['workspaces', id, 'channels']`).
      void qc.invalidateQueries({ queryKey: ['workspaces'] });
      if (item.kind === 'channel') {
        void qc.invalidateQueries({
          queryKey: ['workspaces', item.workspace_id, 'channels'],
        });
      }
    },
    onError: () => {
      toast.error('Failed to unstar, please retry');
    },
  });
}
