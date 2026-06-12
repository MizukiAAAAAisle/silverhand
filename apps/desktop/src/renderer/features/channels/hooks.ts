import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import type {
  AgentRunStatesDto,
  AttachmentDto,
  AttachmentSnapshot,
  ClearSessionResponse,
  ConversationAgentDto,
  ConversationMembersResponse,
  ConversationMessagesDto,
  MessageDto,
  MessageUnreadByConversationDto,
  ReplyBadgeSummary,
  TaskChangedEvent,
  ThreadFollowerStateDto,
  ThreadFollowMutationDto,
} from '@silverhand/shared';
import { apiPaths } from '@silverhand/shared';
import { api, ApiError } from '@/lib/api';
import { getCurrentUserId } from '@/lib/current-user';
import { onWsFrame, subscribeViewerScope, isCurrentViewerScope } from '@/lib/ws-client';
import {
  AGENT_RUN_STATES_GC_MS,
  agentRunStatesKey,
  reconcileAgentRunStateSnapshot,
} from '@/lib/agentRunStateCache';
import {
  useConversationStream,
  type ConversationStreamEvent,
} from '@/hooks/useConversationStream';
import { applyTaskChangedToTaskByNumberCache } from '@/features/tasks/useTaskByNumber';

const messagesKey = (cid: string) => ['channels', cid, 'messages'] as const;
/** Cache key for one reply cluster's window. A cluster lives in the same
 *  channel conversation as its root (rows with `thread_root_id = rootId`),
 *  so it is keyed off the channel id plus the root message id — distinct
 *  from the main-stream window (`messagesKey`) which excludes replies. */
const clusterMessagesKey = (cid: string, rootId: string) =>
  ['channels', cid, 'cluster', rootId, 'messages'] as const;
const agentsKey = (cid: string) => ['channels', cid, 'agents'] as const;
const MESSAGE_PAGE_LIMIT = 100;
const AROUND_MESSAGE_LIMIT = 100;

function parseApiErrorBody(err: ApiError): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(err.body) as unknown;
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function formatStartAgentError(err: unknown): string {
  if (err instanceof ApiError) {
    const body = parseApiErrorBody(err);
    const code = typeof body?.code === 'string' ? body.code : null;
    const detail =
      typeof body?.error === 'string'
        ? body.error
        : typeof body?.message === 'string'
          ? body.message
          : err.body || err.message;
    if (code === 'host_attach_pending') {
      return 'Agent 启动失败：daemon host 还未连接，稍后重试。';
    }
    if (code === 'workspace_path_missing') {
      return `Agent 启动失败：${detail}`;
    }
    if (code === 'workspace_not_provisioned') {
      return `Agent 启动失败：workspace 尚未 provision。${detail}`;
    }
    if (code === 'registry_unavailable') {
      return `Agent 启动失败：daemon workspace registry 不可用。${detail}`;
    }
    return `Agent 启动失败：${detail}`;
  }
  return `Agent 启动失败：${err instanceof Error ? err.message : String(err)}`;
}

function formatRemoveAgentError(err: unknown): string {
  if (err instanceof ApiError) {
    const body = parseApiErrorBody(err);
    const code = typeof body?.code === 'string' ? body.code : null;
    if (code === 'conversation_member_remove_unsupported') {
      return '只能从 channel 或 thread 移除成员(DM 不支持)。';
    }
    if (code === 'conversation_closed') {
      return '该会话已关闭,无法移除成员。';
    }
    if (err.status === 403) return '没有权限将该 agent 从此频道移除。';
    if (err.status === 404) return '该 agent 已不在此频道。';
    const detail =
      typeof body?.error === 'string'
        ? body.error
        : typeof body?.message === 'string'
          ? body.message
          : `HTTP ${err.status}`;
    return `移除失败：${detail}`;
  }
  return `移除失败：${err instanceof Error ? err.message : String(err)}`;
}

/** Page-param shape for the bidirectional infinite query.
 *  - `undefined` (the initial param) → fetch the latest window.
 *  - `{ kind: 'before', seq }` → fetch a window with seq < `seq`.
 *  - `{ kind: 'after', seq }` → fetch a window with seq > `seq`.
 *  We model it as a tagged union instead of a bare number so the
 *  hook knows which direction it's paging without re-deriving it
 *  from "is this a fetchPrevious or fetchNext call". React Query's
 *  inferred page-param type stays `MessagesPageParam` end-to-end. */
export type MessagesPageParam =
  | undefined
  | { kind: 'before'; seq: number }
  | { kind: 'after'; seq: number };

type MessagesCache = InfiniteData<ConversationMessagesDto, MessagesPageParam>;

function invalidateMessageUnreadQueries(qc: QueryClient): void {
  const existing = messageUnreadInvalidationTimers.get(qc);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    messageUnreadInvalidationTimers.delete(qc);
    void qc.invalidateQueries({
      predicate: query => {
        const key = query.queryKey;
        return (
          Array.isArray(key) &&
          key[0] === 'workspaces' &&
          key[key.length - 1] === 'message-unread'
        );
      },
    });
    void qc.invalidateQueries({ queryKey: ['message-unread', 'summary'] });
  }, 100);
  messageUnreadInvalidationTimers.set(qc, timer);
}

const messageUnreadInvalidationTimers = new WeakMap<
  QueryClient,
  ReturnType<typeof setTimeout>
>();

function isMessageUnreadUpdatedPayload(payload: unknown): boolean {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    typeof (payload as { conversation_id?: unknown }).conversation_id === 'string'
  );
}

type ConversationAgentStatusPatch = Pick<ConversationAgentDto, 'agent_id'> &
  Partial<Pick<ConversationAgentDto, 'status' | 'pid' | 'cli_session_id'>>;

function applySessionAgentPatch(
  agent: ConversationAgentDto,
  patch: ConversationAgentStatusPatch,
): ConversationAgentDto {
  if (agent.agent_id !== patch.agent_id) return agent;
  return {
    ...agent,
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.pid !== undefined ? { pid: patch.pid } : {}),
    ...(patch.cli_session_id !== undefined
      ? { cli_session_id: patch.cli_session_id }
      : {}),
  };
}

function applyPendingSessionAgentPatches(
  agents: ConversationAgentDto[],
  pending: Map<string, ConversationAgentStatusPatch>,
): ConversationAgentDto[] {
  if (pending.size === 0) return agents;
  return agents.map(agent => {
    const patch = pending.get(agent.agent_id);
    return patch ? applySessionAgentPatch(agent, patch) : agent;
  });
}

function makeMessagesCache(
  page: ConversationMessagesDto,
  pageParam: MessagesPageParam = undefined,
): MessagesCache {
  return { pages: [page], pageParams: [pageParam] };
}

function cacheHasMessage(data: MessagesCache | undefined, messageId: string): boolean {
  return data?.pages.some(page => page.messages.some(m => m.id === messageId)) ?? false;
}

/** Live-append is only safe when the last cached page is the tail
 *  of the conversation — otherwise we would lie to the user (the
 *  appended message wouldn't follow the message right above it).
 *  Callers MUST gate on this; the helper itself stays loose so the
 *  optimistic-send path can still bootstrap an empty cache. */
