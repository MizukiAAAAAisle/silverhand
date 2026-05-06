import { useEffect, useRef } from 'react';
import { applyAgentRunStateToCache } from '@/lib/agentRunStateCache';
import { onWsFrame, subscribeWsScope } from '@/lib/ws-client';
import type { AgentRunState, ServerFrame } from '@silverhand/shared';

/**
 * Per-conversation realtime event payload. The transport is now the shared
 * WebSocket event bus, but callers keep the legacy event shape.
 */
export interface ConversationStreamEvent {
  /** Known values: `connected`, `ping`, `message`, `agent_status`, `agent_event`,
   *  `agent_activity`, `compaction_stale`, `thread_updated`, `task_changed`. */
  kind: string;
  /** Event payload from the backend, or local metadata for `connected`. */
  payload: any;
}

export type SessionStreamEvent = ConversationStreamEvent;

type Handler = (event: ConversationStreamEvent) => void;
type StreamScope = 'channel' | 'thread';

function wsConversationScope(conversationId: string): string {
  return `conversation:${conversationId}`;
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

function connectedEvent(
  conversationId: string,
  scope: StreamScope,
  extra: Record<string, unknown> = {},
): ConversationStreamEvent {
  return {
    kind: 'connected',
    payload: {
      conversation_id: conversationId,
      scope,
      transport: 'ws',
      ...extra,
    },
  };
}

function streamEventFromFrame(
  frame: ServerFrame,
  expectedScope: string,
  conversationId: string,
  routeScope: StreamScope,
): ConversationStreamEvent | null {
  if (frame.type === 'ping') {
    return { kind: 'ping', payload: Date.now() };
  }

  if (frame.type === 'event') {
    if (frame.scope !== expectedScope) return null;
    return { kind: frame.kind, payload: frame.payload };
  }

  if (frame.type === 'subscribed') {
    if (frame.scope !== expectedScope) return null;
    return connectedEvent(conversationId, routeScope, {
      epoch: frame.epoch,
      seq: frame.seq,
      subscribed: true,
    });
  }

  if (frame.type === 'snapshot_required') {
    if (frame.scope !== expectedScope) return null;
    return connectedEvent(conversationId, routeScope, {
      snapshot_required: true,
      reason: frame.reason,
    });
  }

  return null;
}

/**
 * Subscribe to a channel/thread realtime stream. The public API intentionally
 * matches the old stream hook so message, agent, task, and thread hooks
 * can switch transports without changing their own logic.
 */
export function useConversationStream(
  conversationId: string | null,
  onEvent: Handler,
  scope: StreamScope = 'channel',
): void {
  // Keep the latest handler in a ref so we don't resubscribe every time the
  // parent re-renders with a new closure.
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    if (!conversationId) return;

    let active = true;
    const wsScope = wsConversationScope(conversationId);
    const subscription = subscribeWsScope(wsScope);
    const offFrame = onWsFrame(frame => {
      if (!active) return;
      const event = streamEventFromFrame(frame, wsScope, conversationId, scope);
      if (!event) return;
      ingestConversationEvent(conversationId, event);
      handlerRef.current(event);
    });

    // Preserve the previous hook's reconciliation behavior for late
    // subscribers. Business hooks that need a snapshot already key off the
    // synthetic `connected` event.
    queueMicrotask(() => {
      if (!active) return;
      handlerRef.current(
        connectedEvent(conversationId, scope, { client_synthetic: true }),
      );
    });

    return () => {
      active = false;
      offFrame();
      subscription.unsubscribe();
    };
  }, [conversationId, scope]);
}
