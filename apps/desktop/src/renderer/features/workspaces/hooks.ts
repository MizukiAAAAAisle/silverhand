import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AgentDto,
  ChannelConversationDto,
  DmChannelDto,
  CreateConversationChannelInput,
  CreateWorkspaceInput,
  ThreadDto,
  UpdateWorkspaceInput,
  WorkspaceDto,
  WorkspaceMemberDto,
} from '@silverhand/shared';
import { apiPaths } from '@silverhand/shared';
import { api } from '@/lib/api';

export type WorkspaceListItem = {
  id: string;
  name: string;
  description: string | null;
  kind: 'regular' | 'dm';
  workspace_scope_ids: string[];
  workspace_path: string;
  workspace_host_id: string;
  dm_agent_id: string | null;
  dm_channel_ids: string[];
  archived_at: number | null;
  created_at: number;
  updated_at: number;
};

export type ChannelListItem = ChannelConversationDto | DmChannelDto | ThreadDto;

const workspacesKey = ['workspaces'] as const;
const channelsKey = (workspaceId: string) => ['workspaces', workspaceId, 'channels'] as const;
const membersKey = (workspaceId: string) => ['workspaces', workspaceId, 'members'] as const;

function workspaceToListItem(workspace: WorkspaceDto): WorkspaceListItem {
  return {
    id: workspace.id,
    name: workspace.name,
    description: workspace.description,
    kind: 'regular',
    workspace_scope_ids: [workspace.id],
    workspace_path: workspace.workspace_path,
    workspace_host_id: workspace.workspace_host_id,
    dm_agent_id: null,
    dm_channel_ids: [],
    archived_at: workspace.archived_at,
    created_at: workspace.created_at,
    updated_at: workspace.updated_at,
  };
}

function agentIdFromDmChannel(channel: DmChannelDto): string | null {
  const parts = channel.workspace_path.split(/[\\/]/).filter(Boolean);
  const agentsIdx = parts.lastIndexOf('agents');
  return agentsIdx >= 0 ? parts[agentsIdx + 1] ?? null : null;
}

function dmChannelsToWorkspaceItems(
  channels: DmChannelDto[],
  agents: AgentDto[],
): WorkspaceListItem[] {
  const agentsById = new Map(agents.map(agent => [agent.id, agent]));
  const grouped = new Map<string, DmChannelDto[]>();
  for (const channel of channels) {
    const agentId = agentIdFromDmChannel(channel);
    const key = agentId ?? channel.workspace_path;
    grouped.set(key, [...(grouped.get(key) ?? []), channel]);
  }

  return [...grouped.entries()].map(([key, group]) => {
    const first = group[0]!;
    const agent = agentsById.get(key);
    const createdAt = Math.min(...group.map(channel => channel.created_at));
    const updatedAt = Math.max(...group.map(channel => channel.updated_at));
    const allClosed = group.every(channel => channel.closed_at !== null);
    return {
      id: agent ? `dm:${agent.id}` : `dm:${key}`,
      name: agent ? `dm-${agent.name}` : first.title,
      description: null,
      kind: 'dm',
      workspace_scope_ids: [...new Set(group.map(channel => channel.workspace_id))],
      workspace_path: first.workspace_path,
      workspace_host_id: 'local',
      dm_agent_id: agent?.id ?? key,
      dm_channel_ids: group.map(channel => channel.id),
      archived_at: allClosed ? Math.max(...group.map(channel => channel.closed_at ?? 0)) : null,
      created_at: createdAt,
      updated_at: updatedAt,
    };
  });
}

function dmWorkspaceAgentId(workspaceId: string): string | null {
  return workspaceId.startsWith('dm:') ? workspaceId.slice(3) : null;
}

function dmChannelBelongsToWorkspace(channel: DmChannelDto, workspaceId: string): boolean {
  const agentId = dmWorkspaceAgentId(workspaceId);
  if (agentId) return agentIdFromDmChannel(channel) === agentId;
  return channel.id === workspaceId;
}

function sortConversationList(items: ChannelListItem[]): ChannelListItem[] {
  return [...items].sort((a, b) => {
    const aParent = a.kind === 'thread' ? a.parent_conversation_id : a.id;
    const bParent = b.kind === 'thread' ? b.parent_conversation_id : b.id;
    if (aParent !== bParent) return a.created_at - b.created_at;
    if (a.kind !== b.kind) return a.kind === 'thread' ? 1 : -1;
    return a.created_at - b.created_at;
  });
}

