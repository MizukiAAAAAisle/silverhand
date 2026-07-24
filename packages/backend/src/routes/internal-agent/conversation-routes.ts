// Agent conversation-topology facet: create-channel, follow/unfollow-thread,
// list-workspaces, list-channels. Read-side discovery plus the create-channel
// write, all scoped to the calling agent's visibility / membership.
import type { Hono } from 'hono';
import { performance } from 'node:perf_hooks';
import {
  getAgentPrincipal,
  type AppEnv,
} from '../../auth/principal.js';
import type { BackendContext } from '../../context.js';
import {
  canAgentAccessWorkspace,
  canPostToConversation,
  canViewConversation,
} from '../../permissions.js';
import { listAgentVisibleChannels } from '../../read-model/agent-read.js';
import {
  SLOW_ROUTE_SPAN_MS,
  elapsedSince,
  timedRouteSpan,
} from '../../observability/route-span.js';
import { AgentRepo } from '../../repos/agent-repo.js';
import { WorkspaceRepo } from '../../repos/workspace-repo.js';
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
  internalPaths,
  type AgentListWorkspacesDto,
  type AgentListedWorkspace,
} from '@silverhand/shared';
import type { InternalRouteDeps } from './deps.js';

/**
 * Build the cross-workspace `list_workspaces` payload for the calling
 * agent. The workspace list is the canonical
 * `WorkspaceRepo.listForAgent` (regular ∪ owned agent_home); per-row
 * `agent_dir` is daemon-stamped: the route does
 * the ACL/DB list, then dispatches the narrow `agent_workspace_index`
 * intent to the owning daemon, which resolves `agent_dir` from the
 * registry (regular) or its own homedir (agent_home).
 *
 * The backend NEVER derives `agent_dir` from `workspace_path` (I1). Before
 * dispatching, it `ensure()`s the registry backfill so a legacy
 * row is bound; an id the daemon cannot resolve (`unresolved`), an offline
 * host, or a failed backfill all FAIL CLOSED — the response carries a
 * diagnostic code, never a fabricated `workspace_path`-derived path.
 *
 * Cross-computer slice 2 (#task:1600): the resolution axis is the AGENT's
 * host — the index renders paths as seen from the agent's own computer, so
 * there is exactly ONE daemon to ask regardless of where the workspaces'
 * home computers are. The old multi-host `workspace_host_ambiguous`
 * rejection is gone with the I4 same-host invariant it defended.
 */
type AgentListWorkspacesOutcome =
  | { kind: 'ok'; dto: AgentListWorkspacesDto }
  | { kind: 'failed'; code: string; message: string; status: DataPlaneHttpStatus };

