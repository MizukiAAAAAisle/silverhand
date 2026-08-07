import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveAgentWorkspaceBundleDir } from '../../src/daemon/agent-materialize/handler.js';
import {
  buildManifest,
  copyTreeStable,
  manifestsEqual,
  probe,
} from '../../src/daemon/workspace-registry/opaque-copy.js';
import { RelocationError } from '../../src/daemon/workspace-registry/relocation-error.js';
import {
  runWorkspaceLayoutRelocation,
  __test_enumerateAgentCensus as enumerateAgentCensus,
  __test_fanOutOneBucket as fanOutOneBucket,
  __test_planSessionFanOut as planSessionFanOut,
  __test_readRelocationMarker as readRelocationMarker,
  __test_relocateSingleTree as relocateSingleTree,
} from '../../src/daemon/workspace-registry/layout-relocation.js';
import type { RegistryBinding } from '../../src/daemon/workspace-registry/registry.js';
import { cwdSessionSlug, SessionStoreConfigError } from '../../src/daemon/workspace-registry/session-migration.js';

/**
 * #task:1805 workspace-layout-relocation-v1 §5 falsifiers. Each block breaks a
 * specific invariant the facet promises: the opaque-copy stable-snapshot
 * guarantees (torn staged copy, source rewritten mid-copy, symlink/mode
 * fidelity), the single publish classifier's five filesystem rows, the 1→N
 * batch fan-out equivalence + batch stability, the marker's non-binary version
 * routing, and the end-to-end convergence promise: L2 publishes but session
 * fan-out fails ⇒ the marker is NOT written and a restart converges from that
 * exact physical state.
 */

const BINDING: RegistryBinding = {
  server_origin: 'https://app.example.com',
  host_id: 'host_abc',
};

const silentLogger = {
  info: () => {},
  warn: () => {},
};

/**
 * Seed the legacy registry inventory this migration reads. relocation-v1 §7-4
 * (#task:1808) — the registry is a READ-ONLY reader, so the file is written
 * directly: that is the only way it can exist (an older daemon wrote it), and a
 * fixture routed through the retired `provision()` would exercise code that no
 * longer ships.
 */
function seedLegacyInventory(
  workspaceDataRootDir: string,
  workspaces: Record<string, string>,
  binding: RegistryBinding = BINDING,
): void {
  mkdirSync(workspaceDataRootDir, { recursive: true });
  writeFileSync(
    join(workspaceDataRootDir, 'workspace-registry.json'),
    JSON.stringify({
      schema_version: 1,
      binding,
      workspaces: Object.fromEntries(
        Object.entries(workspaces).map(([id, path]) => [id, { path, provisioned_at: 1 }]),
      ),
    }),
  );
}

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'sh1805-reloc-'));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** Materialize a tree from a spec keyed by relative path: string ⇒ file,
 *  {link} ⇒ symlink, {mode,content} ⇒ file with explicit mode. */
type TreeSpec = Record<
  string,
  string | { link: string } | { content: string; mode: number }
>;
function makeTree(root: string, spec: TreeSpec): void {
  mkdirSync(root, { recursive: true });
  for (const [rel, value] of Object.entries(spec)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    if (typeof value === 'string') {
      writeFileSync(abs, value);
    } else if ('link' in value) {
      symlinkSync(value.link, abs);
    } else {
      writeFileSync(abs, value.content);
      chmodSync(abs, value.mode);
    }
  }
}

function findStaging(destParent: string): string {
  const name = readdirSync(destParent).find(n => n.startsWith('.relocation-staging.'));
  if (name === undefined) throw new Error('no staging dir found beside destination');
  return join(destParent, name);
}

