import { join } from 'node:path';
import type { RuntimeKind } from '@silverhand/shared';
import type { StartOptions } from '../../src/protocol.js';

export function testStartOptions(overrides: {
  conversationId?: string;
  agentId?: string;
  agentName?: string;
  runtime?: RuntimeKind;
  workspacePath?: string;
  agentHomeDir?: string;
  model?: string | null;
  cliSessionId?: string | null;
} = {}): StartOptions {
  const agentId = overrides.agentId ?? 'a1';
  const agentName = overrides.agentName ?? 'tester';
  const conversationId = overrides.conversationId ?? 'c1';
  const runtime = overrides.runtime ?? 'claude';
  const workspacePath = overrides.workspacePath ?? process.cwd();
  const agentHomeDir =
    overrides.agentHomeDir ?? join(process.cwd(), '.silverhand-test-agents', agentId);

  return {
    agent: {
      id: agentId,
      name: agentName,
      home_dir: agentHomeDir,
    },
    workspace: {
      id: 'ws1',
      name: 'test-workspace',
      kind: 'regular',
      path: workspacePath,
    },
    workspace_memory_index: [
      {
        id: 'ws1',
        name: 'test-workspace',
        kind: 'regular',
        path: workspacePath,
      },
    ],
    session: {
      conversation_id: conversationId,
      kind: 'channel',
      title: 'test-session',
      parent_conversation_id: null,
      parent_title: null,
      spawned_by_agent_id: null,
      members: [
        {
          kind: 'agent',
          agent_id: agentId,
          name: agentName,
          display_name: agentName,
          runtime,
        },
      ],
    },
    driver: {
      kind: runtime,
      cli_session_id: overrides.cliSessionId ?? null,
      model: overrides.model ?? null,
      reasoning_effort: null,
      fast_mode: null,
    },
    env_policy: {
      silverhand: {
        server_url: 'http://127.0.0.1:1',
        auth_token: 'test-agent-token',
      },
      silverhand_cli: {
        command: 'silverhand',
        args: [],
      },
      proxy: {
        url: null,
        allowlist: [],
      },
    },
  };
}
