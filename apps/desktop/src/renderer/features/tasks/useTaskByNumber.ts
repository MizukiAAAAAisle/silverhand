import {
  useQuery,
  type QueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import type { TaskChangedEvent, TaskSummaryDto } from '@silverhand/shared';
import { api } from '@/lib/api';

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
 * Keep inline `#task:<n>` popover cache coherent with realtime task
 * mutations. The `task_changed` payload has exactly the mutable fields
 * this cache needs (status, assignee, title); immutable context such as
 * creator/created_at stays from the original `/api/tasks` fetch.
 */
export function applyTaskChangedToTaskByNumberCache(
  qc: QueryClient,
  task: TaskChangedEvent,
): void {
  const key = taskByNumberKey(task.workspace_id, task.task_number);
  const state = qc.getQueryState<TaskSummaryDto | null>(key);
  if (!state) return;

  // A cached miss can become real if the task is created after a user
  // has already hovered the sigil. We cannot synthesize the full
  // TaskSummaryDto from the event, so mark the exact query stale and
  // let active observers refetch.
  if (state.data === null) {
    void qc.invalidateQueries({ queryKey: key, exact: true });
    return;
  }

  qc.setQueryData<TaskSummaryDto | null>(key, prev => {
    if (!prev) return prev;
    return {
      ...prev,
      message_id: task.message_id,
      workspace_id: task.workspace_id,
      channel_id: task.channel_id,
      thread_id: task.thread_id,
      status: task.status,
      title: task.title,
      assignee: task.assignee,
      closed_at: task.closed_at,
    };
  });
}

export function useTaskByNumber(
  workspaceId: string | null | undefined,
  taskNumber: number | null | undefined,
): UseTaskByNumberResult {
  // Both must be resolvable for the lookup to be meaningful. A missing
  // workspace context (e.g. SavedListView outside any conversation) or
  // a non-finite number short-circuits the fetch.
  const enabled =
    typeof workspaceId === 'string'
    && workspaceId.length > 0
    && typeof taskNumber === 'number'
    && Number.isFinite(taskNumber)
    && taskNumber > 0;

  return useQuery({
    queryKey: taskByNumberKey(workspaceId, taskNumber),
    queryFn: async (): Promise<TaskSummaryDto | null> => {
      const params = new URLSearchParams();
      params.set('workspace_id', workspaceId as string);
      params.set('task_number', String(taskNumber));
      params.set('limit', '1');
      const res = await api<{ tasks: TaskSummaryDto[] }>(
        `/api/tasks?${params.toString()}`,
      );
      return res.tasks[0] ?? null;
    },
    enabled,
    staleTime: TASK_REF_STALE_MS,
    gcTime: TASK_REF_GC_MS,
  });
}
