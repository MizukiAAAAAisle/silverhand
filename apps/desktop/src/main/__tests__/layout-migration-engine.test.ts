/**
 * #task:1603 — eager layout-v2 migration engine falsifiers
 * (docs/app-data-layout-v2.md §5/§6 + §8 acceptance rows that are
 * decidable on a temp filesystem).
 */
import { describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindingSlug, cwdSessionSlug, managedWorkspaceSlug } from '@silverhand/host';
import {
  LayoutMigrationError,
  migrateDesktopAppDataLayout,
  rewriteStagedRegistries,
} from '../layout-migration/engine.js';
import {
  layoutVersionFromMarker,
  readDataLayoutMarker,
  writeDataLayoutMarker,
} from '../layout-migration/marker.js';

const silent = { info: () => {}, warn: () => {} };
const BINDING = { server_origin: 'local-embedded', host_id: 'h1' };
const NS = bindingSlug(BINDING);
const REMOTE_BINDING = { server_origin: 'https://silverhand.example', host_id: 'h1' };
const REMOTE_NS = bindingSlug(REMOTE_BINDING);
const PLACEHOLDER_BINDING = { server_origin: 'local-embedded', host_id: 'local' };
const PLACEHOLDER_NS = bindingSlug(PLACEHOLDER_BINDING);
const WS_ID = 'w_test_1';

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'sh-layout-v2-'));
}

function seedLegacyEmbedded(root: string): void {
  writeFileSync(join(root, 'silverhand.db'), 'db-bytes');
  writeFileSync(join(root, 'silverhand.db-wal'), 'wal');
  mkdirSync(join(root, 'blobs', 'ab'), { recursive: true });
  writeFileSync(join(root, 'blobs', 'ab', 'blob1'), 'blob');
  writeFileSync(join(root, 'server-config.json'), '{"mode":"embedded"}');
}

/** The RELEASED pre-v2 local-computer shape: L1 agents at the top level,
 *  the registry namespace under `run/<binding-slug>/`. */
function seedLegacyLocalComputer(root: string): { managed: string } {
  mkdirSync(join(root, 'agents', 'agent-1'), { recursive: true });
  writeFileSync(join(root, 'agents', 'agent-1', 'system_prompt.md'), 'role');
  const nsDir = join(root, 'run', NS);
  const managed = join(nsDir, 'workspaces', managedWorkspaceSlug(WS_ID));
  mkdirSync(managed, { recursive: true });
  writeFileSync(join(managed, 'MEMORY.md'), 'memory');
  writeFileSync(
    join(nsDir, 'workspace-registry.json'),
    JSON.stringify({
      schema_version: 1,
      binding: BINDING,
      workspaces: {
        [WS_ID]: { path: managed, provisioned_at: 1 },
        w_external: { path: '/Users/u/real-project', provisioned_at: 1 },
      },
    }),
  );
  // Transient run/ siblings that must never move.
  writeFileSync(join(root, 'run', 'daemon.pid'), '123');
  mkdirSync(join(root, 'run', 'runtime-pids'), { recursive: true });
  writeFileSync(join(root, 'daemon-config.json'), '{"host_id":"h1","server_url":"http://127.0.0.1:1234"}');
  return { managed };
}

/**
 * Released pre-v2 handoff shape: the active remote registry copied the
 * exact managed entry from the pre-claim local placeholder registry.
 * Both registries intentionally reference one physical predecessor dir.
 */
function seedCrossBindingLegacyWorkspace(
  root: string,
  predecessorBinding = PLACEHOLDER_BINDING,
): { predecessorManaged: string; predecessorNamespace: string } {
  const predecessorNamespace = bindingSlug(predecessorBinding);
  const predecessorManaged = join(
    root,
    'run',
    predecessorNamespace,
    'workspaces',
    managedWorkspaceSlug(WS_ID),
  );
  mkdirSync(predecessorManaged, { recursive: true });
  writeFileSync(join(predecessorManaged, 'MEMORY.md'), 'cross-binding-memory');
  writeFileSync(
    join(root, 'run', predecessorNamespace, 'workspace-registry.json'),
    JSON.stringify({
      schema_version: 1,
      binding: predecessorBinding,
      workspaces: {
        [WS_ID]: { path: predecessorManaged, provisioned_at: 1 },
      },
    }),
  );
  mkdirSync(join(root, 'run', REMOTE_NS), { recursive: true });
  writeFileSync(
    join(root, 'run', REMOTE_NS, 'workspace-registry.json'),
    JSON.stringify({
      schema_version: 1,
      binding: REMOTE_BINDING,
      workspaces: {
        [WS_ID]: { path: predecessorManaged, provisioned_at: 1 },
        w_external: { path: '/Users/u/real-project', provisioned_at: 2 },
      },
    }),
  );
  writeFileSync(
    join(root, 'daemon-config.json'),
    JSON.stringify({
      host_id: REMOTE_BINDING.host_id,
      server_url: REMOTE_BINDING.server_origin,
    }),
  );
  return { predecessorManaged, predecessorNamespace };
}

/** The cwd slug is a function of (runtime kind, cwd) — the two vendors hash the
 *  over-long tail differently (#task:1816). Map a fixture store dir to its kind. */
function sessionKind(store: string): 'claude' | 'qoder' {
  return store === '.claude' ? 'claude' : 'qoder';
}

/** A fake session-store home with claude+qoder buckets for a cwd. */
function seedSessionStores(home: string, cwd: string): void {
  for (const store of ['.claude', '.qoder']) {
    const bucket = join(home, store, 'projects', cwdSessionSlug(sessionKind(store), cwd));
    mkdirSync(bucket, { recursive: true });
    writeFileSync(join(bucket, 'session-1.jsonl'), `{"store":"${store}"}`);
  }
}

/** The first layout-v2 release preserved `_` in the cwd slug. */
function seedReleasedV2SessionStores(home: string, cwd: string): void {
  const releasedSlug = cwd.replace(/[/.]/g, '-');
  for (const store of ['.claude', '.qoder']) {
    const bucket = join(home, store, 'projects', releasedSlug);
    mkdirSync(bucket, { recursive: true });
    writeFileSync(join(bucket, 'session-1.jsonl'), `{"store":"${store}"}`);
  }
}

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), 'sh-home-'));
}

