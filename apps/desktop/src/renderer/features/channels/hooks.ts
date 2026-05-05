import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import type {
  AgentRunStatesDto,
  ConversationAgentDto,
  ConversationMessagesDto,
  MessageDto,
  TaskChangedEvent,
} from '@silverhand/shared';
import { apiPaths } from '@silverhand/shared';
import { api } from '@/lib/api';
import { CURRENT_USER_ID } from '@/lib/current-user';
import {
  AGENT_RUN_STATES_GC_MS,
  agentRunStatesKey,
  reconcileAgentRunStateSnapshot,
} from '@/lib/agentRunStateCache';
import {
  useConversationStream,
  type ConversationStreamEvent,
} from '@/hooks/useConversationStream';

const messagesKey = (cid: string) => ['channels', cid, 'messages'] as const;
const agentsKey = (cid: string) => ['channels', cid, 'agents'] as const;
const MESSAGE_PAGE_LIMIT = 100;
type ConversationRouteKind = 'channel' | 'thread';

type MessagesCache = InfiniteData<ConversationMessagesDto, number | undefined>;

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
  pageParam: number | undefined = undefined,
): MessagesCache {
  return { pages: [page], pageParams: [pageParam] };
}

function cacheHasMessage(data: MessagesCache | undefined, messageId: string): boolean {
  return data?.pages.some(page => page.messages.some(m => m.id === messageId)) ?? false;
}

function appendMessageToCache(
  data: MessagesCache | undefined,
  msg: MessageDto,
): MessagesCache {
  if (!data) {
    return makeMessagesCache({ messages: [msg], has_more_before: false });
  }
  if (cacheHasMessage(data, msg.id)) return data;

  if (data.pages.length === 0) {
    return {
      ...data,
      pages: [{ messages: [msg], has_more_before: false }],
      pageParams: [undefined],
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
        task_assignee: task.assignee,
      };
    });
    return pageChanged ? { ...page, messages } : page;
  });
  return changed ? { ...data, pages } : data;
}

/** Initial latest-window GET + previous-page fetch + live append on SSE. */
export function useChannelMessages(
  channelId: string | null,
  routeKind: ConversationRouteKind = 'channel',
) {
  const qc = useQueryClient();
  const query = useInfiniteQuery<
    ConversationMessagesDto,
    Error,
    InfiniteData<ConversationMessagesDto, number | undefined>,
    ReturnType<typeof messagesKey>,
    number | undefined
  >({
    queryKey: messagesKey(channelId ?? 'none'),
    enabled: !!channelId,
    initialPageParam: undefined as number | undefined,
    queryFn: async ({ pageParam }) => {
      const params = new URLSearchParams({
        limit: String(MESSAGE_PAGE_LIMIT),
      });
      if (typeof pageParam === 'number') {
        params.set('before_seq', String(pageParam));
      }
      const path =
        routeKind === 'thread'
          ? apiPaths.threadMessages(channelId!)
          : apiPaths.channelMessages(channelId!);
      return api<ConversationMessagesDto>(`${path}?${params.toString()}`);
    },
    getNextPageParam: () => undefined,
    getPreviousPageParam: firstPage =>
      firstPage.has_more_before ? firstPage.messages[0]?.seq : undefined,
  });
  const messages = useMemo(
    () => query.data?.pages.flatMap(page => page.messages) ?? [],
    [query.data],
  );

  const onEvent = useCallback(
    (e: ConversationStreamEvent) => {
      if (!channelId) return;
      if (e.kind === 'message') {
        const msg = e.payload?.message as MessageDto | undefined;
        if (!msg) return;
        qc.setQueryData<MessagesCache>(messagesKey(channelId), prev =>
          appendMessageToCache(prev, msg),
        );
      }
      if (e.kind === 'task_changed') {
        const task = e.payload as TaskChangedEvent | undefined;
        if (!task?.message_id) return;
        qc.setQueryData<MessagesCache>(messagesKey(channelId), prev =>
          applyTaskChangedToCache(prev, task),
        );
      }
    },
    [qc, channelId],
  );
  useConversationStream(channelId, onEvent, routeKind);

  return { ...query, data: messages };
}

