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
  // v1 has no human workspace-membership table yet. User access is an
  // existence check; multi-human ACLs replace this implementation later.
  if (!workspaceExists(ctx, workspaceId)) return false;
  if (principal.kind === 'system') return true;
  if (principal.kind === 'user') return true;

  const conversation = conversationRepo(ctx).get(principal.conversationId);
  if (!conversation) return false;
  if (conversation.workspace_id !== workspaceId) return false;
  return conversationRepo(ctx).getAgent(
    principal.conversationId,
    principal.agentId,
  ) !== null;
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
  if (principal.kind !== 'agent') return true;
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
      principal.userId !== null &&
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
  return principal.userId !== null && principal.userId === targetUserId;
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
