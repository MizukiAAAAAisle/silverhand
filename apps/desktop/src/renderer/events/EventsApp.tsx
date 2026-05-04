import { useEffect, useMemo, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Check, ChevronDown, Pin, PinOff } from 'lucide-react';
import * as Select from '@radix-ui/react-select';
import type { AgentDto, ChannelDto, SessionDto } from '@silverhand/shared';
import { api, getBackendInfo } from '@/lib/api';
import { useAppearance } from '@/hooks/useAppearance';
import { EventStream } from '@/components/dev/EventStream';

interface SessionOption {
  channelName: string;
  session: SessionDto;
}

interface ActiveSessionSelection {
  channelId: string | null;
  sessionId: string | null;
}

interface SessionGroup {
  channel: Pick<ChannelDto, 'id' | 'name'>;
  sessions: SessionDto[];
}

/**
 * Standalone window root for the dev-only events viewer. Picks one
 * session at a time and pipes its SSE feed through `<EventStream>`.
 *
 * Single-window flow: opened via the macOS app menu (View → Developer
 * → Show Events Window). Cold start receives the main window's active
 * session through the URL query; already-open windows receive selection
 * changes over IPC. Pin toggle on the right of the titlebar flips the
 * window's always-on-top state via the `window:setAlwaysOnTop` preload
 * bridge.
 */
