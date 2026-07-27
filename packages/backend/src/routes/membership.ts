// Membership HTTP surface across both public and internal router factories:
//   - GET    /api/workspaces/:id/members              (createWorkspaceMembershipApp)
//   - POST   /api/workspaces/:id/members              (createWorkspaceMembershipApp)
//   - PATCH  /api/workspaces/:id/members/users/:userId/role
//                                                     (createWorkspaceMembershipApp)
//   - DELETE /api/workspaces/:id/members/:agentId     (createWorkspaceMembershipApp)
//   - DELETE /api/workspaces/:id/members/users/:userId
//                                                     (createWorkspaceMembershipApp)
//   - GET    /api/conversations/:id/members           (createConversationMembershipApp)
//   - POST   /api/conversations/:id/members           (createConversationMembershipApp)
//   - DELETE /api/conversations/:id/members/agents/:agentId
//                                                     (createConversationMembershipApp)
//   - POST   /internal …/agents/:aid/members          (createInternalMembershipApp)
//
// The context spans `/api/workspaces`, `/api/conversations`, and the internal
// prefix, so it is not a single REST prefix. Auth/principal is inherited from
// the parent app: public bearer/principal/registered-viewer middleware and
// internal param-scoped (`:cid/:aid`) agent-token + `getAgentPrincipal`
// middleware are installed before these sub-apps are mounted. Add/remove
// orchestration lives in application use cases; the routes parse and map HTTP.
import { Hono, type Context } from 'hono';
import {
  apiPaths,
  internalPaths,
  AddWorkspaceMemberInputSchema,
  UpdateWorkspaceHumanMemberRoleInputSchema,
  AddConversationMemberInputSchema,
  AddConversationMemberByHandleInputSchema,
  type AgentCapability,
  type WorkspaceHumanMemberDto,
  type WorkspaceRoleDto,
  type UserDto,
  type WorkspaceUserMemberDto,
} from '@silverhand/shared';
import type { BackendContext } from '../context.js';
import type { AppEnv, Principal } from '../auth/principal.js';
import { getAgentPrincipal, getPrincipal, getUserPrincipal } from '../auth/principal.js';
import {
  canEnrollAgent,
  canGovernWorkspace,
  canViewConversation,
  canViewWorkspace,
  workspaceRole,
} from '../permissions.js';
import { AgentRepo } from '../repos/agent-repo.js';
import { UserRepo } from '../repos/user-repo.js';
import { WorkspaceRepo } from '../repos/workspace-repo.js';
import { ConversationRepo } from '../repos/conversation-repo.js';
import { MessageRepo } from '../repos/message-repo.js';
import { ChannelAttentionPreferenceRepo } from '../repos/channel-attention-preference-repo.js';
import { MembershipService } from '../services/membership-service.js';
import { addWorkspaceAgentMember } from '../application/add-workspace-agent-member.js';
import {
  addConversationMember,
  buildChannelDetailResponse,
  conversationMemberAddedActorSnapshot,
  conversationMemberAddedAgentSnapshot,
  conversationMemberAddedHumanSnapshot,
  type ConversationMemberAddedActorSnapshot,
  type ConversationMemberAddedMemberSnapshot,
  conversationMemberRemovedContent,
  conversationMemberRemovedMetadata,
  joinPublicChannel,
  leaveChannel,
  publishMemberRemoved,
  removeConversationMember,
} from '../application/conversation-member.js';
import { type PostCommitEffect, runPostCommitEffects } from '../application/post-commit.js';
import { conversationMemberResultResponse } from './responses.js';

export interface MembershipRouteDeps {
  ctx: BackendContext;
  agents: AgentRepo;
  users: UserRepo;
  workspaces: WorkspaceRepo;
  conversations: ConversationRepo;
  messages: MessageRepo;
  channelAttentionPrefs: ChannelAttentionPreferenceRepo;
  membership: MembershipService;
}

// ── Workspace-membership read model (private to this context) ──────────────
// Repo queries + DTO assembly for the workspace member list. Membership-owned,
// NOT a shared HTTP mapper — kept here rather than in routes/responses.ts so
// that leaf stays only the cross-public/internal result mappers.
function listWorkspaceHumanMemberDtos(
  ctx: BackendContext,
  workspaces: WorkspaceRepo,
  workspaceId: string,
): WorkspaceHumanMemberDto[] {
  return workspaces
    .listUserMemberships(workspaceId)
    .map(member => {
      const user = ctx.userService.getDto(member.user_id);
      if (!user) return null;
      return { ...user, ...member };
    })
    .filter((member): member is WorkspaceHumanMemberDto => member !== null);
}

