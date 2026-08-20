/**
 * §E drift guard for #task:2045 Delta 4 — the rail's agent-space sort token.
 *
 * `dm` used to be BOTH the domain word for an agent space and the stored/wire
 * token of the rail's Agent Spaces sort group. Delta 4 moved the token to
 * `agent_space` on all three carriers at once (shared `SortGroupSchema`, the
 * backend's rail grouping, and `user_list_sort_mode.scope` via migration v86), so
 * the word now means exactly one thing: a DirectPair conversation.
 *
 * This fence exists because a revival is CHEAP and QUIET. The two rail sort
 * tables are keyed differently — `user_list_sort_mode` by SCOPE, `user_sort_entry`
 * by ENTITY — so re-spelling the group `dm` anywhere on the producing path
 * orphans the mode rows while every manual drag rank survives: "my order is still
 * there but no longer applied". Nothing about that is visible in a diff of the
 * offending line.
 *
 * ## Every shape criterion is gated on the SORT AXIS
 *
 * `dm` is a LEGAL word — it is the DirectPair conversation kind. A fence that
 * flags `z.enum([… 'dm'])` or `group: 'dm'` unconditionally does not defend the
 * sort token, it taxes the DirectPair domain: the next legitimate DirectPair
 * schema reddens and gets "fixed" by widening an exemption. So a bare `dm`
 * literal is judged ONLY when `SORT_AXIS_MARKER` also appears within its ±200-char
 * window; the green controls below pin legal DirectPair `z.enum` / `z.literal` /
 * union shapes staying silent. That today's DirectPair sites happen not to collide
 * (`ConversationGlyph` spells `'channel' | 'dm'` and keys off `kind`) is a
 * coincidence, not a design — the gate is what makes it safe.
 *
 * ## Exemptions are per SITE; only a frozen fossil gets a whole file
 *
 * - `persistId="dm"` — the rail section's localStorage collapse identity
 *   (`SECTION_KEY_PREFIX + persistId`, #task:2035), not a domain or wire word.
 *   Exempted by MATCHED SITE, and the exemption is only trusted after
 *   `persistIdSiteReport()` has proved there is EXACTLY ONE such site in production
 *   source and that it is the one in `Sidebar.tsx`. Today's site is JSX, but the
 *   criterion is not "is this JSX": it counts every DIRECT literal assignment to
 *   this same `persistId` identity — quoted, in an expression container, as a
 *   template literal, or written onto an object (`props.persistId = 'dm'`). A
 *   second carrier in any of those spellings reddens before the shape fence runs,
 *   because two exempt sites make the fence blind at both.
 * - `packages/shared/src/db/migrations.ts` is NOT skipped. It is the live append
 *   point for new migrations, i.e. the most likely place for the token to be
 *   written BACK onto the persisted carrier, and a whole-file skip defends only
 *   against deletion, never against addition. Instead its retired-SQL occurrences
 *   are pinned as an exact, enumerable baseline (`MIGRATION_DM_SQL_BASELINE`):
 *   new explanatory comments stay green, a second `scope = 'dm'` statement reddens
 *   and the failure prints the offending SQL rather than a count to bump.
 * - `packages/shared/src/db/baseline-schema.ts` is the only whole-file exclusion:
 *   a FROZEN v44 fossil with no append point (and, today, no occurrence at all).
 *
 * ## Boundary — it covers LITERAL spellings only
 *
 * `const KEY = 'dm'; … persistId={KEY}` (and the same indirection on any other
 * shape) is invisible to this fence, and to any text fence. Catching it needs the
 * type/AST layer, which costs far more than the risk of a hand-rolled alias for a
 * three-letter constant. Stated here because a green text fence otherwise reads as
 * "revival is impossible" — it means "no LITERAL revival".
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const backendRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(backendRoot, '..', '..');

/** All five ways JSX can spell the allowlisted value: a bare quoted literal, or
 *  an expression container holding a quoted or template literal. Anything narrower
 *  lets the same site be re-typed into an escape hatch.
 *
 *  `\b` matters: without it `my_persistId="dm"` — an unrelated identifier that
 *  merely ENDS in the prop name — would count as an allowlist candidate and turn
 *  the exactly-one assertion into a false red. A MEMBER write
 *  (`props.persistId = 'dm'`) deliberately DOES still count: the criterion is how
 *  many carriers spell this persistence identity, not which syntax spells it, and
 *  a move from JSX prop to object assignment is exactly the migration that must
 *  come back through review. */
