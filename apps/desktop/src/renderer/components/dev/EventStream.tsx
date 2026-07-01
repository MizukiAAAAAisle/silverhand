import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentDto } from '@silverhand/shared';
import { onWsFrame, subscribeWsScope } from '@/lib/ws-client';
import {
  useConversationStream,
  wsConversationSideScope,
  type ConversationStreamEvent,
} from '@/hooks/useConversationStream';

const MAX_EVENTS = 200;

interface LoggedEvent {
  id: number;
  ts: number;
  kind: string;
  payload: unknown;
}

/**
 * Renders a scrolling, ring-buffered log of realtime events for one channel.
 * Used by the dev-only Events window (`renderer/events/EventsApp.tsx`)
 * — extracted out of the previous in-app `EventPanel` so the same
 * markup serves both the standalone window and any future embedded
 * use. Skips `ping` keepalives.
 */
export function EventStream({
  conversationId,
  scope,
  agentsById,
}: {
  conversationId: string | null;
  scope: 'channel' | 'thread';
  agentsById: Map<string, AgentDto>;
}): JSX.Element {
  const [events, setEvents] = useState<LoggedEvent[]>([]);
  const seq = useRef(0);

  // Reset log when switching conversations.
  useEffect(() => {
    setEvents([]);
  }, [conversationId, scope]);

  const onEvent = useCallback((e: ConversationStreamEvent) => {
    if (e.kind === 'ping') return; // noisy keepalive
    setEvents(prev => {
      const next: LoggedEvent = {
        id: ++seq.current,
        ts: Date.now(),
        kind: e.kind,
        payload: e.payload,
      };
      const merged = [...prev, next];
      return merged.length > MAX_EVENTS
        ? merged.slice(merged.length - MAX_EVENTS)
        : merged;
    });
  }, []);
  useConversationStream(conversationId, onEvent, scope);

  // After the #1255 P2 partition, the message-stream bridge above no longer
  // carries side kinds (agent_status / agent_activity / agent_event /
  // conversation_activity / compaction_stale / members) — they publish to the
  // disjoint `conversation-side:<id>` scope. The dev log observes that scope too
  // so it stays a complete picture. Observe-only: it registers INTEREST and
  // reads frames, never writing any cache or cursor.
  useEffect(() => {
    if (!conversationId) return;
    const sideScope = wsConversationSideScope(conversationId);
    const sub = subscribeWsScope(sideScope);
    const off = onWsFrame(frame => {
      if (frame.type !== 'event' || frame.scope !== sideScope) return;
      onEvent({ kind: frame.kind, payload: frame.payload });
    });
    return () => {
      off();
      sub.unsubscribe();
    };
  }, [conversationId, onEvent]);

  const visibleEvents = useMemo(() => [...events].reverse(), [events]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border-subtle px-3 py-1.5 text-[10px] uppercase tracking-wider text-text-muted">
        <span>Stream</span>
        <span>{conversationId ? `${events.length}/${MAX_EVENTS}` : 'no conversation'}</span>
      </div>
      <div className="flex flex-1 flex-col gap-1 overflow-y-auto px-2 py-2 text-[11px]">
        {!conversationId ? (
          <div className="px-1 py-2 text-text-muted">选择一个 channel 以查看事件流</div>
        ) : events.length === 0 ? (
          <div className="px-1 py-2 text-text-muted">等待事件…</div>
        ) : (
          visibleEvents.map(ev => (
            <EventRow key={ev.id} event={ev} agentsById={agentsById} />
          ))
        )}
      </div>
    </div>
  );
}

