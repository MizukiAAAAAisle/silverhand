/**
 * What the bare `/chat` route should open.
 *
 * Clicking the Chat rail drops every coordinate (`nav.toChat()` → `/chat`), so
 * something has to decide where the viewer lands. Before this, that decision had
 * exactly one arm — restore the last workspace, then its last channel — and a
 * viewer who had been reading a DIRECT line got a workspace channel instead:
 * their selection was not "lost" in storage, it had no arm to be restored INTO.
 *
 * The rule this resolver owns is the ORDER of two authorities, and both halves
 * are load-bearing:
 *
 *  - the recorded arm ({@link ChatPlace}) says what the viewer was last on. It is
 *    memory, so it is never trusted as reachability;
 *  - the viewer's own direct-pair list says whether that line is still theirs.
 *    A pair id that is not in it does not become a route, no matter what memory
 *    says — deleted lines, and lines the viewer is no longer an endpoint of, are
 *    the same case here.
 *
 * Hence the third action. While the list has not answered we `wait` rather than
 * fall through to the workspace arm: falling through would navigate, and a
 * navigation cannot be taken back once the answer arrives — the viewer would see
 * a channel open and then be yanked into the DM (or, worse, keep the channel
 * because the URL had already changed). Waiting costs one render of the bare
 * route; guessing costs a wrong place.
 *
 * A failed list is NOT a wait: nothing more is coming, and the honest answer to
 * "is this line still yours" is unknown, so the rail falls back to the workspace
 * arm — the place that needs no per-viewer verification. Fail closed, in the
 * direction that always has somewhere to be.
 *
 * PURE: no refs, no module singletons, no navigation. The caller reads
 * place-memory and the query state, calls this, and executes the action.
 */

import type { ChatPlace } from "@/lib/place-memory";

/** The viewer's direct-pair list, as the restore decision needs it: an answer,
 *  or the absence of one. `ready` carries the conversation ids the viewer is an
 *  endpoint of — the whole authority, not a lookup of one row, so a caller cannot
 *  accidentally ask about a pair that is not in the list. */
export type DirectPairAuthority =
  /** Not answered yet (cold query, or refetching with nothing cached). */
  | { status: "pending" }
  /** Answered and settled: these are the viewer's lines. */
  | { status: "ready"; conversationIds: ReadonlySet<string> }
  /** Answered before, and a fresher read is in flight now — carries the last
   *  answer. The two consumers read it differently ON PURPOSE (#task:2052): a
   *  one-shot gesture (`resolveJumpNav`) may act on a HIT, because the viewer's
   *  pair list only ever grows (no pagination, a removed counterpart still
   *  returns as a `read_only` row), so a cached membership cannot be revoked by
   *  the read in flight; a MISS still fails closed, since it may be exactly the
   *  freshly minted pair this refetch will bring back. A render-driven restore
   *  (`resolveChatPlaceRestore`) instead keeps WAITING — it can afford a frame,
   *  and the fresher read may change reachability. */
  | { status: "refetching"; conversationIds: ReadonlySet<string> }
  /** The read failed. Reachability is unknown and no answer is coming. */
  | { status: "failed" };

/**
 * Project a React Query read of the direct-pair list onto {@link DirectPairAuthority}.
 *
 * This mapping is here, pure, because it is where the ticket's contract is
 * actually decided and the earlier inline version got it wrong: keying on "is there `data`" reads CACHED ROWS as the current
 * answer, and React Query keeps the previous `data` through an invalidation — so
 * both "a refetch is in flight" and "the refetch failed" silently became `ready`
 * and re-opened a line whose reachability had not been re-answered.
 *
 * The rule is about the CURRENT read, not about the presence of rows:
 *
 *  - a fetch in flight ⇒ it depends on whether a read has ever answered: with a
 *    cached answer it is `refetching` (the last answer is in hand, a fresher one
 *    on the way) so a one-shot caller can still act on a HIT; with nothing
 *    cached it is `pending`. Either way the held rows are NOT promoted to the
 *    settled `ready` answer — `failed` still means precisely "nothing more is
 *    coming" (that is what licenses it to route instead of wait);
 *  - otherwise a failed read ⇒ `failed`, cached rows or not;
 *  - otherwise an answered list ⇒ `ready`, including the empty list — "you have
 *    no pairs" is an answer;
 *  - no read in flight, no failure, no answer (cold, or a disabled query) ⇒
 *    `pending`. Absence of an answer is never "no pairs".
 *
 * Deliberately NOT keyed on staleness: with the default `staleTime` a settled
 * success is stale almost immediately, which would make the common case wait
 * forever.
 */