function lastPageIsTail(data: MessagesCache | undefined): boolean {
  if (!data || data.pages.length === 0) return true;
  const last = data.pages[data.pages.length - 1];
  return last?.has_more_after === false;
}

function appendMessageToCache(
  data: MessagesCache | undefined,
  msg: MessageDto,
): MessagesCache {
  if (!data) {
    return makeMessagesCache({
      messages: [msg],
      reply_counts_by_root: {},
      has_more_before: false,
      has_more_after: false,
    });
  }
  if (cacheHasMessage(data, msg.id)) return data;

  if (data.pages.length === 0) {
    return {
      ...data,
      pages: [
        {
          messages: [msg],
          reply_counts_by_root: {},
          has_more_before: false,
          has_more_after: false,
        },
      ],
      pageParams: [undefined as MessagesPageParam],
    };
  }

  const lastIndex = data.pages.length - 1;
  return {
    ...data,
    pages: data.pages.map((page, index) =>
      index === lastIndex
        ? { ...page, messages: [...page.messages, msg] }
        : page,
    ),
  };
}

function removeMessageFromCache(
  data: MessagesCache | undefined,
  messageId: string,
): MessagesCache | undefined {
  if (!data) return data;
  return {
    ...data,
    pages: data.pages.map(page => ({
      ...page,
      messages: page.messages.filter(m => m.id !== messageId),
    })),
  };
}

function replacePendingMessageInCache(
  data: MessagesCache | undefined,
  tempId: string,
  msg: MessageDto,
): MessagesCache {
  const withoutTempAndDuplicate = data
    ? {
        ...data,
        pages: data.pages.map(page => ({
          ...page,
          messages: page.messages.filter(m => m.id !== tempId && m.id !== msg.id),
        })),
      }
    : undefined;
  return appendMessageToCache(withoutTempAndDuplicate, msg);
}

function applyTaskChangedToCache(
  data: MessagesCache | undefined,
  task: TaskChangedEvent,
): MessagesCache | undefined {
  if (!data) return data;
  let changed = false;
  const pages = data.pages.map(page => {
    let pageChanged = false;
    const messages = page.messages.map(message => {
      if (message.id !== task.message_id) return message;
      changed = true;
      pageChanged = true;
      return {
        ...message,
        task_number: task.task_number,
        task_status: task.status,
        task_title: task.title,
        task_workspace_id: task.workspace_id,
        task_closed_at: task.closed_at,
        task_assignee: task.assignee,
      };
    });
    return pageChanged ? { ...page, messages } : page;
  });
  return changed ? { ...data, pages } : data;
}

/** Adjust a root's reply-count badge in the main-stream cache by `delta`.
 *
 *  The main window (cut3-6) excludes reply rows but carries a
 *  `reply_counts_by_root` sidecar per page; a live reply must bump that
 *  badge without inlining the reply itself. Each root appears in exactly
 *  one page's window, so we update the page that already carries the key
 *  or the page holding the root message (the first reply seeds the key).
 *  Roots not in any loaded page are a no-op — the next window fetch
 *  re-derives the authoritative count.
 *
 *  When `reply` is given (a live non-system reply) and the page already
 *  carries an enriched `reply_summaries_by_root` entry for the root (P1,
 *  #task:1073), the summary is patched in the same pass: `last_reply_at`
 *  advances, `reply_count` bumps, and the replier moves to the front of the
 *  (≤3) avatar cluster. We only patch EXISTING summary entries — never
 *  fabricate one — so a backend that hasn't shipped the sidecar keeps a
 *  consistent count-only badge everywhere. `replier_total` is an optimistic
 *  estimate (incremented only when the replier isn't already in the shown
 *  set); it self-heals on the next window refetch. */
function bumpReplyCountInCache(
  data: MessagesCache | undefined,
  rootId: string,
  delta = 1,
  reply?: MessageDto,
): MessagesCache | undefined {
  if (!data) return data;
  return {
    ...data,
    pages: data.pages.map(page => {
      const hasKey = Object.prototype.hasOwnProperty.call(
        page.reply_counts_by_root,
        rootId,
      );
      const hasRoot = page.messages.some(m => m.id === rootId);
      if (!hasKey && !hasRoot) return page;
      const next = Math.max(0, (page.reply_counts_by_root[rootId] ?? 0) + delta);
      const prevSummary = page.reply_summaries_by_root?.[rootId];
      const nextSummaries =
        reply && delta > 0 && prevSummary
          ? {
              ...page.reply_summaries_by_root,
              [rootId]: patchReplySummary(prevSummary, reply),
            }
          : page.reply_summaries_by_root;
      return {
        ...page,
        reply_counts_by_root: { ...page.reply_counts_by_root, [rootId]: next },
        ...(nextSummaries ? { reply_summaries_by_root: nextSummaries } : {}),
      };
    }),
  };
}

/** Optimistically fold a live reply into an existing enriched summary (P1).
 *  Pure; never fabricates a summary (callers gate on presence). */
function patchReplySummary(
  summary: ReplyBadgeSummary,
  reply: MessageDto,
): ReplyBadgeSummary {
  const replier =
    reply.from_kind === 'user'
      ? { kind: 'human' as const, id: reply.from_user_id ?? '' }
      : { kind: 'agent' as const, id: reply.from_agent_id ?? '' };
  const already = summary.repliers.some(
    r => r.kind === replier.kind && r.id === replier.id,
  );
  const repliers = [
    replier,
    ...summary.repliers.filter(
      r => !(r.kind === replier.kind && r.id === replier.id),
    ),
  ].slice(0, 3);
  return {
    reply_count: summary.reply_count + 1,
    last_reply_at: Math.max(summary.last_reply_at, reply.created_at),
    repliers,
    replier_total: already ? summary.replier_total : summary.replier_total + 1,
  };
}

/** Build a single messages-window page request URL.
 *
 *  Cursor params are mutually exclusive on the wire (the route 400s
 *  on 2+) — this helper enforces it locally too by treating
 *  `MessagesPageParam` as the union it is. `aroundMessageId` is its
 *  own caller-driven mode used by `usePrimeConversationMessages`,
 *  not by the page-walk path. `signal` is plumbed straight through
 *  to `api()` so callers can abort the in-flight fetch. */
async function fetchMessagesWindow(opts: {
  conversationId: string;
  pageParam?: MessagesPageParam;
  aroundMessageId?: string;
  /** When set, fetch the reply cluster rooted at this message id
   *  (`?thread_root_id=`) instead of the conversation's main stream.
   *  Channel route only — threads have no nested clusters. */
  threadRootId?: string;
  limit: number;
  signal?: AbortSignal;
}): Promise<ConversationMessagesDto> {
  const params = new URLSearchParams({ limit: String(opts.limit) });
  if (opts.aroundMessageId !== undefined) {
    params.set('around_message_id', opts.aroundMessageId);
  } else if (opts.pageParam) {
    if (opts.pageParam.kind === 'before') {
      params.set('before_seq', String(opts.pageParam.seq));
    } else {
      params.set('after_seq', String(opts.pageParam.seq));
    }
  }
  if (opts.threadRootId !== undefined) {
    params.set('thread_root_id', opts.threadRootId);
  }
  const path = apiPaths.channelMessages(opts.conversationId);
  return api<ConversationMessagesDto>(`${path}?${params.toString()}`, {
    signal: opts.signal,
  });
}

