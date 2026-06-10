import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import type {
  AddWorkspaceMemberInput,
  AgentCapabilitiesDto,
  AgentCapability,
  AgentDto,
  ArchivedChannelListItemDto,
  ChannelConversationDto,
  ChannelLikeDto,
  CreateConversationChannelInput,
  CreateWorkspaceInput,
  DmChannelDto,
  ThreadDto,
  UpdateAgentCapabilitiesInput,
  UpdateWorkspaceInput,
  WorkspaceDto,
  WorkspaceHumanMemberDto,
  WorkspaceMembersResponse,
  WorkspaceRole,
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
  pinned_at: number | null;
  archived_at: number | null;
  created_at: number;
  updated_at: number;
};

export type ChannelListItem = ChannelConversationDto | DmChannelDto | ThreadDto;

const workspacesKey = ['workspaces'] as const;
const channelsKey = (workspaceId: string) => ['workspaces', workspaceId, 'channels'] as const;
const archivedChannelsKey = (workspaceId: string) =>
  ['workspaces', workspaceId, 'channels', 'archived'] as const;
const archivedChannelsIndexKey = (workspaceId: string | null, since: number | null) =>
  ['archived-channels', { workspaceId, since }] as const;
const membersKey = (workspaceId: string) => ['workspaces', workspaceId, 'members'] as const;
const capabilitiesKey = (workspaceId: string, agentId: string) =>
  ['workspaces', workspaceId, 'agents', agentId, 'capabilities'] as const;

/** Human workspace member (canonical shared shape): `UserDto` display
 *  fields PLUS the graded-permissions membership `role`. */
export type WorkspaceHumanMember = WorkspaceHumanMemberDto;

export interface WorkspaceMemberLists {
  agents: AgentDto[];
  humans: WorkspaceHumanMember[];
  /** Current viewer's role in this workspace (request-scoped sugar from the
   *  members endpoint). `null` = not a member → read-only. */
  viewerRole: WorkspaceRole | null;
}

function normalizeWorkspaceMembers(
  response: WorkspaceMembersResponse,
): WorkspaceMemberLists {
  return {
    agents: response.members,
    humans: response.human_members,
    viewerRole: response.viewer_role,
  };
}

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
    pinned_at: workspace.pinned_at,
    archived_at: workspace.archived_at,
    created_at: workspace.created_at,
    updated_at: workspace.updated_at,
  };
}