describe('opaque-copy — stable-snapshot copy invariants (§5 step 1–4)', () => {
  it('copies a dir tree verbatim when the destination is absent', () => {
    const src = join(scratch, 'src');
    const dst = join(scratch, 'out', 'dst');
    makeTree(src, { 'MEMORY.md': 'hello', 'notes/a.md': 'note-a' });
    copyTreeStable(src, dst);
    expect(readFileSync(join(dst, 'MEMORY.md'), 'utf-8')).toBe('hello');
    expect(readFileSync(join(dst, 'notes/a.md'), 'utf-8')).toBe('note-a');
    // Source is left untouched, verbatim, and inert.
    expect(readFileSync(join(src, 'MEMORY.md'), 'utf-8')).toBe('hello');
  });

  it('preserves a symlink by target, never dereferenced', () => {
    const src = join(scratch, 'src');
    const dst = join(scratch, 'dst');
    makeTree(src, { 'real.txt': 'payload', 'alias.txt': { link: 'real.txt' } });
    copyTreeStable(src, dst);
    const linkStat = lstatSync(join(dst, 'alias.txt'));
    expect(linkStat.isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(dst, 'alias.txt'))).toBe('real.txt');
  });

  it('preserves an executable file mode after migration', () => {
    const src = join(scratch, 'src');
    const dst = join(scratch, 'dst');
    makeTree(src, { 'run.sh': { content: '#!/bin/sh\n', mode: 0o755 } });
    copyTreeStable(src, dst);
    expect(statSync(join(dst, 'run.sh')).mode & 0o777).toBe(0o755);
  });

  it('refuses a torn staged copy (staged ≠ source-before) and discards staging', () => {
    const src = join(scratch, 'src');
    const dst = join(scratch, 'out', 'dst');
    makeTree(src, { 'a.txt': 'original' });
    expect(() =>
      copyTreeStable(src, dst, {
        onStaged: () => {
          // Same length, different bytes: only a content hash catches this.
          const staging = findStaging(dirname(dst));
          writeFileSync(join(staging, 'a.txt'), 'MODIFIED');
        },
      }),
    ).toThrow(
      expect.objectContaining({ code: 'relocation_unstable' }),
    );
    expect(probe(dst)).toBe('absent'); // never published
    expect(readFileSync(join(src, 'a.txt'), 'utf-8')).toBe('original'); // source intact
    // Staging discarded.
    expect(readdirSync(dirname(dst)).some(n => n.startsWith('.relocation-staging.'))).toBe(false);
  });

  it('refuses when the source is rewritten under the copy (source-after ≠ source-before)', () => {
    const src = join(scratch, 'src');
    const dst = join(scratch, 'out', 'dst');
    makeTree(src, { 'a.txt': 'v1______' });
    expect(() =>
      copyTreeStable(src, dst, {
        onStaged: () => {
          writeFileSync(join(src, 'a.txt'), 'v2______'); // same length, different content
        },
      }),
    ).toThrow(expect.objectContaining({ code: 'relocation_unstable' }));
    expect(probe(dst)).toBe('absent');
  });

  it('refuses a lost executable bit in the staged copy (mode is part of the manifest)', () => {
    const src = join(scratch, 'src');
    const dst = join(scratch, 'out', 'dst');
    makeTree(src, { 'run.sh': { content: '#!/bin/sh\n', mode: 0o755 } });
    expect(() =>
      copyTreeStable(src, dst, {
        onStaged: () => {
          chmodSync(join(findStaging(dirname(dst)), 'run.sh'), 0o644);
        },
      }),
    ).toThrow(expect.objectContaining({ code: 'relocation_unstable' }));
    expect(probe(dst)).toBe('absent');
  });

  it('manifestsEqual is content-sensitive, not size-sensitive', () => {
    const a = join(scratch, 'a');
    const b = join(scratch, 'b');
    makeTree(a, { 'f.txt': 'AAAA' });
    makeTree(b, { 'f.txt': 'BBBB' });
    expect(manifestsEqual(buildManifest(a), buildManifest(a))).toBe(true);
    expect(manifestsEqual(buildManifest(a), buildManifest(b))).toBe(false);
  });

  it('copies a read-only (0555) tree — root AND nested dirs — without EACCES, preserving modes (§5 B4)', () => {
    const src = join(scratch, 'ro-src');
    const dst = join(scratch, 'ro-dst');
    // Build writable, populate, THEN clamp the nested dir and the root to 0555.
    // The copy must create its dirs writable and clamp their mode only after
    // writing children, or a 0555 dir would block writing its own contents.
    mkdirSync(join(src, 'nested'), { recursive: true });
    writeFileSync(join(src, 'top.txt'), 'top');
    writeFileSync(join(src, 'nested', 'inner.txt'), 'inner');
    chmodSync(join(src, 'nested'), 0o555);
    chmodSync(src, 0o555);
    try {
      copyTreeStable(src, dst);
      expect(readFileSync(join(dst, 'top.txt'), 'utf-8')).toBe('top');
      expect(readFileSync(join(dst, 'nested', 'inner.txt'), 'utf-8')).toBe('inner');
      expect(statSync(dst).mode & 0o777).toBe(0o555);
      expect(statSync(join(dst, 'nested')).mode & 0o777).toBe(0o555);
    } finally {
      // Restore writability so afterEach's recursive rm can unlink children.
      for (const p of [src, join(src, 'nested'), dst, join(dst, 'nested')]) {
        try {
          chmodSync(p, 0o755);
        } catch {
          // best-effort; the tree may be partial if the copy threw
        }
      }
    }
  });

  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  (isRoot ? it.skip : it)(
    'buildManifest fails closed as relocation_unreadable on an unreadable file (§5 B3)',
    () => {
      const src = join(scratch, 'noread');
      makeTree(src, { 'secret.txt': 'shh' });
      chmodSync(join(src, 'secret.txt'), 0o000);
      try {
        expect(() => buildManifest(src)).toThrow(
          expect.objectContaining({ code: 'relocation_unreadable' }),
        );
      } finally {
        try {
          chmodSync(join(src, 'secret.txt'), 0o644);
        } catch {
          // best-effort restore for cleanup
        }
      }
    },
  );

  it('discards staging even when its dirs were clamped read-only (0555) — no residue after an unstable failure (§5 MEDIUM)', () => {
    const src = join(scratch, 'ro-unstable-src');
    const dst = join(scratch, 'ro-unstable-out', 'dst');
    // A 0555 source ⇒ the staged copy's dirs are clamped 0555 too. A prior
    // `removeStaging` (plain recursive rm) could not empty those read-only dirs
    // and leaked the staging tree; cleanup must reopen them first.
    mkdirSync(join(src, 'nested'), { recursive: true });
    writeFileSync(join(src, 'top.txt'), 'v1______');
    writeFileSync(join(src, 'nested', 'inner.txt'), 'inner');
    chmodSync(join(src, 'nested'), 0o555);
    chmodSync(src, 0o555);
    try {
      expect(() =>
        copyTreeStable(src, dst, {
          onStaged: () => {
            // Rewrite the source under the copy (same length) so source-after ≠
            // source-before ⇒ relocation_unstable AFTER the staging dirs are
            // already clamped 0555. Reopen the 0555 root to mutate, then re-clamp.
            chmodSync(src, 0o755);
            writeFileSync(join(src, 'top.txt'), 'v2______');
            chmodSync(src, 0o555);
          },
        }),
      ).toThrow(expect.objectContaining({ code: 'relocation_unstable' }));
      // The read-only staged tree must be fully removed — no residue.
      expect(
        readdirSync(dirname(dst)).some(n => n.startsWith('.relocation-staging.')),
      ).toBe(false);
      expect(probe(dst)).toBe('absent');
    } finally {
      for (const p of [join(src, 'nested'), src]) {
        try {
          chmodSync(p, 0o755);
        } catch {
          // best-effort restore for cleanup
        }
      }
    }
  });
});

