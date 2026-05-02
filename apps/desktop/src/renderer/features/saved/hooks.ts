import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SavedMessageDto } from '@silverhand/shared';
import { api } from '@/lib/api';

const savedKey = ['saved'] as const;

/**
 * Returns the global flat saved-message list. The API ships everything
 * pre-joined (channel/session/agent names + full message body).
 */
export function useSavedMessages() {
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
      void qc.invalidateQueries({ queryKey: savedKey });
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
      void qc.invalidateQueries({ queryKey: savedKey });
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
