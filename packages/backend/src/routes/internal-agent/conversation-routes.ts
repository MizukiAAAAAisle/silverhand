// Agent conversation-topology facet: create-channel, follow/unfollow-thread,
// list-workspaces, list-channels. Read-side discovery plus the create-channel
// write; the reads are scoped to the calling agent's visibility / membership,
// while create-channel takes its source conversation as an ADDRESS (#task:2021
// P4-4).
import type { Hono } from 'hono';
import { performance } from 'node:perf_hooks';
import {
  getAgentPrincipal,
  type AppEnv,
} from '../../auth/principal.js';
import type { BackendContext } from '../../context.js';
import {
  canAgentAccessWorkspace,
  canViewConversation,
} from '../../permissions.js';

import {
  SLOW_ROUTE_SPAN_MS,
  elapsedSince,
  timedRouteSpan,
} from '../../observability/route-span.js';
import {
  dispatchAgentWorkspaceIndex,
  resolveOutboundForHost,
  type DataPlaneFailure,
  type DataPlaneHttpStatus,
} from '../../runtime/workspace-data-plane.js';
import { requireAgentCapability } from '../capability.js';
import {
  channelServiceErrorResponse,
  conversationMessageServiceErrorResponse,
} from '../responses.js';
import {
  AgentCreateChannelInputSchema,
  AgentFollowThreadInputSchema,
  AgentListChannelsQuerySchema,
  type AgentListWorkspacesDto,
  type AgentListedWorkspace,
} from '@silverhand/shared';
import type { InternalRouteDeps } from './deps.js';
import { requireAgentConversationCapability } from './capability-scope.js';
import { resolveConversationTargetForRoute } from './delivery-target.js';
import { resolveAgentQueryWorkspaceId } from './workspace-scope.js';
import { internalAgentRoutePaths } from './paths.js';

/**
 * Build the cross-workspace `list_workspaces` payload for the calling
 * agent. The workspace list is the canonical
 * `WorkspaceRepo.listForAgent` (regular ∪ owned agent_home); per-row
 * `agent_dir` is daemon-stamped: the route does
 * the ACL/DB list, then dispatches the narrow `agent_workspace_index`
 * intent to the owning daemon, which computes `agent_dir` from the
 * DETERMINISTIC agent-centric coordinate `<agent home>/workspaces/<id>`
 * (regular) or its own agent home (agent_home) — relocation-v1 §7 retired
 * both the DB column and the daemon registry binding as path sources.
 *
 * The backend NEVER derives `agent_dir` itself (I1). Two failure axes stay
 * separate:
 *   - transport/host-level (no outbound adapter, offline host, malformed
 *     response) FAILS CLOSED with a diagnostic code — never a fabricated
 *     path;
 *   - a single id the daemon leaves unresolved (the bundle has not been
 *     materialized on this computer yet, because the membership is a pure DB
 *     write until first spawn) degrades PER ENTRY to `agent_dir: null`. A
 *     regular workspace has no home computer, so there is no same-home
 *     inconsistency left to fail the whole response on (§3.4).
 *
 * Cross-computer slice 2 (#task:1600): the resolution axis is the AGENT's
 * host — the index renders paths as seen from the agent's own computer, so
 * there is exactly ONE daemon to ask regardless of which computers the other
 * members run on. The old multi-host `workspace_host_ambiguous` rejection is
 * gone with the I4 same-host invariant it defended.
 */
type AgentListWorkspacesOutcome =
  | { kind: 'ok'; dto: AgentListWorkspacesDto }
  | { kind: 'failed'; code: string; message: string; status: DataPlaneHttpStatus };