describe('relocateSingleTree — the one publish classifier (§5 five rows)', () => {
  const src = () => join(scratch, 'src');
  const dst = () => join(scratch, 'dst');

  it('source present, destination absent → copies', () => {
    makeTree(src(), { 'MEMORY.md': 'x' });
    relocateSingleTree(src(), dst());
    expect(readFileSync(join(dst(), 'MEMORY.md'), 'utf-8')).toBe('x');
  });

  it('source + destination equivalent → settled no-op (replay after a mid-batch crash)', () => {
    makeTree(src(), { 'MEMORY.md': 'x' });
    makeTree(dst(), { 'MEMORY.md': 'x' });
    expect(() => relocateSingleTree(src(), dst())).not.toThrow();
  });

  it('source + destination NOT equivalent → conflict', () => {
    makeTree(src(), { 'MEMORY.md': 'x' });
    makeTree(dst(), { 'MEMORY.md': 'DIFFERENT' });
    expect(() => relocateSingleTree(src(), dst())).toThrow(
      expect.objectContaining({ code: 'relocation_conflict' }),
    );
  });

  it('source absent, destination absent → not-applicable settled no-op', () => {
    expect(() => relocateSingleTree(src(), dst())).not.toThrow();
  });

  it('source absent, destination present → unverifiable conflict (a retained source cannot vanish)', () => {
    makeTree(dst(), { 'MEMORY.md': 'orphan' });
    expect(() => relocateSingleTree(src(), dst())).toThrow(
      expect.objectContaining({ code: 'relocation_conflict' }),
    );
  });
});

