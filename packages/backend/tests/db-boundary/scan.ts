/**
 * Static analysis library for the DB boundary gates (docs/db-boundary.md).
 *
 * Pure functions over TypeScript ASTs; no vitest imports. The gate tests in
 * this directory feed it production sources and compare the findings against
 * the named ledgers in inventory.ts.
 *
 * Honest coverage statement: everything here is single-file syntactic
 * analysis (plus one static hop for same-file consts and relative named
 * imports of SQL constants). It sees direct syntax, not runtime dataflow —
 * the gates document what that does and does not prove.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

export interface SourceEntry {
  /** Repo-relative POSIX path, e.g. `packages/backend/src/db.ts`. */
  path: string;
  src: string;
}

export function walkTsSources(
  rootAbs: string,
  repoRootAbs: string,
  opts: { includeTests: boolean },
): SourceEntry[] {
  const out: SourceEntry[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name === 'node_modules' || name === 'dist') continue;
        walk(full);
        continue;
      }
      if (!name.endsWith('.ts') || name.endsWith('.d.ts')) continue;
      if (!opts.includeTests && name.endsWith('.test.ts')) continue;
      out.push({
        path: relative(repoRootAbs, full).split('\\').join('/'),
        src: readFileSync(full, 'utf8'),
      });
    }
  };
  walk(rootAbs);
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

export function parse(entry: SourceEntry): ts.SourceFile {
  return ts.createSourceFile(entry.path, entry.src, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
}

/** Nearest enclosing named function/method for inventory keying. */
export function enclosingFunctionName(node: ts.Node): string {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (ts.isFunctionDeclaration(cur) && cur.name) return cur.name.text;
    if (ts.isMethodDeclaration(cur) || ts.isGetAccessor(cur) || ts.isSetAccessor(cur)) {
      const method = ts.isIdentifier(cur.name) || ts.isStringLiteral(cur.name) ? cur.name.text : '<computed>';
      const cls = cur.parent && (ts.isClassDeclaration(cur.parent) || ts.isClassExpression(cur.parent)) && cur.parent.name
        ? cur.parent.name.text
        : undefined;
      return cls ? `${cls}.${method}` : method;
    }
    if (ts.isConstructorDeclaration(cur)) {
      const cls = cur.parent && ts.isClassDeclaration(cur.parent) && cur.parent.name ? cur.parent.name.text : '';
      return cls ? `${cls}.constructor` : 'constructor';
    }
    if ((ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) && cur.parent) {
      if (ts.isVariableDeclaration(cur.parent) && ts.isIdentifier(cur.parent.name)) return cur.parent.name.text;
      if (ts.isPropertyAssignment(cur.parent) && ts.isIdentifier(cur.parent.name)) return cur.parent.name.text;
      if (ts.isPropertyDeclaration(cur.parent) && ts.isIdentifier(cur.parent.name)) return cur.parent.name.text;
    }
    cur = cur.parent;
  }
  return '<module>';
}

// ---------------------------------------------------------------------------
// Module-reference enumeration (single authority)
// ---------------------------------------------------------------------------

export type ModuleReferenceForm =
  | 'static-import'
  | 'static-export'
  | 'import-equals'
  | 'import-type'
  | 'dynamic-import'
  | 'require';

export interface ModuleReference {
  form: ModuleReferenceForm;
  /** Module specifier text, or null when the argument is not a string
   *  literal (dynamic expression) — consumers must FAIL LOUD on null for
   *  boundary decisions, never treat it as "no reference". */
  spec: string | null;
  node: ts.Node;
}

/**
 * Every module reference a TypeScript file can make, in one enumeration:
 * static import/export declarations, `import x = require(...)`, inline
 * `import('x').T` type references, dynamic `import()`, and `require()`.
 * The better-sqlite3 import scanner and the boundary gates all consume THIS
 * list, so a new reference form only ever needs to be added here.
 */
