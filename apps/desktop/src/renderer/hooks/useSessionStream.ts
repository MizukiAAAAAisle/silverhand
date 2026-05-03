import { useEffect, useRef } from 'react';
import { getBackendInfo } from '@/lib/api';

/**
 * Per-session SSE event payload. Mirrors what backend's SessionEventBus
 * publishes — see packages/backend/src/event-bus.ts and routes.ts'
 * `/api/sessions/:id/stream` handler.
 */
export interface SessionStreamEvent {
  /** SSE `event:` field. Known values: `connected`, `ping`, `message`,
   *  `agent_status`, `agent_event`, `compaction_stale`, `thread_updated`,
   *  `task_changed`. */
  kind: string;
  /** Parsed JSON payload from SSE `data:` field. */
  payload: any;
}

type Handler = (event: SessionStreamEvent) => void;

/**
 * Subscribe to /api/sessions/:id/stream. The handler is called for every
 * named SSE event that arrives (including `connected` / `ping` — caller
 * filters). Re-mounts the EventSource if `sessionId` changes; auto-closes
 * on unmount.
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
    let es: EventSource | null = null;
    let cancelled = false;

    void (async () => {
      const info = await getBackendInfo();
      if (cancelled) return;
      es = new EventSource(`${info.url}/api/sessions/${sessionId}/stream`);

      const known = [
        'connected',
        'ping',
        'message',
        'agent_status',
        'agent_event',
        'compaction_stale',
        'thread_updated',
        'task_changed',
      ];
      for (const kind of known) {
        es.addEventListener(kind, (raw: MessageEvent) => {
          let payload: unknown;
          try {
            payload = JSON.parse(raw.data);
          } catch {
            payload = raw.data;
          }
          handlerRef.current({ kind, payload });
        });
      }
    })();

    return () => {
      cancelled = true;
      es?.close();
    };
  }, [sessionId]);
}