async function buildAgentListWorkspacesDto(
  ctx: BackendContext,
  agentId: string,
): Promise<AgentListWorkspacesOutcome> {
  const workspaces = new WorkspaceRepo(ctx.db, {
    workspacesRoot: ctx.workspacesRoot,
  }).listForAgent(agentId);
  if (workspaces.length === 0) {
    return { kind: 'ok', dto: { workspaces: [] } };
  }

  const adapter = ctx.outboundFrameAdapter?.() ?? null;

  // Cross-computer slice 2 (#task:1600): resolve against the AGENT's own
  // daemon. Paths in this index are only meaningful on the computer the
  // agent runs on, so the agent's host is the single correct resolution
  // axis — never `workspace_host_id`, which names each workspace's home
  // computer and may legitimately differ per row once members span
  // computers.
  const agent = new AgentRepo(ctx.db).get(agentId);
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
  // Backfill ONLY the rows this response needs resolved — the VISIBLE
  // regular workspaces whose HOME computer is this host (agent_home is
  // daemon-resolved from the homedir convention, never via the registry;
  // a guest workspace's `workspace_path` belongs to its home computer and
  // must never be legacy-bound onto the agent's daemon — guest roots are
  // provisioned pathless at spawn time, #task:1596). An unrelated
  // same-host regular row the agent can't see must never fail-close this
  // agent's list, so we pass the scoped rows rather than enumerating
  // every regular row on the host.
  const regularRows = workspaces
    .filter(
      w => w.workspace_kind === 'regular' && w.workspace_host_id === hostId,
    )
    .map(w => ({ id: w.id, workspace_path: w.workspace_path }));

  const agentDirById = new Map<string, string>();
  {
    // Bind the visible legacy rows first (idempotent + retriable; never
    // memoizes a failure, so a prior offline does not permanently skip them).
    // No visible regular row → no registry backfill needed (agent_home only).
    const backfill =
      regularRows.length > 0
        ? await ctx.workspaceRegistryBackfiller?.ensure(hostId, regularRows)
        : undefined;
    if (backfill && backfill.status === 'failed') {
      // No row bound — daemon offline / registry unavailable. Fail closed.
      const f = backfill.failed[0];
      return {
        kind: 'failed',
        code: f?.code ?? 'host_attach_pending',
        message:
          'workspace registry backfill failed; cannot resolve agent_dir',
        status: f && !f.retriable ? 502 : 503,
      };
    }
    // A `partial` backfill leaves the still-unbound ids to surface as
    // `unresolved` below, which trips the strict fail-closed there.

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
    // #task:1600 piece ② — unresolved ids split by axis:
    //  - a row whose HOME computer is the agent's host was just
    //    backfilled above, so "unresolved" is a genuine registry
    //    inconsistency → strict fail-closed (unchanged contract);
    //  - a GUEST row (home computer elsewhere) with no local binding is
    //    the EXPECTED "unavailable on this computer" state → degrade
    //    per-entry to `agent_dir: null` (never a fabricated path, never
    //    a whole-response failure). It resolves once the workspace next
    //    runs on this computer (spawn-time pathless provision).
    const hostById = new Map(workspaces.map(w => [w.id, w.workspace_host_id]));
    const sameHostUnresolved = index.result.unresolved.filter(
      id => hostById.get(id) === hostId,
    );
    if (sameHostUnresolved.length > 0) {
      return {
        kind: 'failed',
        code: 'workspace_unresolved',
        message: `daemon could not resolve agent_dir for workspace(s): ${sameHostUnresolved.join(', ')}`,
        status: 409,
      };
    }
    for (const entry of index.result.entries) {
      agentDirById.set(entry.workspace_id, entry.agent_dir);
    }
  }

  const dto: AgentListWorkspacesDto = {
    workspaces: workspaces.map((w): AgentListedWorkspace => {
      const agentDir = agentDirById.get(w.id) ?? null;
      if (agentDir === null && w.workspace_host_id === hostId) {
        // Unreachable: every same-host id was resolved or tripped the
        // strict fail-closed above. Guard so a logic gap can never leak
        // an empty/derived path.
        throw new Error(`agent_dir unresolved for workspace ${w.id}`);
      }
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
  const { ctx, conversations } = deps;

  app.post(internalPaths.agentCreateChannel(':cid', ':aid'), async c => {
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
    const current = conversations.get(principal.conversationId);
    if (!current) return c.json({ error: 'conversation not found' }, 404);
    if (!canPostToConversation(ctx, principal, current.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    {
      const denied = requireAgentCapability(c, ctx, principal, 'create_channels',
        current.workspace_id);
      if (denied) return denied;
    }
    const memberAgentIds = conversations
      .listAgents(current.id)
      .map(member => member.agent_id);

    try {
      const result = await ctx.channelService.createChannel({
        workspaceId: current.workspace_id,
        title: parsed.data.title,
        memberAgentIds,
        actor: principal,
        seed: {
          systemMessageBody:
            `Channel created from '${current.title}'. Reason: ${parsed.data.context_summary}`,
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

  app.post(internalPaths.agentFollowThread(':cid', ':aid'), async c => {
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
      const denied = requireAgentCapability(c, ctx, principal, 'read_messages',
        conversations.get(principal.conversationId)?.workspace_id);
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

  app.post(internalPaths.agentUnfollowThread(':cid', ':aid'), async c => {
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
      const denied = requireAgentCapability(c, ctx, principal, 'read_messages',
        conversations.get(principal.conversationId)?.workspace_id);
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

  app.get(internalPaths.agentListWorkspaces(':cid', ':aid'), async c => {
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
    const outcome = await buildAgentListWorkspacesDto(ctx, principal.agentId);
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

  app.get(internalPaths.agentListChannels(':cid', ':aid'), c => {
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
    // `canAgentAccessWorkspace` (workspace_members ∪ owned agent_home).
    const targetWorkspaceId =
      parsedQuery.data.workspace_id ?? sourceConversation.workspace_id;
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
        listAgentVisibleChannels(ctx, targetWorkspaceId, principal.agentId),
      out => ({ channelCount: out.channels.length }),
    );
    return c.json(result);
  });
}
