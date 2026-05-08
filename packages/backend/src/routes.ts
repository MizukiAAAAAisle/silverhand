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
  ArchiveChannelInputSchema,
  ArchivedChannelsQueryInputSchema,
  UpdateTaskStatusInputSchema,
  type AgentDto,
  type AgentDeleteImpactDto,
  type CreateAgentInput,
} from '@silverhand/shared';
import type { BackendContext } from './context.js';
import { AgentRepo } from './repos/agent-repo.js';
import { AttachmentRepo } from './repos/attachment-repo.js';
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
import { detectRuntimes } from './runtimes.js';
import { buildAgentWorkspaceDto } from './agent-workspace.js';
import { AttachmentRejection } from './services/attachment-service.js';
import {
  ActorError as ChannelActorError,
  MemberError,
  SeedError,
  WorkspaceUnsuitableError,
} from './services/channel-service.js';
import {
  ActorError as MessageActorError,
  AttachmentError as MessageAttachmentError,
  ConversationError,
  PolicyError,
  TargetError,
} from './services/conversation-message-service.js';
import {
  ActorError as ThreadActorError,
  MembershipError as ThreadMembershipError,
  MessageError as ThreadMessageError,
  ParentError as ThreadParentError,
  SeedAgentError,
  ThreadError,
} from './services/thread-service.js';
import {
  type AppEnv,
  getAgentPrincipal,
  getUserPrincipal,
  installInternalPrincipalMiddleware,
  installPublicPrincipalMiddleware,
} from './auth/principal.js';
import { installPublicBearerMiddleware } from './auth/bearer.js';
import {
  canDeleteAttachment,
  canManageMembers,
  canMutateWorkspace,
  canPostToConversation,
  canViewAttachment,
  canViewConversation,
  canViewOwnedState,
  canViewWorkspace,
} from './permissions.js';

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
  not_found: 404,
  thread: 400,
  not_archivable: 400,
};

function channelServiceErrorResponse(c: Context, err: unknown): Response | null {
  if (err instanceof WorkspaceUnsuitableError) {
    return c.json(
      { error: err.message, code: err.code },
      err.code === 'workspace_not_found' ? 404 : 400,
    );
  }
  if (err instanceof MemberError || err instanceof SeedError) {
    return c.json({ error: err.message, code: err.code }, 400);
  }
  if (err instanceof ChannelActorError) {
    const status =
      err.code === 'source_conversation_not_found' || err.code === 'agent_not_found'
        ? 404
        : 403;
    return c.json({ error: err.message, code: err.code }, status);
  }
  if (isRepoError(err)) {
    return c.json(
      { error: err.message, code: err.code },
      repoErrorStatusMap[err.code] ?? 400,
    );
  }
  return null;
}

function conversationMessageServiceErrorResponse(
  c: Context,
  err: unknown,
): Response | null {
  if (err instanceof ConversationError) {
    const status = err.code === 'conversation_not_found' ? 404 : 409;
    return c.json({ error: err.message, code: err.code }, status);
  }
  if (err instanceof MessageActorError) {
    const status = err.code === 'agent_not_found' ? 404 : 403;
    return c.json({ error: err.message, code: err.code }, status);
  }
  if (err instanceof TargetError) {
    const status = err.code === 'thread_not_found' ? 404 : err.code === 'target_closed' || err.code === 'target_archived' ? 409 : 400;
    return c.json({ error: err.message, code: err.code }, status);
  }
  if (err instanceof PolicyError) {
    return c.json({ error: err.message, code: err.code }, 400);
  }
  if (err instanceof MessageAttachmentError) {
    return c.json(
      {
        error: err.message,
        code: err.code,
        ...(err.attachmentId ? { attachment_id: err.attachmentId } : {}),
      },
      400,
    );
  }
  return null;
}

function threadServiceErrorResponse(c: Context, err: unknown): Response | null {
  if (err instanceof ThreadMessageError) {
    return c.json({ error: err.message, code: err.code }, 404);
  }
  if (err instanceof ThreadParentError) {
    const status = err.code === 'parent_not_found' ? 404 : 409;
    return c.json({ error: err.message, code: err.code }, status);
  }
  if (err instanceof ThreadMembershipError) {
    return c.json(
      {
        error: err.message,
        code: err.code,
        ...(err.agentId ? { agent_id: err.agentId } : {}),
      },
      400,
    );
  }
  if (err instanceof ThreadActorError) {
    const status = err.code === 'agent_not_found' ? 404 : 403;
    return c.json({ error: err.message, code: err.code }, status);
  }
  if (err instanceof SeedAgentError) {
    return c.json({ error: err.message, code: err.code }, 404);
  }
  if (err instanceof ThreadError) {
    const status = err.code === 'thread_not_found' ? 404 : 409;
    return c.json({ error: err.message, code: err.code }, status);
  }
  if (isRepoError(err)) {
    return c.json(
      { error: err.message, code: err.code },
      repoErrorStatusMap[err.code] ?? 400,
    );
  }
  return null;
}

