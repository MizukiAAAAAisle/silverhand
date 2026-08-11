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
      (node.expression.name.text === 'transaction' || node.expression.name.text === 'atomically') &&
      node.arguments.length >= 1
    ) {
      // `atomically` is the application-facing UnitOfWork transaction point
      // (#task:1978) — same ledger, same callback hygiene, so convergence to
      // UoW does not blind the transaction ledger.
      const isUow = node.expression.name.text === 'atomically';
      const fnName = enclosingFunctionName(node);
      const cb = node.arguments[0];
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
