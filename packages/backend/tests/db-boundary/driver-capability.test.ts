/**
 * Gate 2b — the driver capabilities that are neither SQL nor transactions.
 *
 * Gates 2 and 3 fence `prepare`/`exec`/`pragma` and `transaction`. That leaves
 * nine more methods on better-sqlite3's `Database`, and they are not minor:
 * `loadExtension` loads native code, `function`/`aggregate`/`table` put
 * JavaScript inside the query planner (so a "SQL-free" file could define
 * behaviour the schema then depends on), `serialize`/`backup` copy the whole
 * database out, `unsafeMode` disables the driver's own guardrails,
 * `defaultSafeIntegers` silently changes the type of every integer the app
 * reads, and `close` ends the handle's life under everyone else still using it.
 *
 * Three parts:
 *
 *  - ABSENT SET (2b-A): eight of them appear NOWHERE in the production tree —
 *    receiver-independent, no ledger, zero. Affordable precisely because the
 *    names are unused: a name match cannot be argued with, and there is nothing
 *    to grandfather.
 *  - CLOSE (2b-B): `close` is a real name elsewhere (sockets, servers, streams),
 *    so it is narrowed to receivers that hold a driver handle and pinned to an
 *    exact file × function ledger.
 *  - CATALOGUE PIN: the method set the installed `@types/better-sqlite3`
 *    declares must equal the set this file assigns to gates. A driver upgrade
 *    that adds a capability reddens here rather than arriving unfenced.
 *
 * Named limit for 2b-B, deliberately not papered over: the narrowing is
 * single-file syntax over bindings traceable to `openDatabase()` or to a driver
 * type annotation. A handle handed to a function in ANOTHER file, or reached
 * through `as unknown as`, is invisible to it — that is Gate 1's job (only
 * ledger files may name the driver type) and Gate 5's (concrete adapters stay
 * behind ports). The self-tests below pin both the reach and the limit.
 */
import { describe, expect, it } from 'vitest';
import {
  DRIVER_METHODS_ABSENT,
  DRIVER_METHOD_GATES,
  declaredDriverMethods,
  driverHandleBindings,
  parse,
  scanDriverHandleCalls,
  scanMethodCallsByName,
} from './scan.js';
import { DRIVER_CLOSE_INVENTORY } from './inventory.js';
import { allProductionSources, REPO_ROOT } from './sources.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DRIVER_TYPES_CANDIDATES = [
  'packages/backend/node_modules/@types/better-sqlite3/index.d.ts',
  'node_modules/@types/better-sqlite3/index.d.ts',
];