function workspaceMembersResponse(
  ctx: BackendContext,
  workspaces: WorkspaceRepo,
  workspaceId: string,
  viewerRole: WorkspaceRoleDto | null,
) {
  return {
    members: workspaces.listMembers(workspaceId),
    human_members: listWorkspaceHumanMemberDtos(ctx, workspaces, workspaceId),
    viewer_role: viewerRole,
  };
}

function ownerRoleChangeUnsupported(c: Context) {
  return c.json(
    {
      error: 'owner role changes are not supported',
      code: 'owner_role_change_unsupported',
    },
    400,
  );
}

function ownerRemovalUnsupported(c: Context) {
  return c.json(
    {
      error: 'the workspace owner cannot be removed',
      code: 'owner_removal_unsupported',
    },
    400,
  );
}

type ViewerWorkspaceChange = 'added' | 'role_changed' | 'removed';

function publishViewerWorkspacesChanged(
  ctx: BackendContext,
  userId: string,
  payload: {
    change: ViewerWorkspaceChange;
    workspace_id: string;
    // Absent for `removed` (the viewer no longer has a role here); the
    // renderer treats the payload as a hint and refetches `['workspaces']`
    // as the authority regardless. See `docs/viewer-visibility-sync-v1.md`.
    role?: WorkspaceRoleDto;
  },
): void {
  ctx.events.publishToScope(
    `viewer:${userId}`,
    'viewer_workspaces_changed',
    payload,
  );
}

function addWorkspaceHumanMember(
  ctx: BackendContext,
  workspaces: WorkspaceRepo,
  input: { workspaceId: string; user: UserDto },
): { member: WorkspaceUserMemberDto; human_member: WorkspaceHumanMemberDto } {
  const wasMember = workspaces.isUserMember(input.workspaceId, input.user.id);
  const member = workspaces.addUserMember(input.workspaceId, input.user.id);
  if (!wasMember) {
    publishViewerWorkspacesChanged(ctx, input.user.id, {
      change: 'added',
      workspace_id: input.workspaceId,
      role: member.role,
    });
  }
  return { member, human_member: { ...input.user, ...member } };
}

function updateWorkspaceHumanMemberRole(
  ctx: BackendContext,
  workspaces: WorkspaceRepo,
  input: {
    workspaceId: string;
    user: UserDto;
    previousRole: WorkspaceRoleDto;
    role: Exclude<WorkspaceRoleDto, 'owner'>;
  },
): { member: WorkspaceUserMemberDto; human_member: WorkspaceHumanMemberDto } | null {
  const member = workspaces.setUserRole(
    input.workspaceId,
    input.user.id,
    input.role,
  );
  if (!member) return null;
  if (input.previousRole !== input.role) {
    publishViewerWorkspacesChanged(ctx, input.user.id, {
      change: 'role_changed',
      workspace_id: input.workspaceId,
      role: member.role,
    });
  }
  return { member, human_member: { ...input.user, ...member } };
}

type RemovedConversationTarget = {
  id: string;
  workspace_id: string;
};

type RemovedConversationPublish = {
  conversation: RemovedConversationTarget;
  message: ReturnType<MessageRepo['insertForConversation']>;
};

function workspaceConversationsWithAgent(
  conversations: ConversationRepo,
  workspaceId: string,
  agentId: string,
): RemovedConversationTarget[] {
  return conversations
    .list()
    .filter(conversation =>
      conversation.workspace_id === workspaceId
      && conversations.getAgent(conversation.id, agentId) !== null,
    )
    .map(conversation => ({
      id: conversation.id,
      workspace_id: conversation.workspace_id,
    }));
}

function workspaceConversationsWithUser(
  conversations: ConversationRepo,
  workspaceId: string,
  userId: string,
): RemovedConversationTarget[] {
  return conversations
    .list()
    .filter(conversation =>
      conversation.workspace_id === workspaceId
      && conversations.getUser(conversation.id, userId) !== null,
    )
    .map(conversation => ({
      id: conversation.id,
      workspace_id: conversation.workspace_id,
    }));
}

