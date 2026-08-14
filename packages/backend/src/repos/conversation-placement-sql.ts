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
 * THE roster read of the placement layer, and the only one: an agent's
 * `conversation_agents` edge, with the workspace predicate ANDed INSIDE the
 * fragment so the gating cannot be separated from the read by an edit to a
 * caller.
 *
 * Why a builder instead of an inline clause in each arm (@Cindy B2). "The roster
 * is authoritative for the workspace arm only" is a claim about SQL NESTING, and
 * nesting is not something a scan of nearby text can establish — a
 * `(placement_kind = 'workspace' OR EXISTS (…roster…))` reads as gated to any
 * proximity check and is wide open to the engine. Concentrating the read in one
 * byte-pinned fragment makes the claim checkable by COUNTING: Gate 9 asserts that
 * `conversation_agents` appears exactly once in this file and that the occurrence
 * is inside this fragment's pinned text, so a second roster read anywhere — nested
 * or not, in any arm — fails the gate, and weakening the `AND` to an `OR` fails it
 * too.
 *
 * Binds ONE parameter (the agent id). Callers must keep it in the fragment's own
 * position; {@link agentParticipates} returns its parameters as a list for exactly
 * that reason.
 */
function workspaceAgentRosterEdge(conversationAlias: string): string {
  return `(${conversationAlias}.placement_kind = 'workspace'
            AND EXISTS (
              SELECT 1 FROM conversation_agents ca_p
               WHERE ca_p.conversation_id = ${conversationAlias}.id
                 AND ca_p.agent_id = ?
            ))`;
}

/**
 * SQL predicate: `agentId` PARTICIPATES in this conversation (§4.2) — the SQL
 * face of the same rule `permissions.ts`'s `participates` applies in code, with
 * one arm per placement because the placement IS the rule:
 *
 *   - `workspace` — a `conversation_agents` roster edge, via
 *     {@link workspaceAgentRosterEdge}. The roster is the authority for THIS ARM
 *     ONLY: a stray roster row on a DM or an inbox must be INERT, and an ungated
 *     EXISTS would make it authoritative in every SQL face (delivery, the agent
 *     activity roster, the runtime control planes, P2's target gate) while the code
 *     face correctly ignored it. Same rule, two faces, so they must not disagree.
 *   - `direct_pair` — an `agent` ENDPOINT naming this agent. There is no roster
 *     row and never will be: the two endpoints ARE the participants. Deletion of
 *     the OTHER endpoint does not remove the survivor from its own DM — that
 *     closes the WRITE gate, not participation — so this arm deliberately ignores
 *     `endpoint_*_deleted_at`.
 *   - `agent_inbox` — the conversation IS this agent's inbox. Also rosterless, so
 *     a query whose bottom guard is a bare `JOIN conversation_agents` returns ZERO
 *     rows for it, which is not "the agent may not read its inbox" but "this query
 *     cannot express who its participant is".
 *
 * The RUNNING-IN narrowing that the code face applies to a session principal is
 * deliberately absent: that asks "may THIS session act inside conversation X",
 * while this predicate enumerates the conversations an agent belongs to. Every
 * caller here is a set-shaped face (delivery fan-out, activity, runtime control
 * planes, target gates).
 *
 * A HUMAN is never a participant of an inbox, and no live face enumerates a
 * person's `direct_pair` rows yet (the human DM read surfaces land with
 * #task:2022), so there is deliberately no user-side counterpart here: human
 * faces stay `conversation_users`-gated for the workspace arm, and the human ACL
 * reaches `direct_pair` through the code face (`resolveParticipation`), which
 * needs no SQL. The predicate this file would hold is a one-liner; writing it
 * before a caller exists would make it an unverified contract.
 */
export function agentParticipates(
  conversationAlias: string,
  agentId: string,
): PlacementSqlFragment {
  return {
    sql: `(${workspaceAgentRosterEdge(conversationAlias)}
           OR (${conversationAlias}.placement_kind = 'direct_pair'
               AND ((${conversationAlias}.endpoint_a_kind = 'agent'
                     AND ${conversationAlias}.endpoint_a_id = ?)
                 OR (${conversationAlias}.endpoint_b_kind = 'agent'
                     AND ${conversationAlias}.endpoint_b_id = ?)))
           OR (${conversationAlias}.placement_kind = 'agent_inbox'
               AND ${conversationAlias}.inbox_agent_id = ?))`,
    params: [agentId, agentId, agentId, agentId],
  };
}
