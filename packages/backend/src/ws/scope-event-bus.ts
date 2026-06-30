import { EventEmitter } from 'node:events';
import { ReplayBuffer, type ReplayEntry } from './replay-buffer.js';

interface ScopeEventLogger {
  info(obj: unknown, msg?: string): void;
}

/**
 * ScopeEventBus — the single in-process pub/sub hub for all real-time events.
 *
 * Serves as ctx.events while remaining fully backward-compatible:
 * existing callers use publish(conversationId, event) and
 * subscribe(conversationId, handler) unchanged.
 *
 * Internally every conversation publish is also routed to the
 * 'conversation:{id}' WS scope with no changes to existing publish sites.
 *
 * Four scope layers (Phase 1):
 *   app                           — global, no private data
 *   workspace:{workspaceId}       — workspace-level public facts
 *   conversation:{conversationId} — per-conversation events
 *   viewer:{userId}               — viewer-private events (notifications, unread)
 *
 * WS handlers subscribe to a scope key via subscribeScope() and receive
 * ScopedEvent objects. The replay buffer per scope keeps the last 200 events.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

/** Event shape used by existing conversation-level publishers/subscribers. */
export interface ConversationBusEvent {
  kind: string;
  payload: unknown;
}

export type ConversationBusHandler = (event: ConversationBusEvent) => void;

/** Event shape delivered to WS scope subscribers. */
export interface ScopedEvent {
  scope: string;
  seq: number;
  epoch: string;
  kind: string;
  payload: unknown;
}

export type ScopeHandler = (event: ScopedEvent) => void;

// ── ScopeEventBus ─────────────────────────────────────────────────────────────

export class ScopeEventBus {
  /** Stable identifier for this process lifetime. Changes on restart. */
  readonly epoch: string;

  /** Conversation compat emitter keyed by 'conversation:{id}'. */
  private readonly conversationEmitter = new EventEmitter();

  /** WS scope emitter keyed by scope string. */
  private readonly scopeEmitter = new EventEmitter();

  /** Per-scope monotonic sequence counters. */
  private readonly seqCounters = new Map<string, number>();

  /** Per-scope replay buffers. */
  private readonly buffers = new Map<string, ReplayBuffer>();

  constructor(epochOverride?: string, private readonly logger?: ScopeEventLogger) {
    this.epoch = epochOverride ?? crypto.randomUUID();
    // Allow unlimited listeners — ConversationManager + many WS subscribers.
    this.conversationEmitter.setMaxListeners(0);
    this.scopeEmitter.setMaxListeners(0);
  }

  // ── Backward-compat conversation API ───────────────────────────────────────

  /**
   * Publish an event for a conversation. Notifies conversation-level
   * subscribers and WS subscribers on the 'conversation:{id}' scope.
   */
  publish(conversationId: string, event: ConversationBusEvent): void {
    // 1. Notify conversation-level subscribers.
    this.conversationEmitter.emit(conversationKey(conversationId), event);

    // 2. Route to WS scope fanout.
    this.publishToScope(`conversation:${conversationId}`, event.kind, event.payload);
  }

  /**
   * Subscribe a handler to a conversation's events.
   * Returns an unsubscribe function.
   */
  subscribe(conversationId: string, handler: ConversationBusHandler): () => void {
    const key = conversationKey(conversationId);
    this.conversationEmitter.on(key, handler);
    return () => {
      this.conversationEmitter.off(key, handler);
    };
  }

  // ── WS Scope API ────────────────────────────────────────────────────────────

  /**
   * Publish an event directly to a named scope (workspace/app/viewer/etc.).
   * Also works for conversation scopes when called from non-conversation paths.
   */
  publishToScope(scope: string, kind: string, payload: unknown): void {
    const seq = this.nextSeq(scope);
    const epoch = this.epoch;

    // Write to replay buffer.
    const entry: ReplayEntry = { seq, epoch, kind, payload };
    this.getOrCreateBuffer(scope).push(entry);

    // Fanout to WS scope subscribers.
    const event: ScopedEvent = { scope, seq, epoch, kind, payload };
    const listenerCount = this.scopeEmitter.listenerCount(scope);
    if (shouldLogPublish(scope, kind)) {
      this.logger?.info(
        {
          category: 'event_ws.publish',
          scope,
          conversationId: conversationIdFromScope(scope),
          eventKind: kind,
          seq,
          epoch,
          listenerCount,
        },
        'event ws publish',
      );
    }
    this.scopeEmitter.emit(scope, event);
  }

  /**
   * Subscribe a WS handler to a scope. Returns an unsubscribe function.
   */
  subscribeScope(scope: string, handler: ScopeHandler): () => void {
    this.scopeEmitter.on(scope, handler);
    return () => {
      this.scopeEmitter.off(scope, handler);
    };
  }

  /**
   * Return the replay buffer for a scope, creating it on first access.
   * Used by ws-connection for resume logic.
   */
  getReplayBuffer(scope: string): ReplayBuffer {
    return this.getOrCreateBuffer(scope);
  }

  /**
   * Convenience wrapper: replay entries for a scope with seq > fromSeq and
   * matching epoch. Returns empty array on epoch mismatch or empty buffer.
   *
   * Named `replay` so callers (e.g. ws-connection) can duck-type against
   * this method without importing ReplayBuffer directly.
   */
  replay(scope: string, fromSeq: number, epoch: string): ReplayEntry[] {
    return this.getOrCreateBuffer(scope).replay(fromSeq, epoch);
  }

  /**
   * Return the current seq for a scope (0 if no events published yet).
   */
  currentSeq(scope: string): number {
    return this.seqCounters.get(scope) ?? 0;
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private nextSeq(scope: string): number {
    const next = (this.seqCounters.get(scope) ?? 0) + 1;
    this.seqCounters.set(scope, next);
    return next;
  }

  private getOrCreateBuffer(scope: string): ReplayBuffer {
    let buf = this.buffers.get(scope);
    if (!buf) {
      buf = new ReplayBuffer(200);
      this.buffers.set(scope, buf);
    }
    return buf;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function conversationKey(conversationId: string): string {
  return `conversation:${conversationId}`;
}

function conversationIdFromScope(scope: string): string | undefined {
  return scope.startsWith('conversation:') ? scope.slice('conversation:'.length) : undefined;
}

function shouldLogPublish(scope: string, kind: string): boolean {
  return scope.startsWith('conversation:') && kind === 'message';
}
