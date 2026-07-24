import { describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bindingSlug,
  managedWorkspaceSlug,
  WorkspaceRegistry,
  WorkspaceRegistryError,
  type RegistryBinding,
} from '../../src/daemon/workspace-registry/registry.js';
import { defaultWorkspaceDataRootDir } from '../../src/daemon/workspace-registry/state-dir.js';

/**
 * #task:1596/#task:1603/#task:1612 — workspace-data lives in the EXPLICIT
 * durable computer data root; the daemon performs NO legacy physical moves
 * (the desktop layout engine owns them and runs before any daemon) and,
 * since #task:1612, no legacy path aliasing either. What remains
 * daemon-side is only the durable-root default/wiring
 * (`defaultWorkspaceDataRootDir`); a stale pre-v2 path proposal is a plain
 * `path_conflict`, never healed.
 */

const BINDING: RegistryBinding = {
  server_origin: 'https://srv.example',
  host_id: 'host-1',
};
const OTHER_BINDING: RegistryBinding = {
  server_origin: 'https://srv.example',
  host_id: 'host-2',
};

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'sh-state-dir-'));
}

/** Seed the FINISHED durable FLAT shape (#task:1608 — the engine-owned
 *  move, rewrite, and flatten already happened): registry file directly on
 *  the workspace-data root + raw-id managed workspace dir with a guest L2
 *  file. */
function seedFlatRegistry(
  durableStateDir: string,
  binding: RegistryBinding,
  workspaceId: string,
): { managedPath: string } {
  const managedPath = join(durableStateDir, 'workspaces', workspaceId);
  mkdirSync(managedPath, { recursive: true });
  const l2Dir = join(managedPath, '.silverhand', 'agents', 'agent-1');
  mkdirSync(l2Dir, { recursive: true });
  writeFileSync(join(l2Dir, 'MEMORY.md'), '# durable memory\n', 'utf-8');
  writeFileSync(
    join(durableStateDir, 'workspace-registry.json'),
    JSON.stringify({
      schema_version: 1,
      binding,
      workspaces: { [workspaceId]: { path: managedPath, provisioned_at: 1 } },
    }),
    'utf-8',
  );
  return { managedPath };
}

describe('defaultWorkspaceDataRootDir', () => {
  it('is the global durable root (used only when the embedder passes nothing)', () => {
    expect(
      defaultWorkspaceDataRootDir().endsWith('/.silverhand/workspace-data'),
    ).toBe(true);
  });
});

