/**
 * Gate 5 — auth port/concrete boundary (#task:1978 proof slice).
 *
 * Two-sided contract (ruled in review; a blanket "no driver types in repo
 * exports" ban would only breed empty factories):
 *  - the application-facing port module's RELATIVE IMPORT CLOSURE is
 *    driver-free (recursive, not one hop), so `Database as Db`, forwarding
 *    modules, or a multi-hop re-export chain cannot launder driver types onto
 *    the port surface;
 *  - application/service code depends on ports, never on the concrete SQLite
 *    implementations; concretes are imported only by an EXACT file allowlist
 *    (composition roots + the persistence composition module), never by a
 *    directory-level waiver.
 *
 * Both rules are implemented as pure functions over a file map and the
 * self-tests drive THOSE functions with synthetic trees, so what is proven to
 * redden is the production gate itself, not a lower-level scanner.
 */
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import {
  moduleReferencesOf,
  parse,
  scanBetterSqliteImports,
  type SourceEntry,
} from './scan.js';
import { allProductionSources, REPO_ROOT } from './sources.js';

const PORT_MODULES = ['packages/backend/src/auth/ports.ts'];

/**
 * EXACT files allowed to import the concrete auth persistence. No directory
 * waivers: another repo file importing a concrete is a boundary violation.
 */
const AUTH_CONCRETE_IMPORTERS = new Set([
  'packages/backend/src/index.ts',
  'packages/backend/src/admin.ts',
  'packages/backend/src/routes.ts',
  // the persistence composition module itself wires the concrete repos
  'packages/backend/src/repos/auth-uow.ts',
]);

const CONCRETE_AUTH_FILES = new Set([
  'packages/backend/src/repos/auth-credentials-repo.ts',
  'packages/backend/src/repos/auth-sessions-repo.ts',
  'packages/backend/src/repos/auth-uow.ts',
]);

type ReadSource = (repoRelativePath: string) => string | null;

interface LocalReference {
  spec: string | null;
  form: string;
}

/** All module references of a file, from the single authority in scan.ts. */
function localReferencesOf(entry: SourceEntry): LocalReference[] {
  return moduleReferencesOf(parse(entry)).map(r => ({ spec: r.spec, form: r.form }));
}

function resolveRelative(fromFile: string, spec: string): string {
  const fromDir = fromFile.split('/').slice(0, -1).join('/');
  const raw = spec.endsWith('.ts') ? spec : spec.replace(/\.js$/, '') + '.ts';
  const parts = (fromDir + '/' + raw).split('/');
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === '.' || part === '') continue;
    if (part === '..') resolved.pop();
    else resolved.push(part);
  }
  return resolved.join('/');
}

/**
 * Production gate rule 1: the port file and its full relative import/re-export
 * closure never name better-sqlite3, in any binding form.
 */
export function portClosureDriverViolations(
  portFile: string,
  readSource: ReadSource,
): string[] {
  const problems: string[] = [];
  const visited = new Set<string>();
  const queue = [portFile];
  while (queue.length > 0) {
    const file = queue.pop();
    if (!file || visited.has(file)) continue;
    visited.add(file);
    const src = readSource(file);
    if (src === null) {
      problems.push(`${portFile}: unresolvable module in port closure: ${file}`);
      continue;
    }
    const entry: SourceEntry = { path: file, src };
    if (scanBetterSqliteImports(entry).length > 0) {
      problems.push(
        file === portFile
          ? `${portFile}: names better-sqlite3 directly`
          : `${portFile}: reaches better-sqlite3 through ${file} — driver types must not reach the port surface through any hop`,
      );
      continue;
    }
    for (const ref of localReferencesOf(entry)) {
      if (ref.spec === null) {
        // an unresolvable reference is NOT "no reference" — fail loud
        problems.push(`${portFile}: statically unresolvable ${ref.form} in port closure member ${file}`);
        continue;
      }
      if (ref.spec.startsWith('.')) queue.push(resolveRelative(file, ref.spec));
    }
  }
  return problems;
}

/**
 * Production gate rule 2: only the exact allowlist may import concrete auth
 * persistence modules.
 */
