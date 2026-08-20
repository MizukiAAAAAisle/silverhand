/**
 * The agent-home (DM) workspace concept — the single source of truth for BOTH
 * ways of recognizing one: the id convention, and the ownership relation.
 *
 * An agent's "home" workspace (its DM workspace) has a deterministic id
 * derived from the agent id: `wsah_<agent_id>`. Two layers, with very
 * different breadth:
 *
 * - **The ID CONVENTION is load-bearing broadly.** It MINTS the row id
 *   (`workspace-repo.insertAgentHome`), rides the wire and the API
 *   (`agent_materialize`'s `agent_home_workspace_id`, `create-agent`'s
 *   payload), and is how every consumer RECOGNIZES an agent-home id
 *   structurally, without a `kind` or a path from the backend —
 *   `agent_workspace_index`, `agent_l2_seed`, the agent-fs source
 *   resolver, and `runtime_start` ref resolution (which also uses it to
 *   refuse a FOREIGN agent's home ref fail-closed).
 * - **Its FILESYSTEM CONSEQUENCE is the singular part.** Once an id is
 *   recognized as the owning agent's own home, coordinate resolution
 *   lands on the agent's L1 dir itself rather than on a nested
 *   `workspaces/<id>/` L2 bundle (`resolveAgentWorkspaceBaseDir`,
 *   `workspace-layout-relocation-v1.md` §3.2) — and `agent_materialize`
 *   returns that one dir as both `agent_dir` and
 *   `agent_home_workspace_path` (§6.5 invariant).
 *
 * That consequence is NOT a stored fact: relocation-v1 §3.4 retired the
 * `workspaces.workspace_path` column, so no workspace row carries the L1
 * dir and nothing server-side derives a path from this id.
 *
 * D4.e-1 (Cindy rev2 guard #2): the daemon's `agent_workspace_index`
 * handler must decide whether a `workspace_id` is a given agent's home
 * WITHOUT receiving a path or kind from the backend. It does so by
 * matching against this convention. Keeping the prefix + builder +
 * matcher here (not a hand-written string prefix in the handler) means
 * backend and daemon share one definition and a future rename touches one
 * place.
 */

export const AGENT_HOME_WORKSPACE_ID_PREFIX = 'wsah_';

/** Canonical agent-home workspace id for an agent: `wsah_<agentId>`. */
export function agentHomeWorkspaceId(agentId: string): string {
  return `${AGENT_HOME_WORKSPACE_ID_PREFIX}${agentId}`;
}

/**
 * The container row as this question needs it: an agent home is a workspace that
 * an agent OWNS, and ownership is the relation `owner_agent_id` — a real arc to
 * a real agent, not a word describing one.
 *
 * A structural parameter rather than `Pick<Workspace, …>` so that every shape
 * carrying the relation can ask (the repo row, the authorization port's fact
 * set, a transaction's coordinated facts) without those shapes having to agree
 * on one DTO — and so this module keeps depending on nothing.
 */
export interface AgentOwnedWorkspaceFacts {
  readonly owner_agent_id: string | null;
}

/**
 * Whether this container is some agent's private home.
 *
 * A TYPE GUARD, not a boolean, and that is load-bearing: "this is an agent home"
 * and "this row has a home agent id" are the same fact, so a caller that has
 * asked the question must not have to ask again to USE the id. The `agent_home`
 * creation path used to re-check `owner_agent_id` after the kind comparison and
 * raise a separate corruption error — two questions over one bit, where the
 * second could only fire for a row the schema forbids. Narrowing here deletes
 * that arm structurally instead of leaving a comment explaining why it never runs.
 *
 * WHICH AUTHORITY ANSWERS THIS, and when — the two are not interchangeable:
 *
 * - **Holding the row** (any server-side read point): the relation below. This
 *   is the authority, because ownership is what the concept IS.
 * - **Holding only ids** (`workspaceId` + `agentId`, e.g. the daemon's
 *   `agent_workspace_index` handler, which by construction receives neither a
 *   row nor a kind): {@link isAgentHomeWorkspaceId}, the id convention above.
 *
 * The two cannot disagree because one writer mints both facts in one statement:
 * `WorkspaceRepo.insertAgentHome` derives the id from
 * {@link agentHomeWorkspaceId} and writes `owner_agent_id` in the same INSERT.
 * That agreement is what lets a path-resolving consumer use the id form without
 * fetching a row, so it is pinned by a test rather than left to the reader.
 *
 * Deliberately NOT a comparison against a stored container word: a word is a
 * second spelling of this bit, and every read point that compares the word has
 * to know which spelling of it storage happens to use today. Also deliberately
 * not inlined as `owner_agent_id !== null` at ~29 call sites: that trades one
 * named domain question for N unnamed persistence details.
 */
export function isAgentHomeWorkspace<T extends AgentOwnedWorkspaceFacts>(
  workspace: T,
): workspace is T & { readonly owner_agent_id: string } {
  return workspace.owner_agent_id !== null;
}

/**
 * Whether this container is THIS agent's own home — the capability exemption's
 * question (`permissions.ts`), which is about identity and not just about which
 * kind of container this is: another agent's home must never be exempted.
 *
 * No `agentId.length > 0` guard, unlike {@link isAgentHomeWorkspaceId}: this form
 * compares the `owner_agent_id` FK column DIRECTLY, and a minted agent id is
 * never the empty string, so `agentId === ''` can never equal any stored
 * `owner_agent_id` — the guard could only ever be a no-op here. The id form needs
 * it because `agentHomeWorkspaceId('')` is the well-formed-looking `wsah_`, which
 * could collide with a malformed stored id; a column comparison has no such
 * degenerate value to defend against.
 */
export function isAgentHomeWorkspaceOf(
  workspace: AgentOwnedWorkspaceFacts,
  agentId: string,
): boolean {
  return workspace.owner_agent_id === agentId;
}

/**
 * Whether `workspaceId` is the agent-home workspace of `agentId`.
 *
 * EXACT match against the canonical id for THIS agent — never a loose
 * prefix test. A malformed `wsah_` (empty agent suffix) or a different
 * agent's home (`wsah_other`) must NOT be treated as this agent's home,
 * so the daemon can never resolve one agent's index entry to another
 * agent's L1 dir.
 */
export function isAgentHomeWorkspaceId(workspaceId: string, agentId: string): boolean {
  return agentId.length > 0 && workspaceId === agentHomeWorkspaceId(agentId);
}
