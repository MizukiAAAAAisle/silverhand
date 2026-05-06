import { ConversationRepo } from '../repos/conversation-repo.js';
import type { BackendContext } from '../context.js';
import { WorkspaceRepo } from '../repos/workspace-repo.js';

export type ParsedWsScope =
  | { type: 'app'; scope: 'app' }
  | { type: 'workspace'; scope: string; workspaceId: string }
  | { type: 'conversation'; scope: string; conversationId: string }
  | { type: 'viewer'; scope: string; viewerUserId: string };

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
  _viewerUserId: string,
  workspaceId: string,
): boolean {
  // v1 has no human workspace-membership table yet. Keep the permission
  // decision behind this function so multi-human ACLs can replace it without
  // changing the WS transport.
  return new WorkspaceRepo(ctx.db, { workspacesRoot: ctx.workspacesRoot }).get(workspaceId) !== null;
}

export function canViewConversation(
  ctx: BackendContext,
  viewerUserId: string,
  conversationId: string,
): boolean {
  const conversation = new ConversationRepo(ctx.db).get(conversationId);
  if (!conversation) return false;
  return canViewWorkspace(ctx, viewerUserId, conversation.workspace_id);
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
  switch (scope.type) {
    case 'app':
      return true;
    case 'workspace':
      return canViewWorkspace(ctx, viewerUserId, scope.workspaceId);
    case 'conversation':
      return canViewConversation(ctx, viewerUserId, scope.conversationId);
    case 'viewer':
      return canSubscribeViewer(viewerUserId, scope.viewerUserId);
  }
}
