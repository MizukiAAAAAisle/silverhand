/**
 * The sidebar's DIRECT MESSAGES rows: the viewer's pairs, plus the line that is
 * being started but does not exist yet (#task:2039).
 *
 * WHY THIS IS A SEAM. Two facts about the same agent can be true at once — the
 * viewer has a pair with A, and the pre-mint draft pane for A is the open pane
 * holding unsent text (or the reason a first send failed after the pair was
 * minted). @Cindy's review caught the first cut dropping the draft row the moment
 * a pair appeared: the pane's own rule (`decideDraftHandoff`) correctly stayed,
 * while the sidebar showed the pair's row instead — unselected, and one click away
 * from navigating out of the draft and discarding both the text and the failure.
 *
 * THE RULE. While the draft route is open, that agent's line is ONE row and the
 * DRAFT owns it: selected (the draft pane is the open pane), and clicking it stays
 * on the draft. It becomes an ordinary pair row when — and only when — the draft
 * route is gone, which is exactly what `decideDraftHandoff` decides. So the three
 * cells the review named (dirty / pending / post-mint-error) need no restatement
 * here: they are the cells where that rule says `stay`, the route therefore
 * remains `/chat/d/new/:agentId`, and this function is still handed a draft.
 * ONE decider, and the sidebar reads its output instead of guessing again from the
 * pair's existence.
 *
 * A merged row still shows the PAIR's counterpart and unread count: the pair is
 * the authority on both (the agent may have written first — that is one way the
 * pair got there), and the draft only decides selection and where a click goes.
 * Its key is the pair's conversation id where one exists, so convergence swaps the
 * row's behavior without remounting it.
 *
 * DELETED COUNTERPARTS ARE HIDDEN HERE (@shiki, #task:2094). A pair whose principal
 * is gone should not sit in the sidebar DIRECT MESSAGES list by default — for an
 * agent AND a human counterpart alike. This is a SIDEBAR-ONLY rule: this function
 * is the sidebar's sole row builder ({@link DirectMessagesPanel} its only caller),
 * so saved/search — which read pairs through other paths — are untouched and still
 * surface a deleted line (rendered with its "(deleted account)" label by
 * `counterpart-presentation`). Hiding is decided by {@link directLinePairVisibleInSidebar}.
 */
import type { DirectPairCounterpart, DirectPairListItem } from '@silverhand/shared';

/** The open pre-mint line: route state, not a stored conversation. */
export interface DirectLineDraft {
  agentId: string;
  /** The agent read as a counterpart (`counterpartFromAgent`), used only when no
   *  pair carries a richer one yet. */
  counterpart: DirectPairCounterpart;
}

interface DirectLineRowBase {
  /** Stable across convergence: the pair's conversation id whenever there is a
   *  pair, so a draft row becoming a pair row is the same row. */
  key: string;
  counterpart: DirectPairCounterpart;
  unread: number;
  selected: boolean;
}

export type DirectLineRow =
  /** An existing line. Opening it navigates to the pair. */
  | (DirectLineRowBase & { kind: 'pair'; conversationId: string })
  /** The line being started. Opening it stays on the draft — including when a
   *  pair already exists, which is the whole point of this arm. */
  | (DirectLineRowBase & { kind: 'draft'; agentId: string });

/**
 * Whether a pair is shown in the sidebar DIRECT MESSAGES list. A `deleted`
 * counterpart is hidden (agent and human alike, #task:2094); every `active`
 * counterpart is shown. Behaviour decides the branch, so it is a named predicate
 * with its own test rather than an inline `!== 'deleted'`.
 */
export function directLinePairVisibleInSidebar(
  pair: DirectPairListItem,
): boolean {
  return pair.counterpart.status !== 'deleted';
}

/**
 * Merge the pair list with the open draft into the rows the section renders.
 *
 * Order is the server's (`created_at`, oldest first). A draft that matched a pair
 * keeps THAT PAIR'S position — it is the same line, so it must not jump; a draft
 * with no pair is appended, where a line just being opened belongs.
 *
 * The two selection inputs are mutually exclusive by ROUTE, not by a rule here:
 * `/chat/d/new/:agentId` puts nothing in the open-conversation id, so `draft` and
 * a non-null `selectedConversationId` never arrive together.
 */
export function mergeDirectLineRows({
  pairs,
  draft,
  selectedConversationId,
}: {
  pairs: readonly DirectPairListItem[];
  draft: DirectLineDraft | null;
  selectedConversationId: string | null;
}): DirectLineRow[] {
  let draftMerged = false;
  const visiblePairs = pairs.filter(directLinePairVisibleInSidebar);
  const rows: DirectLineRow[] = visiblePairs.map(pair => {
    const isDraftsPair =
      draft !== null
      && pair.counterpart.kind === 'agent'
      && pair.counterpart.id === draft.agentId;
    if (isDraftsPair && draft !== null) {
      draftMerged = true;
      return {
        kind: 'draft',
        key: pair.conversation_id,
        agentId: draft.agentId,
        counterpart: pair.counterpart,
        unread: pair.unread_count,
        // The draft pane IS the open pane whenever a draft is passed, so this is
        // not a second selection rule — it is that fact, rendered.
        selected: true,
      };
    }
    return {
      kind: 'pair',
      key: pair.conversation_id,
      conversationId: pair.conversation_id,
      counterpart: pair.counterpart,
      unread: pair.unread_count,
      selected:
        selectedConversationId !== null
        && pair.conversation_id === selectedConversationId,
    };
  });
  if (draft !== null && !draftMerged) {
    rows.push({
      kind: 'draft',
      key: `draft:${draft.agentId}`,
      agentId: draft.agentId,
      counterpart: draft.counterpart,
      // No messages exist yet, by construction.
      unread: 0,
      selected: true,
    });
  }
  return rows;
}
