// Message/notification unread read-model (#task:1292), extracted verbatim from
// hooks.ts: the debounced badge invalidate, the S1 viewer-unread in-place
// patches (#task:1284), and the badge-count hooks. Self-contained leaf — owns
// its own query keys and the viewer-scope WS interest for the fallback refetch.
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import type {
  ConversationStreamUnreadDto,
  MessageUnreadByConversationDto,
  MessageUnreadPointerDto,
  MessageUnreadSummaryDto,
  UnreadUpdatedMessagePayload,
} from '@silverhand/shared';
import { apiPaths } from '@silverhand/shared';
import { api } from '@/lib/api';
import {
  onWsFrame,
  subscribeViewerScope,
  isCurrentViewerScope,
} from '@/lib/ws-client';

/** Debounced invalidate of every message-unread badge query (per-workspace
 *  `by_conversation` maps + the global `by_workspace` summary). The legacy
 *  fallback path: the S1 viewer-unread ingestor (#task:1284) patches these caches
 *  in place from an enriched `unread_updated` frame, and this invalidate remains
 *  for cases the live patch cannot cover — a `snapshot_required` reconcile, a
 *  legacy/malformed message-variant payload missing the enriched absolute fields,
 *  or a post-observe fallback while the event websocket is offline.
 *  Never called on a well-formed enriched frame (that would defeat the patch's
 *  zero-refetch). */
