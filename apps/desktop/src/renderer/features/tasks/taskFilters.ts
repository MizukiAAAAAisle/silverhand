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

import type { TaskBoardContainer as TaskBoardContainerAxis } from '@silverhand/shared';

export type { TaskBoardContainerAxis };

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
  /** The board's TOP-LEVEL container axis (#task:2041): which KIND of
   *  container a task's owning conversation sits in —
   *  `workspace | agent_space | direct_messages`. null = the All tab: no
   *  container narrowing, the union of every container the viewer can see
   *  (DM tasks included). This is the coarsest axis and stacks with
   *  `workspaceId` / `channelId` as an INTERSECTION on the wire — picking
   *  `agent_space` then a specific workspace narrows to that one Agent Space.
   *  Unlike the within-board axes, it is also the SOLE input to the facet
   *  menus (the option sets describe the container you are on), so it is the
   *  one narrowing that legitimately reshapes those menus. */
  container: TaskBoardContainerAxis | null;
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
  container: null,
  workspaceId: null,
  channelId: null,
  assignee: { kind: 'any' },
  creator: { kind: 'any' },
};

/** Structural equality across all dimensions — drives the "filters differ
 *  from baseline" check (show Clear, reset target). */
export function taskFiltersEqual(a: TaskFilters, b: TaskFilters): boolean {
  return (
    a.container === b.container &&
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

/**
 * The four-state container axis (#task:2041), closed as ONE pure model shared by
 * the board and the drawer. `null` = All (the union of every container the
 * viewer can see); the three concrete values narrow to one KIND of container.
 * Two pure faces, so the whole "container × option domain × transition" matrix
 * is falsifiable without a DOM:
 *   - `containerScope` — which secondary controls a container offers and over
 *     which option population (the per-container option DOMAIN);
 *   - `applyContainerSwitch` — the transition that drops a workspace/channel
 *     coordinate the new container cannot hold.
 *
 * The membership rule is single-sourced here and read by BOTH faces: a workspace
 * of `kind:'regular'` lives under `workspace`, `kind:'dm'` (an agent home) under
 * `agent_space`; a channel's data-source `group` mirrors that; a viewer
 * DirectPair conversation lives under `direct_messages` and carries no workspace
 * coordinate at all (its board is the pair, matched by the `channel_id` param).
 */

/** The container a workspace of this kind belongs to. */
export function workspaceKindContainer(
  kind: 'regular' | 'dm',
): Extract<TaskBoardContainerAxis, 'workspace' | 'agent_space'> {
  return kind === 'dm' ? 'agent_space' : 'workspace';
}

/** The container a channel of this data-source group belongs to. */
export function channelGroupContainer(
  group: 'dm' | 'workspace',
): Extract<TaskBoardContainerAxis, 'workspace' | 'agent_space'> {
  return group === 'dm' ? 'agent_space' : 'workspace';
}

/** Is a coordinate whose own container is `member` offerable / holdable under
 *  the board's current `container` axis? All (`null`) holds every container; a
 *  concrete container holds only coordinates of its own kind. `member === null`
 *  (an unresolved coordinate whose container we can't name) is held only by All,
 *  so a concrete container never keeps a coordinate it can't vouch for. */
export function containerHolds(
  container: TaskBoardContainerAxis | null,
  member: TaskBoardContainerAxis | null,
): boolean {
  return container === null || member === container;
}

/** The secondary controls a container offers, over the option population it
 *  scopes them to. Generic over the option shapes (the concrete types live in
 *  the filter bar) so this model module stays dependency-free and unit-testable
 *  on plain literals. */
export interface ContainerScope<W, C, P> {
  /** Show the upstream workspace cascade control. */
  showWorkspace: boolean;
  /** Show the channel picker. */
  showChannel: boolean;
  /** Show the DirectPair 对端 leaf — it REPLACES the channel picker under DM. */
  showDirectPair: boolean;
  workspaceOptions: W[];
  channelOptions: C[];
  directPairOptions: P[];
}

/**
 * The per-container option DOMAIN + which controls describe it. One of the two
 * pure faces of the container model (see the block above).
 *
 *  - `direct_messages` — a DM has no workspace/channel coordinate, so the 对端
 *    leaf (→ `channel_id` = the pair conversation) is the ONLY narrowing. The
 *    workspace + channel controls are HIDDEN, not fed an empty set: an empty
 *    option list reads as "no channels", a different (false) claim than "this
 *    axis does not apply here";
 *  - `workspace` / `agent_space` — narrow the workspace + channel populations to
 *    that KIND (a regular workspace vs. an agent home); the DM leaf is never
 *    offered here (you pick the container first, then the pair);
 *  - `null` (All) — the full union of both, and still no DM leaf: All is the
 *    union of every container, narrowed by picking one.
 */
export function containerScope<
  W extends { kind: 'regular' | 'dm' },
  C extends { group: 'dm' | 'workspace' },
  P,
>(
  container: TaskBoardContainerAxis | null,
  source: { workspaceOptions: W[]; channelOptions: C[]; directPairOptions: P[] },
): ContainerScope<W, C, P> {
  if (container === 'direct_messages') {
    return {
      showWorkspace: false,
      showChannel: false,
      showDirectPair: true,
      workspaceOptions: [],
      channelOptions: [],
      directPairOptions: source.directPairOptions,
    };
  }
  const workspaceOptions =
    container === null
      ? source.workspaceOptions
      : source.workspaceOptions.filter(
          o => workspaceKindContainer(o.kind) === container,
        );
  const channelOptions =
    container === null
      ? source.channelOptions
      : source.channelOptions.filter(
          o => channelGroupContainer(o.group) === container,
        );
  return {
    showWorkspace: true,
    showChannel: true,
    showDirectPair: false,
    workspaceOptions,
    channelOptions,
    directPairOptions: [],
  };
}

/** Resolve a selected coordinate to the container it belongs to (null when the
 *  option source no longer holds it). Injected so `applyContainerSwitch` is pure
 *  and unit-testable without the option source — the same shape
 *  `applyWorkspaceCascade` uses for `channelWorkspaceId`. */
export interface ContainerMembership {
  workspaceContainer: (workspaceId: string) => TaskBoardContainerAxis | null;
  channelContainer: (channelId: string) => TaskBoardContainerAxis | null;
}

/**
 * Does the target container render a VISIBLE, clearable control for a coordinate
 * whose own container is `member`? Retention on a container switch must answer
 * THIS, not merely "does the axis semantically belong": the board may carry only
 * coordinates the current container's UI can both show as selected AND let the
 * user clear. A coordinate the target holds semantically but renders no control
 * for is worse than useless — it silently narrows the wire request (`channel_id`)
 * while the UI shows a different, wider container.
 *
 *  - `member === null` — unresolvable against the current option source; no
 *    control can display a coordinate we cannot even name, so it is never kept
 *    (not even by All);
 *  - `member === 'direct_messages'` — a pair id is shown ONLY by the DM 对端 leaf,
 *    which exists solely under `direct_messages`. Kept there and NOWHERE else:
 *    under All the channel picker lists workspace/agent_space channels and the DM
 *    leaf is hidden (`containerScope(null).showDirectPair === false`), so a
 *    retained pair id would be an invisible narrowing — the All-shows-a-DM bug;
 *  - `workspace` / `agent_space` — shown by the workspace cascade + channel
 *    picker, which All and the matching concrete container render, so
 *    `containerHolds` (All ∪ own-kind) is exactly the right test.
 */
function containerShowsCoordinateOf(
  nextContainer: TaskBoardContainerAxis | null,
  member: TaskBoardContainerAxis | null,
): boolean {
  if (member === null) return false;
  if (member === 'direct_messages') return nextContainer === 'direct_messages';
  return containerHolds(nextContainer, member);
}

/**
 * The container-axis transition — the second pure face of the model. Switching
 * container DROPS a workspace/channel coordinate the new container has no VISIBLE
 * control for, so the board never carries an orphan narrowing the user can
 * neither see selected nor clear (which silently narrows the wire request while
 * the UI shows a wider container, and usually empties the board).
 *
 * Retention is decided by `containerShowsCoordinateOf`, NOT by "All holds
 * everything": All holds a DirectPair semantically but renders no control for it
 * (the channel picker lists workspace/agent_space channels; the DM leaf is
 * hidden), so a pair id is dropped on the way to All. The ws↔channel consistency
 * the cascade guarantees is preserved because both coordinates are filtered
 * against the SAME target container.
 */
export function applyContainerSwitch(
  filters: TaskFilters,
  nextContainer: TaskBoardContainerAxis | null,
  membership: ContainerMembership,
): TaskFilters {
  const workspaceId =
    filters.workspaceId !== null &&
    containerShowsCoordinateOf(
      nextContainer,
      membership.workspaceContainer(filters.workspaceId),
    )
      ? filters.workspaceId
      : null;
  const channelId =
    filters.channelId !== null &&
    containerShowsCoordinateOf(
      nextContainer,
      membership.channelContainer(filters.channelId),
    )
      ? filters.channelId
      : null;
  return { ...filters, container: nextContainer, workspaceId, channelId };
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
