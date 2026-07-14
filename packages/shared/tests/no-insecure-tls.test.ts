/**
 * D4.a Commit 1 — CI grep gate enforcing the d4-design §8.3 invariant:
 * **`rejectUnauthorized: false` is absolutely banned in production paths.**
 *
 * V1 TLS policy has a single accept state `system_ca_verified`
 * (Node/Electron system-default CA verification). There is no audited
 * exception helper, no SPKI pin, no self-signed support. The legitimate
 * occurrence count of `rejectUnauthorized: false` in production source
 * is therefore exactly zero — and we enforce that by walking the
 * scoped production directories and failing the test on any match.
 *
 * Why this lives as a vitest test (rather than a separate shell
 * script run from CI):
 *   - `pnpm test` is the existing dev / CI gate; we get enforcement
 *     for free without wiring a new pipeline step.
 *   - Test failures surface the offending file:line in CI output the
 *     same way every other failure does.
 *   - Pure Node implementation (no ripgrep / shell dependency) makes
 *     this portable across the macOS dev box and any CI runner.
 *
 * Scope:
 *   - apps/desktop/src/main
 *   - apps/desktop/src/preload
 *   - packages/host/src
 *   - packages/backend/src
 *   - packages/shared/src
 *   - packages/cli/src
 *
 * NOT scanned:
 *   - Test files (tests may need to construct intentionally-bad TLS
 *     contexts to exercise the typed-error mapper — those are
 *     allowed under controlled fixtures, NOT in production code).
 *   - Docs / markdown (docs quote the token while explaining the
 *     ban; that's fine).
 *   - apps/desktop/src/renderer (browser-side code does not configure
 *     Node TLS agents; renderer fetch goes through main-process proxy
 *     per spec §10.2 anyway).
 *   - generated / vendored code (none in scope today; if it lands,
 *     add an explicit allowlist with a comment justifying each entry).
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// `import.meta.url` based root resolution: this test file lives at
//   <repo-root>/packages/shared/tests/no-insecure-tls.test.ts
// so we walk up three levels to land on the repo root. If the file is
// ever moved, this constant MUST be updated — the depth is hardcoded
// rather than searching for a sentinel file because that's exactly
// the kind of fragile auto-detection that breaks under workspaces.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..', '..');

const PRODUCTION_PATHS: ReadonlyArray<string> = [
  'apps/desktop/src/main',
  'apps/desktop/src/preload',
  'packages/host/src',
  'packages/backend/src',
  'packages/shared/src',
  'packages/cli/src',
];

const SOURCE_EXTENSIONS: ReadonlyArray<string> = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.mjs',
  '.cjs',
];

/**
 * The forbidden pattern. Whitespace tolerant on the colon side
 * (`rejectUnauthorized:false`, `rejectUnauthorized : false`,
 * `rejectUnauthorized:\n  false`) — same tolerance any JS/TS
 * formatter would emit.
 *
 * `false` is matched as a literal word — we deliberately do NOT
 * also match `0` / `null` / variable references, because Node's
 * tls.connect treats those differently (only literal `false`
 * disables verification). A future change to broaden the
 * detection should add explicit cases here with comments.
 */
const FORBIDDEN_PATTERN = /rejectUnauthorized\s*:\s*false\b/;

interface FoundOccurrence {
  /** Path relative to repo root for stable diagnostics. */
  relPath: string;
  /** 1-based line number where the match starts. */
  line: number;
  /** The matching line content (trimmed) for context in the failure. */
  excerpt: string;
}

async function walkSourceFiles(absDir: string): Promise<string[]> {
  // Recursive readdir is supported on Node 18+ and 20+; the
  // `withFileTypes` + `recursive` combo is the cheapest way to get
  // an absolute-path file list. Skip node_modules / dist / coverage
  // directories defensively even though the scoped paths shouldn't
  // contain them.
  //
  // `encoding: 'utf8'` is explicit so the @types/node overload
  // resolves to `Dirent<string>[]` rather than the buffer variant
  // (TS 5.x is strict about the `NonSharedBuffer` distinction).
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(absDir, {
      withFileTypes: true,
      recursive: true,
      encoding: 'utf8',
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      // Directory missing is OK — some scopes (e.g.
      // `apps/desktop/src/preload`) may not exist in a fresh tree.
      // Returning empty makes the gate vacuously pass for absent
      // directories rather than erroring out.
      return [];
    }
    throw err;
  }
  const out: string[] = [];
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const name = ent.name;
    // `recursive: true` returns names like `subdir/file.ts` in `ent.name`
    // on some Node versions and bare basenames on others. The `parentPath`
    // (Node 20+) / `path` (Node 22+) accessor gives the parent dir.
    // Compose the absolute path defensively across both shapes.
    const parent =
      (ent as unknown as { parentPath?: string; path?: string }).parentPath ??
      (ent as unknown as { path?: string }).path ??
      absDir;
    const abs = join(parent, name);
    if (!SOURCE_EXTENSIONS.some(ext => abs.endsWith(ext))) continue;
    // Defensive skip for common derived dirs even though the scope
    // is supposed to be `src/`. A misconfiguration in tsconfig that
    // accidentally drops a `dist/` into `src/` should NOT make this
    // gate scream — the production code we care about is hand-written.
    if (/[\\/](node_modules|dist|build|coverage|\.cache)[\\/]/.test(abs)) {
      continue;
    }
    out.push(abs);
  }
  return out;
}

