/**
 * Direct-pair bounded context — the renderer half of #task:2035. Mirrors
 * `@silverhand/shared` `api/conversation.ts` (`DirectPairListItem`) and the
 * backend's `read-model/direct-pairs.ts`: the viewer's DIRECT MESSAGES list, one
 * row per `direct_pair` the viewer is an endpoint of.
 *
 * A `direct_pair` is NOT a channel and deliberately does not ride the channel
 * hooks: it has no workspace coordinate, so `useChannelsForWorkspace` has no
 * container to key it under and `GET /api/channels/:id` is not its authority. That
 * is also why this list is its own query rather than another arm of
 * `['workspaces']` — the cache key must have exactly the coordinates the row has,
 * which here is the VIEWER and nothing else.
 *
 * EXISTING pairs only (@shiki's product ruling, do not reopen): an agent the
 * viewer has never messaged does not pre-appear. The entrance for opening a new
 * line is the agent's own page (#task:2036), so this list stays a list of open
 * lines rather than a directory.
 *
 * Live-sync contract: `direct_pairs_changed` is an INVALIDATION hint carrying only
 * `conversation_id`, and `GET /api/direct-pairs` stays the authority for
 * membership, order and unread. Nothing here patches a row from a frame — unlike
 * the favorites list, whose unread is patched from `unread_updated`, because that
 * frame is keyed by (viewer, WORKSPACE) and a pair has no workspace coordinate to
 * be keyed under. So the pair's unread has exactly ONE carrier, and it is this
 * invalidation.
 */
import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  DirectPairListItem,
  DirectPairListResponse,
  MessageSendAck,
} from '@silverhand/shared';
import { apiPaths } from '@silverhand/shared';
import { api } from '@/lib/api';
import {
  isCurrentViewerScope,
  onWsFrame,
  subscribeViewerScope,
} from '@/lib/ws-client';

/** Query key for the viewer's direct-pair list. ONE cache entry: the list is
 *  viewer-global (like Activity and favorites) and takes no other coordinate. */
export const directPairsKey = ['direct-pairs'] as const;

/**
 * Read the viewer's direct-pair list. A pure OBSERVER — it arms no WS
 * subscription, because the invalidation obligation belongs to the viewer's
 * session and not to whichever surface happens to be reading the list
 * ({@link useDirectPairsSync}). Several surfaces read it (the sidebar section, and
 * App to resolve an open pair into a pane descriptor), and a per-caller
 * subscription would invalidate the same key once per caller for every frame.
 */
export function useDirectPairsList() {
  return useQuery<DirectPairListResponse>({
    queryKey: directPairsKey,
    queryFn: ({ signal }) =>
      api<DirectPairListResponse>(apiPaths.directPairs, { signal }),
  });
}

/** The rows, or an empty list while the query is cold — for consumers that render
 *  a list and have no separate empty/loading state to distinguish (the sidebar
 *  section renders nothing when there are no pairs, and "not loaded yet" looks the
 *  same). A consumer that must tell the two apart reads
 *  {@link useDirectPairsList} directly. */
export function useDirectPairs(): readonly DirectPairListItem[] {
  return useDirectPairsList().data?.direct_pairs ?? [];
}

/**
 * The viewer's existing line with one agent, or `null` when they have never
 * messaged each other (#task:2039). Pure, so the "existing line vs. new draft"
 * decision behind every `Message` entry is one testable rule rather than a
 * `.find` re-typed per surface.
 *
 * Matched on the counterpart's kind + id, INCLUDING the `deleted` arm: that arm
 * still names the endpoint, and a pair whose agent is gone is still the line
 * these two have — routing a viewer into a fresh draft instead would offer to
 * start a line that cannot be started (the door answers 404) while hiding the one
 * that exists, with its history.
 *
 * `rows: undefined` (a cold list) reads as "no pair" on purpose: the caller's
 * fallback is the draft route, whose first send is get-or-create — so a stale
 * miss costs a converge-on-send, never a duplicate line.
 */
