/**
 * Agent-home (DM) workspace id convention — the single source of truth.
 *
 * An agent's "home" workspace (its DM workspace) has a deterministic id
 * derived from the agent id: `wsah_<agent_id>`. This coincidence is
 * load-bearing across the system: the DM workspace's `workspace_path` IS
 * the agent's L1 dir (`docs/agent-system-prompt-memory.md`, CLAUDE.md §3),
 * and `agent_materialize` returns that path as both `agent_dir` and
 * `agent_home_workspace_path` (§6.5 invariant).
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