export function sortConversationList(items: ChannelListItem[]): ChannelListItem[] {
  const byId = new Map(items.map(item => [item.id, item] as const));
  const topFor = (item: ChannelListItem): ChannelListItem =>
    item.kind === 'thread' && item.parent_conversation_id
      ? byId.get(item.parent_conversation_id) ?? item
      : item;
  const compareTop = (a: ChannelListItem, b: ChannelListItem): number => {
    const aPinned = a.pinned_at !== null;
    const bPinned = b.pinned_at !== null;
    if (aPinned !== bPinned) return aPinned ? -1 : 1;
    if (a.pinned_at !== null && b.pinned_at !== null && a.pinned_at !== b.pinned_at) {
      return b.pinned_at - a.pinned_at;
    }
    return a.created_at - b.created_at;
  };

  return [...items].sort((a, b) => {
    const aTop = topFor(a);
    const bTop = topFor(b);
    if (aTop.id !== bTop.id) return compareTop(aTop, bTop);
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

export function usePinWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, pinned }: { id: string; pinned: boolean }) => {
      const res = await api<{ workspace: WorkspaceDto }>(
        apiPaths.workspacePin(id),
        { method: pinned ? 'POST' : 'DELETE' },
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
        void qc.invalidateQueries({ queryKey: archivedChannelsKey(workspaceId) });
        void qc.invalidateQueries({ queryKey: ['archived-channels'] });
      } else if (frame.type === 'snapshot_required' && frame.scope === scope) {
        void qc.invalidateQueries({ queryKey: channelsKey(workspaceId) });
        void qc.invalidateQueries({ queryKey: archivedChannelsKey(workspaceId) });
        void qc.invalidateQueries({ queryKey: ['archived-channels'] });
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

/** Archived channels (and their threads) for a regular workspace.
 *  Backed by `GET /api/workspaces/:id/channels/archived`. agent_home /
 *  DM workspaces always return an empty list. WS invalidation lives on
 *  `useChannelsForWorkspace` — both queries share the same trigger. */
export function useArchivedChannelsForWorkspace(
  workspaceId: string | null,
  workspaceKind: 'regular' | 'dm' | null = 'regular',
) {
  return useQuery<ChannelListItem[]>({
    queryKey: workspaceId
      ? archivedChannelsKey(workspaceId)
      : ['workspaces', 'none', 'channels', 'archived'],
    enabled: !!workspaceId && workspaceKind === 'regular',
    queryFn: async () => {
      const res = await api<{
        channels: ChannelLikeDto[];
        threads: ThreadDto[];
      }>(apiPaths.workspaceArchivedChannels(workspaceId!));
      return sortConversationList([...res.channels, ...res.threads]);
    },
  });
}

export function useArchivedChannelsIndex({
  workspaceId,
  since,
  workspaceScopeIds,
}: {
  workspaceId: string | null;
  since: number | null;
  workspaceScopeIds: string[];
}) {
  const qc = useQueryClient();
  useEffect(() => {
    const scopeIds = workspaceId ? [workspaceId] : workspaceScopeIds;
    if (scopeIds.length === 0) return;
    const subscriptions = scopeIds.map(id => subscribeWsScope(`workspace:${id}`));
    const unsub = onWsFrame(frame => {
      if (frame.type === 'event') {
        if (frame.kind !== 'workspace_channels_changed') return;
        if (!scopeIds.some(id => frame.scope === `workspace:${id}`)) return;
        void qc.invalidateQueries({ queryKey: ['archived-channels'] });
      } else if (
        frame.type === 'snapshot_required' &&
        scopeIds.some(id => frame.scope === `workspace:${id}`)
      ) {
        void qc.invalidateQueries({ queryKey: ['archived-channels'] });
      }
    });
    return () => {
      for (const sub of subscriptions) sub.unsubscribe();
      unsub();
    };
  }, [qc, workspaceId, workspaceScopeIds]);

  return useQuery<ArchivedChannelListItemDto[]>({
    queryKey: archivedChannelsIndexKey(workspaceId, since),
    queryFn: async () => {
      const params = new URLSearchParams();
      if (workspaceId) params.set('workspace_id', workspaceId);
      if (since !== null) params.set('since', String(since));
      const suffix = params.toString();
      const res = await api<{ channels: ArchivedChannelListItemDto[] }>(
        suffix ? `${apiPaths.archivedChannels}?${suffix}` : apiPaths.archivedChannels,
      );
      return res.channels;
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

export function useArchiveChannel(workspaceId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      channelId,
      archived,
    }: {
      channelId: string;
      archived: boolean;
      workspaceId?: string;
    }) => {
      const res = await api<{ channel: ChannelConversationDto }>(
        apiPaths.channelArchive(channelId),
        { method: 'PATCH', body: JSON.stringify({ archived }) },
      );
      return res.channel;
    },
    onSuccess: (channel, vars) => {
      const targetWorkspaceId = vars.workspaceId ?? channel.workspace_id ?? workspaceId;
      // Active and archived lists are disjoint contracts on the server;
      // refresh both so the row leaves one and appears in the other
      // immediately, even before the WS event arrives.
      if (targetWorkspaceId) {
        qc.invalidateQueries({ queryKey: channelsKey(targetWorkspaceId) });
        qc.invalidateQueries({ queryKey: archivedChannelsKey(targetWorkspaceId) });
      }
      qc.invalidateQueries({ queryKey: ['archived-channels'] });
    },
  });
}

export function useWorkspaceMembers(workspaceId: string | null) {
  return useQuery({
    queryKey: workspaceId ? membersKey(workspaceId) : ['workspaces', 'none', 'members'],
    enabled: !!workspaceId,
    queryFn: async () => {
      const res = await api<WorkspaceMembersResponse>(
        apiPaths.workspaceMembers(workspaceId!),
      );
      return res;
    },
    select: res => res.members,
  });
}

export function useWorkspaceMemberLists(workspaceId: string | null) {
  return useQuery({
    queryKey: workspaceId ? membersKey(workspaceId) : ['workspaces', 'none', 'members'],
    enabled: !!workspaceId,
    queryFn: async () =>
      api<WorkspaceMembersResponse>(apiPaths.workspaceMembers(workspaceId!)),
    select: normalizeWorkspaceMembers,
  });
}

export function useAddWorkspaceMember(workspaceId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: AddWorkspaceMemberInput) => {
      if (!workspaceId) throw new Error('no workspace selected');
      // Backend returns `{member, human_member}` for the human branch
      // and `{member}` for both agent shapes (legacy `{agent_id}` and
      // tagged `{kind:'agent', agent_id}`). Renderer doesn't need the
      // exact response — it invalidates the workspace-members query so
      // the next fetch reseats both `agents` and `humans`.
      await api<unknown>(
        apiPaths.workspaceMembers(workspaceId),
        { method: 'POST', body: JSON.stringify(input) },
      );
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

/** The effective capability set of one agent in one workspace (GET).
 *  Any workspace viewer may read; editing is gated on the human role. */
export function useAgentCapabilities(
  workspaceId: string | null,
  agentId: string | null,
) {
  return useQuery({
    queryKey:
      workspaceId && agentId
        ? capabilitiesKey(workspaceId, agentId)
        : ['workspaces', 'none', 'agents', 'none', 'capabilities'],
    enabled: !!workspaceId && !!agentId,
    queryFn: () =>
      api<AgentCapabilitiesDto>(
        apiPaths.workspaceAgentCapabilities(workspaceId!, agentId!),
      ),
  });
}

/** Replace-set edit of an agent's capabilities (PUT). The caller sends the
 *  FULL desired set; the backend diffs against stored rows. On success the
 *  returned DTO seats the cache; on failure the mutation rejects and the
 *  caller is responsible for rollback + refetch (see `AgentPermissionsPanel`). */
export function useUpdateAgentCapabilities(workspaceId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      agentId: string;
      capabilities: AgentCapability[];
    }) => {
      if (!workspaceId) throw new Error('no workspace selected');
      const body: UpdateAgentCapabilitiesInput = {
        capabilities: vars.capabilities,
      };
      return api<AgentCapabilitiesDto>(
        apiPaths.workspaceAgentCapabilities(workspaceId, vars.agentId),
        { method: 'PUT', body: JSON.stringify(body) },
      );
    },
    onSuccess: (dto, vars) => {
      if (workspaceId) {
        qc.setQueryData(capabilitiesKey(workspaceId, vars.agentId), dto);
      }
    },
  });
}