function removeWorkspaceMemberAndConversationRows(
  ctx: BackendContext,
  conversations: ConversationRepo,
  messages: MessageRepo,
  input: {
    targets: RemovedConversationTarget[];
    actor: ConversationMemberAddedActorSnapshot;
    member: ConversationMemberAddedMemberSnapshot;
    removeWorkspaceMember: () => void;
  },
): RemovedConversationPublish[] {
  return ctx.db.transaction(() => {
    const publishes: RemovedConversationPublish[] = [];
    for (const conversation of input.targets) {
      if (input.member.kind === 'agent') {
        conversations.removeAgent(conversation.id, input.member.id);
      } else {
        conversations.removeUser(conversation.id, input.member.id);
      }
      const message = messages.insertForConversation({
        conversationId: conversation.id,
        fromKind: 'system',
        content: conversationMemberRemovedContent({
          actor: input.actor,
          member: input.member,
        }),
        metadata: conversationMemberRemovedMetadata({
          actor: input.actor,
          member: input.member,
        }),
      });
      publishes.push({ conversation, message });
    }
    input.removeWorkspaceMember();
    return publishes;
  })();
}

async function publishWorkspaceMemberRemovalEffects(
  ctx: BackendContext,
  conversations: ConversationRepo,
  input: {
    removed: RemovedConversationPublish[];
    viewerEvent?: { userId: string; workspaceId: string };
  },
): Promise<void> {
  const effects: PostCommitEffect[] = input.removed.map(
    ({ conversation, message }) => () => publishMemberRemoved(ctx, conversations, conversation, message),
  );
  const viewerEvent = input.viewerEvent;
  if (viewerEvent) {
    effects.push(() =>
      publishViewerWorkspacesChanged(ctx, viewerEvent.userId, {
        change: 'removed',
        workspace_id: viewerEvent.workspaceId,
      }),
    );
  }
  await runPostCommitEffects(effects, ctx.logger);
}

/**
 * Remove a human member from a workspace. Mirrors the agent-remove cascade
 * (`app.delete` below): for every conversation that actually contains the
 * human, delete the `conversation_users` row and insert the matching
 * `conversation_member_removed` system message, then delete the
 * `workspace_users` membership row in the SAME transaction. Humans run no
 * process, so there is nothing to stop. All publishes happen AFTER commit so a
 * rolled-back delete never emits a phantom event. Caller has already verified
 * the target is a non-owner human member.
 */
async function removeWorkspaceHumanMember(
  ctx: BackendContext,
  workspaces: WorkspaceRepo,
  conversations: ConversationRepo,
  messages: MessageRepo,
  input: {
    workspaceId: string;
    user: UserDto;
    actor: ConversationMemberAddedActorSnapshot;
  },
): Promise<void> {
  const targets = workspaceConversationsWithUser(
    conversations,
    input.workspaceId,
    input.user.id,
  );
  const member = conversationMemberAddedHumanSnapshot(input.user);
  const removed = removeWorkspaceMemberAndConversationRows(ctx, conversations, messages, {
    targets,
    actor: input.actor,
    member,
    removeWorkspaceMember: () =>
      workspaces.removeUserMember(input.workspaceId, input.user.id),
  });
  await publishWorkspaceMemberRemovalEffects(ctx, conversations, {
    removed,
    viewerEvent: { userId: input.user.id, workspaceId: input.workspaceId },
  });
}

/**
 * Workspace membership surface (api router): GET list + POST add + two DELETEs
 * (agent-remove and human-remove), as a mountable sub-app. GET is viewer-gated
 * (`canViewWorkspace`); POST is admin-gated for both human and agent adds
 * (agent branch delegates to the AddWorkspaceAgentMember use case).
 *
 * DELETE `…/members/:agentId` (agent) is admin-gated and stops + removes the
 * agent from every conversation of the workspace where it is actually present,
 * writes one `conversation_member_removed` system message per conversation,
 * then removes the workspace membership in the same DB transaction.
 *
 * DELETE `…/members/users/:userId` (human) is owner-gated (human-roster is
 * owner-only); the owner itself is never removable (`owner_removal_unsupported`
 * 400). Humans run no process, so it cascades `conversation_users` +
 * per-conversation removed messages + `workspace_users` in one transaction,
 * then publishes conversation/member-list updates plus `removed` to the viewer
 * scope post-commit. 204.
 */
