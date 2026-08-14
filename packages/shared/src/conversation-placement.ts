// Placement accessors for conversations (agent-scoped-session-v1 §4.1).
//
// A workspace is a property of ONE placement arm, not of every conversation:
// `placement_kind='workspace'` rows carry `workspace_id`, `agent_inbox` rows
// carry `inbox_agent_id`, and `direct_pair` (P3) will carry its endpoints. That
// is why `workspace_id` is nullable on the row AND on the wire.
//
// Nullable coordinates spread through call sites in two very different ways,
// and the whole point of this module is to keep them apart:
//
//   - A surface whose UNIT IS A WORKSPACE (workspace roster admission, the
//     workspace task board, per-workspace channel lists, `#conv:` resolution
//     inside a workspace) must NOT invent a coordinate for a placement that has
//     none. Reaching such a surface with a non-workspace conversation is a
//     ROUTING bug upstream, so it fails loud here instead of coercing.
//     `requireWorkspacePlacement` is that assertion, and every call site is
//     simultaneously a DECLARATION that the surface is workspace-scoped.
//
//   - A surface whose unit is an AGENT, a USER, or a CONVERSATION ID (the agent
//     activity roster, control-plane stop/purge, search, delivery) must carry
//     the null through and group by placement. Those sites do NOT call this
//     function — they handle `workspace_id === null` explicitly.
//
// Deliberately NOT a coercion (`?? someWorkspaceId`) and NOT a filter: a
// silently-substituted or silently-dropped row is the exact failure mode this
// feature exists to remove (§1 "INNER JOIN 整行消失").
import type {
  ConversationEndpointKind,
  ConversationPlacementKind,
} from './db/schema.js';

/** The title every agent inbox carries. One constant so the backend insert and
 *  any display surface agree; the v71 backfill repeats the literal because SQL
 *  cannot import it. Not a per-agent label ("Alice's Inbox"): the inbox has
 *  exactly one participant, who never needs to be told whose it is. */
export const AGENT_INBOX_TITLE = 'Inbox';

/** The minimum shape both DB rows and wire DTOs satisfy. Structural on purpose
 *  so the one rule serves both without a conversion step. */
export interface ConversationPlacementRef {
  id: string;
  workspace_id: string | null;
}

export class ConversationPlacementError extends Error {
  constructor(
    readonly conversationId: string,
    readonly placementKind?: ConversationPlacementKind,
  ) {
    super(
      `conversation ${conversationId} is not workspace-placed` +
        (placementKind ? ` (placement_kind=${placementKind})` : '') +
        ': this surface is workspace-scoped and has no coordinate for it',
    );
    this.name = 'ConversationPlacementError';
  }
}

/** Assert the workspace arm and return its id. Throws
 *  {@link ConversationPlacementError} for every other placement — see the
 *  module docblock for when NOT to use this. */
export function requireWorkspacePlacement(
  conversation: ConversationPlacementRef & {
    placement_kind?: ConversationPlacementKind;
  },
): string {
  if (conversation.workspace_id === null) {
    throw new ConversationPlacementError(
      conversation.id,
      conversation.placement_kind,
    );
  }
  return conversation.workspace_id;
}

/** True when the conversation is workspace-placed. For read surfaces that
 *  legitimately SPLIT by placement rather than assert one arm.
 *
 *  A TYPE PREDICATE, so the split narrows `workspace_id` to `string` in the
 *  positive arm: a site that has honestly branched should not then need a `!` or
 *  a second assertion, which is exactly where a mechanical non-null slips in. */
export function isWorkspacePlaced<T extends ConversationPlacementRef>(
  conversation: T,
): conversation is T & { workspace_id: string } {
  return conversation.workspace_id !== null;
}

/** One endpoint of a `direct_pair` placement as a COORDINATE: which kind of
 *  principal, and its id. Says nothing about whether that principal still
 *  exists — that is a lookup, and keeping it out of this type is what stops
 *  "gone" from being stored twice (see {@link directPairEndpointsOf}). */
export interface ConversationEndpointCoordinate {
  kind: ConversationEndpointKind;
  id: string;
  /** WHEN the principal was hard-deleted, when that is known. NEVER read as the
   *  existence question: a stamp may be missing (some future delete path) while
   *  the principal is genuinely gone, so callers must OR this with a failed
   *  lookup. It is here only so a caller that already knows the endpoint is gone
   *  can say WHEN. */
  deletedAt: number | null;
}

/** The columns {@link directPairEndpointsOf} reads. Structural, so a DB row and
 *  any projection of it (the ACL facts, a future DTO) satisfy it unchanged. */
export interface ConversationEndpointRef {
  placement_kind: ConversationPlacementKind;
  endpoint_a_kind: ConversationEndpointKind | null;
  endpoint_a_id: string | null;
  endpoint_b_kind: ConversationEndpointKind | null;
  endpoint_b_id: string | null;
  endpoint_a_deleted_at: number | null;
  endpoint_b_deleted_at: number | null;
}

/**
 * The two endpoints of a `direct_pair` conversation, in the canonical order the
 * DB stores them, or `null` for every other placement — the ONE place the six
 * endpoint columns are turned into a pair, so no caller re-derives "is the b
 * column the one I mean".
 *
 * Throws rather than returning a half pair when a `direct_pair` row is missing a
 * coordinate. The DB's arc CHECK makes that unrepresentable, so reaching it
 * means the row did not come from this schema, and an ACL that silently treated
 * a half pair as "no endpoints" would fail OPEN on the survivor's write gate.
 */
export function directPairEndpointsOf(
  conversation: ConversationEndpointRef,
): readonly [ConversationEndpointCoordinate, ConversationEndpointCoordinate] | null {
  if (conversation.placement_kind !== 'direct_pair') return null;
  const {
    endpoint_a_kind: aKind,
    endpoint_a_id: aId,
    endpoint_b_kind: bKind,
    endpoint_b_id: bId,
  } = conversation;
  if (aKind === null || aId === null || bKind === null || bId === null) {
    throw new Error(
      'direct_pair conversation is missing an endpoint coordinate: the placement arc CHECK cannot produce this row',
    );
  }
  return [
    { kind: aKind, id: aId, deletedAt: conversation.endpoint_a_deleted_at },
    { kind: bKind, id: bId, deletedAt: conversation.endpoint_b_deleted_at },
  ];
}
