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
  MessageDto,
  SessionMessagesDto,
  SessionAgentDto,
  SessionDto,
} from '@silverhand/shared';
import { apiPaths } from '@silverhand/shared';
import { api } from '@/lib/api';
import { CURRENT_USER_ID } from '@/lib/current-user';
import {
  AGENT_RUN_STATES_GC_MS,
  agentRunStatesKey,
  reconcileAgentRunStateSnapshot,
} from '@/lib/agentRunStateCache';
import { useSessionStream, type SessionStreamEvent } from '@/hooks/useSessionStream';

const messagesKey = (cid: string) => ['channels', cid, 'messages'] as const;
const agentsKey = (cid: string) => ['channels', cid, 'agents'] as const;
const MESSAGE_PAGE_LIMIT = 200;

type MessagesCache = InfiniteData<SessionMessagesDto, number | undefined>;

type SessionAgentStatusPatch = Pick<SessionAgentDto, 'agent_id'> &
  Partial<Pick<SessionAgentDto, 'status' | 'pid' | 'cli_session_id'>>;

function applySessionAgentPatch(
  agent: SessionAgentDto,
  patch: SessionAgentStatusPatch,
): SessionAgentDto {
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
  agents: SessionAgentDto[],
  pending: Map<string, SessionAgentStatusPatch>,
): SessionAgentDto[] {
  if (pending.size === 0) return agents;
  return agents.map(agent => {
    const patch = pending.get(agent.agent_id);
    return patch ? applySessionAgentPatch(agent, patch) : agent;
  });
}

function makeMessagesCache(
  page: SessionMessagesDto,
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

/** Initial latest-window GET + previous-page fetch + live append on SSE. */
export function useChannelMessages(channelId: string | null) {
  const qc = useQueryClient();
  const query = useInfiniteQuery<
    SessionMessagesDto,
    Error,
    InfiniteData<SessionMessagesDto, number | undefined>,
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
      return api<SessionMessagesDto>(
        `${apiPaths.sessionMessages(channelId!)}?${params.toString()}`,
      );
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
    (e: SessionStreamEvent) => {
      if (!channelId || e.kind !== 'message') return;
      const msg = e.payload?.message as MessageDto | undefined;
      if (!msg) return;
      qc.setQueryData<MessagesCache>(messagesKey(channelId), prev =>
        appendMessageToCache(prev, msg),
      );
    },
    [qc, channelId],
  );
  useSessionStream(channelId, onEvent);

  return { ...query, data: messages };
}

/** Initial GET + live update on `agent_status` SSE events. */
export function useChannelAgents(channelId: string | null) {
  const qc = useQueryClient();
  const pendingStatusPatches = useRef<Map<string, SessionAgentStatusPatch>>(
    new Map(),
  );

  useEffect(() => {
    pendingStatusPatches.current.clear();
  }, [channelId]);

  const query = useQuery({
    queryKey: channelId ? agentsKey(channelId) : ['channels', 'none', 'agents'],
    enabled: !!channelId,
    queryFn: async () => {
      const res = await api<{ agents: SessionAgentDto[] }>(
        `/api/sessions/${channelId}/agents`,
      );
      return applyPendingSessionAgentPatches(
        res.agents,
        pendingStatusPatches.current,
      );
    },
  });

  const onEvent = useCallback(
    (e: SessionStreamEvent) => {
      if (channelId && e.kind === 'connected') {
        pendingStatusPatches.current.clear();
        void qc.invalidateQueries({ queryKey: agentsKey(channelId) });
        return;
      }

      if (!channelId || e.kind !== 'agent_status') return;
      const p = e.payload as SessionAgentStatusPatch;
      if (!p?.agent_id) return;

      const prevPatch = pendingStatusPatches.current.get(p.agent_id);
      pendingStatusPatches.current.set(p.agent_id, {
        ...prevPatch,
        ...p,
      });

      const key = agentsKey(channelId);
      const current = qc.getQueryData<SessionAgentDto[]>(key);
      const hasCurrentRow = current?.some(a => a.agent_id === p.agent_id) ?? false;

      qc.setQueryData<SessionAgentDto[]>(key, prev =>
        prev ? prev.map(a => applySessionAgentPatch(a, p)) : prev,
      );

      if (!hasCurrentRow) {
        void qc.invalidateQueries({ queryKey: key });
      }
    },
    [qc, channelId],
  );
  useSessionStream(channelId, onEvent);

  return query;
}