export function findAgentDirectPair(
  pairs: readonly DirectPairListItem[],
  agentId: string,
): DirectPairListItem | null {
  return (
    pairs.find(
      p => p.counterpart.kind === 'agent' && p.counterpart.id === agentId,
    ) ?? null
  );
}

/**
 * The facts the pre-mint draft pane's handoff decision rests on
 * ({@link decideDraftHandoff}). Named so the decision is a pure function instead
 * of conditions scattered through an effect.
 */
export interface DraftHandoffFacts {
  /** The pair the viewer turns out to already have with this agent, if the list
   *  now contains one — {@link findAgentDirectPair}. `null` while they have
   *  none, which is the whole point of the draft route. */
  existingPairId: string | null;
  /** The composer holds content the user typed (trimmed, non-empty). */
  draftDirty: boolean;
  /** A first send is in flight. */
  sendPending: boolean;
  /** The last send attempt settled in failure. */
  sendFailed: boolean;
}

/** Handoff verdict: leave the draft route for the real pair, or stay. */
export type DraftHandoffDecision =
  | { kind: 'stay' }
  | { kind: 'handoff'; conversationId: string };

/**
 * Should the draft pane hand over to the pair's own route?
 *
 * A pair can appear underneath the draft at any moment — the agent may open the
 * line from its side, or our own first send may have MINTED the pair and then
 * failed to persist the message (a window #task:2036 accepts). Handing over
 * automatically in those moments discards whatever the pane is holding: the text
 * the user has typed but not sent, and the failure they have not read yet, both
 * of which live only in this pane's state (@Cindy, #task:2039 review).
 *
 * So only an UNTOUCHED, quiet pane may hand over. The four cells:
 *
 *  - empty — nothing typed, nothing in flight, nothing failed → `handoff`. The
 *    viewer loses nothing and lands on the line that now exists.
 *  - dirty — text is in the composer → `stay`. It is theirs to send; the send
 *    itself is get-or-create, so it converges on the very same pair.
 *  - pending — a send is in flight → `stay`. Its own success path navigates with
 *    the ack's conversation id; racing it here would move the pane out from
 *    under an unsettled mutation.
 *  - post-mint error — the send failed with a pair now existing → `stay`, so the
 *    reason stays on screen and the retry re-enters the same door.
 */
export function decideDraftHandoff(
  facts: DraftHandoffFacts,
): DraftHandoffDecision {
  if (facts.existingPairId === null) return { kind: 'stay' };
  if (facts.sendPending || facts.sendFailed || facts.draftDirty) {
    return { kind: 'stay' };
  }
  return { kind: 'handoff', conversationId: facts.existingPairId };
}

/**
 * What the pane can know about the pair named by `/chat/d/:conversationId`.
 *
 * FIVE states — a row, plus the FOUR different things "no row" can mean, which
 * is two more than a boolean can carry:
 *
 *  - `ready` — the row is in hand; the pane can render.
 *  - `idle` — the route names no pair. Nothing is being awaited.
 *  - `resolving` — the CURRENT authority has not answered yet. This covers the
 *    cold first read AND a refetch over retained rows: on invalidation React
 *    Query keeps the previous `data` and raises `isFetching` while `isPending`
 *    stays false, so a viewer whose cached list predates the pair (exactly the
 *    acceptance case — a stranger's first DM) would otherwise read as a settled
 *    absence and flash the terminal empty state before the row arrives.
 *  - `absent` — the current authority answered and this viewer is not an
 *    endpoint of that conversation (or it does not exist). TERMINAL, and it gets
 *    its OWN rendering ({@link directPairPaneProps} `notFound`) rather than the
 *    no-selection empty state: a loader here would never end, and "select a
 *    channel" would claim the viewer chose nothing.
 *  - `error` — the read that would answer failed and left no row. Not `absent`
 *    (nothing was proven about the pair) and not `resolving` (nothing is in
 *    flight, and with `retry: 1` the client will not keep trying on its own).
 *
 * Precedence is `ready > resolving > error > absent`: a row we hold is enough to
 * render the pane even while a refetch is in flight, and only a settled,
 * successful read may claim absence.
 */
