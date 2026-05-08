import { join } from 'node:path';
import type { ConversationDto, WorkspaceDto } from '@silverhand/shared';

export interface ActiveAgentProfile {
  absoluteDir: string;
  promptDir: string;
}

export function activeAgentProfileDir(
  conversation: ConversationDto,
  workspace: WorkspaceDto,
  agentId: string,
): ActiveAgentProfile {
  if (workspace.workspace_kind === 'agent_home') {
    return { absoluteDir: conversation.workspace_path, promptDir: '.' };
  }
  return {
    absoluteDir: join(conversation.workspace_path, '.silverhand', 'agents', agentId),
    promptDir: `./.silverhand/agents/${agentId}`,
  };
}
