/**
 * Gate 9 — participation authority (agent-scoped-session-v1 §4.2, #task:2020).
 *
 * "Who is in this conversation" must have ONE answer per placement. The
 * behavioral halves are pinned elsewhere (`direct-pair-endpoint-acl.test.ts` for
 * the code face, `direct-pair-aggregate.test.ts` for the SQL one); what a test
 * over VALUES cannot pin is that no future reader ADDS a second authority, and
 * that is what this gate is for. Its subject is therefore the shape of two files:
 *
 *   1. `packages/shared/src/conversation-placement.ts` — home of the
 *      non-workspace arms — must remain unable to consult the roster at all. Not
 *      "must not": CANNOT, structurally, because its only import is a type import
 *      of the schema. A helpful future edit that fell through to
 *      `conversation_agents` for a `direct_pair` row would hand a stranger
 *      someone's DM, and it would have to add a dependency here to do it.
 *   2. `packages/backend/src/repos/conversation-placement-sql.ts` — the SQL face —
 *      must keep its roster `EXISTS` INSIDE the workspace arm. The same rule with
 *      two faces is only one rule while both faces agree; an ungated `EXISTS`
 *      would make a stray roster row authoritative in delivery and in P2's
 *      runtime target gate while the code face correctly ignored it. Its IMPORT
 *      SURFACE is pinned for the same reason as the rule module's, and closes the
 *      escape the fragment pin cannot see (@Cindy B2.1): a roster edge built by an
 *      IMPORTED helper and ORed in leaves this file's own text with exactly one
 *      literal `conversation_agents`, so counting mentions here would stay green
 *      while a second authority ran. The module's load-bearing shape is "SQL text,
 *      no dependencies", so the assertion is that it has NO imports at all —
 *      strictly stronger than any list of forbidden ones.
 *
 * DELIBERATELY NOT A BAN ON ROSTER READS. The workspace arm's participants ARE
 * its roster rows, so `permissions.ts` must keep reading `conversation_users` /
 * `conversation_agents`, and the gate asserts that it still does — a blunt
 * "nobody may name the roster tables" fence would have to be waived by the very
 * code it is meant to protect, and a waived fence protects nothing.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from './sources.js';

const PLACEMENT_RULE = 'packages/shared/src/conversation-placement.ts';
const PLACEMENT_SQL = 'packages/backend/src/repos/conversation-placement-sql.ts';
const PERMISSIONS = 'packages/backend/src/permissions.ts';

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), 'utf8');
}

/**
 * `src` with comments blanked out and every string / template literal kept
 * intact. Both halves matter and for opposite reasons:
 *
 *   - Comments must go, because naming `conversation_agents` in a docblock is
 *     exactly how these invariants are documented — including in the two files
 *     this gate guards. A fence that fired on prose would be "fixed" by deleting
 *     the sentence that explains the rule.
 *   - Literals must stay, because in the SQL face the rule lives INSIDE a
 *     template literal. Blanking strings would make every assertion below
 *     vacuously true.
 *
 * Newlines survive so offsets and the nearest-preceding-predicate scan still
 * line up with the original text.
 */
