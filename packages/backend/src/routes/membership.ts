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
import { canGovernWorkspace, canViewConversation, canViewWorkspace, workspaceRole } from '../permissions.js';
import { AgentRepo } from '../repos/agent-repo.js';
import { UserRepo } from '../repos/user-repo.js';
import { WorkspaceRepo } from '../repos/workspace-repo.js';
import { ConversationRepo } from '../repos/conversation-repo.js';
import { MessageRepo } from '../repos/message-repo.js';
import { MembershipService } from '../services/membership-service.js';
import { addWorkspaceAgentMember } from '../application/add-workspace-agent-member.js';
import {
  addConversationMember,
  removeConversationMember,
} from '../application/conversation-member.js';
import { placementErrorResponse, conversationMemberResultResponse } from './responses.js';

export interface MembershipRouteDeps {
  ctx: BackendContext;
  agents: AgentRepo;
  users: UserRepo;
  workspaces: WorkspaceRepo;
  conversations: ConversationRepo;
  messages: MessageRepo;
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

/**
 * Remove a human member from a workspace. Mirrors the agent-remove cascade
 * (`app.delete` below): drops the user's `conversation_users` row in every
 * conversation of the workspace, then the `workspace_users` membership row.
 * Humans run no process, so there is nothing to stop. The two-table cascade
 * runs in ONE transaction so a mid-sequence failure can't leave the user
 * half-removed (orphan `conversation_users` with no `workspace_users`). The
 * `removed` publish happens AFTER commit so a rolled-back delete never emits
 * a phantom event (same post-commit discipline as create-workspace). Caller
 * has already verified the target is a non-owner human member.
 */
function removeWorkspaceHumanMember(
  ctx: BackendContext,
  workspaces: WorkspaceRepo,
  conversations: ConversationRepo,
  input: { workspaceId: string; userId: string },
): void {
  ctx.db.transaction(() => {
    for (const conversation of conversations.list()) {
      if (conversation.workspace_id !== input.workspaceId) continue;
      conversations.removeUser(conversation.id, input.userId);
    }
    workspaces.removeUserMember(input.workspaceId, input.userId);
  })();
  publishViewerWorkspacesChanged(ctx, input.userId, {
    change: 'removed',
    workspace_id: input.workspaceId,
  });
}

/**
 * Workspace membership surface (api router): GET list + POST add + two DELETEs
 * (agent-remove and human-remove), as a mountable sub-app. GET is viewer-gated
 * (`canViewWorkspace`); POST is admin-gated, human branch escalates to owner,
 * agent branch delegates to the AddWorkspaceAgentMember use case.
 *
 * DELETE `…/members/:agentId` (agent) is admin-gated and stops + removes the
 * agent from every conversation of the workspace, then removes the workspace
 * membership. It stays best-effort (per-conversation stop + removeAgent, then
 * removeMember, 204 — no tx / system message / event; a use-case version is a
 * future increment).
 *
 * DELETE `…/members/users/:userId` (human) is owner-gated (human-roster is
 * owner-only); the owner itself is never removable (`owner_removal_unsupported`
 * 400). Humans run no process, so it just cascades `conversation_users` +
 * `workspace_users` in one transaction, then publishes `removed` to the
 * viewer scope post-commit. 204.
 */
export function createWorkspaceMembershipApp(
  deps: MembershipRouteDeps,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { ctx, agents, workspaces, conversations } = deps;

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
    if (!canGovernWorkspace(ctx, getUserPrincipal(c), workspace.id, 'admin')) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = AddWorkspaceMemberInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    if ('kind' in parsed.data && parsed.data.kind === 'human') {
      // Human-roster control is owner-only. The entry gate above is `admin`
      // (covers the agent-member-add path); adding a HUMAN member escalates to
      // an inner owner check. New humans join as `member` (addUserMember default).
      if (!canGovernWorkspace(ctx, getUserPrincipal(c), workspace.id, 'owner')) {
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
    // route stays thin — parse + admin gate above, then map the typed result.
    // Placement, daemon L2 seed (ordered before the row), the unit-of-work
    // transaction, and the capability default-seed policy all live in the use case.
    const result = await addWorkspaceAgentMember(
      { ctx, agents, workspaces },
      {
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
      case 'placement': {
        const mapped = placementErrorResponse(c, result.error.cause);
        if (mapped) return mapped;
        throw result.error.cause;
      }
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
    if (!canGovernWorkspace(ctx, getUserPrincipal(c), workspace.id, 'admin')) {
      return c.json({ error: 'forbidden' }, 403);
    }
    for (const conversation of conversations.list()) {
      if (conversation.workspace_id !== workspace.id) continue;
      await ctx.runtimeHost
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

  app.delete(apiPaths.workspaceHumanMember(':id', ':userId'), c => {
    const id = c.req.param('id');
    const userId = c.req.param('userId');
    if (!id || !userId) {
      return c.json({ error: 'workspace id and user id required' }, 400);
    }
    const workspace = workspaces.get(id);
    if (!workspace || workspace.workspace_kind !== 'regular') {
      return c.json({ error: 'workspace not found' }, 404);
    }
    // Human-roster management is owner-only (mirrors human add `:213` and
    // role PATCH above), unlike the admin-gated agent-remove.
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
    removeWorkspaceHumanMember(ctx, workspaces, conversations, {
      workspaceId: workspace.id,
      userId,
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
  const { ctx, agents, users, workspaces, conversations, messages, membership } = deps;

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
      membership,
    }, {
      conversationId: id,
      principal: getPrincipal(c),
      member: parsed.data,
    });
    return conversationMemberResultResponse(c, result);
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