export type DirectPairPaneState =
  | { kind: 'idle' }
  | { kind: 'resolving' }
  | { kind: 'ready'; pair: DirectPairListItem }
  | { kind: 'error' }
  | { kind: 'absent' };

/** The query facts {@link projectDirectPairPane} needs, named so the projection
 *  is a pure function of them and can be exercised without React or a socket.
 *  `rows: undefined` is "never answered"; an empty array is an ANSWER. */
export interface DirectPairListQueryFacts {
  rows: readonly DirectPairListItem[] | undefined;
  /** No data has ever been received for this key. */
  isPending: boolean;
  /** A fetch is in flight — true for the cold read AND for a refetch that is
   *  running on top of retained rows. */
  isFetching: boolean;
  /** The last fetch settled in failure. */
  isError: boolean;
}

/** Pure projection of (route id, query facts) → {@link DirectPairPaneState}. */
export function projectDirectPairPane(
  conversationId: string | null,
  facts: DirectPairListQueryFacts,
): DirectPairPaneState {
  if (conversationId === null) return { kind: 'idle' };
  const pair = facts.rows?.find(p => p.conversation_id === conversationId);
  if (pair) return { kind: 'ready', pair };
  if (facts.isPending || facts.isFetching) return { kind: 'resolving' };
  if (facts.isError) return { kind: 'error' };
  return { kind: 'absent' };
}

/**
 * The four questions the primary pane asks about the pair arm, as ONE value.
 *
 * This is the consumer half of {@link DirectPairPaneState} and it is a total,
 * injective mapping on purpose: a state the pane cannot express is a state that
 * only exists in this module's tests. `absent` in particular has to land
 * somewhere of its own — a settled "you are not an endpoint of that
 * conversation" rendered as the no-selection empty state would tell the viewer
 * they chose nothing while the route names a conversation and the authority has
 * already answered.
 */
export interface DirectPairPaneProps {
  /** The row to render, or null when there is nothing to render. */
  pair: DirectPairListItem | null;
  /** Wait: the current authority has not answered yet. */
  resolving: boolean;
  /** The read that would answer failed. */
  loadFailed: boolean;
  /** Answered, and this viewer is not an endpoint of that conversation. */
  notFound: boolean;
}

/**
 * Pure {@link DirectPairPaneState} → {@link DirectPairPaneProps}. Lives here
 * rather than inline in the shell so the five states map to five distinct
 * renderings by construction, and so collapsing any two of them (e.g. `absent`
 * into `idle`) changes an assertable value instead of silently changing only the
 * shipped UI.
 */
export function directPairPaneProps(
  state: DirectPairPaneState,
): DirectPairPaneProps {
  return {
    pair: state.kind === 'ready' ? state.pair : null,
    resolving: state.kind === 'resolving',
    loadFailed: state.kind === 'error',
    notFound: state.kind === 'absent',
  };
}

/**
 * The pane's carrier when the route is `/chat/d/:conversationId`. Thin wrapper
 * over {@link projectDirectPairPane} — the decision lives in the pure function so
 * the state machine is testable and every consumer reads the same one.
 */
export function useDirectPairPane(
  conversationId: string | null,
): DirectPairPaneState {
  const { data, isPending, isFetching, isError } = useDirectPairsList();
  return projectDirectPairPane(conversationId, {
    rows: data?.direct_pairs,
    isPending,
    isFetching,
    isError,
  });
}

