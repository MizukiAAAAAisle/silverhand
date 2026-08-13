// Capability surface, owning both the management routes and the cross-cutting
// enforcement guard:
//   - GET /api/workspaces/:id/agents/:agentId/capabilities  (createWorkspaceCapabilityApp; viewer-gated)
//   - PUT /api/workspaces/:id/agents/:agentId/capabilities  (createWorkspaceCapabilityApp; admin-or-creator-gated)
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
import { canAgentUseCapability, canEditAgentCapabilities, canViewWorkspace } from '../permissions.js';
import { WorkspaceRepo } from '../repos/workspace-repo.js';
import type { AgentCapabilityRepo } from '../repos/agent-capability-repo.js';

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
  /** #task:1983 W3 — the capability store, received instead of constructed:
   *  these two handlers are the only capability WRITE/LIST surface, and the
   *  enforcement read lives behind `canAgentUseCapability`. */
  capabilities: AgentCapabilityRepo;
}

/**
 * Workspace-agent capability management surface (api router): GET view + PUT
 * replace-set, as a mountable sub-app. GET is viewer-gated (`canViewWorkspace`):
 * any workspace viewer may see what an agent is allowed to do. PUT is gated by
 * `canEditAgentCapabilities` (#task:1777): workspace `admin` (governs the whole
 * roster's caps) OR a workspace `member` who CREATED the target agent — the same
 * single-layer co-editor authority as enrollment (approved #1775 option A). Both
 * assert the (workspace, agent) pair is a real `workspace_members` row — but
 * AFTER authorization, never before (a phantom-pair 404 must not leak roster
 * membership to a caller who isn't admin/creator; see the ordering note on PUT).
 *
 * Freshness (explicit, #task:1777): there is NO realtime cross-device editor
 * sync. Enforcement is always live — `canAgentUseCapability` reads the DB per
 * request, so the security boundary is never stale. The editor is authoritative
 * on fetch (GET) and on its own PUT response (returns the full set). A second
 * co-editor's open page may be stale and its submit is last-write-wins — the
 * accepted single-layer concurrency contract, NOT a bug. `replaceSet` therefore
 * publishes no event by design.
 */
export function createWorkspaceCapabilityApp(
  deps: CapabilityRouteDeps,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { ctx, workspaces, capabilities: capabilityStore } = deps;

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
    const capabilities = capabilityStore.list(workspace.id, agentId);
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
    // Authorize BEFORE the membership 404 (#task:1777): admin OR the agent's
    // creator (both must be workspace members). Ordering is deliberate — a
    // membership-first 404 would leak whether the pair exists to any authed
    // caller; only an authorized caller ever learns the pair is invalid.
    if (!canEditAgentCapabilities(ctx, getUserPrincipal(c), workspace.id, agentId)) {
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
    capabilityStore.replaceSet(workspace.id, agentId, parsed.data.capabilities);
    return c.json({
      workspace_id: workspace.id,
      agent_id: agentId,
      capabilities: capabilityStore.list(workspace.id, agentId),
    });
  });

  return app;
}
