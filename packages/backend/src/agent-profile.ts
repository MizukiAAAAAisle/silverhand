import { join } from 'node:path';
import type { ConversationDto, WorkspaceDto } from '@silverhand/shared';

export interface ActiveAgentProfile {
  absoluteDir: string;
  promptDir: string;
}

/**
 * The L2 working profile directory for `(workspace, agent)` — the place
 * where MEMORY.md / notes/ live. Used as the agent's "active profile" in
 * the platform prompt. **Note**: in the current four-file model
 * (system_prompt at L1, MEMORY/notes/CONSENSUS at L2), `system_prompt.md`
 * is no longer materialized inside this directory; the role contract is
 * read from L1 by the system-prompt assembler.
 */
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

/**
 * Absolute path to `{silverhandDir}/agents/{agentId}` — the L1 (agent
 * global) profile directory. The canonical role contract
 * (`system_prompt.md`) lives here and is shared across every workspace
 * the agent participates in.
 */
export function agentL1ProfileDir(silverhandDir: string, agentId: string): string {
  return join(silverhandDir, 'agents', agentId);
}

/**
 * Absolute path to `(workspace, agent)`'s memory directory — the L2
 * working copy carrying MEMORY.md and notes/. Identical to
 * `activeAgentProfileDir(...).absoluteDir` but addressable without a
 * conversation in hand (used when building the workspace memory index
 * for cross-workspace path injection).
 */
export function agentMemoryDirFor(workspace: WorkspaceDto, agentId: string): string {
  if (workspace.workspace_kind === 'agent_home') return workspace.workspace_path;
  return join(workspace.workspace_path, '.silverhand', 'agents', agentId);
}
