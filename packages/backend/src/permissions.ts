import type { AttachmentRow } from '@silverhand/shared';
import type { BackendContext } from './context.js';
import type { Principal, UserPrincipal } from './auth/principal.js';
import { ConversationRepo } from './repos/conversation-repo.js';
import { WorkspaceRepo } from './repos/workspace-repo.js';

export type ParsedWsScope =
  | { type: 'app'; scope: 'app' }
  | { type: 'workspace'; scope: string; workspaceId: string }
  | { type: 'conversation'; scope: string; conversationId: string }
  | { type: 'viewer'; scope: string; viewerUserId: string };

export type AttachmentAclRow = Pick<
  AttachmentRow,
  'channel_id' | 'created_by_kind' | 'created_by_id'
>;

function workspaceRepo(ctx: BackendContext): WorkspaceRepo {
  return new WorkspaceRepo(ctx.db, { workspacesRoot: ctx.workspacesRoot });
}

function conversationRepo(ctx: BackendContext): ConversationRepo {
  return new ConversationRepo(ctx.db);
}

function workspaceExists(ctx: BackendContext, workspaceId: string): boolean {
  return workspaceRepo(ctx).get(workspaceId) !== null;
}

function principalConversationChannelId(
  ctx: BackendContext,
  principal: Principal,
): string | null {
  if (principal.kind !== 'agent') return null;
  const repo = conversationRepo(ctx);
  const conversation = repo.get(principal.conversationId);
  if (!conversation) return null;
  if (!repo.getAgent(conversation.id, principal.agentId)) return null;
  return conversation.kind === 'thread'
    ? conversation.parent_conversation_id
    : conversation.id;
}

export function parseWsScope(scope: string, viewerUserId: string): ParsedWsScope | null {
  if (scope === 'app') return { type: 'app', scope: 'app' };

  const splitAt = scope.indexOf(':');
  if (splitAt <= 0) return null;
  const prefix = scope.slice(0, splitAt);
  const rawId = scope.slice(splitAt + 1);
  if (!rawId) return null;

  if (prefix === 'workspace') {
    const normalized = `workspace:${rawId}`;
    return { type: 'workspace', scope: normalized, workspaceId: rawId };
  }
  if (prefix === 'conversation') {
    const normalized = `conversation:${rawId}`;
    return { type: 'conversation', scope: normalized, conversationId: rawId };
  }
  if (prefix === 'viewer') {
    const resolvedViewerId = rawId === 'self' ? viewerUserId : rawId;
    return {
      type: 'viewer',
      scope: `viewer:${resolvedViewerId}`,
      viewerUserId: resolvedViewerId,
    };
  }
  return null;
}

export function canViewWorkspace(
  ctx: BackendContext,
  principal: Principal,
  workspaceId: string,
): boolean {
  if (!workspaceExists(ctx, workspaceId)) return false;
  if (principal.kind === 'system') return true;
  if (principal.kind === 'user') {
    // v25: humans are real workspace members. The viewer is added
    // to every existing workspace at register time (UserService.register
    // backfill) and to every new workspace at creation; v25 migration
    // also retroactively backfilled DBs that registered before this
    // table existed. Any user not in `workspace_users` for the queried
    // workspace is denied here. Multi-human v2 will use this same
    // gate — invite flows simply add another user to `workspace_users`.
    return workspaceRepo(ctx).isUserMember(workspaceId, principal.userId);
  }

  const conversation = conversationRepo(ctx).get(principal.conversationId);
  if (!conversation) return false;
  if (conversation.workspace_id !== workspaceId) return false;
  return conversationRepo(ctx).getAgent(
    principal.conversationId,
    principal.agentId,
  ) !== null;
}

