import { conversationScope, conversationSideScope } from "@silverhand/shared";

export function wsConversationScope(conversationId: string): string {
  return conversationScope(conversationId);
}

/** Side-channel transport scope for a conversation (agent_status / activity /
 *  members) — the recovery-class-partitioned sibling of {@link
 *  wsConversationScope}. Delegates to the shared grammar so backend publish and
 *  renderer subscribe never drift (#task:1255 P2 step-3). */
export function wsConversationSideScope(conversationId: string): string {
  return conversationSideScope(conversationId);
}
