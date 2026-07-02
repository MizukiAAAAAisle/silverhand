import { useQuery } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import {
  apiPaths,
  type ListChannelThreadsResponse,
  type ThreadSummary,
  type ThreadSummaryInvariant,
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

/** The SINGLE documented threads-list keyset comparator —
 *  `(last_reply_at DESC, root_seq DESC)`.
 *
 *  ┌─ SOURCE FENCE (#task:1279) ────────────────────────────────────────────┐
 *  │ This comparator is the CLIENT MIRROR of the server's authoritative order.│
 *  │ Authoritative source: `packages/backend/src/repos/message-repo.ts`,     │
 *  │ `listChannelThreads` — `ORDER BY lr.created_at DESC, root.seq DESC`      │
 *  │ (keyset cursor: `lr.created_at < ? OR (lr.created_at = ? AND            │
 *  │ root.seq < ?)`). If that ORDER BY / cursor tuple ever changes, THIS     │
 *  │ comparator AND its golden fence test (`useChannelThreads.test.ts` →     │
 *  │ "SOURCE FENCE") MUST change in the same commit — otherwise a client     │
 *  │ repositioning a row from an S1 `threads_list_entry` patch (#task:1278)  │
 *  │ silently drifts from the authoritative order (Cindy gate ②). The        │
 *  │ reciprocal anchor is a comment on the server ORDER BY pointing back     │
 *  │ here, so a grep from either side lands on the other.                    │
 *  └────────────────────────────────────────────────────────────────────────┘
 *
 *  This is the ONE place the order is expressed — never scatter ad-hoc `.sort`
 *  keys; `root_seq` is the immutable tie-break when `last_reply_at` ties to the
 *  millisecond across roots. */
export function compareThreadSummary(a: ThreadSummary, b: ThreadSummary): number {
  if (b.last_reply_at !== a.last_reply_at) return b.last_reply_at - a.last_reply_at;
  // root_seq is a branded MessageSeq (numeric ordinal); DESC tie-break.
  return b.root_seq - a.root_seq;
}

/** Outcome of merging a `threads_list_entry` patch into the held page (#task:1278):
 *   - `merged`     — the root was on the held page; its viewer-invariant fields were
 *                    overwritten with the absolute values and the page re-sorted by
 *                    the keyset (viewer_following kept from the local row).
 *   - `off-page`   — the page is loaded but does NOT hold this root. A new reply
 *                    bumps `last_reply_at` to now, so the root must surface on page-1,
 *                    but P2 v1 does NOT insert (off-page insert deferred; the
 *                    authoritative page-1 membership is the server's) → the caller
 *                    falls back to an invalidate→refetch.
 *   - `cold-absent`— no page data loaded (reader mounted but still fetching) → its
 *                    own mount-fetch is the authoritative recovery → vacuous. */
export type ThreadsListMergeOutcome = 'merged' | 'off-page' | 'cold-absent';

/** Merge an absolute `ThreadSummaryInvariant` into the held threads-list page,
 *  keeping the local `viewer_following` (the broadcast frame carries no per-viewer
 *  fact — Cindy gate ③), then re-sort by {@link compareThreadSummary}. Only
 *  repositions a row ALREADY on the page — never inserts (see
 *  {@link ThreadsListMergeOutcome}). Replay-idempotent: an identical entry
 *  (same `last_reply_message_id` + `reply_count`) is a no-op, and the absolute
 *  overwrite + deterministic sort make a re-applied changed entry converge to the
 *  same page. */
export function mergeThreadsListEntry(
  qc: QueryClient,
  channelId: string,
  entry: ThreadSummaryInvariant,
): ThreadsListMergeOutcome {
  const prev = qc.getQueryData<ListChannelThreadsResponse>(
    channelThreadsKey(channelId),
  );
  if (!prev) return 'cold-absent';
  const existing = prev.threads.find(
    t => t.root_message_id === entry.root_message_id,
  );
  if (!existing) return 'off-page';

  // Idempotency short-circuit (mirrors P1's scalar guard): a reply always changes
  // the last-reply identity + count, so equal on both ⇒ nothing to merge and the
  // row is already correctly positioned → no write (avoids a redundant re-render
  // on exact replay). root_preview/root_* only change on non-reply edits, which
  // don't emit this projection.
  if (
    existing.last_reply_message_id === entry.last_reply_message_id &&
    existing.reply_count === entry.reply_count
  ) {
    return 'merged';
  }

  // Absolute overwrite of every viewer-invariant field; KEEP the local
  // viewer_following (frame has none — never default it, Cindy gate ③).
  const merged: ThreadSummary = {
    ...entry,
    viewer_following: existing.viewer_following,
  };
  const nextThreads = prev.threads
    .map(t => (t.root_message_id === entry.root_message_id ? merged : t))
    .sort(compareThreadSummary);
  qc.setQueryData<ListChannelThreadsResponse>(channelThreadsKey(channelId), {
    ...prev,
    threads: nextThreads,
  });
  return 'merged';
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