describe('fanOutOneBucket — 1→N opaque fan-out under one batch snapshot (§5)', () => {
  it('publishes N verbatim, identical copies from one source', () => {
    const source = join(scratch, 'bucket');
    makeTree(source, { 'sess.jsonl': 'line1\nline2\n', 'sub/x': 'y' });
    const dests = [join(scratch, 'd1'), join(scratch, 'd2'), join(scratch, 'd3')];
    const published = fanOutOneBucket(source, dests);
    expect(published).toBe(3);
    for (const d of dests) {
      expect(readFileSync(join(d, 'sess.jsonl'), 'utf-8')).toBe('line1\nline2\n');
      expect(readFileSync(join(d, 'sub/x'), 'utf-8')).toBe('y');
    }
  });

  it('withholds EVERY publish when the source is rewritten mid-fan-out', () => {
    const source = join(scratch, 'bucket');
    makeTree(source, { 'sess.jsonl': 'aaaaa' });
    const dests = [join(scratch, 'd1'), join(scratch, 'd2')];
    expect(() =>
      fanOutOneBucket(source, dests, {
        onStaged: () => writeFileSync(join(source, 'sess.jsonl'), 'bbbbb'),
      }),
    ).toThrow(expect.objectContaining({ code: 'relocation_unstable' }));
    // No destination gets a torn or half-batch publish.
    for (const d of dests) expect(probe(d)).toBe('absent');
    // MEDIUM (§5, Cindy): a failed fan-out leaves NO staging residue beside any
    // destination — every staging path is registered for cleanup the instant it
    // is chosen, before the copy runs.
    for (const d of dests) {
      expect(
        readdirSync(dirname(d)).some(n => n.startsWith('.relocation-staging.')),
      ).toBe(false);
    }
  });

  it('source present + one destination already-equivalent → replays only the missing ones', () => {
    const source = join(scratch, 'bucket');
    makeTree(source, { 'sess.jsonl': 'shared' });
    const settled = join(scratch, 'd1');
    makeTree(settled, { 'sess.jsonl': 'shared' });
    const fresh = join(scratch, 'd2');
    const published = fanOutOneBucket(source, [settled, fresh]);
    expect(published).toBe(1); // settled one staged nothing
    expect(readFileSync(join(fresh, 'sess.jsonl'), 'utf-8')).toBe('shared');
  });

  it('source present, live bucket with zero census → conflict (never silently orphaned)', () => {
    const source = join(scratch, 'bucket');
    makeTree(source, { 'sess.jsonl': 'x' });
    expect(() => fanOutOneBucket(source, [])).toThrow(
      expect.objectContaining({ code: 'relocation_conflict' }),
    );
  });

  it('source absent, all destinations absent → not-applicable no-op (a runtime never used)', () => {
    expect(fanOutOneBucket(join(scratch, 'missing'), [join(scratch, 'd1')])).toBe(0);
  });

  it('source absent, a destination present → unverifiable conflict', () => {
    const dest = join(scratch, 'd1');
    makeTree(dest, { 'sess.jsonl': 'orphan' });
    expect(() => fanOutOneBucket(join(scratch, 'missing'), [dest])).toThrow(
      expect.objectContaining({ code: 'relocation_conflict' }),
    );
  });
});

describe('planSessionFanOut — whole-inventory session plan (§5 B2)', () => {
  const deps = () => ({
    workspaceDataRootDir: join(scratch, 'wdr'),
    agentHomeRootDir: join(scratch, 'agents-home'),
    currentBinding: BINDING,
    sessionStoreHome: join(scratch, 'home'),
    env: {},
    logger: silentLogger,
  });

  it('collapses same-source aliasing destinations to ONE publish target', () => {
    // Two agent ids that differ only by `_` vs `-` resolve to bundle cwds whose
    // vendor slugs collide; from the SAME source bucket they must dedupe to one.
    const steps = planSessionFanOut(
      [
        {
          entry: { workspace_id: 'ws_1', path: join(scratch, 'checkout'), provisioned_at: 1 },
          census: ['a_x', 'a-x'],
        },
      ],
      deps(),
    );
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) expect(step.dests).toHaveLength(1);
  });

  it('raises a typed conflict when two distinct sources claim one destination', () => {
    // Same agent id in two workspaces whose ids differ only by `_`/`-`: the new
    // bundle cwds slug-collide, but the source buckets differ ⇒ a merge of
    // distinct histories, refused before any publish.
    expect(() =>
      planSessionFanOut(
        [
          {
            entry: { workspace_id: 'w_1', path: join(scratch, 'checkoutA'), provisioned_at: 1 },
            census: ['ax'],
          },
          {
            entry: { workspace_id: 'w-1', path: join(scratch, 'checkoutB'), provisioned_at: 1 },
            census: ['ax'],
          },
        ],
        deps(),
      ),
    ).toThrow(expect.objectContaining({ code: 'relocation_conflict' }));
  });

  it('an unverifiable store root is the SAME code the session pass raises (#task:1815)', () => {
    // The condition depends only on (runtime, env), so the planner raises the
    // pass-neutral typed error — not `relocation_unverifiable`, which is the
    // "we cannot prove this location" bucket the user cannot act on.
    let thrown: unknown;
    try {
      planSessionFanOut(
        [
          {
            entry: {
              workspace_id: 'ws_1',
              path: join(scratch, 'checkout'),
              provisioned_at: 1,
            },
            census: ['a_x'],
          },
        ],
        { ...deps(), env: { CLAUDE_CONFIG_DIR: 'relative/dir' } },
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SessionStoreConfigError);
    expect((thrown as SessionStoreConfigError).code).toBe(
      'session_store_root_unverifiable',
    );
    expect((thrown as SessionStoreConfigError).origin).toBe('relocation_plan');
    expect((thrown as Error).message).toMatch(/CLAUDE_CONFIG_DIR/);
  });

  it('asserts the store root ONCE per runtime, never per workspace', () => {
    // A per-workspace check made the refusal depend on inventory size; the
    // condition never did (#task:1815).
    expect(() =>
      planSessionFanOut([], { ...deps(), env: { CLAUDE_CONFIG_DIR: 'nope' } }),
    ).toThrow(SessionStoreConfigError);
  });
});

