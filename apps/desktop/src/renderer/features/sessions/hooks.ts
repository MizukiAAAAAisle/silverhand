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

const messagesKey = (sid: string) => ['sessions', sid, 'messages'] as const;
const agentsKey = (sid: string) => ['sessions', sid, 'agents'] as const;
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
export function useSessionMessages(sessionId: string | null) {
  const qc = useQueryClient();
  const query = useInfiniteQuery<
    SessionMessagesDto,
    Error,
    InfiniteData<SessionMessagesDto, number | undefined>,
    ReturnType<typeof messagesKey>,
    number | undefined
  >({
    queryKey: messagesKey(sessionId ?? 'none'),
    enabled: !!sessionId,
    initialPageParam: undefined as number | undefined,
    queryFn: async ({ pageParam }) => {
      const params = new URLSearchParams({
        limit: String(MESSAGE_PAGE_LIMIT),
      });
      if (typeof pageParam === 'number') {
        params.set('before_seq', String(pageParam));
      }
      return api<SessionMessagesDto>(
        `${apiPaths.sessionMessages(sessionId!)}?${params.toString()}`,
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
      if (!sessionId || e.kind !== 'message') return;
      const msg = e.payload?.message as MessageDto | undefined;
      if (!msg) return;
      qc.setQueryData<MessagesCache>(messagesKey(sessionId), prev =>
        appendMessageToCache(prev, msg),
      );
    },
    [qc, sessionId],
  );
  useSessionStream(sessionId, onEvent);

  return { ...query, data: messages };
}

/** Initial GET + live update on `agent_status` SSE events. */
export function useSessionAgents(sessionId: string | null) {
  const qc = useQueryClient();
  const pendingStatusPatches = useRef<Map<string, SessionAgentStatusPatch>>(
    new Map(),
  );

  useEffect(() => {
    pendingStatusPatches.current.clear();
  }, [sessionId]);

  const query = useQuery({
    queryKey: sessionId ? agentsKey(sessionId) : ['sessions', 'none', 'agents'],
    enabled: !!sessionId,
    queryFn: async () => {
      const res = await api<{ agents: SessionAgentDto[] }>(
        `/api/sessions/${sessionId}/agents`,
      );
      return applyPendingSessionAgentPatches(
        res.agents,
        pendingStatusPatches.current,
      );
    },
  });

  const onEvent = useCallback(
    (e: SessionStreamEvent) => {
      if (sessionId && e.kind === 'connected') {
        pendingStatusPatches.current.clear();
        void qc.invalidateQueries({ queryKey: agentsKey(sessionId) });
        return;
      }

      if (!sessionId || e.kind !== 'agent_status') return;
      const p = e.payload as SessionAgentStatusPatch;
      if (!p?.agent_id) return;

      const prevPatch = pendingStatusPatches.current.get(p.agent_id);
      pendingStatusPatches.current.set(p.agent_id, {
        ...prevPatch,
        ...p,
      });

      const key = agentsKey(sessionId);
      const current = qc.getQueryData<SessionAgentDto[]>(key);
      const hasCurrentRow = current?.some(a => a.agent_id === p.agent_id) ?? false;

      qc.setQueryData<SessionAgentDto[]>(key, prev =>
        prev ? prev.map(a => applySessionAgentPatch(a, p)) : prev,
      );

      if (!hasCurrentRow) {
        void qc.invalidateQueries({ queryKey: key });
      }
    },
    [qc, sessionId],
  );
  useSessionStream(sessionId, onEvent);

  return query;
}

export function useSendMessage(sessionId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (content: string) => {
      if (!sessionId) throw new Error('no session selected');
      const res = await api<{ message: MessageDto }>(
        `/api/sessions/${sessionId}/messages`,
        { method: 'POST', body: JSON.stringify({ content }) },
      );
      return res.message;
    },
    // Optimistic update: show the message immediately on Enter, before
    // the HTTP response arrives. The temp message uses a `pending-` id;
    // onSuccess replaces it with the real row (SSE's de-dup prevents a
    // second append when the event arrives after onSuccess).
    onMutate: async (content: string) => {
      if (!sessionId) return undefined;
      const key = messagesKey(sessionId);
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<MessagesCache>(key);
      const tempId = `pending-${crypto.randomUUID()}`;
      const tempMsg: MessageDto = {
        id: tempId,
        session_id: sessionId,
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
      if (!sessionId || !ctx) return;
      const key = messagesKey(sessionId);
      qc.setQueryData<MessagesCache>(key, cur =>
        replacePendingMessageInCache(cur, ctx.tempId, msg),
      );
    },
    onError: (_err, _content, ctx) => {
      if (!sessionId || !ctx) return;
      const key = messagesKey(sessionId);
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

export function useStartAgent(sessionId: string | null) {
  return useMutation({
    mutationFn: async (agentId: string) => {
      if (!sessionId) throw new Error('no session selected');
      await api(`/api/sessions/${sessionId}/agents/${agentId}/start`, {
        method: 'POST',
      });
    },
  });
}

export function useStopAgent(sessionId: string | null) {
  return useMutation({
    mutationFn: async (params: {
      agentId: string;
      mode?: 'soft' | 'hard';
      directive?: string;
    }) => {
      if (!sessionId) throw new Error('no session selected');
      await api(`/api/sessions/${sessionId}/agents/${params.agentId}/stop`, {
        method: 'POST',
        body: JSON.stringify({
          mode: params.mode ?? 'hard',
          ...(params.directive ? { directive: params.directive } : {}),
        }),
      });
    },
  });
}

export function useCloseSession(sessionId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (summary: string) => {
      if (!sessionId) throw new Error('no session selected');
      const res = await api<{ session: SessionDto }>(
        `/api/sessions/${sessionId}/close`,
        { method: 'POST', body: JSON.stringify({ summary }) },
      );
      return res.session;
    },
    onSuccess: (s) => {
      // Bump the channel sessions list so the sidebar reflects archived state.
      qc.invalidateQueries({
        queryKey: ['channels', s.channel_id, 'sessions'],
      });
    },
  });
}

/**
 * Ephemeral per-agent run states for the current session.
 *
 * - Initial GET from `/api/sessions/:id/agent-run-states` (snapshot on
 *   mount / reconnect — returns all currently in-flight states).
 * - Live `agent_activity` events are ingested by the shared session stream
 *   layer so the cache stays warm even during the stream close grace period.
 */
export function useAgentRunStates(sessionId: string | null) {
  const qc = useQueryClient();
  const key = sessionId
    ? agentRunStatesKey(sessionId)
    : ['sessions', 'none', 'agent-run-states'];
  const query = useQuery({
    queryKey: key,
    enabled: !!sessionId,
    queryFn: async () => {
      const requestedAt = Date.now();
      const res = await api<AgentRunStatesDto>(
        `/api/sessions/${sessionId}/agent-run-states`,
      );
      return reconcileAgentRunStateSnapshot(
        qc.getQueryData(sessionId ? agentRunStatesKey(sessionId) : key),
        res.states,
        requestedAt,
      );
    },
    // Don't stale-refetch automatically — SSE keeps this up-to-date.
    staleTime: Infinity,
    refetchOnMount: 'always',
    // Keep recent activity visible across quick session/thread navigation.
    gcTime: AGENT_RUN_STATES_GC_MS,
  });

  const onEvent = useCallback(
    (e: SessionStreamEvent) => {
      // On (re)connect, snapshot may have drifted — runs may have ended or
      // started while the SSE was down. Refetch the snapshot to reconcile;
      // the query function merges any newer SSE updates that arrived while
      // the snapshot request was in flight.
      if (sessionId && e.kind === 'connected') {
        void qc.invalidateQueries({ queryKey: agentRunStatesKey(sessionId) });
      }
    },
    [qc, sessionId],
  );
  useSessionStream(sessionId, onEvent);

  return query;
}

/**
 * Per-session unread notification counts for the sessions sidebar badge.
 * Polls every 5 s so badges update without requiring a manual refresh.
 *
 * @deprecated Backed by the notification system (mention_external /
 * agent_start_failed only). Use useMessageUnreadCounts for IM-style
 * message unread badges.
 */
export function useSessionUnreadCounts(channelId: string | null) {
  return useQuery({
    queryKey: ['channels', channelId, 'unread-by-session'],
    enabled: !!channelId,
    refetchInterval: 5_000,
    queryFn: async () => {
      const res = await api<{ counts: Record<string, number> }>(
        `/api/channels/${channelId}/unread-by-session`,
      );
      return res.counts;
    },
  });
}

/**
 * Per-session message unread counts for the sessions sidebar badge.
 * Backed by the session_reads cursor system — counts any message with
 * seq > viewer's last_read_seq (from_kind != 'user' authored by the
 * viewer is excluded). Polls every 5 s.
 */
export function useMessageUnreadCounts(channelId: string | null) {
  return useQuery({
    queryKey: ['channels', channelId, 'message-unread'],
    enabled: !!channelId,
    refetchInterval: 5_000,
    queryFn: async () => {
      const res = await api<{ by_session: Record<string, number>; total: number }>(
        `/api/channels/${channelId}/message-unread`,
      );
      return res;
    },
  });
}

/**
 * Mark all unread notifications for a session as read.
 * Called whenever the user navigates to a session so the badge clears.
 *
 * @deprecated Clears notification-based badges only. Use
 * useMarkMessageSessionRead for the session_reads cursor system.
 */
export function useMarkSessionRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (sessionId: string) => {
      await api('/api/notifications/read', {
        method: 'POST',
        body: JSON.stringify({ session_id: sessionId }),
      });
    },
    onSuccess: () => {
      // Invalidate per-session caches AND the channel-level unread summary
      // so the left sidebar channel badge shrinks immediately rather than
      // waiting for the next 5 s polling cycle.
      void qc.invalidateQueries({ queryKey: ['channels'] });
      void qc.invalidateQueries({ queryKey: ['notifications', 'unread'] });
    },
  });
}

