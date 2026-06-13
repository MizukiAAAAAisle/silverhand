// Internal-agent CLI command surface. This router owns its auth/principal
// middleware and command routes as one standalone factory; it never imports the
// public API composition root.
import {
  getAgentPrincipal,
  installInternalPrincipalMiddleware,
  type AppEnv,
} from '../auth/principal.js';
import type {
  BackendContext,
} from '../context.js';
import {
  createCliInvokeMiddleware,
} from '../observability/cli-invoke-middleware.js';
import {
  SLOW_ROUTE_SPAN_MS,
  elapsedSince,
  timedRouteSpan,
} from '../observability/route-span.js';
import {
  canAgentAccessWorkspace,
  canEditAgent,
  canPostToConversation,
  canViewConversation,
} from '../permissions.js';
import {
  buildAgentSearchMessagesDto,
  buildReadHistoryDto,
  listAgentVisibleChannels,
  resolveAgentReadHistoryTarget,
} from '../read-model/agent-read.js';
import {
  AgentRepo,
} from '../repos/agent-repo.js';
import {
  ConversationRepo,
} from '../repos/conversation-repo.js';
import {
  MessageRepo,
} from '../repos/message-repo.js';
import {
  MessageReactionRepo,
} from '../repos/message-reaction-repo.js';
import {
  addReaction,
  removeReaction,
} from '../application/react-message.js';
import {
  UserRepo,
} from '../repos/user-repo.js';
import {
  WorkspaceRepo,
} from '../repos/workspace-repo.js';
import {
  uploadAttachment,
} from './attachment-upload.js';
import {
  requireAgentCapability,
} from './capability.js';
import {
  createInternalMembershipApp,
} from './membership.js';
import {
  agentServiceErrorBody,
  agentServiceErrorStatus,
  channelServiceErrorResponse,
  conversationMessageServiceErrorResponse,
  reactionResultResponse,
  scheduleServiceErrorResponse,
} from './responses.js';
import {
  dispatchAgentWorkspaceIndex,
  resolveOutboundForHost,
  type DataPlaneFailure,
  type DataPlaneHttpStatus,
} from '../runtime/workspace-data-plane.js';
import {
  MembershipService,
} from '../services/membership-service.js';
import {
  AgentCreateChannelInputSchema,
  AgentFollowThreadInputSchema,
  AgentListChannelsQuerySchema,
  AgentReadHistoryInputSchema,
  AgentReactMessageInputSchema,
  AgentResolveStaleMessageInputSchema,
  AgentSearchMessagesInputSchema,
  AgentSendMessageInputSchema,
  ClaimTasksInputSchema,
  CliTraceInputSchema,
  CreateTasksInputSchema,
  ListTasksQuerySchema,
  ScheduleCancelInputSchema,
  ScheduleCreateInputSchema,
  ScheduleListInputSchema,
  UnclaimTaskInputSchema,
  UpdateTaskStatusInputSchema,
  internalPaths,
  type AgentListWorkspacesDto,
  type AgentListedWorkspace,
} from '@silverhand/shared';
import {
  Hono,
} from 'hono';
import type { Context } from 'hono';
import {
  join,
} from 'node:path';
import {
  performance,
} from 'node:perf_hooks';

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
 * Single-host invariant: all of an agent's workspaces are
 * owned by one host, so resolution targets a SINGLE owning daemon. A
 * multi-host membership set is rejected with an explicit error rather than
 * silently fanned out across daemons (which would break M1 sticky
 * ownership).
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

  // Host invariant: every workspace an agent belongs to is
  // owned by the agent's host — membership enforces `agent.host_id ==
  // workspace_host_id`. This route resolves `agent_dir` against ONE owning
  // daemon. A cross-host result would mean silently fanning out paths from
  // different hosts in a single response, which breaks M1 sticky ownership.
  // So a multi-host set is an EXPLICIT error, never a silent multi-host
  // fan-out (this is the defensive realization of "I4 host equality").
  const ownerHosts = new Set(workspaces.map(w => w.workspace_host_id));
  if (ownerHosts.size > 1) {
    return {
      kind: 'failed',
      code: 'workspace_host_ambiguous',
      message: `agent's workspaces span multiple hosts (${[...ownerHosts].join(', ')}); refusing cross-host agent_dir resolution`,
      status: 409,
    };
  }
  const hostId = workspaces[0]!.workspace_host_id;
  const workspaceIds = workspaces.map(w => w.id);
  // Backfill ONLY the rows this response needs resolved — the
  // VISIBLE regular workspaces (agent_home is daemon-resolved from the homedir
  // convention, never via the registry). An unrelated same-host regular row
  // the agent can't see must never fail-close this agent's list, so we pass
  // the scoped rows rather than enumerating every regular row on the host.
  const regularRows = workspaces
    .filter(w => w.workspace_kind === 'regular')
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
    if (index.result.unresolved.length > 0) {
      // Strict fail-closed: a regular workspace with no
      // registry binding has NO agent_dir. Never derive one from
      // workspace_path — surface a typed error instead.
      return {
        kind: 'failed',
        code: 'workspace_unresolved',
        message: `daemon could not resolve agent_dir for workspace(s): ${index.result.unresolved.join(', ')}`,
        status: 409,
      };
    }
    for (const entry of index.result.entries) {
      agentDirById.set(entry.workspace_id, entry.agent_dir);
    }
  }

  const dto: AgentListWorkspacesDto = {
    workspaces: workspaces.map((w): AgentListedWorkspace => {
      const agentDir = agentDirById.get(w.id);
      if (!agentDir) {
        // Unreachable: every id was resolved or tripped fail-closed above.
        // Guard so a logic gap can never leak an empty/derived path.
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

export function createInternalRouter(ctx: BackendContext): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const agents = new AgentRepo(ctx.db);
  const conversations = new ConversationRepo(ctx.db);
  const messages = new MessageRepo(ctx.db);
  const reactions = new MessageReactionRepo(ctx.db);
  const workspaces = new WorkspaceRepo(ctx.db, { workspacesRoot: ctx.workspacesRoot });
  const users = new UserRepo(ctx.db);
  const membership = new MembershipService({ agents, users, conversations });
  const taskDeps = { ctx, agents, conversations, messages };

  app.use('/internal/conversations/:cid/agents/:aid/*', async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const token = header.replace(/^Bearer\s+/i, '').trim();
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    const verified = ctx.agentTokens.verify(token, cid, aid);
    if (!verified.ok) {
      ctx.logger.warn(
        {
          path: c.req.path,
          hasHeader: !!header,
          tokenLen: token.length,
          reason: verified.reason,
          conversationId: cid,
          agentId: aid,
          caller: c.req.header('x-agent-hub-caller') ?? 'unknown',
        },
        'internal: unauthorized request',
      );
      return c.json({ error: 'unauthorized' }, 401);
    }
    await next();
  });
  installInternalPrincipalMiddleware(app, { agents, conversations });

  // CLI invocation logging — must run after auth so we only emit lines
  // for verified principals, but before route handlers so handler
  // throws/short-circuits still produce one line per call.
  app.use(
    '/internal/conversations/:cid/agents/:aid/*',
    createCliInvokeMiddleware(ctx),
  );

  // Observability-only: CLI fire-and-forget pre-flight failure trace.
  // Excluded from the cli.invoke middleware (the middleware checks the
  // suffix and skips it); logged here as `cli.preflight_failure`.
  app.post(internalPaths.agentCliTrace(':cid', ':aid'), async c => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = CliTraceInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const principal = getAgentPrincipal(c);
    ctx.loggers.cli.warn(
      {
        category: 'cli.preflight_failure',
        conversationId: principal.conversationId,
        agentId: principal.agentId,
        noun: parsed.data.noun ?? null,
        verb: parsed.data.verb ?? null,
        flags_seen: parsed.data.flags_seen ?? [],
        error_code: parsed.data.error_code ?? null,
        error_subkind: parsed.data.error_subkind ?? null,
        error_message: parsed.data.error_message ?? null,
        duration_ms: parsed.data.duration_ms ?? null,
        status: 'failure',
      },
      'cli.preflight_failure',
    );
    return c.json({ ok: true });
  });

  // ── canonical conversation-scoped MCP routes ───────────────────
  // Internal membership routes are wrapped by the param-scoped agent-token auth
  // + getAgentPrincipal middleware installed above.
  app.route(
    '/',
    createInternalMembershipApp({
      ctx,
      agents,
      users,
      workspaces,
      conversations,
      messages,
      membership,
      requireAgentCapability,
    }),
  );

  app.post(internalPaths.agentSendConversationMessage(':cid', ':aid'), async c => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = AgentSendMessageInputSchema.safeParse(body);
    if (!parsed.success) {
      ctx.logger.warn(
        { conversationId: cid, agentId: aid, issues: parsed.error.issues },
        'internal: agent send-message rejected (invalid input)',
      );
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    if (parsed.data.target !== undefined && parsed.data.reply_to_message_id !== undefined) {
      return c.json(
        {
          error: 'target and reply_to_message_id are mutually exclusive',
          code: 'target_conflict',
        },
        400,
      );
    }
    const principal = getAgentPrincipal(c);
    if (!canPostToConversation(ctx, principal, principal.conversationId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    {
      const denied = requireAgentCapability(c, ctx, principal, 'send_messages',
        conversations.get(principal.conversationId)?.workspace_id);
      if (denied) return denied;
    }
    try {
      const result = await ctx.conversationMessageService.sendMessage({
        conversationId: principal.conversationId,
        actor: principal,
        content: parsed.data.content,
        attachmentIds: parsed.data.attachment_ids ?? [],
        target: parsed.data.target,
        legacyReplyToMessageId: parsed.data.reply_to_message_id,
        assertedStreamKey: parsed.data.stream_key,
        seenUpToSeq: parsed.data.seen_up_to_seq,
        staleEventId: parsed.data.stale_event_id,
        staleResolutionReason: parsed.data.stale_resolution_reason,
        freshnessBypass: parsed.data.freshness_bypass ?? false,
      });
      return c.json({
        message_id: result.message.id,
        message_seq: result.message.seq,
        thread_root_id: result.message.thread_root_id,
      });
    } catch (err) {
      const mapped = conversationMessageServiceErrorResponse(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  // Agent reacts to a message (docs/reactions-design.md §5.1 / §12.D). A
  // reaction is a WRITE, so it carries the same `send_messages` capability
  // gate as posting a message — not a read capability. POST adds, DELETE
  // removes; both take `{message_id, emoji}`. The use case enforces that the
  // target message is in the agent's own conversation (via canViewConversation
  // on the agent principal), rejects system messages, and excludes the write
  // from the message CAS (§12.A).
  const handleAgentReact = async (
    c: Context,
    op: 'add' | 'remove',
  ): Promise<Response> => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = AgentReactMessageInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const principal = getAgentPrincipal(c);
    if (!canPostToConversation(ctx, principal, principal.conversationId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    {
      const denied = requireAgentCapability(c, ctx, principal, 'send_messages',
        conversations.get(principal.conversationId)?.workspace_id);
      if (denied) return denied;
    }
    const input = {
      principal,
      messageId: parsed.data.message_id,
      emoji: parsed.data.emoji,
    };
    const result =
      op === 'add'
        ? await addReaction({ ctx, conversations, messages, reactions }, input)
        : await removeReaction({ ctx, conversations, messages, reactions }, input);
    return reactionResultResponse(c, result);
  };

  app.post(internalPaths.agentReactMessage(':cid', ':aid'), c =>
    handleAgentReact(c, 'add'),
  );
  app.delete(internalPaths.agentReactMessage(':cid', ':aid'), c =>
    handleAgentReact(c, 'remove'),
  );

  app.post(internalPaths.agentResolveStaleMessage(':cid', ':aid'), async c => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = AgentResolveStaleMessageInputSchema.safeParse(body);
    if (!parsed.success) {
      ctx.logger.warn(
        { conversationId: cid, agentId: aid, issues: parsed.error.issues },
        'internal: agent stale-resolution rejected (invalid input)',
      );
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const principal = getAgentPrincipal(c);
    if (!canPostToConversation(ctx, principal, principal.conversationId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    {
      const denied = requireAgentCapability(c, ctx, principal, 'send_messages',
        conversations.get(principal.conversationId)?.workspace_id);
      if (denied) return denied;
    }
    ctx.conversationMessageService.resolveStaleMessage({
      conversationId: principal.conversationId,
      actor: principal,
      staleEventId: parsed.data.stale_event_id,
      resolutionReason: parsed.data.resolution_reason,
    });
    return c.json({ ok: true });
  });

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

  app.post(internalPaths.agentReadHistory(':cid', ':aid'), async c => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = AgentReadHistoryInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const principal = getAgentPrincipal(c);
    if (!canViewConversation(ctx, principal, principal.conversationId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const sourceConversation = conversations.get(principal.conversationId);
    if (!sourceConversation) return c.json({ error: 'conversation not found' }, 404);
    const target = resolveAgentReadHistoryTarget(
      ctx,
      conversations,
      sourceConversation,
      principal.agentId,
      parsed.data.target,
    );
    if (!target.ok) {
      return c.json({ error: target.message, code: target.code }, target.status);
    }
    {
      const denied = requireAgentCapability(c, ctx, principal, 'read_messages',
        target.conversation.workspace_id);
      if (denied) return denied;
    }
    const result = timedRouteSpan(
      ctx,
      'agent.read_history',
      {
        sourceConversationId: principal.conversationId,
        targetConversationId: target.conversation.id,
        agentId: principal.agentId,
        limit: parsed.data.limit,
      },
      () => buildReadHistoryDto(ctx, target.conversation, parsed.data, target.threadRootId),
      out => ({
        messageCount: 'messages' in out ? out.messages.length : 0,
      }),
    );
    if ('error' in result) {
      return c.json({ error: result.error, code: result.code }, result.status);
    }
    return c.json(result);
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

  app.post(internalPaths.agentSearchMessages(':cid', ':aid'), async c => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = AgentSearchMessagesInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const principal = getAgentPrincipal(c);
    if (!canViewConversation(ctx, principal, principal.conversationId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const sourceConversation = conversations.get(principal.conversationId);
    if (!sourceConversation) return c.json({ error: 'conversation not found' }, 404);
    // Cross-workspace search is gated up-front by
    // `canAgentAccessWorkspace`. The dto builder still runs the
    // conversation_agents JOIN as the bottom guard, so unjoined
    // channels in the target workspace stay invisible.
    if (
      parsed.data.workspace_id &&
      parsed.data.workspace_id !== sourceConversation.workspace_id
    ) {
      if (
        !canAgentAccessWorkspace(
          ctx,
          principal.agentId,
          parsed.data.workspace_id,
        )
      ) {
        return c.json({ error: 'forbidden' }, 403);
      }
    }
    {
      // Resolve the workspace the search actually lands in:
      // scope='channel' → the channel's (global) workspace; else the
      // explicit workspace_id arg; else the source conversation's. The dto
      // builder still bottom-guards per-channel membership via JOIN.
      const searchWorkspaceId = parsed.data.channel_id
        ? conversations.get(parsed.data.channel_id)?.workspace_id ?? sourceConversation.workspace_id
        : parsed.data.workspace_id ?? sourceConversation.workspace_id;
      const denied = requireAgentCapability(c, ctx, principal, 'read_messages', searchWorkspaceId);
      if (denied) return denied;
    }
    const result = timedRouteSpan(
      ctx,
      'agent.search_messages',
      {
        sourceConversationId: principal.conversationId,
        agentId: principal.agentId,
        scope: parsed.data.scope,
        workspaceId: parsed.data.workspace_id ?? null,
        channelId: parsed.data.channel_id ?? null,
        limit: parsed.data.limit,
      },
      () =>
        buildAgentSearchMessagesDto(
          ctx,
          conversations,
          sourceConversation,
          principal.agentId,
          parsed.data,
        ),
      out => ({
        hitCount: out.ok ? out.dto.hits.length : 0,
      }),
    );
    if (!result.ok) {
      return c.json({ error: result.message, code: result.code }, result.status);
    }
    return c.json(result.dto);
  });

  app.get(internalPaths.agentListConversationTasks(':cid', ':aid'), c => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    const conversation = conversations.get(cid);
    if (!conversation) return c.json({ error: 'conversation not found' }, 404);
    if (!agents.get(aid)) return c.json({ error: 'agent not found' }, 404);
    // status / task_number are repeatable; `?status=in_progress&status=in_review`
    // and `?task_number=190&task_number=191` are the canonical multi-value form.
    // 'all' is a legacy alias for no-filter — drop it before validation.
    const statusValues = (c.req.queries('status') ?? []).filter(s => s !== 'all');
    const taskNumberValues = c.req.queries('task_number') ?? [];
    const parsed = ListTasksQuerySchema.safeParse({
      workspace_id: c.req.query('workspace_id') || undefined,
      conversation_id: c.req.query('conversation_id') || undefined,
      status: statusValues.length > 0 ? statusValues : undefined,
      task_number: taskNumberValues.length > 0 ? taskNumberValues : undefined,
      assignee_id: c.req.query('assignee_id') || undefined,
      limit: c.req.query('limit') || undefined,
    });
    if (!parsed.success) {
      return c.json({ error: 'invalid query', issues: parsed.error.issues }, 400);
    }
    const principal = getAgentPrincipal(c);
    if (!canViewConversation(ctx, principal, principal.conversationId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    // Agent-side --workspace-id: default is the actor's current conversation's
    // workspace; if the agent passes a different
    // workspace_id we must validate existence + membership at the route
    // layer so the service doesn't silently widen reads across
    // workspaces. We don't accept --workspace <name> for list — only
    // claim/unclaim/status need the disambiguation.
    let effectiveWorkspaceId = parsed.data.workspace_id;
    if (effectiveWorkspaceId && effectiveWorkspaceId !== conversation.workspace_id) {
      const targetWs = workspaces.get(effectiveWorkspaceId);
      if (!targetWs) {
        return c.json(
          { error: `workspace ${effectiveWorkspaceId} not found`, code: 'unknown_workspace' },
          404,
        );
      }
      const isMember =
        targetWs.workspace_kind === 'agent_home'
          ? targetWs.owner_agent_id === aid
          : workspaces.isMember(targetWs.id, aid);
      if (!isMember) {
        return c.json(
          {
            error: `agent is not a member of workspace ${targetWs.id}`,
            code: 'workspace_membership_required',
          },
          403,
        );
      }
    } else if (!effectiveWorkspaceId) {
      effectiveWorkspaceId = conversation.workspace_id;
    }
    {
      const denied = requireAgentCapability(c, ctx, principal, 'read_tasks', effectiveWorkspaceId);
      if (denied) return denied;
    }
    return c.json({
      tasks: ctx.taskService.list({
        actor: principal,
        workspaceId: effectiveWorkspaceId,
        conversationId: parsed.data.conversation_id,
        status: parsed.data.status,
        taskNumbers: parsed.data.task_number,
        assigneeAgentId: parsed.data.assignee_id,
        limit: parsed.data.limit,
      }),
    });
  });

  app.post(internalPaths.agentCreateConversationTasks(':cid', ':aid'), async c => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = CreateTasksInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    if (parsed.data.target !== undefined && parsed.data.reply_to_message_id !== undefined) {
      return c.json(
        {
          error: 'target and reply_to_message_id are mutually exclusive',
          code: 'target_conflict',
        },
        400,
      );
    }
    const principal = getAgentPrincipal(c);
    if (!canPostToConversation(ctx, principal, principal.conversationId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    {
      const denied = requireAgentCapability(c, ctx, principal, 'create_tasks',
        conversations.get(principal.conversationId)?.workspace_id);
      if (denied) return denied;
    }
    const result = await ctx.taskService.createTasks({
      conversationId: principal.conversationId,
      actor: principal,
      tasks: parsed.data.tasks,
      target: parsed.data.target,
      legacyReplyToMessageId: parsed.data.reply_to_message_id,
    });
    if ('error' in result) {
      return c.json(
        { error: result.error },
        result.error === 'reply_target_not_found' ? 404 : 400,
      );
    }
    return c.json(result);
  });

  app.post(internalPaths.agentClaimConversationTasks(':cid', ':aid'), async c => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = ClaimTasksInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const actor = getAgentPrincipal(c);
    if (!canPostToConversation(ctx, actor, actor.conversationId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    // Wire optional --workspace-id / --workspace selector.
    // Schema XOR enforces exclusivity; the service does membership +
    // existence checks per result entry.
    const workspaceSelector = {
      ...(parsed.data.workspace_id ? { workspaceId: parsed.data.workspace_id } : {}),
      ...(parsed.data.workspace_name ? { workspaceName: parsed.data.workspace_name } : {}),
    };
    const results = [];
    for (const taskNumber of parsed.data.task_numbers ?? []) {
      results.push(
        await ctx.taskService.claimTask({ actor, by: { taskNumber }, workspaceSelector }),
      );
    }
    for (const messageId of parsed.data.message_ids ?? []) {
      results.push(
        await ctx.taskService.claimTask({ actor, by: { messageId }, workspaceSelector }),
      );
    }
    return c.json({ results });
  });

  app.post(internalPaths.agentUnclaimConversationTask(':cid', ':aid'), async c => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = UnclaimTaskInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const principal = getAgentPrincipal(c);
    if (!canPostToConversation(ctx, principal, principal.conversationId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const workspaceSelector = {
      ...(parsed.data.workspace_id ? { workspaceId: parsed.data.workspace_id } : {}),
      ...(parsed.data.workspace_name ? { workspaceName: parsed.data.workspace_name } : {}),
    };
    const result = await ctx.taskService.unclaimTask({
      actor: principal,
      by: { taskNumber: parsed.data.task_number },
      workspaceSelector,
    });
    return c.json(result);
  });

  app.post(internalPaths.agentUpdateConversationTaskStatus(':cid', ':aid'), async c => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = UpdateTaskStatusInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const principal = getAgentPrincipal(c);
    if (!canPostToConversation(ctx, principal, principal.conversationId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const workspaceSelector = {
      ...(parsed.data.workspace_id ? { workspaceId: parsed.data.workspace_id } : {}),
      ...(parsed.data.workspace_name ? { workspaceName: parsed.data.workspace_name } : {}),
    };
    const result = await ctx.taskService.updateStatus({
      actor: principal,
      by: { taskNumber: parsed.data.task_number },
      status: parsed.data.status,
      workspaceSelector,
    });
    return c.json(result);
  });

  // ── Agent-initiated attachments (silverhand CLI → backend) ────────
  // Agents never specify channel_id; the backend derives it from the
  // calling conversation (cid) so the access boundary is fixed by the
  // agent's runtime context. locateForAgent additionally enforces that
  // the requested attachment belongs to the same channel.

  app.post(internalPaths.agentUploadAttachment(':cid', ':aid'), async c => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    const conversation = conversations.get(cid);
    if (!conversation) return c.json({ error: 'conversation not found' }, 404);
    if (!agents.get(aid)) return c.json({ error: 'agent not found' }, 404);
    if (!conversations.getAgent(cid, aid)) {
      return c.json({ error: 'agent is not a member of this conversation' }, 403);
    }
    const principal = getAgentPrincipal(c);
    if (!canPostToConversation(ctx, principal, principal.conversationId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    {
      const denied = requireAgentCapability(c, ctx, principal, 'upload_attachments',
        conversation.workspace_id);
      if (denied) return denied;
    }
    return uploadAttachment(
      ctx,
      c,
      principal.conversationId,
      'agent',
      principal.agentId,
    );
  });

  app.get(
    internalPaths.agentLocateAttachment(':cid', ':aid', ':attachmentId'),
    async c => {
      const cid = c.req.param('cid');
      const aid = c.req.param('aid');
      const attachmentId = c.req.param('attachmentId');
      if (!cid || !aid || !attachmentId) {
        return c.json(
          { error: 'conversation id, agent id, and attachment id required' },
          400,
        );
      }
      if (!conversations.get(cid)) return c.json({ error: 'conversation not found' }, 404);
      if (!agents.get(aid)) return c.json({ error: 'agent not found' }, 404);
      if (!conversations.getAgent(cid, aid)) {
        return c.json({ error: 'agent is not a member of this conversation' }, 403);
      }
      const principal = getAgentPrincipal(c);
      if (!canViewConversation(ctx, principal, principal.conversationId)) {
        return c.json({ error: 'forbidden' }, 403);
      }
      {
        const denied = requireAgentCapability(c, ctx, principal, 'read_attachments',
          conversations.get(principal.conversationId)?.workspace_id);
        if (denied) return denied;
      }
      const located = await ctx.attachmentService.locateForAgent(
        attachmentId,
        principal.conversationId,
      );
      if (!located) {
        // Either does not exist or belongs to a different channel — same
        // shape on purpose so we don't leak existence across channels.
        return c.json({ error: 'attachment not found' }, 404);
      }
      return c.json(located.locate);
    },
  );

  app.get(
    internalPaths.agentDownloadAttachment(':cid', ':aid', ':attachmentId'),
    async c => {
      const cid = c.req.param('cid');
      const aid = c.req.param('aid');
      const attachmentId = c.req.param('attachmentId');
      if (!cid || !aid || !attachmentId) {
        return c.json(
          { error: 'conversation id, agent id, and attachment id required' },
          400,
        );
      }
      if (!conversations.get(cid)) return c.json({ error: 'conversation not found' }, 404);
      if (!agents.get(aid)) return c.json({ error: 'agent not found' }, 404);
      if (!conversations.getAgent(cid, aid)) {
        return c.json({ error: 'agent is not a member of this conversation' }, 403);
      }
      const principal = getAgentPrincipal(c);
      if (!canViewConversation(ctx, principal, principal.conversationId)) {
        return c.json({ error: 'forbidden' }, 403);
      }
      {
        const denied = requireAgentCapability(c, ctx, principal, 'read_attachments',
          conversations.get(principal.conversationId)?.workspace_id);
        if (denied) return denied;
      }
      const located = await ctx.attachmentService.locateForAgent(
        attachmentId,
        principal.conversationId,
      );
      if (!located) {
        // Same not-found shape as locate: missing rows and cross-channel
        // attempts are indistinguishable.
        return c.json({ error: 'attachment not found' }, 404);
      }
      const response = await ctx.attachmentService.serveForAgentLocated(located.row);
      if (!response) return c.json({ error: 'attachment not found' }, 404);
      return response;
    },
  );

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

  app.post(internalPaths.agentUploadAvatar(':cid', ':aid'), async c => {
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

  app.delete(internalPaths.agentDeleteAvatar(':cid', ':aid'), async c => {
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

  // ── Agent-owned schedules (silverhand CLI → backend) ──────────────
  // Per-agent surface. The route hangs off the calling conversation so
  // the existing internal principal middleware (cid+aid → AgentPrincipal)
  // authenticates the request without a second auth path; the calling
  // `cid` is also passed into the service as the default
  // `target_conversation_id` so creating a schedule in DM defaults to
  // firing in DM, in a channel defaults to firing in that channel, etc.
  // (the agent can always override with `target_conversation_id` in the
  // body to fire elsewhere it's a member of).
  // Errors map ScheduleError.code → structured `{ error, code }` JSON
  // via scheduleServiceErrorResponse so the agent sees stable codes.

  app.post(internalPaths.agentScheduleCreate(':cid', ':aid'), async c => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = ScheduleCreateInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: 'invalid input', code: 'invalid_input', issues: parsed.error.issues },
        400,
      );
    }
    const principal = getAgentPrincipal(c);
    try {
      const schedule = ctx.scheduleService.create(
        parsed.data,
        principal.agentId,
        cid,
      );
      return c.json({ schedule });
    } catch (err) {
      const mapped = scheduleServiceErrorResponse(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  app.post(internalPaths.agentScheduleList(':cid', ':aid'), async c => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = ScheduleListInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: 'invalid input', code: 'invalid_input', issues: parsed.error.issues },
        400,
      );
    }
    const principal = getAgentPrincipal(c);
    const schedules = ctx.scheduleService.list(
      principal.agentId,
      parsed.data.status,
      parsed.data.limit,
    );
    return c.json({ schedules });
  });

  app.post(internalPaths.agentScheduleCancel(':cid', ':aid'), async c => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = ScheduleCancelInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: 'invalid input', code: 'invalid_input', issues: parsed.error.issues },
        400,
      );
    }
    const principal = getAgentPrincipal(c);
    try {
      const schedule = ctx.scheduleService.cancel(
        parsed.data.schedule_id,
        principal.agentId,
      );
      return c.json({ schedule });
    } catch (err) {
      const mapped = scheduleServiceErrorResponse(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  return app;
}
