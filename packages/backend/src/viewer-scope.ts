import type { ConversationRepo } from './repos/conversation-repo.js';
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

export function publishUnreadUpdatedToConversationViewers(
  events: ScopeEventBus,
  conversations: ConversationRepo,
  conversationId: string,
): void {
  publishToConversationViewers(
    events,
    conversations,
    conversationId,
    'unread_updated',
    { conversation_id: conversationId },
  );
}