describe('migrateDesktopAppDataLayout — eager move + session pass', () => {
  it('migrates a full legacy install: bytes survive, run-era registries rewrite to exact v2 coordinates, session namespaces rename, marker lands, re-run is a no-op', () => {
    const root = makeRoot();
    const home = makeHome();
    try {
      seedLegacyEmbedded(root);
      const { managed } = seedLegacyLocalComputer(root);
      seedSessionStores(home, managed);
      seedSessionStores(home, join(root, 'agents', 'agent-1'));

      const r = migrateDesktopAppDataLayout(root, silent, Date.now, {
        sessionStoreHome: home,
        env: {},
      });
      expect(r.migrated).toBe(true);
      expect(r.facets).toEqual({ localComputer: 'migrated', embeddedServer: 'migrated' });
      expect(r.sessions).toBe('migrated');

      // Embedded facet at v2, byte-for-byte.
      expect(readFileSync(join(root, 'embedded-server', 'silverhand.db'), 'utf8')).toBe('db-bytes');
      expect(readFileSync(join(root, 'embedded-server', 'blobs', 'ab', 'blob1'), 'utf8')).toBe('blob');
      expect(existsSync(join(root, 'embedded-server', 'config', 'server-config.json'))).toBe(true);
      // Local-computer facet at v2 — including the run-era namespace.
      expect(readFileSync(join(root, 'computers', 'h1', 'agents', 'agent-1', 'system_prompt.md'), 'utf8')).toBe('role');
      expect(existsSync(join(root, 'desktop', 'computer-binding.json'))).toBe(true);
      expect(existsSync(join(root, 'daemon-config.json'))).toBe(false);
      // #task:1608 convergence: the current binding's namespace is
      // FLATTENED — registry directly on workspace-data/, managed dir by
      // raw workspace id.
      const v2Managed = join(
        root, 'computers', 'h1', 'workspace-data', 'workspaces', WS_ID,
      );
      expect(readFileSync(join(v2Managed, 'MEMORY.md'), 'utf8')).toBe('memory');
      const registry = JSON.parse(
        readFileSync(
          join(root, 'computers', 'h1', 'workspace-data', 'workspace-registry.json'),
          'utf8',
        ),
      ) as { workspaces: Record<string, { path: string }> };
      expect(registry.workspaces[WS_ID]!.path).toBe(v2Managed);
      expect(registry.workspaces['w_external']!.path).toBe('/Users/u/real-project');
      // The slug namespace is fully consumed (registry lifted, dir renamed).
      expect(existsSync(join(root, 'computers', 'h1', 'workspace-data', NS))).toBe(false);
      // Transient run/ state untouched; namespace dir gone from run/.
      expect(readFileSync(join(root, 'run', 'daemon.pid'), 'utf8')).toBe('123');
      expect(existsSync(join(root, 'run', NS))).toBe(false);
      // Session namespaces renamed for BOTH stores and BOTH cwd kinds.
      for (const store of ['.claude', '.qoder']) {
        expect(
          readFileSync(
            join(home, store, 'projects', cwdSessionSlug(sessionKind(store), v2Managed), 'session-1.jsonl'),
            'utf8',
          ),
        ).toContain(store);
        expect(existsSync(join(home, store, 'projects', cwdSessionSlug(sessionKind(store), managed)))).toBe(false);
        const v2AgentHome = join(root, 'computers', 'h1', 'agents', 'agent-1');
        expect(existsSync(join(home, store, 'projects', cwdSessionSlug(sessionKind(store), v2AgentHome)))).toBe(true);
      }
      // Legacy sources gone; staging gone; marker selects v2 WITH sessions.
      expect(existsSync(join(root, 'agents'))).toBe(false);
      expect(existsSync(join(root, 'silverhand.db'))).toBe(false);
      expect(existsSync(join(root, 'computers', '.local-layout-v2.staging'))).toBe(false);
      const marker = readDataLayoutMarker(join(root, 'desktop', 'data-layout.json'));
      expect(layoutVersionFromMarker(marker)).toBe('v2');
      expect(marker.state === 'v2' && marker.marker.sessions != null).toBe(true);
      expect(marker.state === 'v2' && marker.marker.workspace_layout != null).toBe(true);

      // Re-run: pure no-op.
      const again = migrateDesktopAppDataLayout(root, silent, Date.now, {
        sessionStoreHome: home,
        env: {},
      });
      expect(again.migrated).toBe(false);
      expect(again.sessions).toBe('already');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('adopts an exact managed workspace copied from a pre-claim binding into the current remote binding', () => {
    const root = makeRoot();
    const home = makeHome();
    try {
      const { predecessorManaged } = seedCrossBindingLegacyWorkspace(root);
      seedSessionStores(home, predecessorManaged);

      const result = migrateDesktopAppDataLayout(root, silent, Date.now, {
        sessionStoreHome: home,
        env: {},
      });

      expect(result.migrated).toBe(true);
      const workspaceData = join(root, 'computers', REMOTE_BINDING.host_id, 'workspace-data');
      const finalManaged = join(workspaceData, 'workspaces', WS_ID);
      expect(readFileSync(join(finalManaged, 'MEMORY.md'), 'utf8')).toBe('cross-binding-memory');
      const currentRegistry = JSON.parse(
        readFileSync(join(workspaceData, 'workspace-registry.json'), 'utf8'),
      ) as { binding: typeof REMOTE_BINDING; workspaces: Record<string, { path: string }> };
      expect(currentRegistry.binding).toEqual(REMOTE_BINDING);
      expect(currentRegistry.workspaces[WS_ID]!.path).toBe(finalManaged);
      expect(currentRegistry.workspaces['w_external']!.path).toBe('/Users/u/real-project');

      // The pre-claim registry remains inert historical provenance, but its
      // managed bytes have one owner: the active remote binding.
      const predecessorRegistry = join(
        workspaceData,
        PLACEHOLDER_NS,
        'workspace-registry.json',
      );
      expect(existsSync(predecessorRegistry)).toBe(true);
      expect(
        existsSync(
          join(
            workspaceData,
            PLACEHOLDER_NS,
            'workspaces',
            managedWorkspaceSlug(WS_ID),
          ),
        ),
      ).toBe(false);

      // Session identity follows the ownership adoption directly from
      // predecessor cwd to the final flat remote cwd.
      for (const store of ['.claude', '.qoder']) {
        expect(
          existsSync(join(home, store, 'projects', cwdSessionSlug(sessionKind(store), finalManaged), 'session-1.jsonl')),
        ).toBe(true);
        expect(
          existsSync(join(home, store, 'projects', cwdSessionSlug(sessionKind(store), predecessorManaged))),
        ).toBe(false);
      }
      expect(
        layoutVersionFromMarker(readDataLayoutMarker(join(root, 'desktop', 'data-layout.json'))),
      ).toBe('v2');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('selects the exact remote binding when the same host id also has an inert local-embedded namespace', () => {
    const root = makeRoot();
    const home = makeHome();
    try {
      const remoteManaged = join(
        root,
        'run',
        REMOTE_NS,
        'workspaces',
        managedWorkspaceSlug(WS_ID),
      );
      mkdirSync(remoteManaged, { recursive: true });
      writeFileSync(join(remoteManaged, 'MEMORY.md'), 'remote-current-memory');
      writeFileSync(
        join(root, 'run', REMOTE_NS, 'workspace-registry.json'),
        JSON.stringify({
          schema_version: 1,
          binding: REMOTE_BINDING,
          workspaces: {
            [WS_ID]: { path: remoteManaged, provisioned_at: 1 },
          },
        }),
      );

      const historicalWorkspaceId = 'w_historical';
      const historicalSameIdManaged = join(
        root,
        'run',
        NS,
        'workspaces',
        managedWorkspaceSlug(WS_ID),
      );
      const historicalManaged = join(
        root,
        'run',
        NS,
        'workspaces',
        managedWorkspaceSlug(historicalWorkspaceId),
      );
      mkdirSync(historicalSameIdManaged, { recursive: true });
      writeFileSync(join(historicalSameIdManaged, 'MEMORY.md'), 'local-same-id-history');
      mkdirSync(historicalManaged, { recursive: true });
      writeFileSync(join(historicalManaged, 'MEMORY.md'), 'local-history');
      writeFileSync(
        join(root, 'run', NS, 'workspace-registry.json'),
        JSON.stringify({
          schema_version: 1,
          binding: BINDING,
          workspaces: {
            [WS_ID]: {
              path: historicalSameIdManaged,
              provisioned_at: 1,
            },
            [historicalWorkspaceId]: {
              path: historicalManaged,
              provisioned_at: 1,
            },
          },
        }),
      );
      writeFileSync(
        join(root, 'daemon-config.json'),
        JSON.stringify({
          host_id: REMOTE_BINDING.host_id,
          server_url: REMOTE_BINDING.server_origin,
        }),
      );

      expect(() =>
        migrateDesktopAppDataLayout(root, silent, Date.now, {
          sessionStoreHome: home,
          env: {},
        }),
      ).not.toThrow();

      const workspaceData = join(root, 'computers', REMOTE_BINDING.host_id, 'workspace-data');
      expect(
        readFileSync(join(workspaceData, 'workspaces', WS_ID, 'MEMORY.md'), 'utf8'),
      ).toBe('remote-current-memory');
      expect(
        readFileSync(
          join(
            workspaceData,
            NS,
            'workspaces',
            managedWorkspaceSlug(WS_ID),
            'MEMORY.md',
          ),
          'utf8',
        ),
      ).toBe('local-same-id-history');
      expect(
        readFileSync(
          join(
            workspaceData,
            NS,
            'workspaces',
            managedWorkspaceSlug(historicalWorkspaceId),
            'MEMORY.md',
          ),
          'utf8',
        ),
      ).toBe('local-history');
      const currentRegistry = JSON.parse(
        readFileSync(join(workspaceData, 'workspace-registry.json'), 'utf8'),
      ) as { binding: typeof REMOTE_BINDING; workspaces: Record<string, unknown> };
      expect(currentRegistry.binding).toEqual(REMOTE_BINDING);
      expect(currentRegistry.workspaces).not.toHaveProperty(historicalWorkspaceId);
      expect(existsSync(join(workspaceData, NS, 'workspace-registry.json'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('does not promote same-host local-embedded history when the configured remote namespace is absent', () => {
    const root = makeRoot();
    const home = makeHome();
    try {
      const { managed } = seedLegacyLocalComputer(root);
      writeFileSync(
        join(root, 'daemon-config.json'),
        JSON.stringify({
          host_id: REMOTE_BINDING.host_id,
          server_url: REMOTE_BINDING.server_origin,
        }),
      );

      expect(() =>
        migrateDesktopAppDataLayout(root, silent, Date.now, {
          sessionStoreHome: home,
          env: {},
        }),
      ).not.toThrow();

      const workspaceData = join(root, 'computers', REMOTE_BINDING.host_id, 'workspace-data');
      const historicalManaged = join(
        workspaceData,
        NS,
        'workspaces',
        managedWorkspaceSlug(WS_ID),
      );
      expect(readFileSync(join(historicalManaged, 'MEMORY.md'), 'utf8')).toBe('memory');
      expect(existsSync(join(workspaceData, NS, 'workspace-registry.json'))).toBe(true);
      expect(existsSync(join(workspaceData, 'workspace-registry.json'))).toBe(false);
      expect(existsSync(join(workspaceData, 'workspaces', WS_ID))).toBe(false);
      expect(existsSync(managed)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('resumes after the computer tree and binding moved but the marker did not: exact remote wins over same-host local history', () => {
    const root = makeRoot();
    const home = makeHome();
    try {
      const workspaceData = join(root, 'computers', REMOTE_BINDING.host_id, 'workspace-data');
      const remoteManaged = join(
        workspaceData,
        REMOTE_NS,
        'workspaces',
        managedWorkspaceSlug(WS_ID),
      );
      mkdirSync(remoteManaged, { recursive: true });
      writeFileSync(join(remoteManaged, 'MEMORY.md'), 'remote-after-move');
      writeFileSync(
        join(workspaceData, REMOTE_NS, 'workspace-registry.json'),
        JSON.stringify({
          schema_version: 1,
          binding: REMOTE_BINDING,
          workspaces: {
            [WS_ID]: { path: remoteManaged, provisioned_at: 1 },
          },
        }),
      );

      const historicalManaged = join(
        workspaceData,
        NS,
        'workspaces',
        managedWorkspaceSlug(WS_ID),
      );
      mkdirSync(historicalManaged, { recursive: true });
      writeFileSync(join(historicalManaged, 'MEMORY.md'), 'local-after-move');
      writeFileSync(
        join(workspaceData, NS, 'workspace-registry.json'),
        JSON.stringify({
          schema_version: 1,
          binding: BINDING,
          workspaces: {
            [WS_ID]: { path: historicalManaged, provisioned_at: 1 },
          },
        }),
      );
      mkdirSync(join(root, 'desktop'), { recursive: true });
      writeFileSync(
        join(root, 'desktop', 'computer-binding.json'),
        JSON.stringify({
          host_id: REMOTE_BINDING.host_id,
          server_url: REMOTE_BINDING.server_origin,
        }),
      );

      const result = migrateDesktopAppDataLayout(root, silent, Date.now, {
        sessionStoreHome: home,
        env: {},
      });

      expect(result.migrated).toBe(true);
      expect(readFileSync(join(workspaceData, 'workspaces', WS_ID, 'MEMORY.md'), 'utf8')).toBe(
        'remote-after-move',
      );
      expect(readFileSync(join(historicalManaged, 'MEMORY.md'), 'utf8')).toBe(
        'local-after-move',
      );
      expect(existsSync(join(workspaceData, NS, 'workspace-registry.json'))).toBe(true);
      expect(
        layoutVersionFromMarker(readDataLayoutMarker(join(root, 'desktop', 'data-layout.json'))),
      ).toBe('v2');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('adopts a proven managed workspace from a same-host local-embedded predecessor into the exact remote binding', () => {
    const root = makeRoot();
    const home = makeHome();
    try {
      const { predecessorManaged, predecessorNamespace } =
        seedCrossBindingLegacyWorkspace(root, BINDING);
      seedSessionStores(home, predecessorManaged);

      expect(() =>
        migrateDesktopAppDataLayout(root, silent, Date.now, {
          sessionStoreHome: home,
          env: {},
        }),
      ).not.toThrow();

      const workspaceData = join(root, 'computers', REMOTE_BINDING.host_id, 'workspace-data');
      const finalManaged = join(workspaceData, 'workspaces', WS_ID);
      expect(readFileSync(join(finalManaged, 'MEMORY.md'), 'utf8')).toBe(
        'cross-binding-memory',
      );
      expect(
        existsSync(
          join(
            workspaceData,
            predecessorNamespace,
            'workspaces',
            managedWorkspaceSlug(WS_ID),
          ),
        ),
      ).toBe(false);
      expect(existsSync(join(workspaceData, predecessorNamespace, 'workspace-registry.json'))).toBe(
        true,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('cross-binding adoption resumes after the managed dir moved into staging but before registry replacement', () => {
    const root = makeRoot();
    const home = makeHome();
    try {
      const { predecessorManaged } = seedCrossBindingLegacyWorkspace(root);
      seedSessionStores(home, predecessorManaged);
      const stagingWorkspaceData = join(
        root,
        'computers',
        '.local-layout-v2.staging',
        'workspace-data',
      );
      mkdirSync(stagingWorkspaceData, { recursive: true });
      renameSync(
        join(root, 'run', PLACEHOLDER_NS),
        join(stagingWorkspaceData, PLACEHOLDER_NS),
      );
      renameSync(
        join(root, 'run', REMOTE_NS),
        join(stagingWorkspaceData, REMOTE_NS),
      );
      const slug = managedWorkspaceSlug(WS_ID);
      mkdirSync(join(stagingWorkspaceData, REMOTE_NS, 'workspaces'), { recursive: true });
      renameSync(
        join(stagingWorkspaceData, PLACEHOLDER_NS, 'workspaces', slug),
        join(stagingWorkspaceData, REMOTE_NS, 'workspaces', slug),
      );

      expect(() =>
        migrateDesktopAppDataLayout(root, silent, Date.now, {
          sessionStoreHome: home,
          env: {},
        }),
      ).not.toThrow();
      expect(
        readFileSync(
          join(
            root,
            'computers',
            REMOTE_BINDING.host_id,
            'workspace-data',
            'workspaces',
            WS_ID,
            'MEMORY.md',
          ),
          'utf8',
        ),
      ).toBe('cross-binding-memory');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('a cross-binding path without a same-id exact predecessor registry proof remains blocked', () => {
    const root = makeRoot();
    const home = makeHome();
    try {
      const { predecessorManaged } = seedCrossBindingLegacyWorkspace(root);
      const predecessorRegistry = join(
        root,
        'run',
        PLACEHOLDER_NS,
        'workspace-registry.json',
      );
      writeFileSync(
        predecessorRegistry,
        JSON.stringify({
          schema_version: 1,
          binding: PLACEHOLDER_BINDING,
          workspaces: {},
        }),
      );

      expect(() =>
        migrateDesktopAppDataLayout(root, silent, Date.now, {
          sessionStoreHome: home,
          env: {},
        }),
      ).toThrow(/predecessor registry/);
      expect(readFileSync(join(predecessorManaged, 'MEMORY.md'), 'utf8')).toBe(
        'cross-binding-memory',
      );
      expect(
        layoutVersionFromMarker(readDataLayoutMarker(join(root, 'desktop', 'data-layout.json'))),
      ).toBe('legacy-v1');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('cross-binding source and current managed dirs coexisting is an ownership conflict, never a merge', () => {
    const root = makeRoot();
    const home = makeHome();
    try {
      const { predecessorManaged } = seedCrossBindingLegacyWorkspace(root);
      const currentManaged = join(
        root,
        'run',
        REMOTE_NS,
        'workspaces',
        managedWorkspaceSlug(WS_ID),
      );
      mkdirSync(currentManaged, { recursive: true });
      writeFileSync(join(currentManaged, 'MEMORY.md'), 'different-current-memory');

      expect(() =>
        migrateDesktopAppDataLayout(root, silent, Date.now, {
          sessionStoreHome: home,
          env: {},
        }),
      ).toThrow(/both predecessor and current coordinates/);
      expect(readFileSync(join(predecessorManaged, 'MEMORY.md'), 'utf8')).toBe(
        'cross-binding-memory',
      );
      expect(readFileSync(join(currentManaged, 'MEMORY.md'), 'utf8')).toBe(
        'different-current-memory',
      );
      expect(
        layoutVersionFromMarker(readDataLayoutMarker(join(root, 'desktop', 'data-layout.json'))),
      ).toBe('legacy-v1');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('duplicate namespace snapshots defer to the facet ownership conflict instead of adding a planner-only rejection', () => {
    const root = makeRoot();
    const home = makeHome();
    try {
      seedLegacyLocalComputer(root);
      const stagingNamespace = join(
        root,
        'computers',
        '.local-layout-v2.staging',
        'workspace-data',
        NS,
      );
      mkdirSync(stagingNamespace, { recursive: true });
      writeFileSync(
        join(stagingNamespace, 'workspace-registry.json'),
        readFileSync(join(root, 'run', NS, 'workspace-registry.json')),
      );

      expect(() =>
        migrateDesktopAppDataLayout(root, silent, Date.now, {
          sessionStoreHome: home,
          env: {},
        }),
      ).toThrow(/staged copy .* already exists while the legacy source is still present/);
      expect(
        layoutVersionFromMarker(readDataLayoutMarker(join(root, 'desktop', 'data-layout.json'))),
      ).toBe('legacy-v1');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('computer-slot catch-up: the pre-revision dogfood marker moves computers/local to the id-keyed slot, re-renames sessions, relocates the binding, and stamps the fact', () => {
    const root = makeRoot();
    const home = makeHome();
    try {
      // The dev-machine dogfood state: physically v2 at the retired
      // computers/local alias, marker carrying sessions but NOT the
      // computer_slot fact.
      const aliasManaged = join(
        root, 'computers', 'local', 'workspace-data', NS, 'workspaces', managedWorkspaceSlug(WS_ID),
      );
      mkdirSync(aliasManaged, { recursive: true });
      writeFileSync(
        join(root, 'computers', 'local', 'workspace-data', NS, 'workspace-registry.json'),
        JSON.stringify({
          schema_version: 1,
          binding: BINDING,
          workspaces: { [WS_ID]: { path: aliasManaged, provisioned_at: 1 } },
        }),
      );
      mkdirSync(join(root, 'computers', 'local', 'agents', 'agent-1'), { recursive: true });
      mkdirSync(join(root, 'computers', 'local', 'config'), { recursive: true });
      writeFileSync(
        join(root, 'computers', 'local', 'config', 'daemon-config.json'),
        '{"host_id":"h1","server_url":"http://127.0.0.1:1234"}',
      );
      mkdirSync(join(root, 'desktop'), { recursive: true });
      writeFileSync(
        join(root, 'desktop', 'data-layout.json'),
        `${JSON.stringify({ version: 2, migrated_at: 111, from: 'legacy-v1', sessions: { migrated_at: 112 } })}\n`,
      );
      // Session buckets still keyed by the ALIAS cwds.
      seedSessionStores(home, aliasManaged);
      seedSessionStores(home, join(root, 'computers', 'local', 'agents', 'agent-1'));

      const r = migrateDesktopAppDataLayout(root, silent, () => 222, {
        sessionStoreHome: home,
        env: {},
      });
      expect(r.migrated).toBe(true);
      // Slot landed FLAT (#task:1608 convergence chains the workspace
      // flatten after the slot catch-up); alias children gone; binding
      // relocated.
      const slotManaged = join(
        root, 'computers', 'h1', 'workspace-data', 'workspaces', WS_ID,
      );
      expect(existsSync(slotManaged)).toBe(true);
      expect(existsSync(join(root, 'computers', 'local', 'workspace-data'))).toBe(false);
      expect(existsSync(join(root, 'computers', 'local', 'agents'))).toBe(false);
      expect(existsSync(join(root, 'desktop', 'computer-binding.json'))).toBe(true);
      const registry = JSON.parse(
        readFileSync(join(root, 'computers', 'h1', 'workspace-data', 'workspace-registry.json'), 'utf8'),
      ) as { workspaces: Record<string, { path: string }> };
      expect(registry.workspaces[WS_ID]!.path).toBe(slotManaged);
      // Session buckets re-renamed to the slot cwds.
      expect(
        existsSync(join(home, '.claude', 'projects', cwdSessionSlug('claude', slotManaged), 'session-1.jsonl')),
      ).toBe(true);
      expect(existsSync(join(home, '.qoder', 'projects', cwdSessionSlug('qoder', aliasManaged)))).toBe(false);
      expect(
        existsSync(
          join(home, '.claude', 'projects', cwdSessionSlug('claude', join(root, 'computers', 'h1', 'agents', 'agent-1'))),
        ),
      ).toBe(true);
      // Marker keeps its history and gains the computer_slot AND
      // workspace_layout facts.
      const marker = readDataLayoutMarker(join(root, 'desktop', 'data-layout.json'));
      expect(marker.state === 'v2' && marker.marker.migrated_at === 111).toBe(true);
      expect(marker.state === 'v2' && marker.marker.sessions?.migrated_at === 112).toBe(true);
      expect(marker.state === 'v2' && marker.marker.computer_slot?.migrated_at === 222).toBe(true);
      expect(marker.state === 'v2' && marker.marker.workspace_layout?.migrated_at === 222).toBe(true);

      // Second run: fully complete.
      const again = migrateDesktopAppDataLayout(root, silent, Date.now, {
        sessionStoreHome: home,
        env: {},
      });
      expect(again.migrated).toBe(false);
      expect(again.sessions).toBe('already');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
  it('coexisting old+new session namespaces are a typed conflict and the marker is NOT written', () => {
    const root = makeRoot();
    const home = makeHome();
    try {
      const { managed } = seedLegacyLocalComputer(root);
      seedSessionStores(home, managed);
      // #task:1608 convergence: the managed pair targets the FLAT raw-id
      // cwd — that is where a pre-existing destination bucket conflicts.
      const v2Managed = join(
        root, 'computers', 'h1', 'workspace-data', 'workspaces', WS_ID,
      );
      // Destination bucket already exists.
      mkdirSync(join(home, '.claude', 'projects', cwdSessionSlug('claude', v2Managed)), { recursive: true });

      expect(() =>
        migrateDesktopAppDataLayout(root, silent, Date.now, {
          sessionStoreHome: home,
          env: {},
        }),
      ).toThrow(/coexist/);
      // Fail closed: nothing moved, no marker.
      expect(existsSync(join(root, 'run', NS))).toBe(true);
      expect(
        existsSync(join(home, '.claude', 'projects', cwdSessionSlug('claude', managed), 'session-1.jsonl')),
      ).toBe(true);
      expect(
        layoutVersionFromMarker(readDataLayoutMarker(join(root, 'desktop', 'data-layout.json'))),
      ).toBe('legacy-v1');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('a non-absolute config-dir override FAILS CLOSED: nothing moves, no marker; a corrected env completes on the next start (P1-2)', () => {
    const root = makeRoot();
    const home = makeHome();
    try {
      const { managed } = seedLegacyLocalComputer(root);
      seedSessionStores(home, managed);
      expect(() =>
        migrateDesktopAppDataLayout(root, silent, Date.now, {
          sessionStoreHome: home,
          env: { CLAUDE_CONFIG_DIR: 'relative/dir' },
        }),
      ).toThrow(/CLAUDE_CONFIG_DIR/);
      // Fail closed: buckets and tree untouched, no marker.
      expect(existsSync(join(home, '.claude', 'projects', cwdSessionSlug('claude', managed)))).toBe(true);
      expect(existsSync(join(home, '.qoder', 'projects', cwdSessionSlug('qoder', managed)))).toBe(true);
      expect(existsSync(join(root, 'run', NS))).toBe(true);
      expect(
        layoutVersionFromMarker(readDataLayoutMarker(join(root, 'desktop', 'data-layout.json'))),
      ).toBe('legacy-v1');
      // Fixed environment → the idempotent run completes and stamps.
      const again = migrateDesktopAppDataLayout(root, silent, Date.now, {
        sessionStoreHome: home,
        env: {},
      });
      expect(again.sessions).toBe('migrated');
      const done = readDataLayoutMarker(join(root, 'desktop', 'data-layout.json'));
      expect(done.state === 'v2' && done.marker.sessions != null).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('a run-era dir WITHOUT a registry file is transient and ignored; a PRESENT registry with mismatched binding provenance fails closed (P1-3)', () => {
    const root = makeRoot();
    const home = makeHome();
    try {
      seedLegacyLocalComputer(root);
      // Transient-looking dir (no registry file): ignored.
      mkdirSync(join(root, 'run', 'some-transient-dir', 'workspaces'), { recursive: true });
      const r = migrateDesktopAppDataLayout(root, silent, Date.now, {
        sessionStoreHome: home,
        env: {},
      });
      expect(r.migrated).toBe(true);
      expect(existsSync(join(root, 'run', 'some-transient-dir'))).toBe(true);
      expect(existsSync(join(root, 'run', NS))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('a run-era registry with a mismatched binding slug BLOCKS migration (never warn-and-stamp over durable bytes)', () => {
    const root = makeRoot();
    const home = makeHome();
    try {
      seedLegacyLocalComputer(root);
      const foreign = join(root, 'run', 'not-the-binding-slug');
      mkdirSync(join(foreign, 'workspaces', 'x'), { recursive: true });
      writeFileSync(
        join(foreign, 'workspace-registry.json'),
        JSON.stringify({ schema_version: 1, binding: BINDING, workspaces: {} }),
      );
      expect(() =>
        migrateDesktopAppDataLayout(root, silent, Date.now, {
          sessionStoreHome: home,
          env: {},
        }),
      ).toThrow(/binding provenance/);
      // Fail closed: nothing moved, no marker.
      expect(existsSync(join(root, 'run', NS))).toBe(true);
      expect(
        layoutVersionFromMarker(readDataLayoutMarker(join(root, 'desktop', 'data-layout.json'))),
      ).toBe('legacy-v1');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('a crash-staged namespace with a mismatched binding registry BLOCKS activation (P1-3, staged proof)', () => {
    const root = makeRoot();
    const home = makeHome();
    try {
      seedLegacyLocalComputer(root);
      // Simulate a crash where the namespace already moved to staging, and
      // the staged registry's binding no longer proves the dir name.
      const staging = join(root, 'computers', '.local-layout-v2.staging');
      renameNs(root, staging);
      const stagedReg = join(staging, 'workspace-data', NS, 'workspace-registry.json');
      writeFileSync(
        stagedReg,
        JSON.stringify({
          schema_version: 1,
          binding: { server_origin: 'https://evil.example', host_id: 'x' },
          workspaces: {},
        }),
      );
      expect(() =>
        migrateDesktopAppDataLayout(root, silent, Date.now, {
          sessionStoreHome: home,
          env: {},
        }),
      ).toThrow(/binding provenance|does not match its coordinate/);
      expect(existsSync(join(root, 'computers', 'h1', 'workspace-data'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('migrates the REAL remote-app user shape: two run-era namespaces (claimed + local/local placeholder), pre-existing computers/<id> and desktop/ files preserved, no embedded-server conjured', () => {
    const root = makeRoot();
    const home = makeHome();
    try {
      // Replica of user1-silverhand-layout.txt (2026-07-24).
      const claimed = { server_origin: 'https://server.example', host_id: 'computer-user-1' };
      const placeholder = { server_origin: 'local-embedded', host_id: 'local' };
      // The placeholder slug is a cross-machine constant (verified against
      // two real user trees + the dev machine).
      expect(bindingSlug(placeholder)).toBe('ea834b187797f155');
      for (const [binding, wsEntry] of [
        [claimed, true],
        [placeholder, false],
      ] as const) {
        const ns = join(root, 'run', bindingSlug(binding));
        mkdirSync(join(ns, 'workspaces'), { recursive: true });
        const managed = join(ns, 'workspaces', managedWorkspaceSlug('ws-real'));
        if (wsEntry) mkdirSync(managed, { recursive: true });
        writeFileSync(
          join(ns, 'workspace-registry.json'),
          JSON.stringify({
            schema_version: 1,
            binding,
            workspaces: wsEntry
              ? {
                  'ws-real': { path: managed, provisioned_at: 1 },
                  w_ext: { path: '/Users/lk/project', provisioned_at: 1 },
                }
              : {},
          }),
        );
      }
      mkdirSync(join(root, 'agents', '8nIdlc9Jabs_PtAG', 'notes'), { recursive: true });
      writeFileSync(join(root, 'agents', '8nIdlc9Jabs_PtAG', 'MEMORY.md'), 'mem');
      writeFileSync(
        join(root, 'daemon-config.json'),
        '{"host_id":"computer-user-1","server_url":"https://server.example"}',
      );
      // Pre-existing top-level dirs the migration must coexist with.
      mkdirSync(join(root, 'computers', 'aZUOwIIIJrJ2p3zy'), { recursive: true });
      writeFileSync(join(root, 'computers', 'aZUOwIIIJrJ2p3zy', 'proxy-config.json'), '{"p":1}');
      mkdirSync(join(root, 'desktop'), { recursive: true });
      writeFileSync(join(root, 'desktop', 'server-profile.bin'), 'profile');
      writeFileSync(join(root, 'desktop', 'session.bin'), 'session');
      mkdirSync(join(root, 'daemon'), { recursive: true });
      writeFileSync(join(root, 'daemon', 'proxy-config.json.migrated'), '{}');
      writeFileSync(join(root, 'run', 'daemon.pid'), '999');
      writeFileSync(join(root, 'run', 'identity.json'), '{}');
      mkdirSync(join(root, 'run', 'runtime-pids', '1780485251669-21683'), { recursive: true });
      mkdirSync(join(root, 'attachments-cache', 'conv1'), { recursive: true });
      writeFileSync(join(root, 'attachments-cache', 'conv1', 'blob'), 'b');
      seedSessionStores(home, join(root, 'agents', '8nIdlc9Jabs_PtAG'));

      const r = migrateDesktopAppDataLayout(root, silent, Date.now, {
        sessionStoreHome: home,
        env: {},
      });
      expect(r.migrated).toBe(true);
      expect(r.facets).toEqual({ localComputer: 'migrated', embeddedServer: 'noop' });
      // Both namespaces landed at v2. The CLAIMED (current-binding) one is
      // flattened (#task:1608): registry directly on workspace-data/, raw-id
      // managed dir, external path byte-identical. The placeholder namespace
      // stays in its slug shape as an inert orphan — never merged or read.
      const claimedReg = JSON.parse(
        readFileSync(
          join(root, 'computers', 'computer-user-1', 'workspace-data', 'workspace-registry.json'),
          'utf8',
        ),
      ) as { workspaces: Record<string, { path: string }> };
      expect(claimedReg.workspaces['ws-real']!.path).toBe(
        join(root, 'computers', 'computer-user-1', 'workspace-data', 'workspaces', 'ws-real'),
      );
      expect(
        existsSync(join(root, 'computers', 'computer-user-1', 'workspace-data', 'workspaces', 'ws-real')),
      ).toBe(true);
      expect(claimedReg.workspaces['w_ext']!.path).toBe('/Users/lk/project');
      expect(
        existsSync(join(root, 'computers', 'computer-user-1', 'workspace-data', bindingSlug(claimed))),
      ).toBe(false);
      expect(
        existsSync(join(root, 'computers', 'computer-user-1', 'workspace-data', 'ea834b187797f155', 'workspace-registry.json')),
      ).toBe(true);
      // Agent home + its session bucket migrated.
      expect(readFileSync(join(root, 'computers', 'computer-user-1', 'agents', '8nIdlc9Jabs_PtAG', 'MEMORY.md'), 'utf8')).toBe('mem');
      expect(
        existsSync(
          join(home, '.claude', 'projects', cwdSessionSlug('claude', join(root, 'computers', 'computer-user-1', 'agents', '8nIdlc9Jabs_PtAG'))),
        ),
      ).toBe(true);
      // Pre-existing neighbors preserved byte-for-byte; transients untouched.
      expect(readFileSync(join(root, 'computers', 'aZUOwIIIJrJ2p3zy', 'proxy-config.json'), 'utf8')).toBe('{"p":1}');
      expect(readFileSync(join(root, 'desktop', 'server-profile.bin'), 'utf8')).toBe('profile');
      expect(readFileSync(join(root, 'desktop', 'session.bin'), 'utf8')).toBe('session');
      expect(existsSync(join(root, 'daemon', 'proxy-config.json.migrated'))).toBe(true);
      expect(existsSync(join(root, 'run', 'runtime-pids', '1780485251669-21683'))).toBe(true);
      expect(readFileSync(join(root, 'attachments-cache', 'conv1', 'blob'), 'utf8')).toBe('b');
      // Remote install: no embedded-server tree conjured; marker complete.
      expect(existsSync(join(root, 'embedded-server'))).toBe(false);
      const marker = readDataLayoutMarker(join(root, 'desktop', 'data-layout.json'));
      expect(marker.state === 'v2' && marker.marker.sessions != null).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('a released SAME-host connect proxy config inside the target slot does not block migration and survives byte-for-byte (P0-3)', () => {
    const root = makeRoot();
    const home = makeHome();
    try {
      // The real released state: `silverhand-daemon connect` (or the proxy
      // relocation) already wrote computers/<host_id>/proxy-config.json for
      // the SAME host id the legacy binding config proves. The target slot
      // pre-exists — the facet must merge into it, not conflict.
      const { managed } = seedLegacyLocalComputer(root);
      seedSessionStores(home, managed);
      mkdirSync(join(root, 'computers', 'h1'), { recursive: true });
      writeFileSync(join(root, 'computers', 'h1', 'proxy-config.json'), '{"proxy":"same-host"}');

      const r = migrateDesktopAppDataLayout(root, silent, Date.now, {
        sessionStoreHome: home,
        env: {},
      });
      expect(r.migrated).toBe(true);
      expect(r.facets.localComputer).toBe('migrated');
      // Pre-existing proxy bytes preserved; migrated children landed
      // beside them; staging fully consumed.
      expect(readFileSync(join(root, 'computers', 'h1', 'proxy-config.json'), 'utf8')).toBe(
        '{"proxy":"same-host"}',
      );
      expect(readFileSync(join(root, 'computers', 'h1', 'agents', 'agent-1', 'system_prompt.md'), 'utf8')).toBe('role');
      expect(
        existsSync(join(root, 'computers', 'h1', 'workspace-data', 'workspace-registry.json')),
      ).toBe(true);
      expect(
        existsSync(join(root, 'computers', 'h1', 'workspace-data', 'workspaces', WS_ID)),
      ).toBe(true);
      expect(existsSync(join(root, 'computers', '.local-layout-v2.staging'))).toBe(false);
      const marker = readDataLayoutMarker(join(root, 'desktop', 'data-layout.json'));
      expect(marker.state === 'v2' && marker.marker.computer_slot != null).toBe(true);
      expect(marker.state === 'v2' && marker.marker.workspace_layout != null).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('a pre-existing target slot with a NON-allowlisted child is still a typed conflict (P0-3 negative arm)', () => {
    const root = makeRoot();
    const home = makeHome();
    try {
      const { managed } = seedLegacyLocalComputer(root);
      seedSessionStores(home, managed);
      // Foreign agents/ content already in the slot: ownership is ambiguous
      // — never merge durable trees.
      mkdirSync(join(root, 'computers', 'h1', 'agents', 'foreign-agent'), { recursive: true });
      expect(() =>
        migrateDesktopAppDataLayout(root, silent, Date.now, {
          sessionStoreHome: home,
          env: {},
        }),
      ).toThrow(/coexists/);
      // Fail closed: legacy untouched, no marker.
      expect(existsSync(join(root, 'run', NS))).toBe(true);
      expect(existsSync(join(root, 'agents', 'agent-1'))).toBe(true);
      expect(
        layoutVersionFromMarker(readDataLayoutMarker(join(root, 'desktop', 'data-layout.json'))),
      ).toBe('legacy-v1');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('computer-slot catch-up resumes after a crash between children: agents already at the slot, workspace-data still at the alias (P1-1)', () => {
    const root = makeRoot();
    const home = makeHome();
    try {
      // Crash replica: a prior catch-up run moved agents/ to the slot and
      // died before workspace-data (marker never gained the fact). The
      // re-run must classify the moved child as done — not a conflict.
      const aliasManaged = join(
        root, 'computers', 'local', 'workspace-data', NS, 'workspaces', managedWorkspaceSlug(WS_ID),
      );
      mkdirSync(aliasManaged, { recursive: true });
      writeFileSync(join(aliasManaged, 'MEMORY.md'), 'memory');
      writeFileSync(
        join(root, 'computers', 'local', 'workspace-data', NS, 'workspace-registry.json'),
        JSON.stringify({
          schema_version: 1,
          binding: BINDING,
          workspaces: { [WS_ID]: { path: aliasManaged, provisioned_at: 1 } },
        }),
      );
      mkdirSync(join(root, 'computers', 'local', 'config'), { recursive: true });
      writeFileSync(
        join(root, 'computers', 'local', 'config', 'daemon-config.json'),
        '{"host_id":"h1","server_url":"http://127.0.0.1:1234"}',
      );
      // agents/ ALREADY at the slot (the prior run's completed child) —
      // including its already-renamed session bucket.
      mkdirSync(join(root, 'computers', 'h1', 'agents', 'agent-1'), { recursive: true });
      seedSessionStores(home, join(root, 'computers', 'h1', 'agents', 'agent-1'));
      seedSessionStores(home, aliasManaged);
      mkdirSync(join(root, 'desktop'), { recursive: true });
      writeFileSync(
        join(root, 'desktop', 'data-layout.json'),
        `${JSON.stringify({ version: 2, migrated_at: 111, from: 'legacy-v1', sessions: { migrated_at: 112 } })}\n`,
      );

      const r = migrateDesktopAppDataLayout(root, silent, () => 333, {
        sessionStoreHome: home,
        env: {},
      });
      expect(r.migrated).toBe(true);
      // The remaining child completed AND flattened; the finished one
      // stayed put.
      const slotManaged = join(
        root, 'computers', 'h1', 'workspace-data', 'workspaces', WS_ID,
      );
      expect(readFileSync(join(slotManaged, 'MEMORY.md'), 'utf8')).toBe('memory');
      expect(existsSync(join(root, 'computers', 'h1', 'agents', 'agent-1'))).toBe(true);
      expect(existsSync(join(root, 'computers', 'local', 'workspace-data'))).toBe(false);
      // Both session buckets end at slot coordinates (agents one untouched).
      expect(
        existsSync(join(home, '.claude', 'projects', cwdSessionSlug('claude', slotManaged), 'session-1.jsonl')),
      ).toBe(true);
      expect(
        existsSync(
          join(home, '.claude', 'projects', cwdSessionSlug('claude', join(root, 'computers', 'h1', 'agents', 'agent-1'))),
        ),
      ).toBe(true);
      // Marker completes with history preserved.
      const marker = readDataLayoutMarker(join(root, 'desktop', 'data-layout.json'));
      expect(marker.state === 'v2' && marker.marker.migrated_at === 111).toBe(true);
      expect(marker.state === 'v2' && marker.marker.computer_slot?.migrated_at === 333).toBe(true);
      expect(marker.state === 'v2' && marker.marker.workspace_layout?.migrated_at === 333).toBe(true);

      // Third run: fully complete, pure no-op.
      const again = migrateDesktopAppDataLayout(root, silent, Date.now, {
        sessionStoreHome: home,
        env: {},
      });
      expect(again.migrated).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('a mid-activation crash state (agents already in the final slot, staging holds the rest) converges with every byte intact (R2-1)', () => {
    const root = makeRoot();
    const home = makeHome();
    try {
      // Cindy round-2 acceptance state: final={proxy, agents},
      // staging={workspace-data}, legacy absent. The re-run must classify
      // 'agents' as an already-activated product (its legacy source is
      // gone), empty the final root back into staging, and activate with
      // the ONE whole-root rename — never a permanent conflict.
      mkdirSync(join(root, 'computers', 'h1', 'agents', 'agent-1'), { recursive: true });
      writeFileSync(join(root, 'computers', 'h1', 'agents', 'agent-1', 'system_prompt.md'), 'role');
      writeFileSync(join(root, 'computers', 'h1', 'proxy-config.json'), '{"proxy":"same-host"}');
      const staging = join(root, 'computers', '.local-layout-v2.staging');
      const stagedManaged = join(staging, 'workspace-data', NS, 'workspaces', managedWorkspaceSlug(WS_ID));
      mkdirSync(stagedManaged, { recursive: true });
      writeFileSync(join(stagedManaged, 'MEMORY.md'), 'memory');
      // The crashed run already rewrote the staged registry to the exact
      // v2 slot coordinate (rewrite precedes activation).
      const slotManaged = join(
        root, 'computers', 'h1', 'workspace-data', NS, 'workspaces', managedWorkspaceSlug(WS_ID),
      );
      writeFileSync(
        join(staging, 'workspace-data', NS, 'workspace-registry.json'),
        JSON.stringify({
          schema_version: 1,
          binding: BINDING,
          workspaces: { [WS_ID]: { path: slotManaged, provisioned_at: 1 } },
        }),
      );
      writeFileSync(join(root, 'daemon-config.json'), '{"host_id":"h1","server_url":"http://127.0.0.1:1234"}');
      // Sessions were renamed BEFORE the tree move in the crashed run.
      seedSessionStores(home, join(root, 'computers', 'h1', 'agents', 'agent-1'));

      const r = migrateDesktopAppDataLayout(root, silent, Date.now, {
        sessionStoreHome: home,
        env: {},
      });
      expect(r.migrated).toBe(true);
      // Everything converged into the slot, bytes intact, staging consumed.
      expect(readFileSync(join(root, 'computers', 'h1', 'proxy-config.json'), 'utf8')).toBe('{"proxy":"same-host"}');
      expect(readFileSync(join(root, 'computers', 'h1', 'agents', 'agent-1', 'system_prompt.md'), 'utf8')).toBe('role');
      expect(
        readFileSync(
          join(root, 'computers', 'h1', 'workspace-data', 'workspaces', WS_ID, 'MEMORY.md'),
          'utf8',
        ),
      ).toBe('memory');
      expect(existsSync(join(root, 'computers', '.local-layout-v2.staging'))).toBe(false);
      expect(
        layoutVersionFromMarker(readDataLayoutMarker(join(root, 'desktop', 'data-layout.json'))),
      ).toBe('v2');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('computer-slot catch-up refuses to stamp completion over a slot child that is not a directory (R2-2)', () => {
    const root = makeRoot();
    const home = makeHome();
    try {
      // Alias agents is absent, but where the slot agents dir should be
      // there is a FILE: "source absent" must not count as done.
      mkdirSync(join(root, 'computers', 'local', 'workspace-data', NS), { recursive: true });
      writeFileSync(
        join(root, 'computers', 'local', 'workspace-data', NS, 'workspace-registry.json'),
        JSON.stringify({ schema_version: 1, binding: BINDING, workspaces: {} }),
      );
      mkdirSync(join(root, 'computers', 'local', 'config'), { recursive: true });
      writeFileSync(
        join(root, 'computers', 'local', 'config', 'daemon-config.json'),
        '{"host_id":"h1","server_url":"http://127.0.0.1:1234"}',
      );
      mkdirSync(join(root, 'computers', 'h1'), { recursive: true });
      writeFileSync(join(root, 'computers', 'h1', 'agents'), 'not-a-directory');
      mkdirSync(join(root, 'desktop'), { recursive: true });
      writeFileSync(
        join(root, 'desktop', 'data-layout.json'),
        `${JSON.stringify({ version: 2, migrated_at: 111, from: 'legacy-v1', sessions: { migrated_at: 112 } })}\n`,
      );

      expect(() =>
        migrateDesktopAppDataLayout(root, silent, Date.now, {
          sessionStoreHome: home,
          env: {},
        }),
      ).toThrow(/not a directory/);
      // Fail closed: the marker never gains the computer_slot fact.
      const marker = readDataLayoutMarker(join(root, 'desktop', 'data-layout.json'));
      expect(marker.state === 'v2' && marker.marker.computer_slot == null).toBe(true);
      expect(readFileSync(join(root, 'computers', 'h1', 'agents'), 'utf8')).toBe('not-a-directory');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('workspace-layout catch-up: a computer_slot-stamped machine flattens ONLY the current binding namespace; the placeholder orphan stays (#task:1608 convergence)', () => {
    const root = makeRoot();
    const home = makeHome();
    try {
      // Tonight's dogfood state: slot landed, marker has computer_slot but
      // not workspace_layout; two namespaces live in the slot.
      const slotWsData = join(root, 'computers', 'h1', 'workspace-data');
      const currentManaged = join(slotWsData, NS, 'workspaces', managedWorkspaceSlug(WS_ID));
      mkdirSync(currentManaged, { recursive: true });
      writeFileSync(join(currentManaged, 'MEMORY.md'), 'memory');
      writeFileSync(
        join(slotWsData, NS, 'workspace-registry.json'),
        JSON.stringify({
          schema_version: 1,
          binding: BINDING,
          workspaces: {
            [WS_ID]: { path: currentManaged, provisioned_at: 1 },
            w_external: { path: '/Users/u/real-project', provisioned_at: 1 },
          },
        }),
      );
      const placeholder = { server_origin: 'local-embedded', host_id: 'local' };
      const orphanNs = bindingSlug(placeholder);
      const orphanManaged = join(slotWsData, orphanNs, 'workspaces', managedWorkspaceSlug('ws-old'));
      mkdirSync(orphanManaged, { recursive: true });
      writeFileSync(join(orphanManaged, 'old.txt'), 'orphan-bytes');
      writeFileSync(
        join(slotWsData, orphanNs, 'workspace-registry.json'),
        JSON.stringify({
          schema_version: 1,
          binding: placeholder,
          workspaces: { 'ws-old': { path: orphanManaged, provisioned_at: 1 } },
        }),
      );
      mkdirSync(join(root, 'desktop'), { recursive: true });
      writeFileSync(
        join(root, 'desktop', 'computer-binding.json'),
        '{"host_id":"h1","server_url":"http://127.0.0.1:1234"}',
      );
      writeFileSync(
        join(root, 'desktop', 'data-layout.json'),
        `${JSON.stringify({ version: 2, migrated_at: 111, from: 'legacy-v1', sessions: { migrated_at: 112 }, computer_slot: { migrated_at: 113 } })}\n`,
      );
      // Session bucket keyed by the slot-era slug cwd.
      seedSessionStores(home, currentManaged);

      const r = migrateDesktopAppDataLayout(root, silent, () => 444, {
        sessionStoreHome: home,
        env: {},
      });
      expect(r.migrated).toBe(true);
      // Current namespace flattened; external path untouched.
      const flatManaged = join(slotWsData, 'workspaces', WS_ID);
      expect(readFileSync(join(flatManaged, 'MEMORY.md'), 'utf8')).toBe('memory');
      const registry = JSON.parse(
        readFileSync(join(slotWsData, 'workspace-registry.json'), 'utf8'),
      ) as { workspaces: Record<string, { path: string }> };
      expect(registry.workspaces[WS_ID]!.path).toBe(flatManaged);
      expect(registry.workspaces['w_external']!.path).toBe('/Users/u/real-project');
      expect(existsSync(join(slotWsData, NS))).toBe(false);
      // Placeholder orphan untouched byte-for-byte, still slug-shaped.
      expect(readFileSync(join(orphanManaged, 'old.txt'), 'utf8')).toBe('orphan-bytes');
      expect(existsSync(join(slotWsData, orphanNs, 'workspace-registry.json'))).toBe(true);
      // Session bucket re-renamed to the flat cwd.
      expect(
        existsSync(join(home, '.claude', 'projects', cwdSessionSlug('claude', flatManaged), 'session-1.jsonl')),
      ).toBe(true);
      expect(existsSync(join(home, '.claude', 'projects', cwdSessionSlug('claude', currentManaged)))).toBe(false);
      // Marker history preserved; workspace_layout stamped.
      const marker = readDataLayoutMarker(join(root, 'desktop', 'data-layout.json'));
      expect(marker.state === 'v2' && marker.marker.computer_slot?.migrated_at === 113).toBe(true);
      expect(marker.state === 'v2' && marker.marker.workspace_layout?.migrated_at === 444).toBe(true);

      // Re-run: pure no-op.
      const again = migrateDesktopAppDataLayout(root, silent, Date.now, {
        sessionStoreHome: home,
        env: {},
      });
      expect(again.migrated).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('repairs released underscore-preserving session namespaces after the full v2 marker was stamped (#task:1663)', () => {
    const root = makeRoot();
    const home = makeHome();
    try {
      const hostId = 'host_id';
      const workspaceId = 'workspace_id';
      const agentId = 'agent_id';
      const workspaceCwd = join(
        root,
        'computers',
        hostId,
        'workspace-data',
        'workspaces',
        workspaceId,
      );
      const agentCwd = join(root, 'computers', hostId, 'agents', agentId);
      mkdirSync(workspaceCwd, { recursive: true });
      mkdirSync(agentCwd, { recursive: true });
      mkdirSync(join(root, 'desktop'), { recursive: true });
      writeFileSync(
        join(root, 'desktop', 'computer-binding.json'),
        JSON.stringify({ host_id: hostId, server_url: 'http://127.0.0.1:1234' }),
      );
      writeDataLayoutMarker(join(root, 'desktop', 'data-layout.json'), 1, 2, 3, 4);
      seedReleasedV2SessionStores(home, workspaceCwd);
      seedReleasedV2SessionStores(home, agentCwd);

      const result = migrateDesktopAppDataLayout(root, silent, Date.now, {
        sessionStoreHome: home,
        env: {},
      });
      expect(result).toEqual({
        migrated: true,
        facets: { localComputer: 'already', embeddedServer: 'already' },
        sessions: 'migrated',
      });
      for (const cwd of [workspaceCwd, agentCwd]) {
        const releasedSlug = cwd.replace(/[/.]/g, '-');
        for (const store of ['.claude', '.qoder']) {
          expect(
            readFileSync(
              join(home, store, 'projects', cwdSessionSlug(sessionKind(store), cwd), 'session-1.jsonl'),
              'utf8',
            ),
          ).toBe(`{"store":"${store}"}`);
          expect(existsSync(join(home, store, 'projects', releasedSlug))).toBe(false);
        }
      }

      expect(
        migrateDesktopAppDataLayout(root, silent, Date.now, {
          sessionStoreHome: home,
          env: {},
        }),
      ).toEqual({
        migrated: false,
        facets: { localComputer: 'already', embeddedServer: 'already' },
        sessions: 'already',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('a completed v2 install stays bootable when repair inputs are unavailable (#task:1663)', () => {
    const root = makeRoot();
    const home = makeHome();
    const warnings: Record<string, unknown>[] = [];
    try {
      mkdirSync(join(root, 'desktop'), { recursive: true });
      writeFileSync(join(root, 'desktop', 'computer-binding.json'), '{not-json');
      writeDataLayoutMarker(join(root, 'desktop', 'data-layout.json'), 1, 2, 3, 4);

      expect(
        migrateDesktopAppDataLayout(
          root,
          {
            info: () => {},
            warn: fields => warnings.push(fields),
          },
          Date.now,
          { sessionStoreHome: home, env: {} },
        ),
      ).toEqual({
        migrated: false,
        facets: { localComputer: 'already', embeddedServer: 'already' },
        sessions: 'already',
      });
      expect(warnings).toEqual([
        {
          action: 'runtime_session_namespace_slug_repair_inputs_unavailable',
          reason: 'layout_registry_rewrite_blocked',
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('a completed v2 install stays bootable when a repair source cannot be listed (#task:1663)', () => {
    const root = makeRoot();
    const home = makeHome();
    const agentsRoot = join(root, 'computers', 'h1', 'agents');
    const warnings: Record<string, unknown>[] = [];
    try {
      mkdirSync(agentsRoot, { recursive: true });
      chmodSync(agentsRoot, 0o111);
      mkdirSync(join(root, 'desktop'), { recursive: true });
      writeFileSync(
        join(root, 'desktop', 'computer-binding.json'),
        '{"host_id":"h1","server_url":"http://127.0.0.1:1234"}',
      );
      writeDataLayoutMarker(join(root, 'desktop', 'data-layout.json'), 1, 2, 3, 4);

      expect(
        migrateDesktopAppDataLayout(
          root,
          {
            info: () => {},
            warn: fields => warnings.push(fields),
          },
          Date.now,
          { sessionStoreHome: home, env: {} },
        ),
      ).toEqual({
        migrated: false,
        facets: { localComputer: 'already', embeddedServer: 'already' },
        sessions: 'already',
      });
      expect(warnings).toEqual([
        {
          action: 'runtime_session_namespace_slug_repair_inputs_unavailable',
          reason: 'layout_unreadable',
        },
      ]);
    } finally {
      chmodSync(agentsRoot, 0o700);
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('flatten crash-resume: flat registry written but dirs unmoved and source registry still present → converges (#task:1608 convergence)', () => {
    const root = makeRoot();
    const home = makeHome();
    try {
      const slotWsData = join(root, 'computers', 'h1', 'workspace-data');
      const slugManaged = join(slotWsData, NS, 'workspaces', managedWorkspaceSlug(WS_ID));
      mkdirSync(slugManaged, { recursive: true });
      writeFileSync(join(slugManaged, 'MEMORY.md'), 'memory');
      writeFileSync(
        join(slotWsData, NS, 'workspace-registry.json'),
        JSON.stringify({
          schema_version: 1,
          binding: BINDING,
          workspaces: { [WS_ID]: { path: slugManaged, provisioned_at: 1 } },
        }),
      );
      // The crashed run already wrote the FLAT registry (rewrite precedes
      // the dir renames) and died before any rename.
      const flatManaged = join(slotWsData, 'workspaces', WS_ID);
      writeFileSync(
        join(slotWsData, 'workspace-registry.json'),
        JSON.stringify({
          schema_version: 1,
          binding: BINDING,
          workspaces: { [WS_ID]: { path: flatManaged, provisioned_at: 1 } },
        }),
      );
      mkdirSync(join(root, 'desktop'), { recursive: true });
      writeFileSync(join(root, 'desktop', 'computer-binding.json'), '{"host_id":"h1","server_url":"http://127.0.0.1:1234"}');
      writeFileSync(
        join(root, 'desktop', 'data-layout.json'),
        `${JSON.stringify({ version: 2, migrated_at: 111, from: 'legacy-v1', sessions: { migrated_at: 112 }, computer_slot: { migrated_at: 113 } })}\n`,
      );

      const r = migrateDesktopAppDataLayout(root, silent, Date.now, {
        sessionStoreHome: home,
        env: {},
      });
      expect(r.migrated).toBe(true);
      expect(readFileSync(join(flatManaged, 'MEMORY.md'), 'utf8')).toBe('memory');
      expect(existsSync(join(slotWsData, NS))).toBe(false);
      const marker = readDataLayoutMarker(join(root, 'desktop', 'data-layout.json'));
      expect(marker.state === 'v2' && marker.marker.workspace_layout != null).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('a binding config with a missing or unparseable server_url blocks the migration fail-closed (Cindy R4 addendum)', () => {
    for (const badConfig of ['{"host_id":"h1"}', '{"host_id":"h1","server_url":"not a url"}']) {
      const root = makeRoot();
      const home = makeHome();
      try {
        const { managed } = seedLegacyLocalComputer(root);
        writeFileSync(join(root, 'daemon-config.json'), badConfig);
        seedSessionStores(home, managed);
        expect(() =>
          migrateDesktopAppDataLayout(root, silent, Date.now, {
            sessionStoreHome: home,
            env: {},
          }),
        ).toThrow(/server_url/);
        // Fail closed — never degrade to the embedded-only candidate.
        expect(existsSync(join(root, 'run', NS))).toBe(true);
        expect(
          layoutVersionFromMarker(readDataLayoutMarker(join(root, 'desktop', 'data-layout.json'))),
        ).toBe('legacy-v1');
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
      }
    }
  });

  it('an unsafe managed workspace id blocks the migration fail-closed; no marker, bytes intact (#task:1608 convergence)', () => {
    const root = makeRoot();
    const home = makeHome();
    try {
      const { managed } = seedLegacyLocalComputer(root);
      // Overwrite the run-era registry with a managed entry whose id is not
      // a safe path segment (its path IS its own managed coordinate, so the
      // flatten would have to mint a raw-id dir from it).
      const badId = 'evil/../id';
      const badManaged = join(root, 'run', NS, 'workspaces', managedWorkspaceSlug(badId));
      mkdirSync(badManaged, { recursive: true });
      writeFileSync(
        join(root, 'run', NS, 'workspace-registry.json'),
        JSON.stringify({
          schema_version: 1,
          binding: BINDING,
          workspaces: {
            [WS_ID]: { path: managed, provisioned_at: 1 },
            [badId]: { path: badManaged, provisioned_at: 1 },
          },
        }),
      );
      expect(() =>
        migrateDesktopAppDataLayout(root, silent, Date.now, {
          sessionStoreHome: home,
          env: {},
        }),
      ).toThrow(/safe path segment/);
      expect(
        layoutVersionFromMarker(readDataLayoutMarker(join(root, 'desktop', 'data-layout.json'))),
      ).toBe('legacy-v1');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('an empty remote installation creates NO embedded-server directory (§6.4 case 6)', () => {
    const root = makeRoot();
    try {
      const r = migrateDesktopAppDataLayout(root, silent, Date.now, {
        sessionStoreHome: makeHome(),
        env: {},
      });
      expect(r.migrated).toBe(true);
      expect(r.facets.embeddedServer).toBe('noop');
      expect(r.sessions).toBe('noop');
      expect(existsSync(join(root, 'embedded-server'))).toBe(false);
      // Marker still lands: layout version is installation-wide.
      expect(
        layoutVersionFromMarker(readDataLayoutMarker(join(root, 'desktop', 'data-layout.json'))),
      ).toBe('v2');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not touch workspaces/, daemon/, transient run/ files, logs, or attachments-cache', () => {
    const root = makeRoot();
    try {
      seedLegacyEmbedded(root);
      for (const keep of ['workspaces/proj', 'daemon/x', 'run/runtime-pids', 'logs', 'attachments-cache']) {
        mkdirSync(join(root, keep), { recursive: true });
        writeFileSync(join(root, keep, 'keep.txt'), 'k');
      }
      migrateDesktopAppDataLayout(root, silent, Date.now, {
        sessionStoreHome: makeHome(),
        env: {},
      });
      for (const keep of ['workspaces/proj', 'daemon/x', 'run/runtime-pids', 'logs', 'attachments-cache']) {
        expect(readFileSync(join(root, keep, 'keep.txt'), 'utf8')).toBe('k');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('crash resume: a staging root left by a crash completes deterministically to the same final tree', () => {
    const root = makeRoot();
    try {
      seedLegacyEmbedded(root);
      // Simulate a crash: one entry already staged, the rest still legacy.
      const staging = join(root, '.embedded-server-layout-v2.staging');
      mkdirSync(staging, { recursive: true });
      writeFileSync(join(staging, 'silverhand.db'), 'db-bytes');
      rmSync(join(root, 'silverhand.db'));

      const r = migrateDesktopAppDataLayout(root, silent, Date.now, {
        sessionStoreHome: makeHome(),
        env: {},
      });
      expect(r.migrated).toBe(true);
      expect(readFileSync(join(root, 'embedded-server', 'silverhand.db'), 'utf8')).toBe('db-bytes');
      expect(readFileSync(join(root, 'embedded-server', 'silverhand.db-wal'), 'utf8')).toBe('wal');
      expect(existsSync(staging)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('crash resume enumerates a namespace that already moved to STAGING (same classification, same pairs)', () => {
    const root = makeRoot();
    const home = makeHome();
    try {
      const { managed } = seedLegacyLocalComputer(root);
      seedSessionStores(home, managed);
      // Simulate a crash mid-facet: the namespace dir is already staged.
      const staging = join(root, 'computers', '.local-layout-v2.staging');
      mkdirSync(join(staging, 'workspace-data'), { recursive: true });
      renameNs(root, staging);

      const r = migrateDesktopAppDataLayout(root, silent, Date.now, {
        sessionStoreHome: home,
        env: {},
      });
      expect(r.migrated).toBe(true);
      const v2Managed = join(
        root, 'computers', 'h1', 'workspace-data', 'workspaces', WS_ID,
      );
      // Session pair derived from the STAGED source still uses the
      // resolver-computed old cwd and targets the final flat coordinate.
      expect(
        existsSync(join(home, '.claude', 'projects', cwdSessionSlug('claude', v2Managed), 'session-1.jsonl')),
      ).toBe(true);
      expect(existsSync(join(home, '.claude', 'projects', cwdSessionSlug('claude', managed)))).toBe(false);
      expect(
        existsSync(
          join(
            home,
            '.claude',
            'projects',
            cwdSessionSlug('claude', 
              join(
                root,
                'computers',
                'h1',
                'workspace-data',
                NS,
                'workspaces',
                managedWorkspaceSlug(WS_ID),
              ),
            ),
          ),
        ),
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('pre-marker final/legacy coexistence is a typed conflict with every byte preserved (§6.4 case 4)', () => {
    const root = makeRoot();
    try {
      seedLegacyEmbedded(root);
      mkdirSync(join(root, 'embedded-server'), { recursive: true });
      writeFileSync(join(root, 'embedded-server', 'silverhand.db'), 'other');
      expect(() => migrateDesktopAppDataLayout(root, silent)).toThrow(LayoutMigrationError);
      expect(readFileSync(join(root, 'silverhand.db'), 'utf8')).toBe('db-bytes');
      expect(readFileSync(join(root, 'embedded-server', 'silverhand.db'), 'utf8')).toBe('other');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a symlinked legacy source fails closed without traversal (§6.4)', () => {
    const root = makeRoot();
    try {
      const target = join(root, 'elsewhere');
      mkdirSync(target, { recursive: true });
      symlinkSync(target, join(root, 'blobs'));
      writeFileSync(join(root, 'silverhand.db'), 'db');
      expect(() => migrateDesktopAppDataLayout(root, silent)).toThrow(LayoutMigrationError);
      expect(existsSync(target)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a forged registry path inside the legacy run root without exact provenance blocks migration (§6.1)', () => {
    const root = makeRoot();
    try {
      seedLegacyLocalComputer(root);
      const forged = join(root, 'run', NS, 'workspaces', 'not-a-real-slug');
      const registryPath = join(root, 'run', NS, 'workspace-registry.json');
      const parsed = JSON.parse(readFileSync(registryPath, 'utf8')) as {
        workspaces: Record<string, { path: string; provisioned_at: number }>;
      };
      parsed.workspaces['w_forged'] = { path: forged, provisioned_at: 1 };
      writeFileSync(
        registryPath,
        JSON.stringify({ schema_version: 1, binding: BINDING, workspaces: parsed.workspaces }),
      );

      expect(() =>
        migrateDesktopAppDataLayout(root, silent, Date.now, {
          sessionStoreHome: makeHome(),
          env: {},
        }),
      ).toThrow(/exact managed provenance/);
      // Fail-closed: no marker, so the selector stays legacy.
      expect(
        layoutVersionFromMarker(readDataLayoutMarker(join(root, 'desktop', 'data-layout.json'))),
      ).toBe('legacy-v1');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('registry rewrite normalizes paths before deciding whether they are inside managed storage', () => {
    const root = makeRoot();
    try {
      const stagedWorkspaceData = join(root, 'staging');
      const namespaceDir = join(stagedWorkspaceData, NS);
      mkdirSync(namespaceDir, { recursive: true });
      const disguisedManagedPath =
        `${root}/run-sibling/../run/${NS}/workspaces/not-a-real-slug`;
      writeFileSync(
        join(namespaceDir, 'workspace-registry.json'),
        JSON.stringify({
          schema_version: 1,
          binding: BINDING,
          workspaces: {
            w_forged: { path: disguisedManagedPath, provisioned_at: 1 },
          },
        }),
      );

      expect(() =>
        rewriteStagedRegistries(
          stagedWorkspaceData,
          join(root, 'run'),
          join(root, 'computers', 'h1', 'workspace-data'),
          BINDING,
          silent,
        ),
      ).toThrow(/without exact managed provenance/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('post-marker legacy leftovers are inert: reported, never re-adopted or deleted (§6.4 case 5)', () => {
    const root = makeRoot();
    try {
      seedLegacyEmbedded(root);
      migrateDesktopAppDataLayout(root, silent, Date.now, {
        sessionStoreHome: makeHome(),
        env: {},
      });
      // A leftover appears later (e.g. an old binary wrote it).
      writeFileSync(join(root, 'silverhand.db'), 'stale');
      const warns: string[] = [];
      const r = migrateDesktopAppDataLayout(root, {
        info: () => {},
        warn: (_f, m) => warns.push(m),
      });
      expect(r.migrated).toBe(false);
      expect(readFileSync(join(root, 'silverhand.db'), 'utf8')).toBe('stale');
      expect(warns.join('\n')).toContain('inert');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('pre-marker final+staging coexistence is a typed conflict — staging bytes never silently become inert (P0-1)', () => {
    const root = makeRoot();
    try {
      mkdirSync(join(root, 'embedded-server'), { recursive: true });
      writeFileSync(join(root, 'embedded-server', 'silverhand.db'), 'final');
      const staging = join(root, '.embedded-server-layout-v2.staging');
      mkdirSync(staging, { recursive: true });
      writeFileSync(join(staging, 'silverhand.db'), 'staged');
      expect(() => migrateDesktopAppDataLayout(root, silent)).toThrow(LayoutMigrationError);
      // Both sides intact.
      expect(readFileSync(join(root, 'embedded-server', 'silverhand.db'), 'utf8')).toBe('final');
      expect(readFileSync(join(staging, 'silverhand.db'), 'utf8')).toBe('staged');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('crash-resume validates PRESENT staged entries: a symlinked staged item blocks activation (P0-2)', () => {
    const root = makeRoot();
    try {
      seedLegacyEmbedded(root);
      const staging = join(root, '.embedded-server-layout-v2.staging');
      mkdirSync(staging, { recursive: true });
      const target = join(root, 'elsewhere');
      mkdirSync(target);
      // The blobs source appears already staged — but as a symlink.
      symlinkSync(target, join(staging, 'blobs'));
      rmSync(join(root, 'blobs'), { recursive: true, force: true });
      expect(() =>
        migrateDesktopAppDataLayout(root, silent, Date.now, {
          sessionStoreHome: makeHome(),
          env: {},
        }),
      ).toThrow(/staged entry/);
      expect(existsSync(join(root, 'embedded-server'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a staged registry file that is not a regular file blocks the rewrite instead of being skipped (P1)', () => {
    const root = makeRoot();
    try {
      seedLegacyLocalComputer(root);
      // Simulate a crash where the namespace is already staged and its
      // registry file got replaced by a directory.
      const staging = join(root, 'computers', '.local-layout-v2.staging');
      mkdirSync(join(staging, 'workspace-data'), { recursive: true });
      renameNs(root, staging);
      const stagedReg = join(staging, 'workspace-data', NS, 'workspace-registry.json');
      rmSync(stagedReg);
      mkdirSync(stagedReg);
      expect(() =>
        migrateDesktopAppDataLayout(root, silent, Date.now, {
          sessionStoreHome: makeHome(),
          env: {},
        }),
      ).toThrow(LayoutMigrationError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a corrupt marker BLOCKS startup instead of guessing the layout', () => {
    const root = makeRoot();
    try {
      mkdirSync(join(root, 'desktop'), { recursive: true });
      writeFileSync(join(root, 'desktop', 'data-layout.json'), 'not json');
      expect(() => migrateDesktopAppDataLayout(root, silent)).toThrow(/marker/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('writeDataLayoutMarker always records the sessions fact; the optional reader exists only for the dogfood marker', () => {
    const root = makeRoot();
    try {
      const path = join(root, 'desktop', 'data-layout.json');
      writeDataLayoutMarker(path, 1, 2, 3, 4);
      const marker = readDataLayoutMarker(path);
      expect(marker.state === 'v2' && marker.marker.sessions?.migrated_at === 2).toBe(true);
      expect(marker.state === 'v2' && marker.marker.computer_slot?.migrated_at === 3).toBe(true);
      expect(marker.state === 'v2' && marker.marker.workspace_layout?.migrated_at === 4).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/** Move the seeded run-era namespace into the staging workspace-data tree
 *  (simulating a crash between the entry move and activation). */
function renameNs(root: string, staging: string): void {
  mkdirSync(join(staging, 'workspace-data'), { recursive: true });
  renameSync(join(root, 'run', NS), join(staging, 'workspace-data', NS));
}
