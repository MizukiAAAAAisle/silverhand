/**
 * Agent-home (DM) workspace id convention — the single source of truth.
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