export function moduleReferencesOf(sf: ts.SourceFile): ModuleReference[] {
  const refs: ModuleReference[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const spec = node.moduleSpecifier;
      if (spec && ts.isStringLiteral(spec)) {
        refs.push({
          form: ts.isImportDeclaration(node) ? 'static-import' : 'static-export',
          spec: spec.text,
          node,
        });
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      const ref = node.moduleReference;
      if (ts.isExternalModuleReference(ref)) {
        const expr = ref.expression;
        refs.push({
          form: 'import-equals',
          spec: expr && ts.isStringLiteralLike(expr) ? expr.text : null,
          node,
        });
      }
    } else if (ts.isImportTypeNode(node)) {
      const arg = node.argument;
      refs.push({
        form: 'import-type',
        spec:
          ts.isLiteralTypeNode(arg) && ts.isStringLiteral(arg.literal)
            ? arg.literal.text
            : null,
        node,
      });
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire =
        ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if (isDynamicImport || isRequire) {
        const arg = node.arguments[0];
        refs.push({
          form: isDynamicImport ? 'dynamic-import' : 'require',
          spec: arg && ts.isStringLiteralLike(arg) ? arg.text : null,
          node,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return refs;
}

// ---------------------------------------------------------------------------
// better-sqlite3 import scan
// ---------------------------------------------------------------------------

export type ImportKind = 'value' | 'type';

export interface ImportFinding {
  file: string;
  kind: ImportKind;
  form: string;
}

const BETTER_SQLITE3 = 'better-sqlite3';

export function scanBetterSqliteImports(entry: SourceEntry): ImportFinding[] {
  const sf = parse(entry);
  const findings: ImportFinding[] = [];
  for (const ref of moduleReferencesOf(sf)) {
    if (ref.spec !== BETTER_SQLITE3) continue;
    switch (ref.form) {
      case 'static-import': {
        const node = ref.node as ts.ImportDeclaration;
        const clause = node.importClause;
        if (!clause) {
          findings.push({ file: entry.path, kind: 'value', form: 'bare import (side effect)' });
          break;
        }
        const wholeClauseTypeOnly = clause.isTypeOnly;
        if (clause.name) {
          findings.push({
            file: entry.path,
            kind: wholeClauseTypeOnly ? 'type' : 'value',
            form: `default import ${clause.name.text}`,
          });
        }
        const bindings = clause.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) {
          findings.push({
            file: entry.path,
            kind: wholeClauseTypeOnly ? 'type' : 'value',
            form: `namespace import ${bindings.name.text}`,
          });
        }
        if (bindings && ts.isNamedImports(bindings)) {
          for (const el of bindings.elements) {
            findings.push({
              file: entry.path,
              kind: wholeClauseTypeOnly || el.isTypeOnly ? 'type' : 'value',
              form: `named import ${(el.propertyName ?? el.name).text}`,
            });
          }
        }
        break;
      }
      case 'static-export': {
        const node = ref.node as ts.ExportDeclaration;
        findings.push({
          file: entry.path,
          kind: node.isTypeOnly ? 'type' : 'value',
          form: 're-export from better-sqlite3',
        });
        break;
      }
      case 'import-equals':
        findings.push({ file: entry.path, kind: 'value', form: 'import = require' });
        break;
      case 'import-type':
        findings.push({ file: entry.path, kind: 'type', form: 'inline import type' });
        break;
      case 'dynamic-import':
        findings.push({ file: entry.path, kind: 'value', form: 'dynamic import' });
        break;
      case 'require':
        findings.push({ file: entry.path, kind: 'value', form: 'require call' });
        break;
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// SQL corpus extraction
// ---------------------------------------------------------------------------

export type SqlSink = 'prepare' | 'prepareObserved' | 'exec' | 'pragma' | 'schema-module';

export interface SqlOccurrence {
  file: string;
  fn: string;
  sink: SqlSink | 'literal';
  /** Literal SQL text; `${...}` substitutions appear as `«expr»` markers. */
  sql: string;
  /** SQL-shaped literals get the full hazard rule set; others a safe subset. */
  sqlShaped: boolean;
}

export interface SinkCall {
  file: string;
  fn: string;
  sink: Exclude<SqlSink, 'schema-module'>;
}

export interface DynamicSqlOccurrence {
  file: string;
  fn: string;
  sink: Exclude<SqlSink, 'schema-module'>;
  exprKind: string;
}

export interface SqlSinkScan {
  calls: SinkCall[];
  dynamic: DynamicSqlOccurrence[];
  /** One synthetic `PRAGMA` occurrence per `.pragma()` call (API form has no PRAGMA keyword in text). */
  pragmaOccurrences: SqlOccurrence[];
}

const SQL_SHAPE = /^\s*(--|\/\*|WITH|SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|PRAGMA|VACUUM|ANALYZE|REINDEX|ATTACH|DETACH|EXPLAIN)\b/i;

function templateText(node: ts.TemplateExpression): string {
  let text = node.head.text;
  for (const span of node.templateSpans) {
    text += `«expr»${span.literal.text}`;
  }
  return text;
}

function staticStringOf(node: ts.Expression): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return templateText(node);
  if (ts.isParenthesizedExpression(node)) return staticStringOf(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticStringOf(node.left);
    const right = staticStringOf(node.right);
    if (left !== null && right !== null) return left + right;
    return null;
  }
  return null;
}

/** Map of `const NAME = <static string>` declarations in a file. */
function staticConstMap(sf: ts.SourceFile): Map<string, string> {
  const map = new Map<string, string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isVariableDeclarationList(node.parent) &&
      (node.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      const text = staticStringOf(node.initializer);
      if (text !== null) map.set(node.name.text, text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return map;
}

/** Named imports from relative modules: local name -> { module, exported }. */
function relativeNamedImports(sf: ts.SourceFile): Map<string, { module: string; exported: string }> {
  const map = new Map<string, { module: string; exported: string }>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const spec = stmt.moduleSpecifier;
    if (!ts.isStringLiteral(spec) || !spec.text.startsWith('.')) continue;
    const bindings = stmt.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const el of bindings.elements) {
      map.set(el.name.text, { module: spec.text, exported: (el.propertyName ?? el.name).text });
    }
  }
  return map;
}

/** Named imports from ANY module: local name -> imported name (alias-insensitive lookups). */
function allNamedImports(sf: ts.SourceFile): Map<string, string> {
  const map = new Map<string, string>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const bindings = stmt.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const el of bindings.elements) {
      map.set(el.name.text, (el.propertyName ?? el.name).text);
    }
  }
  return map;
}

export interface CorpusResolver {
  /** Resolve `import { name } from './x.js'` in `fromFile` to a static string, if possible. */
  resolveImportedConst(fromFile: string, module: string, exportedName: string): string | null;
}

/** Build a cross-file resolver over a walked source set (single hop, named exports only). */
export function buildCorpusResolver(entries: SourceEntry[]): CorpusResolver {
  const byPath = new Map(entries.map(e => [e.path, e]));
  const constCache = new Map<string, Map<string, string>>();
  const exportedConsts = (path: string): Map<string, string> | null => {
    const cached = constCache.get(path);
    if (cached) return cached;
    const entry = byPath.get(path);
    if (!entry) return null;
    const map = staticConstMap(parse(entry));
    constCache.set(path, map);
    return map;
  };
  return {
    resolveImportedConst(fromFile, module, exportedName) {
      const fromDir = fromFile.split('/').slice(0, -1).join('/');
      const raw = module.replace(/\.js$/, '.ts');
      const parts = (fromDir + '/' + raw).split('/');
      const resolved: string[] = [];
      for (const part of parts) {
        if (part === '.' || part === '') continue;
        if (part === '..') resolved.pop();
        else resolved.push(part);
      }
      const path = resolved.join('/');
      const map = exportedConsts(path.endsWith('.ts') ? path : `${path}.ts`);
      return map?.get(exportedName) ?? null;
    },
  };
}

export function scanSqlSinks(entry: SourceEntry, resolver?: CorpusResolver): SqlSinkScan {
  const sf = parse(entry);
  const consts = staticConstMap(sf);
  const imports = relativeNamedImports(sf);
  const importedNames = allNamedImports(sf);
  const calls: SinkCall[] = [];
  const dynamic: DynamicSqlOccurrence[] = [];
  const pragmaOccurrences: SqlOccurrence[] = [];

  const resolveArg = (arg: ts.Expression): string | null => {
    const direct = staticStringOf(arg);
    if (direct !== null) return direct;
    if (ts.isIdentifier(arg)) {
      const local = consts.get(arg.text);
      if (local !== undefined) return local;
      const imp = imports.get(arg.text);
      if (imp && resolver) return resolver.resolveImportedConst(entry.path, imp.module, imp.exported);
      return null;
    }
    return null;
  };

  const record = (sink: Exclude<SqlSink, 'schema-module'>, node: ts.CallExpression, arg: ts.Expression | undefined): void => {
    if (!arg) return;
    const fn = enclosingFunctionName(node);
    calls.push({ file: entry.path, fn, sink });
    if (resolveArg(arg) === null) {
      dynamic.push({ file: entry.path, fn, sink, exprKind: ts.SyntaxKind[arg.kind] });
    }
    if (sink === 'pragma') {
      // API-form pragma carries no PRAGMA keyword in any literal; synthesize
      // one occurrence so the hazard ledger still counts it.
      const text = resolveArg(arg);
      pragmaOccurrences.push({
        file: entry.path,
        fn,
        sink: 'pragma',
        sql: `PRAGMA ${text ?? '«dynamic»'}`,
        sqlShaped: true,
      });
    }
  };

  /** Alias-insensitive: the local name maps back to `prepareObserved`, or is the bare name itself. */
  const isPrepareObservedIdentifier = (id: ts.Identifier): boolean =>
    (importedNames.get(id.text) ?? id.text) === 'prepareObserved';

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && isPrepareObservedIdentifier(node.expression)) {
        record('prepareObserved', node, node.arguments[2]);
      } else if (ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        const receiver = node.expression.expression;
        if (method === 'prepareObserved') {
          // namespace / object-forwarded form: obs.prepareObserved(db, name, sql)
          record('prepareObserved', node, node.arguments[2]);
        } else if (method === 'prepare') {
          record('prepare', node, node.arguments[0]);
        } else if (method === 'pragma') {
          record('pragma', node, node.arguments[0]);
        } else if (method === 'exec') {
          // `.exec` is ambiguous (RegExp.exec, child_process.exec), but any
          // exemption must be a PROOF, not a heuristic: a SQL-verb allowlist
          // bets on its own completeness (REPLACE/END/VALUES are legal SQLite
          // top-level statements), and a file-level "regex const" set has no
          // lexical scoping (an inner `const runner = db` shadows it). The
          // only receiver we can prove without real binding resolution is a
          // direct regex literal — everything else is a sink, and
          // unresolvable arguments go loudly into the dynamic ledger.
          if (!ts.isRegularExpressionLiteral(receiver) && node.arguments[0]) {
            record('exec', node, node.arguments[0]);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { calls, dynamic, pragmaOccurrences };
}

/**
 * Harvest every string/template literal of a file as hazard corpus, attributed
 * to its definition site. This deliberately over-approximates: SQL reaches
 * sinks through consts, helper params, and cross-file exports, and attributing
 * at the definition keeps each text counted exactly once. Import/export module
 * specifiers are excluded as pure noise.
 */
export function harvestLiterals(entry: SourceEntry): SqlOccurrence[] {
  const sf = parse(entry);
  const occurrences: SqlOccurrence[] = [];
  const push = (node: ts.Node, text: string): void => {
    occurrences.push({
      file: entry.path,
      fn: enclosingFunctionName(node),
      sink: 'literal',
      sql: text,
      sqlShaped: SQL_SHAPE.test(text),
    });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      push(node, node.text);
      return;
    }
    if (ts.isTemplateExpression(node)) {
      push(node, templateText(node));
      // continue into substitution expressions; their own literals are
      // separate texts (the template's cooked parts exclude them)
      for (const span of node.templateSpans) visit(span.expression);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return occurrences;
}

// ---------------------------------------------------------------------------
// SQLite hazard rules
// ---------------------------------------------------------------------------

export interface HazardRule {
  id: string;
  /** What breaks on PostgreSQL, in one line. */
  description: string;
  pattern: RegExp;
  /**
   * fragmentSafe rules run on every string literal (SQL fragments hide in
   * plain strings); the rest only on SQL-shaped text, because their patterns
   * (bare `->`, the word `rowid`/`GLOB`, ...) misfire on prose.
   */
  fragmentSafe: boolean;
}

export const SQL_HAZARD_RULES: HazardRule[] = [
  {
    id: 'json1_function',
    description: 'SQLite JSON1 function; PostgreSQL uses jsonb functions/operators with different semantics',
    pattern: /\bjson_(?:extract|set|insert|replace|remove|patch|array_length|array|object|group_array|group_object|each|tree|valid|quote|type)\s*\(/gi,
    fragmentSafe: true,
  },
  {
    id: 'json1_arrow_operator',
    description: 'SQLite ->/->> JSON operators differ from PostgreSQL jsonb operator typing',
    pattern: /->>?/g,
    fragmentSafe: false,
  },
  {
    id: 'pragma_statement',
    description: 'PRAGMA is SQLite-only; PostgreSQL uses SET/system catalogs',
    pattern: /\bPRAGMA\b/gi,
    fragmentSafe: false,
  },
  {
    id: 'collate_nocase',
    description: 'COLLATE NOCASE is SQLite-only; PostgreSQL needs citext or lower() indexes',
    pattern: /\bCOLLATE\s+NOCASE\b/gi,
    fragmentSafe: true,
  },
  {
    id: 'insert_or_action',
    description: 'INSERT OR IGNORE/REPLACE/... is SQLite syntax; PostgreSQL uses ON CONFLICT clauses',
    pattern: /\b(?:INSERT|UPDATE)\s+OR\s+(?:IGNORE|REPLACE|ABORT|FAIL|ROLLBACK)\b/gi,
    fragmentSafe: true,
  },
  {
    id: 'is_parameter',
    description: 'IS against a bind parameter (null-safe equality) is SQLite behavior; PostgreSQL needs IS NOT DISTINCT FROM',
    pattern: /\bIS\s+(?:NOT\s+)?(?:\?|[:@$]\w+)/gi,
    fragmentSafe: true,
  },
  {
    id: 'begin_immediate_exclusive',
    description: 'BEGIN IMMEDIATE/EXCLUSIVE lock escalation is SQLite-specific',
    pattern: /\bBEGIN\s+(?:IMMEDIATE|EXCLUSIVE)\b/gi,
    fragmentSafe: false,
  },
  {
    id: 'create_trigger',
    description: 'SQLite trigger DDL; PostgreSQL triggers need procedural functions and differ in row semantics',
    pattern: /\bCREATE\s+TRIGGER\b/gi,
    fragmentSafe: true,
  },
  {
    id: 'raise_function',
    description: 'RAISE() inside triggers is SQLite-specific error signaling',
    pattern: /\bRAISE\s*\(/gi,
    fragmentSafe: true,
  },
  {
    id: 'sqlite_datetime_function',
    description: 'strftime/julianday/unixepoch/datetime are SQLite date functions',
    pattern: /\b(?:strftime|julianday|unixepoch|datetime)\s*\(/gi,
    fragmentSafe: true,
  },
  {
    id: 'autoincrement',
    description: 'AUTOINCREMENT is SQLite-only; PostgreSQL uses sequences/identity',
    pattern: /\bAUTOINCREMENT\b/gi,
    fragmentSafe: true,
  },
  {
    id: 'rowid_reference',
    description: 'rowid/last_insert_rowid coupling has no direct PostgreSQL equivalent',
    pattern: /\browid\b|\blast_insert_rowid\s*\(/gi,
    fragmentSafe: false,
  },
  {
    id: 'sqlite_catalog',
    description: 'sqlite_schema/sqlite_master catalog queries are engine-specific',
    pattern: /\bsqlite_(?:schema|master|sequence)\b/gi,
    fragmentSafe: true,
  },
  {
    id: 'glob_operator',
    description: 'GLOB operator is SQLite-only',
    pattern: /\bGLOB\b/g,
    fragmentSafe: false,
  },
  {
    id: 'without_rowid',
    description: 'WITHOUT ROWID storage clause is SQLite-only',
    pattern: /\bWITHOUT\s+ROWID\b/gi,
    fragmentSafe: true,
  },
];

export interface HazardFinding {
  file: string;
  hazard: string;
  count: number;
}

export function scanSqlHazards(corpus: SqlOccurrence[]): HazardFinding[] {
  const counts = new Map<string, number>();
  for (const occ of corpus) {
    for (const rule of SQL_HAZARD_RULES) {
      if (!occ.sqlShaped && !rule.fragmentSafe) continue;
      rule.pattern.lastIndex = 0;
      const matches = occ.sql.match(rule.pattern);
      if (!matches || matches.length === 0) continue;
      const key = `${occ.file}\u0000${rule.id}`;
      counts.set(key, (counts.get(key) ?? 0) + matches.length);
    }
  }
  return [...counts.entries()]
    .map(([key, count]) => {
      const [file = '', hazard = ''] = key.split('\u0000');
      return { file, hazard, count };
    })
    .sort((a, b) => (a.file + a.hazard < b.file + b.hazard ? -1 : 1));
}

// ---------------------------------------------------------------------------
// better-sqlite3 API-surface hazards (member access/calls, not SQL text)
// ---------------------------------------------------------------------------

export interface ApiHazardFinding {
  file: string;
  fn: string;
  api: 'lastInsertRowid' | 'transaction_immediate' | 'transaction_exclusive' | 'transaction_deferred';
}

export function scanApiHazards(entry: SourceEntry): ApiHazardFinding[] {
  const sf = parse(entry);
  const findings: ApiHazardFinding[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'lastInsertRowid') {
      findings.push({ file: entry.path, fn: enclosingFunctionName(node), api: 'lastInsertRowid' });
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ['immediate', 'exclusive', 'deferred'].includes(node.expression.name.text)
    ) {
      findings.push({
        file: entry.path,
        fn: enclosingFunctionName(node),
        api: `transaction_${node.expression.name.text}` as ApiHazardFinding['api'],
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}

// ---------------------------------------------------------------------------
// Transaction boundary scan
// ---------------------------------------------------------------------------

export type TxMode = 'default' | 'immediate' | 'exclusive' | 'deferred' | 'stored' | 'uow';

export interface TxSiteFinding {
  file: string;
  fn: string;
  mode: TxMode;
}

export interface TxViolationFinding {
  file: string;
  fn: string;
  violation: string;
}

export interface TxScanResult {
  sites: TxSiteFinding[];
  violations: TxViolationFinding[];
}

/**
 * Names whose *direct* invocation inside a transaction callback is an
 * external effect escaping the atomic boundary. Matched on the called
 * identifier / property name. Post-commit closures (`effects.push(() =>
 * publish(...))`) are exempt because the call's nearest enclosing function
 * is the pushed arrow, not the transaction callback.
 */
const EFFECT_CALL_PATTERN = /^(?:publish|broadcast|dispatch|notify)/i;
const FORBIDDEN_GLOBALS = new Set(['fetch', 'setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask']);
const POST_COMMIT_DRAINS = new Set(['runPostCommitEffects', 'drainPostCommitEffects']);

function fsBoundNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const spec = stmt.moduleSpecifier;
    if (!ts.isStringLiteral(spec)) continue;
    if (!/^(?:node:)?fs(?:\/promises)?$/.test(spec.text)) continue;
    const clause = stmt.importClause;
    if (!clause) continue;
    if (clause.name) names.add(clause.name.text);
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) names.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) names.add(el.name.text);
    }
  }
  return names;
}

function nearestFunctionBoundary(node: ts.Node): ts.Node | null {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (
      ts.isArrowFunction(cur) ||
      ts.isFunctionExpression(cur) ||
      ts.isFunctionDeclaration(cur) ||
      ts.isMethodDeclaration(cur) ||
      ts.isConstructorDeclaration(cur) ||
      ts.isGetAccessor(cur) ||
      ts.isSetAccessor(cur)
    ) {
      return cur;
    }
    cur = cur.parent;
  }
  return null;
}

export function scanTransactions(entry: SourceEntry): TxScanResult {
  const sf = parse(entry);
  const fsNames = fsBoundNames(sf);
  const importedNames = allNamedImports(sf);
  const sites: TxSiteFinding[] = [];
  const violations: TxViolationFinding[] = [];

  const analyzeCallback = (cb: ts.ArrowFunction | ts.FunctionExpression, fnName: string): void => {
    if (cb.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword)) {
      violations.push({ file: entry.path, fn: fnName, violation: 'async transaction callback' });
    }
    const inCallbackScope = (node: ts.Node): boolean => nearestFunctionBoundary(node) === cb;
    const walk = (node: ts.Node): void => {
      if (ts.isAwaitExpression(node) && inCallbackScope(node)) {
        violations.push({ file: entry.path, fn: fnName, violation: 'await inside transaction callback' });
      }
      if (ts.isCallExpression(node) && inCallbackScope(node)) {
        const callee = node.expression;
        if (ts.isPropertyAccessExpression(callee)) {
          const name = callee.name.text;
          if (name === 'then' || name === 'catch' || name === 'finally') {
            violations.push({ file: entry.path, fn: fnName, violation: `promise .${name}() inside transaction callback` });
          }
          if (EFFECT_CALL_PATTERN.test(name)) {
            violations.push({ file: entry.path, fn: fnName, violation: `effect call .${name}() inside transaction callback` });
          }
          const root = rootIdentifier(callee);
          if (root && fsNames.has(root)) {
            violations.push({ file: entry.path, fn: fnName, violation: `fs call via '${root}' inside transaction callback` });
          }
        } else if (ts.isIdentifier(callee)) {
          // Import-aware: match the IMPORTED name, so `import { publishX as
          // emit }` cannot dodge the pattern by aliasing. A purely local
          // rebinding (`const send = obj.publish.bind(obj)`) has no import
          // edge and is a documented residual, not a covered case.
          const effectiveName = importedNames.get(callee.text) ?? callee.text;
          if (EFFECT_CALL_PATTERN.test(effectiveName)) {
            violations.push({
              file: entry.path,
              fn: fnName,
              violation: `effect call ${callee.text}()${effectiveName === callee.text ? '' : ` (imported as ${effectiveName})`} inside transaction callback`,
            });
          }
          if (FORBIDDEN_GLOBALS.has(callee.text)) {
            violations.push({ file: entry.path, fn: fnName, violation: `${callee.text}() inside transaction callback` });
          }
          if (POST_COMMIT_DRAINS.has(effectiveName)) {
            violations.push({ file: entry.path, fn: fnName, violation: `post-commit drain ${effectiveName}() inside transaction callback` });
          }
          if (fsNames.has(callee.text)) {
            violations.push({ file: entry.path, fn: fnName, violation: `fs call ${callee.text}() inside transaction callback` });
          }
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(cb.body);
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      (node.expression.name.text === 'transaction' || UOW_TX_METHOD.test(node.expression.name.text)) &&
      node.arguments.length >= 1
    ) {
      // `atomically` is the application-facing UnitOfWork transaction point
      // (#task:1978) — same ledger, same callback hygiene, so convergence to
      // UoW does not blind the transaction ledger.
      //
      // The PREFIX, not the exact name (#task:1987): a UnitOfWork may expose more
      // than one coordination axis (`atomicallyForWorkspace` — the membership
      // roster scope), and each of those is a real atomic boundary. Matching only
      // the bare name would have made every additional axis invisible to this
      // ledger — a gate that silently stops covering what it claims to cover.
      const isUow = UOW_TX_METHOD.test(node.expression.name.text);
      const fnName = enclosingFunctionName(node);
      // The callback is the LAST argument, not the first: a UnitOfWork may take
      // coordination inputs ahead of it (`atomically(key, fn)` —
      // membership-persistence.ts). Reading `arguments[0]` made such a call look
      // like "not an inline function", i.e. it degraded the callback hygiene scan
      // to a bare complaint instead of analyzing the body. Taking the last
      // argument keeps `db.transaction(fn)` identical (one argument) and stays
      // fail-loud: if the last argument is not an inline function, the violation
      // below still fires.
      const cb = node.arguments[node.arguments.length - 1];
      sites.push({ file: entry.path, fn: fnName, mode: isUow ? 'uow' : txMode(node) });
      if (cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb))) {
        analyzeCallback(cb, fnName);
      } else if (cb) {
        violations.push({
          file: entry.path,
          fn: fnName,
          violation: 'transaction callback is not an inline function (not statically analyzable)',
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { sites, violations };
}

/** `atomically` and its axis-qualified siblings (`atomicallyForWorkspace`, …) —
 *  every application-facing UnitOfWork transaction point. */
const UOW_TX_METHOD = /^atomically([A-Z][A-Za-z0-9]*)?$/;

function rootIdentifier(expr: ts.Expression): string | null {
  let cur: ts.Expression = expr;
  while (ts.isPropertyAccessExpression(cur)) cur = cur.expression;
  return ts.isIdentifier(cur) ? cur.text : null;
}

function txMode(txCall: ts.CallExpression): TxMode {
  const parent = txCall.parent;
  // db.transaction(fn)() — immediate default invocation
  if (ts.isCallExpression(parent) && parent.expression === txCall) return 'default';
  // db.transaction(fn).exclusive() / .immediate() / .deferred()
  if (ts.isPropertyAccessExpression(parent) && parent.expression === txCall) {
    const name = parent.name.text;
    if (name === 'immediate' || name === 'exclusive' || name === 'deferred') return name;
  }
  // stored for a later call site; mode surfaces via scanApiHazards
  return 'stored';
}

// ---------------------------------------------------------------------------
// Composition-handle readers (`ctx.db`)
// ---------------------------------------------------------------------------

export type ContextDbReadForm = 'property' | 'element' | 'destructure';

export interface ContextDbReadFinding {
  file: string;
  fn: string;
  form: ContextDbReadForm;
}

/**
 * A `.db` read whose base value IS annotated, but with a type name this scan
 * cannot decide — it is neither reachable from the context type nor bound
 * anywhere in the file. Reported instead of swallowed: "silently not a context"
 * is exactly the hole an alias bypass rides through, so an undecidable
 * annotation at a handle read is a gate failure that a human resolves.
 */
export interface UnresolvedContextTypeRef {
  file: string;
  fn: string;
  /** The value whose `.db` was read. */
  base: string;
  /** The type name that could not be decided. */
  typeName: string;
}

export interface ContextDbScan {
  readers: ContextDbReadFinding[];
  unresolved: UnresolvedContextTypeRef[];
}

/** The one context type whose `db` field is the composition handle. */
const CONTEXT_TYPE_ROOT = 'BackendContext';

/**
 * Type names that stand for lib/global types: declared outside every scanned
 * file, never the context, and common enough at annotation sites that treating
 * them as undecidable would be noise. A utility type's ARGUMENTS are still
 * decided individually (`Pick<Ctx, 'db'>` → `Ctx` is checked).
 */
const AMBIENT_TYPE_NAMES = new Set([
  'Array', 'ReadonlyArray', 'Readonly', 'Partial', 'Required', 'Pick', 'Omit', 'Record',
  'Exclude', 'Extract', 'NonNullable', 'ReturnType', 'Parameters', 'InstanceType', 'Awaited',
  'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Iterable', 'AsyncIterable', 'IterableIterator',
  'Date', 'RegExp', 'Error', 'Buffer', 'Function', 'Object', 'String', 'Number', 'Boolean',
  'Symbol', 'BigInt', 'Uint8Array', 'ArrayBuffer', 'NodeJS',
]);

/** `alias ← from`: "the name `alias` may denote whatever `from` denotes". */
interface TypeRelationEdge {
  alias: string;
  from: string;
}

function entityNames(name: ts.EntityName): { root: string; tip: string } {
  if (ts.isIdentifier(name)) return { root: name.text, tip: name.text };
  let left: ts.EntityName = name.left;
  while (!ts.isIdentifier(left)) left = left.left;
  return { root: left.text, tip: name.right.text };
}

/** Every type name mentioned inside a node's type positions (root + tip of
 *  qualified names, so both `ctxMod` and `BackendContext` are seen). */
function typeNamesIn(node: ts.Node): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isTypeReferenceNode(n)) {
      const { root, tip } = entityNames(n.typeName);
      out.push(root, tip);
    } else if (ts.isImportTypeNode(n) && n.qualifier) {
      const { root, tip } = entityNames(n.qualifier);
      out.push(root, tip);
    } else if (ts.isExpressionWithTypeArguments(n)) {
      // heritage clause: `interface X extends BackendContext`
      const e = n.expression;
      if (ts.isIdentifier(e)) out.push(e.text);
      else if (ts.isPropertyAccessExpression(e)) out.push(e.name.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

/**
 * The name-relation edges of ONE file: import/export renames, type aliases,
 * interface/class heritage and type-parameter constraints. This is what makes
 * `import type { BackendContext as Ctx }` and `interface Ctx extends
 * BackendContext {}` visible — both are relations, not textual mentions of the
 * root name at the annotation site.
 */
function collectTypeRelations(sf: ts.SourceFile): TypeRelationEdge[] {
  const edges: TypeRelationEdge[] = [];
  const rename = (specs: readonly (ts.ImportSpecifier | ts.ExportSpecifier)[]): void => {
    for (const spec of specs) {
      if (spec.propertyName) edges.push({ alias: spec.name.text, from: spec.propertyName.text });
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) rename(bindings.elements);
    } else if (ts.isExportDeclaration(node)) {
      if (node.exportClause && ts.isNamedExports(node.exportClause)) rename(node.exportClause.elements);
    } else if (ts.isTypeAliasDeclaration(node)) {
      for (const from of typeNamesIn(node.type)) edges.push({ alias: node.name.text, from });
    } else if ((ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
      for (const clause of node.heritageClauses ?? []) {
        for (const from of typeNamesIn(clause)) edges.push({ alias: node.name.text, from });
      }
    } else if (ts.isTypeParameterDeclaration(node) && node.constraint) {
      for (const from of typeNamesIn(node.constraint)) edges.push({ alias: node.name.text, from });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return edges;
}

/** Names this file introduces that can legitimately stand for a type. A type
 *  reference to something in here is DECIDED (it is whatever that declaration
 *  says); one to a name absent from here has no visible origin at all. */
function localTypeBindings(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && node.importClause) {
      const clause = node.importClause;
      if (clause.name) names.add(clause.name.text);
      const bindings = clause.namedBindings;
      if (bindings) {
        if (ts.isNamespaceImport(bindings)) names.add(bindings.name.text);
        else for (const spec of bindings.elements) names.add(spec.name.text);
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      names.add(node.name.text);
    } else if (
      (ts.isTypeAliasDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isEnumDeclaration(node) ||
        ts.isModuleDeclaration(node) ||
        ts.isTypeParameterDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name)
    ) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return names;
}

/** Fixpoint over `alias ← from` edges, seeded with the context root. Bounded by
 *  the edge count (every pass that changes anything adds a name). */
function closeOver(edges: readonly TypeRelationEdge[], seed: Iterable<string>): Set<string> {
  const closure = new Set<string>(seed);
  closure.add(CONTEXT_TYPE_ROOT);
  for (let pass = 0; pass <= edges.length; pass++) {
    let grew = false;
    for (const { alias, from } of edges) {
      if (closure.has(from) && !closure.has(alias)) {
        closure.add(alias);
        grew = true;
      }
    }
    if (!grew) return closure;
  }
  // unreachable (bounded above); a loud failure beats an under-approximation.
  throw new Error('scan: context-type closure did not stabilize');
}

/**
 * Every name that denotes the composition context ACROSS the corpus: the root,
 * plus every import/export rename, type alias, interface/class heritage and
 * type-parameter constraint chain that reaches it — in any scanned file. A
 * context alias declared in one module and imported by another is only visible
 * this way.
 *
 * Deliberate over-approximation: names are matched as strings, not resolved per
 * module, so a same-named unrelated type elsewhere is treated as a context too.
 * That direction produces a VISIBLE gate failure, never a silent hole.
 */
export function buildContextTypeClosure(entries: readonly SourceEntry[]): ReadonlySet<string> {
  const edges = entries.flatMap(e => collectTypeRelations(parse(e)));
  return closeOver(edges, [CONTEXT_TYPE_ROOT]);
}

/**
 * Does this annotation's TEXT name a context type — directly, through a
 * namespace (`import ctxMod = require('./context.js')` → `ctxMod.BackendContext`),
 * through an inline `import('./context.js').BackendContext`, or through any name
 * in the relation closure? Text matching is what makes all of those one rule:
 * every one of them spells a closure name at the annotation site.
 */
function namesContextType(typeText: string, aliases: ReadonlySet<string>): boolean {
  for (const name of aliases) {
    if (new RegExp(`\\b${name}\\b`).test(typeText)) return true;
  }
  return false;
}

/** Last name segment of an object expression: `this.ctx` / `deps.ctx` → 'ctx'. */
function lastNameSegment(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  if (ts.isParenthesizedExpression(expr)) return lastNameSegment(expr.expression);
  if (ts.isNonNullExpression(expr) || ts.isAsExpression(expr)) return lastNameSegment(expr.expression);
  return null;
}

function bindingElementProperty(el: ts.BindingElement): string | null {
  const key = el.propertyName ?? el.name;
  if (ts.isIdentifier(key) || ts.isStringLiteral(key)) return key.text;
  return null;
}

/**
 * Every read of the composition handle in one file: `ctx.db`, `ctx['db']` and
 * `const { db } = ctx`, where "ctx" is any value the file annotates as a context
 * type plus any local alias of such a value. Pass the corpus closure from
 * {@link buildContextTypeClosure} so a context alias DECLARED IN ANOTHER MODULE
 * is recognized here; without it only this file's own relations are known.
 *
 * Coverage statement (syntax + name relations, no type checker):
 *  - the type side is closed: any name that reaches `BackendContext` through
 *    import/export renames, type aliases, interface/class heritage or a type
 *    parameter constraint is a context type, and a `.db` read whose base is
 *    annotated with an UNDECIDABLE name is reported in `unresolved` rather than
 *    assumed innocent;
 *  - the value side is not: an unannotated value that receives a context by
 *    inference (`const c = pick()`) is invisible. That is a stated limit, and
 *    Gate 1 (driver imports) plus Gate 5 (port/concrete boundary) are what keep
 *    the handle from being obtained by other means.
 */
export function scanContextDbHandle(
  entry: SourceEntry,
  corpusClosure: ReadonlySet<string> = new Set([CONTEXT_TYPE_ROOT]),
): ContextDbScan {
  return scanContextFieldReads(entry, 'db', corpusClosure);
}

/**
 * Generalization of the above over the FIELD NAME: every read of `ctx.<field>`,
 * `ctx['<field>']` and `const { <field> } = ctx` in one file. Gate 6 asks for
 * `db`; Gate 8 asks for a narrow port that is private to one consumer. The
 * context-type closure, the value-alias fixpoint and the undecidable-annotation
 * reporting are identical either way — what changes is only which member of the
 * capability bag is being fenced.
 */
export function scanContextFieldReads(
  entry: SourceEntry,
  field: string,
  corpusClosure: ReadonlySet<string> = new Set([CONTEXT_TYPE_ROOT]),
): ContextDbScan {
  const sf = parse(entry);
  // This file's relations on top of the corpus closure: a single-file probe has
  // no corpus, and a file-local `type Ctx = BackendContext` is not in one.
  const typeAliases = closeOver(collectTypeRelations(sf), corpusClosure);
  const bindings = localTypeBindings(sf);
  const contextValues = new Set<string>();
  /** name → its annotation, for deciding a non-context base at a read site. */
  const declaredTypes = new Map<string, ts.TypeNode>();

  const annotationOf = (node: ts.Node): ts.TypeNode | undefined => {
    if (
      ts.isParameter(node) ||
      ts.isVariableDeclaration(node) ||
      ts.isPropertyDeclaration(node) ||
      ts.isPropertySignature(node)
    ) {
      return node.type;
    }
    return undefined;
  };

  // Fixpoint: value aliases (`const c = ctx`) chain, and a value can be
  // declared after its use.
  for (let pass = 0; pass < 8; pass++) {
    const before = contextValues.size;
    const discover = (node: ts.Node): void => {
      const annotation = annotationOf(node);
      const named = node as ts.NamedDeclaration;
      if (annotation && named.name && ts.isIdentifier(named.name)) {
        declaredTypes.set(named.name.text, annotation);
      }
      if (annotation && named.name && namesContextType(annotation.getText(sf), typeAliases)) {
        if (ts.isIdentifier(named.name)) contextValues.add(named.name.text);
        else if (ts.isObjectBindingPattern(named.name)) {
          // `{ ctx }: { ctx: BackendContext }` — only the members the
          // annotation actually types as a context become context values.
          const typeText = annotation.getText(sf);
          const names = [...typeAliases].join('|');
          for (const el of named.name.elements) {
            const prop = bindingElementProperty(el);
            if (!prop || !ts.isIdentifier(el.name)) continue;
            if (new RegExp(`\\b${prop}\\s*\\??\\s*:[^;,}]*\\b(?:${names})\\b`).test(typeText)) {
              contextValues.add(el.name.text);
            }
          }
        }
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const init = node.initializer;
        const segment = lastNameSegment(init);
        if (segment && contextValues.has(segment)) contextValues.add(node.name.text);
        if (ts.isAsExpression(init) && namesContextType(init.type.getText(sf), typeAliases)) {
          contextValues.add(node.name.text);
        }
      }
      ts.forEachChild(node, discover);
    };
    discover(sf);
    if (contextValues.size === before) break;
  }

  const readers: ContextDbReadFinding[] = [];
  const unresolved: UnresolvedContextTypeRef[] = [];
  const record = (node: ts.Node, form: ContextDbReadForm): void => {
    readers.push({ file: entry.path, fn: enclosingFunctionName(node), form });
  };
  /**
   * The base of this `.<field>` read is not a known context. Is that a DECISION or
   * an unknown? Its annotation is decidable when every type name in it is
   * either bound in this file, ambient, or a resolvable module reference; a name
   * with no visible origin at all is reported instead of assumed innocent.
   */
  const decide = (base: string, node: ts.Node): void => {
    const annotation = declaredTypes.get(base);
    if (!annotation) return; // unannotated: the stated value-side limit
    for (const typeName of undecidableTypeNames(annotation, bindings, typeAliases)) {
      unresolved.push({ file: entry.path, fn: enclosingFunctionName(node), base, typeName });
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === field) {
      const segment = lastNameSegment(node.expression);
      if (segment && contextValues.has(segment)) record(node, 'property');
      else if (segment) decide(segment, node);
    }
    if (ts.isElementAccessExpression(node)) {
      const arg = node.argumentExpression;
      if (
        (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) &&
        arg.text === field
      ) {
        const segment = lastNameSegment(node.expression);
        if (segment && contextValues.has(segment)) record(node, 'element');
        else if (segment) decide(segment, node);
      }
    }
    // `const { db } = ctx` and `function f({ db }: BackendContext)`: the
    // destructuring IS the read, whichever side supplies the context.
    const named = node as ts.NamedDeclaration;
    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node)) &&
      named.name &&
      ts.isObjectBindingPattern(named.name)
    ) {
      const annotation = annotationOf(node);
      const fromInitializer =
        ts.isVariableDeclaration(node) && node.initializer
          ? lastNameSegment(node.initializer)
          : null;
      const isContextSource =
        (fromInitializer !== null && contextValues.has(fromInitializer)) ||
        (annotation !== undefined && namesContextType(annotation.getText(sf), typeAliases));
      const destructuresDb = named.name.elements.some(el => bindingElementProperty(el) === field);
      if (isContextSource) {
        for (const el of named.name.elements) {
          if (bindingElementProperty(el) === field) record(node, 'destructure');
        }
      } else if (destructuresDb) {
        if (annotation) {
          for (const typeName of undecidableTypeNames(annotation, bindings, typeAliases)) {
            unresolved.push({
              file: entry.path,
              fn: enclosingFunctionName(node),
              base: '<destructured>',
              typeName,
            });
          }
        } else if (fromInitializer !== null) {
          decide(fromInitializer, node);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { readers, unresolved };
}

/**
 * Type names in an annotation that this scan can neither place in the context
 * closure nor trace to a visible declaration. `typeof x` and `import('…').T`
 * are excluded on purpose: the first is value dataflow (the stated limit), the
 * second carries its own module specifier and is matched textually.
 */
function undecidableTypeNames(
  annotation: ts.TypeNode,
  bindings: ReadonlySet<string>,
  closure: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isTypeQueryNode(n) || ts.isImportTypeNode(n)) return;
    if (ts.isTypeReferenceNode(n)) {
      const { root } = entityNames(n.typeName);
      if (!closure.has(root) && !bindings.has(root) && !AMBIENT_TYPE_NAMES.has(root)) {
        out.push(root);
      }
      for (const arg of n.typeArguments ?? []) visit(arg);
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(annotation);
  return [...new Set(out)];
}

/** Readers only — the shape Gate 6's zero assertion consumes. */
export function scanContextDbReaders(
  entry: SourceEntry,
  corpusClosure?: ReadonlySet<string>,
): ContextDbReadFinding[] {
  return scanContextDbHandle(entry, corpusClosure).readers;
}

// ---------------------------------------------------------------------------
// Private-port uses (Gate 8)
// ---------------------------------------------------------------------------

export type PortUseKind = 'read' | 'install' | 'declare';

export interface PortUseFinding {
  file: string;
  fn: string;
  kind: PortUseKind;
}

/**
 * Every syntactic use of one named member, BY NAME and independent of receiver.
 *
 * Gate 8 fences a port that is private to a single consumer, and a
 * context-typed scan is the wrong instrument for that: the same port also hangs
 * off the persistence bag that routes receive, so `persistence.authorizationReads`
 * would be an equally effective bypass while naming no context at all. Matching
 * the NAME closes both spellings and every alias in between — the cost is that an
 * unrelated member that happens to share the name must be renamed or added to the
 * ledger, which is the right direction for a name that is supposed to be private.
 *
 *  - `read`    — `x.<name>`, `x['<name>']`, or destructuring it out of anything.
 *  - `install` — an object literal supplying it (composition wiring).
 *  - `declare` — an interface/class declaring it (the type-level definition).
 */
export function scanPortUses(entry: SourceEntry, name: string): PortUseFinding[] {
  const sf = parse(entry);
  const out: PortUseFinding[] = [];
  const push = (node: ts.Node, kind: PortUseKind): void => {
    out.push({ file: entry.path, fn: enclosingFunctionName(node), kind });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === name) {
      push(node, 'read');
    } else if (ts.isElementAccessExpression(node)) {
      const arg = node.argumentExpression;
      if ((ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) && arg.text === name) {
        push(node, 'read');
      }
    } else if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
      const key = node.name;
      if ((ts.isIdentifier(key) || ts.isStringLiteral(key)) && key.text === name) {
        push(node, 'install');
      }
    } else if (ts.isPropertySignature(node) || ts.isPropertyDeclaration(node)) {
      const key = node.name;
      if ((ts.isIdentifier(key) || ts.isStringLiteral(key)) && key.text === name) {
        push(node, 'declare');
      }
    } else if (ts.isBindingElement(node)) {
      const key = node.propertyName ?? node.name;
      if ((ts.isIdentifier(key) || ts.isStringLiteral(key)) && key.text === name) {
        push(node, 'read');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/**
 * The member names an interface declares DIRECTLY in one file, or `null` when
 * that interface is not declared there at all.
 *
 * Gate 6 uses this to state the availability half of the wall as a fact about
 * the TYPE rather than only about its readers: after #task:1983 W5 the
 * production context declares no handle member, so `ctx.db` does not typecheck.
 * The `null` case matters — a vacuously green "no `db` member" on a file that no
 * longer declares the interface would be a gate that stopped looking.
 */
// ---------------------------------------------------------------------------
// Driver capability surface (Gate 2b)
// ---------------------------------------------------------------------------

/**
 * Every method the driver's `Database` interface offers, split by which gate
 * answers for it. The union must equal what the installed `@types/better-sqlite3`
 * declares (pinned by `driver-capability.test.ts`), so a driver upgrade that adds
 * a capability cannot land without someone deciding where it is fenced.
 */
export const DRIVER_METHOD_GATES = {
  prepare: 'gate-2 (sql sinks)',
  exec: 'gate-2 (sql sinks)',
  pragma: 'gate-2 (sql sinks)',
  transaction: 'gate-3 (transaction ownership)',
  close: 'gate-2b-B (lifetime, receiver-narrowed ledger)',
  function: 'gate-2b-A (must be absent)',
  aggregate: 'gate-2b-A (must be absent)',
  loadExtension: 'gate-2b-A (must be absent)',
  defaultSafeIntegers: 'gate-2b-A (must be absent)',
  backup: 'gate-2b-A (must be absent)',
  table: 'gate-2b-A (must be absent)',
  unsafeMode: 'gate-2b-A (must be absent)',
  serialize: 'gate-2b-A (must be absent)',
} as const satisfies Record<string, string>;

export type DriverMethod = keyof typeof DRIVER_METHOD_GATES;

export const DRIVER_METHODS_ABSENT: readonly DriverMethod[] = (
  Object.keys(DRIVER_METHOD_GATES) as DriverMethod[]
).filter(m => DRIVER_METHOD_GATES[m].startsWith('gate-2b-A'));

/** Method names a `Database` declares, harvested from the installed types. */
export function declaredDriverMethods(entry: SourceEntry): string[] | null {
  const sf = parse(entry);
  let found: string[] | null = null;
  const visit = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === 'Database') {
      const names = node.members
        .filter(m => ts.isMethodSignature(m))
        .map(m => (m.name && ts.isIdentifier(m.name) ? m.name.text : null))
        .filter((n): n is string => n !== null);
      found = [...new Set([...(found ?? []), ...names])];
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** Local names introduced by an import of the driver module (value or type). */
function driverLocalNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const ref of moduleReferencesOf(sf)) {
    if (ref.spec !== BETTER_SQLITE3) continue;
    const node = ref.node;
    if (ts.isImportDeclaration(node) && node.importClause) {
      const clause = node.importClause;
      if (clause.name) names.add(clause.name.text);
      const b = clause.namedBindings;
      if (b && ts.isNamespaceImport(b)) names.add(b.name.text);
      if (b && ts.isNamedImports(b)) for (const el of b.elements) names.add(el.name.text);
    } else if (ts.isImportEqualsDeclaration(node)) {
      names.add(node.name.text);
    }
  }
  return names;
}

/** Root identifier a member call hangs off: `db` for both `db.x()` and `this.db.x()`. */
function receiverRootName(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  if (ts.isParenthesizedExpression(expr)) return receiverRootName(expr.expression);
  if (ts.isAsExpression(expr) || ts.isNonNullExpression(expr)) return receiverRootName(expr.expression);
  return null;
}

/**
 * Names in one file that hold a driver handle.
 *
 * The handle has exactly one source in the tree — `openDatabase()` in `db.ts`,
 * which Gate 1 keeps as the only file allowed to construct the driver — so a
 * binding holds one iff it comes from that call, is annotated with its return
 * type, or is annotated with a driver type imported from the module (which only
 * a Gate 1 ledger file may do). Local aliasing is followed to a fixpoint, so
 * `const h = db;` does not launder it.
 */
export function driverHandleBindings(sf: ts.SourceFile): Set<string> {
  const driverTypes = driverLocalNames(sf);
  const bound = new Set<string>();
  const isDriverTypeNode = (type: ts.TypeNode | undefined): boolean => {
    if (!type) return false;
    const text = type.getText(sf);
    if (/\bReturnType\s*<\s*typeof\s+openDatabase\s*>/.test(text)) return true;
    for (const name of driverTypes) {
      if (new RegExp(`(^|[^\\w.])${name}\\b`).test(text)) return true;
    }
    return false;
  };
  const isHandleSource = (expr: ts.Expression | undefined): boolean => {
    if (!expr) return false;
    if (ts.isCallExpression(expr)) {
      const callee = expr.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : null;
      return name === 'openDatabase';
    }
    if (ts.isNewExpression(expr) && ts.isIdentifier(expr.expression)) {
      return driverTypes.has(expr.expression.text);
    }
    if (ts.isIdentifier(expr)) return bound.has(expr.text);
    if (ts.isAsExpression(expr) || ts.isNonNullExpression(expr) || ts.isParenthesizedExpression(expr)) {
      return isHandleSource(expr.expression);
    }
    return false;
  };
  const pass = (): void => {
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        if (isDriverTypeNode(node.type) || isHandleSource(node.initializer)) bound.add(node.name.text);
      } else if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
        if (isDriverTypeNode(node.type)) bound.add(node.name.text);
      } else if (ts.isPropertyDeclaration(node) && ts.isIdentifier(node.name)) {
        if (isDriverTypeNode(node.type) || isHandleSource(node.initializer)) bound.add(node.name.text);
      } else if (ts.isPropertySignature(node) && ts.isIdentifier(node.name)) {
        if (isDriverTypeNode(node.type)) bound.add(node.name.text);
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        isHandleSource(node.right)
      ) {
        const root = receiverRootName(node.left);
        if (root) bound.add(root);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  };
  // Fixpoint: alias chains and assignments can be written before their source.
  let size = -1;
  while (bound.size !== size) {
    size = bound.size;
    pass();
  }
  return bound;
}

export interface DriverMethodCall {
  file: string;
  fn: string;
  method: string;
  receiver: string;
}

/**
 * Calls of the given method names, receiver-INDEPENDENT. Affordable only for
 * names that appear nowhere else in the tree (Gate 2b-A's absent set); using it
 * for a name like `close` would drown in WebSocket and server shutdowns.
 */
export function scanMethodCallsByName(
  entry: SourceEntry,
  methods: readonly string[],
): DriverMethodCall[] {
  const sf = parse(entry);
  const out: DriverMethodCall[] = [];
  const wanted = new Set(methods);
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && wanted.has(node.name.text)) {
      out.push({
        file: entry.path,
        fn: enclosingFunctionName(node),
        method: node.name.text,
        receiver: node.expression.getText(sf),
      });
    } else if (ts.isElementAccessExpression(node)) {
      const arg = node.argumentExpression;
      if ((ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) && wanted.has(arg.text)) {
        out.push({
          file: entry.path,
          fn: enclosingFunctionName(node),
          method: arg.text,
          receiver: node.expression.getText(sf),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Calls of the given methods ON a driver handle (Gate 2b-B's narrowing). */
export function scanDriverHandleCalls(
  entry: SourceEntry,
  methods: readonly string[],
): DriverMethodCall[] {
  const sf = parse(entry);
  const handles = driverHandleBindings(sf);
  if (handles.size === 0) return [];
  const wanted = new Set(methods);
  const out: DriverMethodCall[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const access = node.expression;
      const root = receiverRootName(access.expression);
      if (wanted.has(access.name.text) && root !== null && handles.has(root)) {
        out.push({
          file: entry.path,
          fn: enclosingFunctionName(node),
          method: access.name.text,
          receiver: access.expression.getText(sf),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

export function interfaceMemberNames(entry: SourceEntry, typeName: string): string[] | null {
  const sf = parse(entry);
  let found: string[] | null = null;
  const visit = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === typeName) {
      found = node.members
        .map(m => (m.name && (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name)) ? m.name.text : null))
        .filter((n): n is string => n !== null);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

// ---------------------------------------------------------------------------
// Driver-dialect decoding (SQLite error codes, constraint text, trigger text)
// ---------------------------------------------------------------------------

export type DialectSignal = 'sqlite_error_code' | 'constraint_failed_text' | 'trigger_text';

export interface DialectFinding {
  file: string;
  fn: string;
  signal: DialectSignal;
  /** The matched fragment, for gate output; never part of the ledger key. */
  sample: string;
}

/**
 * String, template and REGEX literals of a file. Regex literals are included
 * because matching driver text with a regex is the most common way to decode
 * it; comments are excluded because documenting the driver's message shape is
 * not decoding it (the gate states this coverage boundary).
 */
function decodableLiteralsOf(sf: ts.SourceFile): Array<{ node: ts.Node; text: string }> {
  const out: Array<{ node: ts.Node; text: string }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      out.push({ node, text: node.text });
      return;
    }
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
      out.push({ node, text: (node as ts.RegularExpressionLiteral).text });
      return;
    }
    if (ts.isTemplateExpression(node)) {
      out.push({ node, text: templateText(node) });
      for (const span of node.templateSpans) visit(span.expression);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Words of a literal, with regex escapes and punctuation flattened away. */
function dialectWords(text: string): string[] {
  return text
    .replace(/\\/g, '')
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter(Boolean);
}

const TRIGGER_SHINGLE_LENGTH = 5;

function shinglesOf(words: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i + TRIGGER_SHINGLE_LENGTH <= words.length; i++) {
    out.push(words.slice(i, i + TRIGGER_SHINGLE_LENGTH).join(' '));
  }
  return out;
}

/**
 * The trigger-message authority: every `RAISE(ABORT, '...')` text defined by
 * the schema modules. Harvested, never hand-listed — a new trigger message is
 * fenced the moment the schema declares it.
 */
export function harvestTriggerMessages(entries: readonly SourceEntry[]): string[] {
  const messages = new Set<string>();
  for (const entry of entries) {
    for (const { text } of decodableLiteralsOf(parse(entry))) {
      for (const m of text.matchAll(/RAISE\s*\(\s*ABORT\s*,\s*'([^']*)'/g)) {
        const message = m[1]?.trim();
        if (message) messages.add(message);
      }
    }
  }
  return [...messages].sort();
}

/**
 * Driver-dialect decoding sites: SQLite error codes, the driver's
 * "constraint failed" message shape, and schema trigger text. Trigger text
 * matches on a run of TRIGGER_SHINGLE_LENGTH consecutive words, so a decoder
 * that quotes only part of a message is caught too, while a short generic
 * phrase is not enough to trip it. Counts are per LITERAL (at most one
 * trigger_text finding each) — the ledger freezes decoding SITES, not how many
 * messages a literal happens to contain.
 */
export function scanDriverDialect(
  entry: SourceEntry,
  triggerMessages: readonly string[],
): DialectFinding[] {
  const triggerShingles = new Map<string, string>();
  for (const message of triggerMessages) {
    for (const shingle of shinglesOf(dialectWords(message))) {
      if (!triggerShingles.has(shingle)) triggerShingles.set(shingle, message);
    }
  }
  const findings: DialectFinding[] = [];
  for (const { node, text } of decodableLiteralsOf(parse(entry))) {
    const push = (signal: DialectSignal, sample: string): void => {
      findings.push({ file: entry.path, fn: enclosingFunctionName(node), signal, sample });
    };
    const code = /\bSQLITE_[A-Z][A-Z0-9_]*/.exec(text.replace(/\\/g, ''));
    if (code) push('sqlite_error_code', code[0]);
    if (/\bconstraint\s+failed\b/i.test(text.replace(/\\/g, ''))) {
      push('constraint_failed_text', 'constraint failed');
    }
    for (const shingle of shinglesOf(dialectWords(text))) {
      const message = triggerShingles.get(shingle);
      if (message !== undefined) {
        push('trigger_text', message);
        break;
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Native SQL in tests
// ---------------------------------------------------------------------------

export interface TestNativeSqlFinding {
  file: string;
  count: number;
}

/**
 * Counts native statement surface in a test file: `.prepare(` / `.pragma(`
 * member calls plus `.exec(` member calls under the same sink rules as
 * production; unresolvable sink arguments count as well (dynamic SQL is
 * still native SQL).
 */
export function countTestNativeSql(entry: SourceEntry, resolver?: CorpusResolver): number {
  return scanSqlSinks(entry, resolver).calls.length;
}
