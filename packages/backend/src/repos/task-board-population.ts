// The human task board's POPULATION: which tasks exist for a given viewer +
// filter set. One definition, interpolated by every board face (the column
// window, the per-status counts, the filter facets) — so a page, a total, and a
// menu can never describe three subtly different sets. This is the same
// discipline as `repos/directed-claim-predicate.ts`: the load-bearing predicate
// is a named builder, not a WHERE clause copied per face and kept equal by
// test.
//
// Deliberately NOT shared with the agent CLI list (`TaskStore.list`'s agent
// branch): the two lanes have genuinely different visibility semantics (agent =
// placement participation of the actor agent; human = placement participation
// of the viewer) and different filter axes. What IS shared is the one semantic that
// must never drift — `userVisibleTaskPredicate` below, used by both this
// builder and `TaskStore.list`'s user branch.
//
// Every fragment assumes the `tasks` table is aliased `t`.
import type { TaskBoardPopulationFilters } from '../services/task/board.js';
import {
  conversationInContainer,
  userParticipates,
} from './conversation-placement-sql.js';

/** A composable SQL fragment plus its positional bind values, in order. */
export interface SqlFragment {
  sql: string;
  args: (string | number)[];
}

/**
 * Which tasks a HUMAN viewer may see: those whose OWNING CONVERSATION the viewer
 * PARTICIPATES in, by the ONE placement-participation authority
 * (`conversation-placement-sql.ts`) — the same gate the per-task ACL
 * (`isUserParticipant`) and the `task_changed` viewer fan-out
 * (`listParticipantUserIds`) use, so a task the board shows is exactly a task
 * the point read serves and the change event reaches. A human participates via
 * the workspace roster edge (a channel seat AND workspace membership) OR the
 * human endpoint of a DirectPair — two arms and no third, so a DM task is
 * visible to its endpoints without any `conversation_users` row (#task:2037).
 *
 * `userParticipates` correlates on the CONVERSATIONS table (placement_kind,
 * endpoints, workspace_id), and the board queries read `FROM tasks t` with no
 * conversation join, so the gate is an EXISTS over `conversations c` keyed by
 * `t.conversation_id`. It returns its OWN bind args (the participation
 * fragment's four viewer-id binds), so no call site hard-codes the arity.
 *
 * This is a semi-join, not a filter applied after reading: it must sit INSIDE
 * every board query so that pagination, totals and menus are all computed over
 * the viewer's own population. A visibility check applied after a LIMIT would
 * make `next_cursor` and the counts lie (a short page would not mean the end of
 * a column), which is precisely what authority-side filtering exists to remove.
 */
export function userVisibleTaskPredicate(viewerUserId: string): SqlFragment {
  const participates = userParticipates('c', viewerUserId);
  return {
    sql: `EXISTS (
    SELECT 1
      FROM conversations c
     WHERE c.id = t.conversation_id
       AND ${participates.sql}
  )`,
    args: [...participates.params],
  };
}

/**
 * Build the board population as a single AND-joined predicate. The viewer gate
 * is unconditional and comes first, so no filter combination can widen the
 * population; the remaining axes only ever narrow it.
 */
export function taskBoardPopulation(
  filters: TaskBoardPopulationFilters,
): SqlFragment {
  const gate = userVisibleTaskPredicate(filters.viewerUserId);
  const clauses: string[] = [gate.sql];
  const args: (string | number)[] = [...gate.args];

  if (filters.workspaceId !== undefined) {
    clauses.push('t.workspace_id = ?');
    args.push(filters.workspaceId);
  }
  if (filters.channelId !== undefined) {
    clauses.push('t.conversation_id = ?');
    args.push(filters.channelId);
  }
  if (filters.container !== undefined) {
    // The board's TOP-LEVEL container axis (#task:2041): the bare state of one
    // of `Workspace | Agent Space | Direct Messages` — ALL of that container at
    // once, which is exactly what `workspaceId` (one workspace) and `channelId`
    // (one conversation) cannot express. The taxonomy is a semi-join over the
    // task's owning conversation, owned by ONE authority
    // (`conversationInContainer`) so the board, the drawer, and any future face
    // read the same container definition. It carries no binds — the axis value
    // is a closed enum resolved to literal SQL there — so `args` is untouched.
    clauses.push(conversationInContainer('t.conversation_id', filters.container));
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