function resolveViewerUserId(c: Context, ctx: BackendContext): string | null {
  const user = getUserPrincipal(c);
  return user.userId || ctx.serverConfig.user_id || null;
}

function requireViewerUserId(c: Context, ctx: BackendContext): string | Response {
  const viewerUserId = resolveViewerUserId(c, ctx);
  if (!viewerUserId) {
    return c.json({ error: 'viewer user id required' }, 400);
  }
  return viewerUserId;
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
    `This is your first onboarding message in this workspace. Before replying, read the seeded onboarding guide note for internal guidance; do not mention internal file paths unless the user asks.`,
    `Send one short greeting: name yourself, state your current workspace role briefly (or say it is not defined yet), and ask what the user wants you to mainly do here (architecture, implementation, review, testing, or research are all valid).`,
  ].join('\n');
}

const SLOW_REQUEST_MS = 500;
const DIAGNOSTIC_REQUEST_MS = 100;
const SLOW_ROUTE_SPAN_MS = 100;
let apiRequestSequence = 0;

function installApiTimingMiddleware(app: Hono<AppEnv>, ctx: BackendContext): void {
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
  if (path === apiPaths.messageUnreadSummary) {
    return true;
  }
  if (/^\/api\/workspaces\/[^/]+\/channels(\/archived)?$/.test(path)) return true;
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

export function createApiRouter(ctx: BackendContext): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  installApiTimingMiddleware(app, ctx);
  installPublicBearerMiddleware(app, ctx, {
    // Liveness probe stays open so a process supervisor can health-check
    // without holding the auth token.
    allowlist: [apiPaths.health],
  });
  installPublicPrincipalMiddleware(app, ctx);
  const hosts = new HostRepo(ctx.db);
  const agents = new AgentRepo(ctx.db);
  const workspaces = new WorkspaceRepo(ctx.db, { workspacesRoot: ctx.workspacesRoot });
  const conversations = new ConversationRepo(ctx.db);
  const messages = new MessageRepo(ctx.db);
  const attachments = new AttachmentRepo(ctx.db);
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
    c.json({
      workspaces: workspaces
        .list()
        .filter(workspace => canViewWorkspace(ctx, getUserPrincipal(c), workspace.id)),
    }),
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
    if (!workspace) {
      return c.json({ error: 'workspace not found' }, 404);
    }
    if (!canViewWorkspace(ctx, getUserPrincipal(c), workspace.id)) {
      return c.json({ error: 'forbidden' }, 403);
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
    if (!canMutateWorkspace(ctx, getUserPrincipal(c), workspace.id)) {
      return c.json({ error: 'forbidden' }, 403);
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
      for (const channel of conversations.listAllChannelsForWorkspace(workspace.id)) {
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
    if (!canMutateWorkspace(ctx, getUserPrincipal(c), workspace.id)) {
      return c.json({ error: 'forbidden' }, 403);
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
    if (!canMutateWorkspace(ctx, getUserPrincipal(c), workspace.id)) {
      return c.json({ error: 'forbidden' }, 403);
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
    // Sweep physical attachment blobs for every top-level channel before
    // dropping the workspace. attachments.channel_id only points at
    // channel/dm_channel rows (threads upload via parent), so iterate
    // those — DB rows go via CASCADE, blobs need an explicit delete.
    for (const conversation of workspaceConversations) {
      if (conversation.kind === 'channel' || conversation.kind === 'dm_channel') {
        await ctx.attachmentService
          .sweepForChannel(conversation.id)
          .catch(err =>
            ctx.logger.warn(
              { workspaceId: workspace.id, conversationId: conversation.id, err },
              'delete workspace: attachment sweep failed (continuing)',
            ),
          );
      }
    }
    workspaces.delete(workspace.id);
    return c.body(null, 204);
  });

  app.get(apiPaths.workspaceChannels(':id'), c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'workspace id required' }, 400);
    const workspace = workspaces.get(id);
    if (!workspace) {
      return c.json({ error: 'workspace not found' }, 404);
    }
    if (!canViewWorkspace(ctx, getUserPrincipal(c), workspace.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const channels =
      workspace.workspace_kind === 'regular'
        ? timedRouteSpan(
            ctx,
            'workspace.channels.list_active',
            { workspaceId: workspace.id },
            () => conversations.listActiveChannelsForWorkspace(workspace.id),
            result => ({ channelCount: result.length }),
          )
        : timedRouteSpan(
            ctx,
            'workspace.dm_channel.list',
            { workspaceId: workspace.id },
            () => conversations.listDmChannelsForWorkspace(workspace.id),
            result => ({ channelCount: result.length }),
          );
    // Active endpoint only returns threads whose parent is also active —
    // the response is a self-contained tree, no orphan threads.
    const threads =
      workspace.workspace_kind === 'regular'
        ? timedRouteSpan(
            ctx,
            'workspace.threads.list_active',
            { workspaceId: workspace.id },
            () =>
              conversations.listThreadsForWorkspace(workspace.id, {
                parentArchived: false,
              }),
            result => ({ threadCount: result.length }),
          )
        : timedRouteSpan(
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

  app.get(apiPaths.workspaceArchivedChannels(':id'), c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'workspace id required' }, 400);
    const workspace = workspaces.get(id);
    if (!workspace) {
      return c.json({ error: 'workspace not found' }, 404);
    }
    if (!canViewWorkspace(ctx, getUserPrincipal(c), workspace.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    // agent_home workspaces don't support channel archive (their only
    // conversation is the dm_channel). Return an empty tree so the
    // frontend can call this hook unconditionally.
    if (workspace.workspace_kind !== 'regular') {
      return c.json({ channels: [], threads: [] });
    }
    const channels = timedRouteSpan(
      ctx,
      'workspace.channels.list_archived',
      { workspaceId: workspace.id },
      () => conversations.listArchivedChannelsForWorkspace(workspace.id),
      result => ({ channelCount: result.length }),
    );
    const threads = timedRouteSpan(
      ctx,
      'workspace.threads.list_archived',
      { workspaceId: workspace.id },
      () =>
        conversations.listThreadsForWorkspace(workspace.id, {
          parentArchived: true,
        }),
      result => ({ threadCount: result.length }),
    );
    return c.json({ channels, threads });
  });

  app.get(apiPaths.archivedChannels, c => {
    const principal = getUserPrincipal(c);
    const parsed = ArchivedChannelsQueryInputSchema.safeParse({
      workspace_id: c.req.query('workspace_id'),
      since: c.req.query('since'),
    });
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    if (
      parsed.data.workspace_id !== undefined &&
      !canViewWorkspace(ctx, principal, parsed.data.workspace_id)
    ) {
      // Mirror the workspace-scoped endpoint: 404 when the workspace
      // doesn't exist, 403 when the caller can't see it. v1 user can
      // see every workspace, so this is mostly future-proofing.
      const exists = workspaces.get(parsed.data.workspace_id);
      return c.json(
        { error: exists ? 'forbidden' : 'workspace not found' },
        exists ? 403 : 404,
      );
    }
    const rows = timedRouteSpan(
      ctx,
      'archived_channels.list',
      {
        workspaceFilter: parsed.data.workspace_id ?? null,
        since: parsed.data.since ?? null,
      },
      () =>
        conversations.listArchivedChannelsAggregate({
          workspaceId: parsed.data.workspace_id,
          since: parsed.data.since,
        }),
      result => ({ rowCount: result.length }),
    );
    // v1 user can view every workspace, so we don't need to filter `rows`
    // here. Once a real workspace ACL exists this filter will be the
    // single chokepoint that enforces it.
    return c.json({ channels: rows });
  });

  app.post(apiPaths.workspaceChannels(':id'), async c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'workspace id required' }, 400);
    const body = await c.req.json().catch(() => ({}));
    const parsed = CreateConversationChannelInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const workspace = workspaces.get(id);
    if (!workspace) {
      return c.json({ error: 'workspace not found' }, 404);
    }
    if (!canMutateWorkspace(ctx, getUserPrincipal(c), workspace.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    if (workspace.workspace_kind === 'agent_home') {
      if (parsed.data.member_agent_ids.length > 0) {
        return c.json(
          { error: 'agent_home channels always use the home owner as member' },
          400,
        );
      }
      if (!workspace.owner_agent_id) {
        return c.json({ error: 'agent_home workspace missing owner' }, 500);
      }
      const owner = agents.get(workspace.owner_agent_id);
      if (!owner) return c.json({ error: 'agent_home owner not found' }, 404);
      const channel = ctx.db.transaction(() => {
        const dm = conversations.insertDmChannel({
          workspaceId: workspace.id,
          workspacePath: workspace.workspace_path,
          title: parsed.data.title,
          agentId: owner.id,
        });
        conversations.addAgent(dm.id, owner.id);
        return dm;
      })();
      ctx.events.publishToScope(`workspace:${workspace.id}`, 'workspace_channels_changed', {
        workspace_id: workspace.id,
        channel_id: channel.id,
      });
      return c.json({ channel }, 201);
    }
    try {
      const result = await ctx.channelService.createChannel({
        workspaceId: id,
        title: parsed.data.title,
        memberAgentIds: parsed.data.member_agent_ids,
        actor: getUserPrincipal(c),
      });
      return c.json({ channel: result.channel }, 201);
    } catch (err) {
      const mapped = channelServiceErrorResponse(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  app.get(apiPaths.workspaceMembers(':id'), c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'workspace id required' }, 400);
    const workspace = workspaces.get(id);
    if (!workspace) return c.json({ error: 'workspace not found' }, 404);
    if (!canViewWorkspace(ctx, getUserPrincipal(c), workspace.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    if (workspace.workspace_kind === 'agent_home') {
      return c.json({ members: [] });
    }
    return c.json({ members: workspaces.listMembers(workspace.id) });
  });

  app.post(apiPaths.workspaceMembers(':id'), async c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'workspace id required' }, 400);
    const workspace = workspaces.get(id);
    if (!workspace || workspace.workspace_kind !== 'regular') {
      return c.json({ error: 'workspace not found' }, 404);
    }
    if (!canManageMembers(ctx, getUserPrincipal(c), workspace.id)) {
      return c.json({ error: 'forbidden' }, 403);
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
    if (!workspace || workspace.workspace_kind !== 'regular') return c.body(null, 204);
    if (!canManageMembers(ctx, getUserPrincipal(c), workspace.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
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

  app.get('/api/workspaces/:id/message-unread', c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'workspace id required' }, 400);
    const workspace = workspaces.get(id);
    if (!workspace) {
      return c.json({ error: 'workspace not found' }, 404);
    }
    if (!canViewWorkspace(ctx, getUserPrincipal(c), workspace.id)) {
      return c.json({ error: 'forbidden' }, 403);
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
    if (!canViewOwnedState(ctx, getUserPrincipal(c), viewerUserId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
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
    if (!canViewConversation(ctx, getUserPrincipal(c), channel.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const viewerUserId = requireViewerUserId(c, ctx);
    if (typeof viewerUserId !== 'string') return viewerUserId;
    if (!canViewOwnedState(ctx, getUserPrincipal(c), viewerUserId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
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
    if (!canViewConversation(ctx, getUserPrincipal(c), channel.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
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
    if (!canViewConversation(ctx, getUserPrincipal(c), channel.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    return c.json({ channel });
  });

  app.get(apiPaths.thread(':id'), c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'thread id required' }, 400);
    const thread = conversations.getThread(id);
    if (!thread) return c.json({ error: 'thread not found' }, 404);
    if (!canViewConversation(ctx, getUserPrincipal(c), thread.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    return c.json({ thread });
  });

  app.get(apiPaths.threadMessages(':id'), c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'thread id required' }, 400);
    const thread = conversations.getThread(id);
    if (!thread) return c.json({ error: 'thread not found' }, 404);
    if (!canViewConversation(ctx, getUserPrincipal(c), thread.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
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
    if (!canViewConversation(ctx, getUserPrincipal(c), channel.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
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
    if (!canViewConversation(ctx, getUserPrincipal(c), thread.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const threadAgents = timedRouteSpan(
      ctx,
      'conversation.agents.list',
      { conversationId: thread.id, kind: thread.kind },
      () => conversations.listAgents(thread.id),
      result => ({ agentCount: result.length }),
    );
    return c.json({ agents: threadAgents });
  });

  app.post('/api/channels/:id/pin', async c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'channel id required' }, 400);
    const channel = conversations.getChannelLike(id);
    if (!channel) return c.json({ error: 'channel not found' }, 404);
    if (!canMutateWorkspace(ctx, getUserPrincipal(c), channel.workspace_id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    try {
      const result = await ctx.channelService.setPinned({ channelId: id, pinned: true });
      return c.json({ channel: result.channel });
    } catch (err) {
      const mapped = channelServiceErrorResponse(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  app.delete('/api/channels/:id/pin', async c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'channel id required' }, 400);
    const channel = conversations.getChannelLike(id);
    if (!channel) return c.json({ error: 'channel not found' }, 404);
    if (!canMutateWorkspace(ctx, getUserPrincipal(c), channel.workspace_id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    try {
      const result = await ctx.channelService.setPinned({ channelId: id, pinned: false });
      return c.json({ channel: result.channel });
    } catch (err) {
      const mapped = channelServiceErrorResponse(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  app.patch(apiPaths.channelArchive(':id'), async c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'channel id required' }, 400);
    const conversation = conversations.get(id);
    if (!conversation) return c.json({ error: 'channel not found' }, 404);
    if (!canMutateWorkspace(ctx, getUserPrincipal(c), conversation.workspace_id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = ArchiveChannelInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    try {
      const result = await ctx.channelService.setArchived({
        channelId: id,
        archived: parsed.data.archived,
      });
      return c.json({ channel: result.channel });
    } catch (err) {
      const mapped = channelServiceErrorResponse(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  app.get(apiPaths.channelAgentRunStates(':id'), c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'channel id required' }, 400);
    const channel = conversations.getChannelLike(id);
    if (!channel) return c.json({ error: 'channel not found' }, 404);
    if (!canViewConversation(ctx, getUserPrincipal(c), channel.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
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
    if (!canViewConversation(ctx, getUserPrincipal(c), thread.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
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
    if (!canPostToConversation(ctx, getUserPrincipal(c), channel.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = SendMessageInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    try {
      const result = await ctx.conversationMessageService.sendMessage({
        conversationId: channel.id,
        actor: getUserPrincipal(c),
        content: parsed.data.content,
        attachmentIds: parsed.data.attachment_ids ?? [],
      });
      return c.json({ message: result.message }, 201);
    } catch (err) {
      const mapped = conversationMessageServiceErrorResponse(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  app.post(apiPaths.threadMessages(':id'), async c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'thread id required' }, 400);
    const thread = conversations.getThread(id);
    if (!thread) return c.json({ error: 'thread not found' }, 404);
    if (!canPostToConversation(ctx, getUserPrincipal(c), thread.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = SendMessageInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    try {
      const result = await ctx.conversationMessageService.sendMessage({
        conversationId: thread.id,
        actor: getUserPrincipal(c),
        content: parsed.data.content,
        attachmentIds: parsed.data.attachment_ids ?? [],
      });
      return c.json({ message: result.message }, 201);
    } catch (err) {
      const mapped = conversationMessageServiceErrorResponse(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  app.post(apiPaths.channelMarkRead(':id'), async c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'channel id required' }, 400);
    const channel = conversations.getChannelLike(id);
    if (!channel) return c.json({ error: 'channel not found' }, 404);
    if (!canViewConversation(ctx, getUserPrincipal(c), channel.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    return markConversationRead(channel.id, c);
  });

  app.post(apiPaths.threadMarkRead(':id'), async c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'thread id required' }, 400);
    const thread = conversations.getThread(id);
    if (!thread) return c.json({ error: 'thread not found' }, 404);
    if (!canViewConversation(ctx, getUserPrincipal(c), thread.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    return markConversationRead(thread.id, c);
  });

  app.get(apiPaths.channelThreads(':id'), c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'channel id required' }, 400);
    const channel = conversations.getChannelLike(id);
    if (!channel) return c.json({ error: 'channel not found' }, 404);
    if (!canViewConversation(ctx, getUserPrincipal(c), channel.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
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

  // ── Attachments ──────────────────────────────────────────────────
  // Upload via channel/thread context so the server resolves the access
  // boundary; clients never specify channel_id directly. Download is
  // by id — auth is bearer (renderer) or v1-permissive (TODO when DM
  // membership is enforceable per blob).

  app.post(apiPaths.channelAttachments(':id'), async c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'channel id required' }, 400);
    const channel = conversations.getChannelLike(id);
    if (!channel) return c.json({ error: 'channel not found' }, 404);
    const viewerUserId = requireViewerUserId(c, ctx);
    if (typeof viewerUserId !== 'string') return viewerUserId;
    if (!canPostToConversation(ctx, getUserPrincipal(c), channel.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    return uploadAttachment(ctx, c, channel.id, 'user', viewerUserId);
  });

  app.post(apiPaths.threadAttachments(':id'), async c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'thread id required' }, 400);
    const thread = conversations.getThread(id);
    if (!thread) return c.json({ error: 'thread not found' }, 404);
    const viewerUserId = requireViewerUserId(c, ctx);
    if (typeof viewerUserId !== 'string') return viewerUserId;
    if (!canPostToConversation(ctx, getUserPrincipal(c), thread.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    return uploadAttachment(ctx, c, thread.id, 'user', viewerUserId);
  });

  app.get(apiPaths.attachment(':id'), async c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'attachment id required' }, 400);
    const viewerUserId = requireViewerUserId(c, ctx);
    if (typeof viewerUserId !== 'string') return viewerUserId;
    const principal = getUserPrincipal(c);
    const response = await ctx.attachmentService.serveForViewer(id, row =>
      canViewAttachment(ctx, principal, row),
    );
    if (!response) return c.json({ error: 'attachment not found' }, 404);
    return response;
  });

  app.delete(apiPaths.attachment(':id'), async c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'attachment id required' }, 400);
    const viewerUserId = requireViewerUserId(c, ctx);
    if (typeof viewerUserId !== 'string') return viewerUserId;
    const attachment = attachments.getById(id);
    if (!attachment) return c.json({ error: 'attachment not found' }, 404);
    if (!canDeleteAttachment(ctx, getUserPrincipal(c), attachment)) {
      return c.json({ error: 'cannot delete attachment owned by another uploader' }, 403);
    }
    const result = await ctx.attachmentService.deleteOrphan(id, {
      kind: 'user',
      userId: viewerUserId,
    });
    if (result.ok) return c.body(null, 204);
    if (result.error === 'not_found') {
      return c.json({ error: 'attachment not found' }, 404);
    }
    if (result.error === 'forbidden') {
      return c.json({ error: 'cannot delete attachment owned by another uploader' }, 403);
    }
    // 'in_use' — at least one persisted message still references this id.
    return c.json(
      { error: 'attachment is referenced by a message and cannot be deleted' },
      409,
    );
  });

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
    const message = messages.getById(messageId);
    if (!message) return c.json({ error: 'message not found' }, 404);
    if (!canPostToConversation(ctx, getUserPrincipal(c), message.conversation_id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    try {
      const result = await ctx.threadService.createThreadFromMessage({
        messageId,
        actor: getUserPrincipal(c),
      });
      return c.json(
        { thread_id: result.thread.id, thread: result.thread, reused: result.reused },
        result.reused ? 200 : 201,
      );
    } catch (err) {
      const mapped = threadServiceErrorResponse(c, err);
      if (mapped) return mapped;
      throw err;
    }
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

  async function markConversationRead(
    conversationId: string,
    c: Context,
  ): Promise<Response> {
    const viewerUserId = requireViewerUserId(c, ctx);
    if (typeof viewerUserId !== 'string') return viewerUserId;
    if (!canViewOwnedState(ctx, getUserPrincipal(c), viewerUserId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
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
    if (!canPostToConversation(ctx, getUserPrincipal(c), conversationId)) {
      return c.json({ error: 'forbidden' }, 403);
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
    if (!canPostToConversation(ctx, getUserPrincipal(c), conversationId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
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

  function createAgentWithHome(input: CreateAgentInput) {
    return ctx.db.transaction(() => {
      const agent = agents.create(input, localHost.id);
      const agentL1Dir = join(ctx.silverhandDir, 'agents', agent.id);
      const home = workspaces.insertAgentHome({
        agent,
        workspacePath: agentL1Dir,
      });
      const dm = conversations.insertDmChannel({
        workspaceId: home.id,
        workspacePath: agentL1Dir,
        title: 'Onboarding',
        agentId: agent.id,
      });
      conversations.addAgent(dm.id, agent.id);
      const onboardingMsg = messages.insertForConversation({
        conversationId: dm.id,
        fromKind: 'system',
        content: [
          `You (@${agent.name}) are now in your personal DM with the user.`,
          `Before replying, read the seeded onboarding guide note for internal guidance; do not mention internal file paths unless the user asks.`,
          `Send one short greeting: say hi by name, state your current global role briefly (or say it is not defined yet), and ask what role the user would like you to play.`,
        ].join('\n'),
        metadata: { subtype: 'onboarding' },
      });
      return { agent, home, dm, onboardingMsg, agentL1Dir };
    })();
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
    const { agent, dm, onboardingMsg, agentL1Dir } = createAgentWithHome(parsed.data);
    await ensureAgentL1Dir(agentL1Dir);
    await ctx.conversationManager.deliverMessage(dm.id, agent.id, onboardingMsg.id);
    ctx.conversationManager
      .start(dm.id, agent.id)
      .catch(err =>
        ctx.logger.error(
          { conversationId: dm.id, agentId: agent.id, err },
          'dm onboarding spawn failed',
        ),
      );
    return c.json({ agent, dm_channel_id: dm.id }, 201);
  });

  app.get('/api/agents/:id', c => {
    const agent = agents.get(c.req.param('id'));
    if (!agent) return c.json({ error: 'agent not found' }, 404);
    return c.json({ agent });
  });

  // PATCH — partial update. `name` and `host_id` are intentionally not
  // patchable here: `name` is the immutable handle (renaming would
  // ripple through the agent_home workspace, every @mention in history,
  // every L2 file path), and host swap is out of v1 scope. Runtime change is
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
    for (const ws of impact.regular_memberships) {
      const workspace = workspaces.get(ws.id);
      if (!workspace) continue;
      for (const conversation of conversations.list()) {
        if (conversation.workspace_id === workspace.id) {
          conversations.removeAgent(conversation.id, id);
        }
      }
      workspaces.removeMember(workspace.id, id);
    }

    // 3. Sweep DM blobs before deleting the agent. DB rows cascade through
    //    agent -> agent_home -> conversations, but physical files need an
    //    explicit pass. Thread uploads are channel-scoped to the dm channel.
    const dmChannels = impact.owned_home
      ? conversations.listDmChannelsForWorkspace(impact.owned_home.id)
      : [];
    for (const dm of dmChannels) {
      await ctx.attachmentService.sweepForChannel(dm.id).catch(err =>
        ctx.logger.warn(
          { agentId: id, conversationId: dm.id, err },
          'delete agent: DM attachment sweep failed (continuing)',
        ),
      );
    }

    // 4. Drop the agent. owner_agent_id ON DELETE CASCADE removes its
    //    agent_home subtree; regular conversation history keeps deleted
    //    sender rows via SET NULL on messages.from_agent_id.
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
        regularWorkspaces: impact.regular_memberships.length,
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
    const ownedHome = workspaces.getAgentHomeByOwner(agentId);
    const regulars = workspaces
      .listForAgent(agentId)
      .filter(w => w.workspace_kind === 'regular');
    const dmChannels = ownedHome
      ? conversations.listDmChannelsForWorkspace(ownedHome.id)
      : conversations.listDmChannelsForAgent(agentId);
    const dm = dmChannels[0] ?? null;

    let dmChannel: AgentDeleteImpactDto['dm_channel'] = null;
    let attachmentsCount = 0;
    if (dm) {
      const rootIds = dmChannels.map(c => c.id);
      const threadIds = rootIds.flatMap(channelId =>
        conversations.listThreadsForChannel(channelId).map(t => t.id),
      );
      const ids = [...rootIds, ...threadIds];
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
      attachmentsCount =
        ctx.db
          .prepare<string[], { c: number }>(
            `SELECT COUNT(*) AS c
               FROM attachments
              WHERE channel_id IN (${rootIds.map(() => '?').join(',')})`,
          )
          .get(...rootIds)?.c ?? 0;
      dmChannel = {
        id: dm.id,
        name: dm.title,
        conversation_count: ids.length,
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
      regular_memberships: regulars.map(c => ({ id: c.id, name: c.name })),
      owned_home: ownedHome,
      attachments_count: attachmentsCount,
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
  app.get(apiPaths.tasks, c => {
    const parsed = ListTasksQuerySchema.safeParse({
      workspace_id: c.req.query('workspace_id') || undefined,
      conversation_id: c.req.query('conversation_id') || undefined,
      status: c.req.query('status') || undefined,
    });
    if (!parsed.success) {
      return c.json({ error: 'invalid query', issues: parsed.error.issues }, 400);
    }
    return c.json({
      tasks: ctx.taskService.list({
        actor: getUserPrincipal(c),
        workspaceId: parsed.data.workspace_id,
        conversationId: parsed.data.conversation_id,
        status: parsed.data.status,
      }),
    });
  });

  app.post('/api/tasks/:messageId/claim', async c => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = HumanClaimTaskInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const result = await ctx.taskService.claimTask({
      actor: getUserPrincipal(c),
      by: { messageId: c.req.param('messageId') },
      assignee: parsed.data.agent_id ? { agentId: parsed.data.agent_id } : undefined,
    });
    return c.json(result, result.success ? 200 : 409);
  });

  app.post('/api/tasks/:messageId/unclaim', async c => {
    const result = await ctx.taskService.unclaimTask({
      actor: getUserPrincipal(c),
      by: { messageId: c.req.param('messageId') },
    });
    return c.json(result, result.success ? 200 : 409);
  });

  app.post('/api/tasks/:messageId/status', async c => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = HumanUpdateTaskStatusInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const result = await ctx.taskService.updateStatus({
      actor: getUserPrincipal(c),
      by: { messageId: c.req.param('messageId') },
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

export function createInternalRouter(ctx: BackendContext): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
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
  installInternalPrincipalMiddleware(app, { agents, conversations });

  // ── canonical conversation-scoped MCP routes ───────────────────
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
    const principal = getAgentPrincipal(c);
    if (!canPostToConversation(ctx, principal, principal.conversationId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    try {
      const result = await ctx.conversationMessageService.sendMessage({
        conversationId: principal.conversationId,
        actor: principal,
        content: parsed.data.content,
        attachmentIds: parsed.data.attachment_ids ?? [],
        target: parsed.data.target,
      });
      return c.json({ message_id: result.message.id });
    } catch (err) {
      const mapped = conversationMessageServiceErrorResponse(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  app.post(internalPaths.agentCreateThread(':cid', ':aid'), async c => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = AgentSpawnChildInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const principal = getAgentPrincipal(c);
    if (!canPostToConversation(ctx, principal, principal.conversationId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    try {
      const result = await ctx.threadService.createThreadFromAgent({
        parentConversationId: principal.conversationId,
        actor: principal,
        title: parsed.data.title,
        contextSummary: parsed.data.context_summary,
        initialPrompt: parsed.data.initial_prompt,
        requestedMembers: parsed.data.members,
      });
      return c.json({ thread_id: result.thread.id });
    } catch (err) {
      const mapped = threadServiceErrorResponse(c, err);
      if (mapped) return mapped;
      throw err;
    }
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

  app.post(internalPaths.agentCloseThread(':cid', ':aid'), async c => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = AgentCloseThreadInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const principal = getAgentPrincipal(c);
    if (!canPostToConversation(ctx, principal, principal.conversationId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    try {
      const result = await ctx.threadService.closeThread({
        threadId: principal.conversationId,
        actor: principal,
        summary: parsed.data.summary,
        postedToParent: parsed.data.posted_to_parent ?? false,
      });
      return c.json({ thread: result.thread });
    } catch (err) {
      const mapped = threadServiceErrorResponse(c, err);
      if (mapped) return mapped;
      throw err;
    }
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
      workspace_id: c.req.query('workspace_id') || undefined,
      conversation_id: c.req.query('conversation_id') || undefined,
      status: c.req.query('status') || undefined,
    });
    if (!parsed.success) {
      return c.json({ error: 'invalid query', issues: parsed.error.issues }, 400);
    }
    const principal = getAgentPrincipal(c);
    if (!canViewConversation(ctx, principal, principal.conversationId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    return c.json({
      tasks: ctx.taskService.list({
        actor: principal,
        conversationId: parsed.data.conversation_id,
        status: parsed.data.status,
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
    const principal = getAgentPrincipal(c);
    if (!canPostToConversation(ctx, principal, principal.conversationId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const result = await ctx.taskService.createTasks({
      conversationId: principal.conversationId,
      actor: principal,
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
    const actor = getAgentPrincipal(c);
    if (!canPostToConversation(ctx, actor, actor.conversationId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const results = [];
    for (const taskNumber of parsed.data.task_numbers ?? []) {
      results.push(await ctx.taskService.claimTask({ actor, by: { taskNumber } }));
    }
    for (const messageId of parsed.data.message_ids ?? []) {
      results.push(await ctx.taskService.claimTask({ actor, by: { messageId } }));
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
    const result = await ctx.taskService.unclaimTask({
      actor: principal,
      by: { taskNumber: parsed.data.task_number },
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
    const result = await ctx.taskService.updateStatus({
      actor: principal,
      by: { taskNumber: parsed.data.task_number },
      status: parsed.data.status,
    });
    return c.json(result);
  });

  // ── Agent-initiated attachments (chat-bridge → backend) ────────────
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

  return app;
}

/** Parse multipart/form-data and hand the file to AttachmentService.
 *  Shared between public (channel/thread) and internal (agent) upload
 *  routes so the response shape and error mapping stay identical. */
async function uploadAttachment(
  ctx: BackendContext,
  c: Context,
  sourceConversationId: string,
  createdByKind: 'user' | 'agent',
  createdById: string,
): Promise<Response> {
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch (err) {
    ctx.logger.warn(
      { sourceConversationId, err },
      'api: attachment upload — multipart parse failed',
    );
    return c.json({ error: 'multipart/form-data required' }, 400);
  }
  const file = form.get('file');
  if (!(file instanceof File)) {
    return c.json({ error: 'file field required' }, 400);
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  try {
    const dto = await ctx.attachmentService.upload({
      sourceConversationId,
      filename: file.name,
      contentType: file.type || null,
      buffer,
      createdByKind,
      createdById,
    });
    return c.json(dto, 201);
  } catch (err) {
    if (err instanceof AttachmentRejection) {
      const status = err.failure.kind === 'too_large' ? 413 : 400;
      return c.json({ error: err.message, code: err.failure.kind }, status);
    }
    throw err;
  }
}
