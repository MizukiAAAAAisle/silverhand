import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentHomeWorkspaceId } from '@silverhand/shared';
import {
  resolveAuthenticatedComputerId,
  resolveRuntimeStartPaths,
  resolveRuntimeActionWorkdir,
  RuntimeStartResolveError,
  type RuntimeStartResolveDeps,
} from '../src/daemon/runtime-start-resolve.js';
import {
  resolveAgentDir,
  resolveAgentWorkspaceBundleDir,
} from '../src/daemon/agent-materialize/handler.js';
import { WorkspaceIdSegmentError } from '../src/daemon/workspace-path-authority.js';
import { testStartOptions } from './_helpers/runtime-start-options.js';
import type { StartOptions } from '../src/protocol.js';

/**
 * D4.e-6 / relocation-v1 §7 task 4 — the daemon resolves `runtime_start` host
 * paths from SEMANTIC wire refs. There is no registry establishment gate any
 * more: a workspace id maps to a UNIQUE deterministic bundle COORDINATE
 * (`resolveAgentWorkspaceBundleDir`), and whether that coordinate is currently
 * AVAILABLE (its L2 materialized here) is a separate fs fact (`bundleL2Present`).
 *
 * These pin the coordinate-vs-availability split (Cindy 2026-08-04):
 *   - the ACTIVE workspace resolves to its coordinate unconditionally (the
 *     supervisor's post-resolve assert enforces availability fail-closed);
 *   - a memory-INDEX entry resolves to its coordinate only when available, else
 *     `path: null` — the legal lazy window (added to a workspace, never spawned
 *     there) and a half-seeded dir both degrade, never fabricate a path;
 *   - `agent_home` resolves via `resolveAgentDir` (ONE join onto the explicit
 *     agents root), never a coordinate lookup;
 *   - an unresolvable ref (foreign agent_home, unsafe id) fails closed as the
 *     active workspace, degrades to null as an index entry.
 */

/** The EXPLICIT agents root every case below resolves under (#task:1813: the
 *  resolver has no home-relative default to fall back on). */
const AGENTS_ROOT = '/tmp/d4e6-agents';

/** The deterministic regular-workspace L2/cwd path (relocation-v1 §3.2). */
function bundle(agentId: string, workspaceId: string, agentHomeRootDir = AGENTS_ROOT): string {
  return resolveAgentWorkspaceBundleDir(agentId, workspaceId, {
    agentHomeRootDir,
  });
}

/** The agent's L1 dir — ONE join onto the agents root. */
function l1(agentId: string, agentHomeRootDir = AGENTS_ROOT): string {
  return resolveAgentDir(agentId, { agentHomeRootDir });
}

/**
 * Resolver deps with an injectable availability seam. `available` defaults to
 * true (every coordinate materialized); pass a predicate to model the lazy
 * window / half-seed for specific bundle dirs.
 */
function depsWith(
  available: (bundleDir: string) => Promise<boolean> = async () => true,
  agentHomeRootDir = AGENTS_ROOT,
): RuntimeStartResolveDeps {
  return {
    agentHomeRootDir,
    bundleL2Present: available,
    resolveComputerId: () => 'computer-1',
  };
}

