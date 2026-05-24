import { useCallback, useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  apiPaths,
  type ConversationRef,
  type MarkNotificationsReadInput,
  type NotificationDto,
} from '@silverhand/shared';
import { api } from '@/lib/api';
import { onWsFrame, subscribeViewerScope, isCurrentViewerScope } from '@/lib/ws-client';
import type { MessageJumpTarget } from '@/features/channels/useMessageJumpController';

const unreadKey = ['notifications', 'unread'] as const;
const listKey = ['notifications', 'list'] as const;
const invalidationTimers = new Map<string, ReturnType<typeof setTimeout>>();

function invalidateQueryDebounced(
  qc: ReturnType<typeof useQueryClient>,
  queryKey: readonly unknown[],
): void {
  const key = JSON.stringify(queryKey);
  const existing = invalidationTimers.get(key);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    invalidationTimers.delete(key);
    void qc.invalidateQueries({ queryKey });
  }, 100);
  invalidationTimers.set(key, timer);
}

function isMessageUnreadUpdatedPayload(payload: unknown): boolean {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    typeof (payload as { conversation_id?: unknown }).conversation_id === 'string'
  );
}

export interface UnreadCounts {
  total: number;
  by_workspace: Record<string, number>;
  /** Most-recent unread pointer per workspace/sidebar item — drives badge-click jump. */
  latest_by_workspace: Record<string, { conversation_id: string; message_id: string }>;
}

/**
 * Unread notification counts. Subscribes to the WS viewer scope and
 * invalidates on `notification` events — no more 5 s polling.
 */
export function useUnreadCounts() {
  const qc = useQueryClient();

  useEffect(() => {
    const sub = subscribeViewerScope();
    const unsub = onWsFrame(frame => {
      if (frame.type === 'event' && isCurrentViewerScope(frame.scope)) {
        if (
          frame.kind === 'notification' ||
          (frame.kind === 'unread_updated' && !isMessageUnreadUpdatedPayload(frame.payload))
        ) {
          invalidateQueryDebounced(qc, unreadKey);
        }
      } else if (frame.type === 'snapshot_required' && isCurrentViewerScope(frame.scope)) {
        invalidateQueryDebounced(qc, unreadKey);
      }
    });
    return () => {
      sub.unsubscribe();
      unsub();
    };
  }, [qc]);

  return useQuery<UnreadCounts>({
    queryKey: unreadKey,
    queryFn: () => api<UnreadCounts>('/api/notifications/unread'),
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
    onSuccess: data => {
      if (data.marked > 0) {
        qc.invalidateQueries({ queryKey: listKey });
      }
    },
  });
}

/**
 * Mount this once at the App root. Listens for WS viewer-scoped notification
 * events (replacing the previous 5 s poll) and fires:
 *  - an in-app toast (sonner) for every new notification
 *  - a system notification via IPC when the app is not in the foreground
 *
 * Suppresses toasts for the currently active channel (user can already
 * see it) unless the kind is `agent_start_failed` (always shown — it's
 * an error condition regardless of focus).
 *
 * Click navigation: both toast `onClick` and native-notification click
 * are routed through `onJump`. When omitted, notifications are still
 * shown but inert. `agent_start_failed` is intentionally not clickable
 * (no message anchor to focus on).
 */
