// Capability surface, owning both the management routes and the cross-cutting
// enforcement guard:
//   - GET /api/workspaces/:id/members/:agentId/capabilities  (createWorkspaceCapabilityApp; viewer-gated)
//   - PUT /api/workspaces/:id/members/:agentId/capabilities  (createWorkspaceCapabilityApp; admin-gated)
//   - requireAgentCapability — the enforcement guard used across the internal
//     router and injected into the membership internal add as the
//     `RequireAgentCapability` port. This module is the port's provider side;
//     the port TYPE stays consumer-owned in routes/membership.ts (dependency
//     inversion) and routes.ts does the wiring.
//
// There is no separate role/governance route surface — `canGovernWorkspace` is a
// permission predicate used as a gate, not a route. So this is one context.
import { Hono, type Context } from 'hono';
import { apiPaths, UpdateAgentCapabilitiesInputSchema, type AgentCapability } from '@silverhand/shared';
import type { BackendContext } from '../context.js';
import type { AppEnv, Principal } from '../auth/principal.js';
import { getUserPrincipal } from '../auth/principal.js';
import { canAgentUseCapability, canGovernWorkspace, canViewWorkspace } from '../permissions.js';
import { WorkspaceRepo } from '../repos/workspace-repo.js';
import { AgentCapabilityRepo } from '../repos/agent-capability-repo.js';

/**
 * Typed capability denial. Returns
 * a 403 with the capability as its OWN field — never string-stuffed into
 * `error` — so the agent/CLI can parse and degrade. Returns `null` when
 * the agent holds `capability` in `workspaceId` (caller proceeds). A
 * missing/unresolved `workspaceId` is treated as a denial (the route's
 * existing conversation gate has already run, so this is defensive).
 *
 * The enforcement guard for the whole internal router; lives in the capability
 * context and is also wired into the membership internal add's injected
 * `RequireAgentCapability` port.
 */
export function requireAgentCapability(
  c: Context,
  ctx: BackendContext,
  principal: Principal,
  capability: AgentCapability,
  workspaceId: string | null | undefined,
): Response | null {
  if (workspaceId && canAgentUseCapability(ctx, principal, capability, { workspaceId })) {
    return null;
  }
  // `capability` stays a top-level typed field — never
  // string-stuffed). The CLI keeps `capability_denied` as its own stable
  // error code: when this explicit `code` is present `mapHttpError`
  // preserves it verbatim (a codeless 403 still falls back to `forbidden`).
  // `message` + `details.capability` carry the human-readable line and the
  // missing bucket through that path.
  return c.json(
    {
      code: 'capability_denied',
      capability,
      message: `missing '${capability}' capability in this workspace`,
      details: { capability },
    },
    403,
  );
}

export interface CapabilityRouteDeps {
  ctx: BackendContext;
  workspaces: WorkspaceRepo;
}

/**
 * Workspace-agent capability management surface (api router): GET view + PUT
 * replace-set, as a mountable sub-app. GET is viewer-gated (`canViewWorkspace`):
 * any workspace viewer may see what an agent is allowed to do. PUT is admin-gated
 * (`canGovernWorkspace 'admin'`): replace-set. Both assert the (workspace, agent)
 * pair is a real `workspace_members` row FIRST (404) — otherwise a viewer could
 * read/write a phantom cap set for a non-member agent.
 */
export function createWorkspaceCapabilityApp(
  deps: CapabilityRouteDeps,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { ctx, workspaces } = deps;

  app.get(apiPaths.workspaceAgentCapabilities(':id', ':agentId'), c => {
    const id = c.req.param('id');
    const agentId = c.req.param('agentId');
    if (!id || !agentId) {
      return c.json({ error: 'workspace id and agent id required' }, 400);
    }
    const workspace = workspaces.get(id);
    if (!workspace) return c.json({ error: 'workspace not found' }, 404);
    if (!canViewWorkspace(ctx, getUserPrincipal(c), workspace.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    if (!workspaces.isMember(workspace.id, agentId)) {
      return c.json({ error: 'agent is not a member of this workspace' }, 404);
    }
    const capabilities = new AgentCapabilityRepo(ctx.db).list(workspace.id, agentId);
    return c.json({ workspace_id: workspace.id, agent_id: agentId, capabilities });
  });

  app.put(apiPaths.workspaceAgentCapabilities(':id', ':agentId'), async c => {
    const id = c.req.param('id');
    const agentId = c.req.param('agentId');
    if (!id || !agentId) {
      return c.json({ error: 'workspace id and agent id required' }, 400);
    }
    const workspace = workspaces.get(id);
    if (!workspace) return c.json({ error: 'workspace not found' }, 404);
    if (!canGovernWorkspace(ctx, getUserPrincipal(c), workspace.id, 'admin')) {
      return c.json({ error: 'forbidden' }, 403);
    }
    if (!workspaces.isMember(workspace.id, agentId)) {
      return c.json({ error: 'agent is not a member of this workspace' }, 404);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = UpdateAgentCapabilitiesInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const repo = new AgentCapabilityRepo(ctx.db);
    repo.replaceSet(workspace.id, agentId, parsed.data.capabilities);
    return c.json({
      workspace_id: workspace.id,
      agent_id: agentId,
      capabilities: repo.list(workspace.id, agentId),
    });
  });

  return app;
}