export function invalidateMessageUnreadQueries(qc: QueryClient): void {
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

/** Query key for the per-workspace message-unread `by_conversation` read-model
 *  (`useMessageUnreadCounts`). `kind` partitions regular vs dm workspaces; a
 *  workspace id is only ever one kind, so the S1 viewer-unread ingestor
 *  (#task:1284) patches whichever partition is loaded. MUST stay identical to the
 *  `useMessageUnreadCounts` queryKey — both build it here so they cannot drift. */
export const messageUnreadByConversationKey = (
  workspaceId: string,
  kind: 'regular' | 'dm',
) => ['workspaces', workspaceId, kind, 'message-unread'] as const;

/** Query key for the global cross-workspace message-unread summary
 *  (`by_workspace`, `useMessageUnreadSummary`). */
export const messageUnreadSummaryKey = ['message-unread', 'summary'] as const;

/** Two unread pointers are equal iff they point at the same message (or both
 *  null). `message_id` is unique, so it alone decides — no need to compare seq /
 *  thread_root_id. Powers the idempotency short-circuit below. */
function unreadPointerEqual(
  a: MessageUnreadPointerDto | undefined,
  b: MessageUnreadPointerDto | null,
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.message_id === b.message_id;
}

/** S1 viewer-unread ingestor patch (#task:1284, doc §6) — authoritative UPSERT of
 *  ONE conversation's absolute unread into the per-workspace `by_conversation`
 *  read-model. The map is a COMPLETE sparse model keyed by conversation id
 *  (absent key == 0 unread), so — unlike a paginated list — key membership is
 *  authoritative from the payload: `count > 0` sets the key, `count == 0` DELETES
 *  it (never a phantom `0` that a refetch would omit — the patched map must be
 *  structurally identical to a refetched one, else the two silently diverge).
 *  `latest_by_conversation` mirrors the pointer (non-null set / null delete);
 *  `total` is the absolute workspace rollup. A whole-query that is not loaded is a
 *  no-op — absence is NOT a refetch trigger; the next mount fetches the
 *  authoritative REST snapshot. Idempotent: an unchanged patch writes nothing. */
export function patchMessageUnreadByConversation(
  qc: QueryClient,
  payload: UnreadUpdatedMessagePayload,
): 'patched' | 'cleared' | 'unchanged' | 'cold' {
  let outcome: 'patched' | 'cleared' | 'unchanged' | 'cold' = 'cold';
  const cid = payload.conversation_id;
  // A workspace id is only ever one kind; patch whichever partition is loaded.
  for (const kind of ['regular', 'dm'] as const) {
    const key = messageUnreadByConversationKey(payload.workspace_id, kind);
    const prev = qc.getQueryData<MessageUnreadByConversationDto>(key);
    if (!prev) continue; // whole-query not loaded → no-op for this partition
    const countUnchanged =
      (prev.by_conversation[cid] ?? 0) === payload.conversation_unread_count;
    const totalUnchanged = prev.total === payload.workspace_unread_count;
    const pointerUnchanged = unreadPointerEqual(
      prev.latest_by_conversation[cid],
      payload.latest_unread,
    );
    if (countUnchanged && totalUnchanged && pointerUnchanged) {
      if (outcome === 'cold') outcome = 'unchanged';
      continue;
    }
    const by_conversation = { ...prev.by_conversation };
    if (payload.conversation_unread_count > 0) {
      by_conversation[cid] = payload.conversation_unread_count;
    } else {
      delete by_conversation[cid];
    }
    const latest_by_conversation = { ...prev.latest_by_conversation };
    if (payload.latest_unread) {
      latest_by_conversation[cid] = payload.latest_unread;
    } else {
      delete latest_by_conversation[cid];
    }
    qc.setQueryData<MessageUnreadByConversationDto>(key, {
      by_conversation,
      latest_by_conversation,
      total: payload.workspace_unread_count,
    });
    outcome = payload.conversation_unread_count > 0 ? 'patched' : 'cleared';
  }
  return outcome;
}

/** S1 viewer-unread ingestor patch (#task:1284, doc §6) — authoritative UPSERT of
 *  one workspace's absolute unread into the global `by_workspace` summary. Same
 *  sparse-map discipline as {@link patchMessageUnreadByConversation}: `> 0` set /
 *  `== 0` delete key; whole-query not loaded → no-op; idempotent. */
export function patchMessageUnreadSummary(
  qc: QueryClient,
  payload: UnreadUpdatedMessagePayload,
): 'patched' | 'cleared' | 'unchanged' | 'cold' {
  const prev = qc.getQueryData<MessageUnreadSummaryDto>(messageUnreadSummaryKey);
  if (!prev) return 'cold';
  const wsId = payload.workspace_id;
  const count = payload.workspace_unread_count;
  if ((prev.by_workspace[wsId] ?? 0) === count) return 'unchanged';
  const by_workspace = { ...prev.by_workspace };
  if (count > 0) by_workspace[wsId] = count;
  else delete by_workspace[wsId];
  qc.setQueryData<MessageUnreadSummaryDto>(messageUnreadSummaryKey, {
    by_workspace,
  });
  return count > 0 ? 'patched' : 'cleared';
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
 * Backed by the conversation_reads cursor system. Message-variant
 * `unread_updated` is patched in place by the viewer-unread ingestor
 * (#task:1284); only a `snapshot_required` (resume/epoch) refetches — no polling.
 */
export function useMessageUnreadCounts(
  workspaceId: string | null,
  workspaceKind: 'regular' | 'dm' | null = 'regular',
) {
  const qc = useQueryClient();
  const queryKey = messageUnreadByConversationKey(
    workspaceId ?? 'none',
    workspaceKind ?? 'regular',
  );

  useEffect(() => {
    if (!workspaceId) return;
    // Interest only (#task:1260) + `snapshot_required` fallback. Message-variant
    // `unread_updated` is now patched IN PLACE by the central viewer-unread
    // ingestor (#task:1284), so this hook no longer invalidates on it — that
    // would defeat the patch's zero-refetch. Only a resume/epoch
    // `snapshot_required` still needs the authoritative refetch.
    const sub = subscribeViewerScope();
    const unsub = onWsFrame(frame => {
      if (frame.type !== 'snapshot_required') return;
      if (!isCurrentViewerScope(frame.scope)) return;
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
 * Global message unread summary across ALL workspaces.
 * Backed by conversation_reads — returns total unread message count per workspace.
 * Used by the workspace sidebar to show per-workspace unread badges.
 * Message-variant `unread_updated` is patched in place by the viewer-unread
 * ingestor (#task:1284); only a `snapshot_required` refetches — no polling.
 */
export function useMessageUnreadSummary() {
  const qc = useQueryClient();
  const queryKey = messageUnreadSummaryKey;

  useEffect(() => {
    // Interest only + `snapshot_required` fallback — message-variant
    // `unread_updated` is patched in place by the viewer-unread ingestor
    // (#task:1284), no invalidate here (see useMessageUnreadCounts).
    const sub = subscribeViewerScope();
    const unsub = onWsFrame(frame => {
      if (frame.type !== 'snapshot_required') return;
      if (!isCurrentViewerScope(frame.scope)) return;
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
