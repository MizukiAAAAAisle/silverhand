import type {
  AttentionBadgeUpdatedPayload,
  UnreadUpdatedMessagePayload,
} from '@silverhand/shared';
import type { AttentionBadgeRepo } from './repos/attention-badge-repo.js';
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
 *  all-workspaces scan (B4 cost gate). See docs/projection-recovery-s1-unread-v1.md.
 *
 *  DELIBERATELY NOT EXPORTED (#task:1870): the tiered badge is a function of the
 *  same facts and the client never refetches it on its own schedule (no polling,
 *  no focus refetch), so an emit path that ships this payload WITHOUT the badge
 *  frame does not open a transient window — it freezes the badge at a wrong value
 *  until a remount / reconnect / unrelated invalidation happens to arrive. Keeping the builder module-private makes
 *  {@link publishUnreadUpdatedToViewer} the only way to emit it, so co-emission
 *  is enforced by the module boundary instead of by every caller remembering. */
function buildUnreadUpdatedMessagePayload(
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

/**
 * Emit the ABSOLUTE tiered badge for ONE (viewer, workspace) (#task:1870).
 *
 * Absolute, never a delta, for the same reason `unread_updated` is: the client
 * patches its roll-up cache from this value, so a missed frame must be
 * self-correcting on the next one. Single-workspace by design — a message
 * arrival fans out to K viewers, so the emitted value must not cost an
 * all-workspace scan per viewer.
 *
 * Exported on its own because two of the three authoritative update sources
 * change the badge WITHOUT changing positional unread: a preference write on
 * either attention aggregate, and a directed notification being inserted or
 * marked read.
 */
export function publishAttentionBadgeUpdated(
  events: ScopeEventBus,
  badges: AttentionBadgeRepo,
  workspaceId: string,
  viewerUserId: string,
): void {
  const payload: AttentionBadgeUpdatedPayload = {
    workspace_id: workspaceId,
    badge_count: badges.badgeCountForWorkspace(viewerUserId, workspaceId),
  };
  events.publishToScope(`viewer:${viewerUserId}`, 'attention_badge_updated', payload);
}

/**
 * Emit the `unread_updated` MESSAGE variant AND the tiered badge for ONE viewer.
 * The single seam for "this viewer's unread in this conversation changed": both
 * frames describe the same committed facts, so they are emitted together rather
 * than left to two independent call sites (see
 * {@link buildUnreadUpdatedMessagePayload} on why a missing badge frame is a
 * PERMANENT wrong state, not a transient one).
 *
 * Callers MUST be post-commit: both payloads read committed state.
 */
export function publishUnreadUpdatedToViewer(
  events: ScopeEventBus,
  badges: AttentionBadgeRepo,
  reads: ConversationReadRepo,
  conversationId: string,
  workspaceId: string,
  viewerUserId: string,
): void {
  events.publishToScope(
    `viewer:${viewerUserId}`,
    'unread_updated',
    buildUnreadUpdatedMessagePayload(
      reads,
      conversationId,
      workspaceId,
      viewerUserId,
    ),
  );
  publishAttentionBadgeUpdated(events, badges, workspaceId, viewerUserId);
}

export function publishUnreadUpdatedToConversationViewers(
  events: ScopeEventBus,
  badges: AttentionBadgeRepo,
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
    publishUnreadUpdatedToViewer(
      events,
      badges,
      reads,
      conversationId,
      workspaceId,
      userId,
    );
  }
}
