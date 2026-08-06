import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { useEffect } from 'react';
import {
  type CreatedTaskIdentity,
  type HumanCreateTaskInput,
  type HumanCreateTaskResult,
  type TaskChangedEvent,
  type TaskDetailDto,
  type TaskEditResult,
  type TaskStatus,
  type TaskSummaryDto,
} from '@silverhand/shared';
import { api, ApiError, toPathSegment } from '@/lib/api';
import {
  isCurrentViewerScope,
  onWsFrame,
  subscribeViewerScope,
} from '@/lib/ws-client';
import { applyTaskChangedToTaskByNumberCache } from './useTaskByNumber';
import {
  shouldRefreshTaskDetail,
  shouldRetryTaskDetail,
  taskDetailKey,
  type TaskDetailFrame,
} from './taskDetail';

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

/**
 * Settle every task projection of ONE channel the viewer lost (#task:1689).
 * Three key families, two shapes:
 *
 *   - `['tasks', ws, conv, status]` list variants are PATCHED (rows filtered by
 *     `channel_id`): `TaskStore.list`'s user arm joins `EXISTS
 *     conversation_users`, so a refetch returns the list minus those rows — the
 *     patch reproduces that shape without re-windowing the survivors.
 *   - `['task-detail', id]` and `['task-by-number', ws, n]` are single-object
 *     caches for a task the viewer can no longer read; a refetch fails rather
 *     than returning a trimmed body, so the query is REMOVED, not patched.
 *
 * PRESENT-ONLY / idempotent throughout: unloaded or non-matching caches are
 * untouched, so an unrelated channel loss never disturbs an open task board.
 */
export function removeChannelFromTasks(qc: QueryClient, channelId: string): void {
  for (const q of qc.getQueryCache().findAll({ queryKey: ['tasks'] })) {
    const prev = qc.getQueryData<TaskSummaryDto[]>(q.queryKey);
    if (!prev) continue;
    const next = prev.filter(t => t.channel_id !== channelId);
    if (next.length === prev.length) continue;
    qc.setQueryData<TaskSummaryDto[]>(q.queryKey, next);
  }
  for (const root of [['task-detail'], ['task-by-number']] as const) {
    for (const q of qc.getQueryCache().findAll({ queryKey: root })) {
      const data = qc.getQueryData<TaskSummaryDto | TaskDetailDto | null>(q.queryKey);
      if (!data || data.channel_id !== channelId) continue;
      qc.removeQueries({ queryKey: q.queryKey, exact: true });
    }
  }
}

/** Which channels of ONE workspace the task caches still hold rows for
 *  (#task:1689). Read off `workspace_id` + `channel_id` on the row: the global
 *  task board's variant (`['tasks','*','*',…]`) spans every workspace, so the
 *  key alone cannot answer it. */
export function tasksHeldChannelIds(
  qc: QueryClient,
  workspaceId: string,
): string[] {
  const ids = new Set<string>();
  for (const q of qc.getQueryCache().findAll({ queryKey: ['tasks'] })) {
    for (const t of qc.getQueryData<TaskSummaryDto[]>(q.queryKey) ?? []) {
      if (t.workspace_id === workspaceId) ids.add(t.channel_id);
    }
  }
  for (const root of [['task-detail'], ['task-by-number']] as const) {
    for (const q of qc.getQueryCache().findAll({ queryKey: root })) {
      const data = qc.getQueryData<TaskSummaryDto | TaskDetailDto | null>(q.queryKey);
      if (data && data.workspace_id === workspaceId) ids.add(data.channel_id);
    }
  }
  return [...ids];
}

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
      // `['task-detail', id]` is deliberately NOT refreshed here: the detail
      // modal is now an app-level surface that opens straight from `?task=`
      // with no board behind it (#task:1715), so a listener that needs a
      // mounted board could not keep it fresh. `useTaskDetail` owns that
      // projection's realtime edge itself — ONE owner per projection.
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
    onSuccess: (_res, vars) => {
      void qc.invalidateQueries({ queryKey: ['tasks'] });
      // The board list is NOT the only projection of a status: the open detail
      // modal reads `['task-detail', id]` and inline `#task:n` sigils read
      // `['task-by-number']`. Without these two a LOCAL status change only
      // showed up once the WS `task_changed` echo arrived — and that listener
      // lives inside `useTasks()`, so it needs a mounted board to fire at all.
      void qc.invalidateQueries({
        queryKey: taskDetailKey(vars.taskId),
        exact: true,
      });
      void qc.invalidateQueries({ queryKey: ['task-by-number'] });
    },
  });
}

/**
 * Assign / re-assign / clear a task's assignee — `agentId: null` clears.
 * `POST /api/tasks/:taskId/claim` `{agent_id}` for a named agent,
 * `POST /api/tasks/:taskId/unclaim` for the clear. Backs the detail modal's
 * Assignee row.
 *
 * ONE hook for both because it is ONE product action ("who owns this"), and both
 * arms need the identical three-projection invalidation and the same error exit;
 * two hooks would let those drift.
 *
 * The renderer never predicts what the write does to the STATUS, and never
 * implies one: assigning a `todo` task DISPATCHES it (the server starts it in the
 * same write — `todo + assignee` has no legal exit), reassigning a running or
 * in-review task only changes hands, and clearing the assignee never rewinds the
 * workflow (backend contract in `docs/tasks-design.md` §4.4, shiki 2026-08-06).
 * Either way the surface re-reads and shows what the server settled on —
 * invalidate, never patch.
 *
 * `done` / `closed` refuse BOTH arms (409): assignment on a terminal task is
 * frozen server-side, which is why the surface offers the control only on a
 * non-terminal one. The 409 stays the authority — the read-only gate is
 * experience, not correctness.
 */
