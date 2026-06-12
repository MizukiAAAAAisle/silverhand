import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  apiPaths,
  type ListChannelThreadsResponse,
} from '@silverhand/shared';
import { api } from '@/lib/api';
import {
  useConversationStream,
  type ConversationStreamEvent,
} from '@/hooks/useConversationStream';

// Re-export so existing consumers (ChannelThreadsPanel) keep their import path
// while the type now lives in the shared barrel (#task:1074 backend landing).
export type { ThreadSummary } from '@silverhand/shared';

/**
 * Channel Threads-list data (#task:1073, P2). Lists every reply-cluster in
 * one channel, newest activity first, so threaded messages are discoverable
 * without scrolling the whole stream.
 *
 * Backed by `GET /api/conversations/:id/threads` (#task:1074). Shape:
 * `ListChannelThreadsResponse` from `@silverhand/shared`.
 */

const channelThreadsKey = (channelId: string) =>
  ['channels', channelId, 'threads-list'] as const;

/**
 * Reactive channel Threads list. Refetches when the channel message stream
 * advances (a new reply bumps a cluster's `last_reply_at` / `reply_count`,
 * or a new reply turns a plain root into a thread), so an open list re-sorts
 * without manual refresh.
 *
 * P2 v1 loads only the first page (the endpoint's default limit). Cursor
 * pagination / infinite scroll is a documented follow-up — channels rarely
 * carry more than a page of active threads, and the list is recency-sorted
 * so the most useful rows are on page one.
 */
export function useChannelThreads(channelId: string | null) {
  const qc = useQueryClient();
  const enabled = !!channelId;
  const key = channelThreadsKey(channelId ?? 'none');

  const query = useQuery<ListChannelThreadsResponse>({
    queryKey: key,
    enabled,
    queryFn: ({ signal }) =>
      api<ListChannelThreadsResponse>(apiPaths.conversationThreads(channelId!), {
        signal,
      }),
  });

  // Any reply (or a reconnect needing a fresh snapshot) can change the list's
  // contents or order. Mirror the cluster hooks' filter: invalidate on the
  // synthetic connected-with-snapshot event and on any channel message.
  const onEvent = useCallback(
    (e: ConversationStreamEvent) => {
      if (!channelId) return;
      if (e.kind === 'connected' && e.payload?.snapshot_required) {
        void qc.invalidateQueries({ queryKey: key });
        return;
      }
      if (e.kind === 'message') {
        void qc.invalidateQueries({ queryKey: key });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [qc, channelId, key.join(':')],
  );
  useConversationStream(enabled ? channelId : null, onEvent, 'channel');

  return {
    threads: query.data?.threads ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: query.refetch,
  };
}
