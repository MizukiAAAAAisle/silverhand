import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import type {
  AgentRunStatesDto,
  AttachmentDto,
  AttachmentSnapshot,
  ClearSessionResponse,
  ConversationAgentDto,
  ConversationMembersResponse,
  ConversationMessagesDto,
  ConversationStreamUnreadDto,
  MessageDto,
  MessageReactionChangedEvent,
  MessageUnreadByConversationDto,
  ReactionAggregateDto,
  ReplyBadgeSummary,
  TaskChangedEvent,
  ThreadFollowerStateDto,
  ThreadFollowMutationDto,
} from '@silverhand/shared';
import { apiPaths } from '@silverhand/shared';
import { api, ApiError } from '@/lib/api';
import { messageReactorsKey } from '@/features/channels/reaction-hooks';
import { channelThreadsKey } from '@/features/channels/useChannelThreads';
import { getCurrentUserId } from '@/lib/current-user';
import { onWsFrame, subscribeViewerScope, isCurrentViewerScope, subscribeWsScope } from '@/lib/ws-client';
import { useInterest } from '@/features/realtime/interest-registry';
import {
  AGENT_RUN_STATES_GC_MS,
  agentRunStatesKey,
  reconcileAgentRunStateSnapshot,
} from '@/lib/agentRunStateCache';
import { wsConversationScope, wsConversationSideScope } from '@/hooks/useConversationStream';
import { applyTaskChangedToTaskByNumberCache } from '@/features/tasks/useTaskByNumber';
import { clusterInitialFetchEnabled } from '@/components/layout/threadMarkRead';
import {
  mainlineStreamSourceHead,
  postObserve,
  streamSourceAtSeq,
} from '@/features/attention/observe';

export const messagesKey = (cid: string) =>
  ['channels', cid, 'messages'] as const;
/** Cache key for one reply cluster's window. A cluster lives in the same
 *  channel conversation as its root (rows with `thread_root_id = rootId`),
 *  so it is keyed off the channel id plus the root message id — distinct
 *  from the main-stream window (`messagesKey`) which excludes replies. */
export const clusterMessagesKey = (cid: string, rootId: string) =>
  ['channels', cid, 'cluster', rootId, 'messages'] as const;
/** Cache key carrying the "this-open window fetch succeeded" epoch (ms) for a
 *  reply cluster (#task:1226 §9/§9.10). Written on the success path by both
 *  `useThreadCluster`'s queryFn AND `primeAround`'s around-target fetch, so a
 *  jump open arms the mark-read freshness gate the same way a normal open does.
 *  Deliberately separate from `clusterMessagesKey` so `setQueryData` appends to
 *  the window (live reply / optimistic patch) never advance it. */
export const clusterFetchEpochKey = (cid: string, rootId: string) =>
  ['channels', cid, 'cluster', rootId, 'fetch-epoch'] as const;
/** Cache key for the thread pane's root row. The root message lives in the
 *  main stream, but ThreadPanel loads it through its own single-row window
 *  query so the pane can mount independently of the channel list. */
export const threadRootKey = (cid: string, rootId: string) =>
  ['channels', cid, 'thread-root', rootId] as const;
/** Cache key for one reply cluster's human-follower state (cut3 slice B). */
const threadFollowersKey = (cid: string, rootId: string) =>
  ['channels', cid, 'thread-followers', rootId] as const;
const agentsKey = (cid: string) => ['channels', cid, 'agents'] as const;
/** Per-window UI-affordance fact (#task:1255 Stage-2): a live mainline message
 *  arrived while this window was NOT at tail, so the UI offers "scroll to
 *  latest" instead of lying with an append. It is NOT the message cache and NOT
 *  a read/cursor input — purely a hint. Stage-2 moves the SET onto the central
 *  conversation ingestor (so the reader view holds zero `onWsFrame`); the view
 *  keeps the position-based CLEARS (channel switch / reached tail / reset),
 *  which are explicit-helper writes of this affordance key, never a frame apply
 *  and never the message cache. See docs/renderer-event-ingestion-v1.md §5. */
export const mainlineLiveGapKey = (cid: string) =>
  ['channels', cid, 'live-gap', 'mainline'] as const;
/** Per-cluster sibling of {@link mainlineLiveGapKey} (#task:1255 Stage-2 P1b):
 *  a live reply arrived while THIS cluster window was not at tail. Same
 *  contract — ingestor SETs, the reader view CLEARs on position changes. */
export const clusterLiveGapKey = (cid: string, rootId: string) =>
  ['channels', cid, 'cluster', rootId, 'live-gap'] as const;
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

export type ConversationAgentStatusPatch = Pick<ConversationAgentDto, 'agent_id'> &
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

// ─── Stage-2 P1c: channel agents (agent_status) ingestor buffer ──────────────
// `useChannelAgents` used a hook-local `useRef` buffer so a live `agent_status`
// that arrives WHILE the snapshot GET is in flight isn't lost when the snapshot
// replaces the cache (the queryFn replays the buffer onto the fresh snapshot).
// To make the hook a pure reader (#task:1255 P1c) the buffer moves here, keyed
// per channel, written by the central ingestor and drained by the queryFn. A
// channel can have MORE THAN ONE `useChannelAgents` reader at once (e.g.
// ChannelView + an AgentInfoPopover surface), so the buffer is refcounted: it is
// cleared only when the LAST reader for that channel leaves. A naive
// clear-on-any-unmount would wipe a still-mounted reader's in-flight snapshot
// buffer and drop a live `agent_status` patch (Cindy P1c #1 blocker). This
// mirrors the old per-hook ref, where one hook unmounting never touched another
// hook's buffer.
const pendingAgentStatusPatchesByChannel = new Map<
  string,
  Map<string, ConversationAgentStatusPatch>
>();
const agentStatusBufferRefcount = new Map<string, number>();

function getPendingAgentStatusPatches(
  channelId: string,
): Map<string, ConversationAgentStatusPatch> {
  let buffer = pendingAgentStatusPatchesByChannel.get(channelId);
  if (!buffer) {
    buffer = new Map();
    pendingAgentStatusPatchesByChannel.set(channelId, buffer);
  }
  return buffer;
}

/** Drop the buffered `agent_status` patches for a channel outright (not
 *  refcounted) — used on `snapshot_required`, where the authoritative snapshot
 *  refetch supersedes any buffered live patch regardless of how many readers are
 *  mounted. Reader-lifecycle clearing goes through retain/release instead. */
export function clearPendingAgentStatusPatches(channelId: string): void {
  pendingAgentStatusPatchesByChannel.delete(channelId);
}

/** Register a `useChannelAgents(channelId)` reader's interest in the patch
 *  buffer (#task:1255 P1c). */
export function retainAgentStatusBuffer(channelId: string): void {
  agentStatusBufferRefcount.set(
    channelId,
    (agentStatusBufferRefcount.get(channelId) ?? 0) + 1,
  );
}

/** Release a reader's interest; clear the buffer only when the last reader for
 *  the channel leaves so a concurrent reader's in-flight snapshot buffer isn't
 *  wiped (Cindy P1c #1 blocker). */
