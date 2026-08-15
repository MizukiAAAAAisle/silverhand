// Favorites bounded context — renderer read/write hooks (#task:1253, re-scoped
// to CONVERSATIONS by #task:1888). Mirrors `@silverhand/shared` `api/favorites.ts`:
// the sidebar's STARRED section as a GLOBAL, viewer-scoped FLAT list of the
// viewer's starred conversations — open- or fixed-roster, the
// `user_sort_entry.starred_at` set under `list_key='channels:<ws_id>'`. A
// WORKSPACE / DM container cannot be here because containers have no star at all
// (#task:1900) — star is a conversation-only action, and its one meaning is
// membership of this list.
//
// Storage split (#task:1252 C — do NOT collapse back to "zero storage"):
//   - MEMBERSHIP is a read projection with NO storage of its own — a row is in
//     Favorites iff its home `user_sort_entry.starred_at` is set (single source).
//   - ORDERING *is* stored: the favorites list has its own `list_key='favorites'`
//     rank + mode in `user_sort_entry`, written through the SHARED sort hooks
//     (useSetSortMode / useReorderSort), NOT here.
// So THIS hook owns: fetch (`useFavorites`) + unstar (`useUnstarFavorite`, a
// per-conversation star DELETE on the channel endpoint). It does not own favorites
// ordering writes. Canonical: docs/list-sort-v1.md.
//
// Favorites is EXCLUSIVE, never an additive overlay (#task:1254): a starred
// conversation shows HERE only — it has been MOVED out of its parent's children.
// So unstar invalidates the workspace/channel caches not to re-sync a second
// visible copy, but so the conversation REAPPEARS under its parent (and the
// favorites list drops it); star does the reverse. Single source is
// `user_sort_entry.starred_at`.
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
import type { FavoritesWatchScope, StarMembership } from '@/lib/home-grouping';
import {
  isCurrentViewerScope,
  onWsFrame,
  subscribeViewerScope,
  subscribeWsScope,
} from '@/lib/ws-client';

/** Query key for the viewer's global favorites list. One cache entry (the list
 *  is global, like Activity); `['favorites']` is its prefix for broad
 *  invalidation from the star mutations. */
export const favoritesKey = ['favorites', 'all'] as const;

/** S1 viewer-unread ingestor patch (#task:1284, doc §6) — write ONE favorite
 *  row's absolute unread from an enriched `unread_updated` frame. A favorite is a
 *  CONVERSATION since #task:1888, so the match is `entity_id === conversation_id`
 *  and the value is `conversation_unread_count` — the frame's
 *  `workspace_unread_count` is the PARENT's roll-up and would overstate a row
 *  whose parent has other unread conversations. Favorites is a LIST whose
 *  membership (which conversations are starred) is orthogonal to unread, so this is
 *  PRESENT-ONLY: it writes `unread_count` on the matching row (0 is written too — a
 *  cleared badge), and is a no-op if the row is absent or the list is not loaded. It
 *  NEVER inserts a row and NEVER refetches (an unread change can't add/remove a
 *  favorite; a fallback refetch would turn a badge tick back into a whole-list
 *  refetch — the exact regression this replaces, Cindy B3). Idempotent: an
 *  unchanged count writes nothing. */
export function patchFavoritesUnread(
  qc: QueryClient,
  payload: UnreadUpdatedMessagePayload,
): 'patched' | 'unchanged' | 'absent' | 'cold' {
  const prev = qc.getQueryData<ListFavoritesDto>(favoritesKey);
  if (!prev) return 'cold'; // list not loaded → no-op
  const idx = prev.items.findIndex(it => it.entity_id === payload.conversation_id);
  if (idx < 0) return 'absent'; // no such favorite row → no-op (never insert)
  const row = prev.items[idx];
  if (!row) return 'absent'; // unreachable (idx >= 0) — narrows the index access
  if (row.unread_count === payload.conversation_unread_count) {
    return 'unchanged';
  }
  const items = prev.items.slice();
  items[idx] = { ...row, unread_count: payload.conversation_unread_count };
  qc.setQueryData<ListFavoritesDto>(favoritesKey, { ...prev, items });
  return 'patched';
}

