import { useCallback, useEffect, useRef, useState } from 'react';
import {
  useSessionStream,
  type SessionStreamEvent,
} from '@/hooks/useSessionStream';

const MAX_EVENTS = 200;

interface LoggedEvent {
  id: number;
  ts: number;
  kind: string;
  payload: unknown;
}

/**
 * Renders a scrolling, ring-buffered log of SSE events for one session.
 * Used by the dev-only Events window (`renderer/events/EventsApp.tsx`)
 * — extracted out of the previous in-app `EventPanel` so the same
 * markup serves both the standalone window and any future embedded
 * use. Skips `ping` keepalives.
 */
export function EventStream({ sessionId }: { sessionId: string | null }): JSX.Element {
  const [events, setEvents] = useState<LoggedEvent[]>([]);
  const seq = useRef(0);

  // Reset log when switching sessions.
  useEffect(() => {
    setEvents([]);
  }, [sessionId]);

  const onEvent = useCallback((e: SessionStreamEvent) => {
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
  useSessionStream(sessionId, onEvent);

  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [events]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border-subtle px-3 py-1.5 text-[10px] uppercase tracking-wider text-text-muted">
        <span>Stream</span>
        <span>{sessionId ? `${events.length}/${MAX_EVENTS}` : 'no session'}</span>
      </div>
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-2 py-2 text-[11px]">
        {!sessionId ? (
          <div className="px-1 py-2 text-text-muted">选择一个会话以查看事件流</div>
        ) : events.length === 0 ? (
          <div className="px-1 py-2 text-text-muted">等待事件…</div>
        ) : (
          <ol className="space-y-1">
            {events.map(ev => (
              <li key={ev.id}>
                <EventRow event={ev} />
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

function EventRow({ event }: { event: LoggedEvent }): JSX.Element {
  const [open, setOpen] = useState(false);
  const tone = kindTone(event.kind);
  const summary = summarize(event.kind, event.payload);
  return (
    <div className="rounded-sm border border-border-subtle bg-bg-floating px-1.5 py-1">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex w-full items-baseline gap-1.5 text-left"
      >
        <span className="font-mono text-[10px] text-text-muted">{fmtTime(event.ts)}</span>
        <span className={'font-medium ' + tone}>{event.kind}</span>
        <span className="flex-1 truncate text-text-secondary">{summary}</span>
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
    case 'compaction_stale':
      return 'text-error';
    case 'connected':
      return 'text-success';
    default:
      return 'text-text-secondary';
  }
}

function summarize(kind: string, payload: unknown): string {
  if (payload == null || typeof payload !== 'object') return '';
  const p = payload as Record<string, unknown>;
  if (kind === 'message') {
    const m = p.message as { from_kind?: string; content?: string } | undefined;
    if (!m) return '';
    const head = (m.content ?? '').slice(0, 80).replace(/\s+/g, ' ');
    return `${m.from_kind ?? '?'}: ${head}`;
  }
  if (kind === 'agent_status') {
    return `${shortId(p.agent_id)} → ${String(p.status ?? '?')}`;
  }
  if (kind === 'agent_event') {
    const t = (p.event_type ?? p.type ?? '') as string;
    return t ? `${shortId(p.agent_id)} ${t}` : shortId(p.agent_id);
  }
  if (kind === 'connected') return '';
  return '';
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
