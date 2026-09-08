// Message/notification unread read-model (#task:1292), extracted verbatim from
// hooks.ts: the debounced badge invalidate, the S1 viewer-unread in-place
// patches (#task:1284), and the badge-count hooks. Self-contained leaf — owns
// its own query keys and the viewer-scope WS interest for the fallback refetch.
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type {
  ConversationStreamUnreadDto,
  MessageUnreadByConversationDto,
  MessageUnreadPointerDto,
  MessageUnreadSummaryDto,
  UnreadUpdatedMessagePayload,
} from "@silverhand/shared";
import { apiPaths } from "@silverhand/shared";
import { api } from "@/lib/api";
import { onWsFrame, subscribeViewerScope, isCurrentViewerScope } from "@/lib/ws-client";
// #task:1773: the filtered `followed ∩ unread` threads dataset is a child key of
// the All threads list. A viewer `unread_updated` (or a viewer-scope
// `snapshot_required`) is the only remote signal for its membership changing, so
// this module invalidates it alongside the unread badge caches.
import { channelThreadsUnreadKey } from "@/features/channels/useChannelThreads";
import { workspaceScopedQueryEnabled } from "@/features/workspaces/workspace-scoped-query";

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
      predicate: (query) => {
        const key = query.queryKey;
        return (
          Array.isArray(key) && key[0] === "workspaces" && key[key.length - 1] === "message-unread"
        );
      },
    });
    void qc.invalidateQueries({ queryKey: ["message-unread", "summary"] });
  }, 100);
  messageUnreadInvalidationTimers.set(qc, timer);
}

const messageUnreadInvalidationTimers = new WeakMap<QueryClient, ReturnType<typeof setTimeout>>();

function isMessageUnreadUpdatedPayload(payload: unknown): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    typeof (payload as { conversation_id?: unknown }).conversation_id === "string"
  );
}

/** Query key for the per-workspace message-unread `by_conversation` read-model
 *  (`useMessageUnreadCounts`). Keyed by workspace id ALONE: a workspace id is
 *  only ever one container kind, so a kind cell would carry zero bits for a
 *  given id — it only ever existed because the S1 `unread_updated` payload
 *  (#task:1284) names the workspace without its kind, forcing the ingestor to
 *  probe both partitions. MUST keep the `['workspaces', wsId, …]` prefix: the
 *  viewer-removal contract classifies this key as `exempt` precisely because its
 *  layer-1 predicate sweep matches that prefix (#task:2078). MUST stay identical
 *  to the `useMessageUnreadCounts` queryKey — both build it here so they cannot
 *  drift. */
export const messageUnreadByConversationKey = (workspaceId: string) =>
  ["workspaces", workspaceId, "message-unread"] as const;

/** Query key for the global cross-workspace message-unread summary
 *  (`by_workspace`, `useMessageUnreadSummary`). */
export const messageUnreadSummaryKey = ["message-unread", "summary"] as const;

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
): "patched" | "cleared" | "unchanged" | "cold" {
  const cid = payload.conversation_id;
  const key = messageUnreadByConversationKey(payload.workspace_id);
  const prev = qc.getQueryData<MessageUnreadByConversationDto>(key);
  if (!prev) return "cold"; // whole-query not loaded → no-op
  const countUnchanged = (prev.by_conversation[cid] ?? 0) === payload.conversation_unread_count;
  const totalUnchanged = prev.total === payload.workspace_unread_count;
  const pointerUnchanged = unreadPointerEqual(
    prev.latest_by_conversation[cid],
    payload.latest_unread,
  );
  if (countUnchanged && totalUnchanged && pointerUnchanged) return "unchanged";
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
  return payload.conversation_unread_count > 0 ? "patched" : "cleared";
}

/** S1 viewer-unread ingestor patch (#task:1284, doc §6) — authoritative UPSERT of
 *  one workspace's absolute unread into the global `by_workspace` summary. Same
 *  sparse-map discipline as {@link patchMessageUnreadByConversation}: `> 0` set /
 *  `== 0` delete key; whole-query not loaded → no-op; idempotent. */
