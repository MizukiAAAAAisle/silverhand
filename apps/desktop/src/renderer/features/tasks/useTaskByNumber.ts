import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { TaskSummaryDto } from '@silverhand/shared';
import { api } from '@/lib/api';
import { logRefHoverDebug } from '@/lib/refHoverDebug';

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
    queryKey: ['task-by-number', workspaceId ?? null, taskNumber ?? null] as const,
    queryFn: async (): Promise<TaskSummaryDto | null> => {
      const params = new URLSearchParams();
      params.set('workspace_id', workspaceId as string);
      params.set('task_number', String(taskNumber));
      params.set('limit', '1');
      logRefHoverDebug('task-query:start', {
        workspaceId,
        taskNumber,
      });
      try {
        const res = await api<{ tasks: TaskSummaryDto[] }>(
          `/api/tasks?${params.toString()}`,
        );
        const task = res.tasks[0] ?? null;
        logRefHoverDebug('task-query:success', {
          workspaceId,
          taskNumber,
          found: task != null,
          status: task?.status ?? null,
        });
        return task;
      } catch (err) {
        logRefHoverDebug('task-query:error', {
          workspaceId,
          taskNumber,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    },
    enabled,
    staleTime: TASK_REF_STALE_MS,
    gcTime: TASK_REF_GC_MS,
  });
}