/**
 * Cross-conversation workspace access for agent principals. Unlike
 * `canViewWorkspace`, this does NOT require the principal's source
 * conversation to belong to the queried workspace — it answers the
 * broader "is this agent a member of this workspace at all?"
 * question. Used by cross-workspace MCP tools (`list_workspaces`,
 * `list_channels?workspace_id=…`).
 *
 * Truth source: `WorkspaceRepo.listForAgent` (regular workspaces via
 * `workspace_members` ∪ owned `agent_home`). The v17 trigger already
 * keeps `workspace_members` agent_home-free, so ownership is the only
 * way an agent reaches its own home.
 */
export function canAgentAccessWorkspace(
  ctx: BackendContext,
  agentId: string,
  workspaceId: string,
): boolean {
  return workspaceRepo(ctx)
    .listForAgent(agentId)
    .some(w => w.id === workspaceId);
}

export function canMutateWorkspace(
  ctx: BackendContext,
  principal: Principal,
  workspaceId: string,
): boolean {
  if (!canViewWorkspace(ctx, principal, workspaceId)) return false;
  return principal.kind !== 'agent';
}

export function canManageMembers(
  ctx: BackendContext,
  principal: Principal,
  workspaceId: string,
): boolean {
  return canMutateWorkspace(ctx, principal, workspaceId);
}

export function canViewConversation(
  ctx: BackendContext,
  principal: Principal,
  conversationId: string,
): boolean {
  const conversation = conversationRepo(ctx).get(conversationId);
  if (!conversation) return false;
  if (!canViewWorkspace(ctx, principal, conversation.workspace_id)) return false;
  if (principal.kind === 'system') return true;
  if (principal.kind === 'user') {
    // v25: human conversation membership. Workspace check passed
    // above (so we know the user is a workspace member); now also
    // require explicit `conversation_users` membership for the
    // specific channel/thread. Channels are seeded from
    // `workspace_users` at creation; threads inherit from the parent
    // conversation. v25 migration backfilled both for already-
    // registered DBs.
    return conversationRepo(ctx).getUser(conversation.id, principal.userId)
      !== null;
  }
  if (principal.conversationId !== conversation.id) return false;
  return conversationRepo(ctx).getAgent(conversation.id, principal.agentId) !== null;
}

export function canPostToConversation(
  ctx: BackendContext,
  principal: Principal,
  conversationId: string,
): boolean {
  if (!canViewConversation(ctx, principal, conversationId)) return false;
  return true;
}

export function canViewAttachment(
  ctx: BackendContext,
  principal: Principal,
  attachment: AttachmentAclRow,
): boolean {
  if (principal.kind === 'agent') {
    return principalConversationChannelId(ctx, principal) === attachment.channel_id;
  }
  return canViewConversation(ctx, principal, attachment.channel_id);
}

export function canDeleteAttachment(
  ctx: BackendContext,
  principal: Principal,
  attachment: AttachmentAclRow,
): boolean {
  if (!canViewAttachment(ctx, principal, attachment)) return false;
  if (principal.kind === 'system') return true;
  if (principal.kind === 'user') {
    return (
      attachment.created_by_kind === 'user' &&
      attachment.created_by_id === principal.userId
    );
  }
  return (
    attachment.created_by_kind === 'agent' &&
    attachment.created_by_id === principal.agentId
  );
}

export function canViewOwnedState(
  _ctx: BackendContext,
  principal: Principal,
  targetUserId: string,
): boolean {
  if (principal.kind === 'system') return true;
  if (principal.kind !== 'user') return false;
  return principal.userId === targetUserId;
}

export function canSubscribeViewer(
  viewerUserId: string,
  scopeViewerUserId: string,
): boolean {
  return viewerUserId === scopeViewerUserId;
}

export function canSubscribeScope(
  ctx: BackendContext,
  viewerUserId: string,
  scope: ParsedWsScope,
): boolean {
  const principal: UserPrincipal = { kind: 'user', userId: viewerUserId };
  switch (scope.type) {
    case 'app':
      return true;
    case 'workspace':
      return canViewWorkspace(ctx, principal, scope.workspaceId);
    case 'conversation':
      return canViewConversation(ctx, principal, scope.conversationId);
    case 'viewer':
      return canViewOwnedState(ctx, principal, scope.viewerUserId);
  }
}
