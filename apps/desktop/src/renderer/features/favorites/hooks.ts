// Favorites bounded context — renderer read/write hooks (#task:1253).
// Mirrors `@silverhand/shared` `api/favorites.ts`: the left-rail STARRED section
// promoted to a GLOBAL, viewer-scoped FLAT favorites list of the viewer's starred
// WORKSPACES / DMs — the `user_sort_entry.starred_at` set under
// `list_key='workspaces'` only (#task:1254 final). A starred CHANNEL is NOT here:
// its star pins it locally in its own channel sidebar (`channels:*` starred
// group), never entering this global list.
//
// Storage split (#task:1252 C — do NOT collapse back to "zero storage"):
//   - MEMBERSHIP is a read projection with NO storage of its own — a row is in
//     Favorites iff its home `user_sort_entry.starred_at` is set (single source).
//   - ORDERING *is* stored: the favorites list has its own `list_key='favorites'`
//     rank + mode in `user_sort_entry`, written through the SHARED sort hooks
//     (useSetSortMode / useReorderSort), NOT here.
// So THIS hook owns: fetch (`useFavorites`) + unstar (`useUnstarFavorite`, a
// per-entity star DELETE on the workspace endpoint). It does not own favorites
// ordering writes. Canonical: docs/list-sort-v1.md.
//
// Favorites is EXCLUSIVE, never an additive overlay (#task:1254): a starred
// workspace/DM shows HERE only — it has been MOVED out of its home rail group. So
// unstar invalidates the workspace rail cache not to re-sync a second visible
// copy, but so the entity REAPPEARS in its home group (and the favorites list
// drops it); star does the reverse. Single source is `user_sort_entry.starred_at`.
import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { QueryClient } from '@tanstack/react-query';
import type {
  FavoriteRowDto,
  ListFavoritesDto,
  UnreadUpdatedMessagePayload,
} from '@silverhand/shared';
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

/** S1 viewer-unread ingestor patch (#task:1284, doc §6) — write ONE favorite
 *  row's absolute unread from an enriched `unread_updated` frame. Favorites is a
 *  LIST whose membership (which entities are starred) is orthogonal to unread, so
 *  this is PRESENT-ONLY: it writes `unread_count` on the row whose `workspace_id`
 *  matches (0 is written too — a cleared badge), and is a no-op if the row is
 *  absent or the list is not loaded. It NEVER inserts a row and NEVER refetches
 *  (an unread change can't add/remove a favorite; a fallback refetch would turn a
 *  badge tick back into a whole-list refetch — the exact regression this replaces,
 *  Cindy B3). Idempotent: an unchanged count writes nothing. */
export function patchFavoritesUnread(
  qc: QueryClient,
  payload: UnreadUpdatedMessagePayload,
): 'patched' | 'unchanged' | 'absent' | 'cold' {
  const prev = qc.getQueryData<ListFavoritesDto>(favoritesKey);
  if (!prev) return 'cold'; // list not loaded → no-op
  const idx = prev.items.findIndex(it => it.workspace_id === payload.workspace_id);
  if (idx < 0) return 'absent'; // no such favorite row → no-op (never insert)
  const row = prev.items[idx];
  if (!row) return 'absent'; // unreachable (idx >= 0) — narrows the index access
  if (row.unread_count === payload.workspace_unread_count) {
    return 'unchanged';
  }
  const items = prev.items.slice();
  items[idx] = { ...row, unread_count: payload.workspace_unread_count };
  qc.setQueryData<ListFavoritesDto>(favoritesKey, { ...prev, items });
  return 'patched';
}

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
 * UNREAD liveness (#task:1254): each row carries a server-scored `unread_count`,
 * so the list is an unread-bearing read-model like `useMessageUnreadSummary`. A
 * message-variant `unread_updated` is now patched in place by the central
 * viewer-unread ingestor (#task:1284, via {@link patchFavoritesUnread}) — this
 * hook no longer invalidates on it (that would turn a badge tick back into a
 * whole-list refetch). Only a `snapshot_required` (resume/epoch) still refetches
 * authoritatively; membership still changes only on star/unstar. Unread is
 * server-scored — never derived client-side.
 */
export function useFavorites() {
  const qc = useQueryClient();

  useEffect(() => {
    const sub = subscribeViewerScope();
    const unsub = onWsFrame(frame => {
      if (frame.type !== 'snapshot_required') return;
      if (!isCurrentViewerScope(frame.scope)) return;
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
 * Unstar one favorite from the rail's context menu. STARRED holds workspace/DM
 * rows only (#task:1254), so this always hits the workspace star endpoint
 * (`entity_id` is the path param; the list_key is derived server-side). It is
 * workspace-agnostic — it correctly unstars a favorite whose home workspace is
 * not the one currently open. Invalidates the favorites list plus the workspace
 * rail so the entity REAPPEARS in its home group (exclusive move — it was hidden
 * from home while starred) and the Star/Unstar menu state flips in lockstep.
 */
export function useUnstarFavorite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (item: FavoriteRowDto) => {
      await api<unknown>(apiPaths.workspaceStar(item.entity_id), { method: 'DELETE' });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: favoritesKey });
      // Home-surface star indicators. Key mirrors `features/workspaces/hooks`
      // (`['workspaces']`).
      void qc.invalidateQueries({ queryKey: ['workspaces'] });
    },
    onError: () => {
      toast.error('Failed to unstar, please retry');
    },
  });
}
