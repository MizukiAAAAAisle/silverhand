import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useEffect } from 'react';
import type {
  TaskChangedEvent,
  TaskDetailDto,
  TaskEditResult,
  TaskStatus,
  TaskSummaryDto,
} from '@silverhand/shared';
import { api } from '@/lib/api';
import {
  isCurrentViewerScope,
  onWsFrame,
  subscribeViewerScope,
} from '@/lib/ws-client';
import { applyTaskChangedToTaskByNumberCache } from './useTaskByNumber';
import { taskDetailKey } from './taskDetail';

/**
 * Tasks live in /api/tasks (per docs/tasks-design.md). The list is
 * filterable by workspace / conversation / status; fetched once per filter
 * combination. Mutations invalidate this cache; workspace/global task views
 * also listen for WS `task_changed` events because agent-side updates can
 * occur from any conversation in the workspace.
 */
export interface TaskFilter {
  workspace_id?: string;
  conversation_id?: string;
  status?: TaskStatus | 'all';
}

export const tasksKey = (f: TaskFilter) =>
  [
    'tasks',
    f.workspace_id ?? '*',
    f.conversation_id ?? '*',
    f.status ?? 'all',
  ] as const;

export interface UseTasksOptions {
  enabled?: boolean;
}

function buildQs(f: TaskFilter): string {
  const params = new URLSearchParams();
  if (f.workspace_id) params.set('workspace_id', f.workspace_id);
  if (f.conversation_id) params.set('conversation_id', f.conversation_id);
  if (f.status && f.status !== 'all') params.set('status', f.status);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export function useTasks(filter: TaskFilter, opts?: UseTasksOptions) {
  const qc = useQueryClient();
  const enabled = opts?.enabled ?? true;

  // The board is the viewer's cross-conversation aggregate. Task changes reach
  // it via the viewer's private scope (`viewer:<userId>`) — the server fans
  // `task_changed` out to each human member of the task's conversation, so one
  // subscription covers every conversation the viewer belongs to across all
  // workspaces, and a task from a channel the viewer can't see never arrives
  // (private-task fanout is gated server-side, not filtered here). Same
  // resolver as viewer-unread / Activity. Per-conversation source-chip
  // convergence is a separate carrier (`conversation:<id>` in the ingestor).
  useEffect(() => {
    if (!enabled) return;
    const sub = subscribeViewerScope();
    const unsub = onWsFrame(frame => {
      if (frame.type === 'snapshot_required') {
        if (isCurrentViewerScope(frame.scope)) {
          void qc.invalidateQueries({ queryKey: ['task-by-number'] });
          void qc.invalidateQueries({ queryKey: ['tasks'] });
          void qc.invalidateQueries({ queryKey: ['task-detail'] });
        }
        return;
      }
      if (frame.type !== 'event') return;
      if (frame.kind !== 'task_changed' || !isCurrentViewerScope(frame.scope)) {
        return;
      }
      const payload = frame.payload as TaskChangedEvent;
      applyTaskChangedToTaskByNumberCache(qc, payload);
      void qc.invalidateQueries({ queryKey: ['tasks'] });
      // An open detail modal edits/reads a separate `['task-detail', taskId]`
      // projection — refresh it too so a remote edit doesn't leave the
      // open body stale (title/status already fan out above).
      void qc.invalidateQueries({
        queryKey: taskDetailKey(payload.task_id),
        exact: true,
      });
    });
    return () => {
      sub.unsubscribe();
      unsub();
    };
  }, [enabled, qc]);

  const query = useQuery({
    queryKey: tasksKey(filter),
    queryFn: async () => {
      const res = await api<{ tasks: TaskSummaryDto[] }>(
        `/api/tasks${buildQs(filter)}`,
      );
      return res.tasks;
    },
    enabled,
  });

  return query;
}

// ── Mutations (human UI overrides) ─────────────────────────────────

export function useUpdateTaskStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { taskId: string; status: TaskStatus }) => {
      const res = await api<{ success: boolean; reason?: string }>(
        `/api/tasks/${args.taskId}/status`,
        { method: 'POST', body: JSON.stringify({ status: args.status }) },
      );
      if (!res.success) throw new Error(res.reason ?? 'update failed');
      return res;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
}

// ── Detail + edit (human detail modal) ─────────────────────────────

/**
 * Full single-task read for the detail modal — GET /api/tasks/:taskId
 * → { task: TaskDetailDto }. The board list stays title-only; the body,
 * edit-provenance byline, and viewer-resolved `nav` all come from
 * here, fetched on demand when a card is opened. `enabled` gates the
 * fetch so a closed modal issues no request.
 */
export function useTaskDetail(
  taskId: string | null | undefined,
  opts?: { enabled?: boolean },
) {
  const gate = opts?.enabled ?? true;
  return useQuery({
    queryKey: taskDetailKey(taskId),
    queryFn: async (): Promise<TaskDetailDto> => {
      const res = await api<{ task: TaskDetailDto }>(`/api/tasks/${taskId}`);
      return res.task;
    },
    enabled: gate && typeof taskId === 'string' && taskId.length > 0,
  });
}

/**
 * `task edit` — a plain last-write-wins UPDATE of the task definition
 * (title and/or content). Returns the full, viewer-resolved detail AFTER the
 * edit so an open detail modal updates in place without a refetch. There is
 * no optimistic-concurrency guard: the most recent successful write wins;
 * every typed failure throws (surfaced via `edit.isError`).
 */
export interface EditTaskInput {
  taskId: string;
  /** Only-changed fields — omit to leave unchanged. A legacy null-title
   *  task keeps its fallback title when `title` is omitted (the backend
   *  materializes it independently of a body-only edit). */
  title?: string;
  body?: string;
}

export function useEditTask() {
  const qc = useQueryClient();
  return useMutation<TaskDetailDto, Error, EditTaskInput>({
    mutationFn: async (input): Promise<TaskDetailDto> => {
      const payload: Record<string, unknown> = {};
      if (input.title !== undefined) payload.title = input.title;
      if (input.body !== undefined) payload.body = input.body;
      const res = await api<Extract<TaskEditResult, { success: true }>>(
        `/api/tasks/${input.taskId}/edit`,
        { method: 'POST', body: JSON.stringify(payload) },
      );
      return res.task;
    },
    onSuccess: task => {
      // In-place cache update from the authoritative post-edit snapshot;
      // title may have changed so refresh the board list + inline sigils.
      qc.setQueryData(taskDetailKey(task.id), task);
      void qc.invalidateQueries({ queryKey: ['tasks'] });
      void qc.invalidateQueries({ queryKey: ['task-by-number'] });
    },
  });
}
