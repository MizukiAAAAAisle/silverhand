import { EventEmitter } from 'node:events';

/**
 * Per-session in-process pub/sub. SSE handlers subscribe; SessionManager
 * and route handlers publish. Single instance per backend, held in
 * BackendContext.
 *
 * `kind` is the SSE `event:` field (e.g. `session_event`, `message`,
 * `agent_status`, `compaction`). `payload` is JSON-serializable and
 * goes verbatim into the SSE `data:` field.
 */
export interface SessionBusEvent {
  kind: string;
  payload: unknown;
}

export type SessionBusHandler = (event: SessionBusEvent) => void;

export class SessionEventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // SessionManager + many SSE subscribers per session — bump the cap
    // so node doesn't print spurious warnings.
    this.emitter.setMaxListeners(0);
  }

  publish(sessionId: string, event: SessionBusEvent): void {
    this.emitter.emit(channel(sessionId), event);
  }

  subscribe(sessionId: string, handler: SessionBusHandler): () => void {
    const ch = channel(sessionId);
    this.emitter.on(ch, handler);
    return () => {
      this.emitter.off(ch, handler);
    };
  }
}

function channel(sessionId: string): string {
  return `session:${sessionId}`;
}
