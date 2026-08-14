/**
 * Unified task-filter model shared by the global Tasks board
 * (TasksSection) and the workspace drawer (WorkspaceTasksDrawer).
 *
 * Design (shiki + Cindy, #task:769 / #task:770): the kanban columns
 * express ONLY the status dimension (Todo / In progress / In review /
 * Done / Closed — `closed` is a terminal status, not a separate
 * visibility axis); every other narrowing — channel, assignee, creator —
 * lives in one TaskFilterBar.
 *
 * This module is now the filter MODEL only: the UI's vocabulary for a
 * narrowing, plus the pure transitions over it (equality, the
 * workspace→channel cascade). Applying a narrowing is the SERVER's job —
 * `boardQuery` maps this model onto the `/api/tasks/board/*` params, and the
 * board reads back a bounded window per column (#task:1884 / #task:1885). The
 * client-side `applyTaskFilters` / `collectAssignees` / `collectCreators` that
 * used to live here were retired with the fetch-all list they sliced
 * (#task:1892): filtering a full download cannot be bounded, and person
 * options aggregated from the rows in hand shrink to whatever page the viewer
 * happened to load.
 */

/** A person reference keyed by `{type,id}` — id alone is unsafe because
 *  agent and user ids share no namespace guarantee (Cindy boundary). */
export type PersonRef =
  | { type: 'agent'; id: string }
  | { type: 'user'; id: string };

/** Assignee/creator filter value. `unassigned` is meaningful for the
 *  assignee axis only (a task always has a creator). */
export type PersonFilter =
  | { kind: 'any' }
  | { kind: 'unassigned' }
  | { kind: 'person'; person: PersonRef };

export interface TaskFilters {
  /** Workspace id to narrow to — the UPSTREAM axis of the workspace→channel
   *  cascade (shiki #task:1387). null = no workspace narrowing. The channel
   *  filter's option set is scoped to this workspace, and switching workspace
   *  drops a channel selection that no longer belongs to it (see
   *  `applyWorkspaceCascade`). Matched by the workspace arm's
   *  `task.board.workspace_id` — no
   *  surface predicate needed, workspace identity isn't thread-aware. */
  workspaceId: string | null;
  /** Conversation id to narrow to — a channel id (matches that channel and
   *  all its threads) or a thread id (matches only that thread). null = no
   *  channel narrowing. Both surfaces read ONE cross-workspace board
   *  (#task:1165), and the match is now the server's `channel_id` param
   *  (`boardQuery.boardFilterParams`) rather than a per-surface predicate —
   *  a narrowing the server applies is the same for every surface by
   *  construction, and it is what lets a column stay a bounded window. */
  channelId: string | null;
  assignee: PersonFilter;
  creator: PersonFilter;
}

export const DEFAULT_TASK_FILTERS: TaskFilters = {
  workspaceId: null,
  channelId: null,
  assignee: { kind: 'any' },
  creator: { kind: 'any' },
};

/** Structural equality across all dimensions — drives the "filters differ
 *  from baseline" check (show Clear, reset target). */
export function taskFiltersEqual(a: TaskFilters, b: TaskFilters): boolean {
  return (
    a.workspaceId === b.workspaceId &&
    a.channelId === b.channelId &&
    personFilterKey(a.assignee) === personFilterKey(b.assignee) &&
    personFilterKey(a.creator) === personFilterKey(b.creator)
  );
}

/**
 * Workspace→channel cascade (shiki #task:1387). When the workspace filter
 * changes, a channel selection that no longer belongs to the new workspace is
 * dropped back to "all channels" — never leave an orphan channel that would
 * yield an empty board (Cindy invariant). Selecting "All workspaces"
 * (`nextWorkspaceId === null`) keeps any channel, since the channel filter is
 * then unconstrained.
 *
 * `channelWorkspaceId` resolves a channel id to its owning workspace id (null
 * if unknown). Pure so the cascade is unit-testable without the option source.
 */
export function applyWorkspaceCascade(
  filters: TaskFilters,
  nextWorkspaceId: string | null,
  channelWorkspaceId: (channelId: string) => string | null,
): TaskFilters {
  if (nextWorkspaceId === null) {
    return { ...filters, workspaceId: null };
  }
  const keepChannel =
    filters.channelId !== null &&
    channelWorkspaceId(filters.channelId) === nextWorkspaceId;
  return {
    ...filters,
    workspaceId: nextWorkspaceId,
    channelId: keepChannel ? filters.channelId : null,
  };
}

/** One selectable person in the assignee / creator menus. The `name` is the
 *  denormalized snapshot the server already put on the row (no profile lookup —
 *  Cindy boundary); the option SETS themselves are a server facet read
 *  (`/api/tasks/board/facets`), so they never shrink to the rows a surface
 *  happens to hold. */
export interface PersonOption {
  person: PersonRef;
  name: string;
}

export function personFilterKey(f: PersonFilter): string {
  if (f.kind === 'person') return `${f.person.type}:${f.person.id}`;
  return f.kind;
}