describe('protectedRoots — requested paths may not overlap durable silverhand roots (#task:1596 round 3 P1-3)', () => {
  it('rejects the data root, its durable children, and their ancestors; unrelated paths still bind', () => {
    const root = tempDir();
    try {
      const dataRoot = join(root, 'custom-data-root');
      const durable = join(dataRoot, 'workspace-data');
      const agents = join(dataRoot, 'agents');
      const globalRoot = join(root, 'fake-global-silverhand');
      mkdirSync(durable, { recursive: true });
      const registry = new WorkspaceRegistry({
        stateDir: durable,
        binding: BINDING,
        protectedRoots: [durable, agents, globalRoot],
        silverhandStateRoot: globalRoot,
      });
      const rejected = [
        durable, // workspace-data root itself
        join(durable, 'sub'), // inside it
        agents, // L1 root
        join(agents, 'agent-1'), // inside L1
        dataRoot, // ANCESTOR of both (purge would take everything)
        globalRoot, // global silverhand root via the state-root rule
        join(globalRoot, 'agents'),
      ];
      for (const target of rejected) {
        let thrown: unknown;
        try {
          registry.provision(`ws-${target.length}`, target);
        } catch (err) {
          thrown = err;
        }
        expect(thrown, target).toBeInstanceOf(WorkspaceRegistryError);
        expect((thrown as WorkspaceRegistryError).code, target).toBe('invalid_path');
      }
      // An unrelated user directory still binds normally.
      const ok = registry.provision('ws-ok', join(root, 'user-project'));
      expect(ok.created).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('protectedRoots × legacyWorkspacesRoot exemption (#task:1596 round 4 P1-2)', () => {
  it('a custom data root nested under legacyWorkspacesRoot keeps its durable roots protected', () => {
    const root = tempDir();
    try {
      const globalRoot = join(root, 'global-silverhand');
      const legacyWorkspacesRoot = join(globalRoot, 'workspaces');
      // A legal user choice: connect --data-root under the legacy
      // generated-workspaces dir.
      const dataRoot = join(legacyWorkspacesRoot, 'my-connect-root');
      const durable = join(dataRoot, 'workspace-data');
      const agents = join(dataRoot, 'agents');
      mkdirSync(durable, { recursive: true });
      const registry = new WorkspaceRegistry({
        stateDir: durable,
        binding: BINDING,
        silverhandStateRoot: globalRoot,
        legacyWorkspacesRoot,
        protectedRoots: [durable, agents, globalRoot],
      });
      // The legacy-child exemption must NOT bypass protectedRoots.
      for (const target of [durable, agents, join(agents, 'a1'), dataRoot]) {
        let thrown: unknown;
        try {
          registry.provision(`ws-${target.length}`, target);
        } catch (err) {
          thrown = err;
        }
        expect(thrown, target).toBeInstanceOf(WorkspaceRegistryError);
        expect((thrown as WorkspaceRegistryError).code, target).toBe('invalid_path');
      }
      // A sibling legacy-child workspace is still the sanctioned exemption.
      const ok = registry.provision(
        'ws-legacy-child',
        join(legacyWorkspacesRoot, 'some-old-generated-ws'),
      );
      expect(ok.created).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('protectedRoots — disjoint-volume global ancestor guard (#task:1596 round 5)', () => {
  it('a requested path that is an ANCESTOR of the global root is rejected even when the data root lives on a disjoint tree', () => {
    const rootA = tempDir(); // "volume" holding the global silverhand root
    const rootB = tempDir(); // disjoint "volume" holding the custom data root
    try {
      const globalRoot = join(rootA, 'home', '.silverhand');
      const durable = join(rootB, 'workspace-data');
      const agents = join(rootB, 'agents');
      mkdirSync(globalRoot, { recursive: true });
      mkdirSync(durable, { recursive: true });
      const registry = new WorkspaceRegistry({
        stateDir: durable,
        binding: BINDING,
        silverhandStateRoot: globalRoot,
        protectedRoots: [durable, agents, globalRoot],
      });
      // <rootA>/home is an ancestor of the global root but overlaps neither
      // custom root nor equals homedir(); pre-fix this bound successfully
      // and a recursive purge would have taken the whole global root.
      let thrown: unknown;
      try {
        registry.provision('ws-evil', join(rootA, 'home'));
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(WorkspaceRegistryError);
      expect((thrown as WorkspaceRegistryError).code).toBe('invalid_path');
      // An unrelated path on volume A still binds.
      const ok = registry.provision('ws-ok', join(rootA, 'projects', 'x'));
      expect(ok.created).toBe(true);
    } finally {
      rmSync(rootA, { recursive: true, force: true });
      rmSync(rootB, { recursive: true, force: true });
    }
  });
});

describe('#task:1612 — the stale-path alias is retired: a legacy coordinate proposal is a plain conflict', () => {
  it('re-binding an already-bound id with a pre-migration managed path fails path_conflict (never healed)', () => {
    const root = tempDir();
    try {
      const durable = join(root, 'workspace-data');
      seedFlatRegistry(durable, BINDING, 'ws-1');
      const registry = new WorkspaceRegistry({ stateDir: durable, binding: BINDING });
      const staleRunEra = join(
        root,
        'run',
        bindingSlug(BINDING),
        'workspaces',
        managedWorkspaceSlug('ws-1'),
      );
      expect(() => registry.provision('ws-1', staleRunEra)).toThrowError(
        expect.objectContaining({ code: 'path_conflict' }),
      );
      // The exact CURRENT path stays idempotent (plain semantics survive).
      const current = join(durable, 'workspaces', 'ws-1');
      expect(registry.provision('ws-1', current)).toEqual({
        path: current,
        created: false,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
