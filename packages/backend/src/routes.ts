import { Hono, type Context } from 'hono';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  apiPaths,
  internalPaths,
  AddWorkspaceMemberInputSchema,
  AgentCloseThreadInputSchema,
  AgentCreateChannelInputSchema,
  AgentSendMessageInputSchema,
  AgentSpawnChildInputSchema,
  ClaimTasksInputSchema,
  CreateAgentInputSchema,
  CreateConversationChannelInputSchema,
  CreateWorkspaceInputSchema,
  CreateTasksInputSchema,
  DeleteAgentInputSchema,
  HumanClaimTaskInputSchema,
  HumanUpdateTaskStatusInputSchema,
  ListTasksQuerySchema,
  MarkConversationReadInputSchema,
  MarkNotificationsReadInputSchema,
  SearchQueryInputSchema,
  SendMessageInputSchema,
  UnclaimTaskInputSchema,
  UpdateAgentInputSchema,
  UpdateWorkspaceInputSchema,
  ArchiveWorkspaceInputSchema,
  UpdateTaskStatusInputSchema,
  type AgentDto,
  type AgentDeleteImpactDto,
  type ConversationDto,
  type SendMessageTarget,
} from '@silverhand/shared';
import type { BackendContext } from './context.js';
import { AgentRepo } from './repos/agent-repo.js';
import { HostRepo } from './repos/host-repo.js';
import { MessageRepo } from './repos/message-repo.js';
import { NotificationRepo } from './repos/notification-repo.js';
import { SavedMessageRepo } from './repos/saved-message-repo.js';
import { SearchRepo } from './repos/search-repo.js';
import { ConversationReadRepo } from './repos/conversation-read-repo.js';
import { ConversationInboxRepo } from './repos/conversation-inbox-repo.js';
import { SettingsRepo, SETTINGS_KEYS } from './repos/settings-repo.js';
import { WorkspaceRepo } from './repos/workspace-repo.js';
import { ConversationRepo, type RepoError } from './repos/conversation-repo.js';
import { validateWorkspacePath } from './provision.js';
import { ensureAgentL1Dir, initWorkspaceDir, seedAgentL2 } from './workspace-files.js';
import { ccMentionsFromUserMessage } from './mention-cc.js';
import { detectRuntimes } from './runtimes.js';
import { buildAgentWorkspaceDto } from './agent-workspace.js';
import {
  claimTasksByAgent,
  createTasksByAgent,
  humanClaim,
  humanUnclaim,
  humanUpdateStatus,
  listTasks,
  unclaimTaskByAgent,
  updateTaskStatusByAgent,
} from './tasks.js';

function isRepoError(err: unknown): err is RepoError {
  return err instanceof Error && typeof (err as RepoError).code === 'string';
}

const repoErrorStatusMap: Record<string, 400 | 404 | 409 | 429> = {
  parent_not_found: 404,
  parent_closed: 409,
  cross_channel_parent: 400,
  max_depth_exceeded: 400,
  concurrent_limit: 429,
  spawn_cooldown: 429,
};

const VIEWER_USER_ID_HEADER = 'x-silverhand-user-id';

function resolveViewerUserId(c: Context, ctx: BackendContext): string | null {
  const headerValue = c.req.header(VIEWER_USER_ID_HEADER)?.trim();
  return headerValue || ctx.serverConfig.user_id || null;
}

function requireViewerUserId(c: Context, ctx: BackendContext): string | Response {
  const viewerUserId = resolveViewerUserId(c, ctx);
  if (!viewerUserId) {
    return c.json({ error: 'viewer user id required' }, 400);
  }
  return viewerUserId;
}

function userLabel(userId: string | null | undefined): string {
  return userId ?? 'user';
}

function onboardingBody(
  workspaceName: string,
  recipient: AgentDto,
  others: AgentDto[],
): string {
  return [
    `You (@${recipient.name}) just joined workspace #${workspaceName}.`,
    others.length === 0
      ? `You're the only agent here right now.`
      : `Other agents in this workspace:\n${others.map(m => `- @${m.name} (${m.runtime})`).join('\n')}`,
    ``,
    `Send one short greeting — name yourself and, in one sentence, say what your current role looks like (or note that it's not yet defined). Then wait for the user.`,
  ].join('\n');
}

const SLOW_REQUEST_MS = 500;
const DIAGNOSTIC_REQUEST_MS = 100;
const SLOW_ROUTE_SPAN_MS = 100;
let apiRequestSequence = 0;

function installApiTimingMiddleware(app: Hono, ctx: BackendContext): void {
  app.use('*', async (c, next) => {
    const url = new URL(c.req.url);
    const path = url.pathname;
    const isDiagnosticPath = isChannelSwitchDiagnosticPath(path);
    const requestId = nextApiRequestId();
    const startedAt = performance.now();
    ctx.logger.info(
      {
        requestId,
        method: c.req.method,
        path,
        query: url.search || null,
      },
      'api: request start',
    );
    try {
      await next();
    } finally {
      const elapsedMs = elapsedSince(startedAt);
      ctx.logger.info(
        {
          requestId,
          method: c.req.method,
          path,
          query: url.search || null,
          status: c.res.status,
          elapsedMs,
        },
        'api: request complete',
      );
      if (
        elapsedMs >= SLOW_REQUEST_MS ||
        (isDiagnosticPath && elapsedMs >= DIAGNOSTIC_REQUEST_MS)
      ) {
        ctx.logger.warn(
          {
            requestId,
            method: c.req.method,
            path,
            status: c.res.status,
            elapsedMs,
            thresholdMs: isDiagnosticPath ? DIAGNOSTIC_REQUEST_MS : SLOW_REQUEST_MS,
          },
          'api: slow request',
        );
      }
    }
  });
}

function nextApiRequestId(): string {
  apiRequestSequence = (apiRequestSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `api-${apiRequestSequence}`;
}

function isChannelSwitchDiagnosticPath(path: string): boolean {
  if (path === apiPaths.messageUnreadSummary || path === apiPaths.workspaceDmChannels) {
    return true;
  }
  if (/^\/api\/workspaces\/[^/]+\/channels$/.test(path)) return true;
  if (
    /^\/api\/channels\/[^/]+\/(messages|agents|agent-run-states|threads|mark-read|message-unread)$/.test(
      path,
    )
  ) {
    return true;
  }
  return /^\/api\/threads\/[^/]+\/(messages|agents|agent-run-states|mark-read)$/.test(
    path,
  );
}

function timedRouteSpan<T>(
  ctx: BackendContext,
  span: string,
  fields: Record<string, unknown>,
  fn: () => T,
  resultFields?: (result: T) => Record<string, unknown>,
): T {
  const startedAt = performance.now();
  try {
    const result = fn();
    const elapsedMs = elapsedSince(startedAt);
    if (elapsedMs >= SLOW_ROUTE_SPAN_MS) {
      ctx.logger.warn(
        {
          span,
          elapsedMs,
          thresholdMs: SLOW_ROUTE_SPAN_MS,
          ...fields,
          ...(resultFields?.(result) ?? {}),
        },
        'api: slow route span',
      );
    }
    return result;
  } catch (err) {
    ctx.logger.warn(
      {
        span,
        elapsedMs: elapsedSince(startedAt),
        ...fields,
        err,
      },
      'api: route span failed',
    );
    throw err;
  }
}

function elapsedSince(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 10) / 10;
}