export function directPairAuthorityFromQuery(query: {
  /** The answered list as an id set, or `undefined` when no read has ever
   *  answered. Callers must pass `undefined` rather than an empty set for a cold
   *  query — the two mean opposite things here. */
  answered: ReadonlySet<string> | undefined;
  /** A read is in flight right now, including a background refetch that is
   *  holding previous rows (`isFetching`, not `isPending`). */
  isFetching: boolean;
  /** The most recent read settled in failure — initial load or refetch. */
  isError: boolean;
}): DirectPairAuthority {
  if (query.isFetching) {
    // A read in flight qualifies the pending decision but never fabricates an
    // answer. With a cached answer this is `refetching`: the last answer is in
    // hand, so a one-shot caller (the jump seam) may act on a HIT, while restore
    // keeps waiting. With nothing cached it is plain `pending`. Splitting here —
    // rather than collapsing both to `pending` — is what keeps the jump seam
    // alive through the refetch storm every incoming DM opens (#task:2052),
    // and it changes nothing for restore (both map to `wait` there).
    return query.answered !== undefined
      ? { status: "refetching", conversationIds: query.answered }
      : { status: "pending" };
  }
  if (query.isError) return { status: "failed" };
  if (query.answered !== undefined) {
    return { status: "ready", conversationIds: query.answered };
  }
  return { status: "pending" };
}

export type ChatPlaceRestore =
  /** Hold the bare route for one more render — the authority is still answering. */
  | { kind: "wait" }
  /** Open this direct line. */
  | { kind: "open-direct"; conversationId: string }
  /** Use the workspace arm (last workspace → its last channel), unchanged. */
  | { kind: "workspace" };

/**
 * WHICH ARM the current chat route is on, for the recorder — or `null` when the
 * route says nothing worth remembering.
 *
 * Three of the four cells are the interesting ones:
 *
 *  - the pre-mint DRAFT route (`/chat/d/new/:agentId`) records NOTHING. It is not
 *    a place: there is no conversation to come back to, and its unsent text lives
 *    in the pane, not here. Recording it would make the rail restore an empty
 *    composer and, worse, imply the text came back with it;
 *  - a DIRECT line records its conversation id — the only coordinate this memory
 *    owns (see {@link ChatPlace});
 *  - a WORKSPACE route records the arm alone, with no coordinate, and does so as
 *    soon as a workspace is selected — a workspace with no channel yet is still
 *    honestly the workspace arm, and its own memory already knows which one;
 *  - bare `/chat` (and any non-chat rail) records nothing, so passing THROUGH the
 *    rail's own restore does not overwrite what is being restored.
 */
export function chatPlaceForRoute(route: {
  /** False on every non-chat rail, whose route state carries no chat place. */
  chatSectionActive: boolean;
  /** `/chat/d/new/:agentId` — pre-mint draft. */
  directDraftAgentId: string | null;
  /** `/chat/d/:conversationId` — an existing direct line. */
  directConversationId: string | null;
  selectedWorkspaceId: string | null;
}): ChatPlace | null {
  if (!route.chatSectionActive) return null;
  if (route.directDraftAgentId !== null) return null;
  if (route.directConversationId !== null) {
    return { kind: "direct_pair", conversationId: route.directConversationId };
  }
  if (route.selectedWorkspaceId !== null) return { kind: "workspace_channel" };
  return null;
}

export function resolveChatPlaceRestore(inputs: {
  /** The recorded arm, or null when nothing was recorded (cold start / logout). */
  place: ChatPlace | null;
  pairs: DirectPairAuthority;
}): ChatPlaceRestore {
  const { place, pairs } = inputs;
  // No memory, or memory that names the workspace arm: the existing path decides,
  // and it does so without consulting the pair list at all.
  if (place === null || place.kind === "workspace_channel") {
    return { kind: "workspace" };
  }
  switch (pairs.status) {
    case "pending":
    case "refetching":
      // A read in flight — held rows or not — is not the settled answer here.
      // Restore is render-driven, so it can afford a frame, and the fresher read
      // may change reachability; it must NOT re-open the line from rows that
      // predate the question. `refetching` carries the held rows only so the
      // one-shot jump seam can act on a HIT; restore's behavior is unchanged
      // (both still `wait`), which #task:2052 keeps intact.
      return { kind: "wait" };
    case "failed":
      return { kind: "workspace" };
    case "ready":
      return pairs.conversationIds.has(place.conversationId)
        ? { kind: "open-direct", conversationId: place.conversationId }
        : { kind: "workspace" };
  }
}
