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
import {
  defaultWorkspaceDataRootDir,
  legacyNamespaceDirs,
  legacyWorkspaceDataSourceDirs,
} from '../../src/daemon/workspace-registry/state-dir.js';

/**
 * #task:1596/#task:1603 — workspace-data lives in the EXPLICIT durable
 * computer data root; the daemon performs NO legacy physical moves (the
 * desktop layout engine owns them and runs before any daemon). What
 * remains daemon-side:
 *   - the durable-root default/wiring (`defaultWorkspaceDataRootDir`);
 *   - the run-era ALIAS provenance (`legacyWorkspaceDataSourceDirs`) for
 *     stale server-DB paths, healed by #1529's provision ACK — the
 *     re-bind alias trusts only the EXACT managed path under a trusted
 *     legacy namespace, never basename resemblance.
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

describe('provision — post-migration stale legacy path alias (exact provenance)', () => {
  // The engine-owned move already happened: seed the finished durable
  // shape directly and keep only the legacy COORDINATE for provenance.
  function migratedRegistry(root: string): {
    registry: WorkspaceRegistry;
    legacy: string;
    durable: string;
  } {
    const legacy = join(root, 'run');
    const durable = join(root, 'workspace-data');
    seedFlatRegistry(durable, BINDING, 'ws-1');
    const registry = new WorkspaceRegistry({
      stateDir: durable,
      binding: BINDING,
      trustedLegacyNamespaceDirs: legacyNamespaceDirs([legacy], [BINDING]),
    });
    return { registry, legacy, durable };
  }

  it('re-binding with the EXACT pre-migration managed path is an idempotent no-op returning the durable path', () => {
    const root = tempDir();
    try {
      const { registry, legacy, durable } = migratedRegistry(root);
      const oldManaged = join(
        legacy,
        bindingSlug(BINDING),
        'workspaces',
        managedWorkspaceSlug('ws-1'),
      );
      const result = registry.provision('ws-1', oldManaged);
      expect(result.created).toBe(false);
      expect(result.path).toBe(join(durable, 'workspaces', 'ws-1'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a forged path with the same slug basename but a foreign parent is NOT provenance → path_conflict', () => {
    const root = tempDir();
    try {
      const { registry } = migratedRegistry(root);
      const forged = join(
        root,
        'evil',
        'workspaces',
        managedWorkspaceSlug('ws-1'),
      );
      let thrown: unknown;
      try {
        registry.provision('ws-1', forged);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(WorkspaceRegistryError);
      expect((thrown as WorkspaceRegistryError).code).toBe('path_conflict');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('without trusted legacy namespaces the alias is off entirely', () => {
    const root = tempDir();
    try {
      const { legacy, durable } = migratedRegistry(root);
      const bare = new WorkspaceRegistry({ stateDir: durable, binding: BINDING });
      const oldManaged = join(
        legacy,
        bindingSlug(BINDING),
        'workspaces',
        managedWorkspaceSlug('ws-1'),
      );
      expect(() => bare.provision('ws-1', oldManaged)).toThrow(/already bound/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

describe('legacyWorkspaceDataSourceDirs — alias provenance only (#task:1603)', () => {
  it('desktop-managed: exactly the RELEASED run/ root; no daemon/ or workspace-data readers (never released-producible)', () => {
    const root = '/approot';
    const dirs = legacyWorkspaceDataSourceDirs({
      daemonIdentityPath: join(root, 'computers', 'local', 'run', 'daemon-identity.json'),
      silverhandStateRoot: root,
    });
    expect(dirs).toEqual([join(root, 'run')]);
  });

  it('connect/custom (no identity file) has no legacy alias sources at all', () => {
    expect(
      legacyWorkspaceDataSourceDirs({
        daemonIdentityPath: null,
        silverhandStateRoot: '/approot',
      }),
    ).toEqual([]);
  });
});

describe('v2 cutover × stale run-era server row — provision alias (#task:1603 P0)', () => {
  it('after the ENGINE-owned move, a server row caching the run-era managed path re-binds idempotently with the v2 root in the ACK; forged basename twins are rejected', () => {
    const root = tempDir();
    try {
      const identityPath = join(root, 'computers', 'h-1', 'run', 'daemon-identity.json');
      const v2StateDir = join(root, 'computers', 'h-1', 'workspace-data');
      // The desktop layout engine already moved the run-era namespace,
      // rewrote its managed path, AND flattened it (#task:1608); the
      // daemon only sees the finished flat shape.
      const v2Managed = join(v2StateDir, 'workspaces', 'ws-1');
      mkdirSync(v2Managed, { recursive: true });
      writeFileSync(
        join(v2StateDir, 'workspace-registry.json'),
        JSON.stringify({
          schema_version: 1,
          binding: BINDING,
          workspaces: { 'ws-1': { path: v2Managed, provisioned_at: 1 } },
        }),
        'utf-8',
      );
      const aliasDirs = legacyWorkspaceDataSourceDirs({
        daemonIdentityPath: identityPath,
        silverhandStateRoot: root,
      });
      // Production shape (run.ts): trusted alias sources = the released
      // run-era root(s) PLUS this computer's own workspace-data root (the
      // intermediate slot-era slug coordinate); protected roots INCLUDE
      // the global root, so only exact alias provenance may pass.
      const registry = new WorkspaceRegistry({
        stateDir: v2StateDir,
        binding: BINDING,
        silverhandStateRoot: root,
        trustedLegacyNamespaceDirs: legacyNamespaceDirs(
          [...aliasDirs, v2StateDir],
          [BINDING],
        ),
        protectedRoots: [v2StateDir, join(root, 'computers', 'h-1', 'agents'), root],
      });
      const staleDbPath = join(
        root,
        'run',
        bindingSlug(BINDING),
        'workspaces',
        managedWorkspaceSlug('ws-1'),
      );
      const result = registry.provision('ws-1', staleDbPath);
      expect(result.created).toBe(false);
      expect(result.path).toBe(v2Managed);
      // A stale SLOT-ERA slug coordinate (pre-flatten intermediate) heals
      // the same way.
      const staleSlotEra = join(
        v2StateDir,
        bindingSlug(BINDING),
        'workspaces',
        managedWorkspaceSlug('ws-1'),
      );
      const slotEra = registry.provision('ws-1', staleSlotEra);
      expect(slotEra.created).toBe(false);
      expect(slotEra.path).toBe(v2Managed);
      // Same basename, foreign parent INSIDE the protected global root:
      // rejected by the protected-root guard (alias provenance is checked
      // first and did not match).
      const forgedInsideRoot = join(root, 'evil', 'workspaces', managedWorkspaceSlug('ws-1'));
      let thrownInside: unknown;
      try {
        registry.provision('ws-1', forgedInsideRoot);
      } catch (err) {
        thrownInside = err;
      }
      expect(thrownInside).toBeInstanceOf(WorkspaceRegistryError);
      expect((thrownInside as WorkspaceRegistryError).code).toBe('invalid_path');
      // Same basename OUTSIDE every protected root: still not provenance →
      // pure re-bind conflict, never a silent overwrite.
      const outside = tempDir();
      try {
        const forgedOutside = join(outside, 'workspaces', managedWorkspaceSlug('ws-1'));
        let thrownOutside: unknown;
        try {
          registry.provision('ws-1', forgedOutside);
        } catch (err) {
          thrownOutside = err;
        }
        expect(thrownOutside).toBeInstanceOf(WorkspaceRegistryError);
        expect((thrownOutside as WorkspaceRegistryError).code).toBe('path_conflict');
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