/**
 * What the TASK-FILTER DM leaf may claim about the viewer's pair list — the
 * filter-bar analogue of {@link DirectPairPaneState}, distinguishing the four
 * things "no matching row" can mean so the leaf never presents a cold/failed
 * read as an authoritative empty set (#task:2041, Cindy B2). The board's DM tab
 * narrows on a pair's conversation id via `channel_id`; if the leaf compresses
 * loading/error to `[]` it (a) can't tell "still loading" from "you have no
 * lines", and (b) after the list answers, a selected pair that is NOT in it
 * reads as ALL on the trigger while the request still carries the dead
 * `channel_id` — the same invisible narrowing B2 kills on the container axis.
 *
 *  - `loading` — no rows in hand yet and a read is in flight (cold first read).
 *  - `failed` — no rows in hand and the read settled in failure.
 *  - `empty` — the authority answered with zero pairs (a real claim).
 *  - `ready` — the authority answered with at least one pair.
 *
 * `staleSelection` rides alongside: `true` only once the CURRENT read has
 * answered SUCCESSFULLY and the selected pair id is not among the rows it
 * answered with — a narrowing whose line is gone, to be cleared/surfaced rather
 * than shown as ALL. It is never `true` while a read is in flight or after a
 * failure, and RETAINED rows are not an answer (@Cindy, #task:2041 Round-3): on
 * invalidation React Query keeps the previous `data` and raises `isFetching`
 * while `isPending` stays false, so a cached list that predates the selected
 * pair — a line opened from the agent's side, or one minted by our own first
 * send — would otherwise be judged stale from rows nobody re-read, and the
 * self-healing consumer would drop a selection that is about to be valid.
 * Same for an error over retained rows: a failed read proves nothing about
 * membership. Only `rows` from a settled, successful fetch may condemn a
 * selection — the precedence {@link projectDirectPairPane} rests on, applied to
 * the selection instead of the pane. */
export type DirectPairFilterLeafStatus = 'loading' | 'failed' | 'empty' | 'ready';

export interface DirectPairFilterLeafView {
  status: DirectPairFilterLeafStatus;
  staleSelection: boolean;
}

/** Pure projection of (list query facts, selected pair id) → the DM leaf view.
 *  `selectedId` must already be null unless the DM container is active, so a real
 *  channel filter on another container is never mistaken for a stale pair. */
export function projectDirectPairFilterLeaf(
  facts: DirectPairListQueryFacts,
  selectedId: string | null,
): DirectPairFilterLeafView {
  const rows = facts.rows;
  // Do the rows we already hold ANSWER the question this leaf is being asked? With
  // a pair selected the question is "is that line still mine" (only that row
  // answers it); with nothing selected it is "which lines are mine" (any non-empty
  // list answers it). Either way a held answer renders as `ready` and no refetch
  // on top of it downgrades that — same `ready > resolving` precedence as
  // {@link projectDirectPairPane}, so the panel does not blink a wait message
  // under rows it is already showing.
  const held = rows !== undefined;
  const answered =
    selectedId !== null
      ? held && rows.some(p => p.conversation_id === selectedId)
      : held && rows.length > 0;
  if (answered) return { status: 'ready', staleSelection: false };
  // Nothing in hand answers it. Anything short of a settled, successful read may
  // not condemn the selection — retained rows are not an answer, a failure proves
  // nothing, and `isPending` catches a cold read that is not currently fetching
  // (paused/disabled) which `isFetching` alone would call settled.
  if (facts.isPending || facts.isFetching) {
    return { status: 'loading', staleSelection: false };
  }
  if (facts.isError) return { status: 'failed', staleSelection: false };
  // Settled and successful. `rows === undefined` here is a query that answered
  // nothing without fetching or failing; treat it as an empty answer.
  const settled = rows ?? [];
  return {
    status: settled.length === 0 ? 'empty' : 'ready',
    staleSelection: selectedId !== null,
  };
}

