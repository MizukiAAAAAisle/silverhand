import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AgentDto,
  ChannelDto,
  ChannelMemberDto,
  CreateChannelInput,
  CreateSessionInput,
  SessionDto,
  UpdateChannelInput,
} from '@silverhand/shared';
import { api } from '@/lib/api';

const workspacesKey = ['workspaces'] as const;
const channelsKey = (workspaceId: string) => ['workspaces', workspaceId, 'channels'] as const;
const membersKey = (workspaceId: string) => ['workspaces', workspaceId, 'members'] as const;

/** Returns all workspaces (backed by the legacy /api/channels endpoint, returns ChannelDto[]). */
export function useWorkspaces() {
  return useQuery({
    queryKey: workspacesKey,
    queryFn: async () => {
      const res = await api<{ channels: ChannelDto[] }>('/api/channels');
      return res.channels;
    },
  });
}

export function useCreateWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateChannelInput) => {
      const res = await api<{ channel: ChannelDto; onboarding_session_id: string }>(
        '/api/channels',
        { method: 'POST', body: JSON.stringify(input) },
      );
      return res;
    },
    onSuccess: async res => {
      qc.setQueryData<ChannelDto[]>(workspacesKey, prev => {
        const cur = prev ?? [];
        if (cur.some(c => c.id === res.channel.id)) {
          return cur.map(c => (c.id === res.channel.id ? res.channel : c));
        }
        return [...cur, res.channel];
      });
      await qc.invalidateQueries({ queryKey: workspacesKey });
    },
  });
}

export function useDeleteWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api(`/api/channels/${id}`, { method: 'DELETE' });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: workspacesKey });
    },
  });
}

export function useRenameWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { id: string } & UpdateChannelInput) => {
      const { id, ...body } = vars;
      const res = await api<{ channel: ChannelDto }>(`/api/channels/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      return res.channel;
    },
    onSuccess: workspace => {
      qc.invalidateQueries({ queryKey: workspacesKey });
      // The workspace name shows up inside channel messages too (e.g.
      // the rename system broadcast we just emitted), so refresh
      // channels for this workspace as well.
      qc.invalidateQueries({ queryKey: channelsKey(workspace.id) });
    },
  });
}

export function useArchiveWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { id: string; archived: boolean }) => {
      const res = await api<{ channel: ChannelDto }>(
        `/api/channels/${vars.id}/archive`,
        {
          method: 'PATCH',
          body: JSON.stringify({ archived: vars.archived }),
        },
      );
      return res.channel;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: workspacesKey });
    },
  });
}

export function useChannelsForWorkspace(workspaceId: string | null) {
  return useQuery({
    queryKey: workspaceId ? channelsKey(workspaceId) : ['workspaces', 'none', 'channels'],
    enabled: !!workspaceId,
    queryFn: async () => {
      const res = await api<{ sessions: SessionDto[] }>(
        `/api/channels/${workspaceId}/sessions`,
      );
      return res.sessions;
    },
  });
}

export function useCreateChannel(workspaceId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateSessionInput) => {
      if (!workspaceId) throw new Error('no workspace selected');
      const res = await api<{ session: SessionDto }>(
        `/api/channels/${workspaceId}/sessions`,
        { method: 'POST', body: JSON.stringify(input) },
      );
      return res.session;
    },
    onSuccess: () => {
      if (workspaceId) qc.invalidateQueries({ queryKey: channelsKey(workspaceId) });
    },
  });
}

export function usePinChannel(workspaceId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ sessionId, pinned }: { sessionId: string; pinned: boolean }) => {
      const res = await api<{ session: SessionDto }>(
        `/api/sessions/${sessionId}/pin`,
        { method: pinned ? 'POST' : 'DELETE' },
      );
      return res.session;
    },
    onSuccess: () => {
      if (workspaceId) qc.invalidateQueries({ queryKey: channelsKey(workspaceId) });
    },
  });
}

export function useWorkspaceMembers(workspaceId: string | null) {
  return useQuery({
    queryKey: workspaceId ? membersKey(workspaceId) : ['workspaces', 'none', 'members'],
    enabled: !!workspaceId,
    queryFn: async () => {
      const res = await api<{ members: AgentDto[] }>(
        `/api/channels/${workspaceId}/members`,
      );
      return res.members;
    },
  });
}

export function useAddWorkspaceMember(workspaceId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (agentId: string) => {
      if (!workspaceId) throw new Error('no workspace selected');
      const res = await api<{ member: ChannelMemberDto }>(
        `/api/channels/${workspaceId}/members`,
        { method: 'POST', body: JSON.stringify({ agent_id: agentId }) },
      );
      return res.member;
    },
    onSuccess: () => {
      if (workspaceId) qc.invalidateQueries({ queryKey: membersKey(workspaceId) });
    },
  });
}

export function useRemoveWorkspaceMember(workspaceId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (agentId: string) => {
      if (!workspaceId) throw new Error('no workspace selected');
      await api(`/api/channels/${workspaceId}/members/${agentId}`, {
        method: 'DELETE',
      });
    },
    onSuccess: () => {
      if (workspaceId) qc.invalidateQueries({ queryKey: membersKey(workspaceId) });
    },
  });
}
