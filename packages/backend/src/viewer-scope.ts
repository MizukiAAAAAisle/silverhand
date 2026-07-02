import type { UnreadUpdatedMessagePayload } from '@silverhand/shared';
import type { ConversationRepo } from './repos/conversation-repo.js';
import type { ConversationReadRepo } from './repos/conversation-read-repo.js';
import type { ScopeEventBus } from './ws/scope-event-bus.js';

export function conversationViewerUserIds(
  conversations: ConversationRepo,
  conversationId: string,
): string[] {
  return conversations.listUsers(conversationId).map(member => member.user_id);
}

export function singleConversationViewerUserId(
  conversations: ConversationRepo,
  conversationId: string,
): string | null {
  const ids = conversationViewerUserIds(conversations, conversationId);
  return ids.length === 1 ? ids[0]! : null;
}

export function publishToConversationViewers(
  events: ScopeEventBus,
  conversations: ConversationRepo,
  conversationId: string,
  kind: string,
  payload: unknown,
): void {
  for (const userId of conversationViewerUserIds(conversations, conversationId)) {
    events.publishToScope(`viewer:${userId}`, kind, payload);
  }
}

/** Build the authoritative `unread_updated` MESSAGE-variant payload for ONE
 *  viewer (#task:1283). All values are absolute, from the same
 *  `ConversationReadRepo` REST serves — the client patches badges instead of
 *  refetching. `workspaceId` is passed in (the caller already holds the
 *  conversation) so this stays a pure per-(viewer,conversation) build with no
 *  extra conversation lookup. Uses the single-workspace rollup helper — never an
 *  all-workspaces scan (B4 cost gate). See docs/projection-recovery-s1-unread-v1.md. */
export function buildUnreadUpdatedMessagePayload(
  reads: ConversationReadRepo,
  conversationId: string,
  workspaceId: string,
  viewerUserId: string,
): UnreadUpdatedMessagePayload {
  return {
    conversation_id: conversationId,
    workspace_id: workspaceId,
    conversation_unread_count: reads.unreadCountForConversation(
      conversationId,
      viewerUserId,
    ),
    workspace_unread_count: reads.unreadCountForWorkspace(
      workspaceId,
      viewerUserId,
    ),
    latest_unread: reads.latestUnreadForConversation(
      conversationId,
      viewerUserId,
    ),
  };
}

export function publishUnreadUpdatedToConversationViewers(
  events: ScopeEventBus,
  conversations: ConversationRepo,
  reads: ConversationReadRepo,
  conversationId: string,
): void {
  const conversation = conversations.get(conversationId);
  if (!conversation) return;
  const workspaceId = conversation.workspace_id;
  // Per-viewer: unread is viewer-specific, so the payload is computed inside the
  // loop (never one payload reused across viewers). The frame rides the
  // per-viewer `viewer:<id>` scope, so per-viewer absolutes carry no
  // broadcast-invariant risk (#task:1283).
  for (const userId of conversationViewerUserIds(conversations, conversationId)) {
    events.publishToScope(
      `viewer:${userId}`,
      'unread_updated',
      buildUnreadUpdatedMessagePayload(reads, conversationId, workspaceId, userId),
    );
  }
}
