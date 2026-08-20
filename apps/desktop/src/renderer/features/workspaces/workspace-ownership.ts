/**
 * The one question the renderer asks about a workspace container's identity:
 * does it belong to an agent? (#task:2078, parent #task:2075.)
 *
 * `workspace_kind` was never independent data — the schema pinned the kind word to
 * this same relation (`owner_agent_id IS NOT NULL`), so the renderer had two
 * spellings of one fact and no way to prove a surface read the one the server
 * would agree with. The kind word is gone (#task:2080 dropped the column);
 * ownership is what stays.
 *
 * WHY A PREDICATE AND NOT A BARE `!== null` AT EACH READ POINT (@Paul, #task:2075
 * 判据②): `owner_agent_id` also answers a second, narrower question — "which
 * agent's avatar do I draw" — and that one legitimately reads the id itself. A
 * bare nullability check at a CLASSIFYING read point is indistinguishable from
 * that, so the two would drift: someone would "simplify" a grouping arm into an
 * avatar lookup and the row would silently change groups whenever the directory
 * had not resolved the agent. Grouping asks this function; only identity
 * rendering touches the id.
 *
 * NOTHING LEFT TO DECODE (the terminal state #task:2070 §B3 aimed at). The stored
 * word (`agent_home`) never reaches the renderer, and since this ticket neither
 * does the published one: the local `WorkspaceUiKind` alias went out with its last
 * consumer, so no expression under `src/renderer` can produce a container-kind
 * token at all. A same-shaped local union re-declared "for readability" brings the
 * subset drift straight back (@Paul, #task:2069) — the axis is this file. The one
 * container word the renderer still mints is the rail's SORT SCOPE
 * (`./rail-sort-group.ts`), which is storage, not this question.
 *
 * A ZERO-IMPORT LEAF on purpose. The parameter is structural, so the SAME
 * predicate serves the domain object (`WorkspaceListItem`) and the wire refs that
 * carry ownership (`SearchWorkspaceRef` since #task:2075 A1, `ActivityWorkspaceRef`)
 * — one definition means a search result row and a rail row cannot classify the
 * same workspace differently. Importing `./hooks` for its type would also close a
 * module-init cycle (see `workspace-scoped-query.ts`).
 */
export interface WorkspaceOwnership {
  owner_agent_id: string | null;
}

/**
 * Whether this container is an Agent Space — an agent's own workspace, created
 * with the agent and named after it.
 *
 * "Agent Spaces" remains the product word on every surface (group headers,
 * filter arms, the task board's container tab). That word is PRESENTATION: it is
 * produced from this boolean, never parsed back into a kind token, so the
 * renderer keeps exactly one authority for the distinction (#task:2075 判据④).
 */
export function isAgentSpace(workspace: WorkspaceOwnership): boolean {
  return workspace.owner_agent_id !== null;
}
