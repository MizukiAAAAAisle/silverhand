import {
  AGENT_AVAILABILITY_CHANGED_EVENT,
  type AgentAvailabilityChangedEvent,
} from '@silverhand/shared';

import type { BackendContext } from '../context.js';
import { agentViewerUserIds } from '../permissions.js';

/**
 * Producer for `agent_availability_changed` (#task:2043 B) — the cache
 * invalidation that pairs with `GET /api/agents/:id/availability`.
 *
 * It fires on TRANSPORT-REACHABILITY transitions (an outbound attachment
 * connects / disconnects, a host is revoked), which is exactly the fact the
 * read face reads (`outboundFrameAdapter().connectionIdForHost`). It is emitted
 * from the host attachment set/close edges — the same edges that already
 * announce `host_connection_changed` — NOT from hydration (`onSeeded`) or from
 * runtime-liveness changes, neither of which moves availability.
 *
 * The frame carries only the agent id: a subscriber's sole reaction is to
 * refetch `/availability`, so the route stays the single source of the value
 * (mirrors `agent_changed` / `direct_pairs_changed`).
 *
 * WHO to notify is an access decision, so it lives in the authorization surface
 * (`permissions.agentViewerUserIds`, the dual of `canViewAgent`), not here. This
 * module is a pure fan-out: it needs only the host→agents binding, which is not
 * an access fact, and `BackendContext` carries no repos, so that one reader is
 * injected at the composition root.
 */
export interface AgentAvailabilityChangedDeps {
  /** Every agent id currently bound to `hostId` (all share the host's
   *  reachability, so all of their availability values move together). */
  listAgentIdsByHost: (hostId: string) => readonly string[];
}

/**
 * Fan an `agent_availability_changed` invalidation to every viewer of every
 * agent on `hostId`. Idempotent and side-effect-free beyond publishing: safe to
 * call on any attachment edge, including a redundant one.
 */
export function publishAgentAvailabilityChangedForHost(
  ctx: BackendContext,
  deps: AgentAvailabilityChangedDeps,
  hostId: string,
): void {
  for (const agentId of deps.listAgentIdsByHost(hostId)) {
    const payload: AgentAvailabilityChangedEvent = { agent_id: agentId };
    for (const userId of agentViewerUserIds(ctx, agentId)) {
      ctx.events.publishToScope(
        `viewer:${userId}`,
        AGENT_AVAILABILITY_CHANGED_EVENT,
        payload,
      );
    }
  }
}
