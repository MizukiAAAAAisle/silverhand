import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import type {
  AgentDto,
  ChannelConversationDto,
  ChannelLikeDto,
  CreateConversationChannelInput,
  CreateWorkspaceInput,
  DmChannelDto,
  ThreadDto,
  UpdateWorkspaceInput,
  WorkspaceDto,
  WorkspaceMemberDto,
} from '@silverhand/shared';
import { apiPaths } from '@silverhand/shared';
import { api } from '@/lib/api';
import { onWsFrame, subscribeWsScope } from '@/lib/ws-client';

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
  const isDm = workspace.workspace_kind === 'agent_home';
  return {
    id: workspace.id,
    name: isDm ? `dm-${workspace.name}` : workspace.name,
    description: workspace.description,
    kind: isDm ? 'dm' : 'regular',
    workspace_scope_ids: [workspace.id],
    workspace_path: workspace.workspace_path,
    workspace_host_id: workspace.workspace_host_id,
    dm_agent_id: workspace.owner_agent_id,
    dm_channel_ids:
      workspace.dm_channel_ids ?? (workspace.dm_channel_id ? [workspace.dm_channel_id] : []),
    archived_at: workspace.archived_at,
    created_at: workspace.created_at,
    updated_at: workspace.updated_at,
  };
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
      const res = await api<{ workspaces: WorkspaceDto[] }>(apiPaths.workspaces);
      return res.workspaces.map(workspaceToListItem);
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
  const qc = useQueryClient();
  useEffect(() => {
    if (!workspaceId || workspaceKind === null) return;
    const scope = `workspace:${workspaceId}`;
    const sub = subscribeWsScope(scope);
    const unsub = onWsFrame(frame => {
      if (frame.type === 'event') {
        if (frame.scope !== scope || frame.kind !== 'workspace_channels_changed') return;
        void qc.invalidateQueries({ queryKey: channelsKey(workspaceId) });
      } else if (frame.type === 'snapshot_required' && frame.scope === scope) {
        void qc.invalidateQueries({ queryKey: channelsKey(workspaceId) });
      }
    });
    return () => {
      sub.unsubscribe();
      unsub();
    };
  }, [qc, workspaceId, workspaceKind]);

  return useQuery<ChannelListItem[]>({
    queryKey: workspaceId ? channelsKey(workspaceId) : ['workspaces', 'none', 'channels'],
    enabled: !!workspaceId && workspaceKind !== null,
    queryFn: async () => {
      const res = await api<{
        channels: ChannelLikeDto[];
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
      const res = await api<{ channel: ChannelLikeDto }>(
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
