import { useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { apiPaths } from "@silverhand/shared";
import type {
  ConversationActivityEvent,
  ConversationActivityListResponse,
} from "@silverhand/shared";
import { api } from "@/lib/api";
import { wsConversationSideScope } from "@/hooks/useConversationStream";
import { useInterest } from "@/features/realtime/interest-registry";

// #task:1255 Stage-2 P1c #2 — the agent activity feed (the `conversation_activity`
// projection) moves off `AgentActivityTimeline`'s local `useState` into a React
// Query cache so the central ingestor can write live rows and the view becomes a
// pure reader (gate-(b)). The feed is its own REST cold-start source (the
// backfill GET), which also gives the `conversation_activity` kind a per-scope
// snapshot for Stage-2 P2.
//
// SOURCE SCOPE IS AN INPUT-LAYER DETAIL. This module knows only (conversationId,
// agentId, row); it does NOT assume which transport scope carried the frame.
// As of #task:1255 P2 step-3 the `conversation_activity` kind rides the
// side-channel scope `conversation-side:<id>` (this hook subscribes it above,
// via `wsConversationSideScope`) — disjoint from the message stream. Either way
// the apply/merge logic here is unchanged — only the ingestor's routing /
// subscription layer differs (Alice/Cindy P2 lane).

const PAGE_SIZE = 100;

export interface AgentActivityFeed {
  events: ConversationActivityEvent[];
  /** Cursor for the next older page (`before_id`); null when fully backfilled. */
  nextBeforeId: number | null;
}

/**
 * Feed cache key. `agentId` is always a concrete agent here (the timeline is
 * per-agent). A future all/null variant MUST pass a stable sentinel string
 * rather than `undefined`, so distinct selections never collide on one key.
 */
export const agentActivityKey = (conversationId: string, agentId: string) =>
  ["conversations", conversationId, "agent-activity", agentId] as const;

/**
 * Merge two activity-event lists into one, sorted ascending by `id`,
 * de-duplicated on `id`. The single reconciliation path for BOTH backfill
 * (prepend older pages) and live frames (append newest):
 *
 *  - ordering key is `id` (monotonic; INSERT-then-publish guarantees the live
 *    frame carries the same row id the DB persisted), NOT `created_at` which
 *    can tie across rows;
 *  - a live frame whose `id` already arrived via backfill is dropped, so the
 *    backfill/live race can't double-render a row.
 *
 * Exported for the reconcile contract test (and re-exported from
 * AgentActivityTimeline for its existing test path).
 */
export function mergeActivityById(
  existing: ReadonlyArray<ConversationActivityEvent>,
  incoming: ReadonlyArray<ConversationActivityEvent>,
): ConversationActivityEvent[] {
  const byId = new Map<number, ConversationActivityEvent>();
  for (const e of existing) byId.set(e.id, e);
  for (const e of incoming) {
    const prev = byId.get(e.id);
    byId.set(e.id, prev ? pickRicher(prev, e) : e);
  }
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

/**
 * Resolve a same-`id` collision. A backend that grows a `thinking`/`text` block
 * IN PLACE re-publishes the same row id with a longer `payload.text` each delta;
 * if WS frames reorder, a late SHORTER frame must NOT clobber the already-longer
 * block (would flicker/regress). So when either side carries text, keep the
 * longer one (monotonic growth); otherwise the later (incoming) wins.
 */
function pickRicher(
  a: ConversationActivityEvent,
  b: ConversationActivityEvent,
): ConversationActivityEvent {
  const al = textLen(a);
  const bl = textLen(b);
  if (al !== null || bl !== null) return (bl ?? -1) >= (al ?? -1) ? b : a;
  return b;
}

function textLen(e: ConversationActivityEvent): number | null {
  const v = (e.payload as Record<string, unknown> | null)?.["text"];
  return typeof v === "string" ? v.length : null;
}

/** True when an `AgentActivityTimeline(conversationId, agentId)` reader is
 *  mounted — the exact feed key has an active observer. The ingestor appends a
 *  live row only while its reader is alive. */
export function hasActiveAgentActivityReader(
  qc: QueryClient,
  conversationId: string,
  agentId: string,
): boolean {
  const entry = qc
    .getQueryCache()
    .find({ queryKey: agentActivityKey(conversationId, agentId), exact: true });
  return (entry?.getObserversCount() ?? 0) > 0;
}

/** Append a live `conversation_activity` row to the feed cache (#task:1255 P1c
 *  #2). Read-inert: writes content only, never a read/transport cursor. No
 *  bootstrap — if the feed isn't loaded (no reader / pre-backfill) `prev` is
 *  undefined and we leave it, so a live row never stitches an incomplete feed
 *  with no REST snapshot behind it. The row is already routed to this agent's
 *  key by the ingestor (agentId filter), and `mergeActivityById` de-dupes
 *  against backfilled pages. */
export function appendAgentActivityToCache(
  qc: QueryClient,
  conversationId: string,
  agentId: string,
  row: ConversationActivityEvent,
): void {
  qc.setQueryData<AgentActivityFeed>(agentActivityKey(conversationId, agentId), (prev) =>
    prev ? { ...prev, events: mergeActivityById(prev.events, [row]) } : prev,
  );
}

/** Reconcile every agent-activity feed in a conversation on a side-scope
 *  `snapshot_required` (#task:1255 P2 step-4 — the item-2 gap). Invalidates the
 *  `['conversations', id, 'agent-activity']` prefix so each mounted feed refetches
 *  its authoritative page (`refetchOnMount:'always'` makes inactive ones refetch
 *  on next open). The feed is CONTENT, and the side scope has no content-apply
 *  seam, so this never touches a read/transport cursor (Alice P2 red line): the
 *  side floor auto-advances transport-side. Returns the invalidate Promise. */
export function reconcileAgentActivityOnSnapshotRequired(
  qc: QueryClient,
  conversationId: string,
): Promise<void> {
  return qc.invalidateQueries({
    queryKey: ["conversations", conversationId, "agent-activity"],
  });
}

export interface UseAgentActivityFeed {
  events: ConversationActivityEvent[];
  nextBeforeId: number | null;
  phase: "loading" | "ready" | "error";
  isLoadingMore: boolean;
  loadEarlier: () => Promise<void>;
}

/**
 * Reader for one `(conversation, agent)` activity feed. Pure reader of the RQ
 * cache (the ingestor writes live rows); the backfill GET is the cold-start
 * source. Pagination (`loadEarlier`) prepends older `before_id` pages into the
 * same merged list. The view keeps scroll/tail-follow; this owns the data.
 */
export function useAgentActivityFeed(
  conversationId: string,
  agentId: string,
): UseAgentActivityFeed {
  const qc = useQueryClient();
  const key = agentActivityKey(conversationId, agentId);
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  const query = useQuery<AgentActivityFeed>({
    queryKey: key,
    queryFn: async () => {
      const res = await api<ConversationActivityListResponse>(
        `${apiPaths.conversationAgentActivity(conversationId, agentId)}?limit=${PAGE_SIZE}`,
      );
      // Reconcile, don't overwrite: a live `conversation_activity` row can land
      // (ingestor → this key) between mount and this resolve. Merge keeps it
      // (id-dedupe drops any overlap) — with no polling a clobbered live row
      // would otherwise be lost until reload.
      const prev = qc.getQueryData<AgentActivityFeed>(key)?.events ?? [];
      return {
        events: mergeActivityById(prev, res.events),
        nextBeforeId: res.next_before_id,
      };
    },
    // Live frames keep this current; always re-backfill on (re)mount to
    // reconcile a window that may have missed frames while unmounted.
    staleTime: Infinity,
    refetchOnMount: "always",
  });

  // Keep the WS scope INTEREST alive while the timeline is open (source scope is
  // an input-layer detail — see module header). #task:1260 P2: interest routes
  // through the registry (`useInterest`) instead of a direct subscribeWsScope
  // useEffect — identical lifecycle, single authority. `conversationId` is always
  // concrete here (no enabled gate), so the scope is never null.
  useInterest(wsConversationSideScope(conversationId));

  const nextBeforeId = query.data?.nextBeforeId ?? null;

  const loadEarlier = useCallback(async () => {
    if (nextBeforeId === null || isLoadingMore) return;
    setIsLoadingMore(true);
    try {
      const res = await api<ConversationActivityListResponse>(
        `${apiPaths.conversationAgentActivity(conversationId, agentId)}?limit=${PAGE_SIZE}&before_id=${nextBeforeId}`,
      );
      qc.setQueryData<AgentActivityFeed>(key, (prev) => ({
        // Prepend older rows; merge preserves ordering + dedupes overlap so a
        // live append that raced this page can't be lost or reordered.
        events: mergeActivityById(res.events, prev?.events ?? []),
        nextBeforeId: res.next_before_id,
      }));
    } catch {
      /* transient — the button stays, user can retry */
    } finally {
      setIsLoadingMore(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, agentId, nextBeforeId, isLoadingMore]);

  const phase: "loading" | "ready" | "error" = query.isError
    ? "error"
    : query.data === undefined
      ? "loading"
      : "ready";

  return {
    events: query.data?.events ?? [],
    nextBeforeId,
    phase,
    isLoadingMore,
    loadEarlier,
  };
}