async function buildAgentListWorkspacesDto(
  // #task:1983 W3 — the two reads this builder needs come from the facet's
  // dependency bag (already constructed by the composition root); `ctx` is here
  // for the outbound adapter thunk alone.
  deps: Pick<InternalRouteDeps, 'ctx' | 'agents' | 'workspaces'>,
  agentId: string,
): Promise<AgentListWorkspacesOutcome> {
  const { ctx } = deps;
  const workspaces = deps.workspaces.listForAgent(agentId);
  if (workspaces.length === 0) {
    return { kind: 'ok', dto: { workspaces: [] } };
  }

  const adapter = ctx.outboundFrameAdapter?.() ?? null;

  // Cross-computer slice 2 (#task:1600): resolve against the AGENT's own
  // daemon. Paths in this index are only meaningful on the computer the
  // agent runs on, so the agent's host is the single correct resolution
  // axis. There is no workspace-side axis to confuse it with any more —
  // relocation-v1 §7 retired the workspace's home computer entirely.
  const agent = deps.agents.get(agentId);
  if (!agent) {
    return {
      kind: 'failed',
      code: 'agent_not_found',
      message: `agent ${agentId} not found`,
      status: 404,
    };
  }
  const hostId = agent.host_id;
  const workspaceIds = workspaces.map(w => w.id);
  // #task:1612 — list resolution performs NO workspace provision: the
  // daemon's agent_workspace_index is the sole resolver. Any id it leaves
  // unresolved degrades per-entry to `agent_dir: null` ("not materialized on
  // this computer yet") — a regular workspace no longer has a home computer,
  // so there is no same-home registry inconsistency to fail closed on (§3.4).
  const agentDirById = new Map<string, string>();
  {
    const outbound = resolveOutboundForHost(adapter, hostId);
    if (outbound.kind === 'failed') {
      return failedOutcome(outbound);
    }
    const index = await dispatchAgentWorkspaceIndex(
      outbound.adapter,
      hostId,
      outbound.connectionId,
      { agent_id: agentId, workspace_ids: workspaceIds },
    );
    if (index.kind === 'failed') {
      return failedOutcome(index);
    }
    // relocation-v1 §3.4 — a regular workspace has no home computer any more,
    // so the old same-home (strict fail-closed) vs guest (degrade) split
    // collapses. Any id the daemon leaves unresolved is the EXPECTED "not
    // materialized on this computer yet" state (a pure-DB membership that has
    // never spawned) → degrade per-entry to `agent_dir: null` (never a
    // fabricated path, never a whole-response failure). It resolves once the
    // agent first materializes its own bundle on this computer.
    for (const entry of index.result.entries) {
      agentDirById.set(entry.workspace_id, entry.agent_dir);
    }
  }

  const dto: AgentListWorkspacesDto = {
    workspaces: workspaces.map((w): AgentListedWorkspace => {
      const agentDir = agentDirById.get(w.id) ?? null;
      return {
        id: w.id,
        name: w.name,
        kind: w.workspace_kind,
        archived: w.archived_at !== null,
        updated_at: w.updated_at,
        agent_dir: agentDir,
      };
    }),
  };
  return { kind: 'ok', dto };
}

function failedOutcome(f: DataPlaneFailure): {
  kind: 'failed';
  code: string;
  message: string;
  status: DataPlaneHttpStatus;
} {
  return { kind: 'failed', code: f.code, message: f.message, status: f.status };
}

