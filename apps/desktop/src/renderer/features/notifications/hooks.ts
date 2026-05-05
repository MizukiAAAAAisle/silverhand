import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type {
  MarkNotificationsReadInput,
  NotificationDto,
} from '@silverhand/shared';
import { api } from '@/lib/api';

const unreadKey = ['notifications', 'unread'] as const;
const listKey = ['notifications', 'list'] as const;

export interface UnreadCounts {
  total: number;
  by_workspace: Record<string, number>;
  /** Most-recent unread pointer per workspace/sidebar item — drives badge-click jump. */
  latest_by_workspace: Record<string, { conversation_id: string; message_id: string }>;
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

/**
 * Mount this once at the App root. Polls unread notifications every 5s,
 * deduplicates by notification id, and fires:
 *  - an in-app toast (sonner) for every new notification
 *  - a system notification via IPC when the app is not in the foreground
 *    (main process guards on isFocused() to avoid double-alerting)
 *
 * Suppresses toasts for the currently active channel (user can already
 * see it) unless the kind is `agent_start_failed` (always shown — it's
 * an error condition regardless of focus).
 */
export function useNotificationToasts(activeChannelId: string | null) {
  const qc = useQueryClient();
  const { data } = useQuery<{ notifications: NotificationDto[] }>({
    queryKey: [...listKey, { unread: true, toasts: true }],
    queryFn: () => api<{ notifications: NotificationDto[] }>('/api/notifications?unread=1'),
    refetchInterval: 5_000,
    staleTime: 2_000,
  });

  const seenIds = useRef<Set<string>>(new Set());
  const initialized = useRef(false);

  useEffect(() => {
    if (!data) return;
    const notifications = data.notifications;

    if (!initialized.current) {
      // First load: mark all existing notifications as seen without
      // toasting — we only alert for genuinely new arrivals.
      for (const n of notifications) seenIds.current.add(n.id);
      initialized.current = true;
      return;
    }

    const toastIds: string[] = [];

    for (const n of notifications) {
      if (seenIds.current.has(n.id)) continue;
      seenIds.current.add(n.id);

      const isAgentFailure = n.kind === 'agent_start_failed';

      // Suppress channel-match notifications unless it's an error.
      if (
        !isAgentFailure &&
        n.conversation_id &&
        n.conversation_id === activeChannelId
      ) {
        continue;
      }

      const label = buildToastLabel(n);

      if (isAgentFailure) {
        toast.error(label);
      } else {
        toast(label);
      }

      toastIds.push(n.id);

      // System notification — main process only fires it when no Electron
      // window is focused, so we always call this unconditionally here.
      void window.agentHub.showSystemNotification({ title: 'Silverhand', body: label });
    }

    // Mark toasted notifications as read so they don't accumulate in the
    // unread list. Fire-and-forget; failure only means a stale badge, not
    // a broken UI. One call per notification avoids a batch endpoint.
    for (const id of toastIds) {
      void api('/api/notifications/read', {
        method: 'POST',
        body: JSON.stringify({ id }),
      }).then(() => {
        qc.invalidateQueries({ queryKey: unreadKey });
      });
    }
  }, [data, activeChannelId, qc]);
}

function buildToastLabel(n: NotificationDto): string {
  if (n.kind === 'agent_start_failed') {
    const name = (n.payload?.['agent_name'] as string | undefined) ?? n.agent_id ?? 'Agent';
    const reason = n.payload?.['reason'] as string | undefined;
    if (reason === 'init_timeout') return `@${name} 启动超时`;
    if (reason === 'runtime_crash') {
      const code = n.payload?.['exit_code'];
      return `@${name} 运行异常退出${code != null ? `（exit ${code}）` : ''}`;
    }
    const error = (n.payload?.['error'] as string | undefined) ?? 'unknown error';
    return `@${name} 启动失败：${error}`;
  }
  if (n.kind === 'mention_external') {
    const channelName = n.payload?.['source_workspace_name'] as string | undefined;
    return channelName ? `你在 #${channelName} 有新提及` : '新提及消息';
  }
  return '新通知';
}
