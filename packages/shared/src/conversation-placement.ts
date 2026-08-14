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
import type { ConversationPlacementKind } from './db/schema.js';

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
