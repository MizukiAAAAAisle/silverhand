import { useQuery, type QueryClient } from '@tanstack/react-query';
import type { MessageDto } from '@silverhand/shared';
import { apiPaths } from '@silverhand/shared';
import { api } from '@/lib/api';
import { channelWorkspaceOf } from '@/features/channels/channel-workspace-index';

export interface FetchedMessage {
  message: MessageDto;
  /** Display name of the sender agent, or null when the message is
   *  from a user (or the agent has been deleted). */
  agent_name: string | null;
}

/** `['messages', messageId]` — one message, keyed by ITS id. */
export const messageKey = (messageId: string) => ['messages', messageId] as const;

/**
 * One-off lookup for a single message + its sender's agent name.
 * Used by `QuotedMessagePreview` to backfill old thread_anchor rows
 * whose metadata snapshot is missing — for new rows the snapshot
 * lives in `metadata` directly and this hook stays disabled.
 */
export function useMessage(messageId: string | null) {
  return useQuery({
    queryKey: messageId ? messageKey(messageId) : (['messages', null] as const),
    enabled: !!messageId,
    // Messages are immutable once written; cache them aggressively.
    staleTime: Infinity,
    queryFn: async () => {
      const res = await api<FetchedMessage>(apiPaths.message(messageId!));
      return res;
    },
  });
}

/**
 * Discard every single-message cache belonging to a channel the viewer lost
 * (#task:1689). `MessageDto.conversation_id` is ALWAYS the parent channel-like
 * conversation — a thread is identified by `thread_root_id`, not by a separate
 * conversation (`ConversationKind` is `channel | dm_channel` since the v43
 * reply-cluster model) — so this cache IS channel-attributable, and the read it
 * caches would be refused after the loss. Removed rather than patched: a
 * single-object read has no filtered shape to patch to.
 */
export function removeChannelFromMessages(qc: QueryClient, channelId: string): void {
  for (const q of qc.getQueryCache().findAll({ queryKey: ['messages'] })) {
    const data = qc.getQueryData<FetchedMessage>(q.queryKey);
    if (data?.message.conversation_id !== channelId) continue;
    qc.removeQueries({ queryKey: q.queryKey, exact: true });
  }
}

/** Which channels of ONE workspace the single-message caches still hold a message
 *  for (#task:1689). The payload carries the conversation but no workspace, so the
 *  workspace comes from the immutable identity index. */
export function messagesHeldChannelIds(qc: QueryClient, workspaceId: string): string[] {
  const ids = new Set<string>();
  for (const q of qc.getQueryCache().findAll({ queryKey: ['messages'] })) {
    const conversationId = qc.getQueryData<FetchedMessage>(q.queryKey)?.message.conversation_id;
    if (!conversationId) continue;
    if (channelWorkspaceOf(conversationId) === workspaceId) ids.add(conversationId);
  }
  return [...ids];
}
