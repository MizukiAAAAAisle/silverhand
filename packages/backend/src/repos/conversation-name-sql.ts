// Conversation-NAME shared SQL (#task:2016) — the workspace namespace's two
// reusable clauses. Like `conversation-placement-sql.ts` this module imports no
// driver and runs no statement; it only carries SQL text, so each rule has ONE
// authority instead of a hand-copied clause per query.
//
// Two clauses live here, and both are load-bearing in a way a local rewrite
// would quietly break:
//
//  - the CURRENT-NAME projection, because "the current name" is `retired_at IS
//    NULL` and nothing else. A query that reached for the newest `assigned_at`
//    instead would look right on every row the rename path has ever produced and
//    still be wrong: retirement, not recency, is what ends an allocation.
//  - the TARGET-JOIN predicate, because resolving a name has to conjoin the
//    workspace and the placement with the id. Joining on `conversation_id`
//    alone is not a data-hygiene nicety — combined with a namespace per
//    workspace it is a cross-workspace addressing hole, where one workspace's
//    name can resolve to another workspace's conversation.
//
// Names belong to `placement_kind='workspace'` conversations only: an
// AgentInbox (and, from P3, a DirectPair) is addressed through its principal and
// never enters a workspace namespace.

/**
 * Correlated subquery yielding the conversation's CURRENT name, or NULL when it
 * holds no current allocation. Takes the table alias because call sites spell
 * the conversations table `c` / `conversations`.
 *
 * NULL is a REACHABLE value, not a defensive branch: `kind` is GENERATED from
 * `roster_policy`, so an `agent_inbox` row reports `kind='dm_channel'` and can
 * reach a channel-like read by id — and it has no name by design. The DTO field
 * is nullable for exactly this reason.
 */
export function currentNameProjection(conversationAlias: string): string {
  return `(SELECT cn.name
             FROM conversation_names cn
            WHERE cn.conversation_id = ${conversationAlias}.id
              AND cn.retired_at IS NULL)`;
}

/** Convenience for the common `c` alias. */
export const CURRENT_NAME = currentNameProjection('c');

/** Convenience for the sites that select from an unaliased `conversations`. */
export const CURRENT_NAME_UNALIASED = currentNameProjection('conversations');

/**
 * The join predicate from an allocation row (`n`) to the conversation it
 * addresses (`c`) — all three conjuncts, written once.
 *
 * `c.workspace_id = n.workspace_id` is the one that matters most: without it a
 * name allocated in workspace A could resolve to a conversation of workspace B
 * (see the module header). `placement_kind='workspace'` keeps the domain honest
 * in the other direction, so a future placement that happens to collide on id
 * space cannot be addressed through a workspace namespace it never joined.
 */
export const NAME_TARGET_JOIN = `c.id = n.conversation_id
       AND c.workspace_id = n.workspace_id
       AND c.placement_kind = 'workspace'`;
