import {
  AGENT_PRESENCE_CHANGED_EVENT,
  type AgentPresenceChangedEvent,
} from '@silverhand/shared';

import type { BackendContext } from '../context.js';
import { agentViewerUserIds } from '../permissions.js';

/**
 * Producer for `agent_presence_changed` (#task:2049) — the cache invalidation
 * that pairs with `GET /api/agents/:id/presence`.
 *
 * Fired ONLY on an Away→Online transition, judged inside `AgentActivitySink` at
 * the presence-clock write edge (an agent past its away deadline producing real
 * runtime activity again). The frame carries only the agent id: a subscriber's
 * sole reaction is to refetch `/presence`, so the route stays the single source
 * of `away_at` (mirrors `agent_availability_changed`).
 *
 * WHO to notify is an access decision, so it lives in the authorization surface
 * (`permissions.agentViewerUserIds`, the dual of `canViewAgent`) — the SAME set
 * availability uses — not here. Per-viewer fan-out. Idempotent and
 * side-effect-free beyond publishing: safe to call on a redundant edge (the
 * sink's concurrent worst case is a duplicate fire, harmless because the frame
 * is id-only and the consumer only refetches).
 */
export function publishAgentPresenceChangedForAgent(
  ctx: BackendContext,
  agentId: string,
): void {
  const payload: AgentPresenceChangedEvent = { agent_id: agentId };
  for (const userId of agentViewerUserIds(ctx, agentId)) {
    ctx.events.publishToScope(
      `viewer:${userId}`,
      AGENT_PRESENCE_CHANGED_EVENT,
      payload,
    );
  }
}
