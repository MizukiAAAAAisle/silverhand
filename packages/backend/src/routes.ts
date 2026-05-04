import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import {
  apiPaths,
  AddChannelMemberInputSchema,
  AgentCloseSessionInputSchema,
  AgentCreateSessionInputSchema,
  AgentSendMessageInputSchema,
  AgentSpawnChildInputSchema,
  ClaimTasksInputSchema,
  CloseSessionInputSchema,
  CreateAgentInputSchema,
  CreateChannelInputSchema,
  CreateSessionInputSchema,
  CreateTasksInputSchema,
  DeleteAgentInputSchema,
  HumanClaimTaskInputSchema,
  HumanUpdateTaskStatusInputSchema,
  ListTasksQuerySchema,
  MarkSessionReadInputSchema,
  MarkNotificationsReadInputSchema,
  SearchQueryInputSchema,
  SendMessageInputSchema,
  UnclaimTaskInputSchema,
  UpdateAgentInputSchema,
  UpdateChannelInputSchema,
  ArchiveChannelInputSchema,
  UpdateTaskStatusInputSchema,
  type AgentDeleteImpactDto,
  type SendMessageTarget,
} from '@silverhand/shared';
import type { BackendContext } from './context.js';
import { ChannelRepo } from './repos/channel-repo.js';
import { AgentRepo } from './repos/agent-repo.js';
import { HostRepo } from './repos/host-repo.js';
import { InboxRepo } from './repos/inbox-repo.js';
import { MembershipRepo } from './repos/membership-repo.js';
import { MessageRepo } from './repos/message-repo.js';
import { NotificationRepo } from './repos/notification-repo.js';
import { SavedMessageRepo } from './repos/saved-message-repo.js';
import { SearchRepo } from './repos/search-repo.js';
import { SessionReadRepo } from './repos/session-read-repo.js';
import { SessionRepo, type RepoError } from './repos/session-repo.js';
import { SettingsRepo, SETTINGS_KEYS } from './repos/settings-repo.js';
import { WorkspaceRepo } from './repos/workspace-repo.js';
import { ConversationRepo } from './repos/conversation-repo.js';
import { provisionChannel, provisionDmChannel, joinChannel, leaveChannel, deleteChannel } from './provision.js';
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

