import { useQuery, type QueryClient } from "@tanstack/react-query";
import type { MessageDto } from "@silverhand/shared";
import { apiPaths } from "@silverhand/shared";
import { api } from "@/lib/api";
import { channelWorkspaceOf } from "@/features/channels/channel-workspace-index";

export interface FetchedMessage {
  message: MessageDto;
  agent_name: string | null;
}

/** `['messages', messageId]` — one message, keyed by ITS id. */
export const messageKey = (messageId: string) => ["messages", messageId] as const;

export function useMessage(messageId: string | null) {
  return useQuery({
    queryKey: messageId ? messageKey(messageId) : (["messages", null] as const),
    enabled: !!messageId,
    // Messages are immutable once written; cache them aggressively.
    staleTime: Infinity,
    queryFn: async () => {
      const res = await api<FetchedMessage>(apiPaths.message(messageId!));
      return res;
    },
  });
}

export function removeChannelFromMessages(qc: QueryClient, channelId: string): void {
  for (const q of qc.getQueryCache().findAll({ queryKey: ["messages"] })) {
    const data = qc.getQueryData<FetchedMessage>(q.queryKey);
    if (data?.message.conversation_id !== channelId) continue;
    qc.removeQueries({ queryKey: q.queryKey, exact: true });
  }
}

export function messagesHeldChannelIds(qc: QueryClient, workspaceId: string): string[] {
  const ids = new Set<string>();
  for (const q of qc.getQueryCache().findAll({ queryKey: ["messages"] })) {
    const conversationId = qc.getQueryData<FetchedMessage>(q.queryKey)?.message.conversation_id;
    if (!conversationId) continue;
    if (channelWorkspaceOf(conversationId) === workspaceId) ids.add(conversationId);
  }
  return [...ids];
}