/** Initial GET + live update on `agent_status` SSE events. */
export function useChannelAgents(
  channelId: string | null,
  routeKind: ConversationRouteKind = 'channel',
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
        routeKind === 'thread'
          ? apiPaths.threadAgents(channelId!)
          : apiPaths.channelAgents(channelId!),
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
        void qc.invalidateQueries({ queryKey: agentsKey(channelId) });
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
  useConversationStream(channelId, onEvent, routeKind);

  return query;
}

export function useSendMessage(
  channelId: string | null,
  routeKind: ConversationRouteKind = 'channel',
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (content: string) => {
      if (!channelId) throw new Error('no channel selected');
      const path =
        routeKind === 'thread'
          ? apiPaths.threadMessages(channelId)
          : apiPaths.channelMessages(channelId);
      const res = await api<{ message: MessageDto }>(
        path,
        { method: 'POST', body: JSON.stringify({ content }) },
      );
      return res.message;
    },
    // Optimistic update: show the message immediately on Enter, before
    // the HTTP response arrives. The temp message uses a `pending-` id;
    // onSuccess replaces it with the real row (SSE's de-dup prevents a
    // second append when the event arrives after onSuccess).
    onMutate: async (content: string) => {
      if (!channelId) return undefined;
      const key = messagesKey(channelId);
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<MessagesCache>(key);
      const tempId = `pending-${crypto.randomUUID()}`;
      const tempMsg: MessageDto = {
        id: tempId,
        conversation_id: channelId,
        from_kind: 'user',
        from_agent_id: null,
        from_user_id: CURRENT_USER_ID,
        content,
        metadata: null,
        seq: Date.now(),
        created_at: Date.now(),
        task_number: null,
        task_status: null,
        task_assignee: null,
        task_title: null,
        task_workspace_id: null,
      };
      qc.setQueryData<MessagesCache>(key, cur =>
        appendMessageToCache(cur, tempMsg),
      );
      return { prev, tempId };
    },
    onSuccess: (msg, _content, ctx) => {
      if (!channelId || !ctx) return;
      const key = messagesKey(channelId);
      qc.setQueryData<MessagesCache>(key, cur =>
        replacePendingMessageInCache(cur, ctx.tempId, msg),
      );
    },
    onError: (_err, _content, ctx) => {
      if (!channelId || !ctx) return;
      const key = messagesKey(channelId);
      // Roll back optimistic message so the user doesn't see a ghost.
      if (ctx.prev) {
        qc.setQueryData<MessagesCache>(key, ctx.prev);
      } else {
        qc.setQueryData<MessagesCache | undefined>(key, cur =>
          removeMessageFromCache(cur, ctx.tempId),
        );
      }
    },
  });
}

export function useStartAgent(
  channelId: string | null,
  routeKind: ConversationRouteKind = 'channel',
) {
  return useMutation({
    mutationFn: async (agentId: string) => {
      if (!channelId) throw new Error('no channel selected');
      const base = routeKind === 'thread' ? 'threads' : 'channels';
      await api(`/api/${base}/${channelId}/agents/${agentId}/start`, {
        method: 'POST',
      });
    },
  });
}

export function useStopAgent(
  channelId: string | null,
  routeKind: ConversationRouteKind = 'channel',
) {
  return useMutation({
    mutationFn: async (params: {
      agentId: string;
      mode?: 'soft' | 'hard';
      directive?: string;
      }) => {
      if (!channelId) throw new Error('no channel selected');
      const base = routeKind === 'thread' ? 'threads' : 'channels';
      await api(`/api/${base}/${channelId}/agents/${params.agentId}/stop`, {
        method: 'POST',
        body: JSON.stringify({
          mode: params.mode ?? 'hard',
          ...(params.directive ? { directive: params.directive } : {}),
        }),
      });
    },
  });
}

/**
 * Ephemeral per-agent run states for the current channel.
 *
 * - Initial GET from the channel/thread run-state endpoint (snapshot on
 *   mount / reconnect — returns all currently in-flight states).
 * - Live `agent_activity` events are ingested by the shared conversation stream
 *   layer so the cache stays warm even during the stream close grace period.
 */