/** Initial latest-window GET + bidirectional pagination + live
 *  append on realtime events.
 *
 *  Bidirectional is what lets `usePrimeConversationMessages` replace
 *  the cache with a single around-message page and have the user
 *  scroll either direction from there: `getPreviousPageParam` reads
 *  the first page's `has_more_before`, `getNextPageParam` reads the
 *  last page's `has_more_after`.
 *
 *  Live `message` events are appended to the cache only when the last
 *  page is the tail of the conversation (`has_more_after === false`).
 *  `isAtTail` is the durable window-position signal for "latest"
 *  actions. `hasNewerLiveGap` is narrower: it only means a live message
 *  arrived while the window was not at tail. The gap flag is local hook
 *  state, not React Query meta — meta is static, and the gap must drive
 *  UI rerenders.
 */
export function useChannelMessages(
  channelId: string | null,
) {
  const qc = useQueryClient();
  const [hasNewerLiveGap, setHasNewerLiveGap] = useState(false);

  // Reset the gap whenever the consumer switches conversations —
  // a stale "new messages below" hint from the previous channel
  // would be both wrong and confusing.
  useEffect(() => {
    setHasNewerLiveGap(false);
  }, [channelId]);

  const query = useInfiniteQuery<
    ConversationMessagesDto,
    Error,
    InfiniteData<ConversationMessagesDto, MessagesPageParam>,
    ReturnType<typeof messagesKey>,
    MessagesPageParam
  >({
    queryKey: messagesKey(channelId ?? 'none'),
    enabled: !!channelId,
    initialPageParam: undefined as MessagesPageParam,
    queryFn: async ({ pageParam, signal }) =>
      fetchMessagesWindow({
        conversationId: channelId!,
        pageParam,
        limit: MESSAGE_PAGE_LIMIT,
        signal,
      }),
    getPreviousPageParam: firstPage => {
      if (!firstPage.has_more_before) return undefined;
      // Pending optimistic messages carry `id: 'pending-<uuid>'` and
      // `seq: Date.now()` — feeding that epoch-ms cursor to
      // `before_seq` would make the route return the entire history.
      // Skip them so the cursor always reflects a real DB seq. The
      // common case (no temp at the head) still resolves to
      // `messages[0]` in O(1).
      const firstReal = firstPage.messages.find(
        m => !m.id.startsWith('pending-'),
      );
      return firstReal ? { kind: 'before', seq: firstReal.seq } : undefined;
    },
    getNextPageParam: lastPage => {
      if (!lastPage.has_more_after || lastPage.messages.length === 0) {
        return undefined;
      }
      // Symmetric to getPreviousPageParam: filter out optimistic
      // temps so `after_seq` never sees an epoch-ms cursor.
      for (let i = lastPage.messages.length - 1; i >= 0; i--) {
        const m = lastPage.messages[i]!;
        if (!m.id.startsWith('pending-')) {
          return { kind: 'after', seq: m.seq };
        }
      }
      return undefined;
    },
  });

  // Whether the cached window reaches the conversation tail. This is
  // deliberately separate from `hasNewerLiveGap`: a saved-message jump
  // can land in mid-history even when no new live message has arrived.
  const isAtTail = query.data
    ? lastPageIsTail(query.data as MessagesCache)
    : true;

  // Whenever the cache shape implies the window is back at tail, clear
  // the live-gap flag. Reaching tail can happen via three paths:
  //   1. user scrolled forward enough that `fetchNextPage` returned
  //      a page with `has_more_after: false`,
  //   2. `primeAround` happened to land on a window that already
  //      includes the tail (e.g. the saved message is recent),
  //   3. `resetToLatest` re-fetched the latest window.
  // Without this effect the gap would stay true forever once it
  // flipped, making the "scroll to latest" affordance lie.
  useEffect(() => {
    if (isAtTail) setHasNewerLiveGap(false);
  }, [isAtTail]);

  const messages = useMemo(
    () => query.data?.pages.flatMap(page => page.messages) ?? [],
    [query.data],
  );

  // Per-root reply counts (cut3-6 sidecar). Each page carries the full,
  // pagination-independent count for every root in its window, so merging
  // pages (later pages win) yields the authoritative count for each root
  // currently visible in the main stream. Drives the inline "{N} Reply"
  // badge on main-line message rows.
  const replyCountsByRoot = useMemo(() => {
    const merged: Record<string, number> = {};
    for (const page of query.data?.pages ?? []) {
      for (const [rootId, count] of Object.entries(page.reply_counts_by_root)) {
        merged[rootId] = count;
      }
    }
    return merged;
  }, [query.data]);

  // Per-root enriched reply-badge summaries (P1, #task:1073). Optional
  // sidecar — merged page-by-page like the counts (later pages win). Absent
  // until the backend ships `reply_summaries_by_root`; an empty map then
  // means every badge renders count-only.
  const replySummariesByRoot = useMemo(() => {
    const merged: Record<string, ReplyBadgeSummary> = {};
    for (const page of query.data?.pages ?? []) {
      if (!page.reply_summaries_by_root) continue;
      for (const [rootId, summary] of Object.entries(
        page.reply_summaries_by_root,
      )) {
        merged[rootId] = summary;
      }
    }
    return merged;
  }, [query.data]);

  /** Reset the active query to the latest window. We do NOT keep the
   *  previous pages here: an around-message window may not be
   *  contiguous with latest, and stitching disjoint ranges would
   *  invalidate before/after cursors on either side. */
  const resetToLatest = useCallback(() => {
    if (!channelId) return;
    setHasNewerLiveGap(false);
    void qc.resetQueries({ queryKey: messagesKey(channelId), exact: true });
  }, [qc, channelId]);

  const onEvent = useCallback(
    (e: ConversationStreamEvent) => {
      if (!channelId) return;
      if (e.kind === 'connected' && e.payload?.snapshot_required) {
        // A reconnect can mean the window we hold is stale — the
        // safest reconciliation is to drop back to latest. The user
        // already lost some events while disconnected; surfacing the
        // tail beats keeping a frozen mid-history window.
        setHasNewerLiveGap(false);
        void qc.invalidateQueries({ queryKey: messagesKey(channelId) });
        return;
      }
      if (e.kind === 'message') {
        const msg = e.payload?.message as MessageDto | undefined;
        if (!msg) return;
        // Reply-cluster: replies live only in their cluster panel, never
        // inline in the main stream (cut3-6 — the main window excludes
        // `thread_root_id != null`). A live reply must not be appended
        // here; it only bumps its root's reply-count badge. The cluster's
        // own `useThreadCluster` window appends it for the open panel.
        if (msg.thread_root_id !== null) {
          // System events (e.g. task claim/status) can now carry a
          // `thread_root_id` — they attribute to the cluster's stream
          // (#task:1053) — but they are NOT replies. Only non-system rows
          // bump the badge, mirroring the cut3-6 sidecar (which excludes
          // system) and `useThreadRoot`'s live bump. Either way the row
          // never appends to the main stream.
          if (msg.from_kind !== 'system') {
            qc.setQueryData<MessagesCache>(messagesKey(channelId), prev =>
              bumpReplyCountInCache(prev, msg.thread_root_id!, 1, msg),
            );
          }
          return;
        }
        const cur = qc.getQueryData<MessagesCache>(messagesKey(channelId));
        if (!lastPageIsTail(cur)) {
          // Window doesn't include the tail — don't lie. Mark the
          // gap so the UI can show "scroll to latest"; the user
          // will reset the window when they're ready.
          setHasNewerLiveGap(true);
          return;
        }
        qc.setQueryData<MessagesCache>(messagesKey(channelId), prev =>
          appendMessageToCache(prev, msg),
        );
      }
      if (e.kind === 'task_changed') {
        const task = e.payload as TaskChangedEvent | undefined;
        if (!task?.message_id) return;
        applyTaskChangedToTaskByNumberCache(qc, task);
        qc.setQueryData<MessagesCache>(messagesKey(channelId), prev =>
          applyTaskChangedToCache(prev, task),
        );
      }
    },
    [qc, channelId],
  );
  useConversationStream(channelId, onEvent);

  return {
    ...query,
    data: messages,
    isAtTail,
    hasNewerLiveGap,
    resetToLatest,
    replyCountsByRoot,
    replySummariesByRoot,
  };
}