export function concreteImportViolations(
  sources: SourceEntry[],
  allowlist: ReadonlySet<string>,
): string[] {
  const offenders: string[] = [];
  for (const entry of sources) {
    if (!entry.path.startsWith('packages/backend/src')) continue;
    if (allowlist.has(entry.path)) continue;
    for (const ref of localReferencesOf(entry)) {
      if (ref.spec === null) {
        // production has no dynamic-expression imports today; a new one is a
        // boundary decision, not something to skip silently
        offenders.push(`${entry.path} has a statically unresolvable ${ref.form} — fail loud`);
        continue;
      }
      if (!ref.spec.startsWith('.')) continue;
      // match on the RESOLVED target path, not the raw specifier — a
      // same-directory `./auth-uow.js` import must be caught too
      if (CONCRETE_AUTH_FILES.has(resolveRelative(entry.path, ref.spec))) {
        offenders.push(`${entry.path} imports ${ref.spec}`);
      }
    }
  }
  return offenders;
}

describe('db-boundary: auth port/concrete boundary', () => {
  const fsRead: ReadSource = file => {
    try {
      return readFileSync(join(REPO_ROOT, file), 'utf8');
    } catch {
      return null;
    }
  };

  it('port modules are driver-free across their whole relative import closure', () => {
    expect(PORT_MODULES.flatMap(f => portClosureDriverViolations(f, fsRead))).toEqual([]);
  });

  it('only the exact composition allowlist imports the concrete auth persistence', () => {
    expect(
      concreteImportViolations(allProductionSources(), AUTH_CONCRETE_IMPORTERS),
      'application/service code depends on auth ports, not concrete SQLite implementations; ' +
        'only the named composition files may wire concretes',
    ).toEqual([]);
  });

  it('module-reference authority: table-driven coverage of every reference form', () => {
    const table: Array<{ src: string; form: string; spec: string | null }> = [
      { src: "import { X } from './a.js';", form: 'static-import', spec: './a.js' },
      { src: "export { X } from './a.js';", form: 'static-export', spec: './a.js' },
      { src: "import Uow = require('./a.js');", form: 'import-equals', spec: './a.js' },
      { src: "type H = import('./a.js').H;", form: 'import-type', spec: './a.js' },
      { src: "const m = await import('./a.js');", form: 'dynamic-import', spec: './a.js' },
      { src: "const m = require('./a.js');", form: 'require', spec: './a.js' },
      { src: 'const m = await import(pathVar);', form: 'dynamic-import', spec: null },
      { src: 'const m = require(pathVar);', form: 'require', spec: null },
    ];
    for (const row of table) {
      const refs = localReferencesOf({ path: 'probe.ts', src: row.src });
      expect(refs, `not enumerated: ${row.src}`).toEqual([{ form: row.form, spec: row.spec }]);
    }
  });

  it('gate self-test: import-equals and unresolvable references redden THROUGH the production gates', () => {
    // import = require of a concrete, from a non-allowlisted file
    const equalsOffenders = concreteImportViolations(
      [
        {
          path: 'packages/backend/src/services/equals-sneak.ts',
          src: "import Uow = require('../repos/auth-uow.js');",
        },
      ],
      AUTH_CONCRETE_IMPORTERS,
    );
    expect(equalsOffenders).toEqual([
      'packages/backend/src/services/equals-sneak.ts imports ../repos/auth-uow.js',
    ]);

    // statically unresolvable dynamic reference is fail-loud, not "no reference"
    const unresolvedOffenders = concreteImportViolations(
      [
        {
          path: 'packages/backend/src/services/opaque-sneak.ts',
          src: 'const m = await import(pickModule());',
        },
      ],
      AUTH_CONCRETE_IMPORTERS,
    );
    expect(unresolvedOffenders).toHaveLength(1);
    expect(unresolvedOffenders[0]).toMatch(/statically unresolvable dynamic-import — fail loud/);

    // port closure: import-equals laundering hop is followed; unresolvable member fails loud
    const equalsTree = new Map<string, string>([
      ['pkg/ports.ts', "import Hop = require('./hop.js');\nexport type H = typeof Hop;"],
      ['pkg/hop.ts', "export type { Database as H } from 'better-sqlite3';"],
    ]);
    expect(
      portClosureDriverViolations('pkg/ports.ts', f => equalsTree.get(f) ?? null),
    ).toHaveLength(1);
    expect(
      portClosureDriverViolations('p.ts', f =>
        f === 'p.ts' ? 'const m = await import(pickModule());' : null,
      )[0],
    ).toMatch(/statically unresolvable dynamic-import/);
  });

  it('gate self-test: multi-hop re-export laundering reddens THROUGH the production gate', () => {
    const tree = new Map<string, string>([
      ['pkg/ports.ts', "import type { Handle } from './hop1.js';\nexport interface P { get(id: string): Handle }"],
      ['pkg/hop1.ts', "export type { Handle } from './hop2.js';"],
      ['pkg/hop2.ts', "export type { Database as Handle } from 'better-sqlite3';"],
    ]);
    const read: ReadSource = f => tree.get(f) ?? null;
    const problems = portClosureDriverViolations('pkg/ports.ts', read);
    expect(problems.length).toBe(1);
    expect(problems[0]).toMatch(/reaches better-sqlite3 through pkg\/hop2\.ts/);

    // direct naming and aliased type import redden too
    expect(
      portClosureDriverViolations('p.ts', f =>
        f === 'p.ts' ? "import type { Database as Db } from 'better-sqlite3';" : null,
      ),
    ).toHaveLength(1);

    // inline `import('./hop1.js').T` TYPE reference launders through the
    // closure too — the visitor must feed it into the queue
    const typeRefTree = new Map<string, string>([
      ['pkg/ports.ts', "export type Handle = import('./hop1.js').Handle;"],
      ['pkg/hop1.ts', "export type { Handle } from './hop2.js';"],
      ['pkg/hop2.ts', "export type { Database as Handle } from 'better-sqlite3';"],
    ]);
    const typeRefProblems = portClosureDriverViolations('pkg/ports.ts', f => typeRefTree.get(f) ?? null);
    expect(typeRefProblems.length).toBe(1);
    expect(typeRefProblems[0]).toMatch(/reaches better-sqlite3 through pkg\/hop2\.ts/);

    // clean multi-hop closure stays green
    const clean = new Map<string, string>([
      ['pkg/ports.ts', "import type { Row } from './types.js';\nexport interface P { get(id: string): Row }"],
      ['pkg/types.ts', 'export interface Row { id: string }'],
    ]);
    expect(portClosureDriverViolations('pkg/ports.ts', f => clean.get(f) ?? null)).toEqual([]);

    // unresolvable closure members fail loud instead of being skipped
    expect(
      portClosureDriverViolations('pkg/ports.ts', f =>
        f === 'pkg/ports.ts' ? "import type { X } from './missing.js';" : null,
      ),
    ).toHaveLength(1);
  });

  it('gate self-test: a NON-allowlisted repos file importing a concrete reddens THROUGH the production gate', () => {
    const synthetic: SourceEntry[] = [
      {
        path: 'packages/backend/src/repos/some-other-repo.ts',
        src: "import { SqliteAuthCredentialsRepo } from './auth-credentials-repo.js';",
      },
      {
        path: 'packages/backend/src/services/sneaky-service.ts',
        src: "import { createSqliteAuthUnitOfWork } from '../repos/auth-uow.js';",
      },
      {
        path: 'packages/backend/src/index.ts',
        src: "import { createSqliteAuthUnitOfWork } from './repos/auth-uow.js';",
      },
    ];
    const offenders = concreteImportViolations(synthetic, AUTH_CONCRETE_IMPORTERS);
    expect(offenders).toEqual([
      "packages/backend/src/repos/some-other-repo.ts imports ./auth-credentials-repo.js",
      "packages/backend/src/services/sneaky-service.ts imports ../repos/auth-uow.js",
    ]);

    // dynamic import / require of a concrete cannot dodge the allowlist either
    const dynamicOffenders = concreteImportViolations(
      [
        {
          path: 'packages/backend/src/services/dynamic-sneak.ts',
          src: "const m = await import('../repos/auth-uow.js');",
        },
        {
          path: 'packages/backend/src/services/require-sneak.ts',
          src: "const { SqliteAuthSessionsRepo } = require('../repos/auth-sessions-repo.js');",
        },
      ],
      AUTH_CONCRETE_IMPORTERS,
    );
    expect(dynamicOffenders).toHaveLength(2);
  });
});
