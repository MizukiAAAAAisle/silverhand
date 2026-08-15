import type { AgentRepo } from '../repos/agent-repo.js';
import type { UserRepo } from '../repos/user-repo.js';
import type { WorkspaceRepo } from '../repos/workspace-repo.js';
import type { CanonicalWorkspaceName } from '@silverhand/shared';

/**
 * Name-uniqueness predicates — the SINGLE source shared by the create paths
 * and the `name-availability` probe endpoints, so a create-form onBlur check
 * can never report a name "available" that the create path would reject
 * (searching / validation drift = false "available" → confusing failed create).
 *
 * These mirror the DB-enforced uniqueness exactly:
 *  - agents: `agents.name` UNIQUE + the agents/users cross-namespace triggers
 *  - workspaces: partial unique index `idx_workspaces_name_key`
 */

/** Participant handles live in ONE global @-handle namespace shared by agents
 *  and human users (DB: `agents.name` UNIQUE + `users.name` UNIQUE +
 *  `agents_name_unique_against_users` / `users_name_unique_against_agents`
 *  triggers). A handle is available iff no agent AND no user already holds it —
 *  checking one table alone would report a colliding handle as "available" and
 *  then trip the DB trigger at create time.
 *
 *  The predicate is scoped to the NAMESPACE, not to the kind of actor being
 *  created: agent creation, the agent-name probe endpoint, and password signup's
 *  user handle (#task:1830) all ask the same question and must not drift apart. */
export function isParticipantHandleAvailable(
  deps: { agents: AgentRepo; users: UserRepo },
  name: string,
): boolean {
  return !deps.agents.getByName(name) && !deps.users.getByName(name);
}

/** Workspace names are unique by canonical folded key among REGULAR workspaces
 *  (DB: partial unique index `idx_workspaces_name_key`; agent_home excluded).
 *  `WorkspaceRepo.getByName` already scopes to `workspace_kind = 'regular'`. */
export function isWorkspaceNameAvailable(
  deps: { workspaces: WorkspaceRepo },
  name: string | CanonicalWorkspaceName,
): boolean {
  return !deps.workspaces.getByName(name);
}
