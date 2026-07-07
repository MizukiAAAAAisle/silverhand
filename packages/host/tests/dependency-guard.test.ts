/**
 * Dependency-guard test (Cindy `vqDWkLFF6pAeIE5t` + `ecQq2DydBJGZUZ35`).
 *
 * `packages/host` is the execution-plane runtime daemon: it spawns
 * agent CLIs, owns process lifecycle, and exposes the runtime_*
 * protocol. It MUST NOT import:
 *
 *   - `@silverhand/backend`   — backend is the control plane (DB,
 *                               services, routes, drivers' prompt
 *                               assembly). Pulling it into host
 *                               would re-couple the two planes and
 *                               defeat the whole PR-2 step 2
 *                               execution-plane migration.
 *   - `@silverhand/cli`       — CLI is an agent-facing client.
 *   - `better-sqlite3`        — host has no DB ownership. Inboxes,
 *                               agent_runtime projection, schedules
 *                               all stay backend-owned. Letting host
 *                               touch sqlite would mean two writers
 *                               on the same DB file with no
 *                               coordination.
 *   - Any relative import that, after path resolution, lands inside
 *     `packages/backend`, `packages/cli`, or `apps/desktop`. We
 *     resolve against the importing file's dirname rather than
 *     string-matching `^../../backend` — that string regex used to
 *     only cover the `src/index.ts` depth and missed every nested
 *     file (`src/daemon/foo.ts` → `../../../backend` etc.).
 *
 * The shared package (`@silverhand/shared`) and `zod` ARE allowed —
 * they're declared in host's `dependencies` and are zero-side-effect
 * type / schema modules.
 *
 * This test is the runtime tripwire: any future PR that adds a
 * forbidden import in `packages/host/src/**` or
 * `packages/host/tests/**` fails CI here, before it can ever land.
 * Tests are in scope because a test fixture that imports backend
 * would re-bind host's behavior to backend just as effectively as a
 * src import would.
 */
import { describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const HOST_ROOT = resolve(__dirname, '..');
const REPO_ROOT = resolve(HOST_ROOT, '..', '..');
const CLI_ROOT = resolve(REPO_ROOT, 'packages/cli');

/**
 * Resolved absolute paths to package roots that must never be
 * reached from host via relative imports. `apps/desktop` is here
 * because the Electron renderer / main code is a downstream
 * consumer; importing it from host would invert the dependency.
 *
 * `packages/shared` is intentionally NOT here — it's a legitimate
 * dep, and intra-monorepo relative paths that traverse into shared
 * (`../../shared/...`) would just be redirecting around the
 * `@silverhand/shared` package import. The package-name rule
 * (workspace dep enforcement) covers the spec'd import form;
 * relative escape into shared is a code-smell but not a host
 * boundary violation.
 */
const FORBIDDEN_PACKAGE_ROOTS = [
  resolve(REPO_ROOT, 'packages/backend'),
  resolve(REPO_ROOT, 'packages/cli'),
  resolve(REPO_ROOT, 'apps/desktop'),
];

interface ForbiddenHit {
  file: string;
  line: number;
  text: string;
  matchedRule: string;
  specifier: string;
}

/**
 * Extract every module specifier referenced by a source line. Covers
 * the import / export / require forms TypeScript / Node actually
 * accept:
 *
 *   - `import x from 'spec'`
 *   - `import * as x from 'spec'`
 *   - `import { x } from 'spec'`
 *   - `import 'spec'`                   (side-effect; previously missed)
 *   - `import type { x } from 'spec'`
 *   - `export { x } from 'spec'`        (export-from; previously missed)
 *   - `export * from 'spec'`            (re-export; previously missed)
 *   - `export type { x } from 'spec'`
 *   - `import('spec')`                  (dynamic import)
 *   - `require('spec')`                 (CJS require literal)
 *
 * Multiple patterns may match the same line (e.g. an import + a
 * dynamic-import in a comment-stripped expression); we collect every
 * specifier so the rule layer can decide.
 */
function specifiersOf(line: string): string[] {
  const out: string[] = [];
  const patterns: RegExp[] = [
    // `import ... from 'spec'` / `export ... from 'spec'` — both bare
    // and named / type variants. The leading non-greedy chunk matches
    // anything up to the keyword `from`.
    /(?:^|[\s;{}()])(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g,
    // Side-effect import: `import 'spec';` or `import "spec";` with no
    // bindings. Anchored by whitespace / line-start to avoid eating
    // text like `something.import('x')`.
    /(?:^|[\s;{}()])import\s+['"]([^'"]+)['"]/g,
    // Dynamic import expression: `import('spec')`. Picks up both
    // top-level and nested usages.
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    // CJS require literal: `require('spec')`. Tolerates type-cast
    // wrappers because we only need the literal.
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      out.push(m[1]!);
    }
  }
  return out;
}

interface Rule {
  name: string;
  /** Receives the importing file's absolute path so relative
   *  specifiers can be resolved correctly. Returns true if `spec`
   *  violates the rule. */
  test: (spec: string, fromFile: string) => boolean;
}

const RULES: Rule[] = [
  {
    name: 'forbidden package import: @silverhand/backend',
    test: spec =>
      spec === '@silverhand/backend' || spec.startsWith('@silverhand/backend/'),
  },
  {
    name: 'forbidden package import: @silverhand/cli',
    test: spec => spec === '@silverhand/cli' || spec.startsWith('@silverhand/cli/'),
  },
  {
    name: 'forbidden package import: better-sqlite3',
    test: spec => spec === 'better-sqlite3' || spec.startsWith('better-sqlite3/'),
  },
  {
    name: 'forbidden relative import: escapes into packages/backend, packages/cli, or apps/desktop',
    test: (spec, fromFile) => {
      // Only relative specifiers can escape via path resolution.
      // Absolute filesystem paths in `from '...'` are illegal TS
      // anyway; bare specifiers are handled by the package-name
      // rules above.
      if (!spec.startsWith('.') && !isAbsolute(spec)) return false;
      const resolved = isAbsolute(spec) ? spec : resolve(dirname(fromFile), spec);
      return FORBIDDEN_PACKAGE_ROOTS.some(root => {
        // Match `root` exactly OR a path that begins with `root/`.
        // Using `relative(root, resolved)` would force us to detect
        // a non-leading `..` segment; the prefix check is simpler
        // and side-steps trailing-separator edge cases.
        return resolved === root || resolved.startsWith(root + sep);
      });
    },
  },
];

const CLI_RULES: Rule[] = [
  {
    name: 'forbidden CLI package import: @silverhand/backend',
    test: spec =>
      spec === '@silverhand/backend' || spec.startsWith('@silverhand/backend/'),
  },
  {
    name: 'forbidden CLI package import: better-sqlite3',
    test: spec => spec === 'better-sqlite3' || spec.startsWith('better-sqlite3/'),
  },
  {
    name: 'forbidden CLI relative import: escapes into packages/backend, packages/host, or apps/desktop',
    test: (spec, fromFile) => {
      if (!spec.startsWith('.') && !isAbsolute(spec)) return false;
      const resolved = isAbsolute(spec) ? spec : resolve(dirname(fromFile), spec);
      const forbiddenRoots = [
        resolve(REPO_ROOT, 'packages/backend'),
        resolve(REPO_ROOT, 'packages/host'),
        resolve(REPO_ROOT, 'apps/desktop'),
      ];
      return forbiddenRoots.some(root => {
        return resolved === root || resolved.startsWith(root + sep);
      });
    },
  },
];

function* walkTsFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'dist') continue;
      yield* walkTsFiles(full);
    } else if (st.isFile() && (name.endsWith('.ts') || name.endsWith('.tsx'))) {
      yield full;
    }
  }
}

