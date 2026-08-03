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
  resolveAgentWorkspaceBundleDir,
} from '../src/daemon/agent-materialize/handler.js';
import { testStartOptions } from './_helpers/runtime-start-options.js';
import type { StartOptions } from '../src/protocol.js';

/**
 * D4.e-6 — daemon resolves `runtime_start` host paths from SEMANTIC wire
 * refs. These pin: regular → deterministic agent-centric bundle dir, with
 * the injected registry resolver kept as the establishment gate (fail-closed
 * / call-recorded); agent_home + agent.home_dir → `computeAgentDir`; the
 * memory index resolves per-kind; and a regular resolution failure surfaces
 * fail-closed as a typed `RuntimeStartResolveError`.
 */

const HOME = '/tmp/d4e6-home';

/** The deterministic regular-workspace L2/cwd path (relocation-v1 §3.2). */
function bundle(agentId: string, workspaceId: string, homeDir = HOME): string {
  return resolveAgentWorkspaceBundleDir(agentId, workspaceId, { homeDir });
}

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
  it('resolves agent.home_dir via computeAgentDir + workspace.path/memory index to the bundle dir, consulting the deps as the establishment gate', () => {
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
    expect(resolved.workspace.path).toBe(bundle('a1', 'ws1'));
    expect(resolved.workspace_memory_index[0]!.path).toBe(bundle('a1', 'ws1'));
    // The registry resolver stays the establishment gate (still consulted),
    // but no longer supplies the path — that is the deterministic bundle dir.
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

  it('memory-index entry with a foreign/non-home agent_home id degrades to unavailable (never resolves onto own L1)', () => {
    const base = testStartOptions({ agentId: 'a1', workspaceKind: 'agent_home' });
    const options: StartOptions = {
      ...base,
      workspace_memory_index: [{ id: 'home1', name: 'DM', kind: 'agent_home' }],
    };
    const resolved = resolveRuntimeStartPaths(options, depsWith(() => '/host/ws/ws1'));
    expect(resolved.workspace_memory_index).toEqual([
      { id: 'home1', name: 'DM', kind: 'agent_home', path: null },
    ]);
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
      bundle('a1', 'ws1'),
      computeAgentDir('a1', HOME),
      bundle('a1', 'ws2'),
    ]);
  });

  it('an unresolvable index entry degrades to path:null while the ACTIVE workspace stays fail-closed', () => {
    // Slice 1 (#task:1596): a cross-computer peer workspace has no local
    // binding on this computer. It must NOT block the spawn and must NOT
    // resolve onto a guessed path — it renders "unavailable on this
    // computer". The active workspace keeps the hard fail-closed contract.
    const base = testStartOptions({ agentId: 'a1', workspaceKind: 'regular' });
    const options: StartOptions = {
      ...base,
      workspace_memory_index: [
        { id: 'ws1', name: 'primary', kind: 'regular' },
        { id: 'ws_peer_unbound', name: 'peer', kind: 'regular' },
      ],
    };
    const resolved = resolveRuntimeStartPaths(
      options,
      depsWith(id => {
        if (id === 'ws_peer_unbound') {
          throw new RuntimeStartResolveError(
            'workspace_not_provisioned',
            'no local binding on this computer',
          );
        }
        return `/host/ws/${id}`;
      }),
    );
    expect(resolved.workspace.path).toBe(bundle('a1', 'ws1'));
    expect(resolved.workspace_memory_index).toEqual([
      { id: 'ws1', name: 'primary', kind: 'regular', path: bundle('a1', 'ws1') },
      { id: 'ws_peer_unbound', name: 'peer', kind: 'regular', path: null },
    ]);

    // Same failure on the ACTIVE workspace still throws (fail closed).
    const activeUnbound: StartOptions = {
      ...base,
      workspace: { id: 'ws_peer_unbound', name: 'peer', kind: 'regular' },
    };
    expect(() =>
      resolveRuntimeStartPaths(
        activeUnbound,
        depsWith(() => {
          throw new RuntimeStartResolveError(
            'workspace_not_provisioned',
            'no local binding on this computer',
          );
        }),
      ),
    ).toThrow(RuntimeStartResolveError);
  });
});