describe('resolveRuntimeStartPaths — regular workspace', () => {
  it('resolves agent.home_dir + active workspace + memory index to the deterministic bundle coordinate, with no registry gate', async () => {
    const options = testStartOptions({ agentId: 'a1', workspaceKind: 'regular' });
    const probed: string[] = [];
    const resolved = await resolveRuntimeStartPaths(
      options,
      depsWith(async (dir) => {
        probed.push(dir);
        return true;
      }),
    );
    expect(resolved.agent.home_dir).toBe(l1('a1'));
    expect(resolved.workspace!.path).toBe(bundle('a1', 'ws1'));
    expect(resolved.workspace_memory_index[0]!.path).toBe(bundle('a1', 'ws1'));
    // The active workspace is NOT availability-probed here (that is the
    // supervisor's post-resolve assert); only the index entry is.
    expect(probed).toEqual([bundle('a1', 'ws1')]);
    // Semantic fields are preserved.
    expect(resolved.workspace!.id).toBe('ws1');
    expect(resolved.agent.id).toBe('a1');
  });

  it('attaches the daemon-resolved computer id to the resolved options', async () => {
    const options = testStartOptions({ workspaceKind: 'regular' });
    const resolved = await resolveRuntimeStartPaths(options, depsWith());
    expect(resolved.computer_id).toBe('computer-1');
  });

  it('lazy window: an index entry whose bundle is not yet materialized degrades to path:null (never fabricates a coordinate)', async () => {
    // The active workspace resolves to its coordinate regardless; a peer index
    // entry the agent has never spawned in has a valid coordinate but no L2 on
    // disk → unavailable, never a guessed path.
    const base = testStartOptions({ agentId: 'a1', workspaceKind: 'regular' });
    const options: StartOptions = {
      ...base,
      workspace_memory_index: [
        { id: 'ws1', name: 'primary' },
        { id: 'ws_never_spawned', name: 'peer' },
      ],
    };
    const resolved = await resolveRuntimeStartPaths(
      options,
      depsWith(async (dir) => dir === bundle('a1', 'ws1')),
    );
    expect(resolved.workspace!.path).toBe(bundle('a1', 'ws1'));
    expect(resolved.workspace_memory_index).toEqual([
      { id: 'ws1', name: 'primary', path: bundle('a1', 'ws1') },
      { id: 'ws_never_spawned', name: 'peer', path: null },
    ]);
  });

  it('offers a memory path only after a mkdir-only bundle gains a readable MEMORY.md', async () => {
    const base = testStartOptions({ agentId: 'a1', workspaceKind: 'regular' });
    const options: StartOptions = {
      ...base,
      workspace_memory_index: [{ id: 'ws_half', name: 'half' }],
    };
    const testRoot = process.env.SILVERHAND_DIR;
    if (!testRoot) throw new Error('This filesystem test requires isolated SILVERHAND_DIR');
    mkdirSync(testRoot, { recursive: true });
    const agentHomeRootDir = mkdtempSync(join(testRoot, 'runtime-paths-'));
    try {
      const half = join(agentHomeRootDir, 'a1', 'workspaces', 'ws_half');
      mkdirSync(half, { recursive: true });
      const deps = { agentHomeRootDir, resolveComputerId: () => 'computer-1' };
      const before = await resolveRuntimeStartPaths(options, deps);
      expect(before.workspace_memory_index).toEqual([{ id: 'ws_half', name: 'half', path: null }]);
      expect(before.cwd).toBe(join(agentHomeRootDir, 'a1', 'workspaces', 'ws1'));
      writeFileSync(join(half, 'MEMORY.md'), '# workspace memory');
      const after = await resolveRuntimeStartPaths(options, deps);
      expect(after.workspace_memory_index).toEqual([{ id: 'ws_half', name: 'half', path: half }]);
      expect(after.cwd).toBe(before.cwd);
    } finally {
      rmSync(agentHomeRootDir, { recursive: true, force: true });
    }
  });

  it('fails closed for the active workspace on an unsafe id (registry_unavailable), before any availability probe', async () => {
    const base = testStartOptions({ agentId: 'a1', workspaceKind: 'regular' });
    const options: StartOptions = {
      ...base,
      workspace: { id: '../escape', name: 'evil' },
    };
    let probed = false;
    let thrown: unknown;
    try {
      await resolveRuntimeStartPaths(
        options,
        depsWith(async () => {
          probed = true;
          return true;
        }),
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RuntimeStartResolveError);
    expect((thrown as RuntimeStartResolveError).code).toBe('registry_unavailable');
    // The active workspace throws during coordinate derivation — availability
    // is never even consulted.
    expect(probed).toBe(false);
  });
});

describe('resolveRuntimeStartPaths — agent_home workspace', () => {
  it('resolves agent_home path via resolveAgentDir, never a coordinate lookup', async () => {
    const options = testStartOptions({
      agentId: 'a9',
      workspaceKind: 'agent_home',
    });
    const resolved = await resolveRuntimeStartPaths(options, depsWith());
    expect(resolved.workspace!.path).toBe(l1('a9'));
    expect(resolved.workspace_memory_index[0]!.path).toBe(l1('a9'));
    expect(resolved.agent.home_dir).toBe(l1('a9'));
    // The valid ref is THIS agent's own home workspace id.
    expect(resolved.workspace!.id).toBe(agentHomeWorkspaceId('a9'));
  });

  it('joins agent.home_dir and agent_home workspace paths onto the caller-supplied agents root', async () => {
    const agentHomeRootDir = '/tmp/isolated-silverhand/agents';
    const options = testStartOptions({
      agentId: 'a9',
      workspaceKind: 'agent_home',
    });
    const resolved = await resolveRuntimeStartPaths(options, {
      agentHomeRootDir,
      bundleL2Present: async () => true,
      resolveComputerId: () => 'computer-1',
    });
    const expected = l1('a9', agentHomeRootDir);
    expect(resolved.agent.home_dir).toBe(expected);
    expect(resolved.workspace!.path).toBe(expected);
    expect(resolved.workspace_memory_index[0]!.path).toBe(expected);
  });

  it('fails closed when an agent_home ref carries a FOREIGN home id (no silent normalization)', async () => {
    const base = testStartOptions({ agentId: 'a1', workspaceKind: 'agent_home' });
    // Swap in another agent's home id (still a `wsah_`-shaped ref, so the daemon
    // recognizes it as agent-home by id, then fails closed because it is not THIS
    // agent's own home id).
    const options: StartOptions = {
      ...base,
      workspace: { id: agentHomeWorkspaceId('other'), name: 'DM' },
    };
    let thrown: unknown;
    try {
      await resolveRuntimeStartPaths(options, depsWith());
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RuntimeStartResolveError);
    expect((thrown as RuntimeStartResolveError).code).toBe('workspace_not_provisioned');
  });

  it("memory-index entry carrying ANOTHER agent's home id degrades to unavailable (never resolves onto own L1)", async () => {
    const base = testStartOptions({ agentId: 'a1', workspaceKind: 'agent_home' });
    const foreignHome = agentHomeWorkspaceId('other');
    const options: StartOptions = {
      ...base,
      workspace_memory_index: [{ id: foreignHome, name: 'DM' }],
    };
    const resolved = await resolveRuntimeStartPaths(options, depsWith());
    // Recognized as an agent-home ref by its `wsah_` id, then fails closed
    // because it is not THIS agent's home → the index entry degrades to null
    // rather than resolving onto this agent's L1.
    expect(resolved.workspace_memory_index).toEqual([{ id: foreignHome, name: 'DM', path: null }]);
  });
});

describe('resolveAuthenticatedComputerId — prompt computer authority', () => {
  it('returns the authenticated binding host id', () => {
    expect(resolveAuthenticatedComputerId({ host_id: 'computer-9' })).toBe('computer-9');
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
    expect((thrown as RuntimeStartResolveError).code).toBe('registry_unavailable');
  });
});

describe('resolveRuntimeStartPaths — mixed memory index', () => {
  it('resolves each entry by its own id convention (regular bundle vs agent-home L1)', async () => {
    const base = testStartOptions({ agentId: 'a1', workspaceKind: 'regular' });
    const options: StartOptions = {
      ...base,
      workspace_memory_index: [
        { id: 'ws1', name: 'primary' },
        { id: agentHomeWorkspaceId('a1'), name: 'DM' },
        { id: 'ws2', name: 'other' },
      ],
    };
    const resolved = await resolveRuntimeStartPaths(options, depsWith());
    expect(resolved.workspace_memory_index.map((w) => w.path)).toEqual([
      bundle('a1', 'ws1'),
      l1('a1'),
      bundle('a1', 'ws2'),
    ]);
  });

  it('an unresolvable (unsafe-id) index entry degrades to path:null while the ACTIVE workspace stays fail-closed', async () => {
    // A corrupt index entry (unsafe id segment) has no bundle coordinate: it
    // must NOT block the spawn and must NOT fabricate a path — it renders
    // "unavailable on this computer". The same failure on the ACTIVE workspace
    // keeps the hard fail-closed contract.
    const base = testStartOptions({ agentId: 'a1', workspaceKind: 'regular' });
    const options: StartOptions = {
      ...base,
      workspace_memory_index: [
        { id: 'ws1', name: 'primary' },
        { id: '../escape', name: 'peer' },
      ],
    };
    const resolved = await resolveRuntimeStartPaths(options, depsWith());
    expect(resolved.workspace!.path).toBe(bundle('a1', 'ws1'));
    expect(resolved.workspace_memory_index).toEqual([
      { id: 'ws1', name: 'primary', path: bundle('a1', 'ws1') },
      { id: '../escape', name: 'peer', path: null },
    ]);

    // Same unsafe id on the ACTIVE workspace still throws (fail closed).
    const activeUnsafe: StartOptions = {
      ...base,
      workspace: { id: '../escape', name: 'peer' },
    };
    await expect(resolveRuntimeStartPaths(activeUnsafe, depsWith())).rejects.toBeInstanceOf(
      RuntimeStartResolveError,
    );
  });
});

describe('resolveRuntimeStartPaths — agent scope', () => {
  it('uses the stable agent home as cwd and carries no workspace projection', async () => {
    const resolved = await resolveRuntimeStartPaths(
      testStartOptions({ agentId: 'a-agent', sessionScope: 'agent' }),
      depsWith(),
    );

    expect(resolved.runtime_scope).toEqual({
      kind: 'agent',
      agent_id: 'a-agent',
    });
    expect(resolved.agent.home_dir).toBe(l1('a-agent'));
    expect(resolved.cwd).toBe(l1('a-agent'));
    expect('workspace' in resolved).toBe(false);
    expect('workspace_memory_index' in resolved).toBe(false);
  });
});

describe('resolveAgentWorkspaceBundleDir — sole path authority self-validates', () => {
  // relocation-v1 §7 task 1/4 — the bundle resolver is the single path
  // authority for a regular workspace L2/cwd, and the workspace id is a raw
  // path SEGMENT (`<agent home>/workspaces/<id>`). Defense-in-depth: the
  // resolver itself must fail closed on an unsafe id and NEVER return a path
  // that escapes the agent home — no traversal, no absolute, no empty.
  const ESCAPES = [
    '../escape',
    'a/b',
    '/abs',
    '..',
    '../../etc/passwd',
    'x/../../y',
    '',
    'a'.repeat(65),
    'dot.dot',
  ];

  for (const id of ESCAPES) {
    it(`throws invalid_path and never resolves an escaping path for ${JSON.stringify(id)}`, () => {
      let thrown: unknown;
      try {
        resolveAgentWorkspaceBundleDir('a1', id, { agentHomeRootDir: AGENTS_ROOT });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(WorkspaceIdSegmentError);
      expect((thrown as WorkspaceIdSegmentError).code).toBe('invalid_path');
    });
  }

  it('a conforming id resolves under the agent home', () => {
    const path = resolveAgentWorkspaceBundleDir('a1', 'ws1', { agentHomeRootDir: AGENTS_ROOT });
    expect(path).toBe(join(AGENTS_ROOT, 'a1', 'workspaces', 'ws1'));
  });
});

describe('runtime action cwd follows the runtime scope', () => {
  it('shares home for agent scope while conversation scope retains distinct target paths', () => {
    const deps = depsWith();
    const targets = [
      { conversation_id: 'channel-1', workspace: { id: 'ws1', name: 'One' } },
      { conversation_id: 'channel-2', workspace: { id: 'ws2', name: 'Two' } },
      { conversation_id: 'direct-pair', workspace: null },
    ];
    for (const target of targets) {
      expect(resolveRuntimeActionWorkdir({ kind: 'agent', agent_id: 'a1' }, target, deps)).toBe(
        l1('a1'),
      );
      const path = resolveRuntimeActionWorkdir(
        { kind: 'conversation', agent_id: 'a1', conversation_id: target.conversation_id },
        target,
        deps,
      );
      expect(path).toBe(
        target.workspace
          ? bundle('a1', target.workspace.id)
          : `${l1('a1')}/conversations/direct-pair`,
      );
    }
  });
});