/** Drop every favorite row under a workspace the viewer lost access to — removed
 *  from it, or the workspace deleted (#task:1404). The same
 *  `viewer_workspaces_changed(removed)` fact that drops the `['workspaces']` row
 *  and purges message-unread ALSO invalidates these rows' membership: favorites is
 *  the THIRD viewer-local projection of that fact, and a starred conversation would
 *  otherwise linger as a dead row. Since #task:1888 a row is a CONVERSATION and
 *  `workspace_id` is its PARENT, so one lost workspace can drop SEVERAL rows.
 *  Consume the event's workspace_id, no refetch: filter out the matching `items`
 *  AND drop their orphan `viewer_sort.entries` (an entry's `entity_id` IS the row's
 *  `favorite_key` = `conversation:<entity_id>`). Leaving the sort entry behind would let
 *  the removed id survive in cache — the whole-cache removal invariant it violates
 *  is why #task:1412 fixed it (Cindy). That guard used to also match a
 *  `workspace:<wsId>` composite and a legacy BARE `<wsId>` entry; since #task:1888
 *  every key here is `conversation:`-prefixed and a conversation id never
 *  contains its parent's, so those two branches have no reachable input and the
 *  invariant now holds through the row filter alone. Local-only: on re-visibility a
 *  refetch restores authoritative order. PRESENT-ONLY / idempotent, mirroring
 *  {@link patchFavoritesUnread}: list not loaded → no-op; nothing matched → no
 *  write. */
