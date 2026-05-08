import { join } from 'node:path';
import type { ConversationDto, WorkspaceDto } from '@silverhand/shared';
import { describe, expect, it } from 'vitest';

import { activeAgentProfileDir } from '../src/agent-profile.js';

function conversation(workspacePath: string): ConversationDto {
  return { workspace_path: workspacePath } as ConversationDto;
}

function workspace(kind: WorkspaceDto['workspace_kind']): WorkspaceDto {
  return { workspace_kind: kind } as WorkspaceDto;
}

describe('activeAgentProfileDir', () => {
  it('uses L2 under regular workspace roots', () => {
    const profile = activeAgentProfileDir(
      conversation('/work/ws'),
      workspace('regular'),
      'agent-1',
    );

    expect(profile.absoluteDir).toBe(
      join('/work/ws', '.silverhand', 'agents', 'agent-1'),
    );
    expect(profile.promptDir).toBe('./.silverhand/agents/agent-1');
  });

  it('uses the agent-home workspace path directly for DM profiles', () => {
    const profile = activeAgentProfileDir(
      conversation('/state/agents/agent-1'),
      workspace('agent_home'),
      'agent-1',
    );

    expect(profile.absoluteDir).toBe('/state/agents/agent-1');
    expect(profile.promptDir).toBe('.');
  });
});
