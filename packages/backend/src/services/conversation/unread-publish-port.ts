/**
 * Post-commit unread publication — the effect contract shared by every writer
 * that changes what a conversation's human viewers should see (message send,
 * archive/unarchive, …).
 *
 * It lives in its own driver-free module rather than inside one domain's port
 * file because it belongs to neither: the channel domain and the message domain
 * both depend on it, and neither owns it. The implementation (badge read-model
 * + unread read-model + viewer resolution) is an adapter detail on purpose —
 * `unread_updated` and its co-emitted tiered badge must never be emitted
 * separately (#task:1870), so callers get exactly one method.
 *
 * By construction this is NOT reachable from any `TxScope`: publishing inside
 * a transaction would announce state that may still roll back (#task:1981 §6).
 */
export interface ConversationUnreadPublishPort {
  publishUnreadUpdatedToConversationViewers(conversationId: string): void;
}

/**
 * The same effect directed at ONE viewer, for writers that already know whose
 * unread moved (the cross-channel mention cc: it inserts into a DM whose only
 * human is the mention's author). Separate interface rather than a second
 * method on the port above, so a caller that needs one is not handed the other
 * — and, for the same #task:1870 reason, still exactly one method: the tiered
 * badge rides along with `unread_updated`.
 */
export interface ConversationViewerUnreadPublishPort {
  publishUnreadUpdatedToViewer(
    conversationId: string,
    workspaceId: string,
    viewerUserId: string,
  ): void;
}