/** Read window for one reply cluster: the root message plus its replies,
 *  served by the cut3-4 `GET /api/channels/:id/messages?thread_root_id=`
 *  route. Distinct cache key from the channel's main stream so the two
 *  windows never cross-contaminate.
 *
 *  Replies arrive on the *channel* realtime stream (the cluster is not a
 *  separate conversation), so this hook subscribes to the channel and
 *  filters live `message` events down to this root's cluster — appending
 *  at tail just like the main window. The parent channel's main-stream
 *  hook independently bumps the reply-count badge for the same event. */
export function useThreadCluster(
  channelId: string | null,
  rootMessageId: string | null,
) {
  const qc = useQueryClient();
  const enabled = !!channelId && !!rootMessageId;
  const key = clusterMessagesKey(channelId ?? 'none', rootMessageId ?? 'none');

  const [hasNewerLiveGap, setHasNewerLiveGap] = useState(false);

  // Reset the gap when the consumer switches channel or thread — a stale
  // "newer replies below" hint from the previous cluster would be wrong.
  useEffect(() => {
    setHasNewerLiveGap(false);
  }, [channelId, rootMessageId]);

  const query = useInfiniteQuery<
    ConversationMessagesDto,
    Error,
    InfiniteData<ConversationMessagesDto, MessagesPageParam>,
    ReturnType<typeof clusterMessagesKey>,
    MessagesPageParam
  >({
    queryKey: key,
    enabled,
    initialPageParam: undefined as MessagesPageParam,
    queryFn: async ({ pageParam, signal }) =>
      fetchMessagesWindow({
        conversationId: channelId!,
        threadRootId: rootMessageId!,
        pageParam,
        limit: MESSAGE_PAGE_LIMIT,
        signal,
      }),
    getPreviousPageParam: firstPage => {
      if (!firstPage.has_more_before) return undefined;
      const firstReal = firstPage.messages.find(
        m => !m.id.startsWith('pending-'),
      );
      return firstReal ? { kind: 'before', seq: firstReal.seq } : undefined;
    },
    getNextPageParam: lastPage => {
      if (!lastPage.has_more_after || lastPage.messages.length === 0) {
        return undefined;
      }
      for (let i = lastPage.messages.length - 1; i >= 0; i--) {
        const m = lastPage.messages[i]!;
        if (!m.id.startsWith('pending-')) {
          return { kind: 'after', seq: m.seq };
        }
      }
      return undefined;
    },
  });

  const messages = useMemo(
    () => query.data?.pages.flatMap(page => page.messages) ?? [],
    [query.data],
  );

  // Whether the cached cluster window reaches the thread tail. A cluster
  // can be mid-history after an around-reply jump: `primeAround` with a
  // `threadRootId` commits an around-window into this SAME cache, so this
  // is NOT always true — it mirrors `useChannelMessages.isAtTail`.
  const isAtTail = query.data
    ? lastPageIsTail(query.data as MessagesCache)
    : true;

  // Clear the gap whenever the window is back at tail (forward scroll
  // reached it, a jump landed on a tail-inclusive window, or
  // `resetToLatest` re-fetched it). Without this the hint would latch true.
  useEffect(() => {
    if (isAtTail) setHasNewerLiveGap(false);
  }, [isAtTail]);

  // Reset the cluster query to the latest (tail) window. We drop the
  // around-window pages: an around-reply window may not be contiguous with
  // the tail, and stitching disjoint ranges would corrupt the cursors.
  const resetToLatest = useCallback(() => {
    if (!channelId || !rootMessageId) return;
    setHasNewerLiveGap(false);
    void qc.resetQueries({ queryKey: key, exact: true });
  }, [qc, channelId, rootMessageId, key]);

  const onEvent = useCallback(
    (e: ConversationStreamEvent) => {
      if (!channelId || !rootMessageId) return;
      if (e.kind === 'connected' && e.payload?.snapshot_required) {
        setHasNewerLiveGap(false);
        void qc.invalidateQueries({ queryKey: key });
        return;
      }
      if (e.kind === 'message') {
        const msg = e.payload?.message as MessageDto | undefined;
        if (!msg) return;
        // Only this cluster's rows: a reply (`thread_root_id === root`) or
        // an edit of the root itself. Main-line and other clusters are
        // ignored here.
        if (msg.thread_root_id !== rootMessageId && msg.id !== rootMessageId) {
          return;
        }
        const cur = qc.getQueryData<MessagesCache>(key);
        // Only append when the cached window still reaches the tail. After
        // an around-reply jump the window is mid-history; appending there
        // would lie about position, so mark the forward gap instead and let
        // the UI offer "jump to latest" (mirrors useChannelMessages).
        if (!lastPageIsTail(cur)) {
          setHasNewerLiveGap(true);
          return;
        }
        qc.setQueryData<MessagesCache>(key, prev =>
          appendMessageToCache(prev, msg),
        );
      }
      if (e.kind === 'task_changed') {
        const task = e.payload as TaskChangedEvent | undefined;
        if (!task?.message_id) return;
        qc.setQueryData<MessagesCache>(key, prev =>
          applyTaskChangedToCache(prev, task),
        );
      }
    },
    [qc, channelId, rootMessageId, key],
  );
  useConversationStream(enabled ? channelId : null, onEvent);

  return { ...query, data: messages, isAtTail, hasNewerLiveGap, resetToLatest };
}