/**
 * Advance the viewer's read cursor for a session to its latest message.
 * Backed by the session_reads cursor — clears message unread badges.
 * The backend resolves the viewer's user id from X-Silverhand-User-Id
 * (injected by api()) so no body is required.
 *
 * Exclusion: messages authored by the current viewer are never counted
 * as unread (the backend excludes rows where from_kind='user' AND
 * from_user_id matches the viewer). Other authors — agents, system
 * messages, and future human users — all count.
 */
export function useMarkMessageSessionRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (sessionId: string) => {
      await api(`/api/sessions/${sessionId}/mark-read`, { method: 'POST' });
    },
    onSuccess: () => {
      // TanStack Query v5 prefix-matches ['channels', ...] so this also
      // hits ['channels', channelId, 'message-unread'] and
      // ['message-unread', 'summary'].
      void qc.invalidateQueries({ queryKey: ['channels'] });
      void qc.invalidateQueries({ queryKey: ['message-unread', 'summary'] });
    },
  });
}

/**
 * Global message unread summary across ALL channels.
 * Backed by session_reads — returns total unread message count per channel.
 * Used by the channel sidebar to show per-channel unread badges.
 * Polls every 5 s alongside the per-session hook.
 *
 * Requires backend: GET /api/message-unread-summary
 * → { by_channel: Record<channelId, number> }
 */
export function useMessageUnreadSummary() {
  return useQuery({
    queryKey: ['message-unread', 'summary'],
    refetchInterval: 5_000,
    queryFn: () =>
      api<{ by_channel: Record<string, number> }>(apiPaths.messageUnreadSummary),
  });
}