export function useSendMessage(channelId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (content: string) => {
      if (!channelId) throw new Error('no channel selected');
      const res = await api<{ message: MessageDto }>(
        `/api/sessions/${channelId}/messages`,
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
        session_id: channelId,
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
        task_channel_id: null,
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

export function useStartAgent(channelId: string | null) {
  return useMutation({
    mutationFn: async (agentId: string) => {
      if (!channelId) throw new Error('no channel selected');
      await api(`/api/sessions/${channelId}/agents/${agentId}/start`, {
        method: 'POST',
      });
    },
  });
}

export function useStopAgent(channelId: string | null) {
  return useMutation({
    mutationFn: async (params: {
      agentId: string;
      mode?: 'soft' | 'hard';
      directive?: string;
    }) => {
      if (!channelId) throw new Error('no channel selected');
      await api(`/api/sessions/${channelId}/agents/${params.agentId}/stop`, {
        method: 'POST',
        body: JSON.stringify({
          mode: params.mode ?? 'hard',
          ...(params.directive ? { directive: params.directive } : {}),
        }),
      });
    },
  });
}

export function useCloseChannel(channelId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (summary: string) => {
      if (!channelId) throw new Error('no channel selected');
      const res = await api<{ session: SessionDto }>(
        `/api/sessions/${channelId}/close`,
        { method: 'POST', body: JSON.stringify({ summary }) },
      );
      return res.session;
    },
    onSuccess: (s) => {
      // Bump the workspace channels list so the sidebar reflects archived state.
      qc.invalidateQueries({
        queryKey: ['workspaces', s.channel_id, 'channels'],
      });
    },
  });
}

/**
 * Ephemeral per-agent run states for the current channel.
 *
 * - Initial GET from `/api/sessions/:id/agent-run-states` (snapshot on
 *   mount / reconnect — returns all currently in-flight states).
 * - Live `agent_activity` events are ingested by the shared session stream
 *   layer so the cache stays warm even during the stream close grace period.
 */
export function useAgentRunStates(channelId: string | null) {
  const qc = useQueryClient();
  const key = channelId
    ? agentRunStatesKey(channelId)
    : ['channels', 'none', 'agent-run-states'];
  const query = useQuery({
    queryKey: key,
    enabled: !!channelId,
    queryFn: async () => {
      const requestedAt = Date.now();
      const res = await api<AgentRunStatesDto>(
        `/api/sessions/${channelId}/agent-run-states`,
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
    (e: SessionStreamEvent) => {
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
  useSessionStream(channelId, onEvent);

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
        `/api/channels/${workspaceId}/unread-by-session`,
      );
      return res.counts;
    },
  });
}

/**
 * Per-channel message unread counts for the channels sidebar badge.
 * Backed by the session_reads cursor system — counts any message with
 * seq > viewer's last_read_seq. Polls every 5 s.
 */
export function useMessageUnreadCounts(workspaceId: string | null) {
  return useQuery({
    queryKey: ['workspaces', workspaceId, 'message-unread'],
    enabled: !!workspaceId,
    refetchInterval: 5_000,
    queryFn: async () => {
      const res = await api<{ by_session: Record<string, number>; total: number }>(
        `/api/channels/${workspaceId}/message-unread`,
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
 * useMarkMessageChannelRead for the session_reads cursor system.
 */
export function useMarkChannelRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (channelId: string) => {
      await api('/api/notifications/read', {
        method: 'POST',
        body: JSON.stringify({ session_id: channelId }),
      });
    },
    onSuccess: () => {
      // Invalidate per-channel caches AND the workspace-level unread summary
      // so the left sidebar workspace badge shrinks immediately rather than
      // waiting for the next 5 s polling cycle.
      void qc.invalidateQueries({ queryKey: ['workspaces'] });
      void qc.invalidateQueries({ queryKey: ['notifications', 'unread'] });
    },
  });
}

/**
 * Advance the viewer's read cursor for a channel to its latest message.
 * Backed by the session_reads cursor — clears message unread badges.
 * The backend resolves the viewer's user id from X-Silverhand-User-Id
 * (injected by api()) so no body is required.
 */
export function useMarkMessageChannelRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (channelId: string) => {
      await api(`/api/sessions/${channelId}/mark-read`, { method: 'POST' });
    },
    onSuccess: () => {
      // TanStack Query v5 prefix-matches ['workspaces', ...] so this also
      // hits ['workspaces', workspaceId, 'message-unread'] and
      // ['message-unread', 'summary'].
      void qc.invalidateQueries({ queryKey: ['workspaces'] });
      void qc.invalidateQueries({ queryKey: ['message-unread', 'summary'] });
    },
  });
}

/**
 * Global message unread summary across ALL workspaces.
 * Backed by session_reads — returns total unread message count per workspace.
 * Used by the workspace sidebar to show per-workspace unread badges.
 * Polls every 5 s alongside the per-channel hook.
 */
export function useMessageUnreadSummary() {
  return useQuery({
    queryKey: ['message-unread', 'summary'],
    refetchInterval: 5_000,
    queryFn: () =>
      api<{ by_channel: Record<string, number> }>(apiPaths.messageUnreadSummary),
  });
}
