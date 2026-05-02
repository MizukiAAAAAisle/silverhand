import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useCallback } from 'react';
import type {
  MessageDto,
  SessionAgentDto,
  SessionDto,
} from '@silverhand/shared';
import { api } from '@/lib/api';
import { useSessionStream, type SessionStreamEvent } from '@/hooks/useSessionStream';

const messagesKey = (sid: string) => ['sessions', sid, 'messages'] as const;
const agentsKey = (sid: string) => ['sessions', sid, 'agents'] as const;

/** Initial GET + live append on `message` SSE events. */
export function useSessionMessages(sessionId: string | null) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: sessionId
      ? messagesKey(sessionId)
      : ['sessions', 'none', 'messages'],
    enabled: !!sessionId,
    queryFn: async () => {
      const res = await api<{ messages: MessageDto[] }>(
        `/api/sessions/${sessionId}/messages`,
      );
      return res.messages;
    },
  });

  const onEvent = useCallback(
    (e: SessionStreamEvent) => {
      if (!sessionId || e.kind !== 'message') return;
      const msg = e.payload?.message as MessageDto | undefined;
      if (!msg) return;
      qc.setQueryData<MessageDto[]>(messagesKey(sessionId), prev => {
        const cur = prev ?? [];
        if (cur.some(m => m.id === msg.id)) return cur; // de-dup
        return [...cur, msg];
      });
    },
    [qc, sessionId],
  );
  useSessionStream(sessionId, onEvent);

  return query;
}

/** Initial GET + live update on `agent_status` SSE events. */
export function useSessionAgents(sessionId: string | null) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: sessionId ? agentsKey(sessionId) : ['sessions', 'none', 'agents'],
    enabled: !!sessionId,
    queryFn: async () => {
      const res = await api<{ agents: SessionAgentDto[] }>(
        `/api/sessions/${sessionId}/agents`,
      );
      return res.agents;
    },
  });

  const onEvent = useCallback(
    (e: SessionStreamEvent) => {
      if (!sessionId || e.kind !== 'agent_status') return;
      const p = e.payload as {
        agent_id: string;
        status?: SessionAgentDto['status'];
        pid?: number | null;
        cli_session_id?: string | null;
      };
      if (!p?.agent_id) return;
      qc.setQueryData<SessionAgentDto[]>(agentsKey(sessionId), prev => {
        const cur = prev ?? [];
        return cur.map(a =>
          a.agent_id === p.agent_id
            ? {
                ...a,
                ...(p.status !== undefined ? { status: p.status } : {}),
                ...(p.pid !== undefined ? { pid: p.pid } : {}),
                ...(p.cli_session_id !== undefined
                  ? { cli_session_id: p.cli_session_id }
                  : {}),
              }
            : a,
        );
      });
    },
    [qc, sessionId],
  );
  useSessionStream(sessionId, onEvent);

  return query;
}

export function useSendMessage(sessionId: string | null) {
  return useMutation({
    mutationFn: async (content: string) => {
      if (!sessionId) throw new Error('no session selected');
      const res = await api<{ message: MessageDto }>(
        `/api/sessions/${sessionId}/messages`,
        { method: 'POST', body: JSON.stringify({ content }) },
      );
      return res.message;
    },
    // No onSuccess invalidate: the SSE `message` event will append it.
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