export function patchMessageUnreadSummary(
  qc: QueryClient,
  payload: UnreadUpdatedMessagePayload,
): "patched" | "cleared" | "unchanged" | "cold" {
  const prev = qc.getQueryData<MessageUnreadSummaryDto>(messageUnreadSummaryKey);
  if (!prev) return "cold";
  const wsId = payload.workspace_id;
  const count = payload.workspace_unread_count;
  if ((prev.by_workspace[wsId] ?? 0) === count) return "unchanged";
  const by_workspace = { ...prev.by_workspace };
  if (count > 0) by_workspace[wsId] = count;
  else delete by_workspace[wsId];
  qc.setQueryData<MessageUnreadSummaryDto>(messageUnreadSummaryKey, {
    by_workspace,
  });
  return count > 0 ? "patched" : "cleared";
}

/** Drop a whole workspace's message-unread contribution when the viewer loses
 *  access to it — removed from it, or the workspace is deleted (#task:1404). The
 *  viewer-scoped `viewer_workspaces_changed` `removed` event carries only the
 *  workspace_id; we consume THAT (no local recount, no refetch of a now-gone
 *  workspace — a REST refetch of its `by_conversation` would 404):
 *    - delete its slice from the global `by_workspace` summary, so the rail badge
 *      and the global unread total drop in place (the workspace-list refetch does
 *      NOT touch this separate query — that gap is the ghost unread #task:1404);
 *    - drop its per-workspace `by_conversation` query entirely — the workspace is
 *      gone, so there is no authoritative snapshot to refetch; removing the
 *      cached query is cleaner than patching it to an empty map.
 *  Mirrors the #task:1284 in-place-patch discipline (targeted slice, never a
 *  whole-list invalidate). Idempotent: an absent summary key is left untouched
 *  and removing an unloaded by_conversation query is a no-op. */
export function removeWorkspaceFromMessageUnread(qc: QueryClient, workspaceId: string): void {
  const prev = qc.getQueryData<MessageUnreadSummaryDto>(messageUnreadSummaryKey);
  if (prev && workspaceId in prev.by_workspace) {
    const by_workspace = { ...prev.by_workspace };
    delete by_workspace[workspaceId];
    qc.setQueryData<MessageUnreadSummaryDto>(messageUnreadSummaryKey, { by_workspace });
  }
  qc.removeQueries({ queryKey: messageUnreadByConversationKey(workspaceId) });
}

/**
 * The CONVERSATION-scoped sibling of {@link removeWorkspaceFromMessageUnread}
 * (#task:1689): settle the unread read-models when the viewer loses ONE channel
 * inside a workspace they still belong to.
 *
 * The workspace arm can drop whole queries; this one must PATCH, because the
 * surrounding workspace map stays authoritative and live. Three writes, in the
 * shape a refetch would produce (the #task:1284 rule: a patched map must be
 * structurally identical to a refetched one, or the two silently diverge):
 *   - delete the conversation's `by_conversation` key (absent == 0 unread — never
 *     a phantom `0`, which a refetch would omit);
 *   - delete its `latest_by_conversation` pointer;
 *   - RECOMPUTE `total` as the sum of the patched `by_conversation`, and set the
 *     global summary's `by_workspace[workspaceId]` to it, so the rail badge and
 *     the global total fall by what the viewer stopped being able to see.
 *
 * `total` is recomputed rather than decremented because the invariant a refetch
 * satisfies is `total === sum(by_conversation)`, and a STALE `total` breaks that
 * (#task:1689 blocker 4): with `{lost: 4, kept: 5}` under a stale `total: 1`,
 * `total - dropped` clamps to 0 and zeroes a surviving channel's badge, while the
 * sum yields 5. The summary is a rollup of THIS workspace's total, and the map is
 * a single query keyed by workspace id (#task:2078), so once it is loaded the
 * entry is fully determined — no delta arithmetic and hence no way for it to go
 * negative. PRESENT-ONLY / idempotent: an unloaded query or an absent
 * conversation key writes nothing.
 */
