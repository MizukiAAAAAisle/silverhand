// Attention bounded context — renderer read/write hooks (#task:1227 ②a).
// Mirrors `@silverhand/shared` `api/attention.ts`; kept in its own feature
// folder (not `features/channels`) to respect the bounded-context boundary —
// Attention is the read-side projection of the human's "queue waiting on me",
// distinct from messaging/channels. Canonical: docs/activity-lifecycle-v1.md.
import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type {
  ActivityItemDto,
  ChannelAttentionMode,
  ChannelAttentionPreferenceDto,
  ListActivityDto,
  ObserveSource,
} from '@silverhand/shared';
import { apiPaths } from '@silverhand/shared';
import { api } from '@/lib/api';
import { activityItemSource, postObserve } from './observe';
import {
  reconcileUnreadAfterObserveIfRealtimeUnavailable,
  settleStreamUnreadAfterObserve,
} from './observe-cache-fallback';
import {
  onWsFrame,
  subscribeViewerScope,
  isCurrentViewerScope,
} from '@/lib/ws-client';

/** Query key for one channel's per-viewer ambient attention preference. Follows
 *  the read-model keying convention (`['conversation', id, …]`); distinct last
 *  segment from the unread read-model so the two never collide. */
export const channelAttentionPreferenceKey = (channelId: string) =>
  ['conversation', channelId, 'attention-preference'] as const;

/**
 * The current viewer's resolved ambient attention preference for one REGULAR
 * channel (`GET /api/conversations/:id/attention-preference`). `mode` is always
 * resolved server-side (default applied when no row exists), so the client
 * never branches on "unset".
 *
 * Channel-scoped ONLY: the backend 404s `dm_channel` / `thread` (DM unread is
 * directed-grade and always enters Activity; threads carry no ambient pref, §6
 * / §13.3). Callers MUST gate on `kind === 'channel'` before passing an id.
 */
export function useChannelAttentionPreference(channelId: string | null) {
  return useQuery<ChannelAttentionPreferenceDto>({
    queryKey: channelAttentionPreferenceKey(channelId ?? 'none'),
    enabled: !!channelId,
    queryFn: ({ signal }) =>
      api<ChannelAttentionPreferenceDto>(
        apiPaths.conversationAttentionPreference(channelId!),
        { signal },
      ),
  });
}

/**
 * Set the viewer's ambient preference for one channel (`PUT …`). This is the
 * ONLY renderer surface that writes attention state (§5.2) — it never touches
 * delivery/follow (`thread_followers`). Optimistic so the toggle feels instant;
 * the server's resolved DTO reconciles on success.
 */
export function useSetChannelAttentionPreference(channelId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (mode: ChannelAttentionMode) => {
      if (!channelId) throw new Error('no channel');
      return api<ChannelAttentionPreferenceDto>(
        apiPaths.conversationAttentionPreference(channelId),
        { method: 'PUT', body: JSON.stringify({ mode }) },
      );
    },
    onMutate: async (mode): Promise<{ prev?: ChannelAttentionPreferenceDto }> => {
      if (!channelId) return {};
      const key = channelAttentionPreferenceKey(channelId);
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<ChannelAttentionPreferenceDto>(key);
      // Construct the full DTO (not a spread of `prev`) so the toggle reflects
      // instantly even when the click lands before the GET has resolved.
      qc.setQueryData<ChannelAttentionPreferenceDto>(key, {
        conversation_id: channelId,
        mode,
      });
      return { prev };
    },
    onError: (_err, _mode, ctx) => {
      if (channelId) {
        const key = channelAttentionPreferenceKey(channelId);
        if (ctx?.prev) qc.setQueryData(key, ctx.prev);
        // prev may be undefined (write fired before first load) — refetch the
        // authoritative value rather than leaving a stale optimistic guess.
        void qc.invalidateQueries({ queryKey: key });
      }
      toast.error('Failed to update, please retry');
    },
    onSuccess: dto => {
      if (channelId) qc.setQueryData(channelAttentionPreferenceKey(channelId), dto);
      // The ambient mode (all/mentions) is an `enter()` input, so flipping it
      // adds/removes this channel's ambient items from the Activity list —
      // invalidate the (global) activity query so the list reflects the new
      // eligibility immediately, not on the next unrelated unread/notification/
      // task event. Backend treats this as client-driven invalidation (no
      // `unread_updated` is emitted for a pref change).
      void qc.invalidateQueries({ queryKey: ['activity'] });
    },
  });
}

