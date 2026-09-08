import type { DirectPairCounterpart, DirectPairListItem } from "@silverhand/shared";

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
  | (DirectLineRowBase & { kind: "pair"; conversationId: string })
  /** The line being started. Opening it stays on the draft — including when a
   *  pair already exists, which is the whole point of this arm. */
  | (DirectLineRowBase & { kind: "draft"; agentId: string });

/**
 * Whether a pair is shown in the sidebar DIRECT MESSAGES list. A `deleted`
 * counterpart is hidden (agent and human alike, #task:2094); every `active`
 * counterpart is shown. Behaviour decides the branch, so it is a named predicate
 * with its own test rather than an inline `!== 'deleted'`.
 */
export function directLinePairVisibleInSidebar(pair: DirectPairListItem): boolean {
  return pair.counterpart.status !== "deleted";
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
  const rows: DirectLineRow[] = visiblePairs.map((pair) => {
    const isDraftsPair =
      draft !== null && pair.counterpart.kind === "agent" && pair.counterpart.id === draft.agentId;
    if (isDraftsPair && draft !== null) {
      draftMerged = true;
      return {
        kind: "draft",
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
      kind: "pair",
      key: pair.conversation_id,
      conversationId: pair.conversation_id,
      counterpart: pair.counterpart,
      unread: pair.unread_count,
      selected: selectedConversationId !== null && pair.conversation_id === selectedConversationId,
    };
  });
  if (draft !== null && !draftMerged) {
    rows.push({
      kind: "draft",
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
