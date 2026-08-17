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
 * Availability = agent validity × host reachability, and this producer fires on
 * a transition of EITHER fact the read face reads
 * (`routes/agents.ts:resolveAgentAvailability`):
 *   - host reachability: an outbound attachment connects/disconnects, or a host
 *     is revoked — a PER-HOST edge, so {@link publishAgentAvailabilityChangedForHost}
 *     enumerates the host's agents (they share the host, so their availability
 *     values move together);
 *   - agent validity: `deletion_started_at` flips null→timestamp at
 *     `deleteAgent`'s `begin` — a PER-AGENT edge with no transport change and no
 *     revoke, so nothing on the host path would ever announce it. This is why
 *     the primitive is per-agent ({@link publishAgentAvailabilityChangedForAgent});
 *     the host fan-out is just an enumerate-and-call over it.
 * It is NOT emitted from hydration (`onSeeded`) or runtime-liveness changes,
 * neither of which moves availability.
 *
 * The frame carries only the agent id: a subscriber's sole reaction is to
 * refetch `/availability`, so the route stays the single source of the value
 * (mirrors `agent_changed` / `direct_pairs_changed`).
 *
 * WHO to notify is an access decision, so it lives in the authorization surface
 * (`permissions.agentViewerUserIds`, the dual of `canViewAgent`), not here. This
 * module is a pure fan-out: the per-agent primitive needs only that reader, and
 * the host fan-out additionally needs the host→agents binding, which is not an
 * access fact and — since `BackendContext` carries no repos — is injected at the
 * composition root.
 */
export interface AgentAvailabilityChangedDeps {
  /** Every agent id currently bound to `hostId` (all share the host's
   *  reachability, so all of their availability values move together). */
  listAgentIdsByHost: (hostId: string) => readonly string[];
}

/**
 * The ONE primitive: fan an `agent_availability_changed` invalidation to every
 * current viewer of `agentId`. Every availability transition ultimately routes
 * through here — the per-host edge enumerates and calls it, the per-agent
 * validity edge (`deletion_started_at`) calls it directly. Idempotent and
 * side-effect-free beyond publishing: safe to call on a redundant edge.
 */
export function publishAgentAvailabilityChangedForAgent(
  ctx: BackendContext,
  agentId: string,
): void {
  const payload: AgentAvailabilityChangedEvent = { agent_id: agentId };
  for (const userId of agentViewerUserIds(ctx, agentId)) {
    ctx.events.publishToScope(
      `viewer:${userId}`,
      AGENT_AVAILABILITY_CHANGED_EVENT,
      payload,
    );
  }
}

/**
 * Fan an `agent_availability_changed` invalidation to every viewer of every
 * agent on `hostId`, by enumerating the host's agents and firing the per-agent
 * primitive for each. The host's reachability moved (attach/detach/revoke), so
 * every agent bound to it changed availability together.
 */
export function publishAgentAvailabilityChangedForHost(
  ctx: BackendContext,
  deps: AgentAvailabilityChangedDeps,
  hostId: string,
): void {
  for (const agentId of deps.listAgentIdsByHost(hostId)) {
    publishAgentAvailabilityChangedForAgent(ctx, agentId);
  }
}
