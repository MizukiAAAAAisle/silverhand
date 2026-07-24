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
  migrateLegacyWorkspaceData,
} from '../../src/daemon/workspace-registry/state-dir.js';

/**
 * #task:1596 durability fix (Cindy P1, round 2) — workspace-data must live
 * in the EXPLICIT persistent computer data root, pre-fix namespaces
 * migrate narrowly and fail-closed:
 *   - coexistence (dest+source, or two sources) = ownership ambiguity →
 *     `migration_blocked`, every byte kept, NO registry;
 *   - rename + ATOMIC registry rewrite, with a deterministic dest-only
 *     repair covering a crash between the two;
 *   - any failure blocks — a legacy dir is never adopted as authority;
 *   - the stale-legacy-path re-bind alias trusts only the EXACT managed
 *     path under an explicitly trusted legacy namespace, never basename.
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

function seedLegacyNamespace(
  legacyStateDir: string,
  binding: RegistryBinding,
  workspaceId: string,
  opts: { requestedPathEntry?: string } = {},
): { nsDir: string; managedPath: string } {
  const nsDir = join(legacyStateDir, bindingSlug(binding));
  const managedPath = join(
    nsDir,
    'workspaces',
    managedWorkspaceSlug(workspaceId),
  );
  mkdirSync(managedPath, { recursive: true });
  // A guest L2 file that must survive migration byte-for-byte.
  const l2Dir = join(managedPath, '.silverhand', 'agents', 'agent-1');
  mkdirSync(l2Dir, { recursive: true });
  writeFileSync(join(l2Dir, 'MEMORY.md'), '# durable memory\n', 'utf-8');
  const workspaces: Record<string, { path: string; provisioned_at: number }> = {
    [workspaceId]: { path: managedPath, provisioned_at: 1 },
  };
  if (opts.requestedPathEntry) {
    workspaces['ws-user'] = { path: opts.requestedPathEntry, provisioned_at: 2 };
  }
  writeFileSync(
    join(nsDir, 'workspace-registry.json'),
    JSON.stringify({ schema_version: 1, binding, workspaces }, null, 2),
    'utf-8',
  );
  return { nsDir, managedPath };
}

function expectMigrationBlocked(fn: () => void): WorkspaceRegistryError {
  let thrown: unknown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(WorkspaceRegistryError);
  expect((thrown as WorkspaceRegistryError).code).toBe('migration_blocked');
  return thrown as WorkspaceRegistryError;
}

describe('defaultWorkspaceDataRootDir', () => {
  it('is the global durable root (used only when the embedder passes nothing)', () => {
    expect(
      defaultWorkspaceDataRootDir().endsWith('/.silverhand/workspace-data'),
    ).toBe(true);
  });
});

describe('migrateLegacyWorkspaceData', () => {
  it('renames a pre-fix namespace into the durable dir, preserves L2 bytes, and repoints managed entry paths', () => {
    const root = tempDir();
    try {
      const legacy = join(root, 'run'); // desktop's wipeable dir
      const durable = join(root, 'workspace-data');
      const userPath = join(root, 'user-project');
      const { managedPath: oldManaged } = seedLegacyNamespace(
        legacy,
        BINDING,
        'ws-1',
        { requestedPathEntry: userPath },
      );

      migrateLegacyWorkspaceData({
        stateDir: durable,
        legacyStateDirs: [legacy],
        bindings: [BINDING],
      });

      const newNs = join(durable, bindingSlug(BINDING));
      const newManaged = join(newNs, 'workspaces', managedWorkspaceSlug('ws-1'));
      // The whole namespace moved; the old one is gone (wiping run/ is now safe).
      expect(existsSync(oldManaged)).toBe(false);
      expect(
        readFileSync(
          join(newManaged, '.silverhand', 'agents', 'agent-1', 'MEMORY.md'),
          'utf-8',
        ),
      ).toBe('# durable memory\n');
      // Managed entry repointed; user-requested entry untouched.
      const file = JSON.parse(
        readFileSync(join(newNs, 'workspace-registry.json'), 'utf-8'),
      ) as { workspaces: Record<string, { path: string }> };
      expect(file.workspaces['ws-1']!.path).toBe(newManaged);
      expect(file.workspaces['ws-user']!.path).toBe(userPath);
      // And the registry itself resolves the migrated binding.
      const registry = new WorkspaceRegistry({
        stateDir: durable,
        binding: BINDING,
      });
      expect(registry.resolve('ws-1')).toBe(newManaged);
      expect(registry.resolve('ws-user')).toBe(userPath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is idempotent: a second run is a no-op', () => {
    const root = tempDir();
    try {
      const legacy = join(root, 'run');
      const durable = join(root, 'workspace-data');
      seedLegacyNamespace(legacy, BINDING, 'ws-1');
      migrateLegacyWorkspaceData({
        stateDir: durable,
        legacyStateDirs: [legacy],
        bindings: [BINDING],
      });
      const nsFile = join(durable, bindingSlug(BINDING), 'workspace-registry.json');
      const before = readFileSync(nsFile, 'utf-8');
      migrateLegacyWorkspaceData({
        stateDir: durable,
        legacyStateDirs: [legacy],
        bindings: [BINDING],
      });
      expect(readFileSync(nsFile, 'utf-8')).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('two bindings do not cross: each namespace migrates under its own slug', () => {
    const root = tempDir();
    try {
      const legacy = join(root, 'daemon');
      const durable = join(root, 'workspace-data');
      seedLegacyNamespace(legacy, BINDING, 'ws-a');
      seedLegacyNamespace(legacy, OTHER_BINDING, 'ws-b');
      migrateLegacyWorkspaceData({
        stateDir: durable,
        legacyStateDirs: [legacy],
        bindings: [BINDING, OTHER_BINDING],
      });
      const regA = new WorkspaceRegistry({ stateDir: durable, binding: BINDING });
      const regB = new WorkspaceRegistry({
        stateDir: durable,
        binding: OTHER_BINDING,
      });
      expect(regA.resolve('ws-a')).toContain(bindingSlug(BINDING));
      expect(regB.resolve('ws-b')).toContain(bindingSlug(OTHER_BINDING));
      expect(() => regA.resolve('ws-b')).toThrow();
      expect(() => regB.resolve('ws-a')).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('destination + legacy source coexisting = ownership ambiguity → migration_blocked, all bytes kept', () => {
    const root = tempDir();
    try {
      const legacy = join(root, 'run');
      const durable = join(root, 'workspace-data');
      seedLegacyNamespace(legacy, BINDING, 'ws-old');
      const destNs = join(durable, bindingSlug(BINDING));
      mkdirSync(destNs, { recursive: true });
      writeFileSync(
        join(destNs, 'workspace-registry.json'),
        JSON.stringify({ schema_version: 1, binding: BINDING, workspaces: {} }),
        'utf-8',
      );
      const destBefore = readFileSync(
        join(destNs, 'workspace-registry.json'),
        'utf-8',
      );
      expectMigrationBlocked(() =>
        migrateLegacyWorkspaceData({
          stateDir: durable,
          legacyStateDirs: [legacy],
          bindings: [BINDING],
        }),
      );
      // Nothing deleted or overwritten on either side.
      expect(existsSync(join(legacy, bindingSlug(BINDING)))).toBe(true);
      expect(readFileSync(join(destNs, 'workspace-registry.json'), 'utf-8')).toBe(
        destBefore,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('two legacy sources coexisting = ownership ambiguity → migration_blocked, neither is picked', () => {
    const root = tempDir();
    try {
      const legacyRun = join(root, 'run');
      const legacyDaemon = join(root, 'daemon');
      const durable = join(root, 'workspace-data');
      seedLegacyNamespace(legacyRun, BINDING, 'ws-1');
      seedLegacyNamespace(legacyDaemon, BINDING, 'ws-2');
      expectMigrationBlocked(() =>
        migrateLegacyWorkspaceData({
          stateDir: durable,
          legacyStateDirs: [legacyRun, legacyDaemon],
          bindings: [BINDING],
        }),
      );
      expect(existsSync(join(legacyRun, bindingSlug(BINDING)))).toBe(true);
      expect(existsSync(join(legacyDaemon, bindingSlug(BINDING)))).toBe(true);
      expect(existsSync(join(durable, bindingSlug(BINDING)))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('crash between rename and rewrite: the next call deterministically repairs stale paths (atomically)', () => {
    const root = tempDir();
    try {
      const legacy = join(root, 'run');
      const durable = join(root, 'workspace-data');
      // Simulate the post-crash state: namespace already AT the durable
      // location (rename happened) but the registry file still points at
      // the legacy namespace (rewrite never ran).
      const destNs = join(durable, bindingSlug(BINDING));
      const staleManaged = join(
        legacy,
        bindingSlug(BINDING),
        'workspaces',
        managedWorkspaceSlug('ws-1'),
      );
      mkdirSync(join(destNs, 'workspaces', managedWorkspaceSlug('ws-1')), {
        recursive: true,
      });
      writeFileSync(
        join(destNs, 'workspace-registry.json'),
        JSON.stringify({
          schema_version: 1,
          binding: BINDING,
          workspaces: { 'ws-1': { path: staleManaged, provisioned_at: 1 } },
        }),
        'utf-8',
      );
      migrateLegacyWorkspaceData({
        stateDir: durable,
        legacyStateDirs: [legacy],
        bindings: [BINDING],
      });
      const repaired = JSON.parse(
        readFileSync(join(destNs, 'workspace-registry.json'), 'utf-8'),
      ) as { workspaces: Record<string, { path: string }> };
      expect(repaired.workspaces['ws-1']!.path).toBe(
        join(destNs, 'workspaces', managedWorkspaceSlug('ws-1')),
      );
      // No temp file left behind (atomic replace completed).
      expect(existsSync(join(destNs, 'workspace-registry.json.migrating'))).toBe(
        false,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rename failure (e.g. permissions/EXDEV) → migration_blocked; the legacy tree is untouched and NOT adopted', () => {
    const root = tempDir();
    try {
      const legacy = join(root, 'run');
      const durable = join(root, 'blocked', 'workspace-data');
      seedLegacyNamespace(legacy, BINDING, 'ws-1');
      // Make the durable parent unwritable so mkdir/rename fails.
      mkdirSync(join(root, 'blocked'), { recursive: true });
      chmodSync(join(root, 'blocked'), 0o500);
      try {
        expectMigrationBlocked(() =>
          migrateLegacyWorkspaceData({
            stateDir: durable,
            legacyStateDirs: [legacy],
            bindings: [BINDING],
          }),
        );
      } finally {
        chmodSync(join(root, 'blocked'), 0o700);
      }
      expect(existsSync(join(legacy, bindingSlug(BINDING)))).toBe(true);
      expect(existsSync(join(durable, bindingSlug(BINDING)))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a later binding failing blocks the whole call — the current binding cannot silently switch authority', () => {
    const root = tempDir();
    try {
      const legacyRun = join(root, 'run');
      const legacyDaemon = join(root, 'daemon');
      const durable = join(root, 'workspace-data');
      // Current binding migrates cleanly; the legacy binding is ambiguous
      // (present in BOTH legacy dirs) → the whole call must throw.
      seedLegacyNamespace(legacyRun, BINDING, 'ws-cur');
      seedLegacyNamespace(legacyRun, OTHER_BINDING, 'ws-leg');
      seedLegacyNamespace(legacyDaemon, OTHER_BINDING, 'ws-leg');
      expectMigrationBlocked(() =>
        migrateLegacyWorkspaceData({
          stateDir: durable,
          legacyStateDirs: [legacyRun, legacyDaemon],
          bindings: [BINDING, OTHER_BINDING],
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('provision — post-migration stale legacy path alias (exact provenance)', () => {
  function migratedRegistry(root: string): {
    registry: WorkspaceRegistry;
    legacy: string;
    durable: string;
  } {
    const legacy = join(root, 'run');
    const durable = join(root, 'workspace-data');
    seedLegacyNamespace(legacy, BINDING, 'ws-1');
    migrateLegacyWorkspaceData({
      stateDir: durable,
      legacyStateDirs: [legacy],
      bindings: [BINDING],
    });
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
      expect(result.path).toBe(
        join(durable, bindingSlug(BINDING), 'workspaces', managedWorkspaceSlug('ws-1')),
      );
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

describe('copyLegacyEntry × migration — pre-claim upgrade combo (#task:1596 round 3 P1-2)', () => {
  const PRED: RegistryBinding = {
    server_origin: 'local-embedded',
    host_id: 'local',
  };

  it('a server-stale requested path for a MIGRATED predecessor namespace copies the durable path (old MEMORY intact)', () => {
    const root = tempDir();
    try {
      const legacy = join(root, 'run');
      const durable = join(root, 'workspace-data');
      seedLegacyNamespace(legacy, PRED, 'ws-up');
      // The server's legacy column still carries the PRE-migration managed
      // path of the predecessor binding.
      const staleSourcePath = join(
        legacy,
        bindingSlug(PRED),
        'workspaces',
        managedWorkspaceSlug('ws-up'),
      );
      migrateLegacyWorkspaceData({
        stateDir: durable,
        legacyStateDirs: [legacy],
        bindings: [BINDING, PRED],
      });
      const registry = new WorkspaceRegistry({
        stateDir: durable,
        binding: BINDING,
        legacyBindings: [PRED],
        trustedLegacyNamespaceDirs: legacyNamespaceDirs([legacy], [BINDING, PRED]),
      });
      const durablePredPath = join(
        durable,
        bindingSlug(PRED),
        'workspaces',
        managedWorkspaceSlug('ws-up'),
      );
      // No path_conflict: the stale proposal is recognized by exact
      // structural provenance and the DURABLE predecessor path is copied
      // (the ack heals the server column).
      const result = registry.provision('ws-up', staleSourcePath);
      expect(result).toEqual({ path: durablePredPath, created: false });
      expect(registry.resolve('ws-up')).toBe(durablePredPath);
      expect(
        readFileSync(
          join(durablePredPath, '.silverhand', 'agents', 'agent-1', 'MEMORY.md'),
          'utf-8',
        ),
      ).toBe('# durable memory\n');
      // A forged same-basename path under a foreign parent for the SAME
      // legacy workspace is NOT provenance → path_conflict.
      let forged: unknown;
      try {
        registry.provision(
          'ws-up',
          join(root, 'evil', 'workspaces', managedWorkspaceSlug('ws-up')),
        );
      } catch (err) {
        forged = err;
      }
      expect(forged).toBeInstanceOf(WorkspaceRegistryError);
      expect((forged as WorkspaceRegistryError).code).toBe('path_conflict');
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

describe('repair × pre-existing legacyBindings handoff (#task:1596 round 4 P1-1)', () => {
  const PRED: RegistryBinding = {
    server_origin: 'local-embedded',
    host_id: 'local',
  };

  it('a current-binding entry pointing into the PREDECESSOR namespace follows the predecessor to ITS durable namespace', () => {
    const root = tempDir();
    try {
      const legacy = join(root, 'run');
      const durable = join(root, 'workspace-data');
      // Predecessor namespace with the real MEMORY bytes.
      seedLegacyNamespace(legacy, PRED, 'ws-h');
      const predLegacyManaged = join(
        legacy,
        bindingSlug(PRED),
        'workspaces',
        managedWorkspaceSlug('ws-h'),
      );
      // Current-binding registry ALSO in the legacy root, whose entry was
      // produced by a pre-upgrade copyLegacyEntry handoff: it points into
      // the predecessor's managed root.
      const curNs = join(legacy, bindingSlug(BINDING));
      mkdirSync(join(curNs, 'workspaces'), { recursive: true });
      writeFileSync(
        join(curNs, 'workspace-registry.json'),
        JSON.stringify({
          schema_version: 1,
          binding: BINDING,
          workspaces: {
            'ws-h': { path: predLegacyManaged, provisioned_at: 1 },
          },
        }),
        'utf-8',
      );
      migrateLegacyWorkspaceData({
        stateDir: durable,
        legacyStateDirs: [legacy],
        bindings: [BINDING, PRED],
      });
      const durablePredManaged = join(
        durable,
        bindingSlug(PRED),
        'workspaces',
        managedWorkspaceSlug('ws-h'),
      );
      // The current registry resolves the PREDECESSOR'S durable namespace —
      // never workspace-data/<current>/... (which does not exist).
      const current = new WorkspaceRegistry({ stateDir: durable, binding: BINDING });
      expect(current.resolve('ws-h')).toBe(durablePredManaged);
      expect(
        readFileSync(
          join(durablePredManaged, '.silverhand', 'agents', 'agent-1', 'MEMORY.md'),
          'utf-8',
        ),
      ).toBe('# durable memory\n');
      expect(
        existsSync(
          join(durable, bindingSlug(BINDING), 'workspaces', managedWorkspaceSlug('ws-h')),
        ),
      ).toBe(false);
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