export function createWorkspaceMembershipApp(
  deps: MembershipRouteDeps,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { ctx, agents, users, workspaces, conversations, messages } = deps;

  app.get(apiPaths.workspaceMembers(':id'), c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'workspace id required' }, 400);
    const workspace = workspaces.get(id);
    if (!workspace) return c.json({ error: 'workspace not found' }, 404);
    const principal = getUserPrincipal(c);
    if (!canViewWorkspace(ctx, principal, workspace.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const viewerRole = workspaceRole(ctx, principal, workspace.id);
    return c.json(
      workspaceMembersResponse(ctx, workspaces, workspace.id, viewerRole),
    );
  });

  app.post(apiPaths.workspaceMembers(':id'), async c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'workspace id required' }, 400);
    const workspace = workspaces.get(id);
    if (!workspace || workspace.workspace_kind !== 'regular') {
      return c.json({ error: 'workspace not found' }, 404);
    }
    const principal = getUserPrincipal(c);
    // Roster-write FLOOR: workspace membership. What is required ON TOP of it
    // depends on WHICH data the write touches, not on the verb — so the role
    // requirement is per-branch below rather than one constant `admin` here
    // (shiki 2026-07-27, ruling on Cindy's blocker):
    //
    //   - human member  → `admin` (the roster of PEOPLE is admin governance)
    //   - agent member  → membership ∧ `canEnrollAgent` (your own agent is
    //                     yours to bring; see the use case). No `admin` OR-arm:
    //                     enrollment is creator-only (#task:1681), so this is
    //                     NOT symmetric with the DELETE route below, where
    //                     `admin` does govern the whole roster.
    //
    // The floor still answers a non-member before the body is parsed, so a
    // stranger cannot probe input validity.
    if (!canGovernWorkspace(ctx, principal, workspace.id, 'member')) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = AddWorkspaceMemberInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    if ('kind' in parsed.data && parsed.data.kind === 'human') {
      // Human add stays ADMIN-gated: inviting a person is governance over the
      // workspace's people roster, and it carries no ownership factor that
      // could stand in for the role. New humans join as `member`
      // (addUserMember default); role changes/removal stay owner-only in their
      // dedicated routes.
      if (!canGovernWorkspace(ctx, principal, workspace.id, 'admin')) {
        return c.json({ error: 'forbidden' }, 403);
      }
      const user = ctx.userService.getDto(parsed.data.user_id);
      if (!user) return c.json({ error: 'user not found' }, 404);
      return c.json(
        addWorkspaceHumanMember(ctx, workspaces, {
          workspaceId: workspace.id,
          user,
        }),
        201,
      );
    }
    // Add an agent member: delegated to AddWorkspaceAgentMemberUseCase. The
    // route stays thin — parse + membership floor above, then map the typed
    // result. Placement, daemon L2 seed (ordered before the row), the
    // unit-of-work transaction, and the capability default-seed policy all live
    // in the use case. So does the enrollment gate (#task:1681,
    // `agent_not_owned`): the workspace role above governs WHOSE roster this
    // is, while placing a specific agent is its creator's authority. Any member
    // may bring their OWN agents — that is shiki's delegation flow ("invite the
    // human, they bring their agents"), which an admin-only roster write made
    // impossible since invitees join as plain `member`.
    const result = await addWorkspaceAgentMember(
      { ctx, agents, workspaces },
      {
        principal,
        workspace: {
          id: workspace.id,
          workspace_path: workspace.workspace_path,
          workspace_host_id: workspace.workspace_host_id,
        },
        agentId: parsed.data.agent_id,
      },
    );
    if (result.ok) return c.json({ member: result.member }, 201);
    switch (result.error.code) {
      case 'agent_not_found':
        return c.json({ error: 'agent not found' }, 404);
      case 'agent_not_owned':
        return c.json(
          {
            error:
              'you can only add agents you created — someone else\'s can be brought in only by its creator',
            code: 'agent_not_owned',
          },
          403,
        );
      case 'seed_failed':
        return c.json(
          { error: result.error.failure.message, code: result.error.failure.code },
          result.error.failure.status,
        );
    }
  });

  app.patch(apiPaths.workspaceHumanMemberRole(':id', ':userId'), async c => {
    const id = c.req.param('id');
    const userId = c.req.param('userId');
    if (!id || !userId) {
      return c.json({ error: 'workspace id and user id required' }, 400);
    }
    const workspace = workspaces.get(id);
    if (!workspace || workspace.workspace_kind !== 'regular') {
      return c.json({ error: 'workspace not found' }, 404);
    }
    if (!canGovernWorkspace(ctx, getUserPrincipal(c), workspace.id, 'owner')) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = UpdateWorkspaceHumanMemberRoleInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    if (parsed.data.role === 'owner') return ownerRoleChangeUnsupported(c);

    const currentRole = workspaces.getUserRole(workspace.id, userId);
    if (!currentRole) {
      return c.json({ error: 'workspace human member not found' }, 404);
    }
    if (currentRole === 'owner') return ownerRoleChangeUnsupported(c);

    const user = ctx.userService.getDto(userId);
    if (!user) return c.json({ error: 'workspace human member not found' }, 404);
    const result = updateWorkspaceHumanMemberRole(ctx, workspaces, {
      workspaceId: workspace.id,
      user,
      previousRole: currentRole,
      role: parsed.data.role,
    });
    if (!result) return c.json({ error: 'workspace human member not found' }, 404);
    return c.json(result);
  });

  app.delete(apiPaths.workspaceMember(':id', ':agentId'), async c => {
    const id = c.req.param('id');
    const agentId = c.req.param('agentId');
    if (!id || !agentId) {
      return c.json({ error: 'workspace id and agent id required' }, 400);
    }
    const workspace = workspaces.get(id);
    if (!workspace || workspace.workspace_kind !== 'regular') return c.body(null, 204);
    const principal = getUserPrincipal(c);
    // Roster-write FLOOR: workspace membership — same shape as the add route,
    // and for the same reason: what is required ON TOP of it follows the DATA.
    if (!canGovernWorkspace(ctx, principal, workspace.id, 'member')) {
      return c.json({ error: 'forbidden' }, 403);
    }
    // #task:1683 — removal is the symmetric half of enrollment (shiki
    // 2026-07-28): whoever may bring their own agent in may take it back out,
    // otherwise every plain member needs an admin to undo their own action.
    // `admin` keeps governance over the WHOLE agent roster (including agents it
    // may not enroll), so this is an OR, not a replacement.
    const isAdmin = canGovernWorkspace(ctx, principal, workspace.id, 'admin');
    if (!isAdmin && !canEnrollAgent(ctx, principal, agentId)) {
      // Also the answer for an unknown agent id from a plain member: ownership
      // is unprovable, so it fails closed instead of falling through to the
      // dangling-row cleanup below (which stays admin-only).
      // The message stays a NEUTRAL FACT: "who could do this instead" is a cell
      // of the permission matrix (§1.1), and the matrix is stated in one place —
      // the surface, which knows the viewer's role. A role name here would be a
      // second copy to keep true (three-way contract with @Norman/@Cindy,
      // 2026-07-28); the renderer maps the typed `code`, never this text.
      return c.json(
        {
          error: 'you can only remove agents you created',
          code: 'agent_not_owned',
        },
        403,
      );
    }
    const agent = agents.get(agentId);
    if (!agent) {
      workspaces.removeMember(workspace.id, agentId);
      return c.body(null, 204);
    }
    const targets = workspaceConversationsWithAgent(
      conversations,
      workspace.id,
      agentId,
    );
    for (const conversation of targets) {
      await ctx.runtimeHost
        .stop(conversation.id, agentId)
        .catch(err =>
          ctx.logger.warn(
            { conversationId: conversation.id, agentId, err },
            'workspace member remove: stop failed',
          ),
        );
    }
    const actor = conversationMemberAddedActorSnapshot({ agents, users }, principal);
    const member = conversationMemberAddedAgentSnapshot(agent);
    const removed = removeWorkspaceMemberAndConversationRows(ctx, conversations, messages, {
      targets,
      actor,
      member,
      removeWorkspaceMember: () => workspaces.removeMember(workspace.id, agentId),
    });
    await publishWorkspaceMemberRemovalEffects(ctx, conversations, { removed });
    return c.body(null, 204);
  });

  app.delete(apiPaths.workspaceHumanMember(':id', ':userId'), async c => {
    const id = c.req.param('id');
    const userId = c.req.param('userId');
    if (!id || !userId) {
      return c.json({ error: 'workspace id and user id required' }, 400);
    }
    const workspace = workspaces.get(id);
    if (!workspace || workspace.workspace_kind !== 'regular') {
      return c.json({ error: 'workspace not found' }, 404);
    }
    // Human removal is owner-only (mirrors role PATCH), unlike admin-gated
    // human add and agent remove.
    if (!canGovernWorkspace(ctx, getUserPrincipal(c), workspace.id, 'owner')) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const currentRole = workspaces.getUserRole(workspace.id, userId);
    if (!currentRole) {
      return c.json({ error: 'workspace human member not found' }, 404);
    }
    // The owner can never be removed: there must always be an owner and
    // ownership transfer is unsupported (same invariant as the role PATCH).
    // Owner-gating means the actor cannot remove themselves either.
    if (currentRole === 'owner') return ownerRemovalUnsupported(c);
    const user = ctx.userService.getDto(userId);
    if (!user) {
      return c.json({ error: 'workspace human member not found' }, 404);
    }
    const actor = conversationMemberAddedActorSnapshot(
      { agents, users },
      getUserPrincipal(c),
    );
    await removeWorkspaceHumanMember(ctx, workspaces, conversations, messages, {
      workspaceId: workspace.id,
      user,
      actor,
    });
    return c.body(null, 204);
  });

  return app;
}

