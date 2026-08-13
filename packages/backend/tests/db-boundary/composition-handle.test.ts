/**
 * Gate 6 — the context carries no driver handle.
 *
 * Until #task:1983 W5 this was a shrink-only ledger of who read
 * `BackendContext.db`. There is nothing left to shrink: the field is gone, so a
 * production file that writes `ctx.db` does not compile. This gate keeps the
 * claim standing after that, in the two halves it actually has:
 *
 *  - AVAILABILITY: the production context declares no `db` member, asserted
 *    directly against `src/context.ts`. That is what makes the compile error
 *    real, and it is not implied by "nobody reads it" — someone could re-add a
 *    driver-free `db: unknown` and every reader would typecheck again. Re-adding
 *    a TYPED handle additionally reddens Gate 1 (proven by that gate's ledger
 *    exact-match), so the two together cover both spellings.
 *  - ZERO READERS: the tree-wide scan must find none. Not a ledger with no rows
 *    — an empty ledger still invites the next row. Any reader reddens, and a
 *    `.db` read whose base type this scan cannot decide is a failure too, since
 *    "silently not a context" is exactly how an alias bypass would ride through.
 *
 * Named limits, deliberately not papered over. The load-bearing gate against
 * "some file issues SQL" is the USAGE side — `scanSqlSinks` matches
 * `prepare`/`exec`/`pragma` by property name, independent of where the receiver
 * came from, and `sql-hazards.test.ts` freezes the per-file counts. This gate
 * only narrows REACHABILITY, and it is single-file syntax plus corpus-wide
 * type-name relations, not dataflow: a value that receives a context through
 * inference is invisible here. The last two self-tests below make that division
 * of labour explicit by proving the usage side catches what this side cannot.
 */
import { describe, expect, it } from 'vitest';
import {
  buildContextTypeClosure,
  interfaceMemberNames,
  moduleReferencesOf,
  parse,
  scanContextDbHandle,
  scanContextDbReaders,
  scanPortUses,
  scanSqlSinks,
} from './scan.js';
import { allProductionSources, REPO_ROOT } from './sources.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CONTEXT_FILE = 'packages/backend/src/context.ts';

