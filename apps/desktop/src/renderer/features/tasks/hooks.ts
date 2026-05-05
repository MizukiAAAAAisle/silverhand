import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type { TaskStatus, TaskSummaryDto } from '@silverhand/shared';
import { api } from '@/lib/api';

/**
 * Tasks live in /api/tasks (per docs/tasks-design.md §6.2). The list is
 * filterable by channel / conversation / status; fetched once per filter
 * combination. Mutations invalidate this cache; channel/global task views
 * also poll lightly because agent-side task updates can occur from any
 * conversation in the workspace.
 */
export interface TaskFilter {
  workspace_id?: string;
  conversation_id?: string;
  status?: TaskStatus | 'all';
}

export const tasksKey = (f: TaskFilter) =>
  ['tasks', f.workspace_id ?? '*', f.conversation_id ?? '*', f.status ?? 'all'] as const;

function buildQs(f: TaskFilter): string {
  const params = new URLSearchParams();
  if (f.workspace_id) params.set('workspace_id', f.workspace_id);
  if (f.conversation_id) params.set('conversation_id', f.conversation_id);
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
    refetchInterval: 5_000,
  });

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
