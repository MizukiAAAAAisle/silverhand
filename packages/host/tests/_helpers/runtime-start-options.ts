import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeKind } from '@silverhand/shared';
import { agentHomeWorkspaceId } from '@silverhand/shared';
import type { StartOptions } from '../../src/protocol.js';
import type { RuntimeStartResolveDeps } from '../../src/daemon/runtime-start-resolve.js';

/**
 * Build SEMANTIC `runtime_start` options (D4.e-6): no `path`/`home_dir`
 * crosses the wire. The daemon resolves host paths deterministically from the
 * agent id + workspace id, so a test pairs these options with matching deps
 * (`testRuntimeStartResolveDeps`, keyed on the explicit agents root).
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
 * Supervisor needs (D4.e-6). relocation-v1 §7 task 4 — there is no registry
 * establishment gate any more: both `regular` and `agent_home` cwds resolve
 * deterministically from the agent id + workspace id under the EXPLICIT
 * `agentHomeRootDir` inside `resolveRuntimeStartPaths` (#task:1813 — there is no
 * home-relative default to fall back on), so pass the sandbox agents root when a
 * test reads real L1 prompt files or a materialized bundle.
 *
 * Availability of a resolved coordinate is a separate fs fact
 * (`bundleL2Present`: MEMORY.md at the bundle root). The default seam returns
 * `true` so memory-index entries resolve to their coordinate without touching
 * disk; override it to model the lazy window (never-spawned member workspace)
 * or a half-seed → `path: null`.
 */
export function testRuntimeStartResolveDeps(overrides: {
  agentHomeRootDir?: string;
  computerId?: string;
  bundleL2Present?: (bundleDir: string) => Promise<boolean>;
  resolveComputerId?: () => string;
} = {}): RuntimeStartResolveDeps {
  const computerId = overrides.computerId ?? 'test-computer';
  return {
    // Never home-derived: a test that does not care which root is used still
    // gets an explicit, obviously-fake one rather than the real user home.
    agentHomeRootDir:
      overrides.agentHomeRootDir ?? join(tmpdir(), 'silverhand-test-agents-root'),
    bundleL2Present: overrides.bundleL2Present ?? (async () => true),
    resolveComputerId: overrides.resolveComputerId ?? (() => computerId),
  };
}