export function releaseAgentStatusBuffer(channelId: string): void {
  const next = (agentStatusBufferRefcount.get(channelId) ?? 0) - 1;
  if (next <= 0) {
    agentStatusBufferRefcount.delete(channelId);
    pendingAgentStatusPatchesByChannel.delete(channelId);
  } else {
    agentStatusBufferRefcount.set(channelId, next);
  }
}

/** Replay the buffered `agent_status` patches for a channel onto a fresh agents
 *  snapshot (#task:1255 P1c). Called by `useChannelAgents`'s queryFn so a patch
 *  that landed while the GET was in flight isn't clobbered by the snapshot. */
export function mergePendingAgentStatusPatches(
  channelId: string,
  agents: ConversationAgentDto[],
): ConversationAgentDto[] {
  return applyPendingSessionAgentPatches(
    agents,
    getPendingAgentStatusPatches(channelId),
  );
}

/** True when a `useChannelAgents(channelId)` reader is mounted — the exact
 *  agents key has at least one active observer. Stage-2 P1c gate (#task:1255):
 *  the ingestor patches the agents cache only while a reader is alive. */
export function hasActiveChannelAgentsReader(
  qc: QueryClient,
  channelId: string,
): boolean {
  const entry = qc
    .getQueryCache()
    .find({ queryKey: agentsKey(channelId), exact: true });
  return (entry?.getObserversCount() ?? 0) > 0;
}

/** Apply a live `agent_status` patch to the channel agents cache (#task:1255
 *  P1c) — verbatim move of `useChannelAgents.onEvent`'s agent_status branch:
 *  buffer the patch (so a concurrent snapshot refetch replays it), patch the
 *  cached rows in place, and invalidate to refetch if the agent isn't a known
 *  row yet (a freshly-provisioned agent). */
export function applyAgentStatusToCache(
  qc: QueryClient,
  channelId: string,
  patch: ConversationAgentStatusPatch,
): void {
  if (!patch?.agent_id) return;
  const buffer = getPendingAgentStatusPatches(channelId);
  const prevPatch = buffer.get(patch.agent_id);
  buffer.set(patch.agent_id, { ...prevPatch, ...patch });

  const key = agentsKey(channelId);
  const current = qc.getQueryData<ConversationAgentDto[]>(key);
  const hasCurrentRow =
    current?.some(a => a.agent_id === patch.agent_id) ?? false;

  qc.setQueryData<ConversationAgentDto[]>(key, prev =>
    prev ? prev.map(a => applySessionAgentPatch(a, patch)) : prev,
  );

  if (!hasCurrentRow) {
    void qc.invalidateQueries({ queryKey: key });
  }
}

/** Reconcile the channel agents cache on `snapshot_required` (#task:1255 P1c) —
 *  verbatim move of `useChannelAgents.onEvent`'s connected+snapshot_required
 *  branch: drop the stale buffer and refetch the authoritative snapshot.
 *
 *  Returns the invalidate Promise so the ingestor can join reconcile settle for
 *  the P2 snapshot-baseline commit (#1255 P2). Strategy is unchanged — the
 *  returned Promise ONLY expresses "this reconcile has settled". */
