import { describe, expect, it } from 'vitest';
import { agentHomeWorkspaceId } from '@silverhand/shared';
import {
  resolveAuthenticatedComputerId,
  resolveRuntimeStartPaths,
  RuntimeStartResolveError,
  type RuntimeStartResolveDeps,
} from '../src/daemon/runtime-start-resolve.js';
import {
  computeAgentDir,
  computeAgentDirFromRoot,
} from '../src/daemon/agent-materialize/handler.js';
import { testStartOptions } from './_helpers/runtime-start-options.js';
import type { StartOptions } from '../src/protocol.js';

/**
 * D4.e-6 — daemon resolves `runtime_start` host paths from SEMANTIC wire
 * refs. These pin: regular → injected registry resolver; agent_home +
 * agent.home_dir → `computeAgentDir`; the memory index resolves per-kind;
 * and a regular resolution failure surfaces fail-closed as a typed
 * `RuntimeStartResolveError`.
 */

const HOME = '/tmp/d4e6-home';

function depsWith(
  resolveRegularWorkspacePath: (id: string) => string,
  homeDir = HOME,
): RuntimeStartResolveDeps {
  return {
    homeDir,
    resolveRegularWorkspacePath,
    resolveComputerId: () => 'computer-1',
  };
}

describe('resolveRuntimeStartPaths — regular workspace', () => {
  it('resolves agent.home_dir + workspace.path + memory index via the deps', () => {
    const options = testStartOptions({ agentId: 'a1', workspaceKind: 'regular' });
    const calls: string[] = [];
    const resolved = resolveRuntimeStartPaths(
      options,
      depsWith(id => {
        calls.push(id);
        return `/host/ws/${id}`;
      }),
    );
    expect(resolved.agent.home_dir).toBe(computeAgentDir('a1', HOME));
    expect(resolved.workspace.path).toBe('/host/ws/ws1');
    expect(resolved.workspace_memory_index[0]!.path).toBe('/host/ws/ws1');
    // The registry resolver is the only source of the regular path.
    expect(calls).toContain('ws1');
    // Semantic fields are preserved.
    expect(resolved.workspace.id).toBe('ws1');
    expect(resolved.agent.id).toBe('a1');
  });

  it('attaches the daemon-resolved computer id to the resolved options', () => {
    const options = testStartOptions({ workspaceKind: 'regular' });
    const resolved = resolveRuntimeStartPaths(
      options,
      depsWith(id => `/host/ws/${id}`),
    );
    expect(resolved.computer_id).toBe('computer-1');
  });

  it('fails closed: a thrown RuntimeStartResolveError propagates unchanged', () => {
    const options = testStartOptions({ workspaceKind: 'regular' });
    expect(() =>
      resolveRuntimeStartPaths(
        options,
        depsWith(() => {
          throw new RuntimeStartResolveError(
            'workspace_not_provisioned',
            'ws1 not bound',
          );
        }),
      ),
    ).toThrow(RuntimeStartResolveError);
  });
});

describe('resolveRuntimeStartPaths — agent_home workspace', () => {
  it('resolves agent_home path via computeAgentDir, never the registry', () => {
    const options = testStartOptions({
      agentId: 'a9',
      workspaceKind: 'agent_home',
    });
    const resolved = resolveRuntimeStartPaths(
      options,
      depsWith(() => {
        throw new Error('registry must not be consulted for agent_home');
      }),
    );
    expect(resolved.workspace.path).toBe(computeAgentDir('a9', HOME));
    expect(resolved.workspace_memory_index[0]!.path).toBe(
      computeAgentDir('a9', HOME),
    );
    expect(resolved.agent.home_dir).toBe(computeAgentDir('a9', HOME));
    // The valid ref is THIS agent's own home workspace id.
    expect(resolved.workspace.id).toBe(agentHomeWorkspaceId('a9'));
  });

  it('uses agentHomeRootDir for agent.home_dir and agent_home workspace paths', () => {
    const agentHomeRootDir = '/tmp/isolated-silverhand/agents';
    const options = testStartOptions({
      agentId: 'a9',
      workspaceKind: 'agent_home',
    });
    const resolved = resolveRuntimeStartPaths(options, {
      agentHomeRootDir,
      resolveRegularWorkspacePath: () => {
        throw new Error('registry must not be consulted for agent_home');
      },
      resolveComputerId: () => 'computer-1',
    });
    const expected = computeAgentDirFromRoot('a9', agentHomeRootDir);
    expect(resolved.agent.home_dir).toBe(expected);
    expect(resolved.workspace.path).toBe(expected);
    expect(resolved.workspace_memory_index[0]!.path).toBe(expected);
  });

  it('fails closed when an agent_home ref carries a FOREIGN home id (no silent normalization)', () => {
    const base = testStartOptions({ agentId: 'a1', workspaceKind: 'agent_home' });
    // Swap in another agent's home id while keeping kind: 'agent_home'.
    const options: StartOptions = {
      ...base,
      workspace: { id: agentHomeWorkspaceId('other'), name: 'DM', kind: 'agent_home' },
    };
    expect(() =>
      resolveRuntimeStartPaths(
        options,
        depsWith(() => {
          throw new Error('registry must not be consulted for agent_home');
        }),
      ),
    ).toThrow(RuntimeStartResolveError);
  });

  it('fails closed when an agent_home ref id is a non-home string', () => {
    const base = testStartOptions({ agentId: 'a1', workspaceKind: 'agent_home' });
    const options: StartOptions = {
      ...base,
      workspace_memory_index: [{ id: 'home1', name: 'DM', kind: 'agent_home' }],
    };
    let thrown: unknown;
    try {
      resolveRuntimeStartPaths(options, depsWith(() => '/host/ws/ws1'));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RuntimeStartResolveError);
    expect((thrown as RuntimeStartResolveError).code).toBe('workspace_not_provisioned');
  });
});

describe('resolveAuthenticatedComputerId — prompt computer authority', () => {
  it('returns the authenticated binding host id', () => {
    expect(
      resolveAuthenticatedComputerId({ host_id: 'computer-9' }),
    ).toBe('computer-9');
  });

  it('fails closed with typed registry_unavailable when not attached — never a placeholder', () => {
    // The embedded registry-namespace fallback (`daemon_id` / 'local') is
    // deliberately NOT accepted here: pre-attach there is no authenticated
    // computer identity, so prompt provenance must refuse, not guess.
    let thrown: unknown;
    try {
      resolveAuthenticatedComputerId(null);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RuntimeStartResolveError);
    expect((thrown as RuntimeStartResolveError).code).toBe(
      'registry_unavailable',
    );
  });
});

describe('resolveRuntimeStartPaths — mixed memory index', () => {
  it('resolves each entry by its own kind', () => {
    const base = testStartOptions({ agentId: 'a1', workspaceKind: 'regular' });
    const options: StartOptions = {
      ...base,
      workspace_memory_index: [
        { id: 'ws1', name: 'primary', kind: 'regular' },
        { id: agentHomeWorkspaceId('a1'), name: 'DM', kind: 'agent_home' },
        { id: 'ws2', name: 'other', kind: 'regular' },
      ],
    };
    const resolved = resolveRuntimeStartPaths(
      options,
      depsWith(id => `/host/ws/${id}`),
    );
    expect(resolved.workspace_memory_index.map(w => w.path)).toEqual([
      '/host/ws/ws1',
      computeAgentDir('a1', HOME),
      '/host/ws/ws2',
    ]);
  });
});