/**
 * Conversation membership surface (api router): GET list + POST add + DELETE
 * remove, as a mountable sub-app. Returns a `Hono` registering
 * GET-then-POST-then-DELETE. GET is viewer-gated (`canViewConversation`);
 * POST auth lives inside the AddConversationMember use case; DELETE delegates
 * to the pure `removeConversationMember` use case, which owns the
 * anti-enumeration role gate, atomic removeAgent/system-message write, and
 * post-commit events. The handler only parses principal/params and maps the
 * typed result to HTTP.
 */
export function createConversationMembershipApp(
  deps: MembershipRouteDeps,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const {
    ctx,
    agents,
    users,
    workspaces,
    conversations,
    messages,
    channelAttentionPrefs,
    membership,
  } = deps;

  app.get(apiPaths.conversationMembers(':id'), c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'conversation id required' }, 400);
    const conversation = conversations.get(id);
    if (!conversation) return c.json({ error: 'conversation not found' }, 404);
    if (!canViewConversation(ctx, getUserPrincipal(c), conversation.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const members = membership.listMembers(conversation.id);
    return c.json({ members });
  });

  app.post(apiPaths.conversationMembers(':id'), async c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'conversation id required' }, 400);
    const body = await c.req.json().catch(() => ({}));
    const parsed = AddConversationMemberInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const result = await addConversationMember({
      ctx,
      agents,
      users,
      workspaces,
      conversations,
      messages,
      channelAttentionPrefs,
      membership,
    }, {
      conversationId: id,
      principal: getPrincipal(c),
      member: parsed.data,
    });
    return conversationMemberResultResponse(c, result);
  });

  // Self-join a PUBLIC channel. The only non-member channel
  // mutation: a workspace human pulls THEMSELVES in. Empty body — the caller is
  // ALWAYS the joined member (`getUserPrincipal`), so there is no target on the
  // wire to forge. Admission + membership transition + idempotency live in the
  // `joinPublicChannel` use case; the handler only maps the typed result to a
  // `{channel, is_member:true}` envelope IDENTICAL to GET channel detail, so the
  // client backfills its cache uniformly on first join and idempotent retry.
  app.post(apiPaths.channelJoin(':id'), async c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'channel id required' }, 400);
    const principal = getUserPrincipal(c);
    const result = await joinPublicChannel(
      { ctx, conversations, messages, channelAttentionPrefs },
      { conversationId: id, principal },
    );
    if (!result.ok) {
      switch (result.error.code) {
        case 'channel_not_found':
          return c.json({ error: 'channel not found' }, 404);
        case 'forbidden':
          return c.json({ error: 'forbidden' }, 403);
      }
    }
    const channel = conversations.getChannelLike(id);
    if (!channel) return c.json({ error: 'channel not found' }, 404);
    // Same envelope as GET channel detail (incl. the capability carriers) so the
    // client backfills its cache uniformly on first join / idempotent retry.
    return c.json(buildChannelDetailResponse(ctx, conversations, principal, channel));
  });

  // Self-LEAVE a channel — the symmetric counterpart of `/join`. A human member
  // removes THEMSELVES (empty body, no forgeable target). Member-only + the
  // archived / owner-of-private / last-human-of-private guards live in the
  // `leaveChannel` use case;
  // the handler maps the typed reason to a status and returns the SAME
  // channel-detail envelope so the client backfills `is_member: false` (public →
  // renderer collapses to Join; private → the channel drops from discovery and
  // detail 403s, so the client routes away via read-path validation).
  app.post(apiPaths.channelLeave(':id'), async c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'channel id required' }, 400);
    const principal = getUserPrincipal(c);
    const result = await leaveChannel(
      { ctx, conversations },
      { conversationId: id, principal },
    );
    if (!result.ok) {
      switch (result.error.code) {
        case 'channel_not_found':
          return c.json({ error: 'channel not found' }, 404);
        case 'not_member':
          return c.json({ error: 'not a member of this channel', code: 'not_member' }, 403);
        case 'channel_archived':
          return c.json(
            { error: 'cannot leave an archived channel', code: 'channel_archived' },
            409,
          );
        case 'channel_owner':
          return c.json(
            {
              error: 'cannot leave as the owner of a private channel',
              code: 'channel_owner',
            },
            409,
          );
        case 'last_human_member':
          return c.json(
            {
              error: 'cannot leave as the last member of a private channel',
              code: 'last_human_member',
            },
            409,
          );
      }
    }
    const channel = conversations.getChannelLike(id);
    if (!channel) return c.json({ error: 'channel not found' }, 404);
    return c.json(buildChannelDetailResponse(ctx, conversations, principal, channel));
  });

  app.delete(apiPaths.conversationAgentMember(':id', ':agentId'), async c => {
    const id = c.req.param('id');
    const agentId = c.req.param('agentId');
    if (!id || !agentId) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    const result = await removeConversationMember({
      ctx,
      agents,
      users,
      conversations,
      messages,
      membership,
    }, {
      conversationId: id,
      principal: getUserPrincipal(c),
      agentId,
    });
    if (result.ok) return c.json({ members: result.members });
    switch (result.error.code) {
      case 'conversation_not_found':
        return c.json({ error: 'conversation not found' }, 404);
      case 'unsupported':
        return c.json(
          {
            error: 'conversation members can only be removed from channels or threads',
            code: 'conversation_member_remove_unsupported',
          },
          422,
        );
      case 'conversation_closed':
        return c.json({ error: 'conversation is closed', code: 'conversation_closed' }, 409);
      case 'forbidden':
        return c.json({ error: 'forbidden' }, 403);
      case 'candidate_not_found':
        return c.json({ error: 'agent not found', code: 'candidate_not_found' }, 404);
      default: {
        const _exhaustive: never = result.error;
        return _exhaustive;
      }
    }
  });

  return app;
}

