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
import ts from 'typescript';
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
    test: (spec) => spec === '@silverhand/backend' || spec.startsWith('@silverhand/backend/'),
  },
  {
    name: 'forbidden package import: @silverhand/cli',
    test: (spec) => spec === '@silverhand/cli' || spec.startsWith('@silverhand/cli/'),
  },
  {
    name: 'forbidden package import: better-sqlite3',
    test: (spec) => spec === 'better-sqlite3' || spec.startsWith('better-sqlite3/'),
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
      return FORBIDDEN_PACKAGE_ROOTS.some((root) => {
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
    test: (spec) => spec === '@silverhand/backend' || spec.startsWith('@silverhand/backend/'),
  },
  {
    name: 'forbidden CLI package import: better-sqlite3',
    test: (spec) => spec === 'better-sqlite3' || spec.startsWith('better-sqlite3/'),
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
      return forbiddenRoots.some((root) => {
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

/** Parse real import syntax, not text inside comments or string fixtures. */
function scanSource(source: string, file: string, rules: Rule[]): ForbiddenHit[] {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const hits: ForbiddenHit[] = [];
  const lines = source.split('\n');
  function visit(node: ts.Node): void {
    let specifier: ts.Node | undefined;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      specifier = node.moduleSpecifier;
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      specifier = node.moduleReference.expression;
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      specifier = node.argument.literal;
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      specifier = node.arguments[0];
    }
    if (specifier && ts.isStringLiteralLike(specifier)) {
      const line = ast.getLineAndCharacterOfPosition(specifier.getStart(ast)).line;
      for (const rule of rules) {
        if (rule.test(specifier.text, file)) {
          hits.push({
            file: relative(REPO_ROOT, file).split(sep).join('/'),
            line: line + 1,
            text: (lines[line] ?? '').trim(),
            matchedRule: rule.name,
            specifier: specifier.text,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return hits;
}

function scanForViolations(scanRoots: string[], rules: Rule[] = RULES): ForbiddenHit[] {
  return scanRoots.flatMap((root) =>
    [...walkTsFiles(root)].flatMap((file) => scanSource(readFileSync(file, 'utf8'), file, rules)),
  );
}

describe('host package dependency guard (Cindy `vqDWkLFF6pAeIE5t` + `ecQq2DydBJGZUZ35`)', () => {
  it('no file in packages/host/{src,tests} imports backend/cli/sqlite/escape-relative', () => {
    const scanRoots = [join(HOST_ROOT, 'src'), join(HOST_ROOT, 'tests')];
    const hits = scanForViolations(scanRoots);
    if (hits.length > 0) {
      const formatted = hits
        .map(
          (h) =>
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
          (h) =>
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

  it.each([
    "import x from '@silverhand/backend';",
    "import * as x from '@silverhand/backend';",
    "import { x } from '@silverhand/backend';",
    "import type { x } from '@silverhand/backend';",
    "import '@silverhand/backend';",
    "export { x } from '@silverhand/backend';",
    "export * from '@silverhand/backend';",
    "export type { x } from '@silverhand/backend';",
    "const x = import('@silverhand/backend');",
    "const x = require ( '@silverhand/backend' );",
    "import x = require('@silverhand/backend');",
    "type X = import('@silverhand/backend').X;",
    "import {\n x,\n y,\n} from '@silverhand/backend';",
    "export {\n x\n} from '@silverhand/backend';",
    "const url = 'https://example.test'; import '@silverhand/backend';",
  ])('source scanner detects forbidden import syntax: %s', (source) => {
    const file = resolve(HOST_ROOT, 'src/daemon/whatever.ts');
    expect(scanSource(source, file, RULES)).toEqual([
      {
        file: 'packages/host/src/daemon/whatever.ts',
        line: source.slice(0, source.indexOf('@silverhand/backend')).split('\n').length,
        text: source.split('\n').at(-1)!.trim(),
        matchedRule: 'forbidden package import: @silverhand/backend',
        specifier: '@silverhand/backend',
      },
    ]);
  });

  it.each([
    ['src/daemon/whatever.ts', "import x from '../../../backend/src/context.js';", true],
    ['src/daemon/whatever.ts', "export * from '../../../backend/src/foo.js';", true],
    ['src/daemon/whatever.ts', "const x = import('../../../backend/src/foo.js');", true],
    ['src/daemon/whatever.ts', "const x = require('../../../backend/src/foo.js');", true],
    ['src/daemon/whatever.ts', "import x from '../../backend/src/foo.js';", false],
    ['src/index.ts', "import x from '../../backend/src/foo.js';", true],
    ['src/index.ts', "import 'better-sqlite3';", true],
    ['src/index.ts', "import x from '@silverhand/cli';", true],
    ['src/index.ts', "import x from '@silverhand/backend/services/foo.js';", true],
    ['src/index.ts', "import { z } from 'zod';", false],
    ['src/index.ts', "import type { RuntimeKind } from '@silverhand/shared';", false],
    ['src/index.ts', "import { foo } from '@silverhand/shared/driver';", false],
    ['src/index.ts', "import { foo } from './drivers/index.js';", false],
    ['src/daemon/whatever.ts', "import { bar } from '../client/index.js';", false],
    ['tests/foo.ts', "import { baz } from '../src/protocol.js';", false],
    ['src/index.ts', "import 'node:fs'; const fs = require('node:fs');", false],
    ['src/index.ts', "// import '@silverhand/backend';\n/* require('better-sqlite3') */", false],
    ['tests/foo.ts', `const fixture = "import '@silverhand/backend';";`, false],
  ] as const)('applies architecture rules from %s: %s', (file, source, forbidden) => {
    expect(scanSource(source, resolve(HOST_ROOT, file), RULES).length).toBe(forbidden ? 1 : 0);
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

    const inputs = Object.keys(result.metafile.inputs).map((p) => p.split(sep).join('/'));
    const forbidden = inputs.filter(
      (p) =>
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

    const inputs = Object.keys(result.metafile.inputs).map((p) => p.split(sep).join('/'));
    const forbidden = inputs.filter(
      (p) =>
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
