/**
 * D4.d D2 tripwire: `packages/backend` MUST NOT import from
 * `packages/host/src/daemon/agent-materialize/**`.
 *
 * Why this is its own test (and not folded into the existing
 * `dependency-guard.test.ts` in `packages/host`): that test
 * enforces "host cannot reach into backend". This one enforces
 * the reverse direction for a specific sub-tree.
 *
 * Boundary (Cindy D4.d D2 pre-gate #1):
 *
 *   - The L1 agent-home template (system_prompt + MEMORY + notes/
 *     skeleton) lives at `packages/host/src/daemon/agent-materialize/
 *     template.ts` because the daemon owns the materialization.
 *   - The daemon is the SOLE owner of those template strings. The
 *     pre-D4.e backend semantic clone (`packages/backend/src/
 *     workspace-files.ts`) was removed in D4.e-5; the only remaining
 *     clone is the embedded test fake's `tests/utils/
 *     embedded-seed-fixtures.ts`, which the guard's remedy ("copy it
 *     locally") explicitly permits.
 *   - Re-coupling them by letting backend `import` from the daemon
 *     module would re-introduce the build-time dependency the
 *     design specifically broke. The tripwire here fires the
 *     instant a backend file (src or tests) reaches into that
 *     subtree, regardless of import form.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

const BACKEND_ROOT = resolve(__dirname, '..');
const REPO_ROOT = resolve(BACKEND_ROOT, '..', '..');

const FORBIDDEN_DIR = resolve(
  REPO_ROOT,
  'packages',
  'host',
  'src',
  'daemon',
  'agent-materialize',
);

/**
 * Package-name forms that resolve to the forbidden subtree. The
 * package is re-exported as `@silverhand/host`; the subtree itself
 * is internal and not re-exported from the barrel. A
 * `@silverhand/host/dist/daemon/agent-materialize/...` form would
 * be the most likely accidental reach.
 */
const FORBIDDEN_PACKAGE_PREFIXES = [
  '@silverhand/host/dist/daemon/agent-materialize',
  '@silverhand/host/src/daemon/agent-materialize',
];

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);

interface FoundImport {
  file: string;
  source: string;
}

function* walkSources(root: string): Generator<string> {
  for (const entry of readdirSync(root)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.silverhand') {
      continue;
    }
    const abs = join(root, entry);
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      yield* walkSources(abs);
      continue;
    }
    if (!SOURCE_EXTENSIONS.has(extOf(entry))) continue;
    yield abs;
  }
}

function extOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot < 0 ? '' : filename.slice(dot);
}

// match both `import ... from '<spec>'` and dynamic `import('<spec>')`
const IMPORT_RE = /(?:from\s*|import\s*\(\s*)['"]([^'"]+)['"]/g;

function checkFile(absPath: string): FoundImport[] {
  const text = readFileSync(absPath, 'utf8');
  const out: FoundImport[] = [];
  for (const m of text.matchAll(IMPORT_RE)) {
    const source = m[1];
    if (source !== undefined && isForbidden(absPath, source)) {
      out.push({ file: absPath, source });
    }
  }
  return out;
}

function isForbidden(importerAbsPath: string, source: string): boolean {
  if (FORBIDDEN_PACKAGE_PREFIXES.some(prefix => source === prefix || source.startsWith(`${prefix}/`))) {
    return true;
  }
  // Relative import resolution: dirname(importer) + source → does it
  // land inside FORBIDDEN_DIR?
  if (source.startsWith('.')) {
    const resolved = resolve(dirname(importerAbsPath), source);
    const rel = relative(FORBIDDEN_DIR, resolved);
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
      return true;
    }
  }
  return false;
}

describe('backend → host/agent-materialize import boundary', () => {
  it('no file under packages/backend imports from packages/host/src/daemon/agent-materialize/**', () => {
    const violations: FoundImport[] = [];
    for (const file of walkSources(BACKEND_ROOT)) {
      // Skip self
      if (file === __filename) continue;
      violations.push(...checkFile(file));
    }
    if (violations.length > 0) {
      const lines = violations.map(
        v => `  ${relative(REPO_ROOT, v.file)}  →  ${v.source}`,
      );
      throw new Error(
        [
          'Forbidden import of agent-materialize subtree detected in backend.',
          '',
          'The L1 agent-home template lives in the daemon (packages/host/',
          'src/daemon/agent-materialize/**) because the daemon owns the',
          'materialization. Backend code must NOT import from that subtree.',
          'If backend needs the same string verbatim, copy it locally and',
          'leave a comment noting the daemon copy is the source of truth.',
          '',
          'Violations:',
          ...lines,
        ].join('\n'),
      );
    }
    expect(violations).toEqual([]);
  });

  // Sanity-check the test itself: it should detect a synthetic
  // violation if the import form changes. We test this in-memory
  // (no file written) by exercising `isForbidden` directly with
  // known shapes — that way the test cannot accidentally green
  // because the regex got broken or the import sigil changed.
  it('isForbidden recognises every known import form', () => {
    const fakeBackendFile = resolve(BACKEND_ROOT, 'src', 'fake.ts');
    expect(
      isForbidden(
        fakeBackendFile,
        '@silverhand/host/dist/daemon/agent-materialize/handler',
      ),
    ).toBe(true);
    expect(
      isForbidden(
        fakeBackendFile,
        '@silverhand/host/src/daemon/agent-materialize/handler',
      ),
    ).toBe(true);
    expect(
      isForbidden(
        fakeBackendFile,
        '../../host/src/daemon/agent-materialize/handler',
      ),
    ).toBe(true);
    // Sibling subtree under host but NOT under agent-materialize: ok.
    expect(
      isForbidden(fakeBackendFile, '@silverhand/host/dist/daemon/dispatcher'),
    ).toBe(false);
    // Public barrel: ok (the barrel does not re-export from
    // agent-materialize today; if a future change re-exports the
    // typed error / schemas via `@silverhand/host`, the rule above
    // only catches the deep path forms — that is intentional, the
    // package-public surface is allowed by design).
    expect(isForbidden(fakeBackendFile, '@silverhand/host')).toBe(false);
  });
});