export function registerConversationRoutes(
  app: Hono<AppEnv>,
  deps: InternalRouteDeps,
): void {
  const { ctx, agentReads, conversations } = deps;

  app.post(internalAgentRoutePaths.createChannel, async c => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = AgentCreateChannelInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }

    const principal = getAgentPrincipal(c);
    // The FORK SOURCE comes from the address, not from the credential's path
    // (#task:2021 P4-4). This door is a single-stream SOURCE operation: it reads
    // one conversation's placement (the workspace the channel is born into) and
    // its agent roster (the members it starts with). Before P4-4 both came from
    // `principal.conversationId`, which under an agent-scoped session is a
    // transport anchor and not a place the actor chose — and once
    // `--route-conversation-id` is retired (#task:2030) it would have had no
    // source for either.
    //
    // READ intent: nothing is posted into the source, so the one allocating arm
    // (`dm:@handle`) must not open a pair — a pair has no workspace and would be
    // refused as `workspace_scope_required` immediately after, leaving a
    // conversation behind a refusal. Same reason `member add` reads.
    const resolved = resolveConversationTargetForRoute(c, deps, {
      address: parsed.data.target,
      operation: 'channel_fork_source',
      intent: 'read',
      now: Date.now(),
    });
    if (!resolved.ok) return resolved.response;
    const source = conversations.get(resolved.target.stream.conversationId);
    if (!source) return c.json({ error: 'conversation not found' }, 404);
    // No second participation gate on the source, and deliberately. Resolution's
    // participation predicate IS the floor here: its workspace arm is the
    // `conversation_agents` roster edge, so a channel this agent merely DISCOVERED
    // (a public one it never joined) never reaches this line — it collapses into
    // the same 404 as an id nobody holds. The only non-roster arms it admits are
    // the agent's own inbox and a direct pair, and both are refused two lines
    // below for having no workspace to be born into.
    //
    // What must NOT be asked is `canPostToConversation`: its agent arm goes
    // through `canViewConversation`, which additionally requires
    // `principal.conversationId === conversationId` — a fact about the
    // CREDENTIAL's frame, not about authority (see `canAddConversationMember`,
    // which converged on the roster edge for the same reason). Asking it would
    // refuse every address except the anchor's own conversation, i.e. re-impose
    // the ambient default through the back door and make the AgentSlot
    // counter-example impossible.
    //
    // A channel is BORN INTO a workspace, and this route's only source for that
    // workspace is the ADDRESSED conversation's own placement — so a pair or an
    // `agent_inbox` names no destination for the act (v71, #task:2014). This is
    // the bounded-context declaration, made explicitly and answered as
    // `workspace_scope_required`, rather than a workspace lookup that used to
    // fail as "workspace not found" on a coordinate the row never had.
    const scope = resolveAgentQueryWorkspaceId(c, source, null, null);
    if (!scope.ok) return scope.response;
    {
      const denied = requireAgentCapability(c, ctx, principal, 'create_channels',
        scope.workspaceId);
      if (denied) return denied;
    }
    const memberAgentIds = conversations
      .listAgents(source.id)
      .map(member => member.agent_id);

    try {
      const result = await ctx.channelService.createChannel({
        workspaceId: scope.workspaceId,
        title: parsed.data.title,
        memberAgentIds,
        // The actor carries the RESOLVED source, not the principal: the service's
        // fork-source reads (roster, human members, seed provenance, the
        // same-workspace invariant) must all land on the conversation the actor
        // named. `ChannelForkActor` exists so the credential's frame is not even
        // in scope there.
        actor: {
          kind: 'agent',
          agentId: principal.agentId,
          forkSourceConversationId: source.id,
        },
        seed: {
          systemMessageBody:
            `Channel created from '${source.title}'. Reason: ${parsed.data.context_summary}`,
          initialPrompt: parsed.data.initial_prompt,
          autoStartMembers: 'all',
        },
      });
      return c.json({ channel_id: result.channel.id });
    } catch (err) {
      const mapped = channelServiceErrorResponse(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  app.post(internalAgentRoutePaths.followThread, async c => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = AgentFollowThreadInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const principal = getAgentPrincipal(c);
    // Following is a read-side subscription within the agent's own
    // conversation — gate on view + read_messages, not post (§4.1: follow
    // is not a membership/permission backdoor).
    if (!canViewConversation(ctx, principal, principal.conversationId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    {
      const denied = requireAgentConversationCapability(c, ctx, principal,
        'read_messages', conversations.getIdentity(principal.conversationId));
      if (denied) return denied;
    }
    try {
      const result = ctx.conversationMessageService.followThread({
        conversationId: principal.conversationId,
        rootMessageId: parsed.data.root_message_id,
        agentId: principal.agentId,
      });
      return c.json({ thread_root_id: result.threadRootId, changed: result.changed });
    } catch (err) {
      const mapped = conversationMessageServiceErrorResponse(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  app.post(internalAgentRoutePaths.unfollowThread, async c => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = AgentFollowThreadInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const principal = getAgentPrincipal(c);
    if (!canViewConversation(ctx, principal, principal.conversationId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    {
      const denied = requireAgentConversationCapability(c, ctx, principal,
        'read_messages', conversations.getIdentity(principal.conversationId));
      if (denied) return denied;
    }
    try {
      const result = ctx.conversationMessageService.unfollowThread({
        conversationId: principal.conversationId,
        rootMessageId: parsed.data.root_message_id,
        agentId: principal.agentId,
      });
      return c.json({ thread_root_id: result.threadRootId, changed: result.changed });
    } catch (err) {
      const mapped = conversationMessageServiceErrorResponse(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  app.get(internalAgentRoutePaths.listWorkspaces, async c => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    const principal = getAgentPrincipal(c);
    if (!canViewConversation(ctx, principal, principal.conversationId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const startedAt = performance.now();
    const outcome = await buildAgentListWorkspacesDto(deps, principal.agentId);
    const elapsedMs = elapsedSince(startedAt);
    if (elapsedMs >= SLOW_ROUTE_SPAN_MS) {
      ctx.logger.warn(
        {
          span: 'agent.list_workspaces',
          elapsedMs,
          thresholdMs: SLOW_ROUTE_SPAN_MS,
          sourceConversationId: principal.conversationId,
          agentId: principal.agentId,
        },
        'api: slow route span',
      );
    }
    if (outcome.kind === 'failed') {
      return c.json(
        { error: outcome.message, code: outcome.code },
        outcome.status,
      );
    }
    return c.json(outcome.dto);
  });

  app.get(internalAgentRoutePaths.listChannels, c => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    const parsedQuery = AgentListChannelsQuerySchema.safeParse({
      workspace_id: c.req.query('workspace_id') || undefined,
    });
    if (!parsedQuery.success) {
      return c.json({ error: 'invalid query', issues: parsedQuery.error.issues }, 400);
    }
    const principal = getAgentPrincipal(c);
    if (!canViewConversation(ctx, principal, principal.conversationId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const sourceConversation = conversations.get(principal.conversationId);
    if (!sourceConversation) return c.json({ error: 'conversation not found' }, 404);
    // Default to source workspace; cross-workspace access is gated by
    // `canAgentAccessWorkspace` (workspace_members ∪ owned agent_home). From a
    // placement with no workspace the default is undefined, so `workspace_id`
    // becomes REQUIRED instead of resolving to a silently empty list (v71).
    const scope = resolveAgentQueryWorkspaceId(
      c,
      sourceConversation,
      parsedQuery.data.workspace_id,
    );
    if (!scope.ok) return scope.response;
    const targetWorkspaceId = scope.workspaceId;
    if (targetWorkspaceId !== sourceConversation.workspace_id) {
      if (!canAgentAccessWorkspace(ctx, principal.agentId, targetWorkspaceId)) {
        return c.json({ error: 'forbidden' }, 403);
      }
    }
    {
      const denied = requireAgentCapability(c, ctx, principal, 'read_messages', targetWorkspaceId);
      if (denied) return denied;
    }
    const result = timedRouteSpan(
      ctx,
      'agent.list_channels',
      {
        sourceConversationId: principal.conversationId,
        sourceWorkspaceId: sourceConversation.workspace_id,
        targetWorkspaceId,
        agentId: principal.agentId,
      },
      () =>
        agentReads.listVisibleChannels(targetWorkspaceId, principal.agentId),
      out => ({ channelCount: out.channels.length }),
    );
    return c.json(result);
  });
}