const PERSIST_ID_SITE_RE =
  /\bpersistId\s*=\s*(?:'dm'|"dm"|\{\s*(?:'dm'|"dm"|`dm`)\s*\})/g;
/** The canonical text of the ONE allowlisted site, asserted verbatim. */
const PERSIST_ID_SITE = 'persistId="dm"';
const PERSIST_ID_FILE = 'apps/desktop/src/renderer/components/layout/Sidebar.tsx';

const MIGRATIONS_FILE = 'packages/shared/src/db/migrations.ts';
/** Every retired-token occurrence that survives comment-stripping in the live
 *  migration ledger, as SOURCE TEXT. v86's predicate is the whole of it. */
const MIGRATION_DM_SQL_BASELINE = ["AND scope = 'dm';"];

const PRODUCTION_ROOTS = [
  'packages/shared/src',
  'packages/backend/src',
  'packages/host/src',
  'packages/cli/src',
  'packages/server/src',
  'apps/desktop/src',
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') || entry.name.endsWith('.tsx') ? [path] : [];
  });
}

function productionFiles(): string[] {
  return PRODUCTION_ROOTS.flatMap(root => sourceFiles(join(repoRoot, root)));
}

/** Strip comments so the fence judges CODE. `/* … *\/` covers JSX's
 *  `{/* … *\/}` too (the braces it leaves behind are inert), so only two forms
 *  are needed. Kept deliberately simple: it may also blank a `//` inside a string
 *  literal, which can only ever make the guard blind to a same-line revival AFTER
 *  a URL — no such site exists, and the shape tests below pin what must still be
 *  caught. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Markers that make a nearby bare `dm` a RAIL SORT GROUP rather than a
 *  DirectPair conversation kind. Producer functions and the persisted carrier —
 *  not loose prose. */
const SORT_AXIS_MARKER =
  /isAgentHomeWorkspace|isAgentSpace|owner_agent_id|user_list_sort_mode|SortGroup|railSortGroup|sortConfigFor|sortMenuFor|list_key/;

const DM_LITERAL_G = /'dm'|"dm"|`dm`/g;
const DM_LITERAL = /'dm'|"dm"|`dm`/;
const ZOD_MEMBER = /z\.enum\(\s*\[[^\]]*(?:'dm'|"dm")[^\]]*\]|z\.literal\(\s*(?:'dm'|"dm")\s*\)/s;
const GROUP_UNION =
  /(?:'dm'|"dm")\s*\|\s*(?:'regular'|"regular")|(?:'regular'|"regular")\s*\|\s*(?:'dm'|"dm")/;
const PERSISTED_SCOPE =
  /\b(?:scope|group)\s*(?:===|==|=|:)\s*(?:'dm'|"dm")|(?:'dm'|"dm")\s*(?:===|==)\s*\w*(?:scope|group|Group)/;

/** Remove the allowlisted site(s) so their literal cannot be read as a revival.
 *  Sound only because `persistIdSiteReport()` independently proves the site is
 *  unique and lives in `Sidebar.tsx` — that assertion runs first, and this helper
 *  is what the assertion licenses. */
function exemptAllowlistedSites(text: string): string {
  return text.replace(PERSIST_ID_SITE_RE, ' ');
}

export function productionPersistIdSites(source: string): string[] {
  return [...stripComments(source).matchAll(PERSIST_ID_SITE_RE)].map(m => m[0]);
}

/** `<repo-relative path>: <matched site text>` for every allowlist candidate.
 *  Pure over its input so the mutation cases below can hand it synthetic files. */
export function persistIdSiteReport(files: { path: string; text: string }[]): string[] {
  return files.flatMap(file =>
    productionPersistIdSites(file.text).map(site => `${file.path}: ${site}`),
  );
}

export function retiredRailSortTokenReasons(source: string): string[] {
  const text = exemptAllowlistedSites(stripComments(source));
  const reasons = new Set<string>();

  for (const match of text.matchAll(DM_LITERAL_G)) {
    const at = match.index ?? 0;
    const window = text.slice(Math.max(0, at - 200), at + 200);
    // The axis gate: no sort-axis marker in reach ⇒ this is the DirectPair word
    // doing its legitimate job, whatever shape it is written in.
    if (!SORT_AXIS_MARKER.test(window)) continue;
    if (ZOD_MEMBER.test(window)) reasons.add('wire enum member');
    else if (GROUP_UNION.test(window)) reasons.add('sort-group type union');
    else if (PERSISTED_SCOPE.test(window)) reasons.add('persisted sort scope');
    else reasons.add('agent-space producer expression');
  }
  return [...reasons];
}