export function removeConversationFromMessageUnread(
  qc: QueryClient,
  workspaceId: string,
  conversationId: string,
): void {
  const key = messageUnreadByConversationKey(workspaceId);
  const prev = qc.getQueryData<MessageUnreadByConversationDto>(key);
  if (!prev) return; // not loaded → present-only no-op
  const hasCount = conversationId in prev.by_conversation;
  const hasPointer = conversationId in prev.latest_by_conversation;
  if (!hasCount && !hasPointer) return; // nothing to settle → no write
  const by_conversation = { ...prev.by_conversation };
  const latest_by_conversation = { ...prev.latest_by_conversation };
  delete by_conversation[conversationId];
  delete latest_by_conversation[conversationId];
  // `total = sum(by_conversation)`, the invariant a refetch satisfies — NOT
  // `prev.total - dropped`, which propagates a stale total onto survivors.
  const total = Object.values(by_conversation).reduce((sum, n) => sum + n, 0);
  qc.setQueryData<MessageUnreadByConversationDto>(key, {
    by_conversation,
    latest_by_conversation,
    total,
  });
  const summary = qc.getQueryData<MessageUnreadSummaryDto>(messageUnreadSummaryKey);
  if (!summary || !(workspaceId in summary.by_workspace)) return;
  if (total === summary.by_workspace[workspaceId]) return; // idempotent
  qc.setQueryData<MessageUnreadSummaryDto>(messageUnreadSummaryKey, {
    by_workspace: { ...summary.by_workspace, [workspaceId]: total },
  });
}

/** Which channels of ONE workspace the unread read-model still holds a count or
 *  pointer for (#task:1689). The map is keyed BY the workspace, so this
 *  attribution comes from the key — no payload scan and no ambiguity. Feeds the
 *  foreign-workspace convergence path (a workspace the viewer is not currently
 *  looking at still owns badge state that must settle). */
