import { useEffect, useRef } from 'react';
import { onWsFrame } from '@/lib/ws-client';
import { useInterest } from '@/features/realtime/interest-registry';
import { conversationScope, conversationSideScope } from '@silverhand/shared';
import type { ServerFrame } from '@silverhand/shared';

/**
 * Per-conversation realtime event payload. The transport is now the shared
 * WebSocket event bus, but callers keep the legacy event shape.
 */
export interface ConversationStreamEvent {
  /** Message-stream kinds this legacy bridge still forwards: `connected`,
   *  `ping`, `message`, `task_changed`. Side-channel kinds (`agent_status` /
   *  `agent_activity` / `agent_event` / `conversation_activity` /
   *  `compaction_stale` / members) no longer ride this bridge — they route
   *  through the central ingestor / their own side-scope consumers, and the
   *  dev EventStream observes the side scope separately (#task:1255 P2 step-3). */
  kind: string;
  /** Event payload from the backend, or local metadata for `connected`. */
  payload: any;
}

export type SessionStreamEvent = ConversationStreamEvent;

type Handler = (event: ConversationStreamEvent) => void;
type StreamScope = 'channel' | 'thread';

export function wsConversationScope(conversationId: string): string {
  return conversationScope(conversationId);
}

/** Side-channel transport scope for a conversation (agent_status / activity /
 *  members) — the recovery-class-partitioned sibling of {@link
 *  wsConversationScope}. Delegates to the shared grammar so backend publish and
 *  renderer subscribe never drift (#task:1255 P2 step-3). */
export function wsConversationSideScope(conversationId: string): string {
  return conversationSideScope(conversationId);
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

  // #task:1260 P2 (distinct slice): the WS scope INTEREST is migrated to the
  // registry. The transport scope is wsConversationScope(conversationId),
  // independent of the routeScope arg (which only shapes the forwarded events),
  // so interest keys on conversationId alone. The onWsFrame LISTENER below is
  // this bridge's OWN concern (read-inert, #task:1251/#1244) and is deliberately
  // NOT moved — interest ⊥ listener: this hook stops being a direct transport
  // subscriber but keeps its listener + synthetic-connected replay verbatim.
  useInterest(conversationId ? wsConversationScope(conversationId) : null);

  useEffect(() => {
    if (!conversationId) return;

    let active = true;
    const wsScope = wsConversationScope(conversationId);
    const offFrame = onWsFrame(frame => {
      if (!active) return;
      const event = streamEventFromFrame(frame, wsScope, conversationId, scope);
      if (!event) return;
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
    };
  }, [conversationId, scope]);
}