describe('retired rail sort token static guard (#task:2045 §E)', () => {
  it('allowlists exactly ONE storage-identity site, and only in the Sidebar', () => {
    // Runs BEFORE the shape fence: the fence exempts the matched site text, so a
    // second site would otherwise be exempt too. Test sources are in scope on
    // purpose — a fixture is production TEXT about the current contract.
    const found = persistIdSiteReport(
      productionFiles().map(file => ({
        path: relative(repoRoot, file),
        text: readFileSync(file, 'utf8'),
      })),
    );
    expect(
      found,
      `Exactly one \`persistId\` may spell the retired token, and only in ${PERSIST_ID_FILE} `
        + '(localStorage collapse identity, #task:2035). If the Agent Spaces section moved, MOVE '
        + 'this anchor with it — do NOT add a second exemption: two exempt sites make the fence '
        + 'blind to a real revival at either one.',
    ).toEqual([`${PERSIST_ID_FILE}: ${PERSIST_ID_SITE}`]);
  });

  it('keeps the retired agent-space sort token out of production source', () => {
    const offenders: string[] = [];
    for (const file of productionFiles()) {
      const rel = relative(repoRoot, file);
      // migrations.ts has its own exact baseline (next test); baseline-schema.ts
      // is the frozen v44 fossil.
      if (rel === MIGRATIONS_FILE || rel === 'packages/shared/src/db/baseline-schema.ts') {
        continue;
      }
      const reasons = retiredRailSortTokenReasons(readFileSync(file, 'utf8'));
      if (reasons.length > 0) offenders.push(`${rel}: ${reasons.join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });

  it('pins the retired token in the live migration ledger to v86 only', () => {
    // Not a whole-file skip: this file is where a FUTURE migration would write
    // `scope='dm'` back onto `user_list_sort_mode`. SQL `--` comments are stripped
    // alongside the JS forms here (and only here — in TS at large, `--` is a
    // decrement operator) so that explaining the history stays free.
    const sql = stripComments(readFileSync(join(repoRoot, MIGRATIONS_FILE), 'utf8')).replace(
      /--[^\n]*/g,
      ' ',
    );
    const occurrences = sql
      .split('\n')
      .filter(line => DM_LITERAL.test(line))
      .map(line => line.trim());
    expect(
      occurrences,
      'A migration writes the retired rail token again. Applied migrations are history and are '
        + 'never rewritten — but a NEW one must not resurrect the token. If this list grew, the '
        + 'added SQL is the bug; if v86 itself was reworded, update MIGRATION_DM_SQL_BASELINE in '
        + 'the same commit so the next reader sees the whole set.',
    ).toEqual(MIGRATION_DM_SQL_BASELINE);
  });

  it('pins the compiler tripwire that made this rename enumerable', () => {
    // `Extract` (not a spelled-out union, not `SortGroup` itself) is what turns
    // any future member rename into a type error at `railSortGroupOf`'s body
    // instead of a silent divergence from the stored rows.
    const bridge = readFileSync(
      join(repoRoot, 'apps/desktop/src/renderer/features/workspaces/rail-sort-group.ts'),
      'utf8',
    );
    expect(bridge).toContain(
      "export type RailSortGroup = Extract<SortGroup, 'agent_space' | 'regular'>;",
    );
  });

  it('proves the guard sees each revival shape instead of passing vacuously', () => {
    const shared = "export const SortGroupSchema = z.enum(['dm', 'regular', 'channels']);";
    expect(retiredRailSortTokenReasons(shared)).toContain('wire enum member');

    const backendSql = `
      const groups = new Map<string, SortGroup>();
      groups.set(ws.id, isAgentHomeWorkspace(ws) ? 'dm' : 'regular');
    `;
    expect(retiredRailSortTokenReasons(backendSql)).toContain(
      'agent-space producer expression',
    );

    const rendererUnion = "export type RailSortGroup = 'dm' | 'regular';";
    expect(retiredRailSortTokenReasons(rendererUnion)).toContain('sort-group type union');

    const persisted = `
      db.prepare('UPDATE user_list_sort_mode SET mode = ? WHERE scope = ?')
        .run(mode, scope === 'dm' ? 'dm' : scope);
    `;
    expect(retiredRailSortTokenReasons(persisted)).toContain('persisted sort scope');
  });

  it('stays silent on the DirectPair axis, which legitimately owns the word', () => {
    // Reverse correctness: these are the shapes a FUTURE DirectPair contract
    // would be written in. A fence that reddens here would be removed, not fixed.
    expect(
      retiredRailSortTokenReasons("export interface Props { kind: 'channel' | 'dm' }"),
    ).toEqual([]);
    expect(
      retiredRailSortTokenReasons(
        "export const ConversationKindSchema = z.enum(['workspace_channel', 'dm']);",
      ),
    ).toEqual([]);
    expect(
      retiredRailSortTokenReasons(
        'export const DirectPairPlacementSchema = z.object({ kind: z.literal("dm") });',
      ),
    ).toEqual([]);
    expect(retiredRailSortTokenReasons("if (conversation.kind === 'dm') return glyph;")).toEqual(
      [],
    );
    expect(retiredRailSortTokenReasons("const p = 'dm:@' + handle;")).toEqual([]);
  });

  it('exempts the storage-identity site by site, in every direct-assignment spelling', () => {
    // Each spelling is exempt on its own…
    for (const site of [
      '<Group persistId="dm" />',
      "<Group persistId='dm' />",
      '<Group persistId={"dm"} />',
      "<Group persistId={'dm'} />",
      '<Group persistId={`dm`} />',
    ]) {
      expect(retiredRailSortTokenReasons(site), site).toEqual([]);
      // …and each spelling still COUNTS as a site, so a second one cannot hide
      // behind a different quote style or an expression container.
      expect(productionPersistIdSites(site), site).toHaveLength(1);
    }
    // A real revival in the same file as the exempt site still reddens.
    expect(
      retiredRailSortTokenReasons('<Group persistId="dm" sort={sortConfigFor(\'dm\')} />'),
    ).toContain('agent-space producer expression');
    // Prose mentioning the site is not a site.
    expect(
      productionPersistIdSites('// the section keeps persistId="dm" for localStorage'),
    ).toEqual([]);
    expect(
      productionPersistIdSites('{/* persistId={"dm"} is storage identity */}'),
    ).toEqual([]);
    // An unrelated identifier that merely ENDS in the prop name is NOT a site —
    // otherwise the exactly-one assertion goes false-red on a neighbour.
    expect(productionPersistIdSites('const my_persistId = "dm";')).toEqual([]);
    expect(productionPersistIdSites('<S myPersistId="dm" />')).toEqual([]);
    // …but the SAME identity written onto a second carrier IS a site: that is the
    // real "JSX prop → object assignment" migration, and it must reach review.
    expect(productionPersistIdSites("props.persistId = 'dm';")).toHaveLength(1);
  });

  it('reddens on a SECOND site in another file, in any spelling', () => {
    // The mutation that motivated the tightening: the old fence stripped the
    // allowlisted TEXT globally, so a second file spelling the same prop passed
    // silently. Both a quote-style swap and an expression container are pinned.
    const anchor = { path: PERSIST_ID_FILE, text: `<Group ${PERSIST_ID_SITE} />` };
    const expected = [`${PERSIST_ID_FILE}: ${PERSIST_ID_SITE}`];
    expect(persistIdSiteReport([anchor])).toEqual(expected);

    for (const spelling of ["persistId='dm'", 'persistId={"dm"}']) {
      const report = persistIdSiteReport([
        anchor,
        { path: 'apps/desktop/src/renderer/components/layout/OtherRail.tsx', text: `<S ${spelling} />` },
      ]);
      expect(report, spelling).not.toEqual(expected);
      expect(report, spelling).toHaveLength(2);
    }

    // A second MENTION (comment only) elsewhere stays green — the fence must not
    // punish explaining the allowlist.
    expect(
      persistIdSiteReport([
        anchor,
        { path: 'apps/desktop/src/renderer/components/layout/sidebar-shared.tsx', text: '// e.g. persistId="dm"' },
      ]),
    ).toEqual(expected);
  });
});
