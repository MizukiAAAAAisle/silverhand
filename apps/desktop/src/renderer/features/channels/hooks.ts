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

const channelsKey = ['channels'] as const;
const sessionsKey = (channelId: string) => ['channels', channelId, 'sessions'] as const;
const membersKey = (channelId: string) => ['channels', channelId, 'members'] as const;

export function useChannels() {
  return useQuery({
    queryKey: channelsKey,
    queryFn: async () => {
      const res = await api<{ channels: ChannelDto[] }>('/api/channels');
      return res.channels;
    },
  });
}

export function useCreateChannel() {
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
      qc.setQueryData<ChannelDto[]>(channelsKey, prev => {
        const cur = prev ?? [];
        if (cur.some(c => c.id === res.channel.id)) {
          return cur.map(c => (c.id === res.channel.id ? res.channel : c));
        }
        return [...cur, res.channel];
      });
      await qc.invalidateQueries({ queryKey: channelsKey });
    },
  });
}

export function useDeleteChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api(`/api/channels/${id}`, { method: 'DELETE' });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: channelsKey });
    },
  });
}

export function useRenameChannel() {
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
    onSuccess: channel => {
      qc.invalidateQueries({ queryKey: channelsKey });
      // The channel name shows up inside session messages too (e.g.
      // the rename system broadcast we just emitted), so refresh
      // sessions for this channel as well.
      qc.invalidateQueries({ queryKey: sessionsKey(channel.id) });
    },
  });
}

export function useArchiveChannel() {
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
      qc.invalidateQueries({ queryKey: channelsKey });
    },
  });
}

export function useSessionsForChannel(channelId: string | null) {
  return useQuery({
    queryKey: channelId ? sessionsKey(channelId) : ['channels', 'none', 'sessions'],
    enabled: !!channelId,
    queryFn: async () => {
      const res = await api<{ sessions: SessionDto[] }>(
        `/api/channels/${channelId}/sessions`,
      );
      return res.sessions;
    },
  });
}

export function useCreateSession(channelId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateSessionInput) => {
      if (!channelId) throw new Error('no channel selected');
      const res = await api<{ session: SessionDto }>(
        `/api/channels/${channelId}/sessions`,
        { method: 'POST', body: JSON.stringify(input) },
      );
      return res.session;
    },
    onSuccess: () => {
      if (channelId) qc.invalidateQueries({ queryKey: sessionsKey(channelId) });
    },
  });
}

export function usePinSession(channelId: string | null) {
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
      if (channelId) qc.invalidateQueries({ queryKey: sessionsKey(channelId) });
    },
  });
}

export function useChannelMembers(channelId: string | null) {
  return useQuery({
    queryKey: channelId ? membersKey(channelId) : ['channels', 'none', 'members'],
    enabled: !!channelId,
    queryFn: async () => {
      const res = await api<{ members: AgentDto[] }>(
        `/api/channels/${channelId}/members`,
      );
      return res.members;
    },
  });
}

export function useAddChannelMember(channelId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (agentId: string) => {
      if (!channelId) throw new Error('no channel selected');
      const res = await api<{ member: ChannelMemberDto }>(
        `/api/channels/${channelId}/members`,
        { method: 'POST', body: JSON.stringify({ agent_id: agentId }) },
      );
      return res.member;
    },
    onSuccess: () => {
      if (channelId) qc.invalidateQueries({ queryKey: membersKey(channelId) });
    },
  });
}

export function useRemoveChannelMember(channelId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (agentId: string) => {
      if (!channelId) throw new Error('no channel selected');
      await api(`/api/channels/${channelId}/members/${agentId}`, {
        method: 'DELETE',
      });
    },
    onSuccess: () => {
      if (channelId) qc.invalidateQueries({ queryKey: membersKey(channelId) });
    },
  });
}
