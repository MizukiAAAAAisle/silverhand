/**
 * What a chat pane needs to know about the conversation it is rendering — the
 * shape `ChannelView` has always taken as `conversation`, lifted here (#task:2035)
 * because a second placement now produces one. The pane is the single authority
 * on this: whatever fills the pane resolves the descriptor ONCE and every child
 * (composer, message list, thread panel) reads the coordinate from it instead of
 * re-deriving it from a conversation-ref fetch of its own.
 *
 * `workspace_id` is nullable, and that null is a POSITIVE fact — "this
 * conversation has no workspace at all" — not "not resolved yet". A pane does not
 * mount without a descriptor, so there is no window in which the coordinate is
 * merely unknown; that distinction is what lets the composer treat a missing
 * workspace as terminal (no roster will ever land) rather than as a cold start.
 */
import type {
  ConversationPlacementKind,
  ConversationRosterPolicy,
  DirectPairListItem,
} from '@silverhand/shared';

/** Kind of the workspace a pane's conversation sits in, `null` for a
 *  workspace-less placement. Mirrors `ConversationRef.workspace_kind`'s
 *  external projection (`agent_home → 'dm'`). */
export type WorkspaceUiKind = 'regular' | 'dm';

export interface ConversationPaneDescriptor {
  id: string;
  /** The pane's display title. A `direct_pair` holds no `title_key`, so the
   *  carrier resolves the counterpart's label into this field — see
   *  `directPairPaneDescriptor`. */
  title: string;
  placement_kind: ConversationPlacementKind;
  roster_policy: ConversationRosterPolicy;
  closed_at: number | null;
  archived_at: number | null;
  /** `null` ⇔ workspace-less placement (a `direct_pair`). Every workspace-scoped
   *  affordance downstream — member management, `#channel` refs, workspace
   *  search, task refs — is gated on this being non-null. */
  workspace_id: string | null;
  /** Per-viewer membership, when the carrier (discovery-union list item)
   *  provides it. Absent on a cross-workspace `?side` ref / deep link →
   *  the view resolves it via a channel-detail fetch (see the membership
   *  derivation in `ChannelView`). Drives the read-only-browse + Join gate for
   *  a public channel the viewer hasn't joined. Never set for a `direct_pair`:
   *  an endpoint is not a member, and the pair's gate has its own constructor
   *  (`directPairGate`). */
  is_member?: boolean;
  /** The conversation accepts no new messages, ever — set only by
   *  `direct_pair`, whose counterpart principal is gone. Distinct from
   *  `closed_at` (an operator action a channel can come back from). */
  read_only?: boolean;
}

/**
 * A direct-pair list row as a pane descriptor. `label` is the counterpart's
 * resolved name (`presentCounterpart(...).label`), which IS the pair's title —
 * resolution is per-viewer and belongs to the renderer, so the mapper takes it
 * rather than inventing one.
 *
 * The two literals are claims about today's write surface, stated here once
 * instead of at each call site:
 *  - `roster_policy: 'fixed'` is the STORED value for a pair (the mint writes it
 *    in `conversation-repo.ts`), so this is a copy of a fact, not a default. It
 *    keeps `canAddMember` false without teaching that predicate about pairs.
 *  - `closed_at` / `archived_at` are null because no door can close or archive a
 *    pair: both operations are workspace-channel routes and reject a
 *    workspace-less placement, and there is no workspace to archive. FALSIFIER:
 *    a `direct_pair` row with either column non-null — the day one exists,
 *    `DirectPairListItem` must carry the two fields and this mapper must copy
 *    them instead.
 */
export function directPairPaneDescriptor(
  pair: DirectPairListItem,
  label: string,
): ConversationPaneDescriptor {
  return {
    id: pair.conversation_id,
    title: label,
    placement_kind: 'direct_pair',
    roster_policy: 'fixed',
    closed_at: null,
    archived_at: null,
    workspace_id: null,
    read_only: pair.read_only,
  };
}
