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
 * Why a builder instead of an inline clause in each arm. "The roster
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
 * The agent side is an EXPRESSION, not a hard-coded `?` (#task:2021 P4-5). The
 * point form binds `'?'` here and the correlated form passes a COLUMN of the
 * enclosing query (`a.id`), so enumerating a conversation's participants is the
 * same predicate as asking about one of them instead of a per-arm re-derivation
 * in the repo. When it is `'?'` the fragment binds ONE parameter and callers must
 * keep it in the fragment's own position; {@link agentParticipates} returns its
 * parameters as a list for exactly that reason.
 */
function workspaceAgentRosterEdge(
  conversationAlias: string,
  agentIdExpr: string,
): string {
  return `(${conversationAlias}.placement_kind = 'workspace'
            AND EXISTS (
              SELECT 1 FROM conversation_agents ca_p
               WHERE ca_p.conversation_id = ${conversationAlias}.id
                 AND ca_p.agent_id = ${agentIdExpr}
            ))`;
}

/** The three placement arms of agent participation, over an agent-side
 *  EXPRESSION. Both public faces below are this text; see
 *  {@link agentParticipates} for what each arm means and why. */
function agentParticipatesSql(
  conversationAlias: string,
  agentIdExpr: string,
): string {
  return `(${workspaceAgentRosterEdge(conversationAlias, agentIdExpr)}
           OR (${conversationAlias}.placement_kind = 'direct_pair'
               AND ((${conversationAlias}.endpoint_a_kind = 'agent'
                     AND ${conversationAlias}.endpoint_a_id = ${agentIdExpr})
                 OR (${conversationAlias}.endpoint_b_kind = 'agent'
                     AND ${conversationAlias}.endpoint_b_id = ${agentIdExpr})))
           OR (${conversationAlias}.placement_kind = 'agent_inbox'
               AND ${conversationAlias}.inbox_agent_id = ${agentIdExpr}))`;
}

/**
 * THE SET-SHAPED roster read: the `conversation_agents` rows of ONE workspace
 * conversation, as agent ids. The twin of {@link workspaceAgentRosterEdge} — same
 * table, same workspace gating ANDed INSIDE the fragment, same reason it is a
 * pinned fragment rather than an inline clause — asked in the other DIRECTION.
 *
 * Why a second reading of the roster exists at all. The predicate
 * form answers "is THIS agent a participant", so enumerating participants with it
 * means offering every agent as the candidate: `JOIN agents a ON <predicate>`
 * plans as a full `SCAN a`, and the send path's recipient enumeration ran that on
 * EVERY message. Cost tracked the number of agents in the installation instead of
 * the size of the conversation. "One text read two ways" was the wrong thing to
 * buy with a table scan: the arms are not symmetric — a roster EXISTS is a
 * membership TEST while the endpoint / inbox arms are already single-row LOOKUPS —
 * so the enumeration has to be expressed as "the placement PRODUCES the candidate
 * ids", which is what {@link PARTICIPANT_AGENT_IDS_SQL} does.
 *
 * That leaves TWO texts for one rule, which is a real cost and is paid for
 * explicitly: Gate 9 counts BOTH roster reads as pinned fragments (so a third one
 * is still a gate failure), and `tests/read-model/participation-enumeration.test.ts`
 * asserts the two readings agree over a placement × liveness matrix rather than
 * trusting that they were edited together.
 */
function workspaceAgentRosterMembers(): string {
  return `SELECT ca_p.agent_id AS agent_id
              FROM conversations c_p
              JOIN conversation_agents ca_p
                ON ca_p.conversation_id = c_p.id
             WHERE c_p.id = @conv
               AND c_p.placement_kind = 'workspace'`;
}

/**
 * The AGENT PARTICIPANTS of one conversation, as a set of candidate ids produced
 * by the placement (§4.2) — the enumerating reading of {@link agentParticipates},
 * arm for arm, and the text every recipient fan-out is built on (#task:2021 P4-5).
 *
 * Shape, and why each part of it is deliberate:
 *
 *   - ONE ARM PER PLACEMENT, each starting from `conversations` by primary key, so
 *     the whole set is reached by ≤ 4 index lookups plus a roster prefix seek on
 *     `PRIMARY KEY (conversation_id, agent_id)`. The three non-workspace arms are
 *     column reads: a `direct_pair`'s participants ARE its two endpoints, an
 *     inbox's IS its owner. The plan contract is pinned by an EXPLAIN falsifier —
 *     regressing to a candidate scan is the failure it exists to report.
 *   - `UNION`, not `UNION ALL`: this is a SET. The arms are mutually exclusive on
 *     `placement_kind` today, so the dedup is doing nothing — but "no duplicate
 *     recipients" is a property the callers rely on (each id becomes one delivery
 *     and one wake), and it must not depend on arms staying exclusive.
 *   - `@conv`, bound ONCE by name for all four arms. Positional `?` here would be
 *     four parameters for one value: the exact miscount
 *     {@link PlacementSqlFragment} exists to prevent, in a text where the arms are
 *     meant to grow.
 *   - CANDIDATES, not recipients: LIVENESS IS NOT HERE. Participation deliberately
 *     survives a deleted peer (the survivor keeps reading its own DM), so a caller
 *     that enumerates DELIVERY targets joins live `agents` over this set — see
 *     `conversation-repo`'s `LIVE_PARTICIPANT_AGENT_IDS_SQL`, which is the
 *     production statement. Putting the join here would silently redefine
 *     participation for every future reader of the set.
 */
export const PARTICIPANT_AGENT_IDS_SQL = `${workspaceAgentRosterMembers()}
             UNION
            SELECT c_p.endpoint_a_id AS agent_id
              FROM conversations c_p
             WHERE c_p.id = @conv
               AND c_p.placement_kind = 'direct_pair'
               AND c_p.endpoint_a_kind = 'agent'
             UNION
            SELECT c_p.endpoint_b_id AS agent_id
              FROM conversations c_p
             WHERE c_p.id = @conv
               AND c_p.placement_kind = 'direct_pair'
               AND c_p.endpoint_b_kind = 'agent'
             UNION
            SELECT c_p.inbox_agent_id AS agent_id
              FROM conversations c_p
             WHERE c_p.id = @conv
               AND c_p.placement_kind = 'agent_inbox'`;

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
 * The human counterpart is {@link userParticipates} — the same rule for the
 * other principal kind. It exists now because a caller does: the
 * send's write gate asks participation of EVERY actor kind inside the
 * transaction, so "the human arm has no SQL face" stopped being true the moment
 * that gate stopped ending at the route.
 */
export function agentParticipates(
  conversationAlias: string,
  agentId: string,
): PlacementSqlFragment {
  return {
    sql: agentParticipatesSql(conversationAlias, '?'),
    params: [agentId, agentId, agentId, agentId],
  };
}

/**
 * The SAME predicate as {@link agentParticipates}, with the agent side supplied
 * as an EXPRESSION of the enclosing query — a column, e.g. `a.id` from a
 * `JOIN agents a` — so a query can FILTER a set of candidate agents it has
 * ALREADY BOUNDED by something else (#task:2021 P4-5).
 *
 * FILTERING, not enumerating. This form's one caller reads
 * `thread_followers` for a thread root and asks the predicate of each follower it
 * found; the candidate set is bounded by the follower table, and each `?`-free
 * arm is evaluated against a row already in hand. Using it to ENUMERATE — offering
 * `agents` as the candidate set — makes the plan a full scan of every agent in the
 * installation on every send, which is why the recipient fan-out is built on
 * {@link PARTICIPANT_AGENT_IDS_SQL} instead. If a future caller wants the
 * participants of a conversation, that constant is the authority; this predicate is
 * for narrowing a set that is already small.
 *
 * Returns a bare string, NOT a {@link PlacementSqlFragment}: with the agent side
 * correlated there is nothing to bind, and a fragment shape would invite a caller
 * to splice an empty `params` list into a position where the point form binds
 * four. Passing `'?'` here would compile and then bind nothing — use
 * {@link agentParticipates} for that.
 *
 * LIVENESS IS NOT PART OF IT. Participation deliberately ignores
 * `endpoint_*_deleted_at` (a survivor keeps reading its own DM), so a caller that
 * enumerates DELIVERY targets must conjoin a live principal row itself — which
 * `JOIN agents a` already does when the correlated column comes from that join
 * (#task:2021 P4-5).
 */
export function agentParticipatesCorrelated(
  conversationAlias: string,
  agentIdExpr: string,
): string {
  return agentParticipatesSql(conversationAlias, agentIdExpr);
}

/**
 * THE human roster read of the placement layer, and the only one — the same
 * shape and the same reason as {@link workspaceAgentRosterEdge}: the workspace
 * predicate is ANDed INSIDE the fragment so no caller can separate the gating
 * from the read, and Gate 9 pins it by TEXT so a second `conversation_users` /
 * `workspace_users` read anywhere in this file is countable rather than a matter
 * of reading nearby prose.
 *
 * TWO conjuncts, because human participation in a channel is two facts (v25):
 * the explicit `conversation_users` seat AND workspace membership. `permissions
 * .ts` applies exactly this pair (`canViewWorkspace` then `isConversationUser`),
 * and a SQL face that kept only the seat would admit a person who had been
 * removed from the workspace but whose channel row outlived the removal.
 *
 * NO EXPRESSION PARAMETER, unlike {@link workspaceAgentRosterEdge}, and the
 * asymmetry is caller-driven rather than an oversight: only AGENTS are ever
 * enumerated. Runtime delivery targets are agents by definition, so a
 * conversation's agent participants are read as a set, while the human rule is
 * only ever asked about ONE person (the write gate's actor, a thread-follower
 * candidate). A parameter whose every call site passes `'?'` is a seam with one
 * legal value — an abstraction pretending to a generality nothing asks for — so
 * this face binds the user id
 * directly and gains an expression the day a second reading actually exists.
 */
function workspaceHumanRosterEdge(conversationAlias: string): string {
  return `(${conversationAlias}.placement_kind = 'workspace'
            AND EXISTS (
              SELECT 1 FROM conversation_users cu_p
               WHERE cu_p.conversation_id = ${conversationAlias}.id
                 AND cu_p.user_id = ?
            )
            AND EXISTS (
              SELECT 1 FROM workspace_users wu_p
               WHERE wu_p.workspace_id = ${conversationAlias}.workspace_id
                 AND wu_p.user_id = ?
            ))`;
}

/**
 * SQL predicate: `userId` PARTICIPATES in this conversation (§4.2) — the human
 * face of {@link agentParticipates}, arm for arm:
 *
 *   - `workspace` — the two-fact roster edge above.
 *   - `direct_pair` — a `human` ENDPOINT naming this user. Rosterless by
 *     construction, so a stray `conversation_users` row on a DM is INERT here,
 *     exactly as a stray `conversation_agents` row is for the agent face. Whether
 *     the OTHER endpoint's principal still exists is not asked here either: that
 *     closes the WRITE gate, not participation.
 *   - `agent_inbox` — ABSENT, and its absence is the rule rather than a gap. A
 *     human is never a participant of an inbox, not even the person who created
 *     the agent: `agents.created_by_user_id` is MANAGEMENT authority, not a
 *     message ACL (the same wording shared's `resolveParticipation` carries). So
 *     this predicate is FALSE there by having no arm to be true in, which is why
 *     there is nothing to keep in sync with the code face.
 */
export function userParticipates(
  conversationAlias: string,
  userId: string,
): PlacementSqlFragment {
  return {
    sql: `(${workspaceHumanRosterEdge(conversationAlias)}
           OR (${conversationAlias}.placement_kind = 'direct_pair'
               AND ((${conversationAlias}.endpoint_a_kind = 'human'
                     AND ${conversationAlias}.endpoint_a_id = ?)
                 OR (${conversationAlias}.endpoint_b_kind = 'human'
                     AND ${conversationAlias}.endpoint_b_id = ?))))`,
    params: [userId, userId, userId, userId],
  };
}
