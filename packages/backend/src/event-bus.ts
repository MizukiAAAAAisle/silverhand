import { EventEmitter } from 'node:events';

/**
 * Per-conversation in-process pub/sub. SSE handlers subscribe; ConversationManager
 * and route handlers publish. Single instance per backend, held in
 * BackendContext.
 *
 * `kind` is the SSE `event:` field (e.g. `session_event`, `message`,
 * `agent_status`, `compaction`). `payload` is JSON-serializable and
 * goes verbatim into the SSE `data:` field.
 */
export interface ConversationBusEvent {
  kind: string;
  payload: unknown;
}

export type ConversationBusHandler = (event: ConversationBusEvent) => void;

export class ConversationEventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // ConversationManager + many SSE subscribers per conversation — bump the cap
    // so node doesn't print spurious warnings.
    this.emitter.setMaxListeners(0);
  }

  publish(conversationId: string, event: ConversationBusEvent): void {
    this.emitter.emit(channel(conversationId), event);
  }

  subscribe(conversationId: string, handler: ConversationBusHandler): () => void {
    const ch = channel(conversationId);
    this.emitter.on(ch, handler);
    return () => {
      this.emitter.off(ch, handler);
    };
  }
}

function channel(conversationId: string): string {
  return `conversation:${conversationId}`;
}
