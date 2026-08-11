import {
  useQuery,
  type QueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import {
  apiPaths,
  type TaskChangedEvent,
  type TaskSummaryDto,
} from '@silverhand/shared';
import { api, ApiError } from '@/lib/api';
import { restartRacingRead } from './racingRead';

/**
 * Fetch a single task by its workspace-scoped task_number for inline
 * `#task:<n>` sigil rendering.
 *
 * Workspace-scoped: `task_number` is unique per workspace (allocated by
 * `TaskService.allocateTaskNumber`), not globally. The caller passes the
 * workspace context of the *message* the sigil appears in — when a side
 * pane renders foreign-workspace content, that's the foreign workspace,
 * not the primary selected one. This matches the cross-workspace
 * `useConversationById` resolution pattern from PR-2.
 *
 * Returns `null` (resolved) when the task is missing — the renderer
 * should silently demote the sigil to inert text rather than show a
 * broken pill. `undefined` while still loading; React Query owns the
 * loading flag.
 */
export type UseTaskByNumberResult = UseQueryResult<TaskSummaryDto | null>;

const TASK_REF_GC_MS = 5 * 60 * 1000;
const TASK_REF_STALE_MS = 30 * 1000;

export const taskByNumberKey = (
  workspaceId: string | null | undefined,
  taskNumber: number | null | undefined,
) => ['task-by-number', workspaceId ?? null, taskNumber ?? null] as const;

/**
 * What one event did to the by-number entry it names.
 *
 * `patched` is the only outcome that WROTE — which is what makes this cache's
 * single refetch owner decidable: nothing else in the event path invalidates a
 * `['task-by-number']` entry, so an assignment that landed over a read issued
 * before the event has to restart that read itself, and one that changed nothing
 * must not (restarting on a duplicate delivery would spend a round trip per echo,
 * the same defect identity preservation fixes on the board rows).
 */
export type TaskByNumberPatchOutcome =
  /** No entry for those axes, or one whose first load has not resolved: there is
   *  no DTO to write over and the event cannot synthesize one. A first load that
   *  is still IN FLIGHT is restarted, because it was issued before this event and
   *  would otherwise commit pre-event state as the chip's initial value. */
  | 'absent'
  /** A cached MISS that has become a real task — only a read can build it. */
  | 'invalidated'
  /** The snapshot says what the entry already reads. */
  | 'unchanged'
  | 'patched';

function sameTaskChangedFields(
  row: TaskSummaryDto,
  task: TaskChangedEvent,
): boolean {
  return (
    row.id === task.task_id
    && row.workspace_id === task.workspace_id
    && row.channel_id === task.channel_id
    && row.thread_root_id === task.thread_root_id
    && row.status === task.status
    && row.title === task.title
    && row.closed_at === task.closed_at
    && (row.assignee?.id ?? null) === (task.assignee?.id ?? null)
    && (row.assignee?.type ?? null) === (task.assignee?.type ?? null)
  );
}

/**
 * Keep inline `#task:<n>` popover cache coherent with realtime task
 * mutations. The `task_changed` payload has exactly the mutable fields
 * this cache needs (status, assignee, title); immutable context such as
 * creator/created_at stays from the original by-number fetch.
 *
 * The write is IDENTITY-PRESERVING and owns the freshness of its own key: an
 * event that repeats what the entry holds writes nothing and restarts nothing,
 * while one that carries news restarts a read issued before it — React Query
 * commits a settled response over an interim `setQueryData`, so without that a
 * point read in flight when the event arrives can put pre-event state back
 * (#task:1975; the same rule as `restartRacingRead` on the board columns).
 */
export function applyTaskChangedToTaskByNumberCache(
  qc: QueryClient,
  task: TaskChangedEvent,
): TaskByNumberPatchOutcome {
  const key = taskByNumberKey(task.workspace_id, task.task_number);
  const state = qc.getQueryState<TaskSummaryDto | null>(key);
  if (!state) return 'absent';

  // A COLD read — the entry exists but has never resolved. Nothing can be
  // patched (there is no DTO yet, and the event cannot synthesize one), so the
  // restart is the entire fix: that request was issued before this event, and
  // React Query commits a settled response over anything written since, so
  // leaving it alone lets the chip's FIRST paint be pre-event state with no
  // bounded recovery behind it (`staleTime` does not re-read on a timer).
  if (state.data === undefined) {
    restartRacingRead(qc, key);
    return 'absent';
  }

  // A cached miss can become real if the task is created after a user
  // has already hovered the sigil. We cannot synthesize the full
  // TaskSummaryDto from the event, so mark the exact query stale and
  // let active observers refetch.
  if (state.data === null) {
    void qc.invalidateQueries({ queryKey: key, exact: true });
    return 'invalidated';
  }
  const prev = state.data;
  if (sameTaskChangedFields(prev, task)) return 'unchanged';

  qc.setQueryData<TaskSummaryDto | null>(key, {
    ...prev,
    id: task.task_id,
    workspace_id: task.workspace_id,
    channel_id: task.channel_id,
    // Keep the navigation anchor fresh from the realtime event so
    // an inline `#task:<n>` jump resolves to the right reply cluster
    // instead of relying on stale by-number fetch values.
    thread_root_id: task.thread_root_id,
    status: task.status,
    title: task.title,
    assignee: task.assignee,
    closed_at: task.closed_at,
  });
  if (state.fetchStatus === 'fetching') {
    restartRacingRead(qc, key);
  }
  return 'patched';
}

/**
 * The wire path for one point lookup. `apiPaths.taskByNumber` is the single
 * authority for where this face lives (#task:1891) — the renderer does not
 * spell the route out a second time.
 *
 * Both axes and NOTHING else: this face takes no `status` and no `limit`. It
 * used to be `GET /api/tasks?workspace_id=&task_number=&limit=1` — a filtered
 * slice of the unbounded human list. That list DID carry a `task_number` filter
 * (`ListTasksQuerySchema`: a repeatable, OR-ed axis), and that is exactly how
 * the old consumer worked. What it lacked was a POINT FACE: the answer to a
 * point question arrived in a list envelope (`{ tasks: [t] }`) narrowed by one
 * filter among many and capped by a caller-supplied `limit`.
 */
export function taskByNumberPath(
  workspaceId: string,
  taskNumber: number,
): string {
  const qs = new URLSearchParams();
  qs.set('workspace_id', workspaceId);
  qs.set('task_number', String(taskNumber));
  return `${apiPaths.taskByNumber}?${qs.toString()}`;
}

/**
 * Whether the two axes are resolvable at all. A missing workspace context
 * (e.g. SavedListView outside any conversation) short-circuits the fetch.
 *
 * `Number.isInteger` rather than `isFinite` mirrors the server's axis
 * (`TaskByNumberQuerySchema`: positive integer), so the two gates cannot
 * disagree about what a task number is — a fractional one is a bad REQUEST
 * (400), which must never be mistaken for a resolved miss.
 */
export function canLookupTaskByNumber(
  workspaceId: string | null | undefined,
  taskNumber: number | null | undefined,
): boolean {
  return (
    typeof workspaceId === 'string'
    && workspaceId.length > 0
    && typeof taskNumber === 'number'
    && Number.isInteger(taskNumber)
    && taskNumber > 0
  );
}

/**
 * Is this failure the authoritative "no such task for you"?
 *
 * ONLY a 404. The face is fail-closed by design — a number that was never
 * allocated and a task the viewer cannot see return the same 404 — and both
 * mean the same thing to a sigil: demote to inert text. Everything else stays
 * an error: a 400 says the request was malformed (caching it as a resolved miss
 * would make a client bug look like a deleted task), and a transport failure
 * arrives as `ApiError` with `kind: 'backend_unreachable'` / `status: 0`, which
 * this predicate excludes by the status check alone. A pill must not claim a
 * task is gone because the server was unreachable.
 */
export function isResolvedTaskMiss(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

/**
 * One point lookup: the task, or `null` when the server authoritatively has
 * none for this viewer.
 *
 * A module-level function rather than an inline `queryFn` so the envelope
 * wiring and the error taxonomy are testable without a React tree — reading
 * `res.task` (this face) instead of `res.tasks[0]` (the retired list) is a
 * value-level fact that a path assertion cannot catch.
 */
export async function fetchTaskByNumber(
  workspaceId: string,
  taskNumber: number,
): Promise<TaskSummaryDto | null> {
  try {
    const res = await api<{ task: TaskSummaryDto }>(
      taskByNumberPath(workspaceId, taskNumber),
    );
    return res.task;
  } catch (err) {
    // A resolved miss, not a failure — so it needs no `retry` policy: the query
    // never enters an error state and React Query has nothing to retry.
    // Anything else propagates and retries as usual.
    if (isResolvedTaskMiss(err)) return null;
    throw err;
  }
}

export function useTaskByNumber(
  workspaceId: string | null | undefined,
  taskNumber: number | null | undefined,
): UseTaskByNumberResult {
  const enabled = canLookupTaskByNumber(workspaceId, taskNumber);

  return useQuery({
    queryKey: taskByNumberKey(workspaceId, taskNumber),
    queryFn: () =>
      fetchTaskByNumber(workspaceId as string, taskNumber as number),
    enabled,
    staleTime: TASK_REF_STALE_MS,
    gcTime: TASK_REF_GC_MS,
  });
}
