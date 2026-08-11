/**
 * Gate 3 — transaction ownership and atomic-boundary hygiene.
 *
 * Every `.transaction(` call site is ledgered by file + enclosing named
 * function + mode, so an atomic boundary cannot move or appear without a
 * reviewable diff. Transaction callbacks must stay synchronous and free of
 * directly-invoked external effects; the post-commit idiom
 * (`effects.push(() => publish(...))`) is naturally exempt because the call
 * sits in a nested closure.
 *
 * Honest limit (documented in docs/db-boundary.md): the callback scan sees
 * DIRECT calls in the callback's own scope. An effect hidden two helpers deep
 * is invisible here — that stays a review concern, not a proven property.
 */
import { describe, expect, it } from 'vitest';
import { scanTransactions } from './scan.js';
import { TX_CALLBACK_EXEMPTIONS, TX_INVENTORY } from './inventory.js';
import { allProductionSources, asInventoryLines, sqlScopeSources } from './sources.js';

describe('db-boundary: transaction ownership', () => {
  const scope = sqlScopeSources(allProductionSources());
  const scans = scope.map(scanTransactions);

  it('transaction call sites match the ledger exactly (file + function + mode)', () => {
    const counts = new Map<string, number>();
    for (const site of scans.flatMap(s => s.sites)) {
      const key = `${site.file}\u0000${site.fn}\u0000${site.mode}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const actual = [...counts.entries()]
      .map(([key, count]) => {
        const [file = '', fn = '', mode = ''] = key.split('\u0000');
        return { file, fn, mode, count };
      })
      .sort((a, b) => (a.file + a.fn + a.mode < b.file + b.fn + b.mode ? -1 : 1));
    const expected = TX_INVENTORY.map(e => ({ file: e.file, fn: e.fn, mode: e.mode, count: e.count })).sort(
      (a, b) => (a.file + a.fn + a.mode < b.file + b.fn + b.mode ? -1 : 1),
    );
    expect(
      actual,
      'transaction sites drifted from the ledger. New atomic boundaries need an owner entry (use-case/service/' +
        'auth); a NEW repo-internal transaction is refused unless its ledger reason explains why the invariant ' +
        'cannot live with the calling owner. Current tree state:\n' +
        asInventoryLines(actual),
    ).toEqual(expected);
  });

  it('every repo-internal ledger entry explains its atomicity ownership', () => {
    const missing = TX_INVENTORY.filter(e => e.owner === 'repo-internal' && !e.reason?.trim());
    expect(missing.map(e => `${e.file} ${e.fn}`)).toEqual([]);
  });

  it('transaction callbacks are synchronous and free of directly-invoked external effects', () => {
    const exempt = new Set(TX_CALLBACK_EXEMPTIONS.map(e => `${e.file}\u0000${e.fn}\u0000${e.violation}`));
    const violations = scans
      .flatMap(s => s.violations)
      .filter(v => !exempt.has(`${v.file}\u0000${v.fn}\u0000${v.violation}`))
      .map(v => `${v.file} ${v.fn}: ${v.violation}`);
    expect(
      violations,
      'a transaction callback awaits, chains promises, or directly invokes an effect surface. Move the effect ' +
        'after commit (post-commit idiom: collect closures inside the tx, drain after it returns).',
    ).toEqual([]);
  });

  it('exemption ledger carries no stale rows', () => {
    const actual = new Set(
      scans.flatMap(s => s.violations).map(v => `${v.file}\u0000${v.fn}\u0000${v.violation}`),
    );
    const stale = TX_CALLBACK_EXEMPTIONS.filter(
      e => !actual.has(`${e.file}\u0000${e.fn}\u0000${e.violation}`),
    );
    expect(stale.map(e => `${e.file} ${e.fn}`)).toEqual([]);
  });

  it('fence self-test: every violation class reddens; the post-commit idiom does not', () => {
    const red = (src: string, expected: RegExp): void => {
      const { violations } = scanTransactions({ path: 'probe.ts', src });
      expect(
        violations.some(v => expected.test(v.violation)),
        `not detected: ${src}\ngot: ${JSON.stringify(violations)}`,
      ).toBe(true);
    };
    red('db.transaction(async () => { x(); })();', /async transaction callback/);
    red('db.transaction(async () => { await q(); })();', /await inside/);
    red('db.transaction(() => { fetchRows().then(use); })();', /promise \.then\(\)/);
    red('db.transaction(() => { publishMemberAdded(evt); })();', /effect call publishMemberAdded/);
    red('db.transaction(() => { this.bus.broadcastAll(evt); })();', /effect call \.broadcastAll/);
    red('db.transaction(() => { fetch(url); })();', /fetch\(\) inside/);
    red('db.transaction(() => { setTimeout(fn, 10); })();', /setTimeout\(\) inside/);
    red('db.transaction(() => { runPostCommitEffects(effects); })();', /post-commit drain/);
    red("import { writeFileSync } from 'node:fs';\ndb.transaction(() => { writeFileSync(p, d); })();", /fs call/);
    red("import * as fs from 'node:fs';\ndb.transaction(() => { fs.rmSync(p); })();", /fs call via 'fs'/);
    red('db.transaction(handler)();', /not an inline function/);
    // review probe: import aliasing cannot dodge the effect pattern
    red(
      "import { publishMemberAdded as emit } from './events.js';\ndb.transaction(() => { emit(evt); })();",
      /effect call emit\(\) \(imported as publishMemberAdded\)/,
    );

    // negative controls — the sanctioned shapes stay green
    const ok = (src: string): void => {
      expect(scanTransactions({ path: 'probe.ts', src }).violations).toEqual([]);
    };
    ok('db.transaction(() => { effects.push(() => publishMemberAdded(evt)); insert(row); })();');
    ok('db.transaction(() => { const n = this.store.assignSelf(id); return n; })();');
    ok("import { writeFileSync } from 'node:fs';\ndb.transaction(() => { rows.push(1); })(); writeFileSync(p, d);");
    // aliasing a NON-effect import to an effect-looking local name stays green (imported name wins)
    ok("import { insertRow as publishRow } from './rows.js';\ndb.transaction(() => { publishRow(r); })();");
    // documented residual, NOT covered: purely local rebinding has no import edge
    ok('const send = events.publishToScope.bind(events);\ndb.transaction(() => { send(evt); })();');
    // mode keying: stored tx surfaces as a site with mode=stored
    const stored = scanTransactions({
      path: 'probe.ts',
      src: 'const tx = db.transaction(() => {}); tx.immediate();',
    });
    expect(stored.sites).toEqual([{ file: 'probe.ts', fn: '<module>', mode: 'stored' }]);
  });
});