/** Pinned-root context for a thread (reply cluster). The root message is
 *  the anchor of the thread and must stay visible regardless of how the
 *  reply pagination window scrolls, so it is fetched independently of the
 *  tail-anchored `useThreadCluster` window.
 *
 *  A single main-stream `around_message_id=<root>&limit=1` read yields
 *  BOTH the root message object AND the authoritative cut3-6
 *  `reply_counts_by_root[root]` (the backend's main-stream window branch
 *  computes the sidecar for every root in the window — see
 *  `routes/conversations.ts`). This decouples "show the root + full reply
 *  count" from "page through replies", satisfying the invariant that the
 *  root is stably pinned and the header count is authoritative (not a
 *  loaded-rows count).
 *
 *  The live reply-count bump mirrors cut3-6 semantics: only non-system
 *  replies to this exact root increment the count. */
export function useThreadRoot(
  channelId: string | null,
  rootMessageId: string | null,
) {
  const qc = useQueryClient();
  const enabled = !!channelId && !!rootMessageId;
  const key = [
    'channels',
    channelId ?? 'none',
    'thread-root',
    rootMessageId ?? 'none',
  ] as const;

  const query = useQuery<ConversationMessagesDto>({
    queryKey: key,
    enabled,
    queryFn: ({ signal }) =>
      fetchMessagesWindow({
        conversationId: channelId!,
        aroundMessageId: rootMessageId!,
        limit: 1,
        signal,
      }),
  });

  const onEvent = useCallback(
    (e: ConversationStreamEvent) => {
      if (!rootMessageId) return;
      if (e.kind !== 'message') return;
      const msg = e.payload?.message as MessageDto | undefined;
      if (!msg) return;
      // Mirror cut3-6 count semantics: only non-system replies to this
      // exact root advance the authoritative count.
      if (msg.thread_root_id !== rootMessageId || msg.from_kind === 'system') {
        return;
      }
      qc.setQueryData<ConversationMessagesDto>(key, prev => {
        if (!prev) return prev;
        const current = prev.reply_counts_by_root[rootMessageId] ?? 0;
        return {
          ...prev,
          reply_counts_by_root: {
            ...prev.reply_counts_by_root,
            [rootMessageId]: current + 1,
          },
        };
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [qc, rootMessageId, key.join(':')],
  );
  useConversationStream(enabled ? channelId : null, onEvent);

  const root =
    query.data?.messages.find(m => m.id === rootMessageId) ?? null;
  const replyCount = rootMessageId
    ? query.data?.reply_counts_by_root[rootMessageId] ?? 0
    : 0;

  return {
    root,
    replyCount,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}

/** Cache key for one reply cluster's human-follower state (cut3 slice B). */
const threadFollowersKey = (cid: string, rootId: string) =>
  ['channels', cid, 'thread-followers', rootId] as const;

/** Human follower state for one reply cluster: whether the current viewer
 *  is subscribed, plus the agent followers still visible in the parent
 *  channel. Drives the ThreadPanel follow toggle / context-menu unfollow
 *  (item 5) and the activity-bubble follower filter (item 4).
 *
 *  Backed by `GET /api/channels/:id/threads/:rootMessageId/followers`. The
 *  root id may be the root message or any reply in the cluster — the
 *  backend normalizes it. */
export function useThreadFollowers(
  channelId: string | null,
  rootMessageId: string | null,
) {
  const qc = useQueryClient();
  const enabled = !!channelId && !!rootMessageId;
  const key = threadFollowersKey(channelId ?? 'none', rootMessageId ?? 'none');
  const query = useQuery<ThreadFollowerStateDto>({
    queryKey: key,
    enabled,
    queryFn: ({ signal }) =>
      api<ThreadFollowerStateDto>(
        apiPaths.channelThreadFollowers(channelId!, rootMessageId!),
        { signal },
      ),
  });

  // The follower set is mutated as a SIDE EFFECT of thread messages:
  // backend auto-follows the author / target / @-mentioned agents on each
  // reply (reply / mention / target_author paths). So this snapshot must
  // track the thread message stream — without it, an open panel keeps a
  // stale `follower_agent_ids` (wrong activity-bubble allow-list) and stale
  // `viewer_following` after someone replies / @-mentions in the cluster.
  // Mirror `useThreadCluster`'s event filter: any reply to this root (or a
  // reconnect that needs a fresh snapshot) invalidates and refetches.
  const onEvent = useCallback(
    (e: ConversationStreamEvent) => {
      if (!rootMessageId) return;
      if (e.kind === 'connected' && e.payload?.snapshot_required) {
        void qc.invalidateQueries({ queryKey: key });
        return;
      }
      if (e.kind !== 'message') return;
      const msg = e.payload?.message as MessageDto | undefined;
      if (!msg) return;
      if (msg.thread_root_id !== rootMessageId && msg.id !== rootMessageId) {
        return;
      }
      void qc.invalidateQueries({ queryKey: key });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [qc, rootMessageId, key.join(':')],
  );
  useConversationStream(enabled ? channelId : null, onEvent, 'channel');

  return query;
}

/** Subscribe the current human viewer to a reply cluster
 *  (`POST .../follow`). Idempotent server-side; we refetch follower state
 *  on success so the toggle + bubble reflect the new membership. */
export function useFollowThread(
  channelId: string | null,
  rootMessageId: string | null,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      if (!channelId || !rootMessageId) throw new Error('no thread selected');
      return api<ThreadFollowMutationDto>(
        apiPaths.channelThreadFollow(channelId, rootMessageId),
        { method: 'POST' },
      );
    },
    onSuccess: () => {
      if (!channelId || !rootMessageId) return;
      void qc.invalidateQueries({
        queryKey: threadFollowersKey(channelId, rootMessageId),
      });
    },
    onError: () => {
      toast.error('关注失败,请重试');
    },
  });
}

/** Unsubscribe the current human viewer from a reply cluster
 *  (`DELETE .../follow`). A later reply / mention re-follows automatically
 *  (backend behavior) — unfollow only stops delivery, not visibility. */
export function useUnfollowThread(
  channelId: string | null,
  rootMessageId: string | null,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      if (!channelId || !rootMessageId) throw new Error('no thread selected');
      return api<ThreadFollowMutationDto>(
        apiPaths.channelThreadFollow(channelId, rootMessageId),
        { method: 'DELETE' },
      );
    },
    onSuccess: () => {
      if (!channelId || !rootMessageId) return;
      void qc.invalidateQueries({
        queryKey: threadFollowersKey(channelId, rootMessageId),
      });
    },
    onError: () => {
      toast.error('取消关注失败,请重试');
    },
  });
}

/** Independent helper for "prime the messages cache around message X
 *  for any conversation". Lives in its own hook so the App-level
 *  jump path doesn't depend on `useChannelMessages` being mounted
 *  for the target conversation (which would be a footgun on jumps
 *  that swap the active channel). The hook holds no state — it
 *  only exposes a stable `primeAround` function bound to the
 *  current `QueryClient`.
 *
 *  Stale-guard contract: the App passes `shouldCommit?: () =>
 *  boolean`. After the network request resolves, we re-check
 *  `shouldCommit()` immediately before `setQueryData`; if it
 *  returns false we discard the response. This keeps the utility
 *  oblivious to "current jump target" — App owns that decision.
 */