function stripComments(source: string): string[] {
  // Returns one string per original line with `//` line comments and
  // `/* ... */` block comments removed. We keep newlines so line
  // numbers stay aligned for error reporting.
  const out: string[] = [];
  const lines = source.split('\n');
  let inBlock = false;
  for (const original of lines) {
    let line = original;
    if (inBlock) {
      const close = line.indexOf('*/');
      if (close === -1) {
        out.push('');
        continue;
      }
      line = line.slice(close + 2);
      inBlock = false;
    }
    // Repeatedly strip block comments that open AND close on this
    // line; track the last opened-but-not-closed block.
    let openIdx = line.indexOf('/*');
    while (openIdx !== -1) {
      const closeIdx = line.indexOf('*/', openIdx + 2);
      if (closeIdx === -1) {
        line = line.slice(0, openIdx);
        inBlock = true;
        break;
      }
      line = line.slice(0, openIdx) + line.slice(closeIdx + 2);
      openIdx = line.indexOf('/*');
    }
    const lineCommentIdx = line.indexOf('//');
    if (lineCommentIdx !== -1) {
      line = line.slice(0, lineCommentIdx);
    }
    out.push(line);
  }
  return out;
}

function scanForViolations(
  scanRoots: string[],
  rules: Rule[] = RULES,
): ForbiddenHit[] {
  const hits: ForbiddenHit[] = [];
  for (const root of scanRoots) {
    for (const file of walkTsFiles(root)) {
      // Skip this guard test itself — its rules literally contain
      // the forbidden strings to exercise them.
      if (file === __filename) continue;
      const source = readFileSync(file, 'utf-8');
      const lines = stripComments(source);
      const originalLines = source.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        for (const spec of specifiersOf(line)) {
          for (const rule of rules) {
            if (rule.test(spec, file)) {
              hits.push({
                file: relative(REPO_ROOT, file).split(sep).join('/'),
                line: i + 1,
                text: (originalLines[i] ?? '').trim(),
                matchedRule: rule.name,
                specifier: spec,
              });
            }
          }
        }
      }
    }
  }
  return hits;
}

