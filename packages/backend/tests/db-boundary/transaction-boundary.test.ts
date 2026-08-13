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
import { txOwnershipViolations } from './zones.js';
import { allProductionSources, asInventoryLines, sqlScopeSources } from './sources.js';

/**
 * The HTTP route layer, by path: the entry module plus everything under the
 * route directory. Transaction ownership here is refused outright (#task:1982
 * W5), not ledgered — see the absolute assertion below for why a ledger row
 * cannot substitute for this.
 */
const ROUTE_LAYER_FILE = 'packages/backend/src/routes.ts';
const ROUTE_LAYER_DIR = 'packages/backend/src/routes/';
function isRouteLayer(file: string): boolean {
  return file === ROUTE_LAYER_FILE || file.startsWith(ROUTE_LAYER_DIR);
}

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

  it('mode, owner and surface are judged jointly (#task:1983 W8)', () => {
    // The absolute assertion below covers WHERE for one layer (routes). This
    // covers the rest of the goal, and it covers the label: `owner` is checked
    // against the layer it names, and a NATIVE transaction — every mode except
    // `uow` — is refused outside the persistence surface no matter what owner it
    // claims. A service that reaches for `db.transaction()` and registers itself
    // as `owner: 'service'` was previously a legal row; the transaction is not a
    // classification problem, it is a capability the business layer does not get.
    expect(
      txOwnershipViolations(TX_INVENTORY),
      'a transaction row does not match the layer it claims. A business layer states the atomicity it needs by ' +
        "calling a UnitOfWork port (mode 'uow'); persistence implements it natively",
    ).toEqual([]);
  });

  it('the HTTP route layer opens no transaction — absolute, by path, ledger-independent', () => {
    // Why this is separate from the ledger comparison above: that test only
    // asks "do the sites match the rows?", so a NEW route transaction passes
    // the moment someone adds a row for it. Deleting `route-debt` from the
    // owner union restricted a LABEL, not a location — `owner: 'use-case'` on
    // a `src/routes/*.ts` row would have been accepted. This assertion is
    // about WHERE, so no ledger edit can re-admit it.
    const searched = scope.filter(e => isRouteLayer(e.path)).map(e => e.path);
    // §CG: an absence claim first proves its search domain is non-empty — an
    // empty route scope would make the two assertions below vacuously green.
    expect(searched.length, 'route-layer sources are not in the scanned scope').toBeGreaterThan(1);
    expect(searched, 'the route entry module must be scanned').toContain(
      'packages/backend/src/routes.ts',
    );

    const routeSites = scans.flatMap(s => s.sites).filter(s => isRouteLayer(s.file));
    expect(
      routeSites,
      'a file in the HTTP route layer opens a transaction. This is not a ledger question: an atomic boundary ' +
        'is a domain decision, and a route cannot own one (it has no way to state the invariant, and every ' +
        'authoritative read it made before BEGIN is a stale snapshot). Move it into a use case that takes a ' +
        'UnitOfWork, and let the route map the outcome to a status code.\n' +
        asInventoryLines(routeSites),
    ).toEqual([]);
    expect(
      TX_INVENTORY.filter(e => isRouteLayer(e.file)).map(e => `${e.file} ${e.fn}`),
      'a ledger row claims a transaction in the route layer; the row is the bug, not the fence',
    ).toEqual([]);
  });

  it('fence self-test: the route-layer fence reddens on a synthetic route transaction', () => {
    // Drives the PRODUCTION scanner + the production path predicate, so the
    // assertion above is proven to be capable of failing.
    for (const path of [
      'packages/backend/src/routes.ts',
      'packages/backend/src/routes/hosts.ts',
      'packages/backend/src/routes/nested/deep.ts',
    ]) {
      const { sites } = scanTransactions({
        path,
        src: 'app.patch("/x", c => { ctx.db.transaction(() => { renameHost(); })(); });',
      });
      expect(sites.filter(s => isRouteLayer(s.file)).length, `not detected: ${path}`).toBe(1);
    }
    // the predicate must not sweep up the layers that legitimately own one,
    // including a same-prefix sibling directory
    for (const path of [
      'packages/backend/src/application/update-host.ts',
      'packages/backend/src/repos/host-uow.ts',
      'packages/backend/src/routes-helpers/tx.ts',
    ]) {
      const { sites } = scanTransactions({
        path,
        src: 'export function f() { return db.transaction(() => { w(); })(); }',
      });
      expect(sites.length, `scanner missed a site in ${path}`).toBe(1);
      expect(sites.filter(s => isRouteLayer(s.file)), `false positive: ${path}`).toEqual([]);
    }
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

  it('fence self-test: a keyed UnitOfWork callback is still analyzed, not waved through', () => {
    // The regression this pins: reading the callback as `arguments[0]` turned a
    // coordination-keyed `atomically(key, fn)` into "not an inline function" —
    // one generic complaint INSTEAD of scanning the body, so a real effect inside
    // such a callback would never have been named.
    const keyed = scanTransactions({
      path: 'probe.ts',
      src: 'uow.atomically({ workspaceId, member }, tx => { publishMemberAdded(evt); });',
    });
    expect(keyed.sites).toEqual([{ file: 'probe.ts', fn: '<module>', mode: 'uow' }]);
    expect(keyed.violations.map(v => v.violation)).toEqual([
      'effect call publishMemberAdded() inside transaction callback',
    ]);
    // The sanctioned keyed shape stays green…
    expect(
      scanTransactions({
        path: 'probe.ts',
        src: 'uow.atomically(key, (tx, anchor) => { effects.push(() => publishMemberAdded(evt)); tx.write(anchor); });',
      }).violations,
    ).toEqual([]);
    // …and a callback that is NOT inline is still refused, in the keyed form too.
    expect(
      scanTransactions({ path: 'probe.ts', src: 'uow.atomically(key, handler);' }).violations.map(
        v => v.violation,
      ),
    ).toEqual(['transaction callback is not an inline function (not statically analyzable)']);
  });

  it('fence self-test: a SECOND coordination axis is a ledgered boundary, and the name rule is exact', () => {
    // What this pins (#task:1987): the scan matches `atomically` PLUS an
    // axis-qualified suffix, so a UnitOfWork that grows a second coordination axis
    // (`atomicallyForWorkspace`, `atomicallyInWorkspace`) cannot hide an atomic
    // boundary — or an effect inside one — from this ledger. Without a committed
    // arm, the widening from the bare name would only ever have been proven by a
    // throwaway falsifier.
    for (const method of ['atomicallyForWorkspace', 'atomicallyInWorkspace']) {
      const axis = scanTransactions({
        path: 'probe.ts',
        src: `uow.${method}(workspaceId, tx => { publishMemberAdded(evt); tx.addAgent(id); });`,
      });
      expect(axis.sites, `axis not ledgered: ${method}`).toEqual([
        { file: 'probe.ts', fn: '<module>', mode: 'uow' },
      ]);
      expect(axis.violations.map(v => v.violation), `effect not named: ${method}`).toEqual([
        'effect call publishMemberAdded() inside transaction callback',
      ]);
    }
    // The sanctioned shape on the second axis stays green.
    expect(
      scanTransactions({
        path: 'probe.ts',
        src: 'uow.atomicallyForWorkspace(workspaceId, tx => { effects.push(() => publishMemberAdded(evt)); tx.addAgent(id); });',
      }).violations,
    ).toEqual([]);

    // The boundary of the widening, stated as a test: the suffix must start a NEW
    // camelCase word. A same-prefix name that merely continues the word is a
    // different method, not an axis — it is NOT a transaction point and the scan
    // must not invent one. (Cost of the rule: a production UnitOfWork must name
    // its axes `atomically<Axis>`; a lowercase/digit continuation is invisible
    // here, which is why the naming convention is the load-bearing half.)
    for (const method of ['atomicallyish', 'atomically2', 'atomically_for_workspace']) {
      const nonAxis = scanTransactions({
        path: 'probe.ts',
        src: `helper.${method}(workspaceId, tx => { publishMemberAdded(evt); });`,
      });
      expect(nonAxis.sites, `false positive: ${method}`).toEqual([]);
      expect(nonAxis.violations, `false positive: ${method}`).toEqual([]);
    }
  });
});