export function createApiRouter(ctx: BackendContext): Hono {
  const app = new Hono();
  const hosts = new HostRepo(ctx.db);
  const agents = new AgentRepo(ctx.db);
  const channels = new ChannelRepo(ctx.db, { workspacesRoot: ctx.workspacesRoot });
  const members = new MembershipRepo(ctx.db);
  const sessions = new SessionRepo(ctx.db);
  const workspaces = new WorkspaceRepo(ctx.db, { workspacesRoot: ctx.workspacesRoot });
  const conversations = new ConversationRepo(ctx.db);
  const messages = new MessageRepo(ctx.db);
  const saved = new SavedMessageRepo(ctx.db);
  const search = new SearchRepo(ctx.db);
  const settings = new SettingsRepo(ctx.db);
  const inboxes = new InboxRepo(ctx.db);
  const notifications = new NotificationRepo(ctx.db);
  const sessionReads = new SessionReadRepo(ctx.db);

  const localHost = hosts.ensureLocal();

  const provisionOpts = {
    silverhandDir: ctx.silverhandDir,
    workspacesRoot: ctx.workspacesRoot,
    localHostId: localHost.id,
    channels,
    members,
    sessions,
    messages,
    agents,
    sessionManager: ctx.sessionManager,
    logger: ctx.logger,
  };

  // ── Health / runtimes / hosts ────────────────────────────────────
  app.get(apiPaths.health, c =>
    c.json({ ok: true, mode: ctx.serverConfig.mode, ts: Date.now() }),
  );

  app.get(apiPaths.runtimes, async c => {
    const runtimes = await detectRuntimes();
    return c.json({ runtimes });
  });

  app.get(apiPaths.hosts, c => c.json({ hosts: hosts.list() }));

  // ── Workspaces / conversations (new naming model) ───────────────
  //
  // These endpoints are additive while the renderer is still on the
  // legacy channel/session routes. They read the shadow schema created
  // by migration 011 and enforce route kind guards so a thread id cannot
  // silently pass as a channel id.

  app.get(apiPaths.workspaces, c =>
    c.json({ workspaces: workspaces.list() }),
  );

  app.get(apiPaths.workspace(':id'), c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'workspace id required' }, 400);
    const workspace = workspaces.get(id);
    if (!workspace || workspace.workspace_kind !== 'regular') {
      return c.json({ error: 'workspace not found' }, 404);
    }
    return c.json({ workspace });
  });

  app.get(apiPaths.workspaceChannels(':id'), c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'workspace id required' }, 400);
    const workspace = workspaces.get(id);
    if (!workspace || workspace.workspace_kind !== 'regular') {
      return c.json({ error: 'workspace not found' }, 404);
    }
    return c.json({
      channels: conversations.listChannelsForWorkspace(workspace.id),
    });
  });

  app.get(apiPaths.workspaceDmChannels, c =>
    c.json({ dm_channels: conversations.listDmChannels() }),
  );

  app.get(apiPaths.conversationChannelMessages(':id'), c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'channel id required' }, 400);
    const channel = conversations.getChannel(id);
    if (!channel) return c.json({ error: 'channel not found' }, 404);
    const parsedLimit = Number(c.req.query('limit') ?? 200);
    const parsedBefore = c.req.query('before_seq');
    const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 500) : 200;
    const beforeSeq = parsedBefore ? Number(parsedBefore) : null;
    return c.json(messages.listWindowForSession(channel.id, { limit, beforeSeq }));
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
    return c.json(messages.listWindowForSession(thread.id, { limit, beforeSeq }));
  });

  app.get(apiPaths.conversationChannelAgents(':id'), c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'channel id required' }, 400);
    const channel = conversations.getChannel(id);
    if (!channel) return c.json({ error: 'channel not found' }, 404);
    return c.json({ agents: conversations.listAgents(channel.id) });
  });

  app.get(apiPaths.threadAgents(':id'), c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'thread id required' }, 400);
    const thread = conversations.getThread(id);
    if (!thread) return c.json({ error: 'thread not found' }, 404);
    return c.json({ agents: conversations.listAgents(thread.id) });
  });

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
    // Auto-create the agent's DM channel + onboarding session.
    const dm = await provisionDmChannel(agent, provisionOpts);
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
  // refused while any session_agent for this agent is starting/active
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
        .listRuntimeSessions(id)
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
    return c.json({ session_agents: agents.listRuntimeSessions(agent.id) });
  });

  // POST /stop — hard-stop every running session_agent for this
  // agent. Returns the count we actually attempted to stop. No-op
  // (200 with stopped: 0) when nothing is running.
  app.post('/api/agents/:id/stop', async c => {
    const id = c.req.param('id');
    const agent = agents.get(id);
    if (!agent) return c.json({ error: 'agent not found' }, 404);
    const live = agents
      .listRuntimeSessions(id)
      .filter(s => s.status === 'starting' || s.status === 'active');
    await Promise.all(
      live.map(s =>
        ctx.sessionManager.stop(s.session_id, id, 'hard').catch(err =>
          ctx.logger.warn(
            { sessionId: s.session_id, agentId: id, err },
            'agent stop: session stop failed',
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

    // 1. Hard-stop every running session_agent. Must precede any DB
    //    delete — once session_agents rows are gone, sessionManager
    //    can't look up handles by (sid, aid).
    for (const live of impact.running_session_agents) {
      await ctx.sessionManager
        .stop(live.session_id, id, 'hard')
        .catch(err =>
          ctx.logger.warn(
            { sessionId: live.session_id, agentId: id, err },
            'delete: stop failed (continuing)',
          ),
        );
    }

    // 2. leaveChannel for every non-DM channel — broadcasts "@xxx
    //    left", removes from session_agents, wipes L2 (no rejoin
    //    path after delete).
    for (const ch of impact.regular_channels) {
      await leaveChannel(ch.id, agent, provisionOpts, { wipeL2: true }).catch(err =>
        ctx.logger.warn({ channelId: ch.id, agentId: id, err }, 'delete: leave failed'),
      );
    }

    // 3. Drop the DM channel (CASCADEs its sessions/messages/etc).
    if (impact.dm_channel) channels.delete(impact.dm_channel.id);

    // 4. Drop the agent (CASCADEs remaining session_agents, inbox,
    //    channel_members; SET NULL on messages.from_agent_id).
    agents.delete(id);

    // 5. Wipe L1 — the agent's global memory/notes/system_prompt.
    await fs
      .rm(impact.l1_path, { recursive: true, force: true })
      .catch(err =>
        ctx.logger.warn({ agentId: id, l1: impact.l1_path, err }, 'delete: L1 rm failed'),
      );

    ctx.logger.info(
      {
        agentId: id,
        agentName: agent.name,
        dmChannelId: impact.dm_channel?.id ?? null,
        regularChannels: impact.regular_channels.length,
        stoppedSessions: impact.running_session_agents.length,
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
    const allChannels = members.listForAgent(agentId);
    const dm = allChannels.find(c => c.kind === 'dm') ?? null;
    const regulars = allChannels.filter(c => c.kind !== 'dm');

    let dmChannel: AgentDeleteImpactDto['dm_channel'] = null;
    if (dm) {
      const dmSessions = sessions.listForChannel(dm.id);
      const messageCount = dmSessions.reduce(
        (acc, s) =>
          acc +
          (ctx.db
            .prepare<[string], { c: number }>(
              'SELECT COUNT(*) AS c FROM messages WHERE session_id = ?',
            )
            .get(s.id)?.c ?? 0),
        0,
      );
      dmChannel = {
        id: dm.id,
        name: dm.name,
        session_count: dmSessions.length,
        message_count: messageCount,
      };
    }

    const runtimeSessions = agents.listRuntimeSessions(agentId);
    const running = runtimeSessions
      .filter(s => s.status === 'starting' || s.status === 'active')
      .map(s => ({
        session_id: s.session_id,
        channel_name: s.channel_name,
        session_title: s.session_title,
        status: s.status,
        pid: s.pid,
      }));

    const l1Path = join(ctx.silverhandDir, 'agents', agentId);
    const l2Paths = regulars.map(c =>
      join(c.workspace_path, '.silverhand', 'agents', agentId),
    );

    return {
      agent_id: agent.id,
      agent_name: agent.name,
      agent_display_name: agent.display_name,
      dm_channel: dmChannel,
      regular_channels: regulars.map(c => ({ id: c.id, name: c.name })),
      running_session_agents: running,
      pending_inbox_count: inboxes.countPendingForAgent(agentId),
      l1_path: l1Path,
      l2_paths: l2Paths,
    };
  }

  // ── Channels ─────────────────────────────────────────────────────
  app.get(apiPaths.channels, c => c.json({ channels: channels.list() }));

  app.post(apiPaths.channels, async c => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = CreateChannelInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    if (channels.getByName(parsed.data.name)) {
      return c.json({ error: 'channel name already exists' }, 409);
    }
    const result = await provisionChannel(parsed.data, provisionOpts);
    return c.json({ channel: result.channel, onboarding_session_id: result.onboardingSessionId }, 201);
  });

  app.delete('/api/channels/:id', async c => {
    await deleteChannel(c.req.param('id'), provisionOpts, { awaitCleanup: false });
    return c.body(null, 204);
  });

  // Rename. DM channels are named after their agent (`dm-<name>`) and
  // never get renamed via this path. On success, broadcasts a system
  // message into every open root session so live agents notice and can
  // update any references in their MEMORY.md the next time they edit.
  app.patch('/api/channels/:id', async c => {
    const channel = channels.get(c.req.param('id'));
    if (!channel) return c.json({ error: 'channel not found' }, 404);
    if (channel.kind === 'dm') {
      return c.json({ error: 'DM channels cannot be renamed' }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = UpdateChannelInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const newName = parsed.data.name;
    if (newName === channel.name) {
      return c.json({ channel });
    }
    const collision = channels.getByName(newName);
    if (collision && collision.id !== channel.id) {
      return c.json({ error: 'channel name already exists' }, 409);
    }

    const oldName = channel.name;
    const updated = channels.rename(channel.id, newName);
    if (!updated) return c.json({ error: 'rename failed' }, 500);

    // Broadcast a system message to every open root session — agents
    // get it as a normal incoming message and can update their MEMORY
    // references organically. Closed sessions are left alone (history).
    const rootOpenSessions = sessions
      .listForChannel(channel.id)
      .filter(s => s.parent_session_id === null && s.closed_at === null);
    for (const session of rootOpenSessions) {
      const announce = messages.insert({
        sessionId: session.id,
        fromKind: 'system',
        content:
          `This channel was renamed from #${oldName} to #${newName}. ` +
          `Update any references in your MEMORY.md when you next edit it.`,
        metadata: { subtype: 'rename', old_name: oldName, new_name: newName },
      });
      for (const sa of sessions.listAgents(session.id)) {
        await ctx.sessionManager.deliverMessage(session.id, sa.agent_id, announce.id);
      }
      ctx.events.publish(session.id, {
        kind: 'message',
        payload: { message: announce },
      });
    }

    ctx.logger.info(
      { channelId: channel.id, oldName, newName, sessionsBroadcast: rootOpenSessions.length },
      'api: channel renamed',
    );
    return c.json({ channel: updated });
  });

  // Archive / unarchive — soft visibility flag. Keeps the channel and all
  // its sessions intact; just hides it behind the renderer's "Archived"
  // group. Doesn't auto-stop running agents (user can do that explicitly
  // if they want to free resources). Reversible via the same endpoint
  // with `archived: false`.
  app.patch('/api/channels/:id/archive', async c => {
    const channel = channels.get(c.req.param('id'));
    if (!channel) return c.json({ error: 'channel not found' }, 404);
    const body = await c.req.json().catch(() => ({}));
    const parsed = ArchiveChannelInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const wantArchived = parsed.data.archived;
    const isArchived = channel.archived_at !== null;
    if (wantArchived === isArchived) {
      // No-op — same state. Return the current row so the client can
      // refresh its cache without hitting an error path.
      return c.json({ channel });
    }
    const updated = channels.setArchived(channel.id, wantArchived);
    if (!updated) return c.json({ error: 'archive update failed' }, 500);
    ctx.logger.info(
      { channelId: channel.id, archived: wantArchived },
      wantArchived ? 'api: channel archived' : 'api: channel unarchived',
    );
    return c.json({ channel: updated });
  });

  app.get('/api/channels/:id/members', c => {
    const channel = channels.get(c.req.param('id'));
    if (!channel) return c.json({ error: 'channel not found' }, 404);
    return c.json({ members: members.listForChannel(channel.id) });
  });

  app.post('/api/channels/:id/members', async c => {
    const channel = channels.get(c.req.param('id'));
    if (!channel) return c.json({ error: 'channel not found' }, 404);
    const body = await c.req.json().catch(() => ({}));
    const parsed = AddChannelMemberInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const agent = agents.get(parsed.data.agent_id);
    if (!agent) return c.json({ error: 'agent not found' }, 404);
    const { member, sessionsUpdated } = await joinChannel(channel.id, agent, provisionOpts);
    ctx.logger.info(
      { channelId: channel.id, agentId: agent.id, sessionsUpdated },
      'api: channel member added',
    );
    return c.json({ member, sessions_updated: sessionsUpdated }, 201);
  });

  app.delete('/api/channels/:id/members/:agentId', async c => {
    const channel = channels.get(c.req.param('id'));
    if (!channel) return c.json({ error: 'channel not found' }, 404);
    const agent = agents.get(c.req.param('agentId'));
    if (!agent) return c.json({ error: 'agent not found' }, 404);
    const { sessionsUpdated } = await leaveChannel(channel.id, agent, provisionOpts);
    ctx.logger.info(
      { channelId: channel.id, agentId: agent.id, sessionsUpdated },
      'api: channel member removed',
    );
    return c.body(null, 204);
  });

  // ── Sessions ─────────────────────────────────────────────────────
  app.get('/api/channels/:id/sessions', c => {
    const channel = channels.get(c.req.param('id'));
    if (!channel) return c.json({ error: 'channel not found' }, 404);
    return c.json({ sessions: sessions.listForChannel(channel.id) });
  });

  // Per-session unread notification counts for the sessions sidebar badge.
  app.get('/api/channels/:id/unread-by-session', c => {
    const channel = channels.get(c.req.param('id'));
    if (!channel) return c.json({ error: 'channel not found' }, 404);
    const countsMap = notifications.unreadCountsBySessionForChannel(channel.id);
    const counts: Record<string, number> = {};
    for (const [sid, n] of countsMap) counts[sid] = n;
    return c.json({ counts });
  });

  app.get(apiPaths.messageUnreadSummary, c => {
    const viewerUserId = requireViewerUserId(c, ctx);
    if (typeof viewerUserId !== 'string') return viewerUserId;
    return c.json({
      by_channel: sessionReads.unreadCountsByChannel(viewerUserId),
    });
  });

  app.get('/api/channels/:id/message-unread', c => {
    const channel = channels.get(c.req.param('id'));
    if (!channel) return c.json({ error: 'channel not found' }, 404);
    const viewerUserId = requireViewerUserId(c, ctx);
    if (typeof viewerUserId !== 'string') return viewerUserId;
    return c.json(
      sessionReads.unreadCountsBySessionForChannel(channel.id, viewerUserId),
    );
  });

  app.post('/api/channels/:id/sessions', async c => {
    const channel = channels.get(c.req.param('id'));
    if (!channel) return c.json({ error: 'channel not found' }, 404);
    const body = await c.req.json().catch(() => ({}));
    const parsed = CreateSessionInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }

    if (parsed.data.parent_session_id && !parsed.data.context_summary?.trim()) {
      return c.json(
        { error: 'context_summary is required when parent_session_id is set' },
        400,
      );
    }

    // Validate member agents are in the channel.
    for (const aid of parsed.data.member_agent_ids) {
      if (!members.isMember(channel.id, aid)) {
        return c.json({ error: `agent ${aid} is not a member of this channel` }, 400);
      }
    }

    let session;
    try {
      session = sessions.insert({
        channelId: channel.id,
        title: parsed.data.title,
        parentSessionId: parsed.data.parent_session_id ?? null,
        spawnedByAgentId: null, // human-initiated from UI
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

    for (const aid of parsed.data.member_agent_ids) {
      sessions.addAgent(session.id, aid);
    }

    if (parsed.data.parent_session_id && parsed.data.context_summary) {
      const parent = sessions.get(parsed.data.parent_session_id);
      messages.insert({
        sessionId: session.id,
        fromKind: 'system',
        content: `Inherited context from parent channel '${parent?.title ?? '(unknown)'}': ${parsed.data.context_summary}`,
        metadata: { subtype: 'child_context' },
      });
    }

    return c.json({ session }, 201);
  });

  app.get('/api/sessions/:id', c => {
    const session = sessions.get(c.req.param('id'));
    if (!session) return c.json({ error: 'not found' }, 404);
    return c.json({ session });
  });

  app.get('/api/sessions/:id/agents', c => {
    const session = sessions.get(c.req.param('id'));
    if (!session) return c.json({ error: 'not found' }, 404);
    return c.json({ agents: sessions.listAgents(session.id) });
  });

  app.get('/api/sessions/:id/agent-run-states', c => {
    const session = sessions.get(c.req.param('id'));
    if (!session) return c.json({ error: 'not found' }, 404);
    return c.json({ states: ctx.sessionManager.getAgentRunStates(session.id) });
  });

  app.get('/api/sessions/:id/messages', c => {
    const session = sessions.get(c.req.param('id'));
    if (!session) return c.json({ error: 'not found' }, 404);
    const limit = parseLimit(c.req.query('limit'), 200);
    const beforeSeq = parseBeforeSeq(c.req.query('before_seq'));
    if (beforeSeq === 'invalid') {
      return c.json({ error: 'before_seq must be a positive integer' }, 400);
    }
    return c.json(
      messages.listWindowForSession(session.id, {
        limit,
        beforeSeq,
      }),
    );
  });

  // Human user posts a message into a session from the UI compose form.
  // Inserts the row, fans out to every running agent, publishes SSE.
  app.post('/api/sessions/:id/messages', async c => {
    const session = sessions.get(c.req.param('id'));
    if (!session) return c.json({ error: 'not found' }, 404);
    if (session.closed_at !== null) {
      return c.json({ error: 'session is closed' }, 409);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = SendMessageInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }

    const msg = messages.insert({
      sessionId: session.id,
      fromKind: 'user',
      fromUserId: resolveViewerUserId(c, ctx),
      content: parsed.data.content,
    });

    // Distribute to every agent in the session (no excludeAgentId — the
    // sender is a human, not a participating agent).
    const recipients = sessions.listAgents(session.id);
    ctx.logger.info(
      {
        sessionId: session.id,
        messageId: msg.id,
        contentBytes: parsed.data.content.length,
        recipientCount: recipients.length,
        recipients: recipients.map(r => r.agent_id),
      },
      'api: user message accepted, distributing',
    );

    // Deliver to inbox / running-agent stdin. For running agents this
    // writes to stdin immediately; for idle agents it writes to the inbox
    // (drained automatically on the next session_init after auto-wake).
    for (const sa of recipients) {
      void ctx.sessionManager.deliverMessage(session.id, sa.agent_id, msg.id);
    }

    // Publish SSE immediately so the sender's UI reflects the message
    // without waiting for agent auto-start (which can take seconds).
    ctx.events.publish(session.id, {
      kind: 'message',
      payload: { message: msg },
    });

    // Bump parent thread badge (fire-and-forget — no client latency).
    if (session.parent_session_id) {
      ctx.events.publish(session.parent_session_id, {
        kind: 'thread_updated',
        payload: {
          parent_session_id: session.parent_session_id,
          child_session_id: session.id,
        },
      });
    }

    // Respond to the sender immediately — background work below.
    const result = c.json({ message: msg }, 201);

    // Background: auto-wake idle agents (they'll drain their inbox on
    // session_init) + fan out cross-channel mention CCs. Errors are
    // logged per-recipient and never surface to the caller.
    void Promise.all(
      recipients
        .filter(r => r.status !== 'active' && r.status !== 'starting')
        .map(r =>
          ctx.sessionManager.start(session.id, r.agent_id).catch(err => {
            ctx.logger.warn(
              { sessionId: session.id, agentId: r.agent_id, err },
              'api: auto-start on message send failed',
            );
          }),
        ),
    );

    // Cross-channel mention CC: any @handle pointing at an agent who
    // isn't a member of THIS session gets a wrapped copy in their DM
    // channel + a notification row. Best-effort — the helper logs and
    // swallows per-recipient failures so one bad delivery never fails
    // the user's send.
    const sourceChannel = channels.get(session.channel_id);
    if (sourceChannel) {
      void ccMentionsFromUserMessage({
        message: msg,
        sourceSession: session,
        sourceChannel,
        agents,
        channels,
        sessions,
        messages,
        notifications,
        sessionManager: ctx.sessionManager,
        logger: ctx.logger,
      });
    }

    return result;
  });

  app.get('/api/sessions/:id/children', c => {
    const session = sessions.get(c.req.param('id'));
    if (!session) return c.json({ error: 'not found' }, 404);
    return c.json({ sessions: sessions.listChildren(session.id) });
  });

  app.post('/api/sessions/:id/mark-read', async c => {
    const session = sessions.get(c.req.param('id'));
    if (!session) return c.json({ error: 'not found' }, 404);
    const viewerUserId = requireViewerUserId(c, ctx);
    if (typeof viewerUserId !== 'string') return viewerUserId;
    const body = await c.req.json().catch(() => ({}));
    const parsed = MarkSessionReadInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const row = sessionReads.markRead({
      viewerUserId,
      sessionId: session.id,
      seq: parsed.data.seq,
    });
    return c.json({ last_read_seq: row.last_read_seq });
  });

  // Open-thread summary under a parent — one row per open child + its
  // anchor message id + reply count. Renderer uses this to render the
  // "{count} Reply" badge on the parent's chat view; one bulk fetch
  // avoids N+1 per visible message.
  app.get('/api/sessions/:id/threads', c => {
    const session = sessions.get(c.req.param('id'));
    if (!session) return c.json({ error: 'not found' }, 404);
    return c.json({ threads: sessions.listOpenThreadsForParent(session.id) });
  });

  // Live event stream for a session. SessionManager + route handlers
  // publish into ctx.events; this endpoint relays to the renderer.
  // Heartbeat every 30s so proxies / Electron don't reap the connection.
  app.get('/api/sessions/:id/stream', c => {
    const session = sessions.get(c.req.param('id'));
    if (!session) return c.json({ error: 'not found' }, 404);
    return streamSSE(c, async stream => {
      const queue: { kind: string; payload: unknown }[] = [];
      let wake: (() => void) | null = null;
      let aborted = false;

      const unsub = ctx.events.subscribe(session.id, e => {
        queue.push(e);
        wake?.();
      });
      stream.onAbort(() => {
        aborted = true;
        unsub();
        wake?.();
      });

      await stream.writeSSE({
        event: 'connected',
        data: JSON.stringify({ session_id: session.id }),
      });

      while (!aborted) {
        if (queue.length > 0) {
          const e = queue.shift()!;
          await stream.writeSSE({
            event: e.kind,
            data: JSON.stringify(e.payload),
          });
          continue;
        }
        await new Promise<void>(resolve => {
          wake = resolve;
          setTimeout(() => {
            wake = null;
            resolve();
          }, 30_000);
        });
        if (queue.length === 0 && !aborted) {
          await stream.writeSSE({ event: 'ping', data: String(Date.now()) });
        }
      }
    });
  });

  app.post('/api/sessions/:id/close', async c => {
    const session = sessions.get(c.req.param('id'));
    if (!session) return c.json({ error: 'not found' }, 404);
    if (session.closed_at !== null) {
      return c.json({ error: 'already closed' }, 409);
    }
    if (sessions.countActiveChildren(session.id) > 0) {
      return c.json(
        { error: 'close all child sessions first', code: 'has_active_children' },
        409,
      );
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = CloseSessionInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const closed = sessions.close(session.id, parsed.data.summary);
    ctx.sessionManager.resolveSessionRuns(session.id, 'session_closed');

    // Auto-post summary to parent if requested and parent exists.
    if (
      closed &&
      !parsed.data.posted_to_parent &&
      session.parent_session_id
    ) {
      const parent = sessions.get(session.parent_session_id);
      if (parent && parent.closed_at === null) {
        messages.insert({
          sessionId: parent.id,
          fromKind: 'system',
          content:
            `Sub-session '${session.title}' closed. Summary: ${parsed.data.summary}`,
          metadata: { subtype: 'child_summary' },
        });
      }
    }

    // Closing a thread drops it from the parent's open-threads summary
    // and changes the child row's closed_at state in the session list.
    // Notify the parent's stream so split/thread UI refreshes without
    // waiting for a full app reload.
    if (session.parent_session_id) {
      ctx.events.publish(session.parent_session_id, {
        kind: 'thread_updated',
        payload: {
          parent_session_id: session.parent_session_id,
          child_session_id: session.id,
        },
      });
    }

    return c.json({ session: closed });
  });

  app.delete('/api/sessions/:id', c => {
    const id = c.req.param('id');
    ctx.sessionManager.resolveSessionRuns(id, 'session_closed');
    sessions.delete(id);
    return c.body(null, 204);
  });

  app.post('/api/sessions/:id/pin', c => {
    let pinResult: ReturnType<typeof sessions.pin>;
    try {
      pinResult = sessions.pin(c.req.param('id'));
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code === 'child_session') {
        return c.json({ error: 'child sessions cannot be pinned' }, 400);
      }
      throw err;
    }
    if (!pinResult) return c.json({ error: 'session not found' }, 404);
    return c.json({ session: pinResult });
  });

  app.delete('/api/sessions/:id/pin', c => {
    const session = sessions.unpin(c.req.param('id'));
    if (!session) return c.json({ error: 'session not found' }, 404);
    return c.json({ session });
  });

  // ── Saved messages (bookmarks) ──────────────────────────────────
  // Single global flat list per spec (docs/app-layout.md §6).

  app.get(apiPaths.saved, c => c.json({ saved: saved.list() }));

  app.get(apiPaths.search, c => {
    const parsed = SearchQueryInputSchema.safeParse({
      q: c.req.query('q') ?? '',
      scope: c.req.query('scope') || undefined,
      channel_id: c.req.query('channel_id') || undefined,
      user_id: c.req.query('user_id') || undefined,
      agent_id: c.req.query('agent_id') || undefined,
      from: c.req.query('from') || undefined,
      to: c.req.query('to') || undefined,
      limit: c.req.query('limit') || undefined,
    });
    if (!parsed.success) {
      return c.json({ error: 'invalid query', issues: parsed.error.issues }, 400);
    }
    return c.json({
      query: parsed.data,
      results: search.search(parsed.data),
    });
  });

  app.get('/api/messages/:id', c => {
    const m = messages.getById(c.req.param('id'));
    if (!m) return c.json({ error: 'message not found' }, 404);
    // Resolve the sender name when it's an agent so the renderer
    // doesn't need a separate /agents lookup for one-off previews.
    let agent_name: string | null = null;
    if (m.from_agent_id) {
      const a = agents.get(m.from_agent_id);
      agent_name = a?.name ?? null;
    }
    return c.json({ message: m, agent_name });
  });

  app.post('/api/messages/:id/save', c => {
    const messageId = c.req.param('id');
    if (!messages.getById(messageId)) {
      return c.json({ error: 'message not found' }, 404);
    }
    const dto = saved.save(messageId);
    if (!dto) return c.json({ error: 'message not found' }, 404);
    return c.json({ saved: dto }, 201);
  });

  app.delete('/api/messages/:id/save', c => {
    saved.remove(c.req.param('id'));
    return c.body(null, 204);
  });

  // ── Thread → child session (human-triggered) ─────────────────────
  // Per docs/app-layout.md §7. Creates a child session anchored to the
  // anchor message; default members = every member currently present in
  // the parent channel. Two seed messages are written: a thread_anchor
  // with metadata pointing back to the original message, then an
  // onboarding system message imperatively asking the relevant agent to
  // greet briefly.
  //
  // The child session process is NOT spawned eagerly — it starts on
  // the first user message in the new pane (same pattern as agent-
  // initiated child sessions, see /internal/.../spawn-child).

  app.post('/api/messages/:id/thread', c => {
    const messageId = c.req.param('id');
    const original = messages.getById(messageId);
    if (!original) return c.json({ error: 'message not found' }, 404);

    const parent = sessions.get(original.session_id);
    if (!parent) return c.json({ error: 'parent session not found' }, 404);
    if (parent.closed_at !== null) {
      return c.json({ error: 'parent session is closed' }, 409);
    }
    if (parent.parent_session_id !== null) {
      return c.json(
        { error: 'cannot start a thread on a child session — only one nesting level allowed' },
        400,
      );
    }

    // Idempotency: if a still-open thread child already exists for
    // this exact source message, reuse it. Closed children are not
    // reused — close means the thread is done; clicking Thread again
    // is a fresh conversation start.
    const existing = sessions.findOpenThreadChild(parent.id, original.id);
    if (existing) {
      return c.json({
        child_session_id: existing.id,
        session: existing,
        reused: true,
      });
    }

    const channel = channels.get(parent.channel_id);
    if (!channel) return c.json({ error: 'channel not found' }, 404);

    // Thread membership follows the current parent channel roster, not
    // just the author of the clicked message. This keeps multi-agent
    // discussions intact when the user peels off a Thread.
    const parentAgentIds = sessions.listAgents(parent.id).map(sa => sa.agent_id);
    const fallbackChannelAgentIds =
      parentAgentIds.length === 0
        ? members.listForChannel(channel.id).map(a => a.id)
        : [];
    const memberAgentIds = Array.from(
      new Set([
        original.from_kind === 'agent' ? original.from_agent_id : null,
        ...parentAgentIds,
        ...fallbackChannelAgentIds,
      ].filter((id): id is string => !!id)),
    );
    if (memberAgentIds.length === 0) {
      return c.json({ error: 'session has no members to start a thread with' }, 400);
    }

    const seedAgentId = original.from_kind === 'agent' && original.from_agent_id
      ? original.from_agent_id
      : memberAgentIds[0]!;
    const seedAgent = agents.get(seedAgentId);
    if (!seedAgent) {
      return c.json({ error: 'seed agent not found' }, 404);
    }

    // Sender label + agent name snapshot for the quote preview.
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

    // Title — short prefix of the anchor body so the sessions sidebar
    // shows something recognizable. 50 char cap with ellipsis.
    const flat = original.content.replace(/\s+/g, ' ').trim();
    const title =
      'Thread: ' + (flat.length > 50 ? flat.slice(0, 50) + '…' : flat);

    let child;
    try {
      child = sessions.insert({
        channelId: channel.id,
        title,
        parentSessionId: parent.id,
        // null spawnedByAgentId = human-spawned (vs. agent MCP-spawned)
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
      sessions.addAgent(child.id, memberAgentId);
    }

    // Seed 1: thread anchor — snapshot the original message's content
    // + sender + timestamp directly into metadata so the UI can render
    // a preview without a second fetch (and so the anchor remains
    // stable even if the original gets edited later).
    const quoteText = [
      `Quoted from #${channel.name} · ${quotedSenderLabel}:`,
      ``,
      ...original.content.split('\n').map(line => `> ${line}`),
    ].join('\n');
    messages.insert({
      sessionId: child.id,
      fromKind: 'system',
      content: quoteText,
      metadata: {
        subtype: 'thread_anchor',
        quoted_message_id: original.id,
        quoted_session_id: parent.id,
        quoted_channel_name: channel.name,
        quoted_content: original.content,
        quoted_from_kind: original.from_kind,
        quoted_from_agent_id: original.from_agent_id,
        quoted_from_user_id: original.from_user_id,
        quoted_agent_name: quotedSenderName,
        quoted_created_at: original.created_at,
      },
    });

    // Seed 2: imperative onboarding (matches the descriptive vs.
    // imperative distinction noted in CLAUDE.md — descriptive system
    // messages tend to be ignored by claude). Tool names + the
    // "system-triggered" disclaimer are intentionally absent — the
    // platform prompt covers send_message / parent-target mechanics
    // and the `from_kind=system` framing.
    const onboarding = [
      `You (@${seedAgent.name}) just joined a thread in #${channel.name}.`,
      `The user wants to dig deeper into the quoted message above.`,
      ``,
      `Read the quote, send one short greeting acknowledging the topic, then wait for the user.`,
      `If you need parent context, ask the parent channel via \`target='parent'\`. When you think the thread has reached a conclusion, post a visible summary in this thread and ask the user whether to close it. Only call \`close_thread\` after the user explicitly confirms.`,
    ].join('\n');
    messages.insert({
      sessionId: child.id,
      fromKind: 'system',
      content: onboarding,
      metadata: { subtype: 'onboarding' },
    });

    // Notify parent's stream so the renderer can refresh the
    // "{count} Reply" badge for the anchor message.
    ctx.events.publish(parent.id, {
      kind: 'thread_updated',
      payload: { parent_session_id: parent.id, child_session_id: child.id },
    });

    return c.json({ child_session_id: child.id, session: child, reused: false }, 201);
  });

  // Wake / sleep an agent in a session. Spawning is explicit per
  // core-design §3.1 — we don't auto-spawn agents on every message.
  app.post('/api/sessions/:id/agents/:aid/start', async c => {
    const session = sessions.get(c.req.param('id'));
    if (!session) return c.json({ error: 'session not found' }, 404);
    const aid = c.req.param('aid');
    if (!agents.get(aid)) return c.json({ error: 'agent not found' }, 404);
    if (!members.isMember(session.channel_id, aid)) {
      return c.json({ error: 'agent is not a member of this channel' }, 400);
    }
    ctx.logger.info({ sessionId: session.id, agentId: aid }, 'api: start agent requested');
    try {
      await ctx.sessionManager.start(session.id, aid);
      return c.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.logger.error({ sessionId: session.id, agentId: aid, err }, 'api: start agent failed');
      return c.json({ error: msg }, 400);
    }
  });

  app.post('/api/sessions/:id/agents/:aid/stop', async c => {
    const session = sessions.get(c.req.param('id'));
    if (!session) return c.json({ error: 'session not found' }, 404);
    const body = await c.req.json().catch(() => ({}));
    const mode: 'soft' | 'hard' = body?.mode === 'soft' ? 'soft' : 'hard';
    const directive =
      typeof body?.directive === 'string' ? body.directive : undefined;
    ctx.logger.info(
      { sessionId: session.id, agentId: c.req.param('aid'), mode, hasDirective: !!directive },
      'api: stop agent requested',
    );
    await ctx.sessionManager.stop(session.id, c.req.param('aid'), mode, directive);
    return c.json({ ok: true });
  });

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

  // Lightweight endpoint: total unread + per-channel counts + the
  // most recent unread pointer per channel so the renderer can jump
  // straight there when the user clicks a DM with the badge.
  app.get(apiPaths.notificationsUnread, c => {
    const total = notifications.unreadCount();
    const byChannel = Object.fromEntries(
      notifications.unreadCountsByChannel().entries(),
    );
    const latestByChannel = Object.fromEntries(
      notifications.latestUnreadByChannel().entries(),
    );
    return c.json({
      total,
      by_channel: byChannel,
      latest_by_channel: latestByChannel,
    });
  });

  // Mark-read with three modes: by id, by channel, or all. Validation
  // mirrors `MarkNotificationsReadInputSchema` in shared/dto.ts.
  app.post(apiPaths.notificationsRead, async c => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = MarkNotificationsReadInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const { id, channel_id, session_id, all } = parsed.data;
    if (id) {
      const ok = notifications.markRead(id);
      return c.json({ marked: ok ? 1 : 0 });
    }
    if (channel_id) {
      const n = notifications.markChannelRead(channel_id);
      return c.json({ marked: n });
    }
    if (session_id) {
      const n = notifications.markSessionRead(session_id);
      return c.json({ marked: n });
    }
    if (all) {
      const n = notifications.markAllRead();
      return c.json({ marked: n });
    }
    // Unreachable thanks to the schema refine, but TS doesn't narrow.
    return c.json({ error: 'invalid input' }, 400);
  });

  // ── Tasks (human-facing list + overrides) ────────────────────────
  const taskDeps = { ctx, agents, channels, sessions, messages };

  app.get(apiPaths.tasks, c => {
    const parsed = ListTasksQuerySchema.safeParse({
      channel_id: c.req.query('channel_id') || undefined,
      session_id: c.req.query('session_id') || undefined,
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

export function createInternalRouter(ctx: BackendContext): Hono {
  const app = new Hono();
  const agents = new AgentRepo(ctx.db);
  const channels = new ChannelRepo(ctx.db, { workspacesRoot: ctx.workspacesRoot });
  const members = new MembershipRepo(ctx.db);
  const sessions = new SessionRepo(ctx.db);
  const messages = new MessageRepo(ctx.db);

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

  // ── send_message ────────────────────────────────────────────────
  app.post('/internal/sessions/:sid/agents/:aid/send-message', async c => {
    const sid = c.req.param('sid');
    const aid = c.req.param('aid');
    const session = sessions.get(sid);
    if (!session) return c.json({ error: 'session not found' }, 404);
    const agent = agents.get(aid);
    if (!agent) return c.json({ error: 'agent not found' }, 404);
    const body = await c.req.json().catch(() => ({}));
    const parsed = AgentSendMessageInputSchema.safeParse(body);
    if (!parsed.success) {
      ctx.logger.warn(
        { sessionId: sid, agentId: aid, issues: parsed.error.issues },
        'internal: agent send-message rejected (invalid input)',
      );
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }

    const target = parsed.data.target ?? 'self';
    const targetSession = resolveTarget(session, target, sessions);
    if (typeof targetSession === 'string') {
      ctx.logger.warn(
        { sessionId: sid, agentId: aid, target, reason: targetSession },
        'internal: agent send-message target unreachable',
      );
      return c.json({ error: targetSession, code: 'target_unreachable' }, 400);
    }
    if (targetSession.closed_at !== null) {
      ctx.logger.warn(
        { sessionId: sid, agentId: aid, targetSessionId: targetSession.id },
        'internal: agent send-message into closed session',
      );
      return c.json({ error: 'target session is closed' }, 409);
    }

    const msg = messages.insert({
      sessionId: targetSession.id,
      fromKind: 'agent',
      fromAgentId: aid,
      content: parsed.data.content,
    });

    ctx.logger.info(
      {
        sessionId: sid,
        agentId: aid,
        targetSessionId: targetSession.id,
        messageId: msg.id,
        contentBytes: parsed.data.content.length,
        target,
      },
      'internal: agent send-message inserted, distributing',
    );

    // Distribute to other session_agents in the target session.
    await distributeMessage(ctx, sessions, targetSession.id, aid, msg.id);

    ctx.events.publish(targetSession.id, {
      kind: 'message',
      payload: { message: msg },
    });
    ctx.sessionManager.resolveRun(sid, aid, 'replied');

    // If the target is a thread (child), bump the parent's stream so
    // the parent view's reply-count badge can refresh without polling.
    if (targetSession.parent_session_id) {
      ctx.events.publish(targetSession.parent_session_id, {
        kind: 'thread_updated',
        payload: {
          parent_session_id: targetSession.parent_session_id,
          child_session_id: targetSession.id,
        },
      });
    }

    return c.json({ message_id: msg.id });
  });

  // ── create_thread (legacy internal path: spawn-child) ───────────
  app.post('/internal/sessions/:sid/agents/:aid/spawn-child', async c => {
    const sid = c.req.param('sid');
    const aid = c.req.param('aid');
    const parent = sessions.get(sid);
    if (!parent) return c.json({ error: 'parent session not found' }, 404);
    const agent = agents.get(aid);
    if (!agent) return c.json({ error: 'agent not found' }, 404);
    const body = await c.req.json().catch(() => ({}));
    const parsed = AgentSpawnChildInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }

    // Members must be ⊆ parent channel members.
    for (const memberId of parsed.data.members) {
      if (!members.isMember(parent.channel_id, memberId)) {
        return c.json(
          { error: `agent ${memberId} is not a member of the parent channel` },
          400,
        );
      }
    }

    let child;
    try {
      child = sessions.insert({
        channelId: parent.channel_id,
        title: parsed.data.title,
        parentSessionId: parent.id,
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

    for (const memberId of parsed.data.members) {
      sessions.addAgent(child.id, memberId);
    }

    // Two seed messages: system context, then the spawning agent's
    // initial prompt as a regular agent message (so child members read
    // it as a normal incoming message).
    messages.insert({
      sessionId: child.id,
      fromKind: 'system',
      content:
        `Inherited context from parent channel '${parent.title}': ${parsed.data.context_summary}`,
      metadata: { subtype: 'child_context' },
    });
    messages.insert({
      sessionId: child.id,
      fromKind: 'agent',
      fromAgentId: aid,
      content: parsed.data.initial_prompt,
    });

    return c.json({ thread_id: child.id });
  });

  // ── create_channel (legacy internal path: create-session) ──────
  app.post('/internal/sessions/:sid/agents/:aid/create-session', async c => {
    const sid = c.req.param('sid');
    const aid = c.req.param('aid');
    const current = sessions.get(sid);
    if (!current) return c.json({ error: 'session not found' }, 404);
    if (!agents.get(aid)) return c.json({ error: 'agent not found' }, 404);
    const body = await c.req.json().catch(() => ({}));
    const parsed = AgentCreateSessionInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }

    const channelMembers = members.listForChannel(current.channel_id);
    let session;
    try {
      session = sessions.insert({
        channelId: current.channel_id,
        title: parsed.data.title,
        parentSessionId: null,
        spawnedByAgentId: aid,
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

    for (const member of channelMembers) {
      sessions.addAgent(session.id, member.id);
    }

    messages.insert({
      sessionId: session.id,
      fromKind: 'system',
      content:
        `Session created from '${current.title}'. Reason: ${parsed.data.context_summary}`,
      metadata: {
        subtype: 'session_context',
        source_session_id: current.id,
        created_by_agent_id: aid,
      },
    });
    const prompt = messages.insert({
      sessionId: session.id,
      fromKind: 'agent',
      fromAgentId: aid,
      content: parsed.data.initial_prompt,
    });

    await distributeMessage(ctx, sessions, session.id, aid, prompt.id);
    void Promise.all(
      sessions
        .listAgents(session.id)
        .filter(sa => sa.agent_id !== aid && sa.status !== 'active' && sa.status !== 'starting')
        .map(sa =>
          ctx.sessionManager.start(session.id, sa.agent_id).catch(err => {
            ctx.logger.warn(
              { sessionId: session.id, agentId: sa.agent_id, err },
              'internal: auto-start on agent-created session failed',
            );
          }),
        ),
    );

    return c.json({ session_id: session.id });
  });

  // ── close_thread (legacy internal path: close session) ──────────
  app.post('/internal/sessions/:sid/agents/:aid/close', async c => {
    const sid = c.req.param('sid');
    const aid = c.req.param('aid');
    const session = sessions.get(sid);
    if (!session) return c.json({ error: 'session not found' }, 404);
    if (!agents.get(aid)) return c.json({ error: 'agent not found' }, 404);
    if (session.closed_at !== null) {
      return c.json({ error: 'already closed' }, 409);
    }
    if (sessions.countActiveChildren(session.id) > 0) {
      return c.json(
        { error: 'close all child sessions first', code: 'has_active_children' },
        409,
      );
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = AgentCloseSessionInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }

    const closed = sessions.close(session.id, parsed.data.summary);
    ctx.sessionManager.resolveSessionRuns(session.id, 'session_closed');
    if (!parsed.data.posted_to_parent && session.parent_session_id) {
      const parent = sessions.get(session.parent_session_id);
      if (parent && parent.closed_at === null) {
        const agent = agents.get(aid);
        const summaryMsg = messages.insert({
          sessionId: parent.id,
          fromKind: 'system',
          content:
            `Sub-session '${session.title}' closed by @${agent?.name ?? 'agent'}. ` +
            `Summary: ${parsed.data.summary}`,
          metadata: { subtype: 'child_summary' },
        });
        await distributeMessage(ctx, sessions, parent.id, null, summaryMsg.id);
        ctx.events.publish(parent.id, {
          kind: 'message',
          payload: { message: summaryMsg },
        });
      }
    }

    // Closing a thread drops it from the parent's open-threads summary,
    // so notify the parent's stream regardless of `posted_to_parent`.
    if (session.parent_session_id) {
      ctx.events.publish(session.parent_session_id, {
        kind: 'thread_updated',
        payload: {
          parent_session_id: session.parent_session_id,
          child_session_id: session.id,
        },
      });
    }

    // Stop every running agent in the closed session.
    for (const sa of sessions.listAgents(session.id)) {
      void ctx.sessionManager.stop(session.id, sa.agent_id, 'hard');
    }

    return c.json({ session: closed });
  });

  // ── Tasks — 5 agent-facing endpoints backing the MCP tools ───────
  // See docs/tasks-design.md §5. Each binds (session_id, agent_id) so
  // task service functions can enforce "operate only on your own
  // session's tasks".
  const taskDeps = { ctx, agents, channels, sessions, messages };

  app.get('/internal/sessions/:sid/agents/:aid/tasks', c => {
    const sid = c.req.param('sid');
    const aid = c.req.param('aid');
    const session = sessions.get(sid);
    if (!session) return c.json({ error: 'session not found' }, 404);
    if (!agents.get(aid)) return c.json({ error: 'agent not found' }, 404);
    const parsed = ListTasksQuerySchema.safeParse({
      channel_id: c.req.query('channel_id') || session.channel_id,
      session_id: c.req.query('session_id') || undefined,
      status: c.req.query('status') || undefined,
    });
    if (!parsed.success) {
      return c.json({ error: 'invalid query', issues: parsed.error.issues }, 400);
    }
    return c.json({ tasks: listTasks(taskDeps, parsed.data) });
  });

  app.post('/internal/sessions/:sid/agents/:aid/tasks/create', async c => {
    const sid = c.req.param('sid');
    const aid = c.req.param('aid');
    const body = await c.req.json().catch(() => ({}));
    const parsed = CreateTasksInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const result = await createTasksByAgent(taskDeps, {
      sessionId: sid,
      agentId: aid,
      tasks: parsed.data.tasks,
    });
    if ('error' in result) {
      return c.json({ error: result.error }, 400);
    }
    return c.json(result);
  });

  app.post('/internal/sessions/:sid/agents/:aid/tasks/claim', async c => {
    const sid = c.req.param('sid');
    const aid = c.req.param('aid');
    const body = await c.req.json().catch(() => ({}));
    const parsed = ClaimTasksInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const result = await claimTasksByAgent(taskDeps, {
      sessionId: sid,
      agentId: aid,
      task_numbers: parsed.data.task_numbers,
      message_ids: parsed.data.message_ids,
    });
    if ('error' in result) {
      return c.json({ error: result.error }, 400);
    }
    return c.json(result);
  });

  app.post('/internal/sessions/:sid/agents/:aid/tasks/unclaim', async c => {
    const sid = c.req.param('sid');
    const aid = c.req.param('aid');
    const body = await c.req.json().catch(() => ({}));
    const parsed = UnclaimTaskInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const result = await unclaimTaskByAgent(taskDeps, {
      sessionId: sid,
      agentId: aid,
      taskNumber: parsed.data.task_number,
    });
    if ('error' in result) {
      return c.json({ error: result.error }, 400);
    }
    return c.json(result);
  });

  app.post('/internal/sessions/:sid/agents/:aid/tasks/update-status', async c => {
    const sid = c.req.param('sid');
    const aid = c.req.param('aid');
    const body = await c.req.json().catch(() => ({}));
    const parsed = UpdateTaskStatusInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const result = await updateTaskStatusByAgent(taskDeps, {
      sessionId: sid,
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

/** Resolve `target` against the current channel/thread. Returns a session DTO
 *  on success, or an error message string on failure. */
function resolveTarget(
  current: NonNullable<ReturnType<SessionRepo['get']>>,
  target: SendMessageTarget,
  sessions: SessionRepo,
): NonNullable<ReturnType<SessionRepo['get']>> | string {
  if (target === 'self') return current;
  if (target === 'parent') {
    if (!current.parent_session_id) return 'no parent channel — current channel is top-level';
    const parent = sessions.get(current.parent_session_id);
    if (!parent) return 'parent channel not found';
    return parent;
  }
  // Thread target: must be a direct child of current.
  const child = sessions.get(target.thread_id);
  if (!child) return 'thread not found';
  if (child.parent_session_id !== current.id) {
    return 'target is not a direct thread of current channel';
  }
  return child;
}

/** Push a newly-inserted message to every other session_agent. Live to
 *  running ones; inbox to sleeping ones. `excludeAgentId` skips the
 *  sender (who already has the content in their own context). */
async function distributeMessage(
  ctx: BackendContext,
  sessions: SessionRepo,
  sessionId: string,
  excludeAgentId: string | null,
  messageId: string,
): Promise<void> {
  const recipients = sessions
    .listAgents(sessionId)
    .filter(sa => sa.agent_id !== excludeAgentId);
  await Promise.all(
    recipients.map(sa =>
      ctx.sessionManager.deliverMessage(sessionId, sa.agent_id, messageId),
    ),
  );
}
