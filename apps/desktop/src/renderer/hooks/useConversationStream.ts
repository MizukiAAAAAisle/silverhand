import { useEffect, useRef } from 'react';
import { applyAgentRunStateToCache } from '@/lib/agentRunStateCache';
import { getBackendInfo } from '@/lib/api';
import type { AgentRunState } from '@silverhand/shared';

/**
 * Per-conversation SSE event payload. Mirrors what backend's ConversationEventBus
 * publishes — see packages/backend/src/event-bus.ts and routes.ts'
 * channel/thread stream handlers.
 */
export interface ConversationStreamEvent {
  /** SSE `event:` field. Known values: `connected`, `ping`, `message`,
   *  `agent_status`, `agent_event`, `agent_activity`, `compaction_stale`,
   *  `thread_updated`, `task_changed`. */
  kind: string;
  /** Parsed JSON payload from SSE `data:` field. */
  payload: any;
}

export type SessionStreamEvent = ConversationStreamEvent;

type Handler = (event: ConversationStreamEvent) => void;
type StreamScope = 'channel' | 'thread';

// Keep this short: every inactive EventSource still occupies a browser
// connection slot to the local backend. A long grace period makes rapid
// channel switching queue subsequent fetches behind stale SSE sockets.
const STREAM_CLOSE_GRACE_MS = 500;

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

const streamsByConversation = new Map<string, StreamEntry>();

function streamKey(scope: StreamScope, id: string): string {
  return `${scope}:${id}`;
}

function streamPath(scope: StreamScope, id: string): string {
  if (scope === 'channel') return `/api/channels/${id}/stream`;
  return `/api/threads/${id}/stream`;
}

function clearCloseTimer(entry: StreamEntry): void {
  if (!entry.closeTimer) return;
  clearTimeout(entry.closeTimer);
  entry.closeTimer = null;
}

function closeStream(key: string, entry: StreamEntry): void {
  if (streamsByConversation.get(key) !== entry) return;
  clearCloseTimer(entry);
  entry.closed = true;
  entry.eventSource?.close();
  entry.eventSource = null;
  streamsByConversation.delete(key);
}

function scheduleCloseStream(key: string, entry: StreamEntry): void {
  if (entry.handlers.size > 0) return;
  clearCloseTimer(entry);
  entry.closeTimer = setTimeout(() => {
    if (entry.handlers.size > 0) return;
    closeStream(key, entry);
  }, STREAM_CLOSE_GRACE_MS);
}

function emitToHandlers(entry: StreamEntry, event: ConversationStreamEvent): void {
  for (const handler of Array.from(entry.handlers)) {
    handler(event);
  }
}

function ingestConversationEvent(
  conversationId: string,
  event: ConversationStreamEvent,
): void {
  if (event.kind !== 'agent_activity') return;
  applyAgentRunStateToCache(
    conversationId,
    event.payload as AgentRunState | undefined,
  );
}

function syntheticConnectedEvent(
  conversationId: string,
  scope: StreamScope,
): ConversationStreamEvent {
  return {
    kind: 'connected',
    payload: {
      conversation_id: conversationId,
      scope,
      client_synthetic: true,
    },
  };
}

function getOrCreateStream(conversationId: string, scope: StreamScope): StreamEntry {
  const key = streamKey(scope, conversationId);
  const existing = streamsByConversation.get(key);
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
  streamsByConversation.set(key, entry);

  void (async () => {
    const info = await getBackendInfo();
    if (entry.closed) return;

    const es = new EventSource(`${info.url}${streamPath(scope, conversationId)}`);
    entry.eventSource = es;

    // The backend sends a custom `connected` event immediately after the
    // stream opens. Native EventSource starts connecting as soon as it is
    // constructed, so use the native `open` event as an additional local
    // reconnect signal in case that first custom event races ahead of the
    // named listeners below.
    es.addEventListener('open', () => {
      if (entry.closed) return;
      emitToHandlers(entry, syntheticConnectedEvent(conversationId, scope));
    });

    for (const kind of KNOWN_EVENTS) {
      es.addEventListener(kind, (raw: MessageEvent) => {
        let payload: unknown;
        try {
          payload = JSON.parse(raw.data);
        } catch {
          payload = raw.data;
        }
        const event: ConversationStreamEvent = { kind, payload };
        ingestConversationEvent(conversationId, event);
        emitToHandlers(entry, event);
      });
    }
  })();

  return entry;
}

/**
 * Subscribe to a channel/thread stream. The handler is called for every
 * named SSE event that arrives (including `connected` / `ping` — caller
 * filters). All subscribers for the same conversation id + scope share one
 * EventSource, then the stream auto-closes after a short grace period once
 * the last subscriber unmounts.
 *
 * Heads-up: backend's API routes have no auth middleware, so we connect
 * with a bare URL — `EventSource` doesn't support custom headers anyway.
 */
export function useConversationStream(
  conversationId: string | null,
  onEvent: Handler,
  scope: StreamScope = 'channel',
): void {
  // Keep the latest handler in a ref so we don't tear down the EventSource
  // every time the parent re-renders with a new closure.
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    if (!conversationId) return;
    const key = streamKey(scope, conversationId);
    const entry = getOrCreateStream(conversationId, scope);
    const handler: Handler = event => handlerRef.current(event);
    entry.handlers.add(handler);

    // New subscribers may attach after the shared EventSource has already
    // opened and consumed the backend's initial `connected` event. Tell the
    // subscriber to run its normal reconnect/snapshot reconciliation path.
    queueMicrotask(() => {
      if (entry.closed || !entry.handlers.has(handler)) return;
      handler(syntheticConnectedEvent(conversationId, scope));
    });

    return () => {
      entry.handlers.delete(handler);
      if (entry.handlers.size === 0) {
        scheduleCloseStream(key, entry);
      }
    };
  }, [conversationId, scope]);
}