function codeOf(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === '//') {
      while (i < src.length && src[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (two === '/*') {
      while (i < src.length && src.slice(i, i + 2) !== '*/') {
        out += src[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      out += '  ';
      i += 2;
      continue;
    }
    const quote = src[i];
    if (quote === '"' || quote === "'" || quote === '`') {
      out += quote;
      i += 1;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') {
          out += src.slice(i, i + 2);
          i += 2;
          continue;
        }
        out += src[i];
        i += 1;
      }
      out += src[i] ?? '';
      i += 1;
      continue;
    }
    out += quote;
    i += 1;
  }
  return out;
}

/** Every module specifier the file imports, with whether the import is
 *  type-only. A value import is what would give the module a way to reach a
 *  database handle, so the two are not interchangeable here.
 *
 *  Every form that creates a dependency counts, INCLUDING the ones that carry no
 *  binding (side-effect, dynamic, `require`) and re-exports — a `export { x } from`
 *  is how a second authority would be laundered through the module rather than
 *  imported into it. Quotes are matched in all three styles because a bypass
 *  written with double quotes or a template literal is still a dependency; this
 *  repo's own style is single quotes, so anything else here is already a signal.
 */
function importsOf(src: string): Array<{ specifier: string; typeOnly: boolean }> {
  const found: Array<{ specifier: string; typeOnly: boolean }> = [];
  const q = `['"\`]`;
  const statement = new RegExp(`(?:^|\\n)\\s*import\\s+([\\s\\S]*?)from\\s*${q}([^'"\`]+)${q}`, 'g');
  for (const m of src.matchAll(statement)) {
    found.push({ specifier: m[2] ?? '', typeOnly: /^\s*type\b/.test(m[1] ?? '') });
  }
  // Side-effect imports and dynamic ones carry no binding but still create a
  // dependency, so they are counted too rather than silently ignored.
  for (const m of src.matchAll(new RegExp(`(?:^|\\n)\\s*import\\s*${q}([^'"\`]+)${q}`, 'g'))) {
    found.push({ specifier: m[1] ?? '', typeOnly: false });
  }
  for (const m of src.matchAll(new RegExp(`\\bimport\\s*\\(\\s*${q}([^'"\`]+)${q}\\s*\\)`, 'g'))) {
    found.push({ specifier: m[1] ?? '', typeOnly: false });
  }
  for (const m of src.matchAll(new RegExp(`\\brequire\\s*\\(\\s*${q}([^'"\`]+)${q}\\s*\\)`, 'g'))) {
    found.push({ specifier: m[1] ?? '', typeOnly: false });
  }
  // A re-export is a dependency that also republishes: `export { rosterEdge } from
  // './x.js'` would put a second authority in this module's public surface without
  // ever naming a table here.
  for (const m of src.matchAll(new RegExp(`(?:^|\\n)\\s*export\\s+([\\s\\S]*?)from\\s*${q}([^'"\`]+)${q}`, 'g'))) {
    found.push({ specifier: m[2] ?? '', typeOnly: /^\s*type\b/.test(m[1] ?? '') });
  }
  return found;
}

/**
 * Every roster-table mention in `src`, as `{table, at}`. Deliberately NOT a
 * judgement about which arm it sits in: the first version of this gate read the
 * nearest PRECEDING `placement_kind = '…'` and called a mention gated when that
 * happened to be `workspace`, which @Cindy's B2 shows is no structural claim at
 * all —
 *
 *     (c.placement_kind = 'workspace' AND EXISTS (…roster…))
 *     OR (c.placement_kind = 'workspace' OR EXISTS (…roster…))
 *
 * has a wide-open roster read whose nearest preceding predicate is `workspace`,
 * and a bare `EXISTS` in a later statement inherits an earlier statement's
 * predicate the same way. Text adjacency is not AST nesting, so the gate stopped
 * pretending it was: it COUNTS mentions and requires every one of them to be
 * inside one byte-pinned fragment, which needs no parser to check.
 */
function rosterMentions(src: string): Array<{ table: string; at: number }> {
  const found: Array<{ table: string; at: number }> = [];
  for (const table of ['conversation_agents', 'conversation_users']) {
    let at = src.indexOf(table);
    while (at !== -1) {
      found.push({ table, at });
      at = src.indexOf(table, at + table.length);
    }
  }
  return found.sort((x, y) => x.at - y.at);
}

/** Collapse whitespace runs so the pinned fragment survives reindentation — the
 *  claim is the SQL's shape, not how a formatter broke its lines. Everything else
 *  stays byte-exact, the `AND` included. */
function squash(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

/**
 * The ONE roster read the placement SQL may contain, pinned as source text.
 * `${conversationAlias}` is part of the pin: the fragment must interpolate the
 * SAME alias into the placement predicate and into the correlated subquery, so a
 * copy that gated on one alias while joining another cannot match it.
 */
const PINNED_ROSTER_FRAGMENT = `(\${conversationAlias}.placement_kind = 'workspace'
            AND EXISTS (
              SELECT 1 FROM conversation_agents ca_p
               WHERE ca_p.conversation_id = \${conversationAlias}.id
                 AND ca_p.agent_id = ?
            ))`;

/**
 * The roster mentions in `code` that do NOT lie inside an occurrence of
 * `fragment`. This is the whole of the SQL-face claim, and it is countable:
 * a second roster read anywhere in the file — nested however deeply, in any arm,
 * in any new function — is a mention outside the fragment, and turning the
 * fragment's `AND` into an `OR` stops the fragment from being found at all.
 */
function rosterReadsOutside(code: string, fragment: string): string[] {
  const flatCode = squash(code);
  const flatFragment = squash(fragment);
  const spans: Array<{ from: number; to: number }> = [];
  let at = flatCode.indexOf(flatFragment);
  while (at !== -1) {
    spans.push({ from: at, to: at + flatFragment.length });
    at = flatCode.indexOf(flatFragment, at + 1);
  }
  return rosterMentions(flatCode)
    .filter(m => !spans.some(s => m.at >= s.from && m.at + m.table.length <= s.to))
    .map(m => `${m.table} @${m.at} is outside the pinned workspace-gated fragment`);
}

describe('db-boundary: participation authority', () => {
  it('the placement rule module cannot reach a roster at all', () => {
    const src = read(PLACEMENT_RULE);
    // The whole claim in one assertion: a type import erases at compile time, so
    // this module has NO runtime dependency, which is why "it does not consult
    // `conversation_agents`" is a property of the build and not of its author's
    // discipline. Adding any value import here is the reviewed diff that would
    // change that.
    expect(importsOf(src), `${PLACEMENT_RULE} gained an import — see this file's header`).toEqual([
      { specifier: './db/schema.js', typeOnly: true },
    ]);
    // …and belt: the CODE names no table, no statement, and no read port, so even
    // a hand-rolled string reaching a driver through a parameter is absent. The
    // check is over `codeOf` because this module's docblock names the roster
    // tables to state the very invariant being pinned here.
    const code = codeOf(src);
    for (const forbidden of [
      'conversation_agents',
      'conversation_users',
      'authorizationReads',
      'SELECT',
      'prepare(',
      'better-sqlite3',
    ]) {
      expect(code, `${PLACEMENT_RULE} must not name ${forbidden} in code`).not.toContain(forbidden);
    }
    // Positive half: the arms it DOES own are here, so a future split that moved
    // one of them into a DB-capable module fails this gate rather than quietly
    // passing it.
    expect(code).toContain('export function resolveParticipation');
    expect(code).toContain(`placement_kind === 'agent_inbox'`);
  });

  it('the SQL face contains exactly ONE roster read, and it is the pinned workspace-gated one', () => {
    // `codeOf` first, for two reasons: this file's prose discusses the roster arm
    // at length, and a prose mention would otherwise count toward the ONE.
    const code = codeOf(read(PLACEMENT_SQL));
    expect(
      rosterReadsOutside(code, PINNED_ROSTER_FRAGMENT),
      `${PLACEMENT_SQL}: a roster read outside the pinned fragment makes a stray roster row ` +
        'authoritative for a DM or an inbox in every embedded read face (delivery, activity, ' +
        'the runtime control planes, target gates)',
    ).toEqual([]);
    // …and exactly one, so the fragment is actually THERE. Zero mentions would
    // satisfy the assertion above while meaning the workspace arm had lost its
    // authority — the opposite failure.
    expect(rosterMentions(squash(code))).toHaveLength(1);
    // The arms that resolve WITHOUT a roster, named so a future edit cannot make
    // them roster-backed and still pass by deleting an arm.
    expect(code).toContain(`placement_kind = 'direct_pair'`);
    expect(code).toContain(`placement_kind = 'agent_inbox'`);
    // The predicate builder delegates rather than inlining, which is what keeps
    // the single-fragment count meaningful as arms are added.
    expect(code).toContain('workspaceAgentRosterEdge(conversationAlias)');
  });

  it('the SQL face has no dependencies, so no roster edge can arrive from outside it', () => {
    // @Cindy B2.1. The mention count above is a claim about THIS FILE'S TEXT, and
    // an imported `extraRosterEdge(alias)` ORed into the predicate satisfies it
    // while running a second authority: the table name lives in the other module.
    // What forecloses that is the module's actual shape — SQL text with no
    // dependencies at all — so that is what gets pinned. NO imports is a stronger
    // and simpler claim than a list of banned ones: there is no "harmless helper"
    // exception to argue about, and gaining one is a reviewed diff.
    const src = read(PLACEMENT_SQL);
    expect(
      importsOf(src),
      `${PLACEMENT_SQL} gained a dependency: this module is SQL TEXT ONLY, and an ` +
        'imported fragment builder is a roster authority the single-mention count cannot see',
    ).toEqual([]);
    // Belt, for the forms a specifier scan cannot name: a require built at runtime
    // and the driver itself.
    const code = codeOf(src);
    for (const forbidden of ['createRequire', 'better-sqlite3', 'prepare(']) {
      expect(code, `${PLACEMENT_SQL} must not name ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('permissions.ts resolves placement participation in exactly one place', () => {
    const code = codeOf(read(PERMISSIONS));
    // One CALL, not one import: the entry points (view / read / post / member-add)
    // all funnel through the one that has it, so a second call site would mean a
    // second entry deciding participation on its own terms.
    const calls = [...code.matchAll(/\bresolveParticipation\(/g)];
    expect(
      calls.length,
      'participation is resolved once per request, by the one exported gate every other entry delegates to',
    ).toBe(1);
  });

  it('and still reads the roster for the WORKSPACE arm (this gate is not a ban)', () => {
    const code = codeOf(read(PERMISSIONS));
    // If these ever disappear, the workspace arm has stopped consulting the
    // authority that defines it — the opposite failure, and just as silent. The
    // gate names both directions so neither can be "fixed" by deleting the other.
    expect(code).toContain('reads.isConversationAgent(');
    expect(code).toContain('reads.isConversationUser(');
  });

  it('fence self-test: only the pinned fragment passes, including B2’s bypasses', () => {
    // The shape the production file has: the pinned fragment and nothing else.
    const gated = `const sql = \`${PINNED_ROSTER_FRAGMENT}
      OR (\${conversationAlias}.placement_kind = 'direct_pair' AND \${conversationAlias}.endpoint_a_id = ?)\`;`;
    expect(rosterReadsOutside(gated, PINNED_ROSTER_FRAGMENT)).toEqual([]);

    // @Cindy's B2 bypass, verbatim in shape: the second arm's roster read is wide
    // open (the `OR` short-circuits the predicate away) while its nearest preceding
    // `placement_kind` is still `workspace`. The retired proximity check passed
    // this; the fragment check must not.
    const orBypass = `${gated}
      const more = \`OR (\${conversationAlias}.placement_kind = 'workspace'
        OR EXISTS (SELECT 1 FROM conversation_agents ca WHERE ca.agent_id = ?))\`;`;
    expect(rosterReadsOutside(orBypass, PINNED_ROSTER_FRAGMENT)).toHaveLength(1);

    // The other half of B2: a bare roster read in a LATER statement, inheriting
    // nothing but the reader's optimism.
    const laterStatement = `${gated}
      const other = \`SELECT 1 FROM conversation_agents ca WHERE ca.agent_id = ?\`;`;
    expect(rosterReadsOutside(laterStatement, PINNED_ROSTER_FRAGMENT)).toHaveLength(1);

    // A near-copy that swapped the gating `AND` for `OR` INSIDE the fragment is not
    // the pinned fragment at all, so its roster read is reported rather than
    // matched — the pin is what makes weakening it visible.
    const weakened = gated.replace(`placement_kind = 'workspace'
            AND EXISTS`, `placement_kind = 'workspace'
            OR EXISTS`);
    expect(rosterReadsOutside(weakened, PINNED_ROSTER_FRAGMENT)).toHaveLength(1);

    // A fragment gated on one alias but joined on another must not match either.
    const aliasSwap = gated.replace('ca_p.conversation_id = ${conversationAlias}.id', 'ca_p.conversation_id = other.id');
    expect(rosterReadsOutside(aliasSwap, PINNED_ROSTER_FRAGMENT)).toHaveLength(1);

    // Reindentation is NOT a violation: the claim is the SQL's shape.
    const reindented = gated.replace(/\n\s+/g, '\n  ');
    expect(rosterReadsOutside(reindented, PINNED_ROSTER_FRAGMENT)).toEqual([]);

    // `conversation_users` has no live SQL face in this layer, so any mention of it
    // is by definition outside the fragment.
    expect(
      rosterReadsOutside(
        `EXISTS (SELECT 1 FROM conversation_users cu WHERE cu.user_id = ?)`,
        PINNED_ROSTER_FRAGMENT,
      ),
    ).toHaveLength(1);

    // The import probe distinguishes type from value, which is the whole basis of
    // the first assertion.
    expect(
      importsOf(`import type { A } from './db/schema.js';\nimport { B } from './x.js';`),
    ).toEqual([
      { specifier: './db/schema.js', typeOnly: true },
      { specifier: './x.js', typeOnly: false },
    ]);
    expect(importsOf(`import './side-effect.js';`)).toEqual([
      { specifier: './side-effect.js', typeOnly: false },
    ]);
    expect(importsOf(`const d = await import('./dyn.js');`)).toEqual([
      { specifier: './dyn.js', typeOnly: false },
    ]);

    // @Cindy B2.1, stated as the two halves it actually has. An EXTERNAL roster
    // edge, ORed into the predicate: the fragment check is BLIND to it (this file's
    // text still holds exactly one literal roster mention, inside the pin) …
    const external = [
      `import { extraRosterEdge } from './extra-roster.js';`,
      'const sql = `' + PINNED_ROSTER_FRAGMENT,
      '      OR (${extraRosterEdge(conversationAlias)})`;',
    ].join('\n');
    expect(rosterReadsOutside(codeOf(external), PINNED_ROSTER_FRAGMENT)).toEqual([]);
    expect(rosterMentions(squash(codeOf(external)))).toHaveLength(1);
    // … and the import surface is what reports it. Written as one self-test on
    // purpose: the pair of assertions is the reason the second gate exists, and
    // splitting them would let someone "fix" the blindness by deleting the note.
    expect(importsOf(external)).toEqual([
      { specifier: './extra-roster.js', typeOnly: false },
    ]);
    // Every laundering form of the same escape is a dependency too: a `require`,
    // a re-export that republishes the helper, and a non-repo quote style.
    expect(importsOf(`const { extraRosterEdge } = require('./extra-roster.js');`)).toEqual([
      { specifier: './extra-roster.js', typeOnly: false },
    ]);
    expect(importsOf(`export { extraRosterEdge } from './extra-roster.js';`)).toEqual([
      { specifier: './extra-roster.js', typeOnly: false },
    ]);
    expect(importsOf(`import { extraRosterEdge } from "./extra-roster.js";`)).toEqual([
      { specifier: './extra-roster.js', typeOnly: false },
    ]);
    // …and a file with no dependencies reports none, so the `toEqual([])` above is
    // an assertion about the module rather than about a probe that never matches.
    expect(importsOf('export const WORKSPACE_PLACED = `c.placement_kind = \'workspace\'`;')).toEqual(
      [],
    );
  });

  it('fence self-test: codeOf drops comments and keeps literals', () => {
    // The direction that would cause a FALSE PASS: a docblock mentioning the
    // roster must not be able to satisfy any of the positive assertions, and must
    // not be able to count toward the ONE allowed roster read either.
    expect(codeOf(`/* conversation_agents in prose */ const x = 1;`)).not.toContain(
      'conversation_agents',
    );
    expect(rosterMentions(codeOf(`// a docblock naming conversation_agents`))).toEqual([]);
    expect(
      rosterReadsOutside(
        codeOf(`// FROM conversation_agents, said the comment`),
        PINNED_ROSTER_FRAGMENT,
      ),
    ).toEqual([]);

    // The direction that would make every assertion VACUOUS: the SQL under test
    // lives inside a template literal, and a `'` inside prose must not swallow it.
    expect(codeOf('const sql = `FROM conversation_agents`;')).toContain('conversation_agents');
    expect(
      codeOf("/* an author's aside */ const sql = `FROM conversation_agents`;"),
    ).toContain('conversation_agents');

    // Offsets survive, so the scan's "nearest preceding" is measured against the
    // real file rather than a compacted copy.
    const withComment = `/* pad */\nconst a = 1;`;
    expect(codeOf(withComment)).toHaveLength(withComment.length);
  });
});
