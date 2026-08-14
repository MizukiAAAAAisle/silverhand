// Conversation-PLACEMENT shared SQL (persistence zone, agent-scoped-session-v1
// §4.1/§4.2/§6). Like `task-sql.ts` this module imports no driver and runs no
// statement — it only carries SQL text, so the two rules below have ONE
// authority instead of a hand-rolled clause per query.
//
// Why SQL needs its own authority at all. `conversations.workspace_id` became
// nullable in v69: only the `workspace_id` arm of the placement carries it. A
// query that keeps `JOIN workspaces w ON w.id = c.workspace_id` therefore
// silently drops every non-workspace row — the failure mode §1 of the design doc
// exists to remove ("INNER JOIN 整行消失"). The fix is NOT to blanket-rewrite
// those joins to LEFT JOIN: most of those faces genuinely ARE workspace-scoped,
// and a LEFT JOIN there would produce rows with a null workspace name that the
// DTO cannot describe.
//
// So every such site must state which of the two it is:
//   - workspace-scoped face ⇒ carry {@link WORKSPACE_PLACED} as an explicit
//     DOMAIN predicate. The INNER JOIN then only ever resolves a coordinate that
//     exists, so the join can no longer be the thing doing the filtering, and
//     the exclusion reads as a decision in the query text.
//   - agent/user/conversation-scoped face ⇒ do NOT use these constants; carry
//     the null through and branch on placement (see
//     `@silverhand/shared`'s `conversation-placement.ts`).
//
// The corresponding code-side rules are `requireWorkspacePlacement` (assert the
// arm) and `isWorkspacePlaced` (split on it).

/** SQL predicate: this conversation is WORKSPACE-placed. Takes the table alias
 *  because call sites use `c` / `conv` / `channel`. Compares `placement_kind`
 *  rather than `workspace_id IS NOT NULL` on purpose — the placement kind is the
 *  discriminator the DB's arc CHECK is written against, so the predicate says
 *  WHICH ARM it wants instead of restating one arm's consequence. */
export function workspacePlaced(conversationAlias: string): string {
  return `${conversationAlias}.placement_kind = 'workspace'`;
}

/** Convenience for the common `c` alias. */
export const WORKSPACE_PLACED = workspacePlaced('c');

/** A SQL fragment plus the parameters it binds, in order. Returned together so
 *  a call site cannot get the parameter COUNT wrong — the participation
 *  predicate below binds the agent id twice, and a hand-written `where.push()`
 *  with one `params.push()` would shift every later parameter. */
export interface PlacementSqlFragment {
  sql: string;
  params: string[];
}

/**
 * SQL predicate: `agentId` PARTICIPATES in this conversation (§4.2) — the SQL
 * face of the same rule `canViewConversation` applies in code:
 *
 *   - a `conversation_agents` roster edge (every workspace placement), OR
 *   - the conversation IS this agent's inbox (`placement_kind='agent_inbox'`
 *     AND `inbox_agent_id = agentId`). The inbox has NO roster row by design —
 *     the placement IS the membership — so a query whose bottom guard is a bare
 *     `JOIN conversation_agents` returns ZERO rows for it, which is not "the
 *     agent may not read its inbox" but "this query cannot express who its
 *     participant is".
 *
 * A HUMAN is never a participant of the inbox, so there is deliberately no
 * user-side counterpart: human read faces stay `conversation_users`-gated and
 * exclude the inbox by domain rule (see `workspacePlaced`).
 */
export function agentParticipates(
  conversationAlias: string,
  agentId: string,
): PlacementSqlFragment {
  return {
    sql: `(EXISTS (
             SELECT 1 FROM conversation_agents ca_p
              WHERE ca_p.conversation_id = ${conversationAlias}.id
                AND ca_p.agent_id = ?
           )
           OR (${conversationAlias}.placement_kind = 'agent_inbox'
               AND ${conversationAlias}.inbox_agent_id = ?))`,
    params: [agentId, agentId],
  };
}
