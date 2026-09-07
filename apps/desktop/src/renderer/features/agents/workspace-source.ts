import type { AgentDto } from '@silverhand/shared';
import type { AgentWorkspaceSource } from './hooks';

export const AGENT_HOME_SOURCE: AgentWorkspaceSource = { kind: 'home' };

export function sideAgentWorkspaceSource(
  sessionScope: AgentDto['session_scope'],
  workspaceId: string | null,
): AgentWorkspaceSource {
  if (sessionScope === 'agent' || !workspaceId) {
    return AGENT_HOME_SOURCE;
  }

  return { kind: 'workspace', workspaceId };
}
