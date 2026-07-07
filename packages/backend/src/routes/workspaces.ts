// This file owns the workspace collection surface: workspace lifecycle / metadata
// (list / get / create / update / archive / pin / delete) plus the workspace's
// CHANNEL COLLECTION — list active channels, list archived channels, and create a
// channel. The seam is the URL aggregate: `/api/workspaces/:id/...` is the
// workspace surface;
// per-conversation behavior (messaging / runtime / membership / read) already
// lives in routes/conversations.ts keyed by `/api/conversations` · `/api/channels/:id`.
//
// One deliberate exception rides here: `GET /api/archived-channels` is a flat,
// cross-workspace read (not workspace-rooted). It is the channel-like global
// aggregate: a recovery surface spanning both `channel` and `dm_channel` so an
// archived DM is still reachable from the default Archived entry (the
// workspace-scoped read paths stay collection-segregated; only this index
// merges). Parked here rather than spun into a one-route island / extra mount.
//
// The two orchestration-heavy routes delegate to createWorkspace /
// deleteWorkspace use cases; this module owns only HTTP parsing, authorization,
// and response mapping.
import { Hono } from 'hono';
import {
  apiPaths,
  ArchiveWorkspaceInputSchema,
  ArchivedChannelsQueryInputSchema,
  CreateConversationChannelInputSchema,
  CreateWorkspaceInputSchema,
  UpdateWorkspaceInputSchema,
  systemSubtype,
} from '@silverhand/shared';
import type { AppEnv } from '../auth/principal.js';
import type { BackendContext } from '../context.js';
import type { AgentRepo } from '../repos/agent-repo.js';
import type { UserRepo } from '../repos/user-repo.js';
import type { WorkspaceRepo } from '../repos/workspace-repo.js';
import type { ConversationRepo } from '../repos/conversation-repo.js';
import type { MessageRepo } from '../repos/message-repo.js';
import type { SortRepo } from '../repos/sort-repo.js';
import { getUserPrincipal, requireViewerUserId } from '../auth/principal.js';
import { canGovernWorkspace, canViewWorkspace } from '../permissions.js';
import { timedRouteSpan } from '../observability/route-span.js';
import { createWorkspace } from '../application/create-workspace.js';
import { deleteWorkspace } from '../application/delete-workspace.js';
import { assertWorkspaceAgentsMatchHost } from '../application/workspace-placement.js';
import { AgentHomeChannelError } from '../services/channel-service.js';
import { channelServiceErrorResponse, placementErrorResponse } from './responses.js';

export interface WorkspacesRouteDeps {
  ctx: BackendContext;
  agents: AgentRepo;
  users: UserRepo;
  workspaces: WorkspaceRepo;
  conversations: ConversationRepo;
  messages: MessageRepo;
  sort: SortRepo;
}