/** Minimal WS frame shape {@link decideDirectPairsInvalidation} consumes, so the
 *  decision can be exercised without React or a socket (mirrors `ViewerSyncFrame`
 *  in `features/workspaces/hooks`). */
export interface DirectPairsSyncFrame {
  type: string;
  kind?: string;
}

/**
 * Pure decision: does this frame invalidate the direct-pair list?
 *
 * `snapshot_required` counts, for the same reason it counts on every other
 * viewer-scoped list: a replay gap may have swallowed the frame that announced a
 * brand-new pair, and the row that would be lost is one the client has no other
 * way to learn about.
 *
 * The caller gates `isCurrentViewerScope(frame.scope)` first — kept out of here so
 * the decision stays dependency-free (same split as
 * `decideViewerSyncInvalidations`).
 */
export function decideDirectPairsInvalidation(
  frame: DirectPairsSyncFrame,
): boolean {
  if (frame.type === 'snapshot_required') return true;
  if (frame.type !== 'event') return false;
  return frame.kind === 'direct_pairs_changed';
}

/**
 * Keep the direct-pair list live. Mount ONCE post-auth
 * (`useAppShellGlobalSync`), NOT from the sidebar section that renders the list:
 * the case this whole feature exists for is a stranger's FIRST DM — an agent the
 * viewer never created and never messaged — and that row must appear immediately
 * even while the viewer is looking at another section, exactly like being added to
 * one's first workspace (`useViewerWorkspacesSync`).
 *
 * The carrier is the `viewer:<userId>` scope, which is subscribable with no
 * workspace and no open conversation. It has to be: a pair has no workspace scope
 * to listen on, and the conversation's own `message` frame reaches only clients
 * subscribed to that conversation — which a viewer who has never opened the line
 * cannot be.
 */
export function useDirectPairsSync(): void {
  const qc = useQueryClient();
  useEffect(() => {
    const sub = subscribeViewerScope();
    const unsub = onWsFrame(frame => {
      if (
        (frame.type !== 'event' && frame.type !== 'snapshot_required') ||
        !isCurrentViewerScope(frame.scope)
      ) {
        return;
      }
      if (decideDirectPairsInvalidation(frame)) {
        void qc.invalidateQueries({ queryKey: directPairsKey });
      }
    });
    return () => {
      sub.unsubscribe();
      unsub();
    };
  }, [qc]);
}

/**
 * First-send door for a human-initiated human↔agent DirectPair (#task:2036
 * part ①). POSTs the draft's text to `POST /api/agents/:id/direct-messages`,
 * which is get-or-create: the pair is minted (and announced) the first time a
 * send commits and reused on every later send. The renderer does NOT allocate
 * the pair — opening or cancelling the draft has zero persistence, so there is
 * nothing to invalidate until a send actually returns.
 *
 * This is emphatically NOT a renderer copy of the backend's initiation
 * authority: the door re-authorizes every send (session scope, schema, content
 * cap, reply target) and its 403/404/400/413 are the authoritative answers. The
 * button's product-domain visibility (`session_scope === 'agent'`) narrows who
 * is OFFERED the door; it never stands in for that check.
 *
 * On success we invalidate `directPairsKey` so a freshly minted pair appears in
 * the DIRECT MESSAGES list even for a viewer whose cached list predates it; the
 * caller reads `ack.message.conversation_id` to navigate to the new line. The
 * mint is idempotent (get-or-create → one row) but the POST is not — a
 * double-submit sends two messages into the same pair, so callers must guard the
 * submit affordance rather than rely on this hook to dedupe.
 */
export function useInitiateDirectMessage(agentId: string) {
  const qc = useQueryClient();
  return useMutation<MessageSendAck, Error, { content: string }>({
    mutationFn: async ({ content }) =>
      api<MessageSendAck>(apiPaths.agentDirectMessages(agentId), {
        method: 'POST',
        body: JSON.stringify({ content } satisfies { content: string }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: directPairsKey });
    },
  });
}
