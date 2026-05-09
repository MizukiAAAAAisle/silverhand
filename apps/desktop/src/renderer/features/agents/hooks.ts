import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AgentDeleteImpactDto,
  AgentDto,
  AgentRuntimeStateDto,
  AgentWorkspaceDto,
  CreateAgentInput,
  ScheduleDto,
  ScheduleListStatusFilter,
  UpdateAgentInput,
} from '@silverhand/shared';
import { apiPaths } from '@silverhand/shared';
import { api } from '@/lib/api';

const agentsKey = ['agents'] as const;
const agentKey = (id: string) => ['agents', id] as const;
const agentWorkspaceKey = (id: string) => ['agents', id, 'workspace'] as const;
const agentRuntimeStateKey = (id: string) => ['agents', id, 'runtime-state'] as const;
const agentDeleteImpactKey = (id: string) => ['agents', id, 'delete-impact'] as const;
const agentSchedulesKey = (id: string, status: ScheduleListStatusFilter) =>
  ['agents', id, 'schedules', status] as const;
export function useAgents() {
  return useQuery({
    queryKey: agentsKey,
    queryFn: async () => {
      const res = await api<{ agents: AgentDto[] }>('/api/agents');
      return res.agents;
    },
  });
}

export function useAgent(agentId: string | null) {
  return useQuery({
    queryKey: agentId ? agentKey(agentId) : ['agents', 'none'],
    enabled: !!agentId,
    queryFn: async () => {
      const res = await api<{ agent: AgentDto }>(`/api/agents/${agentId}`);
      return res.agent;
    },
  });
}

export function useCreateAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateAgentInput) => {
      const res = await api<{ agent: AgentDto; dm_channel_id: string }>(
        '/api/agents',
        { method: 'POST', body: JSON.stringify(input) },
      );
      return res;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: agentsKey });
      qc.invalidateQueries({ queryKey: ['channels'] });
    },
  });
}

export function useUpdateAgent(agentId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateAgentInput) => {
      if (!agentId) throw new Error('no agent id');
      const res = await api<{ agent: AgentDto }>(`/api/agents/${agentId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      });
      return res.agent;
    },
    onSuccess: () => {
      if (!agentId) return;
      qc.invalidateQueries({ queryKey: agentsKey });
      qc.invalidateQueries({ queryKey: agentKey(agentId) });
    },
  });
}

export function useAgentWorkspace(agentId: string | null) {
  return useQuery({
    queryKey: agentId ? agentWorkspaceKey(agentId) : ['agents', 'none', 'workspace'],
    enabled: !!agentId,
    queryFn: async () => {
      const res = await api<{ workspace: AgentWorkspaceDto }>(
        `/api/agents/${agentId}/workspace`,
      );
      return res.workspace;
    },
    // Workspace files change rarely from the UI's POV (agent edits
    // them via tool use); a 30s stale window is plenty and avoids
    // refetching every focus change.
    staleTime: 30_000,
  });
}

export function useAgentRuntimeState(agentId: string | null) {
  return useQuery({
    queryKey: agentId
      ? agentRuntimeStateKey(agentId)
      : ['agents', 'none', 'runtime-state'],
    enabled: !!agentId,
    queryFn: async () => {
      const res = await api<AgentRuntimeStateDto>(
        `/api/agents/${agentId}/runtime-state`,
      );
      return res;
    },
    // Status / pid change as soon as the user clicks Stop or a conversation
    // spawns, so refetch on focus + every 5s while mounted.
    staleTime: 2_000,
    refetchInterval: 5_000,
  });
}

export function useStopAgent(agentId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      if (!agentId) throw new Error('no agent id');
      return api<{ stopped: number }>(`/api/agents/${agentId}/stop`, {
        method: 'POST',
      });
    },
    onSuccess: () => {
      if (!agentId) return;
      qc.invalidateQueries({ queryKey: agentRuntimeStateKey(agentId) });
    },
  });
}

export function useAgentDeleteImpact(agentId: string | null, enabled = true) {
  return useQuery({
    queryKey: agentId
      ? agentDeleteImpactKey(agentId)
      : ['agents', 'none', 'delete-impact'],
    enabled: !!agentId && enabled,
    queryFn: async () => {
      const res = await api<{ impact: AgentDeleteImpactDto }>(
        `/api/agents/${agentId}/delete-impact`,
      );
      return res.impact;
    },
    // Always refetch when the dialog opens — counts are user-facing
    // and we want them current.
    staleTime: 0,
  });
}

export function useDeleteAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (agentId: string) => {
      await api<void>(`/api/agents/${agentId}`, {
        method: 'DELETE',
        body: JSON.stringify({ confirm: true }),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: agentsKey });
      qc.invalidateQueries({ queryKey: ['channels'] });
    },
  });
}

/** Per-agent schedule list for the panel. Default filter `active`
 *  matches the common case "what does this agent still have on the
 *  books"; users can flip to `all` to inspect terminal rows.
 *
 *  Polling cadence: 30s. The scheduler tick + sweep operate at 60s,
 *  so 30s gives at-most-30s lag between a fire and the row's
 *  fired_count / next_fire_at refreshing in the UI without burning
 *  HTTP traffic on the much slower human read cadence. */
export function useAgentSchedules(
  agentId: string | null,
  status: ScheduleListStatusFilter = 'active',
) {
  return useQuery({
    queryKey: agentId
      ? agentSchedulesKey(agentId, status)
      : ['agents', 'none', 'schedules', status],
    enabled: !!agentId,
    queryFn: async () => {
      const res = await api<{ schedules: ScheduleDto[] }>(
        `${apiPaths.agentSchedules(agentId!)}?status=${status}`,
      );
      return res.schedules;
    },
    staleTime: 5_000,
    refetchInterval: 30_000,
  });
}

/** User-initiated cancel from the panel. Invalidates every status
 *  filter for the agent because the row's status is what changed —
 *  active list shrinks, cancelled list grows. */
export function useCancelAgentSchedule(agentId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (scheduleId: string) => {
      if (!agentId) throw new Error('no agent id');
      const res = await api<{ schedule: ScheduleDto }>(
        apiPaths.agentScheduleCancel(agentId, scheduleId),
        { method: 'POST' },
      );
      return res.schedule;
    },
    onSuccess: () => {
      if (!agentId) return;
      qc.invalidateQueries({ queryKey: ['agents', agentId, 'schedules'] });
    },
  });
}
