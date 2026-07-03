// Agent-owned profile MCP facet (silverhand CLI → backend). `profile` is the
// executing subject's L1 (agent-global) config; the routes hang off the calling
// conversation so the internal principal middleware (cid+aid → AgentPrincipal)
// authenticates self-only via `canEditAgent`. Unlike the profile text/avatar
// sibling (DB/blob writes), the raw `mcp.json` is host-local truth reached via
// the data-plane dispatch, so this is its own bounded context: GET reads
// (raw|null, absent is normal), SET validates here (fail-loud `invalid_config`)
// BEFORE the atomic host write, PROBE opens a live one-shot connection. Effect
// is next-spawn (no hot reload) — the CLI/prompt say so.
import type { Hono } from 'hono';
import {
  getAgentPrincipal,
  type AppEnv,
} from '../../auth/principal.js';
import { canEditAgent } from '../../permissions.js';
import {
  dispatchAgentProfileMcpRead,
  dispatchAgentProfileMcpWrite,
  dispatchMcpProbe,
  resolveOutboundForHost,
} from '../../runtime/workspace-data-plane.js';
import {
  McpProbeRequestSchema,
  parseMcpConfig,
  internalPaths,
} from '@silverhand/shared';
import type { InternalRouteDeps } from './deps.js';

export function registerProfileMcpRoutes(
  app: Hono<AppEnv>,
  deps: InternalRouteDeps,
): void {
  const { ctx, agents, conversations } = deps;

  app.get(internalPaths.agentProfileMcpGet(':cid', ':aid'), async c => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    if (!conversations.get(cid)) return c.json({ error: 'conversation not found' }, 404);
    const agent = agents.get(aid);
    if (!agent) return c.json({ error: 'agent not found' }, 404);
    const principal = getAgentPrincipal(c);
    if (!canEditAgent(ctx, principal, aid)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const outbound = resolveOutboundForHost(
      ctx.outboundFrameAdapter?.() ?? null,
      agent.host_id,
    );
    if (outbound.kind === 'failed') {
      return c.json({ error: outbound.message, code: outbound.code }, outbound.status);
    }
    const mcp = await dispatchAgentProfileMcpRead(
      outbound.adapter,
      agent.host_id,
      outbound.connectionId,
      { agent_id: aid },
    );
    if (mcp.kind === 'failed') {
      return c.json({ error: mcp.message, code: mcp.code }, mcp.status);
    }
    return c.json({ raw: mcp.result.raw });
  });

  app.post(internalPaths.agentProfileMcpSet(':cid', ':aid'), async c => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    if (!conversations.get(cid)) return c.json({ error: 'conversation not found' }, 404);
    const agent = agents.get(aid);
    if (!agent) return c.json({ error: 'agent not found' }, 404);
    const principal = getAgentPrincipal(c);
    if (!canEditAgent(ctx, principal, aid)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    // The body is the raw JSON text the agent piped in. Read it verbatim —
    // the file persists the user's own formatting, not a re-serialized copy.
    const raw = await c.req.text();
    // Backend is the PRIMARY validation authority: reject a bad payload here
    // (fail-loud) so nothing crosses the wire / touches disk. The daemon
    // re-validates as belt-and-suspenders.
    const parsed = parseMcpConfig(raw);
    if (!parsed.ok) {
      return c.json({ error: parsed.error, code: 'invalid_config' }, 400);
    }
    const outbound = resolveOutboundForHost(
      ctx.outboundFrameAdapter?.() ?? null,
      agent.host_id,
    );
    if (outbound.kind === 'failed') {
      return c.json({ error: outbound.message, code: outbound.code }, outbound.status);
    }
    const written = await dispatchAgentProfileMcpWrite(
      outbound.adapter,
      agent.host_id,
      outbound.connectionId,
      { agent_id: aid, raw },
    );
    if (written.kind === 'failed') {
      return c.json({ error: written.message, code: written.code }, written.status);
    }
    return c.json({ ok: true, bytes_written: written.result.bytes_written });
  });

  // #task:1137 — `silverhand profile mcp probe`. Live one-shot MCP connection
  // to a named profile server (initialize + optional tools/list), closed
  // immediately by the daemon. Same self-only `canEditAgent` gate as get/set
  // (a probe connects to the user's endpoint with their secrets). The
  // connection's own success/failure rides in the `McpProbeResult` body; only
  // host-transport faults map to an HTTP error.
  app.post(internalPaths.agentProfileMcpProbe(':cid', ':aid'), async c => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    if (!conversations.get(cid)) return c.json({ error: 'conversation not found' }, 404);
    const agent = agents.get(aid);
    if (!agent) return c.json({ error: 'agent not found' }, 404);
    const principal = getAgentPrincipal(c);
    if (!canEditAgent(ctx, principal, aid)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = McpProbeRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: 'invalid input', code: 'invalid_input', issues: parsed.error.issues },
        400,
      );
    }
    const outbound = resolveOutboundForHost(
      ctx.outboundFrameAdapter?.() ?? null,
      agent.host_id,
    );
    if (outbound.kind === 'failed') {
      return c.json({ error: outbound.message, code: outbound.code }, outbound.status);
    }
    const probe = await dispatchMcpProbe(
      outbound.adapter,
      agent.host_id,
      outbound.connectionId,
      {
        source: { kind: 'profile', agent_id: aid },
        server_name: parsed.data.server_name,
        include_tools: parsed.data.include_tools,
      },
    );
    if (probe.kind === 'failed') {
      return c.json({ error: probe.message, code: probe.code }, probe.status);
    }
    return c.json(probe.result);
  });
}