export function createApiRouter(ctx: BackendContext): Hono {
  const app = new Hono();
  installApiTimingMiddleware(app, ctx);
  const hosts = new HostRepo(ctx.db);
  const agents = new AgentRepo(ctx.db);
  const workspaces = new WorkspaceRepo(ctx.db, { workspacesRoot: ctx.workspacesRoot });
  const conversations = new ConversationRepo(ctx.db);
  const messages = new MessageRepo(ctx.db);
  const saved = new SavedMessageRepo(ctx.db);
  const search = new SearchRepo(ctx.db);
  const settings = new SettingsRepo(ctx.db);
  const conversationInboxes = new ConversationInboxRepo(ctx.db);
  const notifications = new NotificationRepo(ctx.db);
  const conversationReads = new ConversationReadRepo(ctx.db);

  const localHost = hosts.ensureLocal();

  // ── Health / runtimes / hosts ────────────────────────────────────
  app.get(apiPaths.health, c =>
    c.json({ ok: true, mode: ctx.serverConfig.mode, ts: Date.now() }),
  );

  app.get(apiPaths.runtimes, async c => {
    const runtimes = await detectRuntimes();
    return c.json({ runtimes });
  });

  app.get(apiPaths.hosts, c => c.json({ hosts: hosts.list() }));

  // ── Workspaces / conversations ──────────────────────────────────
  //
  // Canonical workspace/channel/thread API backed by workspaces and
  // conversations. Route kind guards prevent a thread id from silently
  // passing as a channel id.

  app.get(apiPaths.workspaces, c =>
    c.json({ workspaces: workspaces.list() }),
  );

  app.post(apiPaths.workspaces, async c => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = CreateWorkspaceInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    if (workspaces.getByName(parsed.data.name)) {
      return c.json({ error: 'workspace name already exists' }, 409);
    }

    const workspacePath =
      parsed.data.workspace_path?.trim() || workspaces.workspacePathFor(parsed.data.name);
    const validation = validateWorkspacePath(
      workspacePath,
      ctx.silverhandDir,
      ctx.workspacesRoot,
    );
    if (!validation.ok) {
      return c.json(
        { error: `invalid workspace_path: ${validation.reason}` },
        400,
      );
    }
    await initWorkspaceDir(validation.resolved);

    const workspace = workspaces.insert({
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      workspacePath: validation.resolved,
      workspaceHostId: parsed.data.workspace_host_id ?? localHost.id,
    });

    const memberAgents = parsed.data.member_agent_ids
      .map(id => agents.get(id))
      .filter((agent): agent is AgentDto => agent !== null);
    for (const agent of memberAgents) {
      workspaces.addMember(workspace.id, agent.id);
      const agentL1Dir = join(ctx.silverhandDir, 'agents', agent.id);
      await ensureAgentL1Dir(agentL1Dir);
      await seedAgentL2({
        workspacePath: workspace.workspace_path,
        agentId: agent.id,
        agentL1Dir,
      });
    }

    const onboarding = conversations.insertChannel({
      workspaceId: workspace.id,
      workspacePath: workspace.workspace_path,
      title: 'Onboarding',
    });
    for (const agent of memberAgents) {
      conversations.addAgent(onboarding.id, agent.id);
    }
    for (const agent of memberAgents) {
      const others = memberAgents.filter(m => m.id !== agent.id);
      const onboardingMsg = messages.insertForConversation({
        conversationId: onboarding.id,
        fromKind: 'system',
        content: onboardingBody(workspace.name, agent, others),
        metadata: { subtype: 'onboarding' },
      });
      await ctx.conversationManager.deliverMessage(
        onboarding.id,
        agent.id,
        onboardingMsg.id,
      );
      ctx.conversationManager
        .start(onboarding.id, agent.id)
        .catch(err =>
          ctx.logger.error(
            { conversationId: onboarding.id, agentId: agent.id, err },
            'onboarding spawn failed',
          ),
        );
    }

    return c.json(
      { workspace, onboarding_channel_id: onboarding.id, channel: onboarding },
      201,
    );
  });

  app.get(apiPaths.workspace(':id'), c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'workspace id required' }, 400);
    const workspace = workspaces.get(id);
    if (!workspace || workspace.workspace_kind !== 'regular') {
      return c.json({ error: 'workspace not found' }, 404);
    }
    return c.json({ workspace });
  });

  app.patch(apiPaths.workspace(':id'), async c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'workspace id required' }, 400);
    const workspace = workspaces.get(id);
    if (!workspace || workspace.workspace_kind !== 'regular') {
      return c.json({ error: 'workspace not found' }, 404);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = UpdateWorkspaceInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    if (parsed.data.name && parsed.data.name !== workspace.name) {
      const collision = workspaces.getByName(parsed.data.name);
      if (collision && collision.id !== workspace.id) {
        return c.json({ error: 'workspace name already exists' }, 409);
      }
    }
    const updated = workspaces.updateMutableMetadata(workspace.id, parsed.data);
    if (!updated) return c.json({ error: 'workspace update failed' }, 500);

    if (parsed.data.name && parsed.data.name !== workspace.name) {
      for (const channel of conversations.listChannelsForWorkspace(workspace.id)) {
        if (channel.closed_at !== null) continue;
        const announce = messages.insertForConversation({
          conversationId: channel.id,
          fromKind: 'system',
          content:
            `This workspace was renamed from #${workspace.name} to #${parsed.data.name}. ` +
            `Update any references in your MEMORY.md when you next edit it.`,
          metadata: {
            subtype: 'rename',
            old_name: workspace.name,
            new_name: parsed.data.name,
          },
        });
        for (const ca of conversations.listAgents(channel.id)) {
          await ctx.conversationManager.deliverMessage(
            channel.id,
            ca.agent_id,
            announce.id,
          );
        }
        ctx.events.publish(channel.id, {
          kind: 'message',
          payload: { message: announce },
        });
      }
    }

    return c.json({ workspace: updated });
  });

  app.patch('/api/workspaces/:id/archive', async c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'workspace id required' }, 400);
    const workspace = workspaces.get(id);
    if (!workspace || workspace.workspace_kind !== 'regular') {
      return c.json({ error: 'workspace not found' }, 404);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = ArchiveWorkspaceInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const updated = workspaces.setArchived(workspace.id, parsed.data.archived);
    if (!updated) return c.json({ error: 'archive update failed' }, 500);
    return c.json({ workspace: updated });
  });

  app.delete(apiPaths.workspace(':id'), async c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'workspace id required' }, 400);
    const workspace = workspaces.get(id);
    if (!workspace || workspace.workspace_kind !== 'regular') {
      return c.body(null, 204);
    }
    const workspaceConversations = conversations
      .list()
      .filter(conversation => conversation.workspace_id === workspace.id);
    for (const conversation of workspaceConversations) {
      ctx.conversationManager.resolveConversationRuns(conversation.id, 'conversation_closed');
      for (const ca of conversations.listAgents(conversation.id)) {
        void ctx.conversationManager.stop(conversation.id, ca.agent_id, 'hard');
      }
    }
    workspaces.delete(workspace.id);
    return c.body(null, 204);
  });

  app.get(apiPaths.workspaceChannels(':id'), c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'workspace id required' }, 400);
    const workspace = workspaces.get(id);
    if (!workspace || workspace.workspace_kind !== 'regular') {
      return c.json({ error: 'workspace not found' }, 404);
    }
    const channels = timedRouteSpan(
      ctx,
      'workspace.channels.list',
      { workspaceId: workspace.id },
      () => conversations.listChannelsForWorkspace(workspace.id),
      result => ({ channelCount: result.length }),
    );
    const threads = timedRouteSpan(
      ctx,
      'workspace.threads.list',
      { workspaceId: workspace.id },
      () => conversations.listThreadsForWorkspace(workspace.id),
      result => ({ threadCount: result.length }),
    );
    return c.json({
      channels,
      threads,
    });
  });

  app.post(apiPaths.workspaceChannels(':id'), async c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'workspace id required' }, 400);
    const workspace = workspaces.get(id);
    if (!workspace || workspace.workspace_kind !== 'regular') {
      return c.json({ error: 'workspace not found' }, 404);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = CreateConversationChannelInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    for (const aid of parsed.data.member_agent_ids) {
      if (!workspaces.isMember(workspace.id, aid)) {
        return c.json(
          { error: `agent ${aid} is not a member of this workspace` },
          400,
        );
      }
    }
    const channel = conversations.insertChannel({
      workspaceId: workspace.id,
      workspacePath: workspace.workspace_path,
      title: parsed.data.title,
    });
    for (const aid of parsed.data.member_agent_ids) {
      conversations.addAgent(channel.id, aid);
    }
    return c.json({ channel }, 201);
  });

  app.get(apiPaths.workspaceMembers(':id'), c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'workspace id required' }, 400);
    const workspace = workspaces.get(id);
    if (!workspace) return c.json({ error: 'workspace not found' }, 404);
    return c.json({ members: workspaces.listMembers(workspace.id) });
  });

  app.post(apiPaths.workspaceMembers(':id'), async c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'workspace id required' }, 400);
    const workspace = workspaces.get(id);
    if (!workspace || workspace.workspace_kind !== 'regular') {
      return c.json({ error: 'workspace not found' }, 404);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = AddWorkspaceMemberInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const agent = agents.get(parsed.data.agent_id);
    if (!agent) return c.json({ error: 'agent not found' }, 404);
    const member = workspaces.addMember(workspace.id, agent.id);
    const agentL1Dir = join(ctx.silverhandDir, 'agents', agent.id);
    await ensureAgentL1Dir(agentL1Dir);
    await seedAgentL2({
      workspacePath: workspace.workspace_path,
      agentId: agent.id,
      agentL1Dir,
    });
    return c.json({ member }, 201);
  });

  app.delete(apiPaths.workspaceMember(':id', ':agentId'), async c => {
    const id = c.req.param('id');
    const agentId = c.req.param('agentId');
    if (!id || !agentId) {
      return c.json({ error: 'workspace id and agent id required' }, 400);
    }
    const workspace = workspaces.get(id);
    if (!workspace) return c.body(null, 204);
    for (const conversation of conversations.list()) {
      if (conversation.workspace_id !== workspace.id) continue;
      await ctx.conversationManager
        .stop(conversation.id, agentId, 'hard')
        .catch(err =>
          ctx.logger.warn(
            { conversationId: conversation.id, agentId, err },
            'workspace member remove: stop failed',
          ),
        );
      conversations.removeAgent(conversation.id, agentId);
    }
    workspaces.removeMember(workspace.id, agentId);
    return c.body(null, 204);
  });

  app.get(apiPaths.workspaceDmChannels, c => {
    const dmChannels = timedRouteSpan(
      ctx,
      'workspace.dm_channels.list',
      {},
      () => conversations.listDmChannels(),
      result => ({ channelCount: result.length }),
    );
    return c.json({ dm_channels: dmChannels });
  });

  app.get('/api/workspaces/:id/message-unread', c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'workspace id required' }, 400);
    const workspace = workspaces.get(id);
    if (!workspace || workspace.workspace_kind !== 'regular') {
      return c.json({ error: 'workspace not found' }, 404);
    }
    const viewerUserId = requireViewerUserId(c, ctx);
    if (typeof viewerUserId !== 'string') return viewerUserId;
    const unread = timedRouteSpan(
      ctx,
      'workspace.message_unread.counts',
      { workspaceId: workspace.id, viewerUserId },
      () =>
        conversationReads.unreadCountsByConversationForWorkspace(
          workspace.id,
          viewerUserId,
        ),
      result => ({
        conversationCount: Object.keys(result.by_conversation).length,
        total: result.total,
      }),
    );
    return c.json(unread);
  });

  app.get(apiPaths.messageUnreadSummary, c => {
    const viewerUserId = requireViewerUserId(c, ctx);
    if (typeof viewerUserId !== 'string') return viewerUserId;
    const byWorkspace = timedRouteSpan(
      ctx,
      'workspace.message_unread.summary',
      { viewerUserId },
      () => conversationReads.unreadCountsByWorkspaceSidebar(viewerUserId),
      result => ({ scopeCount: Object.keys(result).length }),
    );
    return c.json({
      by_workspace: byWorkspace,
    });
  });

  app.get('/api/channels/:id/message-unread', c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'channel id required' }, 400);
    const channel = conversations.getChannelLike(id);
    if (!channel) return c.json({ error: 'channel not found' }, 404);
    const viewerUserId = requireViewerUserId(c, ctx);
    if (typeof viewerUserId !== 'string') return viewerUserId;
    const count = timedRouteSpan(
      ctx,
      'conversation.message_unread.count',
      { conversationId: channel.id, viewerUserId },
      () =>
        conversationReads.unreadCountForConversation(
          channel.id,
          viewerUserId,
        ),
    );
    return c.json({ by_conversation: { [channel.id]: count }, total: count });
  });

  app.get(apiPaths.conversationChannelMessages(':id'), c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'channel id required' }, 400);
    const channel = conversations.getChannelLike(id);
    if (!channel) return c.json({ error: 'channel not found' }, 404);
    const parsedLimit = Number(c.req.query('limit') ?? 200);
    const parsedBefore = c.req.query('before_seq');
    const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 500) : 200;
    const beforeSeq = parsedBefore ? Number(parsedBefore) : null;
    const window = timedRouteSpan(
      ctx,
      'conversation.messages.window',
      { conversationId: channel.id, kind: channel.kind, limit, beforeSeq },
      () => messages.listWindowForConversation(channel.id, { limit, beforeSeq }),
      result => ({
        messageCount: result.messages.length,
        hasMoreBefore: result.has_more_before,
      }),
    );
    return c.json(window);
  });

  app.get(apiPaths.conversationChannel(':id'), c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'channel id required' }, 400);
    const channel = conversations.getChannelLike(id);
    if (!channel) return c.json({ error: 'channel not found' }, 404);
    return c.json({ channel });
  });

  app.get(apiPaths.thread(':id'), c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'thread id required' }, 400);
    const thread = conversations.getThread(id);
    if (!thread) return c.json({ error: 'thread not found' }, 404);
    return c.json({ thread });
  });

  app.get(apiPaths.threadMessages(':id'), c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'thread id required' }, 400);
    const thread = conversations.getThread(id);
    if (!thread) return c.json({ error: 'thread not found' }, 404);
    const parsedLimit = Number(c.req.query('limit') ?? 200);
    const parsedBefore = c.req.query('before_seq');
    const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 500) : 200;
    const beforeSeq = parsedBefore ? Number(parsedBefore) : null;
    const window = timedRouteSpan(
      ctx,
      'conversation.messages.window',
      { conversationId: thread.id, kind: thread.kind, limit, beforeSeq },
      () => messages.listWindowForConversation(thread.id, { limit, beforeSeq }),
      result => ({
        messageCount: result.messages.length,
        hasMoreBefore: result.has_more_before,
      }),
    );
    return c.json(window);
  });

  app.get(apiPaths.conversationChannelAgents(':id'), c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'channel id required' }, 400);
    const channel = conversations.getChannelLike(id);
    if (!channel) return c.json({ error: 'channel not found' }, 404);
    const channelAgents = timedRouteSpan(
      ctx,
      'conversation.agents.list',
      { conversationId: channel.id, kind: channel.kind },
      () => conversations.listAgents(channel.id),
      result => ({ agentCount: result.length }),
    );
    return c.json({ agents: channelAgents });
  });

  app.get(apiPaths.threadAgents(':id'), c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'thread id required' }, 400);
    const thread = conversations.getThread(id);
    if (!thread) return c.json({ error: 'thread not found' }, 404);
    const threadAgents = timedRouteSpan(
      ctx,
      'conversation.agents.list',
      { conversationId: thread.id, kind: thread.kind },
      () => conversations.listAgents(thread.id),
      result => ({ agentCount: result.length }),
    );
    return c.json({ agents: threadAgents });
  });

  app.post('/api/channels/:id/pin', c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'channel id required' }, 400);
    let channel;
    try {
      channel = conversations.pin(id);
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code === 'thread') {
        return c.json({ error: 'threads cannot be pinned' }, 400);
      }
      throw err;
    }
    if (!channel) return c.json({ error: 'channel not found' }, 404);
    return c.json({ channel });
  });

  app.delete('/api/channels/:id/pin', c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'channel id required' }, 400);
    const channel = conversations.unpin(id);
    if (!channel) return c.json({ error: 'channel not found' }, 404);
    return c.json({ channel });
  });

  app.get(apiPaths.channelAgentRunStates(':id'), c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'channel id required' }, 400);
    const channel = conversations.getChannelLike(id);
    if (!channel) return c.json({ error: 'channel not found' }, 404);
    const states = timedRouteSpan(
      ctx,
      'conversation.agent_run_states.snapshot',
      { conversationId: channel.id, kind: channel.kind },
      () => ctx.conversationManager.getAgentRunStates(channel.id),
      result => ({ stateCount: result.length }),
    );
    return c.json({ states });
  });

  app.get(apiPaths.threadAgentRunStates(':id'), c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'thread id required' }, 400);
    const thread = conversations.getThread(id);
    if (!thread) return c.json({ error: 'thread not found' }, 404);
    const states = timedRouteSpan(
      ctx,
      'conversation.agent_run_states.snapshot',
      { conversationId: thread.id, kind: thread.kind },
      () => ctx.conversationManager.getAgentRunStates(thread.id),
      result => ({ stateCount: result.length }),
    );
    return c.json({ states });
  });

  app.post(apiPaths.channelMessages(':id'), async c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'channel id required' }, 400);
    const channel = conversations.getChannelLike(id);
    if (!channel) return c.json({ error: 'channel not found' }, 404);
    return postUserMessage(channel.id, c);
  });

  app.post(apiPaths.threadMessages(':id'), async c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'thread id required' }, 400);
    const thread = conversations.getThread(id);
    if (!thread) return c.json({ error: 'thread not found' }, 404);
    return postUserMessage(thread.id, c);
  });

  app.post(apiPaths.channelMarkRead(':id'), async c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'channel id required' }, 400);
    const channel = conversations.getChannelLike(id);
    if (!channel) return c.json({ error: 'channel not found' }, 404);
    return markConversationRead(channel.id, c);
  });

  app.post(apiPaths.threadMarkRead(':id'), async c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'thread id required' }, 400);
    const thread = conversations.getThread(id);
    if (!thread) return c.json({ error: 'thread not found' }, 404);
    return markConversationRead(thread.id, c);
  });

  app.get(apiPaths.channelThreads(':id'), c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'channel id required' }, 400);
    const channel = conversations.getChannelLike(id);
    if (!channel) return c.json({ error: 'channel not found' }, 404);
    const threads = timedRouteSpan(
      ctx,
      'conversation.threads.summary',
      { conversationId: channel.id, kind: channel.kind },
      () => conversations.listThreadSummariesForParent(channel.id),
      result => ({ threadCount: result.length }),
    );
    return c.json({ threads });
  });

  app.get(apiPaths.saved, c => c.json({ saved: saved.list() }));

  app.post(apiPaths.messageSave(':id'), c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'message id required' }, 400);
    const row = saved.save(id);
    if (!row) return c.json({ error: 'message not found' }, 404);
    // Notify viewer so the saved list invalidates without polling.
    ctx.events.publishToScope('viewer:local', 'saved_changed', { message_id: id, action: 'save' });
    return c.json({ saved: row }, 201);
  });

  app.delete(apiPaths.messageSave(':id'), c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'message id required' }, 400);
    saved.remove(id);
    // Notify viewer so the saved list invalidates without polling.
    ctx.events.publishToScope('viewer:local', 'saved_changed', { message_id: id, action: 'unsave' });
    return c.body(null, 204);
  });

  app.get(apiPaths.search, c => {
    const parsed = SearchQueryInputSchema.safeParse(
      Object.fromEntries(new URL(c.req.url).searchParams.entries()),
    );
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const results = search.search(parsed.data);
    return c.json({ query: parsed.data, results });
  });

  app.post(apiPaths.messageThread(':id'), async c => {
    const messageId = c.req.param('id');
    if (!messageId) return c.json({ error: 'message id required' }, 400);
    const original = messages.getById(messageId);
    if (!original) return c.json({ error: 'message not found' }, 404);

    const parentConversationId = original.conversation_id;
    const parent = conversations.getChannelLike(parentConversationId);
    if (!parent) return c.json({ error: 'parent channel not found' }, 404);
    if (parent.closed_at !== null) {
      return c.json({ error: 'parent channel is closed' }, 409);
    }

    const existing = conversations.findOpenThreadChild(parent.id, original.id);
    if (existing) {
      return c.json({
        thread_id: existing.id,
        thread: existing,
        reused: true,
      });
    }

    const parentAgentIds = conversations
      .listAgents(parent.id)
      .map(ca => ca.agent_id);
    const fallbackWorkspaceAgentIds =
      parentAgentIds.length === 0
        ? workspaces.listMemberAgents(parent.workspace_id)
        : [];
    const memberAgentIds = Array.from(
      new Set([
        original.from_kind === 'agent' ? original.from_agent_id : null,
        ...parentAgentIds,
        ...fallbackWorkspaceAgentIds,
      ].filter((id): id is string => !!id)),
    );
    if (memberAgentIds.length === 0) {
      return c.json({ error: 'channel has no members to start a thread with' }, 400);
    }

    const seedAgentId =
      original.from_kind === 'agent' && original.from_agent_id
        ? original.from_agent_id
        : memberAgentIds[0]!;
    const seedAgent = agents.get(seedAgentId);
    if (!seedAgent) {
      return c.json({ error: 'seed agent not found' }, 404);
    }

    let quotedSenderName: string | null = null;
    let quotedSenderLabel: string;
    if (original.from_kind === 'user') {
      quotedSenderLabel = userLabel(original.from_user_id);
    } else if (original.from_agent_id) {
      const a = agents.get(original.from_agent_id);
      quotedSenderName = a?.name ?? null;
      quotedSenderLabel = a ? `@${a.name}` : '@agent';
    } else {
      quotedSenderLabel = '@agent';
    }

    const flat = original.content.replace(/\s+/g, ' ').trim();
    const title =
      'Thread: ' + (flat.length > 50 ? flat.slice(0, 50) + '…' : flat);

    let thread;
    try {
      thread = conversations.insertThread({
        channelId: parent.id,
        title,
        spawnedByAgentId: null,
        spawnCtx: {
          limits: ctx.serverConfig.child_sessions,
          lastSpawnAtByAgent: ctx.lastSpawnAtByAgent,
        },
      });
    } catch (err) {
      if (isRepoError(err)) {
        return c.json(
          { error: err.message, code: err.code },
          repoErrorStatusMap[err.code] ?? 400,
        );
      }
      throw err;
    }

    for (const memberAgentId of memberAgentIds) {
      conversations.addAgent(thread.id, memberAgentId);
    }

    const workspace = workspaces.get(parent.workspace_id);
    const quoteText = [
      `Quoted from #${workspace?.name ?? parent.title} · ${quotedSenderLabel}:`,
      ``,
      ...original.content.split('\n').map(line => `> ${line}`),
    ].join('\n');
    messages.insertForConversation({
      conversationId: thread.id,
      fromKind: 'system',
      content: quoteText,
      metadata: {
        subtype: 'thread_anchor',
        quoted_message_id: original.id,
        quoted_conversation_id: parent.id,
        quoted_channel_name: workspace?.name ?? parent.title,
        quoted_content: original.content,
        quoted_from_kind: original.from_kind,
        quoted_from_agent_id: original.from_agent_id,
        quoted_from_user_id: original.from_user_id,
        quoted_agent_name: quotedSenderName,
        quoted_created_at: original.created_at,
      },
    });

    const onboarding = [
      `You (@${seedAgent.name}) just joined a thread in #${workspace?.name ?? parent.title}.`,
      `The user wants to dig deeper into the quoted message above.`,
      ``,
      `Read the quote, send one short greeting acknowledging the topic, then wait for the user.`,
      `If you need parent context, ask the parent channel via \`target='parent'\`. When you think the thread has reached a conclusion, post a visible summary in this thread and ask the user whether to close it. Only call \`close_thread\` after the user explicitly confirms.`,
    ].join('\n');
    const onboardingMsg = messages.insertForConversation({
      conversationId: thread.id,
      fromKind: 'system',
      content: onboarding,
      metadata: { subtype: 'onboarding' },
    });
    await ctx.conversationManager.deliverMessage(thread.id, seedAgent.id, onboardingMsg.id);
    void ctx.conversationManager.start(thread.id, seedAgent.id).catch(err => {
      ctx.logger.warn(
        { conversationId: thread.id, agentId: seedAgent.id, err },
        'api: auto-start on user-created thread failed',
      );
    });

    ctx.events.publish(parent.id, {
      kind: 'thread_updated',
      payload: {
        parent_conversation_id: parent.id,
        thread_id: thread.id,
      },
    });

    return c.json({ thread_id: thread.id, thread, reused: false }, 201);
  });

  app.post('/api/channels/:id/agents/:aid/start', async c => {
    const id = c.req.param('id');
    const aid = c.req.param('aid');
    if (!id || !aid) return c.json({ error: 'channel id and agent id required' }, 400);
    const channel = conversations.getChannelLike(id);
    if (!channel) return c.json({ error: 'channel not found' }, 404);
    return startConversationAgent(channel.id, aid, c);
  });

  app.post('/api/threads/:id/agents/:aid/start', async c => {
    const id = c.req.param('id');
    const aid = c.req.param('aid');
    if (!id || !aid) return c.json({ error: 'thread id and agent id required' }, 400);
    const thread = conversations.getThread(id);
    if (!thread) return c.json({ error: 'thread not found' }, 404);
    return startConversationAgent(thread.id, aid, c);
  });

  app.post('/api/channels/:id/agents/:aid/stop', async c => {
    const id = c.req.param('id');
    const aid = c.req.param('aid');
    if (!id || !aid) return c.json({ error: 'channel id and agent id required' }, 400);
    const channel = conversations.getChannelLike(id);
    if (!channel) return c.json({ error: 'channel not found' }, 404);
    return stopConversationAgent(channel.id, aid, c);
  });

  app.post('/api/threads/:id/agents/:aid/stop', async c => {
    const id = c.req.param('id');
    const aid = c.req.param('aid');
    if (!id || !aid) return c.json({ error: 'thread id and agent id required' }, 400);
    const thread = conversations.getThread(id);
    if (!thread) return c.json({ error: 'thread not found' }, 404);
    return stopConversationAgent(thread.id, aid, c);
  });

  async function postUserMessage(conversationId: string, c: Context): Promise<Response> {
    const conversation = conversations.get(conversationId);
    if (!conversation) return c.json({ error: 'conversation not found' }, 404);
    if (conversation.closed_at !== null) {
      return c.json({ error: 'conversation is closed' }, 409);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = SendMessageInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }

    const msg = messages.insertForConversation({
      conversationId: conversation.id,
      fromKind: 'user',
      fromUserId: resolveViewerUserId(c, ctx),
      content: parsed.data.content,
    });

    const recipients = conversations.listAgents(conversation.id);
    ctx.logger.info(
      {
        conversationId: conversation.id,
        messageId: msg.id,
        contentBytes: parsed.data.content.length,
        recipientCount: recipients.length,
        recipients: recipients.map(r => r.agent_id),
      },
      'api: user message accepted, distributing',
    );

    for (const ca of recipients) {
      void ctx.conversationManager.deliverMessage(conversation.id, ca.agent_id, msg.id);
    }

    ctx.events.publish(conversation.id, {
      kind: 'message',
      payload: { message: msg },
    });
    // v1 has a single human viewer, so this event is just an invalidation
    // pointer. Multi-user support should fan this out to all eligible viewers
    // except the sender once human membership tables exist.
    publishUnreadUpdated(ctx, conversation.id);

    if (conversation.parent_conversation_id) {
      ctx.events.publish(conversation.parent_conversation_id, {
        kind: 'thread_updated',
        payload: {
          parent_conversation_id: conversation.parent_conversation_id,
          thread_id: conversation.id,
        },
      });
    }

    const sourceWorkspace = workspaces.get(conversation.workspace_id);
    if (sourceWorkspace) {
      void ccMentionsFromUserMessage({
        message: msg,
        sourceConversation: conversation,
        sourceWorkspace,
        agents,
        conversations,
        messages,
        notifications,
        conversationManager: ctx.conversationManager,
        logger: ctx.logger,
        events: ctx.events,
      });
    }

    const result = c.json({ message: msg }, 201);

    void Promise.all(
      recipients
        .filter(r => r.status !== 'active' && r.status !== 'starting')
        .map(r =>
          ctx.conversationManager.start(conversation.id, r.agent_id).catch(err => {
            ctx.logger.warn(
              { conversationId: conversation.id, agentId: r.agent_id, err },
              'api: auto-start on message send failed',
            );
          }),
        ),
    );

    return result;
  }

  async function markConversationRead(
    conversationId: string,
    c: Context,
  ): Promise<Response> {
    const viewerUserId = requireViewerUserId(c, ctx);
    if (typeof viewerUserId !== 'string') return viewerUserId;
    const body = await c.req.json().catch(() => ({}));
    const parsed = MarkConversationReadInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const unreadBefore = conversationReads.unreadCountForConversation(
      conversationId,
      viewerUserId,
    );
    const row = conversationReads.markRead({
      viewerUserId,
      conversationId,
      seq: parsed.data.seq,
    });
    const unreadAfter =
      unreadBefore > 0
        ? conversationReads.unreadCountForConversation(conversationId, viewerUserId)
        : unreadBefore;
    // Notify viewer scope only when unread counters changed. Repeated
    // mark-read calls happen during focus/channel effects and should be no-ops.
    if (unreadAfter !== unreadBefore) {
      publishUnreadUpdated(ctx, conversationId, viewerUserId);
    }
    return c.json({ last_read_seq: row.last_read_seq });
  }

  async function startConversationAgent(
    conversationId: string,
    agentId: string,
    c: Context,
  ): Promise<Response> {
    if (!agents.get(agentId)) return c.json({ error: 'agent not found' }, 404);
    if (!conversations.getAgent(conversationId, agentId)) {
      return c.json({ error: 'agent is not a member of this conversation' }, 400);
    }
    ctx.logger.info(
      { conversationId, agentId },
      'api: start agent requested',
    );
    try {
      await ctx.conversationManager.start(conversationId, agentId);
      return c.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.logger.error(
        { conversationId, agentId, err },
        'api: start agent failed',
      );
      return c.json({ error: msg }, 400);
    }
  }

  async function stopConversationAgent(
    conversationId: string,
    agentId: string,
    c: Context,
  ): Promise<Response> {
    const body = await c.req.json().catch(() => ({}));
    const mode: 'soft' | 'hard' = body?.mode === 'soft' ? 'soft' : 'hard';
    const directive =
      typeof body?.directive === 'string' ? body.directive : undefined;
    ctx.logger.info(
      { conversationId, agentId, mode, hasDirective: !!directive },
      'api: stop agent requested',
    );
    await ctx.conversationManager.stop(conversationId, agentId, mode, directive);
    return c.json({ ok: true });
  }

  async function provisionAgentDmChannel(agent: AgentDto) {
    const agentL1Dir = join(ctx.silverhandDir, 'agents', agent.id);
    await ensureAgentL1Dir(agentL1Dir);
    const systemWorkspace = workspaces.ensureSystemDmWorkspace({
      workspacePath: agentL1Dir,
      workspaceHostId: localHost.id,
    });
    const existing = conversations.findDmChannelForAgent(agent.id);
    if (existing) return existing;

    const dm = conversations.insertDmChannel({
      workspaceId: systemWorkspace.id,
      workspacePath: agentL1Dir,
      title: `dm-${agent.name}`,
      agentId: agent.id,
    });
    conversations.addAgent(dm.id, agent.id);
    const onboardingMsg = messages.insertForConversation({
      conversationId: dm.id,
      fromKind: 'system',
      content: [
        `You (@${agent.name}) are now in your personal DM with the user.`,
        `Send one short greeting — say hi by name and ask what role the user would like you to play. Then wait for their reply.`,
      ].join('\n'),
      metadata: { subtype: 'onboarding' },
    });
    await ctx.conversationManager.deliverMessage(dm.id, agent.id, onboardingMsg.id);
    ctx.conversationManager
      .start(dm.id, agent.id)
      .catch(err =>
        ctx.logger.error(
          { conversationId: dm.id, agentId: agent.id, err },
          'dm onboarding spawn failed',
        ),
      );
    return dm;
  }

  // ── Agents ───────────────────────────────────────────────────────
  app.get(apiPaths.agents, c => c.json({ agents: agents.list() }));

  app.post(apiPaths.agents, async c => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = CreateAgentInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    if (agents.getByName(parsed.data.name)) {
      return c.json({ error: 'agent name already exists' }, 409);
    }
    const agent = agents.create(parsed.data, localHost.id);
    // Auto-create the agent's DM channel + onboarding conversation.
    const dm = await provisionAgentDmChannel(agent);
    return c.json({ agent, dm_channel_id: dm.id }, 201);
  });

  app.get('/api/agents/:id', c => {
    const agent = agents.get(c.req.param('id'));
    if (!agent) return c.json({ error: 'agent not found' }, 404);
    return c.json({ agent });
  });

  // PATCH — partial update. `name` and `host_id` are intentionally not
  // patchable here: `name` is the immutable handle (renaming would
  // ripple through dm-<name>, every @mention in history, every L2
  // file path), and host swap is out of v1 scope. Runtime change is
  // refused while any conversation_agent for this agent is starting/active
  // — otherwise the next event from the in-flight CLI would be parsed
  // by the wrong driver.
  app.patch('/api/agents/:id', async c => {
    const id = c.req.param('id');
    const agent = agents.get(id);
    if (!agent) return c.json({ error: 'agent not found' }, 404);
    const body = await c.req.json().catch(() => ({}));
    const parsed = UpdateAgentInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    if (parsed.data.runtime && parsed.data.runtime !== agent.runtime) {
      const live = agents
        .listRuntimeConversations(id)
        .some(s => s.status === 'starting' || s.status === 'active');
      if (live) {
        return c.json(
          { error: 'agent_busy_change_runtime', detail: 'stop the agent before changing runtime' },
          409,
        );
      }
    }
    const updated = agents.update(id, parsed.data);
    return c.json({ agent: updated });
  });

  app.get('/api/agents/:id/workspace', async c => {
    const agent = agents.get(c.req.param('id'));
    if (!agent) return c.json({ error: 'agent not found' }, 404);
    const l1Dir = join(ctx.silverhandDir, 'agents', agent.id);
    const workspace = await buildAgentWorkspaceDto(l1Dir);
    return c.json({ workspace });
  });

  app.get('/api/agents/:id/runtime-state', c => {
    const agent = agents.get(c.req.param('id'));
    if (!agent) return c.json({ error: 'agent not found' }, 404);
    return c.json({ conversation_agents: agents.listRuntimeConversations(agent.id) });
  });

  // POST /stop — hard-stop every running conversation_agent for this
  // agent. Returns the count we actually attempted to stop. No-op
  // (200 with stopped: 0) when nothing is running.
  app.post('/api/agents/:id/stop', async c => {
    const id = c.req.param('id');
    const agent = agents.get(id);
    if (!agent) return c.json({ error: 'agent not found' }, 404);
    const live = agents
      .listRuntimeConversations(id)
      .filter(s => s.status === 'starting' || s.status === 'active');
    await Promise.all(
      live.map(s =>
        ctx.conversationManager.stop(s.conversation_id, id, 'hard').catch(err =>
          ctx.logger.warn(
            { conversationId: s.conversation_id, agentId: id, err },
            'agent stop: conversation stop failed',
          ),
        ),
      ),
    );
    return c.json({ stopped: live.length });
  });

  // GET /delete-impact — drives the destructive-confirm dialog.
  app.get('/api/agents/:id/delete-impact', c => {
    const agent = agents.get(c.req.param('id'));
    if (!agent) return c.json({ error: 'agent not found' }, 404);
    return c.json({ impact: computeDeleteImpact(agent.id) });
  });

  // DELETE — full destructive flow. See docs/progress.md (this PR's
  // entry). Caller must pass `{ confirm: true }` so wallet-fingers
  // can't drop a heavy DM channel by accident from devtools.
  app.delete('/api/agents/:id', async c => {
    const id = c.req.param('id');
    const agent = agents.get(id);
    if (!agent) return c.body(null, 204); // idempotent on unknown id
    const body = await c.req.json().catch(() => ({}));
    const parsed = DeleteAgentInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: 'confirm flag required', detail: 'pass {"confirm": true}' },
        400,
      );
    }

    const impact = computeDeleteImpact(id);

    // 1. Hard-stop every running conversation_agent. Must precede any DB
    //    delete — once conversation_agents rows are gone, conversationManager
    //    can't look up handles by (conversation id, agent id).
    for (const live of impact.running_conversation_agents) {
      await ctx.conversationManager
        .stop(live.conversation_id, id, 'hard')
        .catch(err =>
          ctx.logger.warn(
            { conversationId: live.conversation_id, agentId: id, err },
            'delete: stop failed (continuing)',
          ),
        );
    }

    // 2. Remove from every regular workspace and its conversations.
    for (const ws of impact.regular_workspaces) {
      const workspace = workspaces.get(ws.id);
      if (!workspace) continue;
      for (const conversation of conversations.list()) {
        if (conversation.workspace_id === workspace.id) {
          conversations.removeAgent(conversation.id, id);
        }
      }
      workspaces.removeMember(workspace.id, id);
    }

    // 3. Drop every DM conversation for the agent.
    for (const dm of conversations.listDmChannelsForAgent(id)) {
      conversations.delete(dm.id);
    }

    // 4. Drop the agent (CASCADEs remaining conversation_agents/inbox rows;
    //    SET NULL on messages.from_agent_id).
    agents.delete(id);

    // 5. Wipe L1 — the agent's global memory/notes/system_prompt.
    await fs
      .rm(impact.l1_path, { recursive: true, force: true })
      .catch(err =>
        ctx.logger.warn({ agentId: id, l1: impact.l1_path, err }, 'delete: L1 rm failed'),
      );
    await Promise.all(
      impact.l2_paths.map(p =>
        fs.rm(p, { recursive: true, force: true }).catch(err =>
          ctx.logger.warn({ agentId: id, path: p, err }, 'delete: L2 rm failed'),
        ),
      ),
    );

    ctx.logger.info(
      {
        agentId: id,
        agentName: agent.name,
        dmChannelId: impact.dm_channel?.id ?? null,
        regularWorkspaces: impact.regular_workspaces.length,
        stoppedConversations: impact.running_conversation_agents.length,
      },
      'agent deleted',
    );
    return c.body(null, 204);
  });

  /**
   * Build the AgentDeleteImpactDto from current DB + filesystem
   * state. Pure read — used both by the GET preview endpoint and by
   * the DELETE handler so the two stay in lock-step.
   */
  function computeDeleteImpact(agentId: string): AgentDeleteImpactDto {
    const agent = agents.get(agentId);
    if (!agent) throw new Error('agent not found'); // guarded by callers
    const regulars = workspaces.listForAgent(agentId);
    const dmConversations = conversations.listDmChannelsForAgent(agentId);
    const dm = dmConversations[0] ?? null;

    let dmChannel: AgentDeleteImpactDto['dm_channel'] = null;
    if (dm) {
      const ids = dmConversations.map(c => c.id);
      const placeholders = ids.map(() => '?').join(',');
      const messageCount =
        ids.length === 0
          ? 0
          : ctx.db
              .prepare<string[], { c: number }>(
	                `SELECT COUNT(*) AS c
	                   FROM messages
	                  WHERE conversation_id IN (${placeholders})`,
	              )
              .get(...ids)?.c ?? 0;
      dmChannel = {
        id: dm.id,
        name: dm.title,
        conversation_count: dmConversations.length,
        message_count: messageCount,
      };
    }

    const runtimeConversations = agents.listRuntimeConversations(agentId);
    const running = runtimeConversations
      .filter(s => s.status === 'starting' || s.status === 'active')

    const l1Path = join(ctx.silverhandDir, 'agents', agentId);
    const l2Paths = regulars.map(c =>
      join(c.workspace_path, '.silverhand', 'agents', agentId),
    );

    return {
      agent_id: agent.id,
      agent_name: agent.name,
      agent_display_name: agent.display_name,
      dm_channel: dmChannel,
      regular_workspaces: regulars.map(c => ({ id: c.id, name: c.name })),
      running_conversation_agents: running,
      pending_inbox_count: conversationInboxes.countPendingForAgent(agentId),
      l1_path: l1Path,
      l2_paths: l2Paths,
    };
  }

  // Old HTTP route aliases were removed in the hard cutover.

  // ── Host-wide settings ───────────────────────────────────────────
  // Flat KV. Currently exposes `proxy_url`. Empty string deletes the row.
  app.get(apiPaths.settings, c => c.json({ settings: settings.all() }));

  app.put(apiPaths.settings, async c => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return c.json({ error: 'invalid input' }, 400);
    }
    const allowed = new Set<string>(Object.values(SETTINGS_KEYS));
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      if (!allowed.has(k)) {
        return c.json({ error: `unknown settings key: ${k}` }, 400);
      }
      if (typeof v !== 'string') {
        return c.json({ error: `value for ${k} must be a string` }, 400);
      }
      settings.set(k, v);
    }
    return c.json({ settings: settings.all() });
  });

  // ── Notifications ────────────────────────────────────────────────
  // v1 single-user. user_id is always NULL on writes; reads filter on
  // `user_id IS NULL` (see NotificationRepo.list). Multi-user migration
  // will pass through a user id resolved from auth.
  app.get(apiPaths.notifications, c => {
    const unread = c.req.query('unread') === '1';
    const limit = parseLimit(c.req.query('limit'), 100);
    return c.json({
      notifications: notifications.list({ unread, limit }),
    });
  });

  // Lightweight endpoint: total unread + per-sidebar-scope counts + the
  // most recent unread pointer so the renderer can jump straight there.
  app.get(apiPaths.notificationsUnread, c => {
    const total = timedRouteSpan(
      ctx,
      'notifications.unreadCount',
      {},
      () => notifications.unreadCount(),
      result => ({ total: result }),
    );
    const byWorkspace = Object.fromEntries(
      timedRouteSpan(
        ctx,
        'notifications.unreadCountsByWorkspace',
        {},
        () => notifications.unreadCountsByWorkspace(),
        result => ({ workspaceCount: result.size }),
      ).entries(),
    );
    const latestByWorkspace = Object.fromEntries(
      timedRouteSpan(
        ctx,
        'notifications.latestUnreadByWorkspace',
        {},
        () => notifications.latestUnreadByWorkspace(),
        result => ({ workspaceCount: result.size }),
      ).entries(),
    );
    return c.json({
      total,
      by_workspace: byWorkspace,
      latest_by_workspace: latestByWorkspace,
    });
  });

  // Mark-read with three modes: by id, by conversation/workspace, or all. Validation
  // mirrors `MarkNotificationsReadInputSchema` in shared/dto.ts.
  app.post(apiPaths.notificationsRead, async c => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = MarkNotificationsReadInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const { id, workspace_id, conversation_id, all } = parsed.data;
    let marked = 0;
    if (id) {
      const ok = notifications.markRead(id);
      marked = ok ? 1 : 0;
    } else if (workspace_id) {
      marked = notifications.markWorkspaceRead(workspace_id);
    } else if (conversation_id) {
      marked = notifications.markConversationRead(conversation_id);
    } else if (all) {
      marked = notifications.markAllRead();
    } else {
      // Unreachable thanks to the schema refine, but TS doesn't narrow.
      return c.json({ error: 'invalid input' }, 400);
    }
    // Push viewer:local only when unread notification counters changed.
    // v1 single-user: userId='local'.
    if (marked > 0) {
      ctx.events.publishToScope('viewer:local', 'unread_updated', { marked });
    }
    return c.json({ marked });
  });

  // ── Tasks (human-facing list + overrides) ────────────────────────
  const taskDeps = { ctx, agents, conversations, messages };

  app.get(apiPaths.tasks, c => {
    const parsed = ListTasksQuerySchema.safeParse({
      workspace_id: c.req.query('workspace_id') || undefined,
      conversation_id: c.req.query('conversation_id') || undefined,
      status: c.req.query('status') || undefined,
    });
    if (!parsed.success) {
      return c.json({ error: 'invalid query', issues: parsed.error.issues }, 400);
    }
    return c.json({ tasks: listTasks(taskDeps, parsed.data) });
  });

  app.post('/api/tasks/:messageId/claim', async c => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = HumanClaimTaskInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const result = await humanClaim(taskDeps, {
      messageId: c.req.param('messageId'),
      agentId: parsed.data.agent_id,
    });
    return c.json(result, result.success ? 200 : 409);
  });

  app.post('/api/tasks/:messageId/unclaim', async c => {
    const result = await humanUnclaim(taskDeps, {
      messageId: c.req.param('messageId'),
    });
    return c.json(result, result.success ? 200 : 409);
  });

  app.post('/api/tasks/:messageId/status', async c => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = HumanUpdateTaskStatusInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const result = await humanUpdateStatus(taskDeps, {
      messageId: c.req.param('messageId'),
      status: parsed.data.status,
    });
    return c.json(result, result.success ? 200 : 409);
  });

  return app;
}

