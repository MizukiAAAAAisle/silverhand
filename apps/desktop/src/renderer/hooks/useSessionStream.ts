import { useEffect, useRef } from 'react';
import { applyAgentRunStateToCache } from '@/lib/agentRunStateCache';
import { getBackendInfo } from '@/lib/api';
import type { AgentRunState } from '@silverhand/shared';

/**
 * Per-session SSE event payload. Mirrors what backend's SessionEventBus
 * publishes — see packages/backend/src/event-bus.ts and routes.ts'
 * `/api/sessions/:id/stream` handler.
 */
export interface SessionStreamEvent {
  /** SSE `event:` field. Known values: `connected`, `ping`, `message`,
   *  `agent_status`, `agent_event`, `agent_activity`, `compaction_stale`,
   *  `thread_updated`, `task_changed`. */
  kind: string;
  /** Parsed JSON payload from SSE `data:` field. */
  payload: any;
}

type Handler = (event: SessionStreamEvent) => void;

const STREAM_CLOSE_GRACE_MS = 30_000;

const KNOWN_EVENTS = [
  'connected',
  'ping',
  'message',
  'agent_status',
  'agent_event',
  'agent_activity',
  'compaction_stale',
  'thread_updated',
  'task_changed',
] as const;

interface StreamEntry {
  eventSource: EventSource | null;
  handlers: Set<Handler>;
  closed: boolean;
  closeTimer: ReturnType<typeof setTimeout> | null;
}

const streamsBySession = new Map<string, StreamEntry>();

function clearCloseTimer(entry: StreamEntry): void {
  if (!entry.closeTimer) return;
  clearTimeout(entry.closeTimer);
  entry.closeTimer = null;
}

function closeStream(sessionId: string, entry: StreamEntry): void {
  if (streamsBySession.get(sessionId) !== entry) return;
  clearCloseTimer(entry);
  entry.closed = true;
  entry.eventSource?.close();
  entry.eventSource = null;
  streamsBySession.delete(sessionId);
}

function scheduleCloseStream(sessionId: string, entry: StreamEntry): void {
  if (entry.handlers.size > 0) return;
  clearCloseTimer(entry);
  entry.closeTimer = setTimeout(() => {
    if (entry.handlers.size > 0) return;
    closeStream(sessionId, entry);
  }, STREAM_CLOSE_GRACE_MS);
}

function emitToHandlers(entry: StreamEntry, event: SessionStreamEvent): void {
  for (const handler of Array.from(entry.handlers)) {
    handler(event);
  }
}

function ingestSessionEvent(sessionId: string, event: SessionStreamEvent): void {
  if (event.kind !== 'agent_activity') return;
  applyAgentRunStateToCache(sessionId, event.payload as AgentRunState | undefined);
}

function syntheticConnectedEvent(sessionId: string): SessionStreamEvent {
  return {
    kind: 'connected',
    payload: { session_id: sessionId, client_synthetic: true },
  };
}

function getOrCreateStream(sessionId: string): StreamEntry {
  const existing = streamsBySession.get(sessionId);
  if (existing) {
    clearCloseTimer(existing);
    return existing;
  }

  const entry: StreamEntry = {
    eventSource: null,
    handlers: new Set(),
    closed: false,
    closeTimer: null,
  };
  streamsBySession.set(sessionId, entry);

  void (async () => {
    const info = await getBackendInfo();
    if (entry.closed) return;

    const es = new EventSource(`${info.url}/api/sessions/${sessionId}/stream`);
    entry.eventSource = es;

    // The backend sends a custom `connected` event immediately after the
    // stream opens. Native EventSource starts connecting as soon as it is
    // constructed, so use the native `open` event as an additional local
    // reconnect signal in case that first custom event races ahead of the
    // named listeners below.
    es.addEventListener('open', () => {
      if (entry.closed) return;
      emitToHandlers(entry, syntheticConnectedEvent(sessionId));
    });

    for (const kind of KNOWN_EVENTS) {
      es.addEventListener(kind, (raw: MessageEvent) => {
        let payload: unknown;
        try {
          payload = JSON.parse(raw.data);
        } catch {
          payload = raw.data;
        }
        const event: SessionStreamEvent = { kind, payload };
        ingestSessionEvent(sessionId, event);
        emitToHandlers(entry, event);
      });
    }
  })();

  return entry;
}

/**
 * Subscribe to /api/sessions/:id/stream. The handler is called for every
 * named SSE event that arrives (including `connected` / `ping` — caller
 * filters). All subscribers for the same `sessionId` share one EventSource,
 * then the stream auto-closes after a short grace period once the last
 * subscriber unmounts.
 *
 * Heads-up: backend's API routes have no auth middleware, so we connect
 * with a bare URL — `EventSource` doesn't support custom headers anyway.
 */
export function useSessionStream(
  sessionId: string | null,
  onEvent: Handler,
): void {
  // Keep the latest handler in a ref so we don't tear down the EventSource
  // every time the parent re-renders with a new closure.
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    if (!sessionId) return;
    const entry = getOrCreateStream(sessionId);
    const handler: Handler = event => handlerRef.current(event);
    entry.handlers.add(handler);

    // New subscribers may attach after the shared EventSource has already
    // opened and consumed the backend's initial `connected` event. Tell the
    // subscriber to run its normal reconnect/snapshot reconciliation path.
    queueMicrotask(() => {
      if (entry.closed || !entry.handlers.has(handler)) return;
      handler(syntheticConnectedEvent(sessionId));
    });

    return () => {
      entry.handlers.delete(handler);
      if (entry.handlers.size === 0) {
        scheduleCloseStream(sessionId, entry);
      }
    };
  }, [sessionId]);
}
