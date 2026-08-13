/**
 * Gate 4 — native SQL stays out of new business tests.
 *
 * Business behavior is tested through semantic fixtures and repository/
 * use-case contracts (tests/utils/test-context.ts); native statement calls in
 * tests are either white-box by nature (schema, migrations, query plans,
 * differential oracles — named with reasons) or pinned debt that only
 * shrinks. A brand-new test file with native SQL fails this gate.
 */
import { describe, expect, it } from 'vitest';
import { buildCorpusResolver, countTestNativeSql } from './scan.js';
import { TEST_NATIVE_SQL_DEBT, TEST_WHITEBOX_INVENTORY } from './inventory.js';
import { allTestSources, asInventoryLines } from './sources.js';

describe('db-boundary: native SQL in tests', () => {
  it('per-file native statement counts match the ledger exactly (whitebox pinned too)', () => {
    const tests = allTestSources();
    const resolver = buildCorpusResolver(tests);
    const whiteboxByFile = new Map(TEST_WHITEBOX_INVENTORY.map(e => [e.file, e.count]));
    const debtByFile = new Map(TEST_NATIVE_SQL_DEBT.map(e => [e.file, e.count]));
    const problems: string[] = [];
    const seen = new Set<string>();
    for (const entry of tests) {
      const count = countTestNativeSql(entry, resolver);
      if (count === 0) continue;
      seen.add(entry.path);
      const whiteboxPinned = whiteboxByFile.get(entry.path);
      if (whiteboxPinned !== undefined) {
        if (whiteboxPinned !== count) {
          problems.push(
            `${entry.path}: ${count} native statement calls, whitebox ledger pins ${whiteboxPinned} — whitebox is ` +
              'not an unbounded escape hatch; any growth is an explicit ledger edit under review',
          );
        }
        continue;
      }
      const pinned = debtByFile.get(entry.path);
      if (pinned === undefined) {
        problems.push(
          `${entry.path}: ${count} native statement calls in a file outside the ledger — new tests go through ` +
            'tests/utils/test-context.ts builders and repository/service contracts, not raw SQL',
        );
      } else if (pinned !== count) {
        problems.push(
          `${entry.path}: ${count} native statement calls, ledger pins ${pinned} — debt is shrink-only; ` +
            'lowering is a ledger edit, raising needs review',
        );
      }
    }
    for (const entry of TEST_NATIVE_SQL_DEBT) {
      if (!seen.has(entry.file)) {
        problems.push(`${entry.file}: stale debt row (no native calls found) — delete the ledger row`);
      }
    }
    for (const entry of TEST_WHITEBOX_INVENTORY) {
      if (!seen.has(entry.file)) {
        problems.push(`${entry.file}: stale whitebox row (no native calls found) — delete the ledger row`);
      }
    }
    expect(problems, `\n${problems.join('\n')}\n`).toEqual([]);
  });

  it('whitebox entries carry reasons; ledgers do not overlap', () => {
    expect(TEST_WHITEBOX_INVENTORY.filter(e => !e.reason.trim())).toEqual([]);
    const whitebox = new Set(TEST_WHITEBOX_INVENTORY.map(e => e.file));
    expect(TEST_NATIVE_SQL_DEBT.filter(e => whitebox.has(e.file))).toEqual([]);
    // A debt row's `reason` is optional (it only annotates a REVIEWED raise), but
    // a present-and-blank one is worse than none: it reads as "this growth was
    // justified" while recording nothing. Absent or substantive, never theatre.
    expect(
      TEST_NATIVE_SQL_DEBT.filter(e => e.reason !== undefined && !e.reason.trim()),
    ).toEqual([]);
  });

  it('fence self-test: native statement shapes in a synthetic test file are counted', () => {
    const src = [
      "const row = ctx.db.prepare('SELECT 1').get();",
      "ctx.db.exec('UPDATE tasks SET status = «x»');",
      "db.pragma('foreign_keys = OFF');",
      'db.prepare(buildSql()).run();', // dynamic arg still counts
      'openTestDb();', // semantic helper does not
      '/^x$/.exec(line);', // RegExp.exec does not
    ].join('\n');
    expect(countTestNativeSql({ path: 'probe.test.ts', src })).toBe(4);
    expect(countTestNativeSql({ path: 'clean.test.ts', src: 'const app = buildTestApp();' })).toBe(0);
    // review probes: alias and arbitrary-receiver dynamic exec cannot dodge the count
    expect(
      countTestNativeSql({
        path: 'probe.test.ts',
        src: "import { prepareObserved as p } from '../../src/observability/observed-statement.js';\np(db, 'n', 'SELECT 1');",
      }),
    ).toBe(1);
    expect(countTestNativeSql({ path: 'probe.test.ts', src: 'runner.exec(buildSql());' })).toBe(1);
    // ruled boundary: only a direct regex LITERAL receiver is exempt; an
    // identifier receiver counts even when a human can see it is a RegExp
    // (file-level const proofs were shadowable — review probe)
    expect(
      countTestNativeSql({ path: 'probe.test.ts', src: 'const re = /^a$/;\nre.exec(line);' }),
    ).toBe(1);
  });

  it('debt total is visible for trend reading (not a gate)', () => {
    const total = TEST_NATIVE_SQL_DEBT.reduce((s, e) => s + e.count, 0);
    expect(total).toBeGreaterThan(0);
    // eslint-disable-next-line no-console
    console.info(
      `db-boundary: ${TEST_NATIVE_SQL_DEBT.length} test files carry ${total} pinned native statement calls; ` +
        `${TEST_WHITEBOX_INVENTORY.length} whitebox files are exempt by reason.\n` +
        asInventoryLines([{ note: 'see TEST_NATIVE_SQL_DEBT in inventory.ts' }]),
    );
  });
});
