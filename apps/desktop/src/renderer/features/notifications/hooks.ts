import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  MarkNotificationsReadInput,
  NotificationDto,
} from '@silverhand/shared';
import { api } from '@/lib/api';

const unreadKey = ['notifications', 'unread'] as const;
const listKey = ['notifications', 'list'] as const;

export interface UnreadCounts {
  total: number;
  by_channel: Record<string, number>;
  /** Most-recent unread pointer per channel — drives DM-click jump. */
  latest_by_channel: Record<string, { session_id: string; message_id: string }>;
}

/**
 * Polled summary of unread notifications. Refreshes every 5s while
 * mounted so the sidebar dot appears within ~one polling window of
 * the underlying CC happening — no SSE channel exists yet for this
 * (would need a per-user multiplexed stream; out of scope for v1).
 */
export function useUnreadCounts() {
  return useQuery<UnreadCounts>({
    queryKey: unreadKey,
    queryFn: () => api<UnreadCounts>('/api/notifications/unread'),
    refetchInterval: 5_000,
    staleTime: 2_000,
  });
}

/** Full notification list — currently unused, but in place for the
 *  upcoming notifications panel. */
export function useNotifications(unread = false) {
  return useQuery<{ notifications: NotificationDto[] }>({
    queryKey: [...listKey, { unread }],
    queryFn: () =>
      api<{ notifications: NotificationDto[] }>(
        `/api/notifications${unread ? '?unread=1' : ''}`,
      ),
  });
}

export function useMarkNotificationsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: MarkNotificationsReadInput) =>
      api<{ marked: number }>('/api/notifications/read', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: unreadKey });
      qc.invalidateQueries({ queryKey: listKey });
    },
  });
}
