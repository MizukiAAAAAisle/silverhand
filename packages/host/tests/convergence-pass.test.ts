import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FlattenLayoutError,
  bindingSlug,
  cwdSessionSlug,
  managedWorkspaceSlug,
  runWorkspaceDataConvergencePass,
} from '../src/index.js';

/**
 * #task:1608 workspace-data convergence — the ONE in-place pass both the
 * desktop marker catch-up and the connect startup entry compose over.
 * Pins: registry lift to the flat coordinate, raw-id dir renames, session
 * bucket renames (old = slot-era slug cwd), orphan namespaces untouched,
 * idempotence, and fail-closed conflict arms.
 */

const silent = { info: () => {}, warn: () => {} };
const BINDING = { server_origin: 'https://srv.example', host_id: 'host-real' };
const OTHER_BINDING = { server_origin: 'local-embedded', host_id: 'host-real' };
const PLACEHOLDER = { server_origin: 'local-embedded', host_id: 'local' };
const WS = 'r6Cb5cuDnS2hAP9l';

function seedSlugNamespace(root: string, binding: typeof BINDING, wsId: string): {
  nsDir: string;
  managed: string;
} {
  const nsDir = join(root, bindingSlug(binding));
  const managed = join(nsDir, 'workspaces', managedWorkspaceSlug(wsId));
  mkdirSync(managed, { recursive: true });
  writeFileSync(join(managed, 'MEMORY.md'), 'memory');
  writeFileSync(
    join(nsDir, 'workspace-registry.json'),
    JSON.stringify({
      schema_version: 1,
      binding,
      workspaces: {
        [wsId]: { path: managed, provisioned_at: 1 },
        w_ext: { path: '/Users/u/project', provisioned_at: 1 },
      },
    }),
  );
  return { nsDir, managed };
}

