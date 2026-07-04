import type { RuntimeKind } from '@silverhand/shared';
import { agentHomeWorkspaceId } from '@silverhand/shared';
import type { StartOptions } from '../../src/protocol.js';
import type { RuntimeStartResolveDeps } from '../../src/daemon/runtime-start-resolve.js';

/**
 * Build SEMANTIC `runtime_start` options (D4.e-6): no `path`/`home_dir`
 * crosses the wire. `workspacePath`/`agentHomeDir` overrides are retained
 * for the COMPANION resolver (`testRuntimeStartResolveDeps`) — the daemon
 * resolves host paths, so a test pairs these options with matching deps.
 */
export function testStartOptions(overrides: {
  conversationId?: string;
  agentId?: string;
  agentName?: string;
  runtime?: RuntimeKind;
  model?: string | null;
  cliSessionId?: string | null;
  workspaceKind?: 'regular' | 'agent_home';
} = {}): StartOptions {
  const agentId = overrides.agentId ?? 'a1';
  const agentName = overrides.agentName ?? 'tester';
  const conversationId = overrides.conversationId ?? 'c1';
  const runtime = overrides.runtime ?? 'claude';
  const workspaceKind = overrides.workspaceKind ?? 'regular';
  // An `agent_home` ref must carry THIS agent's own home workspace id (the
  // daemon resolver validates id == agentHomeWorkspaceId(agentId)); a regular
  // workspace uses an arbitrary id.
  const workspaceId =
    workspaceKind === 'agent_home' ? agentHomeWorkspaceId(agentId) : 'ws1';

  return {
    agent: {
      id: agentId,
      name: agentName,
    },
    workspace: {
      id: workspaceId,
      name: 'test-workspace',
      kind: workspaceKind,
    },
    workspace_memory_index: [
      {
        id: workspaceId,
        name: 'test-workspace',
        kind: workspaceKind,
      },
    ],
    session: {
      conversation_id: conversationId,
      kind: 'channel',
      title: 'test-session',
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
        auth_token: 'test-agent-token',
      },
      silverhand_cli: {
        command: 'silverhand',
        args: [],
      },
    },
  };
}

/**
 * Companion to `testStartOptions`: the daemon-side path resolver deps the
 * Supervisor needs (D4.e-6). `regular` workspaces resolve to `workspacePath`
 * (default `process.cwd()`); `agent_home` + `agent.home_dir` resolve via
 * `computeAgentDir(agentId, homeDir)` inside `resolveRuntimeStartPaths`, so
 * pass `homeDir` when a test reads real L1 prompt files. To force a typed
 * fail-closed, override `resolveRegularWorkspacePath` to throw.
 */
export function testRuntimeStartResolveDeps(overrides: {
  homeDir?: string;
  workspacePath?: string;
  resolveRegularWorkspacePath?: (workspaceId: string) => string;
} = {}): RuntimeStartResolveDeps {
  const workspacePath = overrides.workspacePath ?? process.cwd();
  return {
    homeDir: overrides.homeDir,
    resolveRegularWorkspacePath:
      overrides.resolveRegularWorkspacePath ?? (() => workspacePath),
  };
}