export function usePrimeConversationMessages() {
  const qc = useQueryClient();

  const primeAround = useCallback(
    async (
      conversationId: string,
      messageId: string,
      opts?: {
        shouldCommit?: () => boolean;
        signal?: AbortSignal;
        /** When set, prime the reply cluster rooted at this message id
         *  rather than the conversation's main stream. The window is
         *  fetched via `?thread_root_id=` and committed to
         *  `clusterMessagesKey(conversationId, threadRootId)`, which is
         *  exactly the cache `useThreadCluster` reads — so a cluster jump
         *  lands on the right window instead of 404-ing against the main
         *  stream (whose anchor requires `thread_root_id IS NULL`). */
        threadRootId?: string;
      },
    ): Promise<{ committed: boolean; reason?: 'stale' | 'aborted' | 'not_found' }> => {
      // A cluster target writes to the cluster cache; everything else to
      // the main stream cache. Both the fetch scope and the commit key must
      // agree, or we'd prime one window and read another.
      const cacheKey = opts?.threadRootId
        ? clusterMessagesKey(conversationId, opts.threadRootId)
        : messagesKey(conversationId);
      try {
        if (opts?.signal?.aborted) return { committed: false, reason: 'aborted' };
        const page = await fetchMessagesWindow({
          conversationId,
          aroundMessageId: messageId,
          threadRootId: opts?.threadRootId,
          limit: AROUND_MESSAGE_LIMIT,
          // Plumb signal into the underlying fetch so an abort on the
          // App side actually cancels the in-flight request, not just
          // the post-response commit. Without this, callers that only
          // pass `signal` (and not `shouldCommit`) would still race
          // against the network round-trip.
          signal: opts?.signal,
        });
        if (opts?.signal?.aborted) return { committed: false, reason: 'aborted' };
        if (opts?.shouldCommit && !opts.shouldCommit()) {
          return { committed: false, reason: 'stale' };
        }
        // Cancel any in-flight latest/before/after fetch so React
        // Query doesn't overwrite our prime with a stale response.
        await qc.cancelQueries({
          queryKey: cacheKey,
          exact: true,
        });
        // `cancelQueries` is async — by the time it resolves the
        // user may have clicked another saved message. Re-check both
        // guards before committing so we never write a stale window
        // that the App has already moved past.
        if (opts?.signal?.aborted) return { committed: false, reason: 'aborted' };
        if (opts?.shouldCommit && !opts.shouldCommit()) {
          return { committed: false, reason: 'stale' };
        }
        // Replace the entire cache with this single window. The
        // around window may not be contiguous with whatever the
        // hook held before, so stitching is unsafe; the hook will
        // page outward from here using before/after cursors.
        qc.setQueryData<MessagesCache>(
          cacheKey,
          makeMessagesCache(page, undefined),
        );
        return { committed: true };
      } catch (err) {
        // Aborted fetches surface as DOMException 'AbortError'; treat
        // as a non-error stale path so callers don't have to wrap.
        if (
          (err as { name?: string } | null)?.name === 'AbortError' ||
          opts?.signal?.aborted
        ) {
          return { committed: false, reason: 'aborted' };
        }
        // 404 from the backend means the message id is not in this
        // conversation. Surface that to App so it can clear the
        // jump target instead of spinning on a phantom.
        if (err instanceof ApiError && err.status === 404) {
          return { committed: false, reason: 'not_found' };
        }
        throw err;
      }
    },
    [qc],
  );

  return { primeAround };
}

/** Initial GET + live update on `agent_status` realtime events. */
export function useChannelAgents(
  channelId: string | null,
) {
  const qc = useQueryClient();
  const pendingStatusPatches = useRef<Map<string, ConversationAgentStatusPatch>>(
    new Map(),
  );

  useEffect(() => {
    pendingStatusPatches.current.clear();
  }, [channelId]);

  const query = useQuery({
    queryKey: channelId ? agentsKey(channelId) : ['channels', 'none', 'agents'],
    enabled: !!channelId,
    queryFn: async () => {
      const res = await api<{ agents: ConversationAgentDto[] }>(
        apiPaths.channelAgents(channelId!),
      );
      return applyPendingSessionAgentPatches(
        res.agents,
        pendingStatusPatches.current,
      );
    },
  });

  const onEvent = useCallback(
    (e: ConversationStreamEvent) => {
      if (channelId && e.kind === 'connected') {
        pendingStatusPatches.current.clear();
        if (e.payload?.snapshot_required) {
          void qc.invalidateQueries({ queryKey: agentsKey(channelId) });
        }
        return;
      }

      if (!channelId || e.kind !== 'agent_status') return;
      const p = e.payload as ConversationAgentStatusPatch;
      if (!p?.agent_id) return;

      const prevPatch = pendingStatusPatches.current.get(p.agent_id);
      pendingStatusPatches.current.set(p.agent_id, {
        ...prevPatch,
        ...p,
      });

      const key = agentsKey(channelId);
      const current = qc.getQueryData<ConversationAgentDto[]>(key);
      const hasCurrentRow = current?.some(a => a.agent_id === p.agent_id) ?? false;

      qc.setQueryData<ConversationAgentDto[]>(key, prev =>
        prev ? prev.map(a => applySessionAgentPatch(a, p)) : prev,
      );

      if (!hasCurrentRow) {
        void qc.invalidateQueries({ queryKey: key });
      }
    },
    [qc, channelId],
  );
  useConversationStream(channelId, onEvent);

  return query;
}

export interface SendMessageInput {
  content: string;
  attachments?: AttachmentDto[];
}