// ───────────────────────────── Activity list (②c) ─────────────────────────────

/** Query key for the viewer's Activity list. v1 is a single GLOBAL list (the
 *  human's whole "queue waiting on me" across every workspace), so there is one
 *  cache entry; `['activity']` is its prefix for broad invalidation. */
export const activityKey = () => ['activity', 'all'] as const;

/** Drop every Activity item for a workspace the viewer lost access to — removed
 *  from it, or the workspace deleted (#task:1409). Activity is the FOURTH
 *  viewer-local projection of the single `viewer_workspaces_changed(removed)`
 *  fact (after #task:1404's workspaces list / message-unread / favorites): each
 *  item carries `workspace_id`, so a removed workspace's items must drop or they
 *  linger as ghosts (and keep the #task:1408 rail dot falsely lit). Consume the
 *  event's `workspace_id` and filter in place — NOT a refetch: the list is
 *  GLOBAL (`['activity','all']`, so a refetch wouldn't 404), but a whole-list
 *  refetch re-scores and re-orders every SURVIVING item — a needless reflow for
 *  a pure membership drop. This is a straight membership filter, never a
 *  re-score, so it stays a pure projection: survivors keep their server order.
 *  PRESENT-ONLY / idempotent, mirroring the sibling `removeWorkspaceFrom*`
 *  cleanups: list not loaded → no-op; no matching item → no write.
 *
 *  Archive is deliberately NOT handled here — an archived channel stays
 *  visible-to-owner and its directed items self-heal via the existing
 *  `unread_updated` → refetch path once the backend `enter()` filter excludes
 *  archived (#task:1409 axis 1). Only workspace REMOVAL (a visibility-loss fact
 *  the Activity subscription does not otherwise observe) needs this local
 *  settle. */
export function removeWorkspaceFromActivity(
  qc: QueryClient,
  workspaceId: string,
): void {
  const prev = qc.getQueryData<ListActivityDto>(activityKey());
  if (!prev) return; // list not loaded → no-op
  const items = prev.items.filter(it => it.workspace_id !== workspaceId);
  if (items.length === prev.items.length) return; // no matching item → no write
  qc.setQueryData<ListActivityDto>(activityKey(), { ...prev, items });
}

/**
 * The viewer's GLOBAL Activity list (`GET /api/activity` with NO `workspace_id`,
 * #task:1227 §9.2). v1 UI scope = global (the user's single attention inbox
 * across all workspaces). The server returns it fully
 * `enter()`-filtered (§6), per-(viewer,message) de-duped (§7) and salience-sorted
 * (§13.2) — the renderer renders it as-is and NEVER re-scores. The three filter
 * chips slice this purely client-side on `kind` / `thread_root_id`.
 *
 * Activity is fed by TWO source families, both converging on the viewer scope,
 * so it refreshes on a single subscription (same no-poll model as
 * `useConversationUnread`, #task:1226):
 *   - positional unread (cursor read-model) → viewer-scoped `unread_updated`
 *   - directed notifications (@me / agent-fail) → viewer-scoped `notification`
 *
 * `kind=task` is intentionally OUT of Activity v1 (#task:1227: a status mirror,
 * not an event), so THIS hook adds no `task_changed` subscription — one
 * `viewer:<id>` subscription covers both Activity live sources. (The task
 * board's own `useTasks` does subscribe `task_changed` on the same viewer
 * scope; that is a separate consumer.) Task re-enters Activity in v2 only via a
 * notification-backed `task_needs_review`, which already rides the
 * `notification` source above.
 */