export function reconcileChannelAgentsOnSnapshotRequired(
  qc: QueryClient,
  channelId: string,
): Promise<void> {
  clearPendingAgentStatusPatches(channelId);
  return qc.invalidateQueries({ queryKey: agentsKey(channelId) });
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

/** Whether a reply badge for `rootId` is on a loaded main-stream page — the
 *  root's `reply_counts_by_root` key is already present OR the root message row
 *  is in the window. #1263 (c) gates the authoritative reply-count recovery on
 *  this: an ON-window root → invalidate → refetch the count; an OFF-window root
 *  → no-op, since the badge isn't displayed and the next window fetch re-derives
 *  the authoritative count when the user paginates to it (#task:1255 §4.1). */
function cacheHasRootOrKey(
  data: MessagesCache | undefined,
  rootId: string,
): boolean {
  return (
    data?.pages.some(
      page =>
        Object.prototype.hasOwnProperty.call(page.reply_counts_by_root, rootId) ||
        page.messages.some(m => m.id === rootId),
    ) ?? false
  );
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
      // Optimistic/live-append bootstrap with no prior server window. For a
      // real live-append `msg.seq` IS the new stream head; for an optimistic
      // send the whole page is provisional (replaced on server ack / refetch).
      // This mainline cache's head is never consumed as a thread mark-read
      // snapshot — that comes only from the thread window response
      // (`useThreadCluster` → stream_head_seq) — so it cannot swallow a tail.
      stream_head_seq: msg.seq,
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
          // No prior window to inherit a head from; this appended message is
          // the live head. Mainline cache head is never a thread mark-read
          // snapshot source (those come from the thread window response).
          stream_head_seq: msg.seq,
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

/** Apply a `message_reaction_changed` event to a SINGLE message row.
 *
 *  Count is **absolute-assigned** from the event (`ev.count`, the server's
 *  authoritative post-change aggregate), never derived from `op` +/- — WS
 *  replay / reorder + the viewer's own optimism would otherwise drift
 *  (docs/reactions-design.md §5.2). `viewer_reacted` flips ONLY when the
 *  event's reactor is the current viewer; other reactors bump the count but
 *  leave the viewer flag untouched. `count <= 0` drops the emoji's chip;
 *  the array collapses to `null` when the last reaction goes.
 *
 *  The caller is responsible for matching `message.id === ev.message_id`;
 *  this is the one place the reaction-merge logic lives so the main window,
 *  reply-cluster window, and the thread-pane root row all stay consistent
 *  (#task:1122 review, P1.1 — no second copy of the merge). */
export function applyReactionToMessage(
  message: MessageDto,
  ev: MessageReactionChangedEvent,
  viewerUserId: string | null,
): MessageDto {
  const viewerMatch =
    ev.reactor_kind === 'user' && ev.reactor_id === viewerUserId;
  const prev = message.reactions ?? [];
  const idx = prev.findIndex(r => r.emoji === ev.emoji);
  let next: ReactionAggregateDto[];
  if (ev.count <= 0) {
    next = prev.filter(r => r.emoji !== ev.emoji);
  } else if (idx === -1) {
    next = [
      ...prev,
      {
        emoji: ev.emoji,
        count: ev.count,
        viewer_reacted: viewerMatch && ev.op === 'add',
      },
    ];
  } else {
    next = prev.map((r, i) =>
      i === idx
        ? {
            emoji: r.emoji,
            count: ev.count,
            viewer_reacted: viewerMatch ? ev.op === 'add' : r.viewer_reacted,
          }
        : r,
    );
  }
  return { ...message, reactions: next.length ? next : null };
}

/** Apply a `message_reaction_changed` event to a message-window cache.
 *
 *  Delegates the per-row merge to {@link applyReactionToMessage}; this just
 *  walks the infinite-query pages and is a no-op when the message isn't in
 *  this window — so the same handler can be fired against both the
 *  main-stream and reply-cluster caches and only the one actually holding
 *  the row changes. */
function applyReactionChangedToCache(
  data: MessagesCache | undefined,
  ev: MessageReactionChangedEvent,
  viewerUserId: string | null,
): MessagesCache | undefined {
  if (!data) return data;
  let changed = false;
  const pages = data.pages.map(page => {
    let pageChanged = false;
    const messages = page.messages.map(message => {
      if (message.id !== ev.message_id) return message;
      changed = true;
      pageChanged = true;
      return applyReactionToMessage(message, ev, viewerUserId);
    });
    return pageChanged ? { ...page, messages } : page;
  });
  return changed ? { ...data, pages } : data;
}

/** Patch every channel-scope cache a `message_reaction_changed` event
 *  touches: the main-stream window, the reply-cluster window (only when the
 *  event targets a reply), and the lazy hover reactor-detail query —
 *  invalidated so an already-open "who reacted" list refetches instead of
 *  showing names stale by up to its `staleTime` (#task:1122 review, P1.2).
 *  Mirrors `applyTaskChangedToTaskByNumberCache`'s QueryClient-operating
 *  shape so the WS handler stays a thin caller and the cache effects are
 *  unit-testable without a stream mock. */
export function applyReactionChangedToChannelCaches(
  qc: QueryClient,
  channelId: string,
  ev: MessageReactionChangedEvent,
  viewerUserId: string | null,
): boolean {
  // Idempotent: `applyReactionToMessage` SETS the aggregate from the event's
  // absolute `count`, so replay is a no-op (false-negative safe, §4.1). `applied`
  // = the targeted row is in a loaded window (a reaction on an off-window message
  // is a cursor-inert no-op).
  const mainlineCur = qc.getQueryData<MessagesCache>(messagesKey(channelId));
  let applied = cacheHasMessage(mainlineCur, ev.message_id);
  qc.setQueryData<MessagesCache>(messagesKey(channelId), prev =>
    applyReactionChangedToCache(prev, ev, viewerUserId),
  );
  if (ev.thread_root_id) {
    const clusterCur = qc.getQueryData<MessagesCache>(
      clusterMessagesKey(channelId, ev.thread_root_id),
    );
    if (cacheHasMessage(clusterCur, ev.message_id)) applied = true;
    qc.setQueryData<MessagesCache>(
      clusterMessagesKey(channelId, ev.thread_root_id),
      prev => applyReactionChangedToCache(prev, ev, viewerUserId),
    );
  }
  void qc.invalidateQueries({ queryKey: messageReactorsKey(ev.message_id) });
  return applied;
}

/** Patch the thread pane's root-row query for a `message_reaction_changed`
 *  event. The root lives in the main stream (the event's `thread_root_id` is
 *  null), so {@link applyReactionChangedToChannelCaches} only updates the
 *  LEFT-side main cache — without this the open pane's root reaction stays
 *  stale until a manual refetch (#task:1122 review, P1.1). Reuses the one
 *  merge helper; no-op unless the event targets this exact root. */
export function applyReactionChangedToThreadRootCache(
  qc: QueryClient,
  channelId: string,
  rootMessageId: string,
  ev: MessageReactionChangedEvent,
  viewerUserId: string | null,
): boolean {
  if (ev.message_id !== rootMessageId) return false;
  const prev = qc.getQueryData<ConversationMessagesDto>(
    threadRootKey(channelId, rootMessageId),
  );
  const found = prev?.messages.some(m => m.id === rootMessageId) ?? false;
  if (!found) return false;
  qc.setQueryData<ConversationMessagesDto>(
    threadRootKey(channelId, rootMessageId),
    p => {
      if (!p) return p;
      const messages = p.messages.map(m =>
        m.id === rootMessageId ? applyReactionToMessage(m, ev, viewerUserId) : m,
      );
      return { ...p, messages };
    },
  );
  return found;
}

/** Set/clear the mainline live-gap affordance. Single shared writer: the
 *  ingestor sets `true` on a gapped live message; the reader view clears `false`
 *  on channel switch / reached tail / reset (#task:1255 P1a). */
export function setMainlineLiveGap(
  qc: QueryClient,
  channelId: string,
  value: boolean,
): void {
  qc.setQueryData<boolean>(mainlineLiveGapKey(channelId), value);
}

/** True when a `useChannelMessages(channelId)` reader is mounted — i.e. the
 *  exact mainline window key has at least one active observer.
 *
 *  Stage-2 P1a gate (#task:1255): the central ingestor took over what used to
 *  be `useChannelMessages.onEvent`, which only ran while that hook was mounted.
 *  To stay behavior-equivalent (P1 = prep, NOT correctness), mainline cache
 *  writes must happen ONLY while a mainline reader is alive — thread/follower
 *  scope INTEREST keeps the WS scope subscribed but must not bootstrap or patch
 *  the mainline window (that would surface a live-frame-stitched, incomplete
 *  window with no REST snapshot behind it). P2 does NOT remove this gate — it
 *  makes `markSatisfied` honor it (a frame with no active reader is not applied
 *  and must not advance the cursor); full decouple is P3
 *  (docs/renderer-event-ingestion-v1.md §3.1/§5).
 *  `messagesKey` is observed only by `useChannelMessages`; primers/jumps use
 *  `setQueryData`/`fetchQuery` and register no standing observer. */
export function hasActiveMainlineReader(
  qc: QueryClient,
  channelId: string,
): boolean {
  const entry = qc
    .getQueryCache()
    .find({ queryKey: messagesKey(channelId), exact: true });
  return (entry?.getObserversCount() ?? 0) > 0;
}

/** Apply a live/replayed mainline `message` frame to the channel main-stream
 *  caches (#task:1255 Stage-2 / #task:1263 (c)). Returns this frame's mainline
 *  SATISFACTION promise, or `null` when it touches no mainline display path (the
 *  ingestor collects the non-null promises and advances the resume floor only
 *  once every effect settled fulfilled — §4.1 / #1261):
 *   - a reply (`thread_root_id != null`), non-system, whose root is on a loaded
 *     page → the root's reply badge is a message-DERIVED projection, so recover it
 *     AUTHORITATIVELY (invalidate → refetch the count). #1263 (c): this replaces
 *     the old optimistic `+1`, which was non-idempotent and double-counted on
 *     replay (the Cindy #1263 falsifier). Cursor-inert: the invalidate INITIATES
 *     recovery; the floor advances only once it COMMITS (#1261 satisfaction).
 *     Returns the invalidate Promise.
 *   - a reply to an OFF-window root, or a system reply → `null` (the badge isn't
 *     displayed; a fresh count arrives when the window paginates to that root).
 *   - a mainline row at tail → append (id-deduped) → content committed → resolved.
 *   - a mainline row while the window is NOT at tail → set the live-gap fact; the
 *     row loads authoritatively when the user reaches the tail, so the affordance
 *     IS the commit → resolved (an already-gapped bump is equally satisfied —
 *     #1261 lets the floor advance rather than pin, since paginate is authoritative). */
export function applyMainlineMessageToChannelCaches(
  qc: QueryClient,
  channelId: string,
  msg: MessageDto,
): Promise<void> | null {
  if (msg.thread_root_id !== null) {
    if (msg.from_kind === 'system') return null;
    const rootId = msg.thread_root_id;
    const cur = qc.getQueryData<MessagesCache>(messagesKey(channelId));
    if (!cacheHasRootOrKey(cur, rootId)) return null;
    return qc.invalidateQueries({ queryKey: messagesKey(channelId) });
  }
  const cur = qc.getQueryData<MessagesCache>(messagesKey(channelId));
  if (!lastPageIsTail(cur)) {
    setMainlineLiveGap(qc, channelId, true);
    return Promise.resolve();
  }
  qc.setQueryData<MessagesCache>(messagesKey(channelId), prev =>
    appendMessageToCache(prev, msg),
  );
  return Promise.resolve();
}

/** Apply a `task_changed` frame to the channel caches (#task:1255 Stage-2) —
 *  patches the by-number task cache AND the inline task chip in the main-stream
 *  window. Returns whether the in-stream chip was for a loaded row (the `applied`
 *  signal, §4.1). Idempotent: `applyTaskChangedToCache` SETS task fields, so
 *  replay is a no-op (false-negative safe). The by-number cache is a separate
 *  projection, not the message-stream content the resume floor tracks. */
export function applyTaskChangedToChannelCaches(
  qc: QueryClient,
  channelId: string,
  task: TaskChangedEvent,
): boolean {
  applyTaskChangedToTaskByNumberCache(qc, task);
  const cur = qc.getQueryData<MessagesCache>(messagesKey(channelId));
  const inCache = cacheHasMessage(cur, task.message_id);
  qc.setQueryData<MessagesCache>(messagesKey(channelId), prev =>
    applyTaskChangedToCache(prev, task),
  );
  return inCache;
}

/** Reconcile the channel main-stream window on `snapshot_required` (reconnect
 *  epoch mismatch / replay gap) — verbatim move of `useChannelMessages.onEvent`'s
 *  snapshot_required branch: drop back to latest (invalidate) and clear the
 *  live-gap hint. */
export function reconcileChannelMainlineOnSnapshotRequired(
  qc: QueryClient,
  channelId: string,
): Promise<void> {
  setMainlineLiveGap(qc, channelId, false);
  // Returns the invalidate Promise (reconcile-settle signal for the P2 join,
  // #1255 P2); invalidate strategy unchanged.
  return qc.invalidateQueries({ queryKey: messagesKey(channelId) });
}

/** Reactive reader for the mainline live-gap affordance (#task:1255 P1a). The
 *  central ingestor owns the SET; this just subscribes the cache key so the
 *  view re-renders when the hint flips. No queryFn fetch — the value lives only
 *  in cache (default `false`); `staleTime: Infinity` keeps the placeholder
 *  `queryFn` from ever clobbering an ingestor-written `true`. */
function useMainlineLiveGap(channelId: string | null): boolean {
  const { data } = useQuery<boolean>({
    queryKey: mainlineLiveGapKey(channelId ?? 'none'),
    enabled: !!channelId,
    queryFn: () => false,
    initialData: false,
    staleTime: Infinity,
  });
  return data ?? false;
}

// ─── Stage-2 P1b: thread cluster / root / followers ingestor helpers ─────────
// Move the cache writes that lived in useThreadCluster / useThreadRoot /
// useThreadFollowers `onEvent` into the central ingestor. As with the mainline
// path (P1a), behavior is preserved (P1 = prep): every write is gated on the
// matching reader being mounted. A channel can hold several open clusters at
// once, so the ingestor enumerates the OPEN reader roots (those with a live
// observer) and applies per-root — exactly mirroring "each mounted hook ran its
// own onEvent". P2 does NOT lift these gates — `markSatisfied` honors them (a
// frame with no active reader is not applied and must not advance the cursor);
// full decouple from view mount is P3.

export function setClusterLiveGap(
  qc: QueryClient,
  channelId: string,
  rootId: string,
  value: boolean,
): void {
  qc.setQueryData<boolean>(clusterLiveGapKey(channelId, rootId), value);
}

function useClusterLiveGap(
  channelId: string | null,
  rootId: string | null,
): boolean {
  const { data } = useQuery<boolean>({
    queryKey: clusterLiveGapKey(channelId ?? 'none', rootId ?? 'none'),
    enabled: !!channelId && !!rootId,
    queryFn: () => false,
    initialData: false,
    staleTime: Infinity,
  });
  return data ?? false;
}

/** Roots of the OPEN clusters in this channel (cluster window has ≥1 observer). */
export function openClusterReaderRoots(
  qc: QueryClient,
  channelId: string,
): string[] {
  return qc
    .getQueryCache()
    .findAll({ queryKey: ['channels', channelId, 'cluster'] })
    .filter(q => {
      const k = q.queryKey as readonly unknown[];
      // The cluster id space holds two keys per root (`…cluster/<root>/messages`
      // and `…/fetch-epoch`); only the window query is a reader.
      return k[4] === 'messages' && q.getObserversCount() > 0;
    })
    .map(q => (q.queryKey as readonly unknown[])[3] as string);
}

/** Roots of the OPEN thread-root rows in this channel (≥1 observer). */
export function openThreadRootReaderRoots(
  qc: QueryClient,
  channelId: string,
): string[] {
  return qc
    .getQueryCache()
    .findAll({ queryKey: ['channels', channelId, 'thread-root'] })
    .filter(q => q.getObserversCount() > 0)
    .map(q => (q.queryKey as readonly unknown[])[3] as string);
}

/** Roots of the OPEN follower snapshots in this channel (≥1 observer). */
export function openThreadFollowerReaderRoots(
  qc: QueryClient,
  channelId: string,
): string[] {
  return qc
    .getQueryCache()
    .findAll({ queryKey: ['channels', channelId, 'thread-followers'] })
    .filter(q => q.getObserversCount() > 0)
    .map(q => (q.queryKey as readonly unknown[])[3] as string);
}

/** Roots of reply clusters in this channel that hold a WARM cache but have NO
 *  active reader. `useThreadCluster` is `refetchOnMount: false`, so an inactive,
 *  merely-invalidated cluster would serve stale data on its next open. On
 *  `snapshot_required` these must be REMOVED (cold-start on next mount) rather
 *  than invalidated — the "旧内容已同步移除且不会展示" arm of the `satisfied`
 *  predicate (#task:1255 §6). Active clusters are covered by
 *  {@link openClusterReaderRoots} (invalidate→refetch settles the promise). */
export function warmInactiveClusterRoots(
  qc: QueryClient,
  channelId: string,
): string[] {
  return qc
    .getQueryCache()
    .findAll({ queryKey: ['channels', channelId, 'cluster'] })
    .filter(q => {
      const k = q.queryKey as readonly unknown[];
      return (
        k[4] === 'messages' &&
        q.getObserversCount() === 0 &&
        q.state.data !== undefined
      );
    })
    .map(q => (q.queryKey as readonly unknown[])[3] as string);
}

/** Warm-remove one inactive cluster window on `snapshot_required` (#task:1255
 *  §6). `removeQueries` is synchronous — the returned resolved Promise lets it
 *  join the P2 `Promise.allSettled` commit gate as a fulfilled reconcile. Its
 *  live-gap fact is cleared alongside so a stale "new below" hint can't survive
 *  the cold-start. */
export function removeInactiveClusterCache(
  qc: QueryClient,
  channelId: string,
  rootId: string,
): Promise<void> {
  setClusterLiveGap(qc, channelId, rootId, false);
  qc.removeQueries({
    queryKey: clusterMessagesKey(channelId, rootId),
    exact: true,
  });
  return Promise.resolve();
}

/** True when this channel's main-stream window (`messagesKey`) holds a WARM
 *  cache but has NO active reader. `useChannelMessages` runs at the global
 *  default `staleTime: 5_000`, so a remount within that window serves the warm
 *  cache WITHOUT a refetch — meaning an inactive mainline cache can NOT be
 *  treated as absent/vacuous on `snapshot_required`: it would still display
 *  post-commit stale rows. Like {@link warmInactiveClusterRoots} (the cluster
 *  axis), it must be REMOVED (cold-start on next open), not merely invalidated.
 *  `event-ws-transport-v1.md §8` lists both mainline `useChannelMessages` and
 *  `useThreadCluster` in the warm-remove class. Active mainlines are covered by
 *  {@link hasActiveMainlineReader} (invalidate→refetch settles the promise). */
export function hasWarmInactiveMainline(
  qc: QueryClient,
  channelId: string,
): boolean {
  const entry = qc
    .getQueryCache()
    .find({ queryKey: messagesKey(channelId), exact: true });
  return (
    entry !== undefined &&
    entry.getObserversCount() === 0 &&
    entry.state.data !== undefined
  );
}

/** Warm-remove the inactive main-stream window on `snapshot_required` (#task:1255
 *  §6). `removeQueries` is synchronous — the resolved Promise joins the P2
 *  `Promise.allSettled` commit gate as a fulfilled reconcile. The mainline
 *  live-gap fact is cleared alongside so a stale "new below" hint can't survive
 *  the cold-start. Sibling of {@link removeInactiveClusterCache}. */
export function removeInactiveMainlineCache(
  qc: QueryClient,
  channelId: string,
): Promise<void> {
  setMainlineLiveGap(qc, channelId, false);
  qc.removeQueries({ queryKey: messagesKey(channelId), exact: true });
  return Promise.resolve();
}

/** Reconcile one OPEN thread-root row on `snapshot_required` — refetch its
 *  authoritative reply count. This is the covering recovery that releases a
 *  reply-count invalidate that pinned the floor ({@link applyThreadRootReplyBump}
 *  §4.1). Returns the invalidate Promise for the P2 commit join. */
export function reconcileThreadRootOnSnapshotRequired(
  qc: QueryClient,
  channelId: string,
  rootId: string,
): Promise<void> {
  return qc.invalidateQueries({ queryKey: threadRootKey(channelId, rootId) });
}

/** Apply a `message` frame to one OPEN cluster window — verbatim move of
 *  useThreadCluster.onEvent's message branch (filter to this cluster's rows;
 *  append at tail, else raise the cluster live-gap). Returns this cluster's
 *  SATISFACTION promise, or `null` when the row is not part of this cluster:
 *  a cluster append is an id-deduped CONTENT write (idempotent on replay), and a
 *  live-gap flip is an affordance whose row loads authoritatively when the user
 *  reaches the tail — both are committed synchronously → resolved. An already-
 *  gapped bump is equally satisfied (#1261 lets the floor advance vs pin, since
 *  paginate is authoritative). #task:1255 Stage-2 / #task:1263. */
export function applyClusterMessageToCaches(
  qc: QueryClient,
  channelId: string,
  rootId: string,
  msg: MessageDto,
): Promise<void> | null {
  if (msg.thread_root_id !== rootId && msg.id !== rootId) return null;
  const cur = qc.getQueryData<MessagesCache>(
    clusterMessagesKey(channelId, rootId),
  );
  if (!lastPageIsTail(cur)) {
    setClusterLiveGap(qc, channelId, rootId, true);
    return Promise.resolve();
  }
  qc.setQueryData<MessagesCache>(clusterMessagesKey(channelId, rootId), prev =>
    appendMessageToCache(prev, msg),
  );
  return Promise.resolve();
}

/** Apply a `task_changed` frame to one OPEN cluster window — patches the chip if
 *  the row is loaded (no-op otherwise). Returns whether it patched a loaded row
 *  (the `applied` signal, §4.1); idempotent (sets fields), so false-negative safe. */
export function applyClusterTaskChangedToCaches(
  qc: QueryClient,
  channelId: string,
  rootId: string,
  task: TaskChangedEvent,
): boolean {
  const cur = qc.getQueryData<MessagesCache>(
    clusterMessagesKey(channelId, rootId),
  );
  const inCache = cacheHasMessage(cur, task.message_id);
  qc.setQueryData<MessagesCache>(clusterMessagesKey(channelId, rootId), prev =>
    applyTaskChangedToCache(prev, task),
  );
  return inCache;
}

/** Reconcile one OPEN cluster on `snapshot_required` — clear its live-gap and
 *  invalidate the window so it refetches (mirrors useThreadCluster.onEvent).
 *  Returns the invalidate Promise (reconcile-settle signal for the P2 join,
 *  #1255 P2); strategy unchanged. */
export function reconcileClusterOnSnapshotRequired(
  qc: QueryClient,
  channelId: string,
  rootId: string,
): Promise<void> {
  setClusterLiveGap(qc, channelId, rootId, false);
  return qc.invalidateQueries({ queryKey: clusterMessagesKey(channelId, rootId) });
}

/** Recover the authoritative reply count on one OPEN thread-root row (#task:1255
 *  Stage-2 / #task:1263 (c)). Returns this root's SATISFACTION promise, or `null`
 *  when the frame touches no loaded root display path:
 *   - a non-system reply to this loaded root → the count is a message-DERIVED
 *     projection, so recover it AUTHORITATIVELY (invalidate → refetch). #1263 (c)
 *     replaces the old optimistic `+1`, which was non-idempotent and double-counted
 *     on replay. Cursor-inert: the invalidate INITIATES
 *     recovery; the floor advances only once it COMMITS (#1261). Returns the
 *     invalidate Promise.
 *   - a system reply, a row for another root, or a not-loaded root → `null`
 *     (nothing displayed; the count is authoritative on the root row's own fetch). */
export function applyThreadRootReplyBump(
  qc: QueryClient,
  channelId: string,
  rootId: string,
  msg: MessageDto,
): Promise<void> | null {
  if (msg.thread_root_id !== rootId || msg.from_kind === 'system') return null;
  const prev = qc.getQueryData<ConversationMessagesDto>(
    threadRootKey(channelId, rootId),
  );
  if (!prev) return null;
  return qc.invalidateQueries({ queryKey: threadRootKey(channelId, rootId) });
}

/** Invalidate one OPEN cluster's follower snapshot when a reply to this root
 *  lands — verbatim move of useThreadFollowers.onEvent's message branch. Returns
 *  the invalidate Promise (a derived-invalidate SATISFACTION signal, cursor-inert),
 *  or `null` when the row is not part of this cluster. #task:1263. */
export function applyThreadFollowersMessage(
  qc: QueryClient,
  channelId: string,
  rootId: string,
  msg: MessageDto,
): Promise<void> | null {
  if (msg.thread_root_id !== rootId && msg.id !== rootId) return null;
  return qc.invalidateQueries({ queryKey: threadFollowersKey(channelId, rootId) });
}

/** Invalidate one OPEN cluster's follower snapshot on `snapshot_required`.
 *  Returns the invalidate Promise (reconcile-settle signal for the P2 join,
 *  #1255 P2); strategy unchanged. */
export function invalidateThreadFollowers(
  qc: QueryClient,
  channelId: string,
  rootId: string,
): Promise<void> {
  return qc.invalidateQueries({ queryKey: threadFollowersKey(channelId, rootId) });
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
 *  arrived while the window was not at tail. Since Stage-2 P1a the gap is
 *  a per-channel React Query cache fact (`mainlineLiveGapKey`) the central
 *  ingestor SETs and this hook reads/CLEARs — not local hook state — so a
 *  flip drives a rerender via the query subscription.
 */
export function useChannelMessages(
  channelId: string | null,
) {
  const qc = useQueryClient();

  // Stage-2 (#task:1255 P1a): the central conversation ingestor is the sole
  // `onWsFrame` consumer and owns the SET of the live-gap affordance. This hook
  // is a pure reader of that cache fact; it keeps only the position-based CLEARS
  // (here, channel switch). See docs/renderer-event-ingestion-v1.md §5.
  const hasNewerLiveGap = useMainlineLiveGap(channelId);

  // Reset the gap whenever the consumer switches conversations —
  // a stale "new messages below" hint from the previous channel
  // would be both wrong and confusing. The cleanup clears the channel
  // we're LEAVING: with a per-channel cache key (vs the old hook-local
  // useState) a stale `true` would otherwise survive the switch and flash
  // a bogus "jump to latest" on the first render back (#task:1255 P1a
  // blocker-2). Faithful to the old useState reset-on-mount semantics.
  useEffect(() => {
    if (!channelId) return;
    setMainlineLiveGap(qc, channelId, false);
    return () => setMainlineLiveGap(qc, channelId, false);
  }, [qc, channelId]);

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
    if (isAtTail && channelId) setMainlineLiveGap(qc, channelId, false);
  }, [qc, channelId, isAtTail]);

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
    setMainlineLiveGap(qc, channelId, false);
    void qc.resetQueries({ queryKey: messagesKey(channelId), exact: true });
  }, [qc, channelId]);

  // Pure reader (#task:1255 P1a): no `onWsFrame` here — the central conversation
  // ingestor is the sole consumer and owns all main-stream cache writes
  // (message append / reply-badge bump / task_changed / reaction) plus the
  // live-gap SET. This hook only declares INTEREST in the channel scope so it
  // stays subscribed while a reader is mounted; subscription is bandwidth,
  // decoupled from frame consumption / cache application. Holding zero
  // `onWsFrame` is what lets Stage-2 P2 drop the orphan gate (gate-(b)). See
  // docs/renderer-event-ingestion-v1.md §4.4.
  useEffect(() => {
    if (!channelId) return;
    const sub = subscribeWsScope(wsConversationScope(channelId));
    return () => sub.unsubscribe();
  }, [channelId]);

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
  opts?: {
    /** True while THIS open is a first-unread jump whose `primeAround`
     *  around-window fetch has not yet resolved (#task:1226 §9.10). While set,
     *  the infinite query is held DISABLED so its empty-cache initial LATEST
     *  fetch cannot race / clobber primeAround's around-window. See
     *  `clusterInitialFetchEnabled`. Omit / false for a normal open — it then
     *  keeps its mount-time latest initial fetch unchanged. */
    jumpPrimePending?: boolean;
  },
) {
  const qc = useQueryClient();
  const enabledBase = !!channelId && !!rootMessageId;
  // The infinite query is enabled (and so allowed to auto-fire its initial
  // latest fetch on an empty cache) only when NOT waiting on a jump's
  // primeAround. The stream subscription + epoch carrier below stay on
  // `enabledBase` so live replies and the freshness epoch are still observed
  // while the initial fetch is suppressed.
  const enabled = clusterInitialFetchEnabled({
    hasChannelAndRoot: enabledBase,
    jumpPrimePending: opts?.jumpPrimePending ?? false,
  });
  const key = clusterMessagesKey(channelId ?? 'none', rootMessageId ?? 'none');

  // Stage-2 P1b: the central ingestor owns the SET of the cluster live-gap; this
  // hook reads it as a cache fact and keeps only the position-based CLEARs.
  const hasNewerLiveGap = useClusterLiveGap(channelId, rootMessageId);

  // "This open's window fetch succeeded" signal (#task:1226 §9/§9.10), carried
  // in a dedicated cache key so BOTH writers reach it: this hook's queryFn AND
  // `primeAround` (the jump-open's around-target fetch). It is NOT
  // `dataUpdatedAt` — React Query bumps that on `setQueryData` too (an
  // optimistic live-append), which would open the mark-read gate
  // before a real window response landed. Only a successful window FETCH writes
  // this epoch, so it proves the loaded window is from this open. Read
  // reactively below via `useQuery`.
  const epochKey = clusterFetchEpochKey(
    channelId ?? 'none',
    rootMessageId ?? 'none',
  );

  // Reset the gap when the consumer switches channel or thread — a stale
  // "newer replies below" hint from the previous cluster would be wrong. The
  // cleanup clears the cluster being LEFT (per-(channel,root) cache key, unlike
  // the old hook-local useState) so a stale `true` can't flash on return
  // (#task:1255 P1b, mirrors the mainline blocker-2 fix).
  useEffect(() => {
    if (!channelId || !rootMessageId) return;
    setClusterLiveGap(qc, channelId, rootMessageId, false);
    return () => setClusterLiveGap(qc, channelId, rootMessageId, false);
  }, [qc, channelId, rootMessageId]);

  const query = useInfiniteQuery<
    ConversationMessagesDto,
    Error,
    InfiniteData<ConversationMessagesDto, MessagesPageParam>,
    ReturnType<typeof clusterMessagesKey>,
    MessagesPageParam
  >({
    queryKey: key,
    enabled,
    // #task:1226 §9.10: do NOT auto-refetch on mount. A target-less latest
    // refetch would CLOBBER a jump-open's around-first-unread window that
    // `primeAround` wrote (the authoritative this-open window for a jump). The
    // open's fetch is driven explicitly by the consumer instead: a normal open
    // calls `refetch()` (fresh latest → marks read); a jump-open relies on
    // primeAround's around-fetch (which also stamps the epoch below).
    //
    // `refetchOnMount` only governs refetch when a cache ALREADY exists, NOT
    // the initial fetch on an EMPTY cache (that fires whenever `enabled`). So on
    // a jump-open the empty-cache initial latest fetch is suppressed a layer up,
    // via `enabled` (gated on `jumpPrimePending`), so primeAround is the sole
    // writer of this open's window and no latest can pre-empt it.
    refetchOnMount: false,
    initialPageParam: undefined as MessagesPageParam,
    queryFn: async ({ pageParam, signal }) => {
      const dto = await fetchMessagesWindow({
        conversationId: channelId!,
        threadRootId: rootMessageId!,
        pageParam,
        limit: MESSAGE_PAGE_LIMIT,
        signal,
      });
      // Success path only — reached on a real window response, never via
      // `setQueryData`. Stamp the shared freshness epoch (§9/§9.10).
      qc.setQueryData(epochKey, Date.now());
      return dto;
    },
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
    if (isAtTail && channelId && rootMessageId) {
      setClusterLiveGap(qc, channelId, rootMessageId, false);
    }
  }, [qc, channelId, rootMessageId, isAtTail]);

  // Reset the cluster query to the latest (tail) window. We drop the
  // around-window pages: an around-reply window may not be contiguous with
  // the tail, and stitching disjoint ranges would corrupt the cursors.
  const resetToLatest = useCallback(() => {
    if (!channelId || !rootMessageId) return;
    setClusterLiveGap(qc, channelId, rootMessageId, false);
    void qc.resetQueries({ queryKey: key, exact: true });
  }, [qc, channelId, rootMessageId, key]);

  // Pure reader (#task:1255 P1b): no `onWsFrame` here — the central conversation
  // ingestor is the sole consumer and owns the cluster cache writes (reply
  // append / live-gap SET / task chip patch / snapshot reconcile), gated on this
  // cluster reader being mounted. This hook only declares INTEREST in the
  // channel scope so it stays subscribed while open. See
  // docs/renderer-event-ingestion-v1.md §4.4.
  // #task:1260 P2: interest routes through the registry (`useInterest`) instead
  // of a direct subscribeWsScope useEffect — identical lifecycle, single
  // authority. The `enabledBase` gate maps to the null-scope form; not a
  // correctness boundary (transport retains floor on unsubscribe, resume-replays
  // on re-enable, #1251).
  useInterest(enabledBase && channelId ? wsConversationScope(channelId) : null);

  // Head of the loaded cluster window: the FIRST page's `stream_head_seq`.
  // Per §9.10 `stream_head_seq` is window-INDEPENDENT (the route captures the
  // stream head before slicing the window), so this is a correct mark VALUE for
  // ANY window — latest OR a jump's around-first-unread window — never max(seq)
  // of loaded rows. v1 is read-to-clear: opening/jumping marks to this
  // open-time head; the jump window is a locate view, not a coverage promise.
  // null until first data.
  const streamHeadSeq = query.data?.pages[0]?.stream_head_seq ?? null;

  // Reactive read of the shared freshness epoch (written by queryFn above and
  // by `primeAround` on a jump open). `initialData: 0` + `staleTime: Infinity`
  // means the placeholder queryFn never runs — the value only moves via the
  // `setQueryData` writes, observed reactively here.
  const epochQuery = useQuery({
    queryKey: epochKey,
    queryFn: () => 0,
    enabled: enabledBase,
    initialData: 0,
    staleTime: Infinity,
    gcTime: Infinity,
  });

  return {
    ...query,
    data: messages,
    isAtTail,
    hasNewerLiveGap,
    resetToLatest,
    streamHeadSeq,
    windowFetchSucceededAt: epochQuery.data ?? 0,
  };
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
 *  The reply count is recovered AUTHORITATIVELY (#1263 (c)): a non-system
 *  reply to this exact root invalidates the root cache so the header count
 *  refetches from its own sidecar — never an optimistic +1 (replay-safe). */
export function useThreadRoot(
  channelId: string | null,
  rootMessageId: string | null,
) {
  const qc = useQueryClient();
  const enabled = !!channelId && !!rootMessageId;
  const key = threadRootKey(channelId ?? 'none', rootMessageId ?? 'none');

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

  // Pure reader (#task:1255 P1b): the central ingestor owns the root-row cache
  // writes (root reaction merge + reply-count authoritative recovery/invalidate),
  // gated on this thread-root reader being mounted. This hook only declares
  // INTEREST in the channel scope.
  // #task:1260 P2: interest routes through the registry (`useInterest`) instead
  // of a direct subscribeWsScope useEffect — identical lifecycle, single
  // authority. The compound `enabled` gate (channelId && rootMessageId) maps to
  // the null-scope form: not-enabled → no interest → transport unsubscribes
  // (drops pending, RETAINS floor); re-enable fresh-subscribes + resume-replays
  // (#1251), so `enabled` is not a correctness boundary.
  useInterest(enabled && channelId ? wsConversationScope(channelId) : null);

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
  //
  // Pure reader (#task:1255 P1b): the central ingestor owns the invalidation
  // (a reply to this root, or a reconnect snapshot_required, refetches the
  // follower set), gated on this followers reader being mounted. This hook only
  // declares INTEREST in the channel scope.
  // #task:1260 P2: interest routes through the registry (`useInterest`) instead
  // of a direct subscribeWsScope useEffect — identical lifecycle, single
  // authority. The compound `enabled` gate (channelId && rootMessageId) maps to
  // the null-scope form; not a correctness boundary (transport retains floor on
  // unsubscribe, resume-replays on re-enable, #1251).
  useInterest(enabled && channelId ? wsConversationScope(channelId) : null);

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
        // §9.10: a jump-open's around-target fetch IS this open's authoritative
        // window fetch. Stamp the shared freshness epoch so `useThreadCluster`'s
        // mark-read gate opens with THIS around-window (not a clobbering latest
        // refetch). Only for the cluster path — main-stream primes don't gate a
        // thread mark-read.
        if (opts?.threadRootId) {
          qc.setQueryData(
            clusterFetchEpochKey(conversationId, opts.threadRootId),
            Date.now(),
          );
        }
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

/** Initial GET + live update on `agent_status` realtime events (#task:1255 P1c:
 *  pure reader — the central ingestor patches the agents cache + buffers patches
 *  for the in-flight snapshot; this hook only reads + drains that buffer). */
export function useChannelAgents(
  channelId: string | null,
) {
  const query = useQuery({
    queryKey: channelId ? agentsKey(channelId) : ['channels', 'none', 'agents'],
    enabled: !!channelId,
    queryFn: async () => {
      const res = await api<{ agents: ConversationAgentDto[] }>(
        apiPaths.channelAgents(channelId!),
      );
      // Replay any `agent_status` patches that landed while this GET was in
      // flight (the ingestor buffered them per channel) so the fresh snapshot
      // doesn't clobber newer live state.
      return mergePendingAgentStatusPatches(channelId!, res.agents);
    },
  });

  // Pure reader (#task:1255 P1c): no `onWsFrame` here. The central conversation
  // ingestor owns the live `agent_status` cache patch + the `snapshot_required`
  // reconcile (each gated on this reader). We keep the WS scope INTEREST alive
  // and retain the per-channel patch buffer, releasing on leave — the buffer is
  // cleared only when the LAST reader for the channel goes (refcounted) so a
  // concurrent reader's in-flight snapshot buffer isn't wiped.
  useEffect(() => {
    if (!channelId) return;
    const subscription = subscribeWsScope(wsConversationSideScope(channelId));
    retainAgentStatusBuffer(channelId);
    return () => {
      subscription.unsubscribe();
      releaseAgentStatusBuffer(channelId);
    };
  }, [channelId]);

  return query;
}

export interface SendMessageInput {
  content: string;
  attachments?: AttachmentDto[];
  /** When true, promote this send into an open `todo` task in the same
   *  request (#task:1125). Maps to `as_task` on the wire; the backend
   *  derives the task title from the first line and leaves it unassigned. */
  asTask?: boolean;
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
        as_task?: boolean;
      } = {
        content: input.content,
      };
      if (input.attachments && input.attachments.length > 0) {
        body.attachment_ids = input.attachments.map(a => a.id);
      }
      if (threadRootId) {
        body.reply_to_message_id = threadRootId;
      }
      if (input.asTask) {
        body.as_task = true;
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
              // Carry the real head forward from the discarded window — don't
              // fabricate one. `prev` is non-empty here (lastPageIsTail false
              // implies at least one page), so its last page's head is the
              // freshest server-observed value.
              stream_head_seq:
                prev.pages[prev.pages.length - 1]!.stream_head_seq,
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
        reactions: null,
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
 * - Live `agent_activity` events are ingested by the central conversation
 *   ingestor (#task:1255 P1c), gated on this reader being mounted, so the cache
 *   stays warm across quick channel/thread navigation.
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

  // Pure reader (#task:1255 P1c): no `onWsFrame` here. The central conversation
  // ingestor owns both the live `agent_activity` cache write
  // (`applyAgentRunStateToCache`) and the `snapshot_required` reconcile
  // (`invalidateAgentRunStates`), each gated on this reader being mounted. We
  // keep only the WS scope INTEREST alive so the transport stays subscribed.
  useEffect(() => {
    if (!channelId) return;
    const subscription = subscribeWsScope(wsConversationSideScope(channelId));
    return () => subscription.unsubscribe();
  }, [channelId]);

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
 * Clear a CONVERSATION's notification badges (read_at-only) — the
 * notification-surface / focused-conversation cleanup path (#task:1231). Renamed
 * from `useMarkChannelRead`: it does NOT advance the read cursor (that is
 * `observe(stream)` via `useMarkMessageChannelRead`), it clears the conversation's
 * notification badges, INCLUDING anchorless ones (`agent_start_failed`) that the
 * stream-cursor overlap can't reach (overlap only covers `mention_self` with a
 * seq). This stays the single owner of conversation-level notification bulk;
 * `read_at` legitimately has two writers (this surface + `observe`'s overlap),
 * but the cursor has exactly one (`observe`). Name == behavior: notification
 * badges, never a cursor.
 */
export function useMarkConversationNotificationsRead() {
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
  * Advance the viewer's read cursor for a channel (mainline) to its latest
  * message — the §5 `observe(stream)` mainline path (#task:1231). `stream_head`
  * is server-resolved (channel open / jump knowingly accept concurrent
  * tail-swallow, §2); a channel carries no thread root. Backed by the
  * conversation_reads cursor — clears message unread badges.
  */
export function useMarkMessageChannelRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: string | { id: string }) => {
      const channelId = typeof params === 'string' ? params : params.id;
      await postObserve([mainlineStreamSourceHead(channelId)]);
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
 * Advance the viewer's read cursor for ONE reply-cluster (thread) to the
 * snapshot the viewer actually saw (#task:1226, surface 4) — the §5
 * `observe(stream)` thread path (#task:1231). A thread MUST use `at_seq` (the
 * open-time `stream_head_seq` from `useThreadCluster`): `streamSourceAtSeq` makes
 * a thread `stream_head` unrepresentable here, so the §9.10 invariant — AUTO
 * paths (open / live) pin `at_seq` and never knowingly tail-swallow — is enforced
 * STRUCTURALLY at the caller layer. §9.10 guards the caller-intent axis, not the
 * stream-shape axis: the backend can't tell intent from a single request (it no
 * longer rejects thread + `stream_head`, `9c8c9aa`), so the guard lives here. The
 * cursor advances only to what was rendered, so a reply that landed after open
 * stays unread.
 *
 * Human-attention only: this writes the viewer's `conversation_reads` cursor
 * and nothing else. It does NOT touch thread_followers / delivery / wake.
 */
export function useMarkThreadRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      channelId: string;
      threadRootId: string;
      snapshotSeq: number;
    }) => {
      await postObserve([
        streamSourceAtSeq(params.channelId, params.threadRootId, params.snapshotSeq),
      ]);
    },
    onSuccess: (_d, params) => {
      // Sidebar/global unread roll-up includes followed-thread unread, and the
      // Threads list shows the per-thread sticker/dot — both must refresh.
      // The threads-list query only invalidates on stream message / connected,
      // never on `unread_updated`, so we invalidate it explicitly here.
      invalidateMessageUnreadQueries(qc);
      qc.invalidateQueries({ queryKey: channelThreadsKey(params.channelId) });
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

export const conversationUnreadKey = (conversationId: string) =>
  ['conversation', conversationId, 'unread'] as const;

/**
 * Per-conversation per-viewer stream-unread read-model (#task:1226) — the
 * SINGLE client source of truth for thread / mainline "N new" + first-unread.
 * The reply chip (`MessageItem`) and the Threads list (`ChannelThreadsPanel`)
 * both read this (keyed by root), so the same server-scored fact never lives in
 * two caches that drift. `threads` is sparse: only roots with unread > 0 appear
 * (absent root ⇒ 0).
 *
 * Unread is server-scored — the client can't optimistically derive it — so this
 * is refreshed ONLY by the viewer-scoped `unread_updated` WS signal, NEVER
 * inferred from message events. Scoped to THIS conversation so an unrelated
 * conversation's unread change doesn't refetch it. Human-attention read path
 * only; it never reads or writes `thread_followers` / delivery / wake.
 */
export function useConversationUnread(conversationId: string | null) {
  const qc = useQueryClient();
  const enabled = !!conversationId;
  const queryKey = conversationUnreadKey(conversationId ?? 'none');

  useEffect(() => {
    if (!conversationId) return;
    const sub = subscribeViewerScope();
    const unsub = onWsFrame(frame => {
      if (frame.type === 'snapshot_required') {
        if (!isCurrentViewerScope(frame.scope)) return;
        void qc.invalidateQueries({ queryKey });
        return;
      }
      if (frame.type !== 'event') return;
      if (!isCurrentViewerScope(frame.scope)) return;
      if (frame.kind !== 'unread_updated') return;
      if (!isMessageUnreadUpdatedPayload(frame.payload)) return;
      // Per-stream unread for a thread reply carries the parent CHANNEL's
      // conversation_id (threads share the channel conversation), so this match
      // covers both mainline and thread unread of this conversation.
      const payload = frame.payload as { conversation_id?: unknown };
      if (payload.conversation_id !== conversationId) return;
      void qc.invalidateQueries({ queryKey });
    });
    return () => {
      sub.unsubscribe();
      unsub();
    };
  }, [qc, conversationId]); // eslint-disable-line react-hooks/exhaustive-deps

  return useQuery<ConversationStreamUnreadDto>({
    queryKey,
    enabled,
    queryFn: ({ signal }) =>
      api<ConversationStreamUnreadDto>(apiPaths.conversationUnread(conversationId!), {
        signal,
      }),
  });
}