export function createWorkspacesApp(deps: WorkspacesRouteDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { ctx, agents, users, workspaces, conversations, messages, sort } = deps;

  app.get(apiPaths.workspaces, c => {
    const principal = getUserPrincipal(c);
    const visible = workspaces
      .list()
      .filter(workspace => canViewWorkspace(ctx, principal, workspace.id));
    return c.json({
      workspaces: visible,
      // Filter sort entries to the live SORTABLE set so neither a stale
      // entity_id (removed/non-member) nor an out-of-scope archived workspace
      // leaks on the wire — archived is shown in its own rail group, not sorted.
      viewer_sort: sort.getState(
        principal.userId,
        'workspaces',
        visible.filter(w => w.archived_at == null).map(w => w.id),
      ),
    });
  });

  app.post(apiPaths.workspaces, async c => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = CreateWorkspaceInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const result = await createWorkspace(
      { ctx, agents, users, workspaces, conversations, messages },
      {
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        workspacePath: parsed.data.workspace_path,
        workspaceHostId: parsed.data.workspace_host_id,
        memberAgentIds: parsed.data.member_agent_ids,
        memberUserIds: parsed.data.member_user_ids,
        viewerUserId: requireViewerUserId(c),
      },
    );
    switch (result.kind) {
      case 'created':
        return c.json(
          {
            workspace: result.success.workspace,
            onboarding_channel_id: result.success.onboardingChannelId,
            channel: result.success.channel,
          },
          201,
        );
      case 'nameTaken':
        return c.json({ error: 'workspace name already exists' }, 409);
      case 'placementError': {
        const mapped = placementErrorResponse(c, result.err);
        if (mapped) return mapped;
        throw result.err;
      }
      case 'transportFailed':
        // The data-plane taxonomy owns this {code,message,status} triple; the
        // route just renders it.
        return c.json(
          { error: result.failure.message, code: result.failure.code },
          result.failure.status,
        );
      default: {
        const _exhaustive: never = result;
        return _exhaustive;
      }
    }
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
    if (!canGovernWorkspace(ctx, getUserPrincipal(c), workspace.id, 'admin')) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = UpdateWorkspaceInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    // Placement preflight runs in both deployment modes. Iterate every existing agent-backed
    // conversation in this workspace; if any agent's host placement
    // no longer matches the workspace's `workspace_host_id`,
    // fail-closed with 409 `host_mismatch`. This MUST run before
    // any side effect: metadata write
    // (`updateMutableMetadata`), the rename system message
    // insert, or `runtimeHost.deliverMessage`. The same DB-level placement
    // contract applies in both deployment modes. Agent-host assignments do not
    // change today, but the preflight makes the invariant explicit so future
    // agent-rebind paths cannot silently break workspace metadata writes.
    try {
      assertWorkspaceAgentsMatchHost(
        { ctx, conversations },
        workspace.id,
        workspace.workspace_host_id,
      );
    } catch (err) {
      const mapped = placementErrorResponse(c, err);
      if (mapped) return mapped;
      throw err;
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
            subtype: systemSubtype('rename'),
            old_name: workspace.name,
            new_name: parsed.data.name,
            scope: 'workspace',
          },
        });
        for (const ca of conversations.listAgents(channel.id)) {
          await ctx.runtimeHost.deliverMessage(
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
    if (!canGovernWorkspace(ctx, getUserPrincipal(c), workspace.id, 'owner')) {
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
    const result = await deleteWorkspace(
      { ctx, workspaces, conversations },
      { workspaceId: id, requesterUserId: getUserPrincipal(c).userId },
    );
    switch (result.kind) {
      case 'deleted':
      case 'idempotentNoop':
        return c.body(null, 204);
      case 'notDeletableKind':
        return c.json(
          {
            error: 'workspace kind cannot be deleted via workspace endpoint',
            code: 'workspace_not_deletable',
          },
          409,
        );
      case 'forbidden':
        return c.json({ error: 'forbidden' }, 403);
      case 'placementRejected': {
        const mapped = placementErrorResponse(c, result.err);
        if (mapped) return mapped;
        throw result.err;
      }
      default: {
        const _exhaustive: never = result;
        throw new Error(
          `unhandled DeleteWorkspaceResult: ${JSON.stringify(_exhaustive)}`,
        );
      }
    }
  });

  app.get(apiPaths.workspaceChannels(':id'), c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'workspace id required' }, 400);
    const workspace = workspaces.get(id);
    if (!workspace) {
      return c.json({ error: 'workspace not found' }, 404);
    }
    const principal = getUserPrincipal(c);
    if (!canViewWorkspace(ctx, principal, workspace.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    // Membership filter: human principals only see channels/threads
    // they are explicit members of (`conversation_users`). Agent /
    // system principals never call these public list endpoints in
    // practice; if they ever do, the unfiltered behavior is the
    // historical contract.
    const forUserId =
      principal.kind === 'user' ? principal.userId : undefined;
    const channels =
      workspace.workspace_kind === 'regular'
        ? timedRouteSpan(
            ctx,
            'workspace.channels.list_active',
            { workspaceId: workspace.id },
            () =>
              conversations.listActiveChannelsForWorkspace(workspace.id, {
                forUserId,
              }),
            result => ({ channelCount: result.length }),
          )
        : timedRouteSpan(
            ctx,
            'workspace.dm_channel.list_active',
            { workspaceId: workspace.id },
            () =>
              conversations.listActiveDmChannelsForWorkspace(workspace.id, {
                forUserId,
              }),
            result => ({ channelCount: result.length }),
          );
    return c.json({
      channels,
      // Filter to the live channel set so a stale entity_id never leaks.
      viewer_sort: sort.getState(
        principal.userId,
        `channels:${workspace.id}`,
        channels.map(ch => ch.id),
      ),
    });
  });

  app.get(apiPaths.workspaceArchivedChannels(':id'), c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'workspace id required' }, 400);
    const workspace = workspaces.get(id);
    if (!workspace) {
      return c.json({ error: 'workspace not found' }, 404);
    }
    const principal = getUserPrincipal(c);
    if (!canViewWorkspace(ctx, principal, workspace.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const forUserId =
      principal.kind === 'user' ? principal.userId : undefined;
    // agent_home / DM workspaces have their own archived collection
    // (archived DMs + the threads under them). It is kept SEPARATE from
    // the regular channel Archived view — same response shape, never
    // merged into one list (the DM list is its own sidebar collection).
    if (workspace.workspace_kind !== 'regular') {
      const dmChannels = timedRouteSpan(
        ctx,
        'workspace.dm_channel.list_archived',
        { workspaceId: workspace.id },
        () =>
          conversations.listArchivedDmChannelsForWorkspace(workspace.id, {
            forUserId,
          }),
        result => ({ channelCount: result.length }),
      );
      return c.json({ channels: dmChannels });
    }
    const channels = timedRouteSpan(
      ctx,
      'workspace.channels.list_archived',
      { workspaceId: workspace.id },
      () =>
        conversations.listArchivedChannelsForWorkspace(workspace.id, {
          forUserId,
        }),
      result => ({ channelCount: result.length }),
    );
    return c.json({ channels });
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
          forUserId:
            principal.kind === 'user' ? principal.userId : undefined,
        }),
      result => ({ rowCount: result.length }),
    );
    // Membership filter is applied at the repo level (forUserId), so
    // the result already only includes channels the principal is a
    // `conversation_users` member of. v1 single-human is auto-added
    // to every conversation; v2 multi-human relies on this filter.
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
    if (!canGovernWorkspace(ctx, getUserPrincipal(c), workspace.id, 'admin')) {
      return c.json({ error: 'forbidden' }, 403);
    }
    if (workspace.workspace_kind === 'agent_home') {
      if (
        parsed.data.member_agent_ids.length > 0 ||
        (parsed.data.member_user_ids?.length ?? 0) > 0
      ) {
        return c.json(
          { error: 'agent_home channels always use the home owner/current user as members' },
          400,
        );
      }
      try {
        const { channel } = await ctx.channelService.createAgentHomeDmChannel({
          workspaceId: workspace.id,
          title: parsed.data.title,
          actor: getUserPrincipal(c),
        });
        return c.json({ channel }, 201);
      } catch (err) {
        // The agent_home owner guards keep their exact `{ error }`-only bodies
        // (no `code`) — they must NOT go through `channelServiceErrorResponse`,
        // which adds a `code`. Every other failure (a transaction SqliteError,
        // or the unreachable workspace/kind defensive guards) rethrows → a
        // generic 500.
        if (err instanceof AgentHomeChannelError) {
          switch (err.code) {
            case 'agent_home_missing_owner':
              return c.json({ error: 'agent_home workspace missing owner' }, 500);
            case 'agent_home_owner_not_found':
              return c.json({ error: 'agent_home owner not found' }, 404);
            default: {
              const _exhaustive: never = err.code;
              throw err;
            }
          }
        }
        throw err;
      }
    }
    try {
      const result = await ctx.channelService.createChannel({
        workspaceId: id,
        title: parsed.data.title,
        memberAgentIds: parsed.data.member_agent_ids,
        memberUserIds: parsed.data.member_user_ids,
        actor: getUserPrincipal(c),
      });
      return c.json({ channel: result.channel }, 201);
    } catch (err) {
      const mapped = channelServiceErrorResponse(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  return app;
}