describe('runWorkspaceDataConvergencePass', () => {
  it('lifts the current binding registry, renames managed dirs to raw ids, renames session buckets, and leaves orphans untouched', () => {
    const root = mkdtempSync(join(tmpdir(), 'sh-conv-'));
    const home = mkdtempSync(join(tmpdir(), 'sh-conv-home-'));
    try {
      const { managed } = seedSlugNamespace(root, BINDING, WS);
      const orphan = seedSlugNamespace(root, PLACEHOLDER, WS);
      const bucket = join(home, '.claude', 'projects', cwdSessionSlug(managed));
      mkdirSync(bucket, { recursive: true });
      writeFileSync(join(bucket, 'session-1.jsonl'), '{"s":1}');

      const r = runWorkspaceDataConvergencePass({
        workspaceDataRoot: root,
        currentBinding: BINDING,
        sessionStoreHome: home,
        env: {},
        logger: silent,
      });
      expect(r.status).toBe('flattened');
      expect(r.renamed).toBe(1);
      const flatManaged = join(root, 'workspaces', WS);
      expect(readFileSync(join(flatManaged, 'MEMORY.md'), 'utf8')).toBe('memory');
      const registry = JSON.parse(
        readFileSync(join(root, 'workspace-registry.json'), 'utf8'),
      ) as { workspaces: Record<string, { path: string }> };
      expect(registry.workspaces[WS]!.path).toBe(flatManaged);
      expect(registry.workspaces['w_ext']!.path).toBe('/Users/u/project');
      expect(existsSync(join(root, bindingSlug(BINDING)))).toBe(false);
      // Orphan namespace: byte-for-byte untouched, still slug-shaped.
      expect(readFileSync(join(orphan.managed, 'MEMORY.md'), 'utf8')).toBe('memory');
      // Session bucket followed the cwd.
      expect(
        existsSync(join(home, '.claude', 'projects', cwdSessionSlug(flatManaged), 'session-1.jsonl')),
      ).toBe(true);
      expect(existsSync(bucket)).toBe(false);

      // Idempotent re-run: nothing left to do.
      const again = runWorkspaceDataConvergencePass({
        workspaceDataRoot: root,
        currentBinding: BINDING,
        sessionStoreHome: home,
        env: {},
        logger: silent,
      });
      expect(again.status).toBe('already_flat');
      expect(again.renamed).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('a workspace present at BOTH the slug and the flat coordinate fails closed', () => {
    const root = mkdtempSync(join(tmpdir(), 'sh-conv-'));
    const home = mkdtempSync(join(tmpdir(), 'sh-conv-home-'));
    try {
      seedSlugNamespace(root, BINDING, WS);
      mkdirSync(join(root, 'workspaces', WS), { recursive: true });
      expect(() =>
        runWorkspaceDataConvergencePass({
          workspaceDataRoot: root,
          currentBinding: BINDING,
          sessionStoreHome: home,
          env: {},
          logger: silent,
        }),
      ).toThrowError(FlattenLayoutError);
      // Fail closed: source bytes intact, source registry not retired.
      expect(
        existsSync(join(root, bindingSlug(BINDING), 'workspace-registry.json')),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('P0-1a: a malformed NON-candidate orphan registry neither blocks nor joins — current converges, orphan bytes untouched', () => {
    const root = mkdtempSync(join(tmpdir(), 'sh-conv-'));
    const home = mkdtempSync(join(tmpdir(), 'sh-conv-home-'));
    try {
      seedSlugNamespace(root, BINDING, WS);
      // A broken registry in a directory that is NOT a candidate coordinate.
      mkdirSync(join(root, 'deadbeefdeadbeef'), { recursive: true });
      writeFileSync(join(root, 'deadbeefdeadbeef', 'workspace-registry.json'), '{ not json');

      const r = runWorkspaceDataConvergencePass({
        workspaceDataRoot: root,
        currentBinding: BINDING,
        sessionStoreHome: home,
        env: {},
        logger: silent,
      });
      expect(r.status).toBe('flattened');
      expect(
        readFileSync(join(root, 'deadbeefdeadbeef', 'workspace-registry.json'), 'utf8'),
      ).toBe('{ not json');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('P0-1b: a same-host/DIFFERENT-origin namespace is never adopted — zero flat output', () => {
    const root = mkdtempSync(join(tmpdir(), 'sh-conv-'));
    try {
      seedSlugNamespace(root, { server_origin: 'https://other.example', host_id: 'host-real' }, WS);
      const r = runWorkspaceDataConvergencePass({
        workspaceDataRoot: root,
        currentBinding: BINDING,
        sessionStoreHome: root,
        env: {},
        logger: silent,
      });
      expect(r.status).toBe('no_namespace');
      expect(existsSync(join(root, 'workspace-registry.json'))).toBe(false);
      expect(existsSync(join(root, 'workspaces'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('P0-1c: a forged header under the candidate coordinate is a typed conflict, never lifted', () => {
    const root = mkdtempSync(join(tmpdir(), 'sh-conv-'));
    try {
      const nsDir = join(root, bindingSlug(BINDING));
      mkdirSync(nsDir, { recursive: true });
      writeFileSync(
        join(nsDir, 'workspace-registry.json'),
        JSON.stringify({
          schema_version: 1,
          binding: { server_origin: 'https://evil.example', host_id: 'host-real' },
          workspaces: {},
        }),
      );
      expect(() =>
        runWorkspaceDataConvergencePass({
          workspaceDataRoot: root,
          currentBinding: BINDING,
          sessionStoreHome: root,
          env: {},
          logger: silent,
        }),
      ).toThrowError(expect.objectContaining({ code: 'flatten_conflict' }));
      expect(existsSync(join(root, 'workspace-registry.json'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // P0-2 — ONE strict plan precedes every side effect: each failure class
  // must produce ZERO session renames, an intact source registry, and no
  // flat registry.
  function seedBucket(home: string, cwd: string): string {
    const bucket = join(home, '.claude', 'projects', cwdSessionSlug(cwd));
    mkdirSync(bucket, { recursive: true });
    writeFileSync(join(bucket, 'session-1.jsonl'), '{"s":1}');
    return bucket;
  }

  function expectPlanFailure(
    seedRegistry: (nsDir: string, managed: string) => void,
    alsoSeed?: (root: string) => void,
  ): void {
    const root = mkdtempSync(join(tmpdir(), 'sh-conv-'));
    const home = mkdtempSync(join(tmpdir(), 'sh-conv-home-'));
    try {
      const nsDir = join(root, bindingSlug(BINDING));
      const managed = join(nsDir, 'workspaces', managedWorkspaceSlug(WS));
      mkdirSync(managed, { recursive: true });
      seedRegistry(nsDir, managed);
      alsoSeed?.(root);
      const registryBytes = readFileSync(join(nsDir, 'workspace-registry.json'), 'utf8');
      const bucket = seedBucket(home, managed);
      expect(() =>
        runWorkspaceDataConvergencePass({
          workspaceDataRoot: root,
          currentBinding: BINDING,
          sessionStoreHome: home,
          env: {},
          logger: silent,
        }),
      ).toThrow();
      // ZERO session renames, source registry byte-identical, no flat.
      expect(existsSync(join(bucket, 'session-1.jsonl'))).toBe(true);
      expect(readFileSync(join(nsDir, 'workspace-registry.json'), 'utf8')).toBe(registryBytes);
      expect(existsSync(join(root, 'workspace-registry.json'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }

  it('P0-2a: a registry MISSING the workspaces field fails the strict plan — never repaired to empty', () => {
    expectPlanFailure(nsDir =>
      writeFileSync(
        join(nsDir, 'workspace-registry.json'),
        JSON.stringify({ schema_version: 1, binding: BINDING }),
      ),
    );
  });

  it('P0-2b: an unsafe managed id fails BEFORE any session rename', () => {
    expectPlanFailure(nsDir => {
      const badId = 'evil/../id';
      const badManaged = join(nsDir, 'workspaces', managedWorkspaceSlug(badId));
      mkdirSync(badManaged, { recursive: true });
      writeFileSync(
        join(nsDir, 'workspace-registry.json'),
        JSON.stringify({
          schema_version: 1,
          binding: BINDING,
          workspaces: {
            [WS]: { path: join(nsDir, 'workspaces', managedWorkspaceSlug(WS)), provisioned_at: 1 },
            [badId]: { path: badManaged, provisioned_at: 1 },
          },
        }),
      );
    });
  });

  it('P0-2c: a case-fold id collision fails BEFORE any session rename', () => {
    expectPlanFailure(nsDir =>
      writeFileSync(
        join(nsDir, 'workspace-registry.json'),
        JSON.stringify({
          schema_version: 1,
          binding: BINDING,
          workspaces: {
            WsAbC: { path: join(nsDir, 'workspaces', managedWorkspaceSlug('WsAbC')), provisioned_at: 1 },
            wsabc: { path: join(nsDir, 'workspaces', managedWorkspaceSlug('wsabc')), provisioned_at: 1 },
          },
        }),
      ),
    );
  });

  it('P0-2d: a flat coordinate occupied by a FILE fails BEFORE any session rename', () => {
    expectPlanFailure(
      nsDir =>
        writeFileSync(
          join(nsDir, 'workspace-registry.json'),
          JSON.stringify({
            schema_version: 1,
            binding: BINDING,
            workspaces: {
              [WS]: { path: join(nsDir, 'workspaces', managedWorkspaceSlug(WS)), provisioned_at: 1 },
            },
          }),
        ),
      root => {
        mkdirSync(join(root, 'workspaces'), { recursive: true });
        writeFileSync(join(root, 'workspaces', WS), 'not-a-directory');
      },
    );
  });

  it('P0-2e: a malformed FLAT registry blocks the resume — never stamped over', () => {
    const root = mkdtempSync(join(tmpdir(), 'sh-conv-'));
    try {
      seedSlugNamespace(root, BINDING, WS);
      writeFileSync(join(root, 'workspace-registry.json'), '{ broken flat');
      expect(() =>
        runWorkspaceDataConvergencePass({
          workspaceDataRoot: root,
          currentBinding: BINDING,
          sessionStoreHome: root,
          env: {},
          logger: silent,
        }),
      ).toThrowError(expect.objectContaining({ code: 'flatten_unreadable' }));
      // Source untouched.
      expect(
        existsSync(join(root, bindingSlug(BINDING), 'workspace-registry.json')),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a flat registry from a different binding blocks resume instead of becoming current', () => {
    const root = mkdtempSync(join(tmpdir(), 'sh-conv-'));
    try {
      writeFileSync(
        join(root, 'workspace-registry.json'),
        JSON.stringify({
          schema_version: 1,
          binding: BINDING,
          workspaces: {},
        }),
      );

      expect(() =>
        runWorkspaceDataConvergencePass({
          workspaceDataRoot: root,
          currentBinding: OTHER_BINDING,
          sessionStoreHome: root,
          env: {},
          logger: silent,
        }),
      ).toThrowError(expect.objectContaining({ code: 'flatten_conflict' }));
      expect(
        JSON.parse(readFileSync(join(root, 'workspace-registry.json'), 'utf8')),
      ).toMatchObject({ binding: BINDING });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('P1-1: a case-fold-colliding FLAT registry blocks the resume — no source retirement (R5)', () => {
    const root = mkdtempSync(join(tmpdir(), 'sh-conv-'));
    try {
      seedSlugNamespace(root, BINDING, WS);
      // Crash-resume flat registry carrying a case-fold collision on
      // EXTERNAL entries — the shared invariant must reject it.
      writeFileSync(
        join(root, 'workspace-registry.json'),
        JSON.stringify({
          schema_version: 1,
          binding: BINDING,
          workspaces: {
            WsAbC: { path: '/Users/u/a', provisioned_at: 1 },
            wsabc: { path: '/Users/u/b', provisioned_at: 1 },
          },
        }),
      );
      expect(() =>
        runWorkspaceDataConvergencePass({
          workspaceDataRoot: root,
          currentBinding: BINDING,
          sessionStoreHome: root,
          env: {},
          logger: silent,
        }),
      ).toThrowError(expect.objectContaining({ code: 'flatten_conflict' }));
      // The source registry was NOT retired.
      expect(
        existsSync(join(root, bindingSlug(BINDING), 'workspace-registry.json')),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('P1-2: an external-only registry with workspaces/ occupied by a FILE fails the plan — zero flat output (R5)', () => {
    const root = mkdtempSync(join(tmpdir(), 'sh-conv-'));
    try {
      const nsDir = join(root, bindingSlug(BINDING));
      mkdirSync(nsDir, { recursive: true });
      writeFileSync(
        join(nsDir, 'workspace-registry.json'),
        JSON.stringify({
          schema_version: 1,
          binding: BINDING,
          workspaces: { w_ext: { path: '/Users/u/project', provisioned_at: 1 } },
        }),
      );
      writeFileSync(join(root, 'workspaces'), 'not-a-directory');
      expect(() =>
        runWorkspaceDataConvergencePass({
          workspaceDataRoot: root,
          currentBinding: BINDING,
          sessionStoreHome: root,
          env: {},
          logger: silent,
        }),
      ).toThrowError(expect.objectContaining({ code: 'flatten_conflict' }));
      // ZERO flat output: no flat registry was written, source intact.
      expect(existsSync(join(root, 'workspace-registry.json'))).toBe(false);
      expect(existsSync(join(nsDir, 'workspace-registry.json'))).toBe(true);
      expect(readFileSync(join(root, 'workspaces'), 'utf8')).toBe('not-a-directory');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('an empty or never-migrated root is a no-op (no namespace claims the id)', () => {
    const root = mkdtempSync(join(tmpdir(), 'sh-conv-'));
    try {
      const r = runWorkspaceDataConvergencePass({
        workspaceDataRoot: root,
        currentBinding: BINDING,
        sessionStoreHome: root,
        env: {},
        logger: silent,
      });
      expect(r.status).toBe('no_namespace');
      expect(existsSync(join(root, 'workspace-registry.json'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('repairs a released underscore-preserving session namespace on an already-flat root (#task:1663)', () => {
    const root = mkdtempSync(join(tmpdir(), 'sh_conv_'));
    const home = mkdtempSync(join(tmpdir(), 'sh-conv-home-'));
    try {
      const workspaceId = 'workspace_id';
      const cwd = join(root, 'workspaces', workspaceId);
      mkdirSync(cwd, { recursive: true });
      writeFileSync(
        join(root, 'workspace-registry.json'),
        JSON.stringify({
          schema_version: 1,
          binding: BINDING,
          workspaces: {
            [workspaceId]: { path: cwd, provisioned_at: 1 },
          },
        }),
      );
      const releasedSlug = cwd.replace(/[/.]/g, '-');
      const releasedBucket = join(home, '.claude', 'projects', releasedSlug);
      mkdirSync(releasedBucket, { recursive: true });
      writeFileSync(join(releasedBucket, 'session-1.jsonl'), '{"session":"preserved"}');

      const result = runWorkspaceDataConvergencePass({
        workspaceDataRoot: root,
        currentBinding: BINDING,
        sessionStoreHome: home,
        env: {},
        logger: silent,
      });

      expect(result).toEqual({ status: 'already_flat', renamed: 1 });
      expect(
        readFileSync(
          join(home, '.claude', 'projects', cwdSessionSlug(cwd), 'session-1.jsonl'),
          'utf8',
        ),
      ).toBe('{"session":"preserved"}');
      expect(existsSync(releasedBucket)).toBe(false);
      expect(
        runWorkspaceDataConvergencePass({
          workspaceDataRoot: root,
          currentBinding: BINDING,
          sessionStoreHome: home,
          env: {},
          logger: silent,
        }),
      ).toEqual({ status: 'already_flat', renamed: 0 });
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});
