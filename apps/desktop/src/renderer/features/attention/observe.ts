// The single eliminate primitive (#task:1231, docs/observe-collapse-v1.md).
// Every read-state clearing path in the renderer reduces to one `observe()`
// call — the backend routes the write back to the source aggregate (stream
// cursor for `stream`, `notifications.read_at` for `notification`), so the
// renderer never owns any read/eliminate state of its own (answerability,
// §5.3). Lives in the Attention bounded context because eliminate is an
// Attention concern; messaging hooks (channel/thread mark-read) delegate here.
import type { ObserveSource, ObserveDto } from '@silverhand/shared';
import { apiPaths } from '@silverhand/shared';
import { api } from '@/lib/api';

/** POST the eliminate primitive. One source = a single clear; many = a Mark-all
 *  batch (one transaction server-side — any illegal source fails the WHOLE
 *  request, so callers build sources only from server-validated DTO fields). */
export function postObserve(sources: ObserveSource[]): Promise<ObserveDto> {
  return api<ObserveDto>(apiPaths.attentionObserve, {
    method: 'POST',
    body: JSON.stringify({ sources }),
  });
}

// ── Pure source_ref builders ────────────────────────────────────────────────
// The §9.10 position rule is enforced STRUCTURALLY at construction, not by
// convention: a thread (root != null) can only ever be built `at_seq`, and the
// only builder that emits `stream_head` hardcodes `thread_root_id: null`. So a
// thread auto path can NOT accidentally emit `stream_head` from the renderer —
// the type system + these constructors make the regression unrepresentable.

/** A client-supplied resolved position (thread open-time snapshot head /
 *  visible-live seq; or a channel with a held snapshot). REQUIRED for a thread
 *  auto path — `threadRootId` non-null + `at_seq` is the only legal thread shape
 *  (the backend 400s `thread_position_required` on a thread + `stream_head`). */
export function streamSourceAtSeq(
  conversationId: string,
  threadRootId: string | null,
  seq: number,
): ObserveSource {
  return {
    kind: 'stream',
    conversation_id: conversationId,
    thread_root_id: threadRootId,
    position: { kind: 'at_seq', seq },
  };
}

/** A server-resolved mainline (channel) stream clear to current head. Allowed
 *  ONLY for an explicit/non-auto path (channel open / jump / ambient hover-✓ /
 *  Mark all) which knowingly accepts concurrent tail-swallow (§2). Hardcodes
 *  `thread_root_id: null` — a thread can never reach this builder. */
export function mainlineStreamSourceHead(conversationId: string): ObserveSource {
  return {
    kind: 'stream',
    conversation_id: conversationId,
    thread_root_id: null,
    position: { kind: 'stream_head' },
  };
}

/** A directed dismiss by explicit `notification_id` (§5.3 source_ref-out) —
 *  NEVER reverse-advances a cursor, NEVER parses an item's render `id`. */
export function notificationSource(notificationId: string): ObserveSource {
  return { kind: 'notification', notification_id: notificationId };
}
