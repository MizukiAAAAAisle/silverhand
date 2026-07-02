import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { UnreadUpdatedMessagePayloadSchema } from '@silverhand/shared';
import type { ServerFrame } from '@silverhand/shared';
import { isCurrentViewerScope, onWsFrame } from '@/lib/ws-client';
import {
  invalidateMessageUnreadQueries,
  patchMessageUnreadByConversation,
  patchMessageUnreadSummary,
} from '@/features/channels/hooks';
import { favoritesKey, patchFavoritesUnread } from '@/features/favorites/hooks';

/**
 * S1 viewer-unread badge projection patch — the viewer-scope patch dispatcher
 * (#task:1284, doc `projection-recovery-s1-unread-v1.md`).
 *
 * The enriched `unread_updated` MESSAGE variant now carries authoritative
 * ABSOLUTE unread counts per read-model boundary (conversation / workspace) plus
 * the latest-unread pointer. This single App-level `onWsFrame` consumer validates
 * that frame ONCE and fans the absolute values into the three displayed badge
 * caches — the per-workspace `by_conversation` map, the global `by_workspace`
 * summary, and the favorites list — so an unread change patches a badge in place
 * instead of invalidate→whole-list refetch. It holds ZERO subscriptions (the
 * badge hooks keep their viewer-scope interest); it is a pure frame CONSUMER,
 * exactly like the conversation-scope `useConversationIngestor`.
 *
 * WHY A SINGLE DISPATCH (my #1269 guardrail). All three consumers read the same
 * frame. Wiring three independent `onWsFrame` handlers is the #1269 trap — a new
 * consumer dimension gets forgotten and its live patch is silently dropped. One
 * validated frame → one fan-out makes that impossible by construction. This is
 * the SAME pattern as the #1270 message-row seam, but a NEW, small dispatcher on
 * a DIFFERENT scope (`viewer:<id>`, not `conversation:<id>`) and a DIFFERENT
 * projection family (badge/list caches keyed by conversation/workspace, not
 * message rows) — today the viewer scope has no central ingestor at all.
 *
 * SEED, NOT MIGRATION (guardrail). This is the seed of a future viewer-scope
 * ingestor, but this cut wires ONLY `unread_updated` and solves ONLY the two
 * badge surfaces (message-unread summary + favorites). The other scattered
 * viewer-scope `onWsFrame` consumers (`notification`, `saved_changed`,
 * `viewer_workspaces_changed`) stay where they are — folding them in is an
 * explicit FUTURE-CONVERGENCE step, deliberately out of this cut so the seed
 * doesn't balloon into a viewer-scope refactor.
 *
 * Not on the resume floor: `unread_updated` is a viewer-scope frame and carries
 * no cursor/floor semantics (the resume floor is the conversation-scope content
 * seam), so — unlike `useConversationIngestor` — this dispatcher never calls
 * `markSatisfied` / `commitSnapshotBaseline`. It only writes caches.
 */

/** Route one realtime frame into the viewer-unread badge caches. Pure (takes the
 *  `QueryClient` explicitly) so it is unit-testable without rendering. */
export function ingestViewerUnreadFrame(qc: QueryClient, frame: ServerFrame): void {
  if (frame.type !== 'event') return;
  if (frame.kind !== 'unread_updated') return;
  if (!isCurrentViewerScope(frame.scope)) return;

  // Discriminate the two `unread_updated` variants by `conversation_id` presence:
  //  - BADGE variant (`{}`, no conversation_id) → notification badge, NOT ours
  //    (its consumers keep their own handlers — future-convergence TODO).
  //  - MESSAGE variant → parse the enriched absolute payload.
  const payload = frame.payload as { conversation_id?: unknown } | undefined;
  if (typeof payload?.conversation_id !== 'string') return;

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
