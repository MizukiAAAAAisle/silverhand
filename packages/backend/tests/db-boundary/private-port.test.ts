/**
 * Gate 8 — `authorizationReads` stays private to its one consumer.
 *
 * Gates 1–7 fence CAPABILITIES: who may name the driver, who may issue SQL, who
 * may decode dialect. This gate fences an AUDIENCE. `authorizationReads` is a
 * read-only view of exactly the facts access decisions need, and its whole value
 * is that every "may this principal do X" predicate in the process reads from
 * one file. Nothing about a second consumer fails to compile — it just turns a
 * decision port into a convenient query shortcut, silently.
 *
 * Two halves, deliberately separate:
 *
 *  - EXACT LEDGER: the per-file × per-kind counts match the tree. This is what
 *    makes a moved read a visible diff rather than an accounting wash.
 *  - ZONE RULE: a `read` outside the `consumer` zone is a violation on its own,
 *    checked against the zone rather than against the row's own count — so the
 *    only way to legalise a new reader is to declare it a consumer in the
 *    ledger, in review, by name.
 *
 * Named limit: this is a syntactic name match, not dataflow. A file that takes
 * `AuthorizationReadPort` as a parameter and calls `port.workspace(id)` never
 * writes the member name and is invisible here — that is what Gate 5's
 * port/concrete fencing and the `authorization-ports.ts` single-implementation
 * rule are for. What this gate closes is the reachability that actually exists
 * in the tree: the port hangs off both the context AND the persistence bag that
 * every route receives, and either spelling would otherwise be one line away.
 */
import { describe, expect, it } from 'vitest';
import { scanPortUses, type PortUseKind } from './scan.js';
import { AUTHORIZATION_PORT_INVENTORY } from './inventory.js';
import { allProductionSources } from './sources.js';

const PORT = 'authorizationReads';

interface Row {
  file: string;
  reads: number;
  installs: number;
  declares: number;
}

function tally(files: ReturnType<typeof allProductionSources>): Row[] {
  const byFile = new Map<string, Row>();
  for (const entry of files) {
    for (const use of scanPortUses(entry, PORT)) {
      const row = byFile.get(use.file) ?? { file: use.file, reads: 0, installs: 0, declares: 0 };
      if (use.kind === 'read') row.reads += 1;
      else if (use.kind === 'install') row.installs += 1;
      else row.declares += 1;
      byFile.set(use.file, row);
    }
  }
  return [...byFile.values()].sort((a, b) => (a.file < b.file ? -1 : 1));
}

describe('db-boundary: authorizationReads is a private port', () => {
  const actual = tally(allProductionSources());

  it('the use set matches the ledger exactly, per file and per kind', () => {
    const expected = AUTHORIZATION_PORT_INVENTORY.map(e => ({
      file: e.file,
      reads: e.reads,
      installs: e.installs,
      declares: e.declares,
    })).sort((a, b) => (a.file < b.file ? -1 : 1));
    expect(
      actual,
      'authorizationReads use set drifted from the ledger. A new READ means a second module is deciding ' +
        'access from its own facts: take the repo/port your module actually needs, or argue in review why ' +
        'the authorization surface should stop being one file. A new INSTALL means a second supplier of ' +
        'the same facts. Current tree state:\n' +
        actual.map(r => `  ${r.file}: reads=${r.reads} installs=${r.installs} declares=${r.declares}`).join('\n'),
    ).toEqual(expected);
  });

  it('only the consumer zone reads the port — boot may forward it, not ask it', () => {
    const readersOutsideConsumer = AUTHORIZATION_PORT_INVENTORY.filter(
      e => e.zone !== 'consumer' && e.reads > 0,
    );
    // Boot's single forward is the one legal exception and it is bounded to one
    // read: `authorizationReads: persistence.authorizationReads` in the context
    // literal. A second read in that file would be boot answering an
    // authorization question, which is a rule living in the composition root.
    expect(
      readersOutsideConsumer.map(e => `${e.file} (${e.zone}): ${e.reads}`),
      'a non-consumer zone reads the port more than the single boot forward allows',
    ).toEqual(['packages/backend/src/index.ts (composition): 1']);
    expect(
      AUTHORIZATION_PORT_INVENTORY.filter(e => e.zone === 'consumer').map(e => e.file),
      'the consumer zone is a singleton by construction: the point of the port is that ONE file holds ' +
        'every access predicate',
    ).toEqual(['packages/backend/src/permissions.ts']);
  });

  it('every ledger row says what its use of the port is for', () => {
    expect(AUTHORIZATION_PORT_INVENTORY.filter(e => !e.reason.trim()).map(e => e.file)).toEqual([]);
  });

  it('fence self-test: every spelling of a use is detected, on any receiver', () => {
    const probes: Array<[string, PortUseKind]> = [
      ['function f(ctx: BackendContext) { return ctx.authorizationReads.workspace(1); }', 'read'],
      ["function f(p: Persistence) { return p.authorizationReads.agent(1); }", 'read'],
      ["function f(x: unknown) { return (x as any)['authorizationReads']; }", 'read'],
      ['function f(ctx: BackendContext) { const { authorizationReads } = ctx; return authorizationReads; }', 'read'],
      ['function f({ authorizationReads }: BackendContext) { return authorizationReads; }', 'read'],
      ['function f(ctx: BackendContext) { const { authorizationReads: r } = ctx; return r; }', 'read'],
      ['const ctx = { authorizationReads: reads };', 'install'],
      ['const ctx = { authorizationReads };', 'install'],
      ['interface C { authorizationReads: AuthorizationReadPort; }', 'declare'],
      ['class C { readonly authorizationReads!: AuthorizationReadPort; }', 'declare'],
    ];
    for (const [src, kind] of probes) {
      const got = scanPortUses({ path: 'probe.ts', src }, PORT);
      expect(got.length, `not detected: ${src}`).toBe(1);
      expect(got[0]?.kind, `wrong kind for: ${src}`).toBe(kind);
    }
  });

  it('fence self-test: an aliased receiver cannot launder a read', () => {
    // The bypass a context-typed scan would miss. `deps` names no context type
    // and is not the persistence bag; matching by NAME is what catches it.
    const laundered =
      'function f(deps: { authorizationReads: unknown }) {\n' +
      '  const port = deps.authorizationReads;\n' +
      '  return port;\n' +
      '}';
    expect(scanPortUses({ path: 'probe.ts', src: laundered }, PORT).map(u => u.kind)).toEqual([
      'declare',
      'read',
    ]);
  });

  it('fence self-test: prose and unrelated members stay silent', () => {
    const negatives = [
      '// authorizationReads is permissions.ts private port\nexport const x = 1;',
      '/** installed on the context as `authorizationReads` */\nexport const y = 2;',
      'function f(ctx: BackendContext) { return ctx.authorizationReadsLegacy; }',
      "function f(ctx: BackendContext) { return ctx['authorizationReadsLegacy']; }",
    ];
    for (const src of negatives) {
      expect(scanPortUses({ path: 'probe.ts', src }, PORT), `false positive: ${src}`).toEqual([]);
    }
  });
});