export function useSendMessage(
  channelId: string | null,
  /** When set, the message is a reply into this root's cluster: the
   *  request carries `reply_to_message_id` and all optimistic cache
   *  writes target the cluster window (`clusterMessagesKey`) instead of
   *  the channel's main stream. The reply's reply-count badge on the main
   *  stream is bumped by the live `message` event, not here. */
  threadRootId?: string | null,
) {
  const qc = useQueryClient();
  // Optimistic writes land wherever the reply will actually be read: the
  // cluster window for a reply, the main stream otherwise.
  const targetKey =
    channelId && threadRootId
      ? clusterMessagesKey(channelId, threadRootId)
      : channelId
        ? messagesKey(channelId)
        : null;
  return useMutation({
    mutationFn: async (input: SendMessageInput) => {
      if (!channelId) throw new Error('no channel selected');
      const path = apiPaths.channelMessages(channelId);
      const body: {
        content: string;
        attachment_ids?: string[];
        reply_to_message_id?: string;
      } = {
        content: input.content,
      };
      if (input.attachments && input.attachments.length > 0) {
        body.attachment_ids = input.attachments.map(a => a.id);
      }
      if (threadRootId) {
        body.reply_to_message_id = threadRootId;
      }
      const res = await api<{ message: MessageDto }>(
        path,
        { method: 'POST', body: JSON.stringify(body) },
      );
      return res.message;
    },
    // Optimistic update: show the message immediately on Enter, before
    // the HTTP response arrives. The temp message uses a `pending-` id;
    // onSuccess replaces it with the real row (live de-dupe prevents a
    // second append when the event arrives after onSuccess).
    onMutate: async (input: SendMessageInput) => {
      if (!channelId || !targetKey) return undefined;
      const key = targetKey;
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<MessagesCache>(key);
      // Invariant: never append optimistic messages to a non-tail
      // window. If the user is browsing an `around_message_id` window
      // (or any other state where `lastPage.has_more_after === true`),
      // appending here would visually attach the new message to the
      // mid-history view, which is a lie about position. Rebuild the
      // cache as a tail-only single page so the optimistic insert
      // — and any subsequent live appends — land on a real tail.
      // `has_more_before: true` lets the user scroll up to fetch
      // earlier history once the latest window is established.
      // Rollback is preserved by the captured `prev` baseline above.
      if (prev && !lastPageIsTail(prev)) {
        qc.setQueryData<MessagesCache>(key, {
          pages: [
            {
              messages: [],
              reply_counts_by_root: {},
              has_more_before: true,
              has_more_after: false,
            },
          ],
          pageParams: [undefined as MessagesPageParam],
        });
      }
      const tempId = `pending-${crypto.randomUUID()}`;
      const snapshots: AttachmentSnapshot[] | null =
        input.attachments && input.attachments.length > 0
          ? input.attachments.map(a => ({
              id: a.id,
              filename: a.filename,
              size: a.size,
              content_type: a.content_type,
            }))
          : null;
      const tempMsg: MessageDto = {
        id: tempId,
        conversation_id: channelId,
        from_kind: 'user',
        from_agent_id: null,
        from_user_id: getCurrentUserId(),
        content: input.content,
        metadata: null,
        attachments: snapshots,
        seq: Date.now(),
        created_at: Date.now(),
        thread_root_id: threadRootId ?? null,
        task_number: null,
        task_status: null,
        task_assignee: null,
        task_title: null,
        task_workspace_id: null,
        task_closed_at: null,
      };
      qc.setQueryData<MessagesCache>(key, cur =>
        appendMessageToCache(cur, tempMsg),
      );
      return { prev, tempId };
    },
    onSuccess: (msg, _input, ctx) => {
      if (!targetKey || !ctx) return;
      qc.setQueryData<MessagesCache>(targetKey, cur =>
        replacePendingMessageInCache(cur, ctx.tempId, msg),
      );
    },
    onError: (_err, _input, ctx) => {
      if (!targetKey || !ctx) return;
      // Roll back optimistic message so the user doesn't see a ghost.
      if (ctx.prev) {
        qc.setQueryData<MessagesCache>(targetKey, ctx.prev);
      } else {
        qc.setQueryData<MessagesCache | undefined>(targetKey, cur =>
          removeMessageFromCache(cur, ctx.tempId),
        );
      }
    },
  });
}

export function useStartAgent(
  channelId: string | null,
) {
  return useMutation({
    mutationFn: async (agentId: string) => {
      if (!channelId) throw new Error('no channel selected');
      const path = apiPaths.channelAgentStart(channelId, agentId);
      await api(path, {
        method: 'POST',
      });
    },
    onError: err => {
      toast.error(formatStartAgentError(err));
    },
  });
}

export function useStopAgent(
  channelId: string | null,
) {
  return useMutation({
    mutationFn: async (params: {
      agentId: string;
      mode?: 'soft' | 'hard';
      directive?: string;
      }) => {
      if (!channelId) throw new Error('no channel selected');
      const path = apiPaths.channelAgentStop(channelId, params.agentId);
      await api(path, {
        method: 'POST',
        body: JSON.stringify({
          mode: params.mode ?? 'hard',
          ...(params.directive ? { directive: params.directive } : {}),
        }),
      });
    },
  });
}

export function useClearAgentSession(
  channelId: string | null,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (agentId: string) => {
      if (!channelId) throw new Error('no channel selected');
      const path = apiPaths.channelAgentClearSession(channelId, agentId);
      return api<ClearSessionResponse>(path, { method: 'POST' });
    },
    onSuccess: (res, agentId) => {
      if (!channelId) return;
      qc.setQueryData<ConversationAgentDto[]>(agentsKey(channelId), prev =>
        prev
          ? prev.map(agent =>
              agent.agent_id === agentId
                ? {
                    ...agent,
                    cli_session_id: null,
                    ...(res.was_running ? { status: 'idle' as const, pid: null } : {}),
                  }
                : agent,
            )
          : prev,
      );
    },
  });
}

/**
 * Remove an agent from THIS conversation only (human-triggered leave —
 * #task:957). The backend route `DELETE /api/conversations/:id/members/
 * agents/:agentId` (Cindy) stops the agent's runtime here, drops the
 * membership row, and emits a "member removed" system narration. The
 * path is conversation-kind agnostic — it works for both channels and
 * threads, so no `routeKind` branch is needed.
 *
 * Permission (agent owner OR workspace owner/admin) is enforced
 * server-side; the popover hides the control otherwise via
 * `canRemoveAgentFromChannel`, and this hook surfaces a toast if the
 * server still rejects (stale role, concurrent change).
 */
export function useRemoveAgentFromChannel(channelId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (agentId: string) => {
      if (!channelId) throw new Error('no channel selected');
      await api(apiPaths.conversationAgentMember(channelId, agentId), {
        method: 'DELETE',
      });
    },
    onSuccess: (_res, agentId) => {
      if (!channelId) return;
      // Drop the removed agent from the per-conversation roster cache so
      // the member strip / popover update immediately; the backend's
      // `conversation_members_changed` event reconciles other windows.
      qc.setQueryData<ConversationAgentDto[]>(agentsKey(channelId), prev =>
        prev ? prev.filter(a => a.agent_id !== agentId) : prev,
      );
      // The header member-chip strip reads from a *separate* cache
      // (`['conversation-members', id]` via `useConversationMembers`), so
      // strip the removed agent there too — otherwise the chip lingers
      // until the invalidate refetch lands (visible on slow networks).
      // Invalidate stays as the reconciler against the authoritative list.
      qc.setQueryData<ConversationMembersResponse>(
        ['conversation-members', channelId],
        prev =>
          prev
            ? {
                ...prev,
                members: prev.members.filter(
                  m => !(m.kind === 'agent' && m.agent_id === agentId),
                ),
              }
            : prev,
      );
      void qc.invalidateQueries({ queryKey: agentsKey(channelId) });
      void qc.invalidateQueries({
        queryKey: ['conversation-members', channelId],
      });
    },
    onError: err => {
      toast.error(formatRemoveAgentError(err));
    },
  });
}

/**
 * Ephemeral per-agent run states for the current channel.
 *
 * - Initial GET from the channel/thread run-state endpoint (snapshot on
 *   mount / reconnect — returns all currently in-flight states).
 * - Live `agent_activity` events are ingested by the shared conversation stream
 *   layer so the cache stays warm across quick channel/thread navigation.
 */