export function EventsApp(): JSX.Element {
  // Inherit theme tokens from main window (shares localStorage).
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
  const agentsById = useMemo(() => {
    return new Map(agents.map(a => [a.id, a]));
  }, [agents]);

  const channelsQuery = useQuery({
    queryKey: ['channels'],
    queryFn: async () => {
      const res = await api<{ channels: ChannelDto[] }>('/api/channels');
      return res.channels;
    },
  });
  const channels = channelsQuery.data ?? [];
  const [activeSession, setActiveSession] = useState<ActiveSessionSelection>(() =>
    initialActiveSessionFromUrl(),
  );
  const sessionId = activeSession.sessionId;

  const selectedSessionQuery = useQuery({
    queryKey: ['sessions', sessionId],
    enabled: !!sessionId,
    retry: false,
    queryFn: async () => {
      if (!sessionId) throw new Error('missing session id');
      const res = await api<{ session: SessionDto }>(`/api/sessions/${sessionId}`);
      return res.session;
    },
  });

  // Fan out one query per channel so the picker can group sessions by
  // channel without inventing a new aggregate endpoint.
  const sessionQueries = useQueries({
    queries: channels.map(c => ({
      queryKey: ['channels', c.id, 'sessions'] as const,
      queryFn: async () => {
        const res = await api<{ sessions: SessionDto[] }>(
          `/api/channels/${c.id}/sessions`,
        );
        return res.sessions;
      },
    })),
  });

  const activeChannelId =
    activeSession.channelId ?? selectedSessionQuery.data?.channel_id ?? null;
  // Events runs in a separate renderer with an empty QueryClient. Fetch
  // the active channel's sessions directly so the picker has real rows
  // during cold start instead of relying only on the selected-session
  // label fallback while the channel fan-out catches up.
  const activeChannelSessionsQuery = useQuery({
    queryKey: activeChannelId
      ? (['channels', activeChannelId, 'sessions'] as const)
      : (['channels', 'none', 'sessions'] as const),
    enabled: !!activeChannelId,
    queryFn: async () => {
      if (!activeChannelId) throw new Error('missing channel id');
      const res = await api<{ sessions: SessionDto[] }>(
        `/api/channels/${activeChannelId}/sessions`,
      );
      return res.sessions;
    },
  });

  // Group sessions by channel for the Select dropdown. The active
  // channel query and direct selected-session query are merged in with
  // id-based de-duping so the cold-start fallback never creates duplicate
  // rows once the fan-out query resolves.
  const groups = useMemo(() => {
    const out: SessionGroup[] = channels
      .map((c, i) => {
        const sessions = (sessionQueries[i]?.data ?? []).slice().sort(
          (a, b) => b.created_at - a.created_at,
        );
        return { channel: c, sessions };
      })
      .filter(g => g.sessions.length > 0);

    if (activeChannelId) {
      const activeChannel =
        channels.find(c => c.id === activeChannelId) ??
        ({
          id: activeChannelId,
          name: activeChannelId.slice(0, 6),
        } satisfies Pick<ChannelDto, 'id' | 'name'>);
      const activeSessions = activeChannelSessionsQuery.data ?? [];
      const selectedSession =
        selectedSessionQuery.data?.channel_id === activeChannelId
          ? selectedSessionQuery.data
          : null;
      const mergedSessions = mergeSessions(
        activeSessions,
        selectedSession ? [selectedSession] : [],
      );

      if (mergedSessions.length > 0) {
        const existing = out.find(g => g.channel.id === activeChannelId);
        if (existing) {
          existing.sessions = mergeSessions(existing.sessions, mergedSessions);
        } else {
          out.unshift({ channel: activeChannel, sessions: mergedSessions });
        }
      }
    }

    return out;
  }, [
    activeChannelId,
    activeChannelSessionsQuery.data,
    channels,
    selectedSessionQuery.data,
    sessionQueries,
  ]);

  const allOptions = useMemo<SessionOption[]>(() => {
    const out: SessionOption[] = [];
    for (const g of groups) {
      for (const s of g.sessions) {
        out.push({ channelName: g.channel.name, session: s });
      }
    }
    return out;
  }, [groups]);

  const selectedOption =
    allOptions.find(o => o.session.id === sessionId) ?? null;

  useEffect(() => {
    return window.agentHub.onActiveSession(active => {
      setActiveSession({
        channelId: active.channelId,
        sessionId: active.sessionId,
      });
    });
  }, []);

  // Auto-pick the most recently-created session once the list arrives
  // so the SSE feed starts immediately when no active-session hint was
  // provided. If a URL/IPC hint exists, keep it while the per-channel
  // queries catch up.
  useEffect(() => {
    if (sessionId) return;
    if (allOptions.length === 0) return;
    const first = allOptions[0]!.session;
    setActiveSession({ channelId: first.channel_id, sessionId: first.id });
  }, [allOptions, sessionId]);

  // If a stale URL/IPC hint points at a deleted session, fall back once
  // all picker data has settled. Valid hints are covered by the direct
  // /api/sessions/:id query below, so they do not get overwritten while
  // the per-channel fan-out is still loading.
  useEffect(() => {
    if (!sessionId) return;
    if (selectedOption || selectedSessionQuery.data) return;
    if (channelsQuery.isLoading || sessionQueries.some(q => q.isLoading)) return;
    if (activeChannelSessionsQuery.isLoading) return;
    if (selectedSessionQuery.isLoading) return;
    if (selectedSessionQuery.isError && allOptions.length > 0) {
      const first = allOptions[0]!.session;
      setActiveSession({ channelId: first.channel_id, sessionId: first.id });
    }
  }, [
    allOptions,
    activeChannelSessionsQuery.isLoading,
    channelsQuery.isLoading,
    selectedOption,
    selectedSessionQuery.data,
    selectedSessionQuery.isError,
    selectedSessionQuery.isLoading,
    sessionId,
    sessionQueries,
  ]);

  const currentLabel = useMemo(() => {
    if (selectedOption) {
      return `#${selectedOption.channelName} · ${selectedOption.session.title}`;
    }
    const session = selectedSessionQuery.data;
    if (!session) return null;
    const channel = channels.find(c => c.id === session.channel_id);
    const channelName = channel?.name ?? session.channel_id.slice(0, 6);
    return `#${channelName} · ${session.title}`;
  }, [channels, selectedOption, selectedSessionQuery.data]);
  const pickerLoading =
    channelsQuery.isLoading ||
    sessionQueries.some(q => q.isLoading) ||
    activeChannelSessionsQuery.isLoading ||
    selectedSessionQuery.isLoading;
  const pickerError =
    channelsQuery.isError ||
    sessionQueries.some(q => q.isError) ||
    activeChannelSessionsQuery.isError;
  const triggerLabel =
    currentLabel ??
    (sessionId
      ? pickerLoading
        ? '加载中…'
        : '会话不可用'
      : '— 选择会话 —');
  const selectDisabled = groups.length === 0 && pickerLoading;
  const handleSessionChange = (value: string): void => {
    const nextSessionId = value || null;
    const option = allOptions.find(o => o.session.id === nextSessionId);
    setActiveSession(prev => ({
      channelId: option?.session.channel_id ?? prev.channelId,
      sessionId: nextSessionId,
    }));
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
          value={sessionId ?? ''}
          onValueChange={handleSessionChange}
        >
          <Select.Trigger
            aria-label="选择会话"
            disabled={selectDisabled}
            className="flex min-w-0 flex-1 items-center justify-between gap-2 rounded-md border border-border-subtle bg-bg-floating px-2.5 py-1.5 text-sm text-text-primary outline-none transition-colors hover:border-border focus:border-border-focus focus:ring-2 focus:ring-border-focus data-[placeholder]:text-text-muted"
          >
            <span
              className={
                'min-w-0 flex-1 truncate ' +
                (currentLabel ? 'text-text-primary' : 'text-text-muted')
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
              className="z-50 max-h-[60vh] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-md border border-border bg-bg-floating shadow-lg"
            >
              <Select.Viewport className="p-1">
                {groups.length === 0 ? (
                  <div className="px-2 py-3 text-center text-xs text-text-muted">
                    {pickerLoading ? '加载会话中…' : '没有可用的会话'}
                  </div>
                ) : (
                  <>
                    {pickerError ? (
                      <div className="px-2 py-1.5 text-xs text-warning">
                        部分会话加载失败
                      </div>
                    ) : null}
                    {groups.map((g, gi) => (
                      <Select.Group key={g.channel.id}>
                        {gi > 0 ? (
                          <Select.Separator className="my-1 h-px bg-border-subtle" />
                        ) : null}
                        <Select.Label className="px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-text-muted">
                          #{g.channel.name}
                        </Select.Label>
                        {g.sessions.map(s => (
                          <SessionItem key={s.id} session={s} />
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
            'flex size-7 shrink-0 items-center justify-center rounded-md border transition-colors ' +
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
        <EventStream sessionId={sessionId} agentsById={agentsById} />
      </div>
    </div>
  );
}

function initialActiveSessionFromUrl(): ActiveSessionSelection {
  const params = new URLSearchParams(window.location.search);
  const channelId = cleanParam(params.get('channelId'));
  const sessionId = cleanParam(params.get('sessionId'));
  return { channelId, sessionId };
}

function cleanParam(value: string | null): string | null {
  return value && value.trim() ? value : null;
}

function mergeSessions(...sets: SessionDto[][]): SessionDto[] {
  const byId = new Map<string, SessionDto>();
  for (const sessions of sets) {
    for (const session of sessions) {
      byId.set(session.id, session);
    }
  }
  return [...byId.values()].sort((a, b) => b.created_at - a.created_at);
}

function SessionItem({ session }: { session: SessionDto }): JSX.Element {
  const closed = session.closed_at !== null;
  return (
    <Select.Item
      value={session.id}
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
          {session.title}
        </span>
      </Select.ItemText>
    </Select.Item>
  );
}