export function useAssignTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { taskId: string; agentId: string | null }) => {
      const res = await api<{ success: boolean; reason?: string }>(
        args.agentId === null
          ? `/api/tasks/${args.taskId}/unclaim`
          : `/api/tasks/${args.taskId}/claim`,
        {
          method: 'POST',
          ...(args.agentId === null
            ? {}
            : { body: JSON.stringify({ agent_id: args.agentId }) }),
        },
      );
      if (!res.success) throw new Error(res.reason ?? 'assign failed');
      return res;
    },
    onSuccess: (_res, vars) => {
      // Same three projections as a status write — the board list is never the
      // only place a task's assignee is shown.
      void qc.invalidateQueries({ queryKey: ['tasks'] });
      void qc.invalidateQueries({
        queryKey: taskDetailKey(vars.taskId),
        exact: true,
      });
      void qc.invalidateQueries({ queryKey: ['task-by-number'] });
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
 *
 * This hook is also the SOLE realtime owner of the `['task-detail', id]`
 * projection (#task:1715). It used to ride the listener inside `useTasks`, which
 * only worked while a board was mounted — the modal now opens straight from
 * `?task=<task_id>` (a chat chip, a cold deep-link) with no board behind it, so
 * that arrangement lost both remote `task_changed` refresh and
 * `snapshot_required` gap recovery exactly when the modal was the only task
 * surface on screen. Owning the edge here also means one projection has one
 * owner: no second invalidation of the same key racing this one (a duplicate
 * `invalidateQueries` on a query that already has data CANCELS the in-flight
 * refetch and restarts it — `cancelRefetch` defaults to true — so a second
 * writer is a wasted round trip, not a free dedup).
 *
 * Viewer scope is the right carrier: the server fans `task_changed` out to every
 * human member of the task's conversation, and a human's detail read gate IS
 * conversation membership — so anything the modal is allowed to show, the viewer
 * scope delivers.
 */
export function useTaskDetail(
  taskId: string | null | undefined,
  opts?: { enabled?: boolean },
) {
  const qc = useQueryClient();
  const gate = opts?.enabled ?? true;
  const enabled = gate && typeof taskId === 'string' && taskId.length > 0;

  useEffect(() => {
    if (!enabled || typeof taskId !== 'string') return;
    const sub = subscribeViewerScope();
    const unsub = onWsFrame(frame => {
      // The decision itself is `shouldRefreshTaskDetail` (a pure, exhaustive
      // contract): this listener only projects the wire frame onto it, so the
      // scope/kind/id rules are testable without a React tree.
      const projected: TaskDetailFrame =
        frame.type === 'snapshot_required'
          ? {
              type: 'snapshot_required',
              viewerScope: isCurrentViewerScope(frame.scope),
            }
          : frame.type === 'event'
            ? {
                type: 'event',
                viewerScope: isCurrentViewerScope(frame.scope),
                kind: frame.kind,
                taskId: (frame.payload as TaskChangedEvent)?.task_id ?? null,
              }
            : { type: 'other' };
      if (!shouldRefreshTaskDetail(projected, taskId)) return;
      void qc.invalidateQueries({ queryKey: taskDetailKey(taskId), exact: true });
    });
    return () => {
      sub.unsubscribe();
      unsub();
    };
  }, [enabled, qc, taskId]);

  return useQuery({
    queryKey: taskDetailKey(taskId),
    queryFn: async (): Promise<TaskDetailDto> => {
      // `taskId` reaches here from `?task=<id>` — a URL the user can paste or
      // hand-edit — so it is untrusted input interpolated into a request path.
      // A value that cannot be one path segment is answered LOCALLY as the same
      // authoritative 404 a deleted task gets: it names no readable task, and
      // sending it would let `..` climb out of `/api/tasks/` in main's
      // `new URL(path, base)` (Cindy / Alice review).
      const segment = toPathSegment(taskId as string);
      if (segment === null) {
        throw new ApiError(404, 'Not Found', 'malformed task pointer');
      }
      const res = await api<{ task: TaskDetailDto }>(`/api/tasks/${segment}`);
      return res.task;
    },
    // 404 is terminal — see `shouldRetryTaskDetail`.
    retry: shouldRetryTaskDetail,
    enabled,
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

// ── Create (human panel direct-create) ─────────────────────────────

/**
 * `POST /api/tasks` — create a task straight from a task surface, naming the
 * target channel (#task:1723). Shares the agent create's semantics server-side
 * (one `taskService.createTasks` txn) and, like it, the ACK returns ONLY the
 * identity the transaction produced — `{ id, task_number, title }`, never a
 * post-commit detail re-read (which could report a committed write as a failure
 * and drive a duplicate on this sourceless, non-idempotent create; #task:1724).
 * The identity ACK only CONFIRMS the create — the surface does not navigate to
 * the new task; on success the dialog closes and the `['tasks']` invalidation
 * below refreshes the board/drawer in place (shiki 2026-07-30).
 *
 * Only `['tasks']` is invalidated: the new row belongs on every board list, and
 * there is no prior detail / by-number projection of a task that did not exist a
 * moment ago. Typed domain rejections arrive as an `ApiError` carrying the
 * `{ success:false, code }` envelope — `createTaskErrorMessage` (in
 * `createTaskError.ts`) turns the `code` discriminant into copy for the dialog.
 */
export function useCreateTask() {
  const qc = useQueryClient();
  return useMutation<CreatedTaskIdentity, Error, HumanCreateTaskInput>({
    mutationFn: async (input): Promise<CreatedTaskIdentity> => {
      const res = await api<Extract<HumanCreateTaskResult, { success: true }>>(
        '/api/tasks',
        { method: 'POST', body: JSON.stringify(input) },
      );
      return res.task;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
}
