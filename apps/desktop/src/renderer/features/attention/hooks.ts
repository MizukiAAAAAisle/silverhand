// Attention bounded context — renderer read/write hooks (#task:1227 ②a).
// Mirrors `@silverhand/shared` `api/attention.ts`; kept in its own feature
// folder (not `features/channels`) to respect the bounded-context boundary —
// Attention is the read-side projection of the human's "queue waiting on me",
// distinct from messaging/channels. Canonical: docs/activity-lifecycle-v1.md.
import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
      // task event (Cindy review). Backend treats this as client-driven
      // invalidation (no `unread_updated` is emitted for a pref change).
      void qc.invalidateQueries({ queryKey: ['activity'] });
    },
  });
}

// ───────────────────────────── Activity list (②c) ─────────────────────────────

/** Query key for the viewer's Activity list. v1 is a single GLOBAL list (the
 *  human's whole "queue waiting on me" across every workspace), so there is one
 *  cache entry; `['activity']` is its prefix for broad invalidation. */
export const activityKey = () => ['activity', 'all'] as const;

/**
 * The viewer's GLOBAL Activity list (`GET /api/activity` with NO `workspace_id`,
 * #task:1227 §9.2). v1 UI scope = global (the user's single attention inbox
 * across all workspaces — shiki 2026-06-25). The server returns it fully
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
 * `kind=task` is intentionally OUT of Activity v1 (#task:1227, shiki 2026-06-26 —
 * a status mirror, not an event), so there is NO `task_changed` subscription: one
 * `viewer:<id>` subscription covers both live sources. Task re-enters in v2 only
 * via a notification-backed `task_needs_review`, which already rides the
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
    onSuccess: () => {
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
 * clear (Cindy phase-B contract). The whole batch is one `observe()` call (one
 * server transaction); an empty batch is a no-op.
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
      if (sources.length === 0) return;
      await postObserve(sources);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['activity'] });
      void qc.invalidateQueries({ queryKey: ['notifications'] });
    },
    onError: () => {
      toast.error('Failed to mark all as read, please retry');
    },
  });
}
