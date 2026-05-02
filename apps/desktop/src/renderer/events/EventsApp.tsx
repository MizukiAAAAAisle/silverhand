import { useEffect, useMemo, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Check, ChevronDown, Pin, PinOff } from 'lucide-react';
import * as Select from '@radix-ui/react-select';
import type { ChannelDto, SessionDto } from '@silverhand/shared';
import { api, getBackendInfo } from '@/lib/api';
import { useAppearance } from '@/hooks/useAppearance';
import { EventStream } from '@/components/dev/EventStream';

interface SessionOption {
  channelName: string;
  session: SessionDto;
}

/**
 * Standalone window root for the dev-only events viewer. Picks one
 * session at a time and pipes its SSE feed through `<EventStream>`.
 *
 * Single-window flow: opened via the macOS app menu (View → Developer
 * → Show Events Window). Doesn't try to follow the main window's
 * selection — too coupled for a debug surface; the picker takes one
 * extra click and keeps the windows independent. Pin toggle on the
 * right of the titlebar flips the window's always-on-top state via
 * the `window:setAlwaysOnTop` preload bridge.
 */
export function EventsApp(): JSX.Element {
  // Inherit theme tokens from main window (shares localStorage).
  useAppearance();

  const { data: info } = useQuery({
    queryKey: ['backend-info'],
    queryFn: getBackendInfo,
  });
  const { data: channels = [] } = useQuery({
    queryKey: ['channels'],
    queryFn: async () => {
      const res = await api<{ channels: ChannelDto[] }>('/api/channels');
      return res.channels;
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

  // Group sessions by channel for the Select dropdown.
  const groups = useMemo(() => {
    return channels
      .map((c, i) => {
        const sessions = (sessionQueries[i]?.data ?? []).slice().sort(
          (a, b) => b.created_at - a.created_at,
        );
        return { channel: c, sessions };
      })
      .filter(g => g.sessions.length > 0);
  }, [channels, sessionQueries]);

  const allOptions = useMemo<SessionOption[]>(() => {
    const out: SessionOption[] = [];
    for (const g of groups) {
      for (const s of g.sessions) {
        out.push({ channelName: g.channel.name, session: s });
      }
    }
    return out;
  }, [groups]);

  const [sessionId, setSessionId] = useState<string | null>(null);

  // Auto-pick the most recently-created session once the list arrives
  // so the SSE feed starts immediately on first open.
  useEffect(() => {
    if (sessionId) return;
    if (allOptions.length === 0) return;
    setSessionId(allOptions[0]!.session.id);
  }, [allOptions, sessionId]);

  const currentLabel = useMemo(() => {
    const m = allOptions.find(o => o.session.id === sessionId);
    if (!m) return null;
    return `#${m.channelName} · ${m.session.title}`;
  }, [allOptions, sessionId]);

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
          onValueChange={v => setSessionId(v || null)}
        >
          <Select.Trigger
            aria-label="选择会话"
            className="flex min-w-0 flex-1 items-center justify-between gap-2 rounded-md border border-border-subtle bg-bg-floating px-2.5 py-1.5 text-sm text-text-primary outline-none transition-colors hover:border-border focus:border-border-focus focus:ring-2 focus:ring-border-focus data-[placeholder]:text-text-muted"
          >
            <Select.Value placeholder="— 选择会话 —">
              <span className="truncate">{currentLabel ?? '— 选择会话 —'}</span>
            </Select.Value>
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
                    没有可用的会话
                  </div>
                ) : (
                  groups.map((g, gi) => (
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
                  ))
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
        <EventStream sessionId={sessionId} />
      </div>
    </div>
  );
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