function EventRow({
  event,
  agentsById,
}: {
  event: LoggedEvent;
  agentsById: Map<string, AgentDto>;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const tone = kindTone(event.kind);
  const agent = findEventAgent(event.payload, agentsById);
  const summary = summarize(event.kind, event.payload, agent);
  return (
    <div className="rounded-sm border border-border-subtle bg-bg-floating px-1.5 py-1">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex w-full min-w-0 items-baseline gap-1.5 text-left"
      >
        <span className="shrink-0 font-mono text-[10px] text-text-muted">
          {fmtTime(event.ts)}
        </span>
        <span className={'shrink-0 font-medium ' + tone}>{event.kind}</span>
        {agent ? (
          <span className="shrink-0 rounded-sm border border-border-subtle bg-bg-elevated px-1 font-mono text-[10px] text-text-muted">
            @{agent.name}
            <span className="text-text-muted">/{agent.runtime}</span>
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-text-secondary">{summary}</span>
      </button>
      {open ? (
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-sm bg-bg-elevated p-1.5 font-mono text-[10px] text-text-secondary">
          {safeStringify(event.payload)}
        </pre>
      ) : null}
    </div>
  );
}

function kindTone(kind: string): string {
  switch (kind) {
    case 'message':
      return 'text-accent';
    case 'agent_status':
      return 'text-warning';
    case 'agent_event':
      return 'text-text-primary';
    case 'agent_activity':
      return 'text-success';
    case 'compaction_stale':
      return 'text-error';
    case 'connected':
      return 'text-success';
    default:
      return 'text-text-secondary';
  }
}

function summarize(
  kind: string,
  payload: unknown,
  agent: AgentDto | null,
): string {
  if (payload == null || typeof payload !== 'object') return '';
  const p = payload as Record<string, unknown>;
  if (kind === 'message') {
    const m = p.message as
      | { from_kind?: string; from_agent_id?: string | null; content?: string }
      | undefined;
    if (!m) return '';
    const head = (m.content ?? '').slice(0, 80).replace(/\s+/g, ' ');
    if (agent) return head;
    const sender = m.from_kind ?? '?';
    return `${sender}: ${head}`;
  }
  if (kind === 'agent_status') {
    const status = String(p.status ?? '?');
    return agent ? `→ ${status}` : `${agentLabel(agent, p.agent_id)} → ${status}`;
  }
  if (kind === 'agent_event') {
    const inner = p.event;
    const ev = inner && typeof inner === 'object'
      ? (inner as Record<string, unknown>)
      : p;
    const t = (ev.kind ?? ev.event_type ?? ev.type ?? '') as string;
    if (agent) return t;
    return t ? `${agentLabel(agent, p.agent_id)} ${t}` : agentLabel(agent, p.agent_id);
  }
  if (kind === 'agent_activity') {
    const status = String(p.status ?? '?');
    const detail =
      typeof p.activitySnippet === 'string'
        ? p.activitySnippet
        : p.toolCallCounts && typeof p.toolCallCounts === 'object'
          ? summarizeToolCallCounts(p.toolCallCounts as Record<string, unknown>)
          : Array.isArray(p.toolCalls)
          ? p.toolCalls.join(', ')
          : '';
    const suffix = `→ ${status}${detail ? ` · ${detail}` : ''}`;
    return agent ? suffix : `${agentLabel(agent, p.agentId ?? p.agent_id)} ${suffix}`;
  }
  if (kind === 'connected') return '';
  return '';
}

function findEventAgent(
  payload: unknown,
  agentsById: Map<string, AgentDto>,
): AgentDto | null {
  const id = findAgentId(payload);
  return id ? agentsById.get(id) ?? null : null;
}

function findAgentId(payload: unknown): string | null {
  if (payload == null || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.agent_id === 'string') return p.agent_id;
  if (typeof p.agentId === 'string') return p.agentId;
  const message = p.message;
  if (message && typeof message === 'object') {
    const m = message as Record<string, unknown>;
    if (typeof m.from_agent_id === 'string') return m.from_agent_id;
  }
  return null;
}

function agentLabel(agent: AgentDto | null, fallbackId: unknown): string {
  if (agent) return `@${agent.name}/${agent.runtime}`;
  return shortId(fallbackId);
}

function summarizeToolCallCounts(counts: Record<string, unknown>): string {
  return Object.entries(counts)
    .slice(0, 4)
    .map(([name, count]) => `${name}×${Number(count) || 0}`)
    .join(', ');
}

function shortId(v: unknown): string {
  return typeof v === 'string' ? v.slice(0, 6) : '';
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
