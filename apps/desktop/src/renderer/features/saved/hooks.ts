import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import type { SavedMessageDto, ServerFrame } from '@silverhand/shared';
import { api } from '@/lib/api';
import {
  onWsFrame,
  subscribeViewerScope,
  isCurrentViewerScope,
  subscribeWsScope,
} from '@/lib/ws-client';
import { useWorkspaces } from '@/features/workspaces/hooks';

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
 * this patch reproduces exactly that shape instead of refetching.
 *
 * The surgical patch is scoped to THIS path, and is not a general preference for
 * patching over refetching: the sibling `workspace_channels_changed` path below
 * deliberately DOES refetch, because a rename/archive changes an embedded
 * projection no local patch can recompute. So re-windowing the
 * `saved_at DESC LIMIT` set is a cost this path declines to pay for a result it
 * can reproduce exactly — not a cost the list never pays (@Paul, #task:2055).
 *
 * Attribution is `place.conversation_id`: it IS the row's conversation
 * coordinate, and equals `message.conversation_id` — both name the PARENT
 * channel. A saved thread reply is not a separate conversation (a thread is a
 * reply-cluster inside the same channel, identified by `message.thread_root_id`,
 * which is a message id — not a conversation coordinate), so `place.conversation_id`
 * answers "does this row belong to the lost channel" for channel and thread
 * saves alike (#task:2055 ④). A `direct_pair` row's `conversation_id` is the pair
 * itself and never matches a channel id, so it is left untouched.
 * PRESENT-ONLY / idempotent: an unloaded variant or a variant with no matching
 * row writes nothing.
 */
export function removeChannelFromSaved(qc: QueryClient, channelId: string): void {
  for (const q of qc.getQueryCache().findAll({ queryKey: savedKey })) {
    const prev = qc.getQueryData<SavedMessageDto[]>(q.queryKey);
    if (!prev) continue;
    const next = prev.filter(row => row.place.conversation_id !== channelId);
    if (next.length === prev.length) continue;
    qc.setQueryData<SavedMessageDto[]>(q.queryKey, next);
  }
}

/** Which channels of ONE workspace the Saved list still holds rows for
 *  (#task:1689). Read off the row's `place`, not the key (the unfiltered variant
 *  holds every workspace at once). Only the `workspace_channel` arm belongs to a
 *  workspace's channel set — a `direct_pair` row has no workspace and is skipped;
 *  its channel coordinate is `place.conversation_id` (#task:2055). */
export function savedHeldChannelIds(
  qc: QueryClient,
  workspaceId: string,
): string[] {
  const ids = new Set<string>();
  for (const q of qc.getQueryCache().findAll({ queryKey: savedKey })) {
    const data = qc.getQueryData<SavedMessageDto[]>(q.queryKey);
    if (!data) continue;
    for (const row of data) {
      if (
        row.place.kind === 'workspace_channel' &&
        row.place.workspace_id === workspaceId
      ) {
        ids.add(row.place.conversation_id);
      }
    }
  }
  return [...ids];
}

/**
 * Whether a WS frame arriving on a subscribed `workspace:<id>` scope must
 * invalidate `['saved']`. A saved row's embedded `channel_name` (the
 * `workspace_channel` arm of `SavedPlace`) is a LIVE projection — the placement
 * contract §4-A and `SavedPlaceSchema` require this list to keep it fresh — so a
 * channel rename / archive / move, delivered as `workspace_channels_changed` on
 * the WORKSPACE scope (NOT the viewer scope, so the sibling `saved_changed`
 * effect below cannot see it), forces a refetch; a post-reconnect
 * `snapshot_required` on that scope may have swallowed one, so it counts too.
 * INVALIDATE-only: the frame carries no row payload and `['saved']` is refetched
 * whole, never written from the frame (mirrors the shipped `useBoard` card face).
 * `scopes` is the set of `workspace:<id>` the viewer belongs to. Pure. */
export function savedWorkspaceFrameInvalidates(
  frame: ServerFrame,
  scopes: ReadonlySet<string>,
): boolean {
  if (frame.type === 'snapshot_required') return scopes.has(frame.scope);
  return (
    frame.type === 'event' &&
    frame.kind === 'workspace_channels_changed' &&
    scopes.has(frame.scope)
  );
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
 * invalidation from save/unsave + the WS `saved_changed` effect (viewer scope) +
 * the `workspace_channels_changed` effect (workspace scope, keeping embedded
 * `channel_name` live) cover every variant. Call with no args for the full list
 * (used by `useSavedMessageIds`).
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

  // Keep each row's embedded `channel_name` live (SavedPlaceSchema §4-A): a
  // channel rename / archive rides `workspace_channels_changed`, which is emitted
  // on the WORKSPACE scope, not the viewer scope — so the viewer-scope effect
  // above cannot see it. Mirror the shipped `useBoard` card face: subscribe every
  // workspace the viewer belongs to and invalidate `['saved']` on a hit (the pure
  // `savedWorkspaceFrameInvalidates` decides), never patch from the frame.
  const { data: workspaces = [] } = useWorkspaces();
  // Stable, order-independent key over the id set so the effect re-subscribes
  // only when membership actually changes, not on every equal-ids refetch.
  const workspaceScopeKey = useMemo(
    () => [...workspaces.map(w => w.id)].sort().join(','),
    [workspaces],
  );
  useEffect(() => {
    const ids = workspaceScopeKey ? workspaceScopeKey.split(',') : [];
    if (ids.length === 0) return;
    const scopes = new Set(ids.map(id => `workspace:${id}`));
    const subs = ids.map(id => subscribeWsScope(`workspace:${id}`));
    const unsub = onWsFrame(frame => {
      if (savedWorkspaceFrameInvalidates(frame, scopes)) invalidateSavedDebounced(qc);
    });
    return () => {
      for (const s of subs) s.unsubscribe();
      unsub();
    };
  }, [qc, workspaceScopeKey]);

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