describe('db-boundary: driver capability surface', () => {
  const sources = allProductionSources();

  it('the dangerous-capability set is absent from production, not ledgered (2b-A)', () => {
    const found = sources.flatMap(e => scanMethodCallsByName(e, DRIVER_METHODS_ABSENT));
    expect(
      found.map(c => `${c.file} ${c.fn}: ${c.receiver}.${c.method}()`),
      'a production file names one of the driver capabilities this wall keeps at zero. There is no ledger ' +
        'row to add: extension loading, user-defined functions/aggregates/virtual tables, whole-database ' +
        'serialize/backup, unsafeMode and defaultSafeIntegers are all engine-level powers that would make ' +
        'the app depend on SQLite in ways no port can express. If one is genuinely needed, it belongs ' +
        'behind a named persistence port with its own contract test, and this gate should be told about it ' +
        'in review — not extended quietly.',
    ).toEqual([]);
  });

  it('handle close() matches the ledger exactly, per file and function (2b-B)', () => {
    const actual = sources
      .flatMap(e => scanDriverHandleCalls(e, ['close']))
      .map(c => ({ file: c.file, fn: c.fn }))
      .sort((a, b) => (a.file === b.file ? (a.fn < b.fn ? -1 : 1) : a.file < b.file ? -1 : 1));
    const expected = DRIVER_CLOSE_INVENTORY.map(e => ({ file: e.file, fn: e.fn })).sort((a, b) =>
      a.file === b.file ? (a.fn < b.fn ? -1 : 1) : a.file < b.file ? -1 : 1,
    );
    expect(
      actual,
      'driver close() sites drifted from the ledger. Closing a handle someone else is still using is a ' +
        'process-wide failure, so each site must name the entrypoint whose handle it ends. Current tree ' +
        'state:\n' + actual.map(c => `  ${c.file} (${c.fn})`).join('\n'),
    ).toEqual(expected);
  });

  it('every close() row names the entrypoint whose handle it ends', () => {
    expect(DRIVER_CLOSE_INVENTORY.filter(e => !e.reason.trim()).map(e => e.file)).toEqual([]);
  });

  it('a file may only close a handle it opened itself', () => {
    // The rule behind the ledger, checked mechanically rather than trusted from
    // the reasons: every closing file also calls `openDatabase`. A file that
    // closes a handle it RECEIVED is the shape that produces "closed under the
    // writer" — and it is the only shape a small ledger cannot rule out on its
    // own, because the row would look identical.
    const opensItsOwn = new Map<string, boolean>();
    for (const entry of sources) {
      if (!DRIVER_CLOSE_INVENTORY.some(e => e.file === entry.path)) continue;
      opensItsOwn.set(entry.path, /\bopenDatabase\s*\(/.test(entry.src));
    }
    expect(
      [...opensItsOwn.entries()].filter(([, opens]) => !opens).map(([file]) => file),
      'a file closes a driver handle without opening one. Closing what you were handed ends a lifetime ' +
        'someone else owns; give the handle back to its opener and let that scope close it.',
    ).toEqual([]);
    // And every ledgered file was actually seen — a row for a deleted file would
    // otherwise pass this check by being absent from the corpus.
    expect(
      DRIVER_CLOSE_INVENTORY.map(e => e.file).filter(f => !opensItsOwn.has(f)),
      'a ledger row names a file that is not in the production corpus',
    ).toEqual([]);
  });

  it('the installed driver declares exactly the methods this wall assigns to gates', () => {
    const rel = DRIVER_TYPES_CANDIDATES.find(p => existsSync(join(REPO_ROOT, p)));
    expect(rel, `@types/better-sqlite3 not found at any of: ${DRIVER_TYPES_CANDIDATES.join(', ')}`)
      .toBeDefined();
    const declared = declaredDriverMethods({
      path: rel as string,
      src: readFileSync(join(REPO_ROOT, rel as string), 'utf8'),
    });
    expect(declared, 'the `Database` interface is no longer declared in the driver types — this pin stopped looking')
      .not.toBeNull();
    expect(
      [...new Set(declared ?? [])].sort(),
      'the driver\'s capability surface changed. Every method must be assigned to a gate in ' +
        'DRIVER_METHOD_GATES: fence it (add to the absent set), ledger it, or state which existing gate ' +
        'already covers it. An unassigned method is a capability with no wall.',
    ).toEqual(Object.keys(DRIVER_METHOD_GATES).sort());
  });

  it('fence self-test: a handle reaches the close scan through every local form', () => {
    const positives: Array<[string, string]> = [
      ['direct openDatabase result', "const db = openDatabase(p); db.close();"],
      [
        'declared then assigned (the real shape in boot and admin)',
        'let db: ReturnType<typeof openDatabase>;\ndb = openDatabase(p);\nfunction stop() { db.close(); }',
      ],
      [
        'local alias of a handle',
        'const db = openDatabase(p);\nconst h = db;\nh.close();',
      ],
      [
        'alias chain',
        'const db = openDatabase(p);\nconst a = db; const b = a;\nb.close();',
      ],
      [
        'parameter annotated with the driver type',
        "import type { Database as Db } from 'better-sqlite3';\nfunction f(db: Db) { db.close(); }",
      ],
      [
        'class field holding the handle',
        "import type { Database as Db } from 'better-sqlite3';\nclass R { constructor(private readonly db: Db) {} stop() { this.db.close(); } }",
      ],
      [
        'constructed directly from the driver',
        "import Database from 'better-sqlite3';\nconst db = new Database(p);\ndb.close();",
      ],
    ];
    for (const [label, src] of positives) {
      expect(
        scanDriverHandleCalls({ path: 'probe.ts', src }, ['close']).length,
        `not detected: ${label}`,
      ).toBe(1);
    }
  });

  it('fence self-test: unrelated close() calls are not driver closes', () => {
    const negatives: Array<[string, string]> = [
      ['websocket', 'function f(ws: WebSocket) { ws.close(); }'],
      ['http server', 'function f(server: Server) { server.close(); }'],
      ['a repo that holds a handle privately', "import type { Database as Db } from 'better-sqlite3';\nclass R { constructor(private readonly db: Db) {} q(s: Stream) { s.close(); } }"],
      ['same-named local that is not a handle', 'const db = { close() {} };\ndb.close();'],
      ['prose', 'const db = openDatabase(p); // db.close() is boot-owned\nexport { db };'],
    ];
    for (const [label, src] of negatives) {
      expect(
        scanDriverHandleCalls({ path: 'probe.ts', src }, ['close']),
        `false positive: ${label}`,
      ).toEqual([]);
    }
  });

  it('the 2b-B limit is real and stated: a cross-file handle is out of its reach', () => {
    // Proven rather than claimed, so the docs statement can be trusted. The
    // callee names no driver type and takes the handle structurally, so no
    // binding is traceable and the narrowed scan is silent by construction.
    const callee = 'export function shutdown(h: { close(): void }) { h.close(); }';
    expect(
      scanDriverHandleCalls({ path: 'callee.ts', src: callee }, ['close']),
      'if this ever finds the call, the limit stated in the header and docs/db-boundary.md is stale',
    ).toEqual([]);
    expect(driverHandleBindings(parse({ path: 'callee.ts', src: callee })).size).toBe(0);
    // What keeps that file honest is Gate 1: it may not name the driver type, so
    // the structural parameter is the ONLY spelling available to it, and Gate 5
    // keeps such a file from being a repo. The compensating fence, named.
    expect(DRIVER_METHOD_GATES.close).toContain('receiver-narrowed');
  });
});
