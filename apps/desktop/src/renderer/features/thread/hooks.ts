import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { api } from '@/lib/api';
import { apiPaths, type SessionDto } from '@silverhand/shared';
import { useSessionStream, type SessionStreamEvent } from '@/hooks/useSessionStream';

const channelSessionsKey = (channelId: string) =>
  ['channels', channelId, 'sessions'] as const;

/**
 * Start a thread on a message → backend creates a child session
 * anchored to it. On success, invalidate the channel's session list so
 * the new child appears in the SessionsSidebar tree.
 */
export function useStartThread(channelId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (messageId: string) => {
      const res = await api<{
        child_session_id: string;
        session?: SessionDto;
      }>(
        apiPaths.messageThread(messageId),
        { method: 'POST' },
      );
      return res;
    },
    onSuccess: res => {
      if (channelId) {
        if (res.session) {
          qc.setQueryData<SessionDto[]>(
            channelSessionsKey(channelId),
            prev => {
              const cur = prev ?? [];
              if (cur.some(s => s.id === res.session!.id)) {
                return cur.map(s => (s.id === res.session!.id ? res.session! : s));
              }
              return [...cur, res.session!];
            },
          );
        }
        void qc.invalidateQueries({
          queryKey: channelSessionsKey(channelId),
        });
      }
    },
  });
}

export interface ThreadSummary {
  child_session_id: string;
  anchor_message_id: string;
  reply_count: number;
}

const threadsKey = (sid: string) => ['sessions', sid, 'threads'] as const;

/**
 * Open-thread summary for a parent session — one row per open child
 * with its anchor message id and the count of non-system replies.
 *
 * One bulk fetch per session (no N+1 per message). Live-refreshed via
 * the parent's SSE `thread_updated` event, which backend publishes on:
 * thread create, child receives a message, child closes.
 */
export function useSessionThreads(
  sessionId: string | null,
  channelId: string | null,
) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: sessionId
      ? threadsKey(sessionId)
      : ['sessions', 'none', 'threads'],
    enabled: !!sessionId,
    queryFn: async () => {
      const res = await api<{ threads: ThreadSummary[] }>(
        apiPaths.sessionThreads(sessionId!),
      );
      return res.threads;
    },
  });

  const onEvent = useCallback(
    (e: SessionStreamEvent) => {
      if (!sessionId || e.kind !== 'thread_updated') return;
      void qc.invalidateQueries({ queryKey: threadsKey(sessionId) });
      if (channelId) {
        void qc.invalidateQueries({
          queryKey: channelSessionsKey(channelId),
        });
      }
    },
    [qc, sessionId, channelId],
  );
  useSessionStream(sessionId, onEvent);

  return query;
}
