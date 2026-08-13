// The human task board's POPULATION: which tasks exist for a given viewer +
// filter set. One definition, interpolated by every board face (the column
// window, the per-status counts, the filter facets) — so a page, a total, and a
// menu can never describe three subtly different sets. This is the same
// discipline as `repos/directed-claim-predicate.ts`: the load-bearing predicate
// is a named constant, not a WHERE clause copied per face and kept equal by
// test.
//
// Deliberately NOT shared with the agent CLI list (`TaskStore.list`'s agent
// branch): the two lanes have genuinely different visibility semantics (agent =
// workspace equality derived from the actor's conversation; human = per-row
// membership) and different filter axes. What IS shared is the one semantic that
// must never drift — `USER_VISIBLE_TASK_PREDICATE` below, used by both this
// builder and `TaskStore.list`'s user branch.
//
// Every fragment assumes the `tasks` table is aliased `t`.
import type { TaskBoardPopulationFilters } from '../services/task/board.js';

/**
 * Which tasks a HUMAN viewer may see: those whose owning conversation the
 * viewer is a member of. Exactly ONE bind parameter — the viewer's user id.
 *
 * This is a semi-join, not a filter applied after reading: it must sit INSIDE
 * every board query so that pagination, totals and menus are all computed over
 * the viewer's own population. A visibility check applied after a LIMIT would
 * make `next_cursor` and the counts lie (a short page would not mean the end of
 * a column), which is precisely what authority-side filtering exists to remove.
 */
export const USER_VISIBLE_TASK_PREDICATE = `EXISTS (
    SELECT 1
      FROM conversation_users cu
     WHERE cu.conversation_id = t.conversation_id
       AND cu.user_id = ?
  )`;

/** A composable SQL fragment plus its positional bind values, in order. */
export interface SqlFragment {
  sql: string;
  args: (string | number)[];
}

/**
 * Build the board population as a single AND-joined predicate. The viewer gate
 * is unconditional and comes first, so no filter combination can widen the
 * population; the remaining axes only ever narrow it.
 */
export function taskBoardPopulation(
  filters: TaskBoardPopulationFilters,
): SqlFragment {
  const clauses: string[] = [USER_VISIBLE_TASK_PREDICATE];
  const args: (string | number)[] = [filters.viewerUserId];

  if (filters.workspaceId !== undefined) {
    clauses.push('t.workspace_id = ?');
    args.push(filters.workspaceId);
  }
  if (filters.channelId !== undefined) {
    clauses.push('t.conversation_id = ?');
    args.push(filters.channelId);
  }
  if (filters.assignee !== undefined) {
    if (filters.assignee.type === 'unassigned') {
      clauses.push('t.assignee_agent_id IS NULL AND t.assignee_user_id IS NULL');
    } else if (filters.assignee.type === 'agent') {
      clauses.push('t.assignee_agent_id = ?');
      args.push(filters.assignee.id);
    } else {
      clauses.push('t.assignee_user_id = ?');
      args.push(filters.assignee.id);
    }
  }
  if (filters.creator !== undefined) {
    if (filters.creator.type === 'agent') {
      clauses.push("t.creator_kind = 'agent' AND t.creator_agent_id = ?");
    } else {
      clauses.push("t.creator_kind = 'user' AND t.creator_user_id = ?");
    }
    args.push(filters.creator.id);
  }

  return { sql: clauses.join('\n    AND '), args };
}
