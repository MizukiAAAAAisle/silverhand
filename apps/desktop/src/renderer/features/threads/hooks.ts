import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { api } from '@/lib/api';
import { apiPaths, type SessionDto } from '@silverhand/shared';
import { useSessionStream, type SessionStreamEvent } from '@/hooks/useSessionStream';

const workspaceChannelsKey = (workspaceId: string) =>
  ['workspaces', workspaceId, 'channels'] as const;

/**
 * Start a thread on a message → backend creates a child session
 * anchored to it. On success, invalidate the workspace's channel list so
 * the new thread appears in the ChannelsSidebar tree.
 */
export function useStartThread(workspaceId: string | null) {
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
      if (workspaceId) {
        if (res.session) {
          qc.setQueryData<SessionDto[]>(
            workspaceChannelsKey(workspaceId),
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
          queryKey: workspaceChannelsKey(workspaceId),
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

const threadsKey = (cid: string) => ['channels', cid, 'threads'] as const;

/**
 * Open-thread summary for a parent channel — one row per open thread
 * with its anchor message id and the count of non-system replies.
 *
 * One bulk fetch per channel (no N+1 per message). Live-refreshed via
 * the parent's SSE `thread_updated` event, which backend publishes on:
 * thread create, thread receives a message, thread closes.
 */
export function useChannelThreads(
  channelId: string | null,
  workspaceId: string | null,
) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: channelId
      ? threadsKey(channelId)
      : ['channels', 'none', 'threads'],
    enabled: !!channelId,
    queryFn: async () => {
      const res = await api<{ threads: ThreadSummary[] }>(
        apiPaths.sessionThreads(channelId!),
      );
      return res.threads;
    },
  });

  const onEvent = useCallback(
    (e: SessionStreamEvent) => {
      if (!channelId || e.kind !== 'thread_updated') return;
      void qc.invalidateQueries({ queryKey: threadsKey(channelId) });
      if (workspaceId) {
        void qc.invalidateQueries({
          queryKey: workspaceChannelsKey(workspaceId),
        });
      }
    },
    [qc, channelId, workspaceId],
  );
  useSessionStream(channelId, onEvent);

  return query;
}