export function useNotificationToasts(
  activeChannelId: string | null,
  onJump?: (target: MessageJumpTarget) => void,
) {
  const qc = useQueryClient();
  const { data } = useQuery<{ notifications: NotificationDto[] }>({
    queryKey: [...listKey, { unread: true, toasts: true }],
    queryFn: () => api<{ notifications: NotificationDto[] }>('/api/notifications?unread=1'),
    staleTime: 2_000,
  });

  const seenIds = useRef<Set<string>>(new Set());
  const initialized = useRef(false);
  // Live notification rows the user can click on. Toast `onClick` reads
  // straight from this map; native-notification clicks come back from
  // main as ids and look up here too. We keep it as a ref instead of
  // closing over `data` so a stale closure (delivered to main yesterday,
  // clicked today) still resolves correctly.
  const clickableById = useRef<Map<string, NotificationDto>>(new Map());
  // Stable callback ref so the WS subscribe effect doesn't tear down
  // every time the parent's nav handler re-renders.
  const onJumpRef = useRef(onJump);
  useEffect(() => {
    onJumpRef.current = onJump;
  }, [onJump]);

  const handleClickById = useCallback(
    (notificationId: string): void => {
      const n = clickableById.current.get(notificationId);
      if (!n) return;
      const handler = onJumpRef.current;
      if (!handler) return;
      void resolveNotificationJumpTarget(n, qc).then(target => {
        if (!target) return;
        handler(target);
      });
    },
    [qc],
  );

  // Toasts need the latest notification rows only when a new notification
  // arrives. `unread_updated` is a badge/read-cursor signal and would make
  // every channel switch refetch the toast list.
  useEffect(() => {
    const sub = subscribeViewerScope();
    const toastKey = [...listKey, { unread: true, toasts: true }] as const;
    const unsub = onWsFrame(frame => {
      if (frame.type === 'event' && isCurrentViewerScope(frame.scope)) {
        if (frame.kind === 'notification') {
          invalidateQueryDebounced(qc, toastKey);
        }
      } else if (frame.type === 'snapshot_required' && isCurrentViewerScope(frame.scope)) {
        invalidateQueryDebounced(qc, toastKey);
      }
    });
    return () => {
      sub.unsubscribe();
      unsub();
    };
  }, [qc]);

  // Native-notification click bridge. Main process forwards the
  // `notificationId` originally passed to `showSystemNotification`
  // back here when the user clicks the OS-level alert.
  useEffect(() => {
    return window.agentHub.onNotificationClicked(handleClickById);
  }, [handleClickById]);

  useEffect(() => {
    if (!data) return;
    const notifications = data.notifications;

    if (!initialized.current) {
      // First load: mark all existing notifications as seen without
      // toasting — we only alert for genuinely new arrivals.
      for (const n of notifications) {
        seenIds.current.add(n.id);
        if (isClickableKind(n.kind)) clickableById.current.set(n.id, n);
      }
      initialized.current = true;
      return;
    }

    const toastIds: string[] = [];

    for (const n of notifications) {
      if (seenIds.current.has(n.id)) continue;
      seenIds.current.add(n.id);
      if (isClickableKind(n.kind)) clickableById.current.set(n.id, n);

      const isAgentFailure = n.kind === 'agent_start_failed';
      const isViewerMention = n.kind === 'mention_self';

      // Suppress channel-match notifications unless it's an error.
      if (
        !isAgentFailure &&
        !isViewerMention &&
        n.conversation_id &&
        n.conversation_id === activeChannelId
      ) {
        continue;
      }

      const label = buildToastLabel(n);
      // Sonner's `ExternalToast` doesn't expose a whole-surface
      // `onClick`; the idiomatic pattern is the `action` button. We
      // surface "查看" so a click on the toast's affordance jumps to
      // the source message. The system-notification path (main process)
      // still fires on full-surface click — that one is governed by
      // the OS-level Notification semantics, not sonner.
      const toastOptions = isClickableKind(n.kind)
        ? {
            action: {
              label: '查看',
              onClick: () => handleClickById(n.id),
            },
          }
        : undefined;

      if (isAgentFailure) {
        toast.error(label, toastOptions);
      } else {
        toast(label, toastOptions);
      }

      toastIds.push(n.id);

      // System notification — main process suppresses ordinary alerts when an
      // Electron window is focused; direct human mentions opt out via `force`.
      void window.agentHub.showSystemNotification({
        title: 'Silverhand',
        body: buildSystemNotificationBody(n),
        force: isViewerMention,
        notificationId: isClickableKind(n.kind) ? n.id : undefined,
      });
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
  }, [data, activeChannelId, qc, handleClickById]);
}

/**
 * Whether a given notification kind has a meaningful click destination.
 * `mention_self` and `mention_external` open the source message;
 * `agent_start_failed` has no message anchor and is intentionally inert
 * (the user can find the failed agent via the regular Members panel).
 */
function isClickableKind(kind: NotificationDto['kind']): boolean {
  return kind === 'mention_self' || kind === 'mention_external';
}

/**
 * Map a notification row onto a `MessageJumpTarget`. The jump path
 * needs the *channel* id and an optional thread id; notifications
 * carry the conversation id directly, which may be a thread. Resolves
 * the conversation-ref via React Query's cache so repeated clicks
 * (and `useConversationById` reads of the same id) share the lookup.
 *
 * Returns `null` for kinds without a navigable target or when the
 * required ids are missing (e.g. malformed `mention_external` row).
 */
export async function resolveNotificationJumpTarget(
  n: NotificationDto,
  qc: ReturnType<typeof useQueryClient>,
): Promise<MessageJumpTarget | null> {
  if (n.kind === 'mention_self') {
    if (!n.conversation_id || !n.message_id) return null;
    return resolveTargetFromConversationId(
      qc,
      n.workspace_id,
      n.conversation_id,
      n.message_id,
    );
  }
  if (n.kind === 'mention_external') {
    // Original mention site lives in the source workspace. The local
    // `conversation_id` is the synthesized DM Mentions channel; we
    // intentionally bypass it and jump straight to the foreign source
    // so the user lands on the actual message.
    if (
      !n.source_workspace_id ||
      !n.source_conversation_id ||
      !n.source_message_id
    ) {
      return null;
    }
    return resolveTargetFromConversationId(
      qc,
      n.source_workspace_id,
      n.source_conversation_id,
      n.source_message_id,
    );
  }
  return null;
}

async function resolveTargetFromConversationId(
  qc: ReturnType<typeof useQueryClient>,
  workspaceId: string | null,
  conversationId: string,
  messageId: string,
): Promise<MessageJumpTarget> {
  // Cached against the same key `useConversationById` uses, so a
  // recently-resolved cross-workspace `?side` ref is reused for free.
  const data = await qc
    .fetchQuery<{ ref: ConversationRef }>({
      queryKey: ['conversation-ref', conversationId],
      queryFn: () => api<{ ref: ConversationRef }>(apiPaths.conversationRef(conversationId)),
      staleTime: 30_000,
    })
    .catch(() => null);
  if (!data) {
    // Fetch failed — fall back to treating the id as a top-level
    // channel. Worse case the jump primer reports `not_found` and the
    // user sees an empty state; better than silently swallowing the click.
    return {
      workspaceId: workspaceId ?? undefined,
      channelId: conversationId,
      threadId: null,
      messageId,
    };
  }
  const ref = data.ref;
  const resolvedWorkspaceId = workspaceId ?? ref.workspace_id;
  if (ref.kind === 'thread' && ref.parent_channel_id) {
    return {
      workspaceId: resolvedWorkspaceId,
      channelId: ref.parent_channel_id,
      threadId: ref.id,
      messageId,
    };
  }
  return {
    workspaceId: resolvedWorkspaceId,
    channelId: ref.id,
    threadId: null,
    messageId,
  };
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
  if (n.kind === 'mention_self') {
    const conversationTitle = n.payload?.['conversation_title'] as string | undefined;
    return conversationTitle
      ? `你在 #${conversationTitle} 被提及`
      : '你被提及了';
  }
  return '新通知';
}

function payloadString(n: NotificationDto, key: string): string | null {
  const value = n.payload?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function buildSystemNotificationBody(n: NotificationDto): string {
  if (n.kind === 'mention_self') {
    const triggerName = payloadString(n, 'trigger_name') ?? '有人';
    const conversationTitle = payloadString(n, 'conversation_title');
    return conversationTitle
      ? `${triggerName} 在 # ${conversationTitle} 中 @ 了你。`
      : `${triggerName} @ 了你。`;
  }
  return buildToastLabel(n);
}
