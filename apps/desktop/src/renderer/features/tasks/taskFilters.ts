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
import {
  isAgentSpace,
  type WorkspaceOwnership,
} from '@/features/workspaces/workspace-ownership';

export type { TaskBoardContainerAxis };

/** Which data source a channel option came from — the PRESENTATION axis the
 *  channel dropdown sections on, named once here so the three consumers cannot
 *  drift (#task:2066). Not a stored key: the filter value stays a channel id. */
export type ChannelSourceGroup = 'agent_space' | 'workspace';

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
   *  `task.place.workspace_id` — no
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
 * The container axis (#task:2041), closed as ONE pure model shared by the board
 * and the drawer. `null` = All (the union of every container the viewer can see);
 * the three concrete values narrow to one KIND of container. Two pure faces, so
 * the whole "container × channel axis × selection" matrix is falsifiable without
 * a DOM:
 *   - `applyBoardScopeSelection` — the transition that sets the container AND its
 *     concrete coordinate together from one grouped-dropdown pick (shiki
 *     2026-08-17: the container kind and the object it narrows to are one choice,
 *     not a pick-kind-then-object two-step). The grouped dropdown lists the
 *     workspace / agent-space OBJECTS directly (never a direct line — DM is not a
 *     selectable global scope, contract §5), so the only within-board axis the
 *     container still reshapes is the channel picker;
 *   - `channelAxisScope` — whether that channel picker applies under a container,
 *     and over which channel population.
 *
 * The membership rule is single-sourced here: a people-owned workspace lives
 * under `workspace`, an agent space under `agent_space`; a channel's data-source
 * `group` mirrors that. The `direct_messages` container is
 * never picked from the scope dropdown — it exists only as the pinned baseline of
 * a direct line's own (locked) Tasks drawer, where its coordinate is the pair
 * conversation (matched by the `channel_id` param) and no workspace is minted.
 */

/**
 * The board container a workspace belongs to.
 *
 * The QUESTION is ownership (#task:2078) — the container kind this used to read
 * is retired. The ANSWER is untouched on purpose: `'agent_space'` here is a
 * member of the BOARD axis's own alphabet (`TaskBoardContainerSchema`, a wire
 * value that travels to `/api/tasks/board/*`), which merely shares a spelling
 * with the retired container kind. Two axes, one word: retiring the kind does
 * not retire this token, so nothing about the return value moves.
 */
export function workspaceBoardContainer(
  workspace: WorkspaceOwnership,
): Extract<TaskBoardContainerAxis, 'workspace' | 'agent_space'> {
  return isAgentSpace(workspace) ? 'agent_space' : 'workspace';
}

/** The container a channel of this data-source group belongs to. */
export function channelGroupContainer(
  group: ChannelSourceGroup,
): Extract<TaskBoardContainerAxis, 'workspace' | 'agent_space'> {
  return group === 'agent_space' ? 'agent_space' : 'workspace';
}

/** Whether the within-workspace channel axis applies under a container, and over
 *  which channel population. Generic over the channel option shape (the concrete
 *  type lives in the filter bar) so this model module stays dependency-free and
 *  unit-testable on plain literals. */
export interface ChannelAxisScope<C> {
  /** Show the channel picker (false under `direct_messages`). */
  show: boolean;
  /** The channels this container offers (empty under `direct_messages`). */
  channelOptions: C[];
}

/**
 * The channel axis under a container — one of the two pure faces of the container
 * model (see the block above). After the board-scope collapse (#task:2041) the
 * workspace + agent-space OBJECTS are listed directly by the grouped dropdown from
 * the full option sets, so the container model's only remaining projection is the
 * channel picker:
 *
 *  - `direct_messages` — a DM's coordinate is the pair conversation (→ the
 *    `channel_id` param), not a channel, so the channel picker is HIDDEN, not fed
 *    an empty set: an empty option list reads as "no channels", a different
 *    (false) claim than "this axis does not apply here". (In practice a
 *    direct_messages board is only ever the locked DM drawer, which hides the
 *    whole scope + channel row anyway; this keeps the pure model honest for the
 *    one value that reaches it.)
 *  - `workspace` / `agent_space` — narrow the channel population to that KIND (a
 *    regular workspace's channels vs. an agent home's);
 *  - `null` (All) — every channel the viewer can see.
 */
export function channelAxisScope<C extends { group: ChannelSourceGroup }>(
  container: TaskBoardContainerAxis | null,
  channelOptions: C[],
): ChannelAxisScope<C> {
  if (container === 'direct_messages') {
    return { show: false, channelOptions: [] };
  }
  return {
    show: true,
    channelOptions:
      container === null
        ? channelOptions
        : channelOptions.filter(o => channelGroupContainer(o.group) === container),
  };
}

/**
 * The board-scope selection — one grouped-dropdown pick that names both the
 * container KIND and the concrete object inside it, collapsing the old
 * pick-container-then-object two-step into a single choice (#task:2041, shiki
 * 2026-08-17). A workspace / agent-space pick carries its own container so the
 * two are set together. There is no `direct_pair` pick: a DM is never a selectable
 * scope in the global board (contract §5) — the "All" tab already covers DM tasks
 * in its union, and a specific direct line is narrowed to only from inside its own
 * (locked) Tasks drawer, where the scope trigger is hidden entirely.
 */
export type BoardScopeSelection =
  | { kind: 'all' }
  | {
      kind: 'workspace';
      workspaceId: string;
      container: Extract<TaskBoardContainerAxis, 'workspace' | 'agent_space'>;
    };

/**
 * Apply a board-scope pick — the second pure face of the model — setting the
 * container axis AND its concrete coordinate together. Every pick lands on a
 * fully-resolved scope, so there is no orphan-coordinate transition to repair
 * afterward; the only cleanup is the workspace cascade dropping a coordinate the
 * pick strands:
 *   - `all` — clear the container and every coordinate (the union tab, DM tasks
 *     included);
 *   - `workspace` — run the workspace→channel cascade (so a channel that no
 *     longer belongs to the picked workspace is dropped) and stamp the
 *     workspace's own container.
 *
 * `channelWorkspaceId` resolves a channel id to its owning workspace (null if
 * unknown) — the same injected resolver `applyWorkspaceCascade` takes, so this
 * stays pure and unit-testable without the option source.
 */
export function applyBoardScopeSelection(
  filters: TaskFilters,
  selection: BoardScopeSelection,
  channelWorkspaceId: (channelId: string) => string | null,
): TaskFilters {
  switch (selection.kind) {
    case 'all':
      return { ...filters, container: null, workspaceId: null, channelId: null };
    case 'workspace':
      return {
        ...applyWorkspaceCascade(filters, selection.workspaceId, channelWorkspaceId),
        container: selection.container,
      };
  }
}

/** One section of the board-scope dropdown: the workspaces it lists (regular
 *  workspaces under "Workspaces", agent homes under "Agent Spaces"). Generic over
 *  the concrete option shape — that lives in the filter bar — so the
 *  classification stays in this model module. Direct Messages are not a section:
 *  a DM is never a selectable global scope (contract §5). */
export interface BoardScopeGroup<W> {
  key: 'workspaces' | 'agent-spaces';
  label: string;
  workspaces: readonly W[];
}

/**
 * Classify the board-scope dropdown's sections (#task:2041) — the third pure face
 * of the container model, so "which workspace goes in which section, and when does
 * a section show" is falsifiable without a DOM (the whole classification used to be
 * inlined in the filter bar's `useMemo`, where deleting a section or mis-routing a
 * workspace stayed green — @Cindy).
 *
 * The people-owned vs agent-space split reuses {@link workspaceBoardContainer}, the
 * SAME taxonomy the wire axis uses, so a workspace can never land in a section that
 * disagrees with the container its pick stamps. A section shows iff it has
 * objects: an answered-empty section is simply absent. Direct Messages are not
 * offered here (contract §5) — the coarsest axis's only selectable objects are
 * workspaces and agent spaces; DM tasks reach the board through the "All" union or
 * their own locked drawer.
 */
export function boardScopeGroups<W extends WorkspaceOwnership>(input: {
  workspaces: readonly W[];
}): Array<BoardScopeGroup<W>> {
  const inContainer = (
    container: Extract<TaskBoardContainerAxis, 'workspace' | 'agent_space'>,
  ): readonly W[] => input.workspaces.filter(w => workspaceBoardContainer(w) === container);
  const defs: Array<BoardScopeGroup<W>> = [
    { key: 'workspaces', label: 'Workspaces', workspaces: inContainer('workspace') },
    { key: 'agent-spaces', label: 'Agent Spaces', workspaces: inContainer('agent_space') },
  ];
  return defs.filter(g => g.workspaces.length > 0);
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
