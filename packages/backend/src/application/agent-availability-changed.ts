import {
  AGENT_AVAILABILITY_CHANGED_EVENT,
  type AgentAvailabilityChangedEvent,
} from '@silverhand/shared';

import type { UserPrincipal } from '../auth/principal.js';
import type { BackendContext } from '../context.js';
import { canViewAgent } from '../permissions.js';

/**
 * Producer for `agent_availability_changed` (#task:2043 B) — the cache
 * invalidation that pairs with `GET /api/agents/:id/availability`.
 *
 * It fires on TRANSPORT-REACHABILITY transitions (an outbound attachment
 * connects / disconnects, a host is revoked), which is exactly the fact the
 * read face reads (`outboundFrameAdapter().connectionIdForHost`). It is emitted
 * from the host-ws attachment set/close edges — the same edges that already
 * announce `host_connection_changed` — NOT from hydration (`onSeeded`) or from
 * runtime-liveness changes, neither of which moves availability.
 *
 * The frame carries only the agent id: a subscriber's sole reaction is to
 * refetch `/availability`, so the route stays the single source of the value
 * (mirrors `agent_changed` / `direct_pairs_changed`).
 *
 * `BackendContext` carries no db handle or repos, so the two readers the fan-out
 * needs beyond `ctx.authorizationReads` are injected at the composition root.
 */
export interface AgentAvailabilityChangedDeps {
  /** Every agent id currently bound to `hostId` (all share the host's
   *  reachability, so all of their availability values move together). */
  listAgentIdsByHost: (hostId: string) => readonly string[];
  /** User member ids of a workspace — the workspace arm of the view audience. */
  workspaceMemberUserIds: (workspaceId: string) => readonly string[];
}

/**
 * The users who may currently read an agent's availability — the audience DUAL
 * of `canViewAgent`. Built as the union of that predicate's ACL arms (owner ∪
 * DirectPair human endpoints ∪ shared-workspace members) and then filtered
 * through `canViewAgent` per candidate. The filter is load-bearing, not
 * belt-and-suspenders: it keeps enumeration EXACT against future changes to the
 * predicate's arms or to its active-only status widener, so a viewer who cannot
 * read the route never receives its invalidation and one who can is never
 * missed. A non-`active` agent (404 for everyone) yields an empty audience and
 * emits nothing, with no special-case here.
 */
function availabilityAudience(
  ctx: BackendContext,
  deps: AgentAvailabilityChangedDeps,
  agentId: string,
): string[] {
  const reads = ctx.authorizationReads;
  const candidates = new Set<string>();

  const facts = reads.agent(agentId);
  if (facts?.created_by_user_id) candidates.add(facts.created_by_user_id);
  for (const userId of reads.agentDirectPairHumanEndpointIds(agentId)) {
    candidates.add(userId);
  }
  for (const workspaceId of reads.agentWorkspaceIds(agentId)) {
    for (const userId of deps.workspaceMemberUserIds(workspaceId)) {
      candidates.add(userId);
    }
  }

  return [...candidates].filter(userId => {
    const principal: UserPrincipal = { kind: 'user', userId };
    return canViewAgent(ctx, principal, agentId);
  });
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
    for (const userId of availabilityAudience(ctx, deps, agentId)) {
      ctx.events.publishToScope(
        `viewer:${userId}`,
        AGENT_AVAILABILITY_CHANGED_EVENT,
        payload,
      );
    }
  }
}
