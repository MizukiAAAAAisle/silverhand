// Agent profile facet (silverhand CLI → backend). Two axes, deliberately not
// one: the SELF axis (avatar set/clear, display_name / description read+write)
// is self-only STRUCTURALLY — the agent-token middleware pins
// `principal.agentId === :aid` from the spawn-injected token, so there is no
// caller-chosen target, and `canEditAgent` is the defensive double-check that
// for an agent principal reduces to the self predicate. The PEER axis
// (#task:1823) is read-only and takes its target as a handle, gated by
// workspace co-membership + `read_messages`; it never touches the self routes'
// pin. These fields are DB columns / blob on `agents`, so the backend writes
// them directly via the repo / avatar service — no host round-trip (unlike
// profile MCP, which lives in a sibling module and stays self-only).
import type { Hono } from 'hono';
import {
  getAgentPrincipal,
  type AppEnv,
} from '../../auth/principal.js';
import {
  canAgentAccessWorkspace,
  canEditAgent,
  canViewConversation,
} from '../../permissions.js';
import { requireAgentCapability } from '../capability.js';
import {
  agentServiceErrorBody,
  agentServiceErrorStatus,
} from '../responses.js';
import {
  AgentPeerProfileQuerySchema,
  UpdateProfileInputSchema,
  normalizeHandle,
  type AgentProfileDto,
} from '@silverhand/shared';
import type { InternalRouteDeps } from './deps.js';
import { internalAgentRoutePaths } from './paths.js';

/**
 * The ONE profile projection, shared by the self read/write and the peer read
 * (#task:1823). Peer reads deliberately return the identical shape: forking a
 * narrower "public profile" DTO would make one domain fact two contracts, and
 * nothing in it is privileged — `id` buys no authority (every self route is
 * token-pinned) and `avatar_url` is a derived read-only Silverhand route.
 */
const toAgentProfileDto = (dto: {
  id: string;
  name: string;
  display_name: string;
  description: string | null;
  avatar_url: string | null;
}): AgentProfileDto => ({
  id: dto.id,
  name: dto.name,
  display_name: dto.display_name,
  description: dto.description,
  avatar_url: dto.avatar_url,
});

