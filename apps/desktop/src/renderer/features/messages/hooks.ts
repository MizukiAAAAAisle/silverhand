import { useQuery } from '@tanstack/react-query';
import type { MessageDto } from '@silverhand/shared';
import { apiPaths } from '@silverhand/shared';
import { api } from '@/lib/api';

export interface FetchedMessage {
  message: MessageDto;
  /** Display name of the sender agent, or null when the message is
   *  from a user (or the agent has been deleted). */
  agent_name: string | null;
}

/**
 * One-off lookup for a single message + its sender's agent name.
 * Used by `QuotedMessagePreview` to backfill old thread_anchor rows
 * whose metadata snapshot is missing — for new rows the snapshot
 * lives in `metadata` directly and this hook stays disabled.
 */
export function useMessage(messageId: string | null) {
  return useQuery({
    queryKey: ['messages', messageId] as const,
    enabled: !!messageId,
    // Messages are immutable once written; cache them aggressively.
    staleTime: Infinity,
    queryFn: async () => {
      const res = await api<FetchedMessage>(apiPaths.message(messageId!));
      return res;
    },
  });
}
