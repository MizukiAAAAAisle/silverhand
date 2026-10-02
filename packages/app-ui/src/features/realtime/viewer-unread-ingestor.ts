import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { UnreadUpdatedMessagePayloadSchema } from "@silverhand/shared";
import type { ServerFrame } from "@silverhand/shared";
import { isCurrentViewerScope, onWsFrame } from "@/lib/ws-client";
import {
  invalidateMessageUnreadQueries,
  patchMessageUnreadByConversation,
  patchMessageUnreadSummary,
} from "@/features/channels/hooks";
import { favoritesKey, patchFavoritesUnread } from "@/features/workspaces/favorites";

/** Route one realtime frame into the viewer-unread badge caches. Pure (takes the
 *  `QueryClient` explicitly) so it is unit-testable without rendering. */
export function ingestViewerUnreadFrame(qc: QueryClient, frame: ServerFrame): void {
  if (frame.type !== "event") return;
  if (frame.kind !== "unread_updated") return;
  if (!isCurrentViewerScope(frame.scope)) return;

  // Discriminate the two `unread_updated` variants by `conversation_id` presence:
  //  - BADGE variant (`{}`, no conversation_id) → notification badge, NOT ours
  //    (its consumers keep their own handlers — future-convergence TODO).
  //  - MESSAGE variant → parse the enriched absolute payload.
  const payload = frame.payload as { conversation_id?: unknown } | undefined;
  if (typeof payload?.conversation_id !== "string") return;

  const parsed = UnreadUpdatedMessagePayloadSchema.safeParse(frame.payload);
  if (!parsed.success) {
    // Legacy / malformed message variant (a pre-S1 backend, or a field-shape
    // mismatch) is the ONLY absence/failure fallback (doc §0): invalidate→refetch
    // every badge consumer. Cache-absence itself is NEVER a fallback — the
    // patchers no-op on an unloaded query and the next mount fetches REST.
    invalidateMessageUnreadQueries(qc);
    void qc.invalidateQueries({ queryKey: favoritesKey });
    return;
  }

  // SINGLE-POINT validation → fan out to every present projection (doc §6). Each
  // patcher owns its cache-shape disposition: sparse maps upsert (>0 set / ==0
  // delete key / unloaded no-op); favorites is present-only (missing row / cold →
  // no-op, never insert/refetch).
  const data = parsed.data;
  patchMessageUnreadByConversation(qc, data);
  patchMessageUnreadSummary(qc, data);
  patchFavoritesUnread(qc, data);
}

/** App-level mount: the sole `onWsFrame` consumer for message-variant
 *  `unread_updated` badge patches. Mount once near `useConversationIngestor`. */
export function useViewerUnreadIngestor(): void {
  const qc = useQueryClient();
  useEffect(() => {
    return onWsFrame((frame: ServerFrame) => ingestViewerUnreadFrame(qc, frame));
  }, [qc]);
}