export function registerProfileRoutes(
  app: Hono<AppEnv>,
  deps: InternalRouteDeps,
): void {
  const { ctx, agents, conversations, workspaces } = deps;

  // ── Agent self-edit avatar (silverhand CLI → backend) ────────────
  // The agent token middleware already enforces `principal.agentId ===
  // :aid`, so the URL pin alone makes this self-only. `canEditAgent`
  // is called as a defensive double-check (mirrors the public route)
  // and to keep the agent-self branch of the predicate exercised by
  // tests instead of dead code.
  //
  // Only the avatar is exposed here — display_name / description /
  // runtime / reasoning_effort / fast_mode self-edit is **not**
  // covered by PR-2. Cross-creator profile edits go through the
  // public `PATCH /api/agents/:id` (creator-only); agent self-edit
  // for those fields is a future internal route, not implied by this
  // PR.

  app.post(internalAgentRoutePaths.avatar, async c => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    if (!conversations.get(cid)) return c.json({ error: 'conversation not found' }, 404);
    if (!agents.get(aid)) return c.json({ error: 'agent not found' }, 404);
    const principal = getAgentPrincipal(c);
    if (!canEditAgent(ctx, principal, aid)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return c.json({ error: 'multipart/form-data required' }, 400);
    }
    const file = form.get('file');
    if (!(file instanceof File)) {
      return c.json({ error: 'file field required' }, 400);
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    try {
      const dto = await ctx.agentService.uploadAvatar(aid, {
        buffer,
        contentType: file.type || 'application/octet-stream',
        filename: file.name || 'avatar',
      });
      return c.json({ avatar_url: dto.avatar_url, agent: dto });
    } catch (err) {
      const status = agentServiceErrorStatus(err);
      if (status) return c.json(agentServiceErrorBody(err), status);
      throw err;
    }
  });

  app.delete(internalAgentRoutePaths.avatar, async c => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    if (!conversations.get(cid)) return c.json({ error: 'conversation not found' }, 404);
    if (!agents.get(aid)) return c.json({ error: 'agent not found' }, 404);
    const principal = getAgentPrincipal(c);
    if (!canEditAgent(ctx, principal, aid)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    try {
      const dto = await ctx.agentService.clearAvatar(aid);
      return c.json({ agent: dto });
    } catch (err) {
      const status = agentServiceErrorStatus(err);
      if (status) return c.json(agentServiceErrorBody(err), status);
      throw err;
    }
  });

  // ── Agent self-edit profile metadata (silverhand CLI → backend) ──
  // #task:1178 — `silverhand profile get|update` for display_name /
  // description / avatar. Same self-only contract as the avatar routes
  // above: the principal middleware pins `principal.agentId === :aid` from
  // the spawn-injected token, so there is NO caller-chosen target (the CLI
  // has no `--agent-id` flag — self-edit is STRUCTURAL, not merely gated).
  // `canEditAgent` is the defensive double-check; for an agent principal it
  // reduces to the self predicate.
  //
  // Unlike profile MCP (host-local L1 file → data plane), these fields are
  // DB columns / blob on `agents`, so the backend writes them directly via
  // the repo / avatar service — no host round-trip. Cross-creator human
  // edits go through the public `PATCH /api/agents/:id` (creator-only);
  // this is the agent-self counterpart.
  //
  // UPDATE is ONE multipart request: text fields + the avatar action travel
  // together, and every input (text schema + avatar bytes/MIME via the avatar
  // service) is validated BEFORE any write, so a bad value can never land a
  // half-applied edit. This is NOT cross-store atomic, though: the avatar blob
  // (storage + DB pointer) is written before the text columns, with no
  // transaction spanning blob storage and SQLite — so an infra failure on the
  // text write *after* a successful avatar write leaves the avatar changed.
  // The clean target (write the blob orphan-safe, then a single `agents.update`
  // carrying pointer + text) needs the avatar service to split blob-store from
  // pointer-write; tracked as a follow-up, not v1. The avatar bytes ride a
  // `file` part (never base64 in JSON); the avatar service stays the single
  // MIME/size/storage validator.

  app.get(internalAgentRoutePaths.profile, async c => {
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
    return c.json({ profile: toAgentProfileDto(agent) });
  });

  app.post(internalAgentRoutePaths.profile, async c => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    if (!conversations.get(cid)) return c.json({ error: 'conversation not found' }, 404);
    if (!agents.get(aid)) return c.json({ error: 'agent not found' }, 404);
    const principal = getAgentPrincipal(c);
    if (!canEditAgent(ctx, principal, aid)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return c.json({ error: 'multipart/form-data required' }, 400);
    }

    // Collect text fields. `null` (absent) → leave unchanged; a present
    // value (incl. empty string) → update. Validate as a unit BEFORE any
    // write so a bad value can't land a half-applied edit.
    const textInput: Record<string, unknown> = {};
    const rawDisplayName = form.get('display_name');
    if (typeof rawDisplayName === 'string') textInput.display_name = rawDisplayName;
    const rawDescription = form.get('description');
    if (typeof rawDescription === 'string') textInput.description = rawDescription;
    const hasText = Object.keys(textInput).length > 0;

    const avatarAction = form.get('avatar_action');
    if (avatarAction !== null && avatarAction !== 'set' && avatarAction !== 'clear') {
      return c.json({ error: 'avatar_action must be "set" or "clear"' }, 400);
    }
    if (!hasText && avatarAction === null) {
      return c.json({ error: 'no fields to update' }, 400);
    }

    let parsedText: ReturnType<typeof UpdateProfileInputSchema.safeParse> | null = null;
    if (hasText) {
      parsedText = UpdateProfileInputSchema.safeParse(textInput);
      if (!parsedText.success) {
        return c.json({ error: 'invalid input', issues: parsedText.error.issues }, 400);
      }
    }

    // Apply avatar first (validated by the service), then text. Both are
    // pre-validated, so only I/O can fail past this point — and because the two
    // writes don't share a transaction, an I/O failure on the text write below
    // leaves the avatar already changed (the residual partial documented above).
    try {
      if (avatarAction === 'set') {
        const file = form.get('file');
        if (!(file instanceof File)) {
          return c.json({ error: 'file field required for avatar_action=set' }, 400);
        }
        const buffer = Buffer.from(await file.arrayBuffer());
        await ctx.agentService.uploadAvatar(aid, {
          buffer,
          contentType: file.type || 'application/octet-stream',
          filename: file.name || 'avatar',
        });
      } else if (avatarAction === 'clear') {
        await ctx.agentService.clearAvatar(aid);
      }
    } catch (err) {
      const status = agentServiceErrorStatus(err);
      if (status) return c.json(agentServiceErrorBody(err), status);
      throw err;
    }

    if (parsedText?.success) {
      // Through the service so the `agent_changed` refresh event fires in
      // the shared seam (same publish the avatar set/clear above use, and
      // the human PATCH route). On a combined text+avatar edit this emits
      // two `agent_changed` events (one per write) — harmless: clients
      // coalesce the invalidations.
      ctx.agentService.updateAgent(aid, parsedText.data);
    }

    const fresh = agents.get(aid);
    if (!fresh) return c.json({ error: 'agent not found' }, 404);
    return c.json({ profile: toAgentProfileDto(fresh) });
  });

  // ── Peer profile READ (#task:1823) ───────────────────────────────
  // Read ANOTHER agent's profile. Read horizon and write authority are
  // different axes: the self routes above are self-only STRUCTURALLY (the
  // token pins `:aid`), and that property is worth keeping, so the peer read
  // is a separate route with a caller-supplied HANDLE rather than a widened
  // gate on the self URL. `:aid` still means "the executing agent" here.
  //
  // Same projection as the self read — one `AgentProfileDto`, so "what a
  // profile is" cannot fork into a self shape and a public shape.
  //
  // Visibility: co-membership of a workspace the caller can reach. The order
  // is load-bearing (anti-enumeration, #957): every CALLER-SIDE gate — the
  // conversation floor, the workspace horizon, the capability — is resolved
  // BEFORE the target is resolved, so nothing about the target, not even
  // whether that handle exists, can be observed by a caller who fails them.
  // Query SYNTAX is validated first and that is deliberate: a 400 for a
  // malformed handle is a statement about the request, never about who
  // exists, and keeping it first is what lets the gates below assume a
  // well-formed input. Past those gates unknown handle / a handle that
  // belongs to a human / an agent outside this workspace collapse into ONE
  // identical 404: a handle is globally unique across `users.name` ⊕
  // `agents.name`, so a distinguishable "that's a human" would answer a
  // cross-workspace existence question (§AP).
  app.get(internalAgentRoutePaths.peerProfile, c => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    const parsedQuery = AgentPeerProfileQuerySchema.safeParse({
      handle: c.req.query('handle'),
      workspace_id: c.req.query('workspace_id') || undefined,
    });
    if (!parsedQuery.success) {
      return c.json(
        { error: 'invalid query', issues: parsedQuery.error.issues },
        400,
      );
    }
    const principal = getAgentPrincipal(c);
    if (!canViewConversation(ctx, principal, principal.conversationId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const sourceConversation = conversations.get(principal.conversationId);
    if (!sourceConversation) {
      return c.json({ error: 'conversation not found' }, 404);
    }
    // Default to the source workspace; a cross-workspace target is gated by
    // the caller's own workspace horizon (`canAgentAccessWorkspace` =
    // workspace_members ∪ owned agent_home), mirroring `list_channels`.
    const targetWorkspaceId =
      parsedQuery.data.workspace_id ?? sourceConversation.workspace_id;
    if (targetWorkspaceId !== sourceConversation.workspace_id) {
      if (!canAgentAccessWorkspace(ctx, principal.agentId, targetWorkspaceId)) {
        return c.json({ error: 'forbidden' }, 403);
      }
    }
    {
      const denied = requireAgentCapability(
        c,
        ctx,
        principal,
        'read_messages',
        targetWorkspaceId,
      );
      if (denied) return denied;
    }
    const target = agents.getByName(normalizeHandle(parsedQuery.data.handle));
    // Target membership is the authoritative `workspace_members` edge — NOT
    // the caller-side horizon predicate, which also admits an agent's own
    // home workspace. Being reachable BY the caller and being a member OF the
    // workspace are different facts.
    if (!target || !workspaces.isMember(targetWorkspaceId, target.id)) {
      return c.json({ error: 'agent not found' }, 404);
    }
    return c.json({ profile: toAgentProfileDto(target) });
  });
}