export function useAgentRunStates(
  channelId: string | null,
) {
  const qc = useQueryClient();
  const key = channelId
    ? agentRunStatesKey(channelId)
    : ['channels', 'none', 'agent-run-states'];
  const query = useQuery({
    queryKey: key,
    enabled: !!channelId,
    queryFn: async () => {
      const requestedAt = Date.now();
      const path = apiPaths.channelAgentRunStates(channelId!);
      const res = await api<AgentRunStatesDto>(
        path,
      );
      return reconcileAgentRunStateSnapshot(
        qc.getQueryData(channelId ? agentRunStatesKey(channelId) : key),
        res.states,
        requestedAt,
      );
    },
    // Don't stale-refetch automatically — realtime events keep this up-to-date.
    staleTime: Infinity,
    // Returning to a channel/thread after unsubscribing can miss terminal
    // activity events; always reconcile against the backend snapshot on mount.
    refetchOnMount: 'always',
    // Keep recent activity visible across quick channel/thread navigation.
    gcTime: AGENT_RUN_STATES_GC_MS,
  });

  const onEvent = useCallback(
    (e: ConversationStreamEvent) => {
      // On (re)connect, snapshot may have drifted — runs may have ended or
      // started while the transport was down. Refetch the snapshot to reconcile;
      // the query function merges any newer live updates that arrived while
      // the snapshot request was in flight.
      if (channelId && e.kind === 'connected' && e.payload?.snapshot_required) {
        void qc.invalidateQueries({ queryKey: agentRunStatesKey(channelId) });
      }
    },
    [qc, channelId],
  );
  useConversationStream(channelId, onEvent);

  return query;
}

/**
 * Notification-backed unread counts per channel. Invalidated by WS
 * viewer-scoped `unread_updated` events — no polling.
 *
 * @deprecated Backed by the notification system (mention_external /
 * agent_start_failed only). Use useMessageUnreadCounts for IM-style
 * message unread badges.
 */
export function useChannelUnreadCounts(workspaceId: string | null) {
  const qc = useQueryClient();
  const queryKey = ['workspaces', workspaceId, 'unread-by-channel'] as const;

  useEffect(() => {
    if (!workspaceId) return;
    const sub = subscribeViewerScope();
    const unsub = onWsFrame(frame => {
      if (frame.type !== 'event') return;
      if (!isCurrentViewerScope(frame.scope)) return;
      if (frame.kind === 'unread_updated' && isMessageUnreadUpdatedPayload(frame.payload)) {
        return;
      }
      if (frame.kind !== 'notification' && frame.kind !== 'unread_updated') return;
      qc.invalidateQueries({ queryKey });
    });
    return () => { sub.unsubscribe(); unsub(); };
  }, [qc, workspaceId]); // eslint-disable-line react-hooks/exhaustive-deps

  return useQuery({
    queryKey,
    enabled: !!workspaceId,
    queryFn: async () => {
      const res = await api<{ counts: Record<string, number> }>(
        `/api/channels/${workspaceId}/unread-by-conversation`,
      );
      return res.counts;
    },
  });
}

/**
 * Per-channel message unread counts for the channels sidebar badge.
 * Backed by the conversation_reads cursor system. Invalidated by WS
 * viewer-scoped `unread_updated` events — no polling.
 */
export function useMessageUnreadCounts(
  workspaceId: string | null,
  workspaceKind: 'regular' | 'dm' | null = 'regular',
) {
  const qc = useQueryClient();
  const queryKey = ['workspaces', workspaceId, workspaceKind, 'message-unread'] as const;

  useEffect(() => {
    if (!workspaceId) return;
    const sub = subscribeViewerScope();
    const unsub = onWsFrame(frame => {
      if (frame.type === 'snapshot_required') {
        if (!isCurrentViewerScope(frame.scope)) return;
        invalidateMessageUnreadQueries(qc);
        return;
      }
      if (frame.type !== 'event') return;
      if (!isCurrentViewerScope(frame.scope)) return;
      if (frame.kind !== 'unread_updated') return;
      if (!isMessageUnreadUpdatedPayload(frame.payload)) return;
      invalidateMessageUnreadQueries(qc);
    });
    return () => { sub.unsubscribe(); unsub(); };
  }, [qc, workspaceId]);

  return useQuery({
    queryKey,
    enabled: !!workspaceId && workspaceKind !== null,
    queryFn: async () => {
      const res = await api<MessageUnreadByConversationDto>(
        `/api/workspaces/${workspaceId}/message-unread`,
      );
      return res;
    },
  });
}

/**
 * Mark all unread notifications for a channel as read.
 * Called whenever the user navigates to a channel so the badge clears.
 *
 * @deprecated Clears notification-based badges only. Use
 * useMarkMessageChannelRead for the conversation_reads cursor system.
 */
export function useMarkChannelRead() {
  return useMutation({
    mutationFn: async (channelId: string) => {
      await api('/api/notifications/read', {
        method: 'POST',
        body: JSON.stringify({ conversation_id: channelId }),
      });
    },
  });
}

 /**
  * Advance the viewer's read cursor for a channel to its latest message.
  * Backed by the conversation_reads cursor — clears message unread badges.
 * The backend resolves the viewer principal from the main-held desktop
 * session bearer, so no body is required.
  */
export function useMarkMessageChannelRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: string | { id: string }) => {
      const channelId = typeof params === 'string' ? params : params.id;
      await api(apiPaths.channelMarkRead(channelId), { method: 'POST' });
    },
    onSuccess: () => {
      // Only unread counters need to refresh after marking a conversation
      // read. Invalidating ['workspaces'] also refetches the channel/tree
      // data, which makes every channel click redo the sidebar thread load.
      invalidateMessageUnreadQueries(qc);
    },
  });
}

/**
 * Global message unread summary across ALL workspaces.
 * Backed by conversation_reads — returns total unread message count per workspace.
 * Used by the workspace sidebar to show per-workspace unread badges.
 * Invalidated by WS viewer-scoped `unread_updated` events — no polling.
 */
export function useMessageUnreadSummary() {
  const qc = useQueryClient();
  const queryKey = ['message-unread', 'summary'] as const;

  useEffect(() => {
    const sub = subscribeViewerScope();
    const unsub = onWsFrame(frame => {
      if (frame.type === 'snapshot_required') {
        if (!isCurrentViewerScope(frame.scope)) return;
        invalidateMessageUnreadQueries(qc);
        return;
      }
      if (frame.type !== 'event') return;
      if (!isCurrentViewerScope(frame.scope)) return;
      if (frame.kind !== 'unread_updated') return;
      if (!isMessageUnreadUpdatedPayload(frame.payload)) return;
      invalidateMessageUnreadQueries(qc);
    });
    return () => { sub.unsubscribe(); unsub(); };
  }, [qc]);

  return useQuery({
    queryKey,
    queryFn: () =>
      api<{ by_workspace: Record<string, number> }>(apiPaths.messageUnreadSummary),
  });
}