export function messageUnreadHeldChannelIds(qc: QueryClient, workspaceId: string): string[] {
  const data = qc.getQueryData<MessageUnreadByConversationDto>(
    messageUnreadByConversationKey(workspaceId),
  );
  if (!data) return [];
  const ids = new Set<string>([
    ...Object.keys(data.by_conversation),
    ...Object.keys(data.latest_by_conversation),
  ]);
  return [...ids];
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
  const queryKey = ["workspaces", workspaceId, "unread-by-channel"] as const;

  useEffect(() => {
    if (!workspaceId) return;
    const sub = subscribeViewerScope();
    const unsub = onWsFrame((frame) => {
      if (frame.type !== "event") return;
      if (!isCurrentViewerScope(frame.scope)) return;
      if (frame.kind === "unread_updated" && isMessageUnreadUpdatedPayload(frame.payload)) {
        return;
      }
      if (frame.kind !== "notification" && frame.kind !== "unread_updated") return;
      qc.invalidateQueries({ queryKey });
    });
    return () => {
      sub.unsubscribe();
      unsub();
    };
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
 *
 * `workspaceResolved` is the same no-default gate the channel-list hooks take —
 * see `useChannelsForWorkspace` for why absence must not be defaultable
 * (#task:2078).
 */
export function useMessageUnreadCounts(workspaceId: string | null, workspaceResolved: boolean) {
  const qc = useQueryClient();
  const queryKey = messageUnreadByConversationKey(workspaceId ?? "none");

  useEffect(() => {
    if (!workspaceId) return;
    // Interest only (#task:1260) + `snapshot_required` fallback. Message-variant
    // `unread_updated` is now patched IN PLACE by the central viewer-unread
    // ingestor (#task:1284), so this hook no longer invalidates on it — that
    // would defeat the patch's zero-refetch. Only a resume/epoch
    // `snapshot_required` still needs the authoritative refetch.
    const sub = subscribeViewerScope();
    const unsub = onWsFrame((frame) => {
      if (frame.type !== "snapshot_required") return;
      if (!isCurrentViewerScope(frame.scope)) return;
      invalidateMessageUnreadQueries(qc);
    });
    return () => {
      sub.unsubscribe();
      unsub();
    };
  }, [qc, workspaceId]);

  return useQuery({
    queryKey,
    enabled: workspaceScopedQueryEnabled(workspaceId, workspaceResolved),
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
    const unsub = onWsFrame((frame) => {
      if (frame.type !== "snapshot_required") return;
      if (!isCurrentViewerScope(frame.scope)) return;
      invalidateMessageUnreadQueries(qc);
    });
    return () => {
      sub.unsubscribe();
      unsub();
    };
  }, [qc]);

  return useQuery({
    queryKey,
    queryFn: () => api<{ by_workspace: Record<string, number> }>(apiPaths.messageUnreadSummary),
  });
}

export const conversationUnreadKey = (conversationId: string) =>
  ["conversation", conversationId, "unread"] as const;

/**
 * Per-conversation per-viewer stream-unread read-model (#task:1226) — the
 * SINGLE client source of truth for thread / mainline "N new" + first-unread.
 * The reply chip (`MessageItem`) and the Threads list (`ChannelThreadsPanel`)
 * both read this (keyed by root), so the same server-scored fact never lives in
 * two caches that drift. `threads` is sparse: only roots with unread > 0 appear
 * (absent root ⇒ 0).
 *
 * Unread is server-scored — the client can't optimistically derive it — so this
 * is settled from REST: remotely by viewer-scoped `unread_updated` or DM
 * `direct_pairs_changed` signals, and locally by successful observe() calls.
 * It is NEVER inferred from message events. Scoped to THIS conversation so an
 * unrelated conversation's unread change doesn't refetch it. Human-attention
 * read path only; it never reads or writes `thread_followers` / delivery / wake.
 */
export function useConversationUnread(conversationId: string | null) {
  const qc = useQueryClient();
  const enabled = !!conversationId;
  const queryKey = conversationUnreadKey(conversationId ?? "none");

  useEffect(() => {
    if (!conversationId) return;
    const sub = subscribeViewerScope();
    const unsub = onWsFrame((frame) => {
      if (frame.type === "snapshot_required") {
        if (!isCurrentViewerScope(frame.scope)) return;
        void qc.invalidateQueries({ queryKey });
        // #task:1773: the `followed ∩ unread` threads dataset's membership is a
        // function of THIS viewer's unread + follow state, so a viewer-scope
        // reconcile must refetch it alongside the unread read-model. The header
        // dot boolean rides this same read-model; the filtered list is a separate
        // read over the same predicate → both settle from one signal (Cindy gate:
        // freshness signals refetch BOTH authorities, no boolean/rows cross-derive).
        void qc.invalidateQueries({ queryKey: channelThreadsUnreadKey(conversationId) });
        return;
      }
      if (frame.type !== "event") return;
      if (!isCurrentViewerScope(frame.scope)) return;
      if (frame.kind === "direct_pairs_changed") {
        if (!isMessageUnreadUpdatedPayload(frame.payload)) return;
        const payload = frame.payload as { conversation_id: string };
        if (payload.conversation_id === conversationId) {
          void qc.invalidateQueries({ queryKey, exact: true });
        }
        return;
      }
      if (frame.kind !== "unread_updated") return;
      if (!isMessageUnreadUpdatedPayload(frame.payload)) return;
      // Per-stream unread for a thread reply carries the parent CHANNEL's
      // conversation_id (threads share the channel conversation), so this match
      // covers both mainline and thread unread of this conversation.
      const payload = frame.payload as { conversation_id?: unknown };
      if (payload.conversation_id !== conversationId) return;
      void qc.invalidateQueries({ queryKey });
      // #task:1773: a viewer `unread_updated` for this conversation is the ONLY
      // remote signal for two membership-changing events of the filtered set —
      // another device clearing a followed thread's unread (observe), and this
      // viewer follow/unfollowing on another device (backend publishes
      // `unread_updated` on a real follow change, `conversation-message-service`).
      // Neither rides a conversation message frame, so refetch the filtered
      // sibling here. NOT the exact All key: All membership/order is unread- AND
      // follow-agnostic (`lr.created_at DESC, root.seq DESC`), so a viewer unread
      // signal must not refetch it.
      void qc.invalidateQueries({ queryKey: channelThreadsUnreadKey(conversationId) });
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
