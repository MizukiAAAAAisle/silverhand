import { apiPaths, type AgentDto } from '@silverhand/shared';

/** Select the public clear-session address from immutable runtime ownership.
 * AgentSlot deliberately ignores the currently rendered conversation; a
 * ConversationSlot must retain it as part of semantic identity. */
export function clearAgentSessionPath(input: {
  agentId: string;
  sessionScope: AgentDto['session_scope'];
  conversationId: string | null;
}): string {
  if (input.sessionScope === 'agent') {
    return apiPaths.agentClearSession(input.agentId);
  }
  if (!input.conversationId) {
    throw new Error('no channel selected');
  }
  return apiPaths.channelAgentClearSession(
    input.conversationId,
    input.agentId,
  );
}
