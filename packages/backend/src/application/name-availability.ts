import type { AgentRepo } from '../repos/agent-repo.js';
import type { UserRepo } from '../repos/user-repo.js';
import type { WorkspaceRepo } from '../repos/workspace-repo.js';

/**
 * Name-uniqueness predicates — the SINGLE source shared by the create paths
 * and the `name-availability` probe endpoints, so a create-form onBlur check
 * can never report a name "available" that the create path would reject
 * (searching / validation drift = false "available" → confusing failed create).
 *
 * These mirror the DB-enforced uniqueness exactly:
 *  - agents: `agents.name` UNIQUE + the agents/users cross-namespace triggers
 *  - workspaces: partial unique index `workspaces_regular_name_unique`
 */

/** Agent names live in the GLOBAL @-handle namespace shared with human users
 *  (DB: `agents.name` UNIQUE + `agents_name_unique_against_users` /
 *  `users_name_unique_against_agents` triggers). A name is available iff no
 *  agent AND no user already holds it — checking agents alone would report a
 *  name colliding with a human handle as "available", then create would trip
 *  the DB trigger. */
export function isAgentNameAvailable(
  deps: { agents: AgentRepo; users: UserRepo },
  name: string,
): boolean {
  return !deps.agents.getByName(name) && !deps.users.getByName(name);
}

/** Workspace names are unique among REGULAR workspaces (DB: partial unique
 *  index `workspaces_regular_name_unique`; DM / agent_home excluded).
 *  `WorkspaceRepo.getByName` already scopes to `workspace_kind = 'regular'`. */
export function isWorkspaceNameAvailable(
  deps: { workspaces: WorkspaceRepo },
  name: string,
): boolean {
  return !deps.workspaces.getByName(name);
}
