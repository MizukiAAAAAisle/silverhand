import { useMemo } from 'react';
import {
  useInfiniteQuery,
  useQuery,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';
import {
  apiPaths,
  type AttachmentListItem,
  type AttachmentListPage,
  type AttachmentSenderFacet,
  type AttachmentSenderFacets,
} from '@silverhand/shared';
import { api } from '@/lib/api';
import {
  dateFilterSince,
  type DateFilterValue,
} from '@/components/ui/date-filter-select';
import { wsConversationScope } from '@/hooks/useConversationStream';
import { useInterest } from '@/features/realtime/interest-registry';

/**
 * Channel Attachments panel data source. Lists every attachment referenced
 * by a persisted message in the channel — orphan / composer-draft blobs
 * are filtered out at the backend, thread replies are included as part of
 * the parent channel scope (thread reply messages store the parent's
 * `conversation_id`), and one row is emitted per unique attachment id
 * (earliest persisted reference wins the source fields; see the DTO
 * comments in `packages/shared/src/api/attachment.ts`).
 *
 * Backed by `GET /api/channels/:id/attachments`. The endpoint returns a
 * keyset page keyed by `(appeared_at DESC, attachment_id DESC)`; we feed
 * the opaque `next_cursor` back verbatim.
 *
 * Filtering is pushed to the backend, never applied to already-loaded pages:
 * front-end filtering of a paginated window only sees the rows fetched so
 * far, so a sender/time predicate would silently under-report until the user
 * scrolled the whole channel. Both axes (sender, time) go into the query
 * string and the React Query key, so each filter combination is its own
 * cached, independently-paginated list.
 */

const ATTACHMENTS_PAGE_LIMIT = 40;

/** Which sender the list is scoped to. `null` (absent) = all senders. Mirrors
 *  the list wire's discriminated sender contract: a `user`/`agent` carries a
 *  non-empty id, `system` carries none. Sourced from the sender facets, so it
 *  can only ever name a real canonical-source actor (never a dead option). */
export type AttachmentSenderFilter =
  | { kind: 'user'; userId: string }
  | { kind: 'agent'; agentId: string }
  | { kind: 'system' };

/** The panel's full filter state. `time` reuses the shared recency options
 *  (`all` = unbounded); the hook resolves it to a `since` epoch-ms once, frozen
 *  at the start of the filter session (the full query key carries that cutoff). */
export interface AttachmentListFilter {
  sender: AttachmentSenderFilter | null;
  time: DateFilterValue;
}

/** The unfiltered default — every attachment, all time. */
export const ALL_ATTACHMENTS_FILTER: AttachmentListFilter = {
  sender: null,
  time: 'all',
};

/** True when a filter narrows the list (drives the "no matches" empty state
 *  and the Clear affordance vs the genuine "channel has no attachments"). */
export function isAttachmentFilterActive(f: AttachmentListFilter): boolean {
  return f.sender !== null || f.time !== 'all';
}

/** Stable, hashable projection of a filter's discrete axes (sender + time
 *  PRESET) for the query key. This is only PART of the key — the full key
 *  (see {@link attachmentsListQueryKey}) also carries the resolved `since`
 *  cutoff, since two sessions on the same preset but different resolved
 *  windows are distinct cache entries. */
export function attachmentFilterKey(f: AttachmentListFilter): {
  s: string | null;
  t: DateFilterValue;
} {
  const s =
    f.sender === null
      ? null
      : f.sender.kind === 'user'
        ? `u:${f.sender.userId}`
        : f.sender.kind === 'agent'
          ? `a:${f.sender.agentId}`
          : 'sys';
  return { s, t: f.time };
}

/** Build the list request's query string for one page. Sender maps to the
 *  discriminated wire (`sender_kind` + a `sender_id` only for user/agent);
 *  `since` is the cutoff frozen at the START of the filter session (the hook
 *  memoizes it and threads it in) — this function never reads the clock, so
 *  every page of one session emits the identical `since` the query key
 *  carries. No `until` — every preset is an open-ended recency window, which
 *  composes with the keyset cursor. Pure + exported so the wire contract is
 *  unit-locked without a rendered hook. */
export function attachmentsListSearchParams(
  filter: AttachmentListFilter,
  opts: { cursor?: string | null; limit: number; since: number | null },
): URLSearchParams {
  const params = new URLSearchParams();
  params.set('limit', String(opts.limit));
  if (opts.cursor != null) params.set('cursor', opts.cursor);
  if (filter.sender) {
    params.set('sender_kind', filter.sender.kind);
    if (filter.sender.kind === 'user') {
      params.set('sender_id', filter.sender.userId);
    } else if (filter.sender.kind === 'agent') {
      params.set('sender_id', filter.sender.agentId);
    }
    // system: no sender_id (the wire rejects one).
  }
  if (opts.since !== null) params.set('since', String(opts.since));
  return params;
}

/** Identity of a filter "session": the same string ⟺ the same frozen time
 *  window. Changing channel, sender, or time preset starts a NEW session
 *  (and thus resolves a fresh cutoff). Used as the memo key that freezes the
 *  resolved cutoff for the session. */
export function attachmentAnchorId(
  channelId: string,
  f: AttachmentListFilter,
): string {
  const k = attachmentFilterKey(f);
  return `${channelId}|${k.s ?? ''}|${k.t}`;
}

/** Base (filter-agnostic) key. Every filtered list is a child of this prefix,
 *  so `invalidateChannelAttachmentsList` and the reader gate operate on the
 *  whole family without enumerating filters. */
export const channelAttachmentsKey = (channelId: string) =>
  ['channels', channelId, 'attachments-list'] as const;

/** Distinct canonical-source senders for one channel — the filter facets. */
export const channelAttachmentSendersKey = (channelId: string) =>
  ['channels', channelId, 'attachment-senders'] as const;

/** The FULL list query key: base prefix + filter projection + the FROZEN
 *  resolved cutoff. Two sessions with the same preset but different resolved
 *  cutoffs (e.g. '7d' started on different days) are distinct cache entries —
 *  a query key must map to one HTTP input. The base prefix is unchanged, so
 *  the reader gate / invalidation still span the whole filter family. */
export function attachmentsListQueryKey(
  channelId: string,
  filter: AttachmentListFilter,
  resolvedSince: number | null,
) {
  return [
    ...channelAttachmentsKey(channelId),
    attachmentFilterKey(filter),
    resolvedSince,
  ] as const;
}

/** True when a `useChannelAttachments(channelId, …)` reader is mounted for
 *  ANY filter — a PREFIX match over the base key, so it detects a reader
 *  whose live query key carries a filter segment. Mirrors
 *  `hasActiveChannelThreadsReader` (#task:1255 P1c gate): the central
 *  conversation ingestor only invalidates the attachments list while a
 *  reader is alive, so interest-only scope subscription (no visible
 *  consumer) doesn't spin up needless refetches. */
export function hasActiveChannelAttachmentsReader(
  qc: QueryClient,
  channelId: string,
): boolean {
  return qc
    .getQueryCache()
    .findAll({ queryKey: channelAttachmentsKey(channelId) })
    .some(entry => entry.getObserversCount() > 0);
}

/** Invalidate every filtered variant of the channel Attachments list —
 *  verbatim analogue of `invalidateChannelThreadsList`, and a PREFIX
 *  invalidation (the base key with no filter segment) so all cached filter
 *  combinations refetch, not just the default one. The central ingestor
 *  calls this when a mainline or thread message carrying attachment refs
 *  lands. Returns the invalidate Promise for reconcile-settle signalling. */
export function invalidateChannelAttachmentsList(
  qc: QueryClient,
  channelId: string,
): Promise<void> {
  return qc.invalidateQueries({ queryKey: channelAttachmentsKey(channelId) });
}

/** Invalidate the sender facets — a newly-landed attachment can introduce a
 *  sender not yet in the dropdown. Marks the facet query stale; with the
 *  dropdown closed there is no observer, so it simply refetches on next open
 *  rather than firing immediately. */
export function invalidateChannelAttachmentSenders(
  qc: QueryClient,
  channelId: string,
): Promise<void> {
  return qc.invalidateQueries({
    queryKey: channelAttachmentSendersKey(channelId),
  });
}

/** Reactive channel Attachments list with cursor pagination, scoped by
 *  `filter`. Fetches the first page on mount and exposes `fetchNextPage` for
 *  infinite scroll; the ingestor invalidates the query family as messages
 *  land so an open panel stays current. `nowMs` is injected in tests to pin
 *  the time-filter cutoff; production defaults to `Date.now()`. */
export function useChannelAttachments(
  channelId: string | null,
  filter: AttachmentListFilter = ALL_ATTACHMENTS_FILTER,
  opts: { nowMs?: number } = {},
): {
  items: AttachmentListItem[];
  isLoading: boolean;
  isError: boolean;
  isFetchingNextPage: boolean;
  hasNextPage: boolean;
  fetchNextPage: () => void;
  refetch: () => void;
} {
  const enabled = !!channelId;
  const cid = channelId ?? 'none';

  // Freeze the resolved time cutoff for the lifetime of this filter session,
  // recomputing only when the session identity (channel / sender / preset)
  // changes. A plain `useMemo` is safe here — NOT a render-mutated ref — even
  // though the factory reads the clock: the resolved cutoff is part of the
  // full query key, so if React ever discards the memo the recompute yields a
  // NEW key (at worst a refetch), never a different HTTP input smuggled into
  // one cache entry. `opts.nowMs` pins the clock in tests. `filter.time` is
  // listed explicitly (redundant with `anchorId`, but stabler than proving an
  // implicit dep) while the raw `filter` object identity stays out.
  const anchorId = attachmentAnchorId(cid, filter);
  const resolvedSince = useMemo(
    () => dateFilterSince(filter.time, opts.nowMs ?? Date.now()),
    [anchorId, filter.time, opts.nowMs],
  );

  // The full key carries the RESOLVED cutoff, not just the preset — so a
  // '7d' session started today and one started tomorrow are distinct cache
  // entries (different HTTP input ⇒ different identity). The base prefix is
  // unchanged, so the reader gate / invalidation still span the whole family.
  const key = attachmentsListQueryKey(cid, filter, resolvedSince);

  const query = useInfiniteQuery<
    AttachmentListPage,
    Error,
    InfiniteData<AttachmentListPage, string | null>,
    typeof key,
    string | null
  >({
    queryKey: key,
    enabled,
    initialPageParam: null,
    queryFn: ({ pageParam, signal }) => {
      const base = apiPaths.channelAttachments(channelId!);
      const params = attachmentsListSearchParams(filter, {
        cursor: pageParam,
        limit: ATTACHMENTS_PAGE_LIMIT,
        since: resolvedSince,
      });
      return api<AttachmentListPage>(`${base}?${params.toString()}`, { signal });
    },
    getNextPageParam: lastPage => lastPage.next_cursor,
  });

  // Same interest / invalidation contract as `useChannelThreads`: hold WS
  // scope INTEREST while a reader is mounted so the transport stays
  // subscribed; the central ingestor is the only party that mutates our
  // cache in response to inbound frames.
  useInterest(channelId ? wsConversationScope(channelId) : null);

  // Flatten pages once so consumers don't reach into InfiniteData shape.
  const items = useMemo(
    () => query.data?.pages.flatMap(p => p.items) ?? [],
    [query.data],
  );

  return {
    items,
    isLoading: query.isLoading,
    isError: query.isError,
    isFetchingNextPage: query.isFetchingNextPage,
    hasNextPage: !!query.hasNextPage,
    fetchNextPage: () => {
      if (query.hasNextPage && !query.isFetchingNextPage) {
        void query.fetchNextPage();
      }
    },
    refetch: () => {
      void query.refetch();
    },
  };
}

/** Sender filter facets for one channel — the DISTINCT canonical-source
 *  actors, each guaranteed wire-expressible by the list filter (see the DTO
 *  doc). Lazy: `enabled` is flipped on when the sender dropdown first opens,
 *  so a panel whose filter is never touched issues no facet request. */
export function useChannelAttachmentSenders(
  channelId: string | null,
  opts: { enabled: boolean },
): {
  senders: AttachmentSenderFacet[];
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
} {
  const query = useQuery<AttachmentSenderFacets, Error>({
    queryKey: channelAttachmentSendersKey(channelId ?? 'none'),
    enabled: opts.enabled && !!channelId,
    queryFn: ({ signal }) =>
      api<AttachmentSenderFacets>(apiPaths.channelAttachmentSenders(channelId!), {
        signal,
      }),
  });
  return {
    senders: query.data?.senders ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: () => {
      void query.refetch();
    },
  };
}
