// Public `GET /api/agents/:id/availability` surface (#task:2043), extracted from
// `agents.ts` so one wire authority answers the route and both the parity oracle
// and the production mount consume THIS factory rather than a re-implementation.
import { getUserPrincipal, type AppEnv } from '../auth/principal.js';
import type { BackendContext } from '../context.js';
import { canViewAgent } from '../permissions.js';
import type { AgentRepo } from '../repos/agent-repo.js';
import type { HostRepo } from '../repos/host-repo.js';
import {
  type AgentDto,
  type AgentAvailability,
  type AgentAvailabilityDto,
} from '@silverhand/shared';
import { Hono } from 'hono';

export interface AvailabilityRouteDeps {
  ctx: BackendContext;
  agents: AgentRepo;
  /** #task:2043 — read `host.revoked_at` for the viewer-authorized availability
   *  bit: a revoked host reads `offline` even while a socket lingers. */
  hosts: HostRepo;
}

export function createAvailabilityApp(deps: AvailabilityRouteDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { ctx, agents, hosts } = deps;

  // ── GET /api/agents/:id/availability (#task:2043) ─────────────────────────
  // Read this face against the concept it is NOT: process-aliveness ("is a live
  // process running right now?"), which #task:2049 retired as a presence input
  // and #task:2056 deleted as a read face — there is no per-agent liveness
  // endpoint, and the surviving `host_agent_liveness_changed` frame is a
  // HOST-level owner-scoped invalidation, not a viewer read face. Availability
  // asks whether this agent is REACHABLE right now. Same `canViewAgent` gate
  // (incl. the DirectPair-endpoint arm). Availability reuses the EXACT authority
  // the delivery path reads for its transport gate:
  // `ctx.outboundFrameAdapter().connectionIdForHost(hostId)`
  // — the first two gates of real delivery (host exists & not revoked; an
  // outbound attachment is connected) MINUS the runtime-hydrate wait. Reading
  // the same port the delivery gate reads is load-bearing: the (B)
  // `agent_availability_changed` producer fires on this adapter's attach/detach
  // edges, so the read face and the event face observe ONE fact and cannot
  // drift into two middle layers.
  //
  // It deliberately does NOT consult `hostStatusReadModel`: that is a SEPARATE
  // optional port carrying seed / snapshot / hydrate / retry semantics that are
  // irrelevant to reachability. Gating on ITS presence (as an earlier cut did)
  // reports Offline on a deployment that wired the delivery transport without
  // the snapshot projection — an attachment the delivery gate would happily
  // accept. So an idle-reaped or not-yet-hydrated agent on a connected host
  // stays `online` (the next message re-spawns it), hydration never enters the
  // dependency graph, and that decoupling is the fix for a DM partner seeing
  // `offline` after every turn.
  //
  // TWO values, total. The attachment fact is total (present or absent); there
  // is no success `unknown` arm — a read that cannot be answered is an infra
  // fault (let it throw ⇒ 5xx), and "we cannot tell" is a RENDERER query
  // projection, not a backend value.
  const resolveAgentAvailability = (agent: AgentDto): AgentAvailability => {
    // Agent validity: an agent mid hard-delete can no longer accept work.
    if (agent.deletion_started_at !== null) return 'offline';
    // Host validity. The revoke check is load-bearing on its own: a bare DB
    // revoke may race ahead of the socket teardown, so a still-attached but
    // revoked host must not read `online` off a lingering connection.
    const host = hosts.get(agent.host_id);
    if (!host || host.revoked_at !== null) return 'offline';
    // Attachment presence — the SAME port the delivery transport gate reads.
    const connectionId =
      ctx.outboundFrameAdapter?.()?.connectionIdForHost(agent.host_id) ?? null;
    return connectionId !== null ? 'online' : 'offline';
  };

  app.get('/api/agents/:id/availability', c => {
    const agent = agents.get(c.req.param('id'));
    if (!agent) return c.json({ error: 'agent not found' }, 404);
    if (!canViewAgent(ctx, getUserPrincipal(c), agent.id)) {
      return c.json({ error: 'agent not found' }, 404);
    }
    return c.json({
      availability: resolveAgentAvailability(agent),
    } satisfies AgentAvailabilityDto);
  });

  return app;
}