export function useActivity() {
  const qc = useQueryClient();
  const queryKey = activityKey();

  useEffect(() => {
    const sub = subscribeViewerScope();
    const unsub = onWsFrame(frame => {
      if (frame.type === 'snapshot_required') {
        if (isCurrentViewerScope(frame.scope)) {
          void qc.invalidateQueries({ queryKey });
        }
        return;
      }
      if (frame.type !== 'event') return;
      if (!isCurrentViewerScope(frame.scope)) return;
      if (frame.kind === 'unread_updated' || frame.kind === 'notification') {
        void qc.invalidateQueries({ queryKey });
      }
    });
    return () => {
      sub.unsubscribe();
      unsub();
    };
  }, [qc]); // eslint-disable-line react-hooks/exhaustive-deps

  return useQuery<ListActivityDto>({
    queryKey,
    queryFn: ({ signal }) => api<ListActivityDto>(apiPaths.activity, { signal }),
  });
}

/**
 * Clear ONE Activity item through the single eliminate primitive (#task:1231).
 * The caller resolves the item to a `source_ref` via {@link activityItemSource}
 * (the kind-based routing chokepoint in `observe.ts`), so this hook is
 * source-shape agnostic — it just posts and refreshes. Used by the per-row
 * hover-✓ and the on-open directed dismiss. Invalidates both the activity list
 * and the notification caches so the row and any badge drop together.
 */
export function useClearActivityItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (source: ObserveSource) => postObserve([source]),
    onSuccess: (result, source) => {
      reconcileUnreadAfterObserveIfRealtimeUnavailable(qc, result);
      // A cleared stream item (mainline / thread / DM positional) changes this
      // conversation's per-stream `conversationUnread` — settle it via the single
      // seam so a co-visible channel chip re-settles at once, not on the async
      // `unread_updated` round-trip (#task:1402: same window as #task:1400, from
      // the Activity entry point). Notification-kind sources are ignored by the
      // seam. #task:1284 global maps are untouched.
      settleStreamUnreadAfterObserve(qc, [source], result);
      void qc.invalidateQueries({ queryKey: ['activity'] });
      void qc.invalidateQueries({ queryKey: ['notifications'] });
    },
    onError: () => {
      toast.error('Failed to mark as read, please retry');
    },
  });
}

/**
 * Mark a batch of Activity items read in one transaction (#task:1231 phase B —
 * "Mark all read"). Each item is routed through {@link activityItemSource}, so
 * directed items clear by `notification_id` and ambient items by an explicit
 * stream-head clear — a Mark-all NEVER converts a directed dismiss into a stream
 * clear. The whole batch is one `observe()` call (one server transaction); an
 * empty batch is a no-op.
 *
 * The caller passes the items to clear (today: the currently-visible/filtered
 * list, so "Mark all read" clears what the user is looking at and never a hidden,
 * filtered-out item). `observe()` caps a batch at 1000 sources; a real attention
 * queue is far below that, so v1 does not chunk.
 */
export function useMarkActivityAllRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (items: ActivityItemDto[]) => {
      const sources = items
        .map(activityItemSource)
        .filter((s): s is ObserveSource => s != null);
      if (sources.length === 0) return { changed: false };
      return postObserve(sources);
    },
    onSuccess: (result, items) => {
      reconcileUnreadAfterObserveIfRealtimeUnavailable(qc, result);
      // Settle every distinct stream conversation this batch cleared via the
      // single seam (#task:1402) — dedup + `changed`-gated inside it. Rebuild the
      // sources from `items` (pure routing) since onSuccess gets the variables,
      // not the mutationFn's local sources. #task:1284 global maps untouched.
      const sources = items
        .map(activityItemSource)
        .filter((s): s is ObserveSource => s != null);
      settleStreamUnreadAfterObserve(qc, sources, result);
      void qc.invalidateQueries({ queryKey: ['activity'] });
      void qc.invalidateQueries({ queryKey: ['notifications'] });
    },
    onError: () => {
      toast.error('Failed to mark all as read, please retry');
    },
  });
}