function parseLimit(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, 500);
}

function parseBeforeSeq(raw: string | undefined): number | null | 'invalid' {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return 'invalid';
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n) || n <= 0) return 'invalid';
  return n;
}

function publishUnreadUpdated(
  ctx: BackendContext,
  conversationId: string,
  viewerUserId = 'local',
): void {
  ctx.events.publishToScope(`viewer:${viewerUserId}`, 'unread_updated', {
    conversation_id: conversationId,
  });
}

export function createInternalRouter(ctx: BackendContext): Hono {
  const app = new Hono();
  const agents = new AgentRepo(ctx.db);
  const conversations = new ConversationRepo(ctx.db);
  const messages = new MessageRepo(ctx.db);
  const taskDeps = { ctx, agents, conversations, messages };

  app.use('*', async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const token = header.replace(/^Bearer\s+/i, '').trim();
    if (!token || token !== ctx.serverConfig.auth_token) {
      ctx.logger.warn(
        {
          path: c.req.path,
          hasHeader: !!header,
          tokenLen: token.length,
          caller: c.req.header('x-agent-hub-caller') ?? 'unknown',
        },
        'internal: unauthorized request',
      );
      return c.json({ error: 'unauthorized' }, 401);
    }
    await next();
  });

  // ── canonical conversation-scoped MCP routes ───────────────────
  app.post(internalPaths.agentSendConversationMessage(':cid', ':aid'), async c => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    const conversation = conversations.get(cid);
    if (!conversation) return c.json({ error: 'conversation not found' }, 404);
    const agent = agents.get(aid);
    if (!agent) return c.json({ error: 'agent not found' }, 404);
    const body = await c.req.json().catch(() => ({}));
    const parsed = AgentSendMessageInputSchema.safeParse(body);
    if (!parsed.success) {
      ctx.logger.warn(
        { conversationId: cid, agentId: aid, issues: parsed.error.issues },
        'internal: agent send-message rejected (invalid input)',
      );
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }

    const target = parsed.data.target ?? 'self';
    const targetConversation = resolveConversationTarget(conversation, target, conversations);
    if (typeof targetConversation === 'string') {
      ctx.logger.warn(
        { conversationId: cid, agentId: aid, target, reason: targetConversation },
        'internal: agent send-message target unreachable',
      );
      return c.json({ error: targetConversation, code: 'target_unreachable' }, 400);
    }
    if (targetConversation.closed_at !== null) {
      ctx.logger.warn(
        { conversationId: cid, agentId: aid, targetConversationId: targetConversation.id },
        'internal: agent send-message into closed conversation',
      );
      return c.json({ error: 'target conversation is closed' }, 409);
    }

    const msg = messages.insertForConversation({
      conversationId: targetConversation.id,
      fromKind: 'agent',
      fromAgentId: aid,
      content: parsed.data.content,
    });

    ctx.logger.info(
      {
        conversationId: cid,
        agentId: aid,
        targetConversationId: targetConversation.id,
        messageId: msg.id,
        contentBytes: parsed.data.content.length,
        target,
      },
      'internal: agent send-message inserted, distributing',
    );

    await distributeConversationMessage(
      ctx,
      conversations,
      targetConversation.id,
      aid,
      msg.id,
    );

    ctx.events.publish(targetConversation.id, {
      kind: 'message',
      payload: { message: msg },
    });
    publishUnreadUpdated(ctx, targetConversation.id);
    ctx.conversationManager.resolveRun(cid, aid, 'replied');

    if (targetConversation.parent_conversation_id) {
      ctx.events.publish(targetConversation.parent_conversation_id, {
        kind: 'thread_updated',
        payload: {
          parent_conversation_id: targetConversation.parent_conversation_id,
          thread_id: targetConversation.id,
        },
      });
    }

    return c.json({ message_id: msg.id });
  });

  app.post(internalPaths.agentCreateThread(':cid', ':aid'), async c => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    const parent = conversations.getChannelLike(cid);
    if (!parent) return c.json({ error: 'parent channel not found' }, 404);
    if (!agents.get(aid)) return c.json({ error: 'agent not found' }, 404);
    const body = await c.req.json().catch(() => ({}));
    const parsed = AgentSpawnChildInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }

    const parentMembers = new Set(
      conversations.listAgents(parent.id).map(member => member.agent_id),
    );
    if (!parentMembers.has(aid)) {
      return c.json({ error: 'agent is not a member of the parent channel' }, 400);
    }
    const requestedMembers =
      parsed.data.members && parsed.data.members.length > 0
        ? parsed.data.members
        : [...parentMembers];
    for (const memberId of requestedMembers) {
      if (!parentMembers.has(memberId)) {
        return c.json(
          { error: `agent ${memberId} is not a member of the parent channel` },
          400,
        );
      }
    }
    const threadMemberIds = Array.from(new Set([...requestedMembers, aid]));

    let thread;
    try {
      thread = conversations.insertThread({
        channelId: parent.id,
        title: parsed.data.title,
        spawnedByAgentId: aid,
        spawnCtx: {
          limits: ctx.serverConfig.child_sessions,
          lastSpawnAtByAgent: ctx.lastSpawnAtByAgent,
        },
      });
    } catch (err) {
      if (isRepoError(err)) {
        return c.json(
          { error: err.message, code: err.code },
          repoErrorStatusMap[err.code] ?? 400,
        );
      }
      throw err;
    }

    for (const memberId of threadMemberIds) {
      conversations.addAgent(thread.id, memberId);
    }

    const contextMsg = messages.insertForConversation({
      conversationId: thread.id,
      fromKind: 'system',
      content:
        `Inherited context from parent channel '${parent.title}': ${parsed.data.context_summary}`,
      metadata: { subtype: 'child_context' },
    });
    const prompt = messages.insertForConversation({
      conversationId: thread.id,
      fromKind: 'agent',
      fromAgentId: aid,
      content: parsed.data.initial_prompt,
    });
    await ctx.conversationManager.deliverMessage(thread.id, aid, contextMsg.id);
    await distributeConversationMessage(ctx, conversations, thread.id, aid, prompt.id);
    void startConversationAgents(ctx, conversations, thread.id, {
      reason: 'internal: auto-start on agent-created thread failed',
    });

    ctx.events.publish(parent.id, {
      kind: 'thread_updated',
      payload: {
        parent_conversation_id: parent.id,
        thread_id: thread.id,
      },
    });

    return c.json({ thread_id: thread.id });
  });

  app.post(internalPaths.agentCreateChannel(':cid', ':aid'), async c => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    const current = conversations.get(cid);
    if (!current) return c.json({ error: 'conversation not found' }, 404);
    if (!agents.get(aid)) return c.json({ error: 'agent not found' }, 404);
    const body = await c.req.json().catch(() => ({}));
    const parsed = AgentCreateChannelInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }

    const channel = conversations.insertChannel({
      workspaceId: current.workspace_id,
      workspacePath: current.workspace_path,
      title: parsed.data.title,
      spawnedByAgentId: aid,
    });

    for (const member of conversations.listAgents(current.id)) {
      conversations.addAgent(channel.id, member.agent_id);
    }

    const contextMsg = messages.insertForConversation({
      conversationId: channel.id,
      fromKind: 'system',
      content:
        `Channel created from '${current.title}'. Reason: ${parsed.data.context_summary}`,
      metadata: {
        subtype: 'channel_context',
        source_conversation_id: current.id,
        created_by_agent_id: aid,
      },
    });
    const prompt = messages.insertForConversation({
      conversationId: channel.id,
      fromKind: 'agent',
      fromAgentId: aid,
      content: parsed.data.initial_prompt,
    });

    await ctx.conversationManager.deliverMessage(channel.id, aid, contextMsg.id);
    await distributeConversationMessage(ctx, conversations, channel.id, aid, prompt.id);
    void startConversationAgents(ctx, conversations, channel.id, {
      reason: 'internal: auto-start on agent-created channel failed',
    });

    return c.json({ channel_id: channel.id });
  });

  app.post(internalPaths.agentCloseThread(':cid', ':aid'), async c => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    const thread = conversations.getThread(cid);
    if (!thread) return c.json({ error: 'thread not found' }, 404);
    if (!agents.get(aid)) return c.json({ error: 'agent not found' }, 404);
    if (thread.closed_at !== null) {
      return c.json({ error: 'already closed' }, 409);
    }
    if (conversations.countActiveChildren(thread.id) > 0) {
      return c.json(
        { error: 'close all child threads first', code: 'has_active_children' },
        409,
      );
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = AgentCloseThreadInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }

    const closed = conversations.close(thread.id, parsed.data.summary);
    ctx.conversationManager.resolveConversationRuns(thread.id, 'conversation_closed');
    if (!parsed.data.posted_to_parent && thread.parent_conversation_id) {
      const parent = conversations.get(thread.parent_conversation_id);
      if (parent && parent.closed_at === null) {
        const agent = agents.get(aid);
        const summaryMsg = messages.insertForConversation({
          conversationId: parent.id,
          fromKind: 'system',
          content:
            `Thread '${thread.title}' closed by @${agent?.name ?? 'agent'}. ` +
            `Summary: ${parsed.data.summary}`,
          metadata: { subtype: 'thread_summary' },
        });
        await distributeConversationMessage(ctx, conversations, parent.id, null, summaryMsg.id);
        ctx.events.publish(parent.id, {
          kind: 'message',
          payload: { message: summaryMsg },
        });
      }
    }

    if (thread.parent_conversation_id) {
      ctx.events.publish(thread.parent_conversation_id, {
        kind: 'thread_updated',
        payload: {
          parent_conversation_id: thread.parent_conversation_id,
          thread_id: thread.id,
        },
      });
    }

    for (const ca of conversations.listAgents(thread.id)) {
      void ctx.conversationManager.stop(thread.id, ca.agent_id, 'hard');
    }

    return c.json({ thread: closed });
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
    const parsed = ListTasksQuerySchema.safeParse({
      workspace_id: c.req.query('workspace_id') || conversation.workspace_id,
      conversation_id: c.req.query('conversation_id') || undefined,
      status: c.req.query('status') || undefined,
    });
    if (!parsed.success) {
      return c.json({ error: 'invalid query', issues: parsed.error.issues }, 400);
    }
    return c.json({ tasks: listTasks(taskDeps, parsed.data) });
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
    const result = await createTasksByAgent(taskDeps, {
      conversationId: cid,
      agentId: aid,
      tasks: parsed.data.tasks,
    });
    if ('error' in result) {
      return c.json({ error: result.error }, 400);
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
    const result = await claimTasksByAgent(taskDeps, {
      conversationId: cid,
      agentId: aid,
      task_numbers: parsed.data.task_numbers,
      message_ids: parsed.data.message_ids,
    });
    if ('error' in result) {
      return c.json({ error: result.error }, 400);
    }
    return c.json(result);
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
    const result = await unclaimTaskByAgent(taskDeps, {
      conversationId: cid,
      agentId: aid,
      taskNumber: parsed.data.task_number,
    });
    if ('error' in result) {
      return c.json({ error: result.error }, 400);
    }
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
    const result = await updateTaskStatusByAgent(taskDeps, {
      conversationId: cid,
      agentId: aid,
      taskNumber: parsed.data.task_number,
      status: parsed.data.status,
    });
    if ('error' in result) {
      return c.json({ error: result.error }, 400);
    }
    return c.json(result);
  });

  return app;
}