describe('readInventory — boundary validation fails closed as typed error (§5 B3)', () => {
  function writeFlatRegistry(
    wdr: string,
    workspaces: Record<string, { path: string; provisioned_at: number }>,
  ): void {
    mkdirSync(wdr, { recursive: true });
    writeFileSync(
      join(wdr, 'workspace-registry.json'),
      JSON.stringify({ schema_version: 1, binding: BINDING, workspaces }),
    );
  }
  function runReloc(wdr: string) {
    return runWorkspaceLayoutRelocation({
      workspaceDataRootDir: wdr,
      agentHomeRootDir: join(scratch, 'agents-home'),
      currentBinding: BINDING,
      sessionStoreHome: join(scratch, 'home'),
      env: {},
      logger: silentLogger,
    });
  }

  it('a non-canonical registry path → relocation_unverifiable', () => {
    const wdr = join(scratch, 'wdr');
    writeFlatRegistry(wdr, { ws_1: { path: '/a/b/../c', provisioned_at: 1 } });
    expect(() => runReloc(wdr)).toThrow(
      expect.objectContaining({ code: 'relocation_unverifiable' }),
    );
  });

  it('a relative registry path → relocation_unverifiable', () => {
    const wdr = join(scratch, 'wdr');
    writeFlatRegistry(wdr, { ws_1: { path: 'relative/checkout', provisioned_at: 1 } });
    expect(() => runReloc(wdr)).toThrow(
      expect.objectContaining({ code: 'relocation_unverifiable' }),
    );
  });

  it('an unsafe registry workspace id → relocation_unverifiable', () => {
    const wdr = join(scratch, 'wdr');
    writeFlatRegistry(wdr, {
      'has space': { path: join(scratch, 'checkout'), provisioned_at: 1 },
    });
    expect(() => runReloc(wdr)).toThrow(
      expect.objectContaining({ code: 'relocation_unverifiable' }),
    );
  });
});

describe('readRelocationMarker — non-binary version routing (§5 MEDIUM 1)', () => {
  const marker = () => join(scratch, 'relocation-v1.marker.json');

  it('missing file → run', () => {
    expect(readRelocationMarker(marker())).toEqual({ kind: 'run' });
  });

  it('current shape but corrupt JSON → run', () => {
    writeFileSync(marker(), '{ not json');
    expect(readRelocationMarker(marker())).toEqual({ kind: 'run' });
  });

  it('no routable version key → run', () => {
    writeFileSync(marker(), JSON.stringify({ facet: 'x' }));
    expect(readRelocationMarker(marker())).toEqual({ kind: 'run' });
  });

  it('current version but schema-invalid body → run', () => {
    writeFileSync(marker(), JSON.stringify({ schema_version: 1, facet: 'wrong' }));
    expect(readRelocationMarker(marker())).toEqual({ kind: 'run' });
  });

  it('valid v1 marker → done, carries the migrated counts', () => {
    writeFileSync(
      marker(),
      JSON.stringify({
        schema_version: 1,
        facet: 'workspace-layout-relocation-v1',
        completed_at: 123,
        migrated: { workspaces: 2, agents: 5 },
      }),
    );
    expect(readRelocationMarker(marker())).toEqual({ kind: 'done', workspaces: 2, agents: 5 });
  });

  it('strictly higher version → fail closed (never reinterpreted as v1)', () => {
    writeFileSync(marker(), JSON.stringify({ schema_version: 2, facet: 'x' }));
    expect(() => readRelocationMarker(marker())).toThrow(
      expect.objectContaining({ code: 'relocation_marker_unsupported' }),
    );
  });

  it('version below the first shipped version → fail closed', () => {
    writeFileSync(marker(), JSON.stringify({ schema_version: 0, facet: 'x' }));
    expect(() => readRelocationMarker(marker())).toThrow(
      expect.objectContaining({ code: 'relocation_marker_unsupported' }),
    );
  });
});

