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
  __test_readRelocationMarker as readRelocationMarker,
  __test_relocateSingleTree as relocateSingleTree,
} from '../../src/daemon/workspace-registry/layout-relocation.js';
import { WorkspaceRegistry, type RegistryBinding } from '../../src/daemon/workspace-registry/registry.js';
import { cwdSessionSlug } from '../../src/daemon/workspace-registry/session-migration.js';

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
    expect(probe(dests[0])).toBe('absent');
    expect(probe(dests[1])).toBe('absent');
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

  function setUp(): Fixture {
    const workspaceDataRootDir = join(scratch, 'wdr');
    const agentHomeRootDir = join(scratch, 'agents-home');
    const sessionHome = join(scratch, 'home');
    const oldRoot = join(scratch, 'checkout');
    const workspaceId = 'ws_1';
    const agentId = 'agentAAA';
    mkdirSync(workspaceDataRootDir, { recursive: true });

    // Retained registry inventory: workspace_id → old shared cwd.
    new WorkspaceRegistry({ stateDir: workspaceDataRootDir, binding: BINDING }).provision(
      workspaceId,
      oldRoot,
    );

    // L2 subtree under the old shared cwd.
    makeTree(oldRoot, {
      '.silverhand/agents/agentAAA/MEMORY.md': 'agent memory',
      '.silverhand/agents/agentAAA/notes/n.md': 'a note',
    });

    // Shared Claude session bucket keyed by the OLD cwd slug.
    const claudeSource = join(sessionHome, '.claude', 'projects', cwdSessionSlug(oldRoot));
    makeTree(claudeSource, { 'sess.jsonl': '{"turn":1}\n' });

    const l2Dest = resolveAgentWorkspaceBundleDir(agentId, workspaceId, { agentHomeRootDir });
    const claudeDest = join(sessionHome, '.claude', 'projects', cwdSessionSlug(l2Dest));

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
});
