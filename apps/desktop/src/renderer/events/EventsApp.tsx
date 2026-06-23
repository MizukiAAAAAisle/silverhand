import { useEffect, useMemo, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Check, ChevronDown, Pin, PinOff } from 'lucide-react';
import * as Select from '@radix-ui/react-select';
import type {
  AgentDto,
  ChannelConversationDto,
  DmChannelDto,
  WorkspaceDto,
} from '@silverhand/shared';
import { api, getBackendInfo } from '@/lib/api';
import { useAppearance } from '@/hooks/useAppearance';
import { EventStream } from '@/components/dev/EventStream';

type StreamScope = 'channel' | 'thread';
type ChannelLike = ChannelConversationDto | DmChannelDto;

interface ConversationOption {
  id: string;
  title: string;
  workspaceId: string;
  workspaceName: string;
  scope: StreamScope;
  closed_at: number | null;
  created_at: number;
}

interface ActiveConversationSelection {
  workspaceId: string | null;
  conversationId: string | null;
}

interface ConversationGroup {
  workspace: Pick<WorkspaceDto, 'id' | 'name'> | { id: string; name: string };
  conversations: ConversationOption[];
}

/**
 * Standalone window root for the dev-only events viewer. Picks one
 * channel/thread at a time and pipes its realtime events through `<EventStream>`.
 */
export function EventsApp(): JSX.Element {
  useAppearance();

  const { data: info } = useQuery({
    queryKey: ['backend-info'],
    queryFn: getBackendInfo,
  });
  const { data: agents = [] } = useQuery({
    queryKey: ['agents'],
    queryFn: async () => {
      const res = await api<{ agents: AgentDto[] }>('/api/agents');
      return res.agents;
    },
  });
  const agentsById = useMemo(() => new Map(agents.map(a => [a.id, a])), [agents]);

  const workspacesQuery = useQuery({
    queryKey: ['events', 'workspaces'],
    queryFn: async () => {
      const res = await api<{ workspaces: WorkspaceDto[] }>('/api/workspaces');
      return res.workspaces;
    },
  });
  const workspaces = workspacesQuery.data ?? [];

  const channelQueries = useQueries({
    queries: workspaces.map(w => ({
      queryKey: ['events', 'workspaces', w.id, 'channels'] as const,
      queryFn: async () => {
        const res = await api<{ channels: ChannelLike[] }>(
          `/api/workspaces/${w.id}/channels`,
        );
        return res.channels;
      },
    })),
  });

  const [activeConversation, setActiveConversation] =
    useState<ActiveConversationSelection>(() => initialActiveConversationFromUrl());
  const conversationId = activeConversation.conversationId;

  const activeConversationQuery = useQuery({
    queryKey: ['events', 'conversation', conversationId],
    enabled: !!conversationId,
    retry: false,
    queryFn: async (): Promise<ConversationOption> => {
      if (!conversationId) throw new Error('missing conversation id');
      // The legacy isolated-thread viewer was retired, so only channels
      // resolve here. A fossil-thread id throws and the events panel shows
      // no selection (retry:false) — the degraded behavior for fossils.
      const res = await api<{ channel: ChannelLike }>(`/api/channels/${conversationId}`);
      return optionFromChannel(
        res.channel,
        workspaces.find(w => w.id === res.channel.workspace_id)?.name,
      );
    },
  });

  const groups = useMemo<ConversationGroup[]>(() => {
    const out: ConversationGroup[] = [];

    for (let i = 0; i < workspaces.length; i += 1) {
      const workspace = workspaces[i]!;
      const conversations = (channelQueries[i]?.data ?? [])
        .map(channel => optionFromChannel(channel, workspace.name))
        .sort((a, b) => b.created_at - a.created_at);
      if (conversations.length > 0) out.push({ workspace, conversations });
    }

    return out;
  }, [channelQueries, workspaces]);

  const allOptions = useMemo<ConversationOption[]>(
    () => groups.flatMap(g => g.conversations),
    [groups],
  );
  const selectedOption =
    allOptions.find(o => o.id === conversationId) ??
    activeConversationQuery.data ??
    null;
  const streamScope = selectedOption?.scope ?? 'channel';

  useEffect(() => {
    return window.agentHub.onActiveConversation(active => {
      setActiveConversation({
        workspaceId: active.workspaceId,
        conversationId: active.conversationId,
      });
    });
  }, []);

  useEffect(() => {
    if (conversationId || allOptions.length === 0) return;
    const first = allOptions[0]!;
    setActiveConversation({
      workspaceId: first.workspaceId,
      conversationId: first.id,
    });
  }, [allOptions, conversationId]);

  const pickerLoading =
    workspacesQuery.isLoading ||
    channelQueries.some(q => q.isLoading) ||
    activeConversationQuery.isLoading;
  const pickerError =
    workspacesQuery.isError ||
    channelQueries.some(q => q.isError);
  const triggerLabel =
    selectedOption
      ? `${selectedOption.scope === 'thread' ? 'Thread' : '#'}${selectedOption.workspaceName} · ${selectedOption.title}`
      : conversationId
        ? pickerLoading
          ? '加载中…'
          : 'conversation unavailable'
        : '— 选择 channel —';
  const selectDisabled = groups.length === 0 && pickerLoading;
  const handleConversationChange = (value: string): void => {
    const option = allOptions.find(o => o.id === value);
    setActiveConversation({
      workspaceId: option?.workspaceId ?? activeConversation.workspaceId,
      conversationId: value || null,
    });
  };

  const [pinned, setPinned] = useState(false);
  const togglePin = (): void => {
    const next = !pinned;
    setPinned(next);
    void window.agentHub.setWindowAlwaysOnTop(next);
  };

  return (
    <div className="flex h-screen flex-col bg-bg-base text-text-primary">
      <header className="flex shrink-0 items-center gap-2 border-b border-border-subtle bg-bg-primary px-3 py-2 text-xs">
        <span className="text-[10px] font-medium uppercase tracking-wider text-text-muted">
          Events
        </span>

        <Select.Root
          value={conversationId ?? ''}
          onValueChange={handleConversationChange}
        >
          <Select.Trigger
            aria-label="选择 channel"
            disabled={selectDisabled}
            className="flex min-w-0 flex-1 items-center justify-between gap-2 rounded-[var(--control-radius)] border border-border-subtle bg-bg-floating px-2.5 py-1.5 text-sm text-text-primary outline-none transition-colors hover:border-border focus:border-border-focus data-[placeholder]:text-text-muted"
          >
            <span
              className={
                'min-w-0 flex-1 truncate ' +
                (selectedOption ? 'text-text-primary' : 'text-text-muted')
              }
            >
              {triggerLabel}
            </span>
            <Select.Icon>
              <ChevronDown className="size-3.5 text-text-muted" />
            </Select.Icon>
          </Select.Trigger>
          <Select.Portal>
            <Select.Content
              position="popper"
              sideOffset={4}
              className="z-50 max-h-[60vh] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-md border border-border bg-bg-floating shadow-popover"
            >
              <Select.Viewport className="p-1">
                {groups.length === 0 ? (
                  <div className="px-2 py-3 text-center text-xs text-text-muted">
                    {pickerLoading ? '加载 channel 中…' : '没有可用的 channel'}
                  </div>
                ) : (
                  <>
                    {pickerError ? (
                      <div className="px-2 py-1.5 text-xs text-warning">
                        部分 channel 加载失败
                      </div>
                    ) : null}
                    {groups.map((g, gi) => (
                      <Select.Group key={g.workspace.id}>
                        {gi > 0 ? (
                          <Select.Separator className="my-1 h-px bg-border-subtle" />
                        ) : null}
                        <Select.Label className="px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-text-muted">
                          {g.workspace.name}
                        </Select.Label>
                        {g.conversations.map(option => (
                          <ConversationItem key={option.id} option={option} />
                        ))}
                      </Select.Group>
                    ))}
                  </>
                )}
              </Select.Viewport>
            </Select.Content>
          </Select.Portal>
        </Select.Root>

        <button
          type="button"
          onClick={togglePin}
          aria-pressed={pinned}
          title={pinned ? '取消置顶' : '窗口置顶'}
          className={
            'flex size-7 shrink-0 items-center justify-center rounded-[var(--control-radius)] border transition-colors ' +
            (pinned
              ? 'border-accent bg-accent/10 text-accent'
              : 'border-border-subtle text-text-muted hover:border-border hover:text-text-primary')
          }
        >
          {pinned ? <Pin className="size-3.5" /> : <PinOff className="size-3.5" />}
        </button>
      </header>

      <div className="flex shrink-0 items-center justify-between border-b border-border-subtle bg-bg-primary px-3 py-1 text-[10px] text-text-muted">
        <span>backend</span>
        <span className="font-mono">{info?.url ?? '—'}</span>
      </div>

      <div className="flex-1 overflow-hidden">
        <EventStream
          conversationId={conversationId}
          scope={streamScope}
          agentsById={agentsById}
        />
      </div>
    </div>
  );
}