describe('enumerateAgentCensus — the shared L2/session census', () => {
  it('lists direct agent-dir children, skipping stray files, empty when agents/ is absent', () => {
    const root = join(scratch, 'ws');
    makeTree(root, {
      '.silverhand/agents/agentA/MEMORY.md': 'a',
      '.silverhand/agents/agentB/MEMORY.md': 'b',
      '.silverhand/agents/loose.txt': 'not an agent',
    });
    expect(enumerateAgentCensus(root)).toEqual(['agentA', 'agentB']);
    expect(enumerateAgentCensus(join(scratch, 'never-used'))).toEqual([]);
  });
});

describe('runWorkspaceLayoutRelocation — end-to-end convergence falsifier (§5)', () => {
  interface Fixture {
    workspaceDataRootDir: string;
    agentHomeRootDir: string;
    sessionHome: string;
    oldRoot: string;
    workspaceId: string;
    agentId: string;
    l2Dest: string;
    claudeSource: string;
    claudeDest: string;
  }

  function setUp(oldRootName = 'checkout'): Fixture {
    const workspaceDataRootDir = join(scratch, 'wdr');
    const agentHomeRootDir = join(scratch, 'agents-home');
    const sessionHome = join(scratch, 'home');
    const oldRoot = join(scratch, oldRootName);
    const workspaceId = 'ws_1';
    const agentId = 'agentAAA';
    mkdirSync(workspaceDataRootDir, { recursive: true });

    // Retained registry inventory: workspace_id → old shared cwd.
    seedLegacyInventory(workspaceDataRootDir, { [workspaceId]: oldRoot });

    // L2 subtree under the old shared cwd.
    makeTree(oldRoot, {
      '.silverhand/agents/agentAAA/MEMORY.md': 'agent memory',
      '.silverhand/agents/agentAAA/notes/n.md': 'a note',
    });

    // Shared Claude session bucket keyed by the OLD cwd slug.
    const claudeSource = join(sessionHome, '.claude', 'projects', cwdSessionSlug('claude', oldRoot));
    makeTree(claudeSource, { 'sess.jsonl': '{"turn":1}\n' });

    const l2Dest = resolveAgentWorkspaceBundleDir(agentId, workspaceId, { agentHomeRootDir });
    const claudeDest = join(sessionHome, '.claude', 'projects', cwdSessionSlug('claude', l2Dest));

    return {
      workspaceDataRootDir,
      agentHomeRootDir,
      sessionHome,
      oldRoot,
      workspaceId,
      agentId,
      l2Dest,
      claudeSource,
      claudeDest,
    };
  }

  function run(fx: Fixture) {
    return runWorkspaceLayoutRelocation({
      workspaceDataRootDir: fx.workspaceDataRootDir,
      agentHomeRootDir: fx.agentHomeRootDir,
      currentBinding: BINDING,
      sessionStoreHome: fx.sessionHome,
      env: {},
      logger: silentLogger,
    });
  }

  it('publishes an empty-inventory marker when a new computer has no workspace-data root yet', () => {
    const workspaceDataRootDir = join(scratch, 'computers', BINDING.host_id, 'workspace-data');
    expect(probe(workspaceDataRootDir)).toBe('absent');

    const first = runWorkspaceLayoutRelocation({
      workspaceDataRootDir,
      agentHomeRootDir: join(scratch, 'computers', BINDING.host_id, 'agents'),
      currentBinding: BINDING,
      sessionStoreHome: join(scratch, 'home'),
      env: {},
      logger: silentLogger,
    });

    expect(first).toMatchObject({ status: 'migrated', workspaces: 0, agents: 0, moved: true });
    expect(probe(join(workspaceDataRootDir, 'relocation-v1.marker.json'))).toBe('file');

    expect(
      runWorkspaceLayoutRelocation({
        workspaceDataRootDir,
        agentHomeRootDir: join(scratch, 'computers', BINDING.host_id, 'agents'),
        currentBinding: BINDING,
        sessionStoreHome: join(scratch, 'home'),
        env: {},
        logger: silentLogger,
      }),
    ).toMatchObject({ status: 'already_done', moved: false });
  });

  it('migrates L2 + session, writes the marker last, and replays idempotently', () => {
    const fx = setUp();
    const first = run(fx);
    expect(first).toMatchObject({ status: 'migrated', workspaces: 1, agents: 1, moved: true });

    // L2 relocated verbatim into the agent-centric bundle.
    expect(readFileSync(join(fx.l2Dest, 'MEMORY.md'), 'utf-8')).toBe('agent memory');
    expect(readFileSync(join(fx.l2Dest, 'notes/n.md'), 'utf-8')).toBe('a note');
    // Session bucket fanned out to the new cwd.
    expect(readFileSync(join(fx.claudeDest, 'sess.jsonl'), 'utf-8')).toBe('{"turn":1}\n');
    // Source retained, verbatim, inert.
    expect(readFileSync(join(fx.oldRoot, '.silverhand/agents/agentAAA/MEMORY.md'), 'utf-8')).toBe(
      'agent memory',
    );
    // Marker present.
    const markerPath = join(fx.workspaceDataRootDir, 'relocation-v1.marker.json');
    expect(probe(markerPath)).toBe('file');

    // Idempotent replay: valid marker ⇒ skip without re-running.
    const second = run(fx);
    expect(second).toMatchObject({ status: 'already_done', moved: false });
  });

  /**
   * #task:1816 — before the vendor-rule port, a legacy cwd holding any
   * character outside `[A-Za-z0-9/._-]` (a space, a parenthesis, CJK — exactly
   * what the old native folder picker accepted unvalidated) threw
   * `relocation_unverifiable` in the PLAN phase. The marker was therefore never
   * written and every subsequent boot failed the same way, with no in-app
   * remedy. This is the falsifier for that regression.
   */
  it('a legacy cwd with a space, parens and CJK migrates end-to-end (#task:1816)', () => {
    const fx = setUp('My Checkout (2025)/\u5de5\u4f5c\u533a');
    expect(fx.oldRoot).toMatch(/ \(2025\)/);

    expect(run(fx)).toMatchObject({ status: 'migrated', workspaces: 1, agents: 1, moved: true });
    expect(readFileSync(join(fx.l2Dest, 'MEMORY.md'), 'utf-8')).toBe('agent memory');
    expect(readFileSync(join(fx.claudeDest, 'sess.jsonl'), 'utf-8')).toBe('{"turn":1}\n');
    // Source bytes retained, and the marker IS written — the boot completes.
    expect(readFileSync(join(fx.oldRoot, '.silverhand/agents/agentAAA/MEMORY.md'), 'utf-8')).toBe(
      'agent memory',
    );
    expect(probe(join(fx.workspaceDataRootDir, 'relocation-v1.marker.json'))).toBe('file');
  });

  it('such a cwd still fails CLOSED when its session destination conflicts', () => {
    const fx = setUp('My Checkout (2025)/\u5de5\u4f5c\u533a');
    makeTree(fx.claudeDest, { 'sess.jsonl': 'CONFLICTING' });

    expect(() => run(fx)).toThrow(expect.objectContaining({ code: 'relocation_conflict' }));
    expect(probe(join(fx.workspaceDataRootDir, 'relocation-v1.marker.json'))).toBe('absent');
    expect(readFileSync(join(fx.claudeSource, 'sess.jsonl'), 'utf-8')).toBe('{"turn":1}\n');
  });

  it('L2 publishes but session fan-out fails ⇒ NO marker; a restart converges from that state', () => {
    const fx = setUp();
    // Poison the session destination with conflicting content so the fan-out
    // classifier fails closed AFTER the L2 subtree has already published.
    makeTree(fx.claudeDest, { 'sess.jsonl': 'CONFLICTING' });

    expect(() => run(fx)).toThrow(
      expect.objectContaining({ code: 'relocation_conflict' }),
    );

    // L2 was published (the failure came later in the same pass)...
    expect(readFileSync(join(fx.l2Dest, 'MEMORY.md'), 'utf-8')).toBe('agent memory');
    // ...but the marker was NOT written, so the daemon would not start on the
    // new resolver.
    const markerPath = join(fx.workspaceDataRootDir, 'relocation-v1.marker.json');
    expect(probe(markerPath)).toBe('absent');

    // Resolve the conflict (the operator / next state) and restart: the L2
    // classifier sees an equivalent published destination (settled no-op), the
    // fan-out now has an absent destination to publish, and the marker is
    // written — converging from the exact physical state the crash left.
    rmSync(fx.claudeDest, { recursive: true, force: true });
    const retry = run(fx);
    expect(retry).toMatchObject({ status: 'migrated', moved: true });
    expect(readFileSync(join(fx.claudeDest, 'sess.jsonl'), 'utf-8')).toBe('{"turn":1}\n');
    expect(probe(markerPath)).toBe('file');
  });

  it('same-source aliasing agents collapse to ONE session publish; L2 stays per-agent (§5 B2 dedup)', () => {
    const workspaceDataRootDir = join(scratch, 'wdr');
    const agentHomeRootDir = join(scratch, 'agents-home');
    const sessionHome = join(scratch, 'home');
    const oldRoot = join(scratch, 'checkout');
    const workspaceId = 'ws_1';
    mkdirSync(workspaceDataRootDir, { recursive: true });
    seedLegacyInventory(workspaceDataRootDir, { [workspaceId]: oldRoot });
    // Two agents whose new bundle cwds slug-collide (`a_x` vs `a-x`).
    makeTree(oldRoot, {
      '.silverhand/agents/a_x/MEMORY.md': 'mem-underscore',
      '.silverhand/agents/a-x/MEMORY.md': 'mem-hyphen',
    });
    makeTree(join(sessionHome, '.claude', 'projects', cwdSessionSlug('claude', oldRoot)), {
      'sess.jsonl': '{"t":1}\n',
    });

    const res = runWorkspaceLayoutRelocation({
      workspaceDataRootDir,
      agentHomeRootDir,
      currentBinding: BINDING,
      sessionStoreHome: sessionHome,
      env: {},
      logger: silentLogger,
    });
    expect(res).toMatchObject({ status: 'migrated', workspaces: 1, agents: 2 });

    const cwdUnderscore = resolveAgentWorkspaceBundleDir('a_x', workspaceId, { agentHomeRootDir });
    const cwdHyphen = resolveAgentWorkspaceBundleDir('a-x', workspaceId, { agentHomeRootDir });
    // L2 stays per-agent, distinct destinations.
    expect(readFileSync(join(cwdUnderscore, 'MEMORY.md'), 'utf-8')).toBe('mem-underscore');
    expect(readFileSync(join(cwdHyphen, 'MEMORY.md'), 'utf-8')).toBe('mem-hyphen');
    // The two new cwds slug-collide → ONE shared session namespace, published once.
    const destUnderscore = join(sessionHome, '.claude', 'projects', cwdSessionSlug('claude', cwdUnderscore));
    const destHyphen = join(sessionHome, '.claude', 'projects', cwdSessionSlug('claude', cwdHyphen));
    expect(destUnderscore).toBe(destHyphen); // guard: the alias really collides
    expect(readFileSync(join(destUnderscore, 'sess.jsonl'), 'utf-8')).toBe('{"t":1}\n');
  });

  it('cross-source collision on one session destination fails closed BEFORE any publish (§5 B2 conflict)', () => {
    const workspaceDataRootDir = join(scratch, 'wdr');
    const agentHomeRootDir = join(scratch, 'agents-home');
    const sessionHome = join(scratch, 'home');
    const oldRootA = join(scratch, 'checkoutA');
    const oldRootB = join(scratch, 'checkoutB');
    mkdirSync(workspaceDataRootDir, { recursive: true });
    // Two workspaces whose ids differ only by `_`/`-`, same agent id in both:
    // their new bundle cwds slug-collide, but the source buckets differ.
    seedLegacyInventory(workspaceDataRootDir, { w_1: oldRootA, 'w-1': oldRootB });
    makeTree(oldRootA, { '.silverhand/agents/ax/MEMORY.md': 'A' });
    makeTree(oldRootB, { '.silverhand/agents/ax/MEMORY.md': 'B' });
    makeTree(join(sessionHome, '.claude', 'projects', cwdSessionSlug('claude', oldRootA)), {
      'sess.jsonl': 'A\n',
    });
    makeTree(join(sessionHome, '.claude', 'projects', cwdSessionSlug('claude', oldRootB)), {
      'sess.jsonl': 'B\n',
    });

    expect(() =>
      runWorkspaceLayoutRelocation({
        workspaceDataRootDir,
        agentHomeRootDir,
        currentBinding: BINDING,
        sessionStoreHome: sessionHome,
        env: {},
        logger: silentLogger,
      }),
    ).toThrow(expect.objectContaining({ code: 'relocation_conflict' }));

    // Detected in the plan phase: NO marker, and EVERY destination still absent
    // — both the shared session namespace AND both L2 bundles.
    expect(probe(join(workspaceDataRootDir, 'relocation-v1.marker.json'))).toBe('absent');
    const cwdA = resolveAgentWorkspaceBundleDir('ax', 'w_1', { agentHomeRootDir });
    const cwdB = resolveAgentWorkspaceBundleDir('ax', 'w-1', { agentHomeRootDir });
    expect(cwdSessionSlug('claude', cwdA)).toBe(cwdSessionSlug('claude', cwdB)); // guard: they really collide
    expect(probe(join(sessionHome, '.claude', 'projects', cwdSessionSlug('claude', cwdA)))).toBe('absent');
    expect(probe(cwdA)).toBe('absent');
    expect(probe(cwdB)).toBe('absent');
  });
});
