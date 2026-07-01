import { useQuery } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import {
  apiPaths,
  type ListChannelThreadsResponse,
} from '@silverhand/shared';
import { api } from '@/lib/api';
import { wsConversationScope } from '@/hooks/useConversationStream';
import { useInterest } from '@/features/realtime/interest-registry';

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

export const channelThreadsKey = (channelId: string) =>
  ['channels', channelId, 'threads-list'] as const;

/** True when a `useChannelThreads(channelId)` reader is mounted — the exact
 *  threads-list key has at least one active observer. Stage-2 P1c gate
 *  (#task:1255): the central ingestor took over `useChannelThreads.onEvent`,
 *  which only ran while that hook was mounted, so the list is invalidated only
 *  while a reader is alive (interest-only scope subscription must not). */
export function hasActiveChannelThreadsReader(
  qc: QueryClient,
  channelId: string,
): boolean {
  const entry = qc
    .getQueryCache()
    .find({ queryKey: channelThreadsKey(channelId), exact: true });
  return (entry?.getObserversCount() ?? 0) > 0;
}

/** Invalidate the channel Threads list (#task:1255 P1c) — verbatim move of
 *  `useChannelThreads.onEvent`: any reply (or a reconnect needing a fresh
 *  snapshot) can change the list's contents or order, so refetch. Both the
 *  `message` and `snapshot_required` branches did exactly this. */
export function invalidateChannelThreadsList(
  qc: QueryClient,
  channelId: string,
): Promise<void> {
  // Returns the invalidate Promise (reconcile-settle signal for the P2 snapshot
  // join, #1255 P2); the message-path caller ignores it, strategy unchanged.
  return qc.invalidateQueries({ queryKey: channelThreadsKey(channelId) });
}

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

  // Pure reader (#task:1255 P1c): no `onWsFrame` here — the central conversation
  // ingestor invalidates this list (gated on a mounted reader) when a reply
  // lands or a reconnect needs a fresh snapshot. We keep only the WS scope
  // INTEREST alive so the transport stays subscribed while the panel is open.
  // #task:1260 P2: interest is declared through the registry (was a direct
  // subscribeWsScope useEffect) — identical lifecycle, single authority. The
  // `enabled` gate maps to the null-scope form: disabled → no interest → the
  // transport unsubscribes (drops pending, RETAINS floor); re-enable
  // fresh-subscribes + resume-replays frames missed while disabled (#1251), so
  // `enabled` is not a correctness boundary.
  useInterest(channelId ? wsConversationScope(channelId) : null);

  return {
    threads: query.data?.threads ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: query.refetch,
  };
}
