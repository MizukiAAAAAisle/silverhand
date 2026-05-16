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

const savedKey = ['saved'] as const;
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
 * Returns the global flat saved-message list. The API ships everything
 * pre-joined (channel/conversation/agent names + full message body).
 * Invalidated by WS viewer-scoped `saved_changed` events so the list
 * stays in sync without polling.
 */
export function useSavedMessages() {
  const qc = useQueryClient();

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
    queryKey: savedKey,
    queryFn: async () => {
      const res = await api<{ saved: SavedMessageDto[] }>('/api/saved');
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
