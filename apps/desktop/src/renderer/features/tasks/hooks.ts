import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useCallback } from 'react';
import type { TaskStatus, TaskSummaryDto } from '@silverhand/shared';
import { api } from '@/lib/api';
import { useSessionStream, type SessionStreamEvent } from '@/hooks/useSessionStream';

/**
 * Tasks live in /api/tasks (per docs/tasks-design.md §6.2). The list is
 * filterable by channel / session / status; fetched once per filter
 * combination, kept fresh via SSE `task_changed` events on the matching
 * session stream.
 */
export interface TaskFilter {
  channel_id?: string;
  session_id?: string;
  status?: TaskStatus | 'all';
}

export const tasksKey = (f: TaskFilter) =>
  ['tasks', f.channel_id ?? '*', f.session_id ?? '*', f.status ?? 'all'] as const;

function buildQs(f: TaskFilter): string {
  const params = new URLSearchParams();
  if (f.channel_id) params.set('channel_id', f.channel_id);
  if (f.session_id) params.set('session_id', f.session_id);
  if (f.status && f.status !== 'all') params.set('status', f.status);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export function useTasks(filter: TaskFilter, opts?: { enabled?: boolean }) {
  const qc = useQueryClient();
  const enabled = opts?.enabled ?? true;
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

  // Subscribe to session stream when scope is a single session — backend
  // only publishes task_changed on the owning session's bus, so this is
  // the right granularity. For channel/global views we fall back to
  // periodic refetch (acceptable: tasks change at human pace).
  const onEvent = useCallback(
    (e: SessionStreamEvent) => {
      if (e.kind !== 'task_changed') return;
      // Cheapest correct refresh: invalidate everything under tasks/.
      // Granular cache patching is possible but adds bug surface for
      // limited gain — task views are tiny and refetch is fast.
      void qc.invalidateQueries({ queryKey: ['tasks'] });
    },
    [qc],
  );
  useSessionStream(filter.session_id ?? null, onEvent);

  return query;
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
