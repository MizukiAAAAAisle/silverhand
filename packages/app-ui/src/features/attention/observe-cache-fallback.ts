import type { QueryClient } from "@tanstack/react-query";
import type { ObserveDto, ObserveSource } from "@silverhand/shared";
import {
  invalidateMessageUnreadQueries,
  conversationUnreadKey,
} from "@/features/channels/message-unread";
import { favoritesKey } from "@/features/workspaces/favorites";
import { eventWsClient, type WsClientStatus } from "@/lib/ws-client";

/**
 * `observe()` normally clears unread badges through the post-commit
 * `unread_updated` viewer-scope event. If the event websocket is currently not
 * connected, that patch cannot arrive, so reconcile the unread-bearing caches by
 * REST invalidation. The healthy websocket path remains the zero-refetch S1
 * projection.
 */
export function shouldRefetchUnreadAfterObserve(
  result: ObserveDto | undefined,
  status: WsClientStatus,
): boolean {
  return result?.changed === true && status !== "connected";
}

export function reconcileUnreadAfterObserveIfRealtimeUnavailable(
  qc: QueryClient,
  result: ObserveDto | undefined,
  status: WsClientStatus = eventWsClient.getStatus(),
): boolean {
  if (!shouldRefetchUnreadAfterObserve(result, status)) return false;
  invalidateMessageUnreadQueries(qc);
  void qc.invalidateQueries({ queryKey: favoritesKey });
  return true;
}

/**
 * Healthy-path per-stream settle after a LOCAL `observe(stream)` (#task:1402).
 *
 * The enriched `unread_updated` frame this client's observe triggers carries only
 * the sidebar/workspace ROLL-UP (patched in place by the #task:1284 ingestor); it
 * does NOT carry the per-stream `conversationUnread` read-model (mainline +
 * per-root chip / Threads-list "N new", `GET /api/conversations/:id/unread`). So
 * the acting client's own immediate / cross-pane chip would sit stale until that
 * async WS frame round-trips back and `useConversationUnread` self-invalidates —
 * the #task:1400 stale window. This settles that ONE read-model locally: for each
 * distinct conversation touched by a `stream` source in this observe, invalidate
 * `conversationUnreadKey` so the chip re-settles from REST at once.
 *
 * Deliberately narrow and #task:1284-safe: it NEVER touches the global
 * message-unread maps / sidebar roll-up (those ride the ingestor patch; a
 * whole-list invalidate here would defeat the zero-refetch projection). This is
 * the SINGLE seam EVERY local `observe(stream)` caller funnels through — thread
 * mark-read, mainline mark-read, Activity clear / mark-all-read — so a new observe
 * entry point is correct by construction and cannot reintroduce the per-caller gap
 * the #task:1402 audit found. Do not hand-write this invalidate at a caller.
 *
 * Gated on `result.changed === true`: an observe that moved no cursor changed no
 * unread, so there is nothing to settle (no empty-observe refetch).
 */
export function settleStreamUnreadAfterObserve(
  qc: QueryClient,
  sources: ObserveSource[],
  result: ObserveDto | undefined,
): void {
  if (result?.changed !== true) return;
  const seen = new Set<string>();
  for (const s of sources) {
    if (s.kind !== "stream") continue;
    if (seen.has(s.conversation_id)) continue;
    seen.add(s.conversation_id);
    void qc.invalidateQueries({ queryKey: conversationUnreadKey(s.conversation_id) });
  }
}
