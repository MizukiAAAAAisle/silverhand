import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { TaskSummaryDto } from '@silverhand/shared';
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
      const res = await api<{ tasks: TaskSummaryDto[] }>(
        `/api/tasks?${params.toString()}`,
      );
      return res.tasks[0] ?? null;
    },
    enabled,
  });
}