export function useAgentRunStates(
  channelId: string | null,
  routeKind: ConversationRouteKind = 'channel',
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
      const path =
        routeKind === 'thread'
          ? apiPaths.threadAgentRunStates(channelId!)
          : apiPaths.channelAgentRunStates(channelId!);
      const res = await api<AgentRunStatesDto>(
        path,
      );
      return reconcileAgentRunStateSnapshot(
        qc.getQueryData(channelId ? agentRunStatesKey(channelId) : key),
        res.states,
        requestedAt,
      );
    },
    // Don't stale-refetch automatically — SSE keeps this up-to-date.
    staleTime: Infinity,
    refetchOnMount: 'always',
    // Keep recent activity visible across quick channel/thread navigation.
    gcTime: AGENT_RUN_STATES_GC_MS,
  });

  const onEvent = useCallback(
    (e: ConversationStreamEvent) => {
      // On (re)connect, snapshot may have drifted — runs may have ended or
      // started while the SSE was down. Refetch the snapshot to reconcile;
      // the query function merges any newer SSE updates that arrived while
      // the snapshot request was in flight.
      if (channelId && e.kind === 'connected') {
        void qc.invalidateQueries({ queryKey: agentRunStatesKey(channelId) });
      }
    },
    [qc, channelId],
  );
  useConversationStream(channelId, onEvent, routeKind);

  return query;
}

/**
 * Per-channel unread notification counts for the channels sidebar badge.
 * Polls every 5 s so badges update without requiring a manual refresh.
 *
 * @deprecated Backed by the notification system (mention_external /
 * agent_start_failed only). Use useMessageUnreadCounts for IM-style
 * message unread badges.
 */
export function useChannelUnreadCounts(workspaceId: string | null) {
  return useQuery({
    queryKey: ['workspaces', workspaceId, 'unread-by-channel'],
    enabled: !!workspaceId,
    refetchInterval: 5_000,
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
 * Backed by the conversation_reads cursor system — counts any message with
 * seq > viewer's last_read_seq. Polls every 5 s.
 */
export function useMessageUnreadCounts(
  workspaceId: string | null,
  workspaceKind: 'regular' | 'dm' | null = 'regular',
) {
  return useQuery({
    queryKey: ['workspaces', workspaceId, workspaceKind, 'message-unread'],
    enabled: !!workspaceId && workspaceKind !== null,
    refetchInterval: 5_000,
    queryFn: async () => {
      const path =
        workspaceKind === 'dm'
          ? `/api/channels/${workspaceId}/message-unread`
          : `/api/workspaces/${workspaceId}/message-unread`;
      const res = await api<{ by_conversation: Record<string, number>; total: number }>(
        path,
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
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (channelId: string) => {
      await api('/api/notifications/read', {
        method: 'POST',
        body: JSON.stringify({ conversation_id: channelId }),
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['notifications', 'unread'] });
    },
  });
}

/**
 * Advance the viewer's read cursor for a channel to its latest message.
 * Backed by the conversation_reads cursor — clears message unread badges.
 * The backend resolves the viewer's user id from X-Silverhand-User-Id
 * (injected by api()) so no body is required.
 */
export function useMarkMessageChannelRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: string | { id: string; kind?: ConversationRouteKind }) => {
      const channelId = typeof params === 'string' ? params : params.id;
      const kind = typeof params === 'string' ? 'channel' : params.kind ?? 'channel';
      const path =
        kind === 'thread'
          ? apiPaths.threadMarkRead(channelId)
          : apiPaths.channelMarkRead(channelId);
      await api(path, { method: 'POST' });
    },
    onSuccess: () => {
      // Only unread counters need to refresh after marking a conversation
      // read. Invalidating ['workspaces'] also refetches the channel/tree
      // data, which makes every channel click redo the sidebar thread load.
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
    },
  });
}

/**
 * Global message unread summary across ALL workspaces.
 * Backed by conversation_reads — returns total unread message count per workspace.
 * Used by the workspace sidebar to show per-workspace unread badges.
 * Polls every 5 s alongside the per-channel hook.
 */
export function useMessageUnreadSummary() {
  return useQuery({
    queryKey: ['message-unread', 'summary'],
    refetchInterval: 5_000,
    queryFn: () =>
      api<{ by_workspace: Record<string, number> }>(apiPaths.messageUnreadSummary),
  });
}