/**
 * Capability-guard port. The internal agent-add gates on
 * `manage_conversation_members`, but the capability primitive `requireAgentCapability`
 * is a cross-cutting concern owned by the capability context, not membership.
 * Membership depends on it as an injected port so this file does not import the
 * provider directly.
 */
export type RequireAgentCapability = (
  c: Context,
  ctx: BackendContext,
  principal: Principal,
  capability: AgentCapability,
  workspaceId: string | null | undefined,
) => Response | null;

export interface InternalMembershipRouteDeps extends MembershipRouteDeps {
  requireAgentCapability: RequireAgentCapability;
}

/**
 * Internal (agent-initiated) conversation member add (internal router), as a
 * mountable sub-app. Returns a `Hono` registering the by-handle add, gated by the
 * injected `manage_conversation_members` capability check, then delegating to the
 * AddConversationMember use case. The internal app's param-scoped agent-token
 * auth + `getAgentPrincipal` middleware wrap the mounted route; `:cid/:aid`
 * param extraction survives the mount.
 */
export function createInternalMembershipApp(
  deps: InternalMembershipRouteDeps,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const {
    ctx,
    agents,
    users,
    workspaces,
    conversations,
    messages,
    channelAttentionPrefs,
    membership,
    requireAgentCapability,
  } = deps;

  app.post(internalPaths.agentAddConversationMember(':cid', ':aid'), async c => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = AddConversationMemberByHandleInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const principal = getAgentPrincipal(c);
    {
      const denied = requireAgentCapability(c, ctx, principal, 'manage_conversation_members',
        conversations.get(principal.conversationId)?.workspace_id);
      if (denied) return denied;
    }
    const result = await addConversationMember({
      ctx,
      agents,
      users,
      workspaces,
      conversations,
      messages,
      channelAttentionPrefs,
      membership,
    }, {
      conversationId: principal.conversationId,
      principal,
      member: parsed.data,
    });
    return conversationMemberResultResponse(c, result);
  });

  return app;
}
