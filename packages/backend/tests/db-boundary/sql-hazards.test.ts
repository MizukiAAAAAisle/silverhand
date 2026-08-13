/**
 * Gate 2 — SQLite-specific SQL hazard ledger.
 *
 * Corpus = every string/template literal of the SQL scope (backend, server,
 * shared schema modules), harvested at its definition site, plus one
 * synthetic PRAGMA occurrence per `.pragma()` API call. SQL sink calls with
 * arguments that cannot be statically resolved are never skipped silently:
 * they live in DYNAMIC_SQL_INVENTORY, and any new one fails this gate.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildCorpusResolver,
  harvestLiterals,
  scanApiHazards,
  scanSqlHazards,
  scanSqlSinks,
  SQL_HAZARD_RULES,
} from './scan.js';
import {
  API_HAZARD_INVENTORY,
  DYNAMIC_SQL_INVENTORY,
  SQL_CALLER_INVENTORY,
  SQL_HAZARD_EXPANSIONS,
  SQL_HAZARD_INVENTORY,
} from './inventory.js';
import { allProductionSources, asInventoryLines, REPO_ROOT, sqlScopeSources } from './sources.js';
import { zoneSurfaceViolations } from './zones.js';

describe('db-boundary: SQLite hazard ledger', () => {
  const all = allProductionSources();
  const scope = sqlScopeSources(all);
  const resolver = buildCorpusResolver(all);
  const sinks = scope.map(e => scanSqlSinks(e, resolver));

  it('per-file × per-hazard occurrence counts equal frozen baseline + reviewed expansions', () => {
    const corpus = [...scope.flatMap(harvestLiterals), ...sinks.flatMap(s => s.pragmaOccurrences)];
    const actual = scanSqlHazards(corpus);
    const expectedByKey = new Map<string, number>();
    for (const row of SQL_HAZARD_INVENTORY) {
      expectedByKey.set(`${row.file}\u0000${row.hazard}`, row.count);
    }
    for (const exp of SQL_HAZARD_EXPANSIONS) {
      const key = `${exp.file}\u0000${exp.hazard}`;
      expectedByKey.set(key, (expectedByKey.get(key) ?? 0) + exp.added);
    }
    const expected = [...expectedByKey.entries()]
      .map(([key, count]) => {
        const [file = '', hazard = ''] = key.split('\u0000');
        return { file, hazard, count };
      })
      .sort((a, b) => (a.file + a.hazard < b.file + b.hazard ? -1 : 1));
    expect(
      actual,
      'SQLite hazard counts drifted. Shrinking: decrement/delete the BASELINE row. Growing: add a ' +
        'SQL_HAZARD_EXPANSIONS entry with a reason and an existing semantic test — that is the sanctioned, ' +
        'gate-validated path. (Bumping a baseline count would also pass this gate, but the baseline is ' +
        'shrink-only by review contract and the diff is visible.) Current tree state:\n' +
        asInventoryLines(actual),
    ).toEqual(expected);
  });

  it('every reviewed expansion names a reason and an existing semantic test', () => {
    const problems: string[] = [];
    for (const exp of SQL_HAZARD_EXPANSIONS) {
      if (!exp.reason.trim()) problems.push(`${exp.file} × ${exp.hazard}: empty reason`);
      if (!exp.semanticTest.trim() || !existsSync(join(REPO_ROOT, exp.semanticTest))) {
        problems.push(`${exp.file} × ${exp.hazard}: semanticTest '${exp.semanticTest}' does not exist`);
      }
      if (exp.added <= 0) problems.push(`${exp.file} × ${exp.hazard}: non-positive expansion`);
    }
    expect(problems).toEqual([]);
  });

  it('every SQL sink call site is accounted for (debt/schema counts pinned; zones named)', () => {
    const counts = new Map<string, number>();
    for (const c of sinks.flatMap(s => s.calls)) {
      counts.set(c.file, (counts.get(c.file) ?? 0) + 1);
    }
    const inventoryByFile = new Map(SQL_CALLER_INVENTORY.map(e => [e.file, e]));
    const problems: string[] = [];
    for (const [file, count] of [...counts.entries()].sort()) {
      const entry = inventoryByFile.get(file);
      if (!entry) {
        problems.push(`${file}: ${count} sink calls but no ledger entry — new SQL callers outside the ledger are refused`);
        continue;
      }
      if (entry.count !== undefined && entry.count !== count) {
        problems.push(`${file}: ${count} sink calls, ledger pins ${entry.count} — update the ledger consciously (debt is shrink-only)`);
      }
    }
    for (const entry of SQL_CALLER_INVENTORY) {
      if (!counts.has(entry.file)) {
        problems.push(`${entry.file}: ledger entry is stale (no sink calls in tree) — delete the row`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('every SQL-caller row is on the owner surface its zone names (#task:1983 W8)', () => {
    // Without this the ledger above is satisfiable by the offender: a new
    // `src/services/*.ts` that calls `db.prepare()` and adds itself with
    // `zone: 'repository'` matches its own row and every gate stays green. The
    // zone is a claim about which module owns persisted state, so it is checked
    // against that surface — statement capability is not something a consumer
    // layer can label its way into.
    expect(
      zoneSurfaceViolations(SQL_CALLER_INVENTORY, 'sql-caller'),
      'a SQL-caller row claims a zone it is not on. Issuing SQL is a persistence privilege: put the query in a ' +
        'repository/read-model under src/repos/ or src/read-model/, or ask one for the fact you need',
    ).toEqual([]);
  });

  it('dynamic (statically unresolvable) SQL sink arguments match the ledger exactly — never silently skipped', () => {
    const counts = new Map<string, number>();
    for (const d of sinks.flatMap(s => s.dynamic)) {
      const key = `${d.file}\u0000${d.fn}\u0000${d.sink}\u0000${d.exprKind}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const actual = [...counts.entries()]
      .map(([key, count]) => {
        const [file = '', fn = '', sink = '', exprKind = ''] = key.split('\u0000');
        return { file, fn, sink, exprKind, count };
      })
      .sort((a, b) => (a.file + a.fn + a.sink + a.exprKind < b.file + b.fn + b.sink + b.exprKind ? -1 : 1));
    const expected = DYNAMIC_SQL_INVENTORY.map(d => ({
      file: d.file,
      fn: d.fn,
      sink: d.sink,
      exprKind: d.exprKind,
      count: d.count,
    })).sort((a, b) => (a.file + a.fn + a.sink + a.exprKind < b.file + b.fn + b.sink + b.exprKind ? -1 : 1));
    expect(
      actual,
      'dynamic SQL expressions drifted from the ledger. A sink argument the scanner cannot resolve to a ' +
        'literal/template/static const is a hazard-gate escape hatch; new ones need a ledger entry with a ' +
        'reason explaining where the literals are harvested. Current tree state:\n' +
        asInventoryLines(actual),
    ).toEqual(expected);
  });

  it('better-sqlite3 API-surface hazards (lastInsertRowid, tx modes) match the ledger exactly', () => {
    const actual = scope
      .flatMap(scanApiHazards)
      .sort((a, b) => (a.file + a.fn + a.api < b.file + b.fn + b.api ? -1 : 1));
    const expected = [...API_HAZARD_INVENTORY].sort((a, b) =>
      a.file + a.fn + a.api < b.file + b.fn + b.api ? -1 : 1,
    );
    expect(
      actual,
      'API-surface hazard set drifted. lastInsertRowid and immediate()/exclusive() calls are per-site ' +
        'ledgered; new ones need justification. Current tree state:\n' +
        asInventoryLines(actual),
    ).toEqual(expected);
  });

  it('fence self-test: non-prepare forms and indirection are detected', () => {
    // (a) hazard inside db.exec('...') — SQL-shape prong, no db-named receiver needed
    const execProbe = scanSqlSinks({ path: 'probe.ts', src: "handle.exec('BEGIN IMMEDIATE');" });
    expect(execProbe.calls).toEqual([{ file: 'probe.ts', fn: '<module>', sink: 'exec' }]);

    // (b) hazard reaches the ledger through a same-file const, counted at definition
    const constSrc = "const SQL = 'INSERT OR IGNORE INTO x VALUES (?)';\ndb.prepare(SQL).run(1);";
    const constLiterals = harvestLiterals({ path: 'probe.ts', src: constSrc });
    expect(scanSqlHazards(constLiterals)).toEqual([
      { file: 'probe.ts', hazard: 'insert_or_action', count: 1 },
    ]);
    expect(scanSqlSinks({ path: 'probe.ts', src: constSrc }).dynamic).toEqual([]);

    // (c) API-form pragma is counted as a pragma hazard even with no PRAGMA literal
    const pragmaProbe = scanSqlSinks({ path: 'probe.ts', src: "db.pragma('journal_mode = WAL');" });
    expect(scanSqlHazards(pragmaProbe.pragmaOccurrences)).toEqual([
      { file: 'probe.ts', hazard: 'pragma_statement', count: 1 },
    ]);

    // (d) unresolvable sink argument is recorded, not skipped
    const dyn = scanSqlSinks({ path: 'probe.ts', src: 'db.prepare(buildSql(kind)).run();' });
    expect(dyn.dynamic).toEqual([
      { file: 'probe.ts', fn: '<module>', sink: 'prepare', exprKind: 'CallExpression' },
    ]);

    // (e) member-access hazards that carry no SQL text at all
    const api = scanApiHazards({
      path: 'probe.ts',
      src: 'const id = stmt.run().lastInsertRowid;\ndb.transaction(() => {}).exclusive();',
    });
    expect(api.map(a => a.api).sort()).toEqual(['lastInsertRowid', 'transaction_exclusive']);

    // (f) the ONLY exec exemption is a direct regex literal receiver — a
    // ruled boundary, not a heuristic: SQL-verb allowlists and file-level
    // "regex const" sets were both bypassed by review probes.
    expect(scanSqlSinks({ path: 'probe.ts', src: '/^a+$/.exec(line);' }).calls).toEqual([]);
    expect(scanSqlHazards(harvestLiterals({ path: 'probe.ts', src: "const msg = 'click -> done';" }))).toEqual([]);
    // review probes: legal SQLite verbs missing from any allowlist still count
    expect(scanSqlSinks({ path: 'probe.ts', src: "db.exec('REPLACE INTO t(id) VALUES (1)');" }).calls).toEqual([
      { file: 'probe.ts', fn: '<module>', sink: 'exec' },
    ]);
    expect(scanSqlSinks({ path: 'probe.ts', src: "db.exec('END TRANSACTION');" }).calls.length).toBe(1);
    // review probe: shadowing a regex const with a db binding cannot dodge the sink
    const shadowed = scanSqlSinks({
      path: 'probe.ts',
      src: 'const runner = /x/;\nfunction f() {\n  const runner = db;\n  runner.exec(buildSql());\n}',
    });
    expect(shadowed.calls).toEqual([{ file: 'probe.ts', fn: 'f', sink: 'exec' }]);
    expect(shadowed.dynamic.length).toBe(1);
    // accepted cost of the ruled boundary: non-regex-literal receivers are
    // sinks even when they are provably not a DB to a human reader
    expect(scanSqlSinks({ path: 'probe.ts', src: "cp.exec('ls -la');" }).calls.length).toBe(1);

    // (g) review probes: alias/namespace/arbitrary-receiver forms cannot dodge the sinks
    const aliased = scanSqlSinks({
      path: 'probe.ts',
      src: "import { prepareObserved as p } from './x.js';\np(db, 'n', 'SELECT 1');",
    });
    expect(aliased.calls).toEqual([{ file: 'probe.ts', fn: '<module>', sink: 'prepareObserved' }]);
    expect(aliased.dynamic).toEqual([]);
    const namespaced = scanSqlSinks({
      path: 'probe.ts',
      src: "import * as obs from './x.js';\nobs.prepareObserved(db, 'n', buildSql());",
    });
    expect(namespaced.calls).toEqual([{ file: 'probe.ts', fn: '<module>', sink: 'prepareObserved' }]);
    expect(namespaced.dynamic.length).toBe(1);
    const anyReceiverExec = scanSqlSinks({ path: 'probe.ts', src: 'runner.exec(buildSql());' });
    expect(anyReceiverExec.calls).toEqual([{ file: 'probe.ts', fn: '<module>', sink: 'exec' }]);
    expect(anyReceiverExec.dynamic).toEqual([
      { file: 'probe.ts', fn: '<module>', sink: 'exec', exprKind: 'CallExpression' },
    ]);
  });

  it('fence self-test: cross-file const resolution keeps helper-forwarded SQL out of the dynamic ledger', () => {
    const lib = { path: 'lib.ts', src: "export const Q = 'SELECT rowid FROM t';" };
    const user = { path: 'user.ts', src: "import { Q } from './lib.js';\ndb.prepare(Q).all();" };
    const resolver2 = buildCorpusResolver([lib, user]);
    expect(scanSqlSinks(user, resolver2).dynamic).toEqual([]);
    // and the hazard is still counted — at the definition site
    expect(scanSqlHazards(harvestLiterals(lib))).toEqual([
      { file: 'lib.ts', hazard: 'rowid_reference', count: 1 },
    ]);
  });

  it('every hazard rule id used by the ledger exists', () => {
    const ids = new Set(SQL_HAZARD_RULES.map(r => r.id));
    const unknown = SQL_HAZARD_INVENTORY.filter(e => !ids.has(e.hazard)).map(e => e.hazard);
    expect(unknown).toEqual([]);
  });
});