describe('db-boundary: composition-handle readers', () => {
  const sources = allProductionSources();
  // The closure is corpus-wide on purpose: a context alias exported by one
  // module and imported by another is only visible when both are considered.
  const closure = buildContextTypeClosure(sources);
  const scans = sources.map(e => scanContextDbHandle(e, closure));
  const findings = scans.flatMap(s => s.readers);

  it('the production context declares no handle member (#task:1983 W5)', () => {
    const members = interfaceMemberNames(
      {
        path: CONTEXT_FILE,
        src: readFileSync(join(REPO_ROOT, CONTEXT_FILE), 'utf8'),
      },
      'BackendContext',
    );
    expect(members, `BackendContext is no longer declared in ${CONTEXT_FILE} — this gate stopped looking`)
      .not.toBeNull();
    expect(
      members?.filter(m => m === 'db'),
      'BackendContext declared a `db` member again. The context is a capability bag, not a service ' +
        'locator: anything holding one could then issue any statement without declaring that it touches ' +
        'persistence. Take the repo/port you need in your own deps, and if a TEST needs the running ' +
        "server's handle, use TestBackendContext + startTestBackend from tests/utils/.",
    ).toEqual([]);
  });

  it('no production file reads a handle off the context — zero, not a ledger', () => {
    expect(
      findings.map(f => `${f.file} ${f.fn}: ${f.form}`),
      'a production file reads the driver handle off the context. There is no ledger row to add: the ' +
        'field does not exist on the production type, so this can only be a structurally forged context ' +
        'or a cast. Inject the repo/persistence port the file actually needs.',
    ).toEqual([]);
  });

  it('no `.db` read in the tree rests on an undecidable context type', () => {
    // Fail loud, do not assume innocent: a base annotated with a type whose
    // origin this scan cannot see is neither "a context" nor "not a context".
    const unresolved = scans.flatMap(s => s.unresolved);
    expect(
      unresolved.map(u => `${u.file} ${u.fn}: ${u.base} typed as unresolvable '${u.typeName}'`),
      'a `.db` read is annotated with a type this gate cannot decide. Either the type name has no visible ' +
        'declaration/import in its file (fix the file), or the scan needs to learn that relation — never leave ' +
        'it silent: an undecidable annotation is exactly how an aliased context slips past the ledger.',
    ).toEqual([]);
  });

  it('production code cannot reach the test-only handle subtype (#task:1983 W6)', () => {
    // W5 did not delete the handle from the process — it moved the only way to
    // obtain one into `tests/utils/`. That relocation is worth exactly as much as
    // the fence around it, and it has two failure modes, both checked here.
    //
    // (a) A production file importing anything under `tests/` would make
    // `TestBackendContext` — a context WITH a `db` — a production type again.
    const testImporters: string[] = [];
    for (const entry of sources) {
      for (const ref of moduleReferencesOf(parse(entry))) {
        // A dynamic specifier cannot be decided; fail loud rather than assume.
        if (ref.spec === null) {
          testImporters.push(`${entry.path}: non-literal module specifier (${ref.form})`);
          continue;
        }
        if (/(^|\/)tests\//.test(ref.spec) || ref.spec.includes('/tests/utils')) {
          testImporters.push(`${entry.path}: ${ref.spec}`);
        }
      }
    }
    expect(
      testImporters,
      'a production file reaches into tests/. Besides being backwards, tests/utils/ is where the ' +
        'test-only context subtype that still carries a driver handle lives — importing it re-opens the ' +
        'exact reachability W5 closed.',
    ).toEqual([]);

    // (b) The seam itself: `onDatabaseOpened` may be DECLARED and INVOKED by
    // boot, and SUPPLIED by nobody in production. A production caller passing the
    // hook would be production code receiving the handle through the test door —
    // which no other gate sees, because it names no driver type and issues no SQL.
    const seamUses = sources.flatMap(e =>
      scanPortUses(e, 'onDatabaseOpened').map(u => `${u.file}: ${u.kind}`),
    );
    expect(
      [...seamUses].sort(),
      'the testHooks.onDatabaseOpened seam is boot-declared and boot-invoked only. An `install` in ' +
        'production means a production caller now takes the handle through the test seam; a second file ' +
        'reading it means a second harness door.',
    ).toEqual(['packages/backend/src/index.ts: declare', 'packages/backend/src/index.ts: read']);
  });

  it('fence self-test: no type-alias form can hide a context', () => {
    // Every arm is an ALIASING relation rather than a textual mention of
    // `BackendContext` at the annotation site — the class that used to pass.
    const aliased: Array<[string, string]> = [
      [
        'imported rename',
        "import type { BackendContext as Ctx } from './context.js';\nfunction f(ctx: Ctx) { return ctx.db; }",
      ],
      [
        'value-import rename',
        "import { BackendContext as Ctx } from './context.js';\nfunction f(ctx: Ctx) { return ctx.db; }",
      ],
      [
        'interface extends',
        'interface Ctx extends BackendContext {}\nfunction f(ctx: Ctx) { return ctx.db; }',
      ],
      [
        'interface extends an imported rename',
        "import type { BackendContext as Base } from './context.js';\ninterface Ctx extends Base {}\nfunction f(ctx: Ctx) { return ctx.db; }",
      ],
      [
        'alias of an alias',
        'type A = BackendContext; type B = A;\nfunction f(ctx: B) { return ctx.db; }',
      ],
      [
        'class implements',
        'class Ctx implements BackendContext {}\nfunction f(ctx: Ctx) { return ctx.db; }',
      ],
      [
        'type-parameter constraint',
        'function f<T extends BackendContext>(ctx: T) { return ctx.db; }',
      ],
      [
        're-exported rename, then imported',
        "export { BackendContext as Ctx } from './context.js';\nfunction f(ctx: Ctx) { return ctx.db; }",
      ],
      [
        'aliased context reached by destructuring',
        "import type { BackendContext as Ctx } from './context.js';\nfunction f(ctx: Ctx) { const { db } = ctx; return db; }",
      ],
    ];
    for (const [label, src] of aliased) {
      const scan = scanContextDbHandle({ path: 'probe.ts', src });
      expect(scan.readers.length, `not detected: ${label}`).toBe(1);
      expect(scan.unresolved, `reported as unresolved instead of detected: ${label}`).toEqual([]);
    }
  });

  it('fence self-test: an undecidable annotation at a `.db` read is reported, not ignored', () => {
    const undecidable: Array<[string, string]> = [
      ['no declaration anywhere', 'function f(x: MysteryDeps) { return x.db; }'],
      ['undecidable inside a wrapper type', 'function f(x: Partial<MysteryDeps>) { return x.db; }'],
      ['undecidable at a destructuring read', 'function f({ db }: MysteryDeps) { return db; }'],
    ];
    for (const [label, src] of undecidable) {
      const scan = scanContextDbHandle({ path: 'probe.ts', src });
      expect(scan.readers, `wrongly counted as a reader: ${label}`).toEqual([]);
      expect(scan.unresolved.map(u => u.typeName), `not reported: ${label}`).toEqual(['MysteryDeps']);
    }
    // a decidable non-context stays silent in BOTH channels
    const decided = scanContextDbHandle({
      path: 'probe.ts',
      src: "import type { TaskRepo } from './repos/task-repo.js';\nfunction f(repo: TaskRepo) { return repo.db; }",
    });
    expect(decided.readers).toEqual([]);
    expect(decided.unresolved).toEqual([]);
  });

  it('fence self-test: every way of reaching ctx.db is detected', () => {
    const probes: Array<[string, string]> = [
      ['direct property access', 'function f(ctx: BackendContext) { return ctx.db; }'],
      ['element access', "function f(ctx: BackendContext) { return ctx['db']; }"],
      ['destructuring the context', 'function f(ctx: BackendContext) { const { db } = ctx; return db; }'],
      ['destructuring alias', 'function f(ctx: BackendContext) { const { db: handle } = ctx; return handle; }'],
      ['parameter destructuring', 'function f({ db }: BackendContext) { return db; }'],
      ['context as a member', 'function f(deps: { ctx: BackendContext }) { return deps.ctx.db; }'],
      [
        'class field',
        'class R { constructor(private readonly ctx: BackendContext) {} q() { return this.ctx.db; } }',
      ],
      ['local alias', 'function f(ctx: BackendContext) { const c = ctx; return c.db; }'],
      [
        'type alias + alias chain',
        'type Ctx = BackendContext; function f(ctx: Ctx) { const c = ctx; const d = c; return d.db; }',
      ],
      [
        'destructured context member',
        'function f({ ctx }: { ctx: BackendContext }) { return ctx.db; }',
      ],
      [
        'require-introduced context type',
        "import ctxMod = require('./context.js'); function f(ctx: ctxMod.BackendContext) { return ctx.db; }",
      ],
      [
        'dynamic-import type reference',
        "function f(ctx: import('./context.js').BackendContext) { return ctx.db; }",
      ],
      [
        'as-cast introduced context',
        'function f(raw: unknown) { const ctx = raw as BackendContext; return ctx.db; }',
      ],
    ];
    for (const [label, src] of probes) {
      expect(scanContextDbReaders({ path: 'probe.ts', src }).length, `not detected: ${label}`).toBe(1);
    }
  });

  it('fence self-test: a `db` that is not the composition handle is not flagged', () => {
    const negatives: Array<[string, string]> = [
      ['unrelated object with a db field', 'function f(ctx: { db: string }) { return ctx.db; }'],
      [
        'a repo exposing its own handle',
        "import type { TaskRepo } from './repos/task-repo.js';\nfunction f(repo: TaskRepo) { return repo.db; }",
      ],
      ['prose naming ctx.db', 'function f(ctx: BackendContext) { /* ctx.db is composition-only */ return ctx.logger; }'],
      ['a same-named local that is not a context', 'function f() { const ctx = { db: 1 }; return ctx.db; }'],
      ['another field of the context', 'function f(ctx: BackendContext) { return ctx.dbWriteProbe; }'],
    ];
    for (const [label, src] of negatives) {
      expect(scanContextDbReaders({ path: 'probe.ts', src }), `false positive: ${label}`).toEqual([]);
    }
  });

  // ── The division of labour, proven rather than asserted ──────────────────
  //
  // Both arms below are the bypasses this gate CANNOT see, and both must be
  // caught by the usage side (Gate 2's `scanSqlSinks` + the per-file counts in
  // `sql-hazards.test.ts`). If an arm ever goes green on BOTH sides, the wall has
  // a hole and this test says so at the seam rather than in a postmortem.

  it('closure: a structurally forged context is invisible here and caught by the usage side', () => {
    // No context type is named — `{ db: unknown }` is a decidable NON-context, so
    // Gate 6 stays silent by design (flagging it would flag every `.db` in the
    // tree). The statement call is what gives it away.
    const src =
      "function f(deps: { db: unknown }) {\n" +
      "  return (deps.db as { prepare(s: string): unknown }).prepare('SELECT 1');\n" +
      '}';
    const scan = scanContextDbHandle({ path: 'probe.ts', src });
    expect(scan.readers, 'structural forgery is out of this gate’s stated scope').toEqual([]);
    expect(scan.unresolved).toEqual([]);
    expect(
      scanSqlSinks({ path: 'probe.ts', src }).calls.map(c => c.sink),
      'a forged handle that ISSUES SQL must still be caught: scanSqlSinks matches the sink by property ' +
        'name, independent of where the receiver came from',
    ).toEqual(['prepare']);
  });

  it('closure: a legal owner forwarding the handle to another file is caught at the callee', () => {
    // The legal lifetime owner (boot) or the composition root hands its handle to
    // a helper elsewhere. Neither file names a context, so no availability gate
    // fires — the callee's own sink call is the finding, and it lands in that
    // file's row in the SQL-caller ledger.
    const callee =
      "export function helper(handle: { exec(s: string): void }) { handle.exec('VACUUM'); }";
    const caller =
      "import { helper } from './helper.js';\n" +
      "export function boot(db: unknown) { helper(db as { exec(s: string): void }); }";
    expect(scanContextDbReaders({ path: 'callee.ts', src: callee })).toEqual([]);
    expect(scanContextDbReaders({ path: 'caller.ts', src: caller })).toEqual([]);
    expect(
      scanSqlSinks({ path: 'callee.ts', src: callee }).calls.map(c => `${c.fn}:${c.sink}`),
      'forwarding a handle across files does not launder it: the file that USES it owns the finding',
    ).toEqual(['helper:exec']);
    // And the caller — which only forwards — is correctly NOT a SQL caller.
    expect(scanSqlSinks({ path: 'caller.ts', src: caller }).calls).toEqual([]);
  });
});