function optionFromChannel(
  channel: ChannelLike,
  workspaceName?: string,
): ConversationOption {
  const isDm = channel.kind === 'dm_channel';
  return {
    id: channel.id,
    title: channel.title,
    workspaceId: isDm ? channel.id : channel.workspace_id,
    workspaceName: isDm ? 'Direct Messages' : (workspaceName ?? channel.workspace_id),
    scope: 'channel',
    closed_at: channel.closed_at,
    created_at: channel.created_at,
  };
}

function initialActiveConversationFromUrl(): ActiveConversationSelection {
  const params = new URLSearchParams(window.location.search);
  return {
    workspaceId: cleanParam(params.get('workspaceId')),
    conversationId: cleanParam(params.get('conversationId')),
  };
}

function cleanParam(value: string | null): string | null {
  return value && value.trim() ? value : null;
}

function ConversationItem({
  option,
}: {
  option: ConversationOption;
}): JSX.Element {
  const closed = option.closed_at !== null;
  return (
    <Select.Item
      value={option.id}
      className={
        'relative flex cursor-default select-none items-center gap-2 rounded px-2 py-1.5 text-sm outline-none ' +
        'data-[highlighted]:bg-bg-hover data-[state=checked]:text-accent ' +
        (closed ? 'text-text-muted' : 'text-text-primary')
      }
    >
      <Select.ItemIndicator className="absolute left-0 flex w-4 items-center justify-center">
        <Check className="size-3.5" />
      </Select.ItemIndicator>
      <Select.ItemText>
        <span className={'pl-4 ' + (closed ? 'line-through' : '')}>
          {option.title}
        </span>
      </Select.ItemText>
    </Select.Item>
  );
}
