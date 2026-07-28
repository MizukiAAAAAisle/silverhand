import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { useEffect } from 'react';
import type { SavedMessageDto } from '@silverhand/shared';
import { api } from '@/lib/api';
import { onWsFrame, subscribeViewerScope, isCurrentViewerScope } from '@/lib/ws-client';

/** Prefix key of every Saved list variant. The per-variant key appends the
 *  filter object (`['saved', { workspaceId, since }]`), so a channel-scoped
 *  cleanup must walk ALL loaded variants, not one canonical key (#task:1689). */
export const savedKey = ['saved'] as const;
const savedInvalidationTimers = new WeakMap<
  QueryClient,
  ReturnType<typeof setTimeout>
>();

function invalidateSavedDebounced(qc: QueryClient): void {
  const existing = savedInvalidationTimers.get(qc);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    savedInvalidationTimers.delete(qc);
    void qc.invalidateQueries({ queryKey: savedKey });
  }, 100);
  savedInvalidationTimers.set(qc, timer);
}

/**
 * Drop every Saved row attributed to ONE channel, across EVERY loaded filter
 * variant (#task:1689). The Saved read is membership-filtered server-side, so a
 * refetch after the viewer loses a channel returns the list WITHOUT those rows —
 * this patch reproduces exactly that shape instead of refetching, because a
 * refetch would also re-window the `saved_at DESC LIMIT` set and reflow rows the
 * viewer can still see.
 *
 * Attribution is `channel_id`: for a saved THREAD reply `conversation_id` is the
 * thread, while `channel_id` is always the parent channel — so `channel_id` is
 * the only field that answers "does this row belong to the lost channel".
 * PRESENT-ONLY / idempotent: an unloaded variant or a variant with no matching
 * row writes nothing.
 */
export function removeChannelFromSaved(qc: QueryClient, channelId: string): void {
  for (const q of qc.getQueryCache().findAll({ queryKey: savedKey })) {
    const prev = qc.getQueryData<SavedMessageDto[]>(q.queryKey);
    if (!prev) continue;
    const next = prev.filter(row => row.channel_id !== channelId);
    if (next.length === prev.length) continue;
    qc.setQueryData<SavedMessageDto[]>(q.queryKey, next);
  }
}

/** Which channels of ONE workspace the Saved list still holds rows for
 *  (#task:1689). Read off the row (`workspace_id` + `channel_id`), not the key:
 *  the unfiltered variant holds every workspace at once. */
export function savedHeldChannelIds(
  qc: QueryClient,
  workspaceId: string,
): string[] {
  const ids = new Set<string>();
  for (const q of qc.getQueryCache().findAll({ queryKey: savedKey })) {
    const data = qc.getQueryData<SavedMessageDto[]>(q.queryKey);
    if (!data) continue;
    for (const row of data) {
      if (row.workspace_id === workspaceId) ids.add(row.channel_id);
    }
  }
  return [...ids];
}

/**
 * Returns the saved-message list. The API ships everything pre-joined
 * (channel/conversation/agent names + full message body).
 *
 * Filtering is SERVER-SIDE (mirror archived-channels, #task:1258): pass
 * `{ workspaceId, since }` and the backend applies `workspace_id` + `saved_at
 * >= since` WHERE clauses BEFORE the `ORDER BY saved_at DESC LIMIT` — so a
 * filter narrows the FULL set, never a client-side slice of the capped window
 * (which would silently drop older history). The filter params are part of the
 * query key so each variant caches independently; the `['saved']` prefix
 * invalidation from save/unsave + the WS `saved_changed` effect covers every
 * variant. Call with no args for the full list (used by `useSavedMessageIds`).
 */
export interface SavedMessagesQuery {
  workspaceId?: string | null;
  since?: number | null;
}

export function useSavedMessages(params?: SavedMessagesQuery) {
  const qc = useQueryClient();
  const workspaceId = params?.workspaceId ?? null;
  const since = params?.since ?? null;

  useEffect(() => {
    const sub = subscribeViewerScope();
    const unsub = onWsFrame(frame => {
      if (frame.type === 'event' && isCurrentViewerScope(frame.scope) && frame.kind === 'saved_changed') {
        invalidateSavedDebounced(qc);
      } else if (frame.type === 'snapshot_required' && isCurrentViewerScope(frame.scope)) {
        invalidateSavedDebounced(qc);
      }
    });
    return () => { sub.unsubscribe(); unsub(); };
  }, [qc]);

  return useQuery({
    queryKey: [...savedKey, { workspaceId, since }] as const,
    queryFn: async () => {
      const qs = new URLSearchParams();
      if (workspaceId) qs.set('workspace_id', workspaceId);
      if (since != null) qs.set('since', String(since));
      const suffix = qs.toString();
      const res = await api<{ saved: SavedMessageDto[] }>(
        `/api/saved${suffix ? `?${suffix}` : ''}`,
      );
      return res.saved;
    },
  });
}

/** Set of message_ids that are currently saved — used by MessageItem to
 *  show the active state. Computed off the saved list to avoid an extra
 *  query per message list. */
export function useSavedMessageIds(): Set<string> {
  const { data = [] } = useSavedMessages();
  return new Set(data.map(s => s.message.id));
}

export function useSaveMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (messageId: string) => {
      const res = await api<{ saved: SavedMessageDto }>(
        `/api/messages/${messageId}/save`,
        { method: 'POST' },
      );
      return res.saved;
    },
    onSuccess: () => {
      invalidateSavedDebounced(qc);
    },
  });
}

export function useUnsaveMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (messageId: string) => {
      await api(`/api/messages/${messageId}/save`, { method: 'DELETE' });
    },
    onSuccess: () => {
      invalidateSavedDebounced(qc);
    },
  });
}

/** Toggle save state — picks save / unsave based on the cached set so
 *  consumers can pass a single onClick. */
export function useToggleSave() {
  const save = useSaveMessage();
  const unsave = useUnsaveMessage();
  const ids = useSavedMessageIds();
  return {
    toggle: (messageId: string) => {
      if (ids.has(messageId)) unsave.mutate(messageId);
      else save.mutate(messageId);
    },
    isPending: save.isPending || unsave.isPending,
  };
}