export function removeWorkspaceFromFavorites(
  qc: QueryClient,
  workspaceId: string,
): void {
  const prev = qc.getQueryData<ListFavoritesDto>(favoritesKey);
  if (!prev) return; // list not loaded → no-op
  // Collect the removed rows' sort identities BEFORE filtering, so their orphan
  // sort entries can be dropped too.
  const removedKeys = new Set(
    prev.items
      .filter(it => it.workspace_id === workspaceId)
      .map(it => it.favorite_key),
  );
  const items = prev.items.filter(it => it.workspace_id !== workspaceId);
  const entries = prev.viewer_sort.entries.filter(
    e => !removedKeys.has(e.entity_id),
  );
  const changed =
    items.length !== prev.items.length ||
    entries.length !== prev.viewer_sort.entries.length;
  if (!changed) return; // nothing matched → no write
  qc.setQueryData<ListFavoritesDto>(favoritesKey, {
    ...prev,
    items,
    viewer_sort: { ...prev.viewer_sort, entries },
  });
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
 * whole-list refetch). Unread is server-scored — never derived client-side.
 *
 * MEMBERSHIP liveness (#task:1889). Since #task:1888 a row is a CONVERSATION, so
 * its membership now moves on facts the viewer scope never carries: leaving a
 * private channel, or archiving one, ends a star's reachability and must drop the
 * row — otherwise a dead STARRED row survives until remount. Those facts arrive as
 * `workspace_channels_changed` on the PARENT's workspace scope.
 *
 * The watched scope set is supplied by the CONSUMER (every workspace the viewer
 * can currently see) and typed {@link FavoritesWatchScope}, whose only producer is
 * `partitionRailWorkspaces().allVisibleIds` — so it can be neither derived from
 * the rows this list is showing nor re-derived from a home projection without
 * failing typecheck (@Cindy MUST FIX, #task:1889). A projection must not decide
 * its own dependency set: the moment an authoritative
 * refetch hid the LAST favorite under a parent, that parent left the derived set,
 * and the later restore / re-join `workspace_channels_changed` had nobody left
 * listening — the star never came back short of a remount. A star ADDING a row
 * needs no arm here (the star mutations invalidate this key directly), and
 * regaining a whole workspace arrives on the viewer scope
 * (`decideViewerSyncInvalidations`, `features/workspaces/hooks`).
 */
export function useFavorites(watchWorkspaceIds: FavoritesWatchScope) {
  const qc = useQueryClient();
  const query = useFavoritesList();

  // Joined into a stable string so the effect re-subscribes only when the SET
  // changes, not on every render of the caller's array literal.
  const scopeKey = Array.from(new Set(watchWorkspaceIds)).sort().join(',');

  useEffect(() => {
    const scopeIds = scopeKey ? scopeKey.split(',') : [];
    const subs = scopeIds.map(id => subscribeWsScope(`workspace:${id}`));
    const sub = subscribeViewerScope();
    const unsub = onWsFrame(frame => {
      const viewerSnapshot =
        frame.type === 'snapshot_required' && isCurrentViewerScope(frame.scope);
      if (viewerSnapshot || decideFavoritesInvalidation(frame, scopeIds)) {
        void qc.invalidateQueries({ queryKey: favoritesKey });
      }
    });
    return () => {
      for (const s of subs) s.unsubscribe();
      sub.unsubscribe();
      unsub();
    };
  }, [qc, scopeKey]);

  return query;
}

/**
 * The favorites list as a plain OBSERVER — same cache entry, no freshness
 * subscription of its own.
 *
 * For readers that need to know WHICH conversations are starred without owning the
 * list: STARRED's membership is also what decides whether a parent branch still
 * holds a row (`branchHoldsSelectedRow`, #task:1901), and that question is asked
 * one level above `FavoritesGroup`. Deliberately NOT `useFavorites(scope)` — a
 * second call would arm a second set of WS subscriptions and invalidate the key
 * twice per frame, for a caller that only reads. The one owner keeps the scope; the
 * observers ride its cache.
 */
export function useFavoritesList() {
  return useQuery<ListFavoritesDto>({
    queryKey: favoritesKey,
    queryFn: ({ signal }) => api<ListFavoritesDto>(apiPaths.favorites, { signal }),
  });
}

/**
 * Has this conversation MOVED out of its parent's channel list into STARRED
 * (#task:1888)? Three states, never a boolean (#task:1901, @Cindy MUST FIX #2):
 * this list is the only authority on the question, so before it answers there is
 * no answer, and folding that into "not starred" is a guess the caller then acts
 * on — the parent branch mounts its three queries and unmounts them a round trip
 * later, which is precisely the waste the caller exists to avoid.
 *
 * PENDING and ERROR are deliberately different. Pending is a bounded wait, so it
 * stays `'unknown'`. A failure is not bounded, so it falls back to `'unstarred'`,
 * which restores the COMMON path: a genuinely unstarred selection keeps its row in
 * its parent. It is NOT a rescue for a genuinely starred one — that row is excluded
 * from the parent by the parent's own `starred_at` (`excludeStarredChannels`) and
 * STARRED has no data either, so it stays absent while the list is down, which is
 * the behaviour a failed favorites list already had. A background refetch after a
 * success keeps the previous data, so it never re-enters `'unknown'`.
 */
export function useStarMembership(conversationId: string | null): StarMembership {
  const { data, status } = useFavoritesList();
  if (conversationId === null) return 'unknown';
  if (!data) return status === 'error' ? 'unstarred' : 'unknown';
  return data.items.some(it => it.entity_id === conversationId)
    ? 'starred'
    : 'unstarred';
}

/** Minimal WS frame shape {@link decideFavoritesInvalidation} consumes, so the
 *  decision can be exercised without React or a socket (mirrors
 *  `ViewerSyncFrame` in `features/workspaces/hooks`). */
export interface FavoritesSyncFrame {
  type: string;
  /** Optional so a raw `ServerFrame` (whose non-scoped variants carry none) can
   *  be passed straight in — a frame with no scope matches no watched workspace. */
  scope?: string;
  kind?: string;
}

/**
 * Pure decision: does this frame invalidate the favorites list, given the
 * WATCHED workspace scopes? True for a replay gap or a channel-membership change
 * on any watched parent. The viewer-scope half of the gate stays in the caller
 * (`isCurrentViewerScope` reads live socket state), same split as
 * `decideViewerSyncInvalidations`.
 *
 * `scopeIds` is every workspace the viewer can see — deliberately NOT the parents
 * of the rows currently in the list. A parent with zero visible favorites is
 * exactly the case that must stay armed: it is where a hidden star is waiting for
 * its channel to be restored.
 */
export function decideFavoritesInvalidation(
  frame: FavoritesSyncFrame,
  scopeIds: readonly string[],
): boolean {
  const watched = scopeIds.some(id => frame.scope === `workspace:${id}`);
  if (frame.type === 'snapshot_required') return watched;
  if (frame.type !== 'event') return false;
  if (frame.kind !== 'workspace_channels_changed') return false;
  return watched;
}

/**
 * Unstar one favorite from its row's context menu. A favorite is a CONVERSATION
 * (#task:1888), so this always hits the channel star endpoint with the row's
 * `entity_id`; the storage list_key is derived server-side, which is what makes it
 * workspace-agnostic — it correctly unstars a favorite whose parent workspace is
 * not the one currently open. Invalidates the favorites list plus the workspace /
 * channel caches so the conversation REAPPEARS under its parent (exclusive move —
 * it was hidden from there while starred) and the Star/Unstar menu state flips in
 * lockstep.
 */
export function useUnstarFavorite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (item: FavoriteRowDto) => {
      await api<unknown>(apiPaths.channelStar(item.entity_id), { method: 'DELETE' });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: favoritesKey });
      // Home-surface star indicators. Key mirrors `features/workspaces/hooks`
      // (`['workspaces']` covers the parent's channel list, whose inline
      // `viewer_sort` carries the `starred_at` the exclusion reads).
      void qc.invalidateQueries({ queryKey: ['workspaces'] });
    },
    onError: () => {
      toast.error('Failed to unstar, please retry');
    },
  });
}