function resolveConversationTarget(
  current: ConversationDto,
  target: SendMessageTarget,
  conversations: ConversationRepo,
): ConversationDto | string {
  if (target === 'self') return current;
  if (target === 'parent') {
    if (!current.parent_conversation_id) {
      return 'no parent channel — current channel is top-level';
    }
    const parent = conversations.get(current.parent_conversation_id);
    if (!parent) return 'parent channel not found';
    return parent;
  }
  const thread = conversations.getThread(target.thread_id);
  if (!thread) return 'thread not found';
  if (thread.parent_conversation_id !== current.id) {
    return 'target is not a direct thread of current channel';
  }
  return thread;
}

async function distributeConversationMessage(
  ctx: BackendContext,
  conversations: ConversationRepo,
  conversationId: string,
  excludeAgentId: string | null,
  messageId: string,
): Promise<void> {
  const recipients = conversations
    .listAgents(conversationId)
    .filter(ca => ca.agent_id !== excludeAgentId);
  await Promise.all(
    recipients.map(ca =>
      ctx.conversationManager.deliverMessage(conversationId, ca.agent_id, messageId),
    ),
  );
}

async function startConversationAgents(
  ctx: BackendContext,
  conversations: ConversationRepo,
  conversationId: string,
  opts: { reason: string },
): Promise<void> {
  const recipients = conversations
    .listAgents(conversationId)
    .filter(ca => ca.status !== 'active' && ca.status !== 'starting');
  await Promise.all(
    recipients.map(ca =>
      ctx.conversationManager.start(conversationId, ca.agent_id).catch(err => {
        ctx.logger.warn(
          { conversationId, agentId: ca.agent_id, err },
          opts.reason,
        );
      }),
    ),
  );
}
