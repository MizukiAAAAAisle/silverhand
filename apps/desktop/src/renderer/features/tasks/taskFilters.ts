import type { TaskSummaryDto } from '@silverhand/shared';

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
 * Filtering is entirely CLIENT-SIDE here: `TaskSummaryDto` already carries
 * `channel_id` / `thread_id` / `assignee` / `creator`, lists are
 * unpaginated, and each surface fetches-broadly-then-slices — so no
 * backend query change is needed. Backend `creator_type/creator_id` +
 * assignee `{type,id}` params are a later perf optimization once task
 * volume demands it (the inflection point, not this PR).
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
  /** Surface-specific id (global → workspace id; drawer → conversation
   *  id, i.e. a channel or thread). null = no channel narrowing. The
   *  match semantics differ per surface, so callers pass a `matchChannel`
   *  predicate to `applyTaskFilters` rather than baking channel logic in
   *  here (Cindy boundary: don't flatten workspace/channel vs
   *  conversation/thread into one plane). */
  channelId: string | null;
  assignee: PersonFilter;
  creator: PersonFilter;
}

export const DEFAULT_TASK_FILTERS: TaskFilters = {
  channelId: null,
  assignee: { kind: 'any' },
  creator: { kind: 'any' },
};

/** Structural equality across all dimensions — drives the "filters differ
 *  from baseline" check (show Clear, reset target). */
export function taskFiltersEqual(a: TaskFilters, b: TaskFilters): boolean {
  return (
    a.channelId === b.channelId &&
    personFilterKey(a.assignee) === personFilterKey(b.assignee) &&
    personFilterKey(a.creator) === personFilterKey(b.creator)
  );
}

function matchPerson(
  filter: PersonFilter,
  person: { type: string; id: string | null } | null,
): boolean {
  if (filter.kind === 'any') return true;
  if (filter.kind === 'unassigned') return person == null;
  if (person == null) return false;
  return person.type === filter.person.type && person.id === filter.person.id;
}

/**
 * Apply the client-side dimensions (channel / assignee / creator) to a
 * task list.
 *
 * `matchChannel` is supplied by each surface so channel semantics stay
 * surface-correct: the global board matches by workspace, the drawer
 * matches a channel plus all its threads.
 */
export function applyTaskFilters(
  tasks: TaskSummaryDto[],
  filters: TaskFilters,
  matchChannel: (task: TaskSummaryDto, channelId: string) => boolean,
): TaskSummaryDto[] {
  return tasks.filter(task => {
    if (filters.channelId && !matchChannel(task, filters.channelId)) {
      return false;
    }
    if (
      !matchPerson(
        filters.assignee,
        task.assignee ? { type: task.assignee.type, id: task.assignee.id } : null,
      )
    ) {
      return false;
    }
    if (
      filters.creator.kind !== 'any' &&
      !matchPerson(filters.creator, { type: task.creator.type, id: task.creator.id })
    ) {
      return false;
    }
    return true;
  });
}

export interface PersonOption {
  person: PersonRef;
  name: string;
}

/**
 * Aggregate distinct assignees from a fetched task list — the ONLY
 * candidate source for the assignee filter (no profile lookup; use the
 * denormalized `name`/`id` already on the dto, per Cindy boundary).
 * Sorted by name for stable menu order.
 */
export function collectAssignees(tasks: TaskSummaryDto[]): PersonOption[] {
  const seen = new Map<string, PersonOption>();
  for (const t of tasks) {
    if (!t.assignee) continue;
    const key = `${t.assignee.type}:${t.assignee.id}`;
    if (!seen.has(key)) {
      seen.set(key, {
        person: { type: t.assignee.type, id: t.assignee.id },
        name: t.assignee.name,
      });
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Aggregate distinct creators from a fetched task list. `system` creators
 * (and any with a null id) are skipped — they aren't a selectable person.
 */
export function collectCreators(tasks: TaskSummaryDto[]): PersonOption[] {
  const seen = new Map<string, PersonOption>();
  for (const t of tasks) {
    const { type, id, name } = t.creator;
    if (id == null || (type !== 'agent' && type !== 'user')) continue;
    const key = `${type}:${id}`;
    if (!seen.has(key)) {
      seen.set(key, { person: { type, id }, name });
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function personFilterKey(f: PersonFilter): string {
  if (f.kind === 'person') return `${f.person.type}:${f.person.id}`;
  return f.kind;
}
