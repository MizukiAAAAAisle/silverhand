import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useEffect } from 'react';
import type {
  TaskArchiveFilter,
  TaskChangedEvent,
  TaskStatus,
  TaskSummaryDto,
} from '@silverhand/shared';
import { api } from '@/lib/api';
import { onWsFrame, subscribeWsScope } from '@/lib/ws-client';
import { applyTaskChangedToTaskByNumberCache } from './useTaskByNumber';

/**
 * Tasks live in /api/tasks (per docs/tasks-design.md §6.2). The list is
 * filterable by workspace / conversation / status; fetched once per filter
 * combination. Mutations invalidate this cache; workspace/global task views
 * also listen for WS `task_changed` events because agent-side updates can
 * occur from any conversation in the workspace.
 */
export interface TaskFilter {
  workspace_id?: string;
  conversation_id?: string;
  status?: TaskStatus | 'all';
  archived?: TaskArchiveFilter;
}

export const tasksKey = (f: TaskFilter) =>
  [
    'tasks',
    f.workspace_id ?? '*',
    f.conversation_id ?? '*',
    f.status ?? 'all',
    f.archived ?? 'active',
  ] as const;

export interface UseTasksOptions {
  enabled?: boolean;
  workspaceScopeIds?: readonly string[];
}

function buildQs(f: TaskFilter): string {
  const params = new URLSearchParams();
  if (f.workspace_id) params.set('workspace_id', f.workspace_id);
  if (f.conversation_id) params.set('conversation_id', f.conversation_id);
  if (f.status && f.status !== 'all') params.set('status', f.status);
  if (f.archived && f.archived !== 'active') params.set('archived', f.archived);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export function useTasks(filter: TaskFilter, opts?: UseTasksOptions) {
  const qc = useQueryClient();
  const enabled = opts?.enabled ?? true;
  const workspaceScopeKey = scopeKey(
    opts?.workspaceScopeIds ?? (filter.workspace_id ? [filter.workspace_id] : undefined),
  );

  // Subscribe to workspace-level task_changed events so the global task
  // drawer/badge refreshes without polling. conversation-level task changes
  // are already delivered via the conversation WS scope.
  useEffect(() => {
    if (!enabled || workspaceScopeKey.length === 0) return;
    const workspaceScopeIds = workspaceScopeKey.split('\0');
    const scopes = new Set(workspaceScopeIds.map(id => `workspace:${id}`));
    const subs = [...scopes].map(scope => subscribeWsScope(scope));
    const unsub = onWsFrame(frame => {
      if (frame.type === 'event') {
        if (frame.kind !== 'task_changed' || !scopes.has(frame.scope)) return;
        applyTaskChangedToTaskByNumberCache(qc, frame.payload as TaskChangedEvent);
        void qc.invalidateQueries({ queryKey: ['tasks'] });
      } else if (frame.type === 'snapshot_required' && scopes.has(frame.scope)) {
        void qc.invalidateQueries({ queryKey: ['task-by-number'] });
        void qc.invalidateQueries({ queryKey: ['tasks'] });
      }
    });
    return () => {
      for (const sub of subs) sub.unsubscribe();
      unsub();
    };
  }, [enabled, qc, workspaceScopeKey]);

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

function scopeKey(ids: readonly string[] | undefined): string {
  if (!ids) return '';
  return [...new Set(ids.filter(Boolean))].sort().join('\0');
}

// ── Mutations (human UI overrides) ─────────────────────────────────

export function useUpdateTaskStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { messageId: string; status: TaskStatus }) => {
      const res = await api<{ success: boolean; reason?: string }>(
        `/api/tasks/${args.messageId}/status`,
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

export function useUnclaimTaskHuman() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (messageId: string) => {
      const res = await api<{ success: boolean; reason?: string }>(
        `/api/tasks/${messageId}/unclaim`,
        { method: 'POST' },
      );
      if (!res.success) throw new Error(res.reason ?? 'unclaim failed');
      return res;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
}

export function useArchiveTaskHuman() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { messageId: string; archived: boolean }) => {
      const res = await api<{ success: boolean; reason?: string }>(
        `/api/tasks/${args.messageId}/archive`,
        { method: 'POST', body: JSON.stringify({ archived: args.archived }) },
      );
      if (!res.success) throw new Error(res.reason ?? 'archive failed');
      return res;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
}

// ── Aggregations ───────────────────────────────────────────────────

const ACTIVE: ReadonlySet<TaskStatus> = new Set(['todo', 'in_progress', 'in_review']);

export function partitionByActive(
  tasks: TaskSummaryDto[],
): { active: TaskSummaryDto[]; done: TaskSummaryDto[] } {
  const active: TaskSummaryDto[] = [];
  const done: TaskSummaryDto[] = [];
  for (const t of tasks) (ACTIVE.has(t.status) ? active : done).push(t);
  return { active, done };
}

/** Group active tasks by status — drives the drawer's section headers. */
export function groupActiveByStatus(
  tasks: TaskSummaryDto[],
): Record<TaskStatus, TaskSummaryDto[]> {
  const out: Record<TaskStatus, TaskSummaryDto[]> = {
    todo: [],
    in_progress: [],
    in_review: [],
    done: [],
  };
  for (const t of tasks) out[t.status].push(t);
  return out;
}