export function useWorkspaces() {
  return useQuery({
    queryKey: workspacesKey,
    queryFn: async () => {
      const [regular, dm] = await Promise.all([
        api<{ workspaces: WorkspaceDto[] }>(apiPaths.workspaces),
        api<{ dm_channels: DmChannelDto[] }>(apiPaths.workspaceDmChannels),
      ]);
      const agents = await api<{ agents: AgentDto[] }>(apiPaths.agents).catch(
        () => ({ agents: [] }),
      );
      return [
        ...regular.workspaces.map(workspaceToListItem),
        ...dmChannelsToWorkspaceItems(dm.dm_channels, agents.agents),
      ];
    },
  });
}

export function useCreateWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateWorkspaceInput) => {
      const res = await api<{
        workspace: WorkspaceDto;
        onboarding_channel_id: string;
      }>(
        apiPaths.workspaces,
        { method: 'POST', body: JSON.stringify(input) },
      );
      return res;
    },
    onSuccess: async res => {
      const workspace = workspaceToListItem(res.workspace);
      qc.setQueryData<WorkspaceListItem[]>(workspacesKey, prev => {
        const cur = prev ?? [];
        if (cur.some(c => c.id === workspace.id)) {
          return cur.map(c => (c.id === workspace.id ? workspace : c));
        }
        return [...cur, workspace];
      });
      await qc.invalidateQueries({ queryKey: workspacesKey });
    },
  });
}

export function useDeleteWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api(apiPaths.workspace(id), { method: 'DELETE' });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: workspacesKey });
    },
  });
}

export function useRenameWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { id: string } & UpdateWorkspaceInput) => {
      const { id, ...body } = vars;
      const res = await api<{ workspace: WorkspaceDto }>(apiPaths.workspace(id), {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      return workspaceToListItem(res.workspace);
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
      const res = await api<{ workspace: WorkspaceDto }>(
        `/api/workspaces/${vars.id}/archive`,
        {
          method: 'PATCH',
          body: JSON.stringify({ archived: vars.archived }),
        },
      );
      return workspaceToListItem(res.workspace);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: workspacesKey });
    },
  });
}

export function useChannelsForWorkspace(
  workspaceId: string | null,
  workspaceKind: 'regular' | 'dm' | null = 'regular',
) {
  return useQuery<ChannelListItem[]>({
    queryKey: workspaceId ? channelsKey(workspaceId) : ['workspaces', 'none', 'channels'],
    enabled: !!workspaceId && workspaceKind !== null,
    queryFn: async () => {
      if (workspaceKind === 'dm') {
        const res = await api<{ dm_channels: DmChannelDto[] }>(
          apiPaths.workspaceDmChannels,
        );
        return res.dm_channels.filter(channel =>
          dmChannelBelongsToWorkspace(channel, workspaceId!),
        );
      }
      const res = await api<{
        channels: ChannelConversationDto[];
        threads: ThreadDto[];
      }>(
        apiPaths.workspaceChannels(workspaceId!),
      );
      return sortConversationList([...res.channels, ...res.threads]);
    },
  });
}

export function useCreateChannel(workspaceId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateConversationChannelInput) => {
      if (!workspaceId) throw new Error('no workspace selected');
      const res = await api<{ channel: ChannelConversationDto }>(
        apiPaths.workspaceChannels(workspaceId),
        { method: 'POST', body: JSON.stringify(input) },
      );
      return res.channel;
    },
    onSuccess: () => {
      if (workspaceId) qc.invalidateQueries({ queryKey: channelsKey(workspaceId) });
    },
  });
}

export function usePinChannel(workspaceId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ channelId, pinned }: { channelId: string; pinned: boolean }) => {
      const res = await api<{ channel: ChannelConversationDto | DmChannelDto }>(
        `/api/channels/${channelId}/pin`,
        { method: pinned ? 'POST' : 'DELETE' },
      );
      return res.channel;
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
        apiPaths.workspaceMembers(workspaceId!),
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
      const res = await api<{ member: WorkspaceMemberDto }>(
        apiPaths.workspaceMembers(workspaceId),
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
      await api(apiPaths.workspaceMember(workspaceId, agentId), {
        method: 'DELETE',
      });
    },
    onSuccess: () => {
      if (workspaceId) qc.invalidateQueries({ queryKey: membersKey(workspaceId) });
    },
  });
}