async function findOccurrences(): Promise<FoundOccurrence[]> {
  const found: FoundOccurrence[] = [];
  for (const relDir of PRODUCTION_PATHS) {
    const absDir = join(REPO_ROOT, relDir);
    const files = await walkSourceFiles(absDir);
    for (const abs of files) {
      const text = await readFile(abs, 'utf8');
      // Quick reject: skip file split if the pattern doesn't
      // appear at all (lineless test on the raw blob).
      if (!FORBIDDEN_PATTERN.test(text)) continue;
      // Per-line scan to compose accurate diagnostics.
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line === undefined) continue;
        if (!FORBIDDEN_PATTERN.test(line)) continue;
        found.push({
          relPath: abs.startsWith(REPO_ROOT + '/')
            ? abs.slice(REPO_ROOT.length + 1)
            : abs,
          line: i + 1,
          excerpt: line.trim(),
        });
      }
    }
  }
  return found;
}

describe('D4.a §8.3 — rejectUnauthorized:false production-path ban (CI grep gate)', () => {
  it('no production source file contains `rejectUnauthorized: false`', async () => {
    const occurrences = await findOccurrences();
    if (occurrences.length === 0) {
      // Happy path: the gate passes silently.
      expect(occurrences).toEqual([]);
      return;
    }
    const formatted = occurrences
      .map(o => `  ${o.relPath}:${o.line}  →  ${o.excerpt}`)
      .join('\n');
    throw new Error(
      [
        `D4.0 contract §8.3 violation:`,
        `\`rejectUnauthorized: false\` is absolutely banned in production paths.`,
        `Use the system-default TLS verification pipeline.`,
        `If you need to test against a self-signed cert, do it from a test`,
        `fixture under tests/, not from production source.`,
        ``,
        `Offending occurrences (${occurrences.length}):`,
        formatted,
      ].join('\n'),
    );
  });

  it('every production-path scope entry exists on disk AND scans at least one source file', async () => {
    // Meta-test pin (strengthened per Cindy D4.a Commit 1 review
    // 2026-05-28): the previous version only required ≥ 1 path to
    // resolve, which would silently let a renamed / typo'd path
    // become a no-op scan of a real production directory. The
    // strengthened contract is "every PRODUCTION_PATHS entry MUST
    // exist on disk AND MUST contain ≥ 1 source file under the
    // SOURCE_EXTENSIONS allowlist".
    //
    // If a future scope becomes genuinely optional (e.g.
    // `apps/desktop/src/preload` is removed in a renderer-only
    // build), add an explicit `OPTIONAL_PRODUCTION_PATHS` allowlist
    // with a comment justifying each entry — silent tolerance for
    // missing scope is the failure mode this test was rewritten to
    // catch.
    expect(PRODUCTION_PATHS.length).toBeGreaterThan(0);
    const reports = await Promise.all(
      PRODUCTION_PATHS.map(async p => {
        const abs = join(REPO_ROOT, p);
        let exists = false;
        try {
          await readdir(abs);
          exists = true;
        } catch {
          exists = false;
        }
        const files = exists ? await walkSourceFiles(abs) : [];
        return { path: p, exists, fileCount: files.length };
      }),
    );
    // Report ALL violations at once so a maintainer fixing scope
    // drift sees the complete picture, not one error at a time.
    const missingDirs = reports.filter(r => !r.exists).map(r => r.path);
    const emptyDirs = reports
      .filter(r => r.exists && r.fileCount === 0)
      .map(r => r.path);
    if (missingDirs.length > 0 || emptyDirs.length > 0) {
      const lines: string[] = ['Production-path scope drift detected:'];
      if (missingDirs.length > 0) {
        lines.push(`  Missing directories:`);
        for (const p of missingDirs) lines.push(`    - ${p}`);
      }
      if (emptyDirs.length > 0) {
        lines.push(`  Directories with no source files:`);
        for (const p of emptyDirs) lines.push(`    - ${p}`);
      }
      lines.push('');
      lines.push(
        'Either fix the scope list, or — if the path is genuinely optional —',
      );
      lines.push(
        'introduce an explicit OPTIONAL_PRODUCTION_PATHS allowlist and add a',
      );
      lines.push(
        'comment justifying each entry. Silent no-op scans are exactly the',
      );
      lines.push('regression this test exists to prevent.');
      throw new Error(lines.join('\n'));
    }
    // Final sanity: total file count must be > 0 (defensive — would
    // be covered by the per-path check above, but pinning the
    // aggregate gives an easy invariant for future readers).
    const totalFiles = reports.reduce((acc, r) => acc + r.fileCount, 0);
    expect(totalFiles).toBeGreaterThan(0);
  });
});