describe('host package dependency guard (Cindy `vqDWkLFF6pAeIE5t` + `ecQq2DydBJGZUZ35`)', () => {
  it('no file in packages/host/{src,tests} imports backend/cli/sqlite/escape-relative', () => {
    const scanRoots = [join(HOST_ROOT, 'src'), join(HOST_ROOT, 'tests')];
    const hits = scanForViolations(scanRoots);
    if (hits.length > 0) {
      const formatted = hits
        .map(
          h =>
            `  ${h.file}:${h.line} — ${h.matchedRule}\n    specifier: ${h.specifier}\n    > ${h.text}`,
        )
        .join('\n');
      expect.fail(
        `found ${hits.length} forbidden import(s) in packages/host:\n${formatted}\n\n` +
          'Host owns the execution plane and must not depend on backend / cli / sqlite, ' +
          'and must not relative-escape into backend / cli / desktop packages. ' +
          'If you need data from backend, route it through the runtime_* protocol ' +
          '(`packages/host/src/protocol.ts`) instead.',
      );
    }
    expect(hits).toEqual([]);
  });

  it('no file in packages/cli/{src,tests} imports backend/sqlite/desktop or relative-escapes into host/backend', () => {
    const scanRoots = [join(CLI_ROOT, 'src'), join(CLI_ROOT, 'tests')];
    const hits = scanForViolations(scanRoots, CLI_RULES);
    if (hits.length > 0) {
      const formatted = hits
        .map(
          h =>
            `  ${h.file}:${h.line} — ${h.matchedRule}\n    specifier: ${h.specifier}\n    > ${h.text}`,
        )
        .join('\n');
      expect.fail(
        `found ${hits.length} forbidden import(s) in packages/cli:\n${formatted}\n\n` +
          'CLI may use published protocol/client package surfaces, but must not depend on ' +
          'backend internals, sqlite, desktop code, or relative-escape into host/backend.',
      );
    }
    expect(hits).toEqual([]);
  });

  it('scanner self-test: specifiersOf covers every import / export / require form', () => {
    // Each entry is a line and the set of specifiers we expect.
    // These prove `specifiersOf` actually picks up every form Node /
    // TS accept; gaps here are what Cindy `ecQq2DydBJGZUZ35` flagged.
    const cases: Array<{ line: string; expected: string[] }> = [
      { line: "import x from 'a';", expected: ['a'] },
      { line: "import * as x from 'a';", expected: ['a'] },
      { line: "import { x } from 'a';", expected: ['a'] },
      { line: "import type { x } from 'a';", expected: ['a'] },
      { line: "import 'a';", expected: ['a'] }, // side-effect (was missed)
      { line: '  import "a";', expected: ['a'] }, // side-effect with leading whitespace
      { line: "export { x } from 'a';", expected: ['a'] }, // export-from (was missed)
      { line: "export * from 'a';", expected: ['a'] }, // re-export (was missed)
      { line: "export type { x } from 'a';", expected: ['a'] },
      { line: "const x = import('a');", expected: ['a'] }, // dynamic import
      { line: "const x = require('a');", expected: ['a'] }, // CJS require (was missed)
      { line: "const x = require ( 'a' )", expected: ['a'] }, // require with spaces
    ];
    for (const { line, expected } of cases) {
      const got = specifiersOf(line);
      expect(got, `line=${JSON.stringify(line)}`).toEqual(expected);
    }
  });

  it('scanner self-test: every forbidden form actually fires the rules', () => {
    // Synthesize a file path deep inside host so `../../../backend`
    // is a realistic escape. The `src/daemon` depth is exactly the
    // case Cindy flagged as previously slipping past the old
    // `^../../backend` regex.
    const fromFile = resolve(HOST_ROOT, 'src/daemon/whatever.ts');
    const samples: Array<{ line: string; mustFire: boolean; note: string }> = [
      // Package-name forms — depth-independent.
      {
        line: "import { foo } from '@silverhand/backend';",
        mustFire: true,
        note: '@silverhand/backend bare',
      },
      {
        line: "import { foo } from '@silverhand/backend/services/foo.js';",
        mustFire: true,
        note: '@silverhand/backend subpath',
      },
      { line: "import 'better-sqlite3';", mustFire: true, note: 'sqlite side-effect' },
      {
        line: "const db = require('better-sqlite3');",
        mustFire: true,
        note: 'sqlite require',
      },
      {
        line: "import x from '@silverhand/cli';",
        mustFire: true,
        note: '@silverhand/cli bare',
      },
      // Relative-escape from `packages/host/src/daemon/`:
      //   ../../../backend = packages/backend
      {
        line: "import x from '../../../backend/src/context.js';",
        mustFire: true,
        note: 'relative escape into backend (correct depth)',
      },
      {
        line: "export * from '../../../backend/src/foo.js';",
        mustFire: true,
        note: 'export-from relative escape',
      },
      {
        line: "const x = import('../../../backend/src/foo.js');",
        mustFire: true,
        note: 'dynamic-import relative escape',
      },
      {
        line: "const x = require('../../../backend/src/foo.js');",
        mustFire: true,
        note: 'require relative escape',
      },
      // The OLD regex matched this one (depth 2); the new logic must
      // continue to catch it via path resolution.
      {
        line: "import x from '../../backend/src/foo.js';",
        mustFire: false,
        note: 'depth-2 escape FROM src/daemon/ resolves to repo root, NOT into backend',
      },
    ];
    for (const { line, mustFire, note } of samples) {
      const specs = specifiersOf(line);
      const fired = specs.some(spec => RULES.some(rule => rule.test(spec, fromFile)));
      expect(fired, `${note}: ${JSON.stringify(line)}`).toBe(mustFire);
    }

    // Top-level `src/index.ts` is shallower — `../../backend/...`
    // DOES land in packages/backend from there. Same line, different
    // fromFile, opposite outcome. This is exactly why we resolve
    // against the importing file's dirname instead of pattern-matching
    // the literal string.
    const topLevelFromFile = resolve(HOST_ROOT, 'src/index.ts');
    {
      const fired = specifiersOf("import x from '../../backend/src/foo.js';").some(
        spec => RULES.some(rule => rule.test(spec, topLevelFromFile)),
      );
      expect(
        fired,
        'depth-2 escape FROM src/index.ts SHOULD fire because ../../backend lands in packages/backend',
      ).toBe(true);
    }
  });

  it('scanner self-test: allowed imports do NOT fire any rule', () => {
    const fromFile = resolve(HOST_ROOT, 'src/daemon/whatever.ts');
    const allowed = [
      "import { z } from 'zod';",
      "import type { RuntimeKind } from '@silverhand/shared';",
      "import { foo } from '@silverhand/shared/driver';",
      "import { foo } from './drivers/index.js';", // intra-host
      "import { bar } from '../client/index.js';", // intra-host parent
      "import { baz } from '../../src/protocol.js';", // intra-host across src
      "import 'node:fs';", // node builtin (irrelevant to rules)
      "const fs = require('node:fs');",
    ];
    for (const line of allowed) {
      const specs = specifiersOf(line);
      const fired = specs.some(spec => RULES.some(rule => rule.test(spec, fromFile)));
      expect(fired, `rule should NOT fire for allowed ${JSON.stringify(line)}`).toBe(false);
    }
  });

  it('daemon bundle does not pull backend-only shared DB migrations', async () => {
    const result = await build({
      absWorkingDir: HOST_ROOT,
      entryPoints: ['src/daemon/entry.ts'],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      outfile: 'daemon.js',
      write: false,
      minify: true,
      metafile: true,
      logLevel: 'silent',
      banner: {
        js: 'import{createRequire}from"node:module";const require=createRequire(import.meta.url);',
      },
    });

    const inputs = Object.keys(result.metafile.inputs).map(p =>
      p.split(sep).join('/'),
    );
    const forbidden = inputs.filter(
      p =>
        p.endsWith('/packages/shared/src/db/baseline-schema.ts') ||
        p.endsWith('/packages/shared/src/db/migrations.ts') ||
        p.endsWith('../shared/src/db/baseline-schema.ts') ||
        p.endsWith('../shared/src/db/migrations.ts'),
    );
    expect(forbidden).toEqual([]);

    const bundleText = result.outputFiles[0]?.text ?? '';
    expect(bundleText).not.toContain('CREATE TABLE hosts (');
    expect(bundleText).not.toContain('host_credentials');
  });

  it('CLI bundle does not pull backend packages, sqlite, or backend-only shared DB migrations', async () => {
    const result = await build({
      absWorkingDir: CLI_ROOT,
      entryPoints: ['src/cli.ts'],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      outfile: 'cli.js',
      write: false,
      minify: true,
      metafile: true,
      logLevel: 'silent',
      banner: {
        js: 'import{createRequire}from"node:module";const require=createRequire(import.meta.url);',
      },
    });

    const inputs = Object.keys(result.metafile.inputs).map(p =>
      p.split(sep).join('/'),
    );
    const forbidden = inputs.filter(
      p =>
        p.includes('/packages/backend/') ||
        p.includes('/node_modules/better-sqlite3/') ||
        p.endsWith('/packages/shared/src/db/baseline-schema.ts') ||
        p.endsWith('/packages/shared/src/db/migrations.ts') ||
        p.endsWith('../shared/src/db/baseline-schema.ts') ||
        p.endsWith('../shared/src/db/migrations.ts'),
    );
    expect(forbidden).toEqual([]);

    const bundleText = result.outputFiles[0]?.text ?? '';
    expect(bundleText).not.toContain('CREATE TABLE hosts (');
    expect(bundleText).not.toContain('host_credentials');
  });
});
