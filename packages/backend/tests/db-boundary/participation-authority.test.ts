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
 *      must keep its roster `EXISTS` INSIDE the workspace arm, for EVERY principal
 *      kind — including the human one, since the send's write gate now asks human
 *      participation inside the transaction, so the human rule has a SQL face too.
 *      The same rule with two faces is only one rule while both faces agree; an
 *      ungated `EXISTS` would make a stray roster row authoritative in delivery and
 *      in P2's runtime target gate while the code face correctly ignored it. Its
 *      IMPORT SURFACE is pinned for the same reason as the rule module's, and closes
 *      the escape the fragment pin cannot see: a roster edge built by
 *      an IMPORTED helper and ORed in leaves this file's own text with exactly the
 *      allowed literal roster mentions, so counting mentions here would stay green
 *      while a second authority ran. The module's load-bearing shape is "SQL text,
 *      no dependencies", so the assertion is that it has NO imports at all —
 *      strictly stronger than any list of forbidden ones.
 *
 *   3. `packages/backend/src/services/conversation-message/contracts.ts` and the
 *      send gate in `conversation-message-service.ts` — participation must not be
 *      expressible as a POLICY at all. `requireSenderParticipation`
 *      existed for exactly as long as one arm legitimately said `false`; once both
 *      arms said `true` the field was a security invariant left behind as a
 *      switch. A values test cannot pin its absence — `true` and "no field" behave
 *      identically today — so the shape is pinned here: no policy field names
 *      participation, and the gate takes no policy object to read one from.
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
import {
  agentParticipates,
  agentParticipatesCorrelated,
  PARTICIPANT_AGENT_IDS_SQL,
  userParticipates,
} from '../../src/repos/conversation-placement-sql.js';
import { REPO_ROOT } from './sources.js';

const PLACEMENT_RULE = 'packages/shared/src/conversation-placement.ts';
const PLACEMENT_SQL = 'packages/backend/src/repos/conversation-placement-sql.ts';
const PERMISSIONS = 'packages/backend/src/permissions.ts';
const SEND_CONTRACTS = 'packages/backend/src/services/conversation-message/contracts.ts';
const SEND_SERVICE = 'packages/backend/src/services/conversation-message-service.ts';

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
 *  Call it on {@link codeOf} output, not on raw source — every call site here does.
 *  A comment cannot create a dependency, and the scan below is deliberately
 *  lazy-greedy across newlines to catch a multi-line import list, which makes it
 *  read a docblock sentence like "each arm starts from `conversations`" after any
 *  line-initial `export` as a re-export of a module named `conversations`. That
 *  false positive is worse than a cosmetic annoyance: the fix a future author would
 *  reach for is deleting the sentence that documents the invariant.
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
 * happened to be `workspace`, which is no structural claim at
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
/** One predicate builder's own text: its declaration through the first
 *  line-initial `}`. Used where the claim is about ONE predicate's ARM LIST rather
 *  than about the whole file — the arms of both kinds now live in sibling builders,
 *  so a file-wide scan cannot tell "the human face has no inbox arm" from "some
 *  function in this file mentions inboxes". Returns `''` when the builder is absent,
 *  which the call sites assert against separately. */
function armTextOf(code: string, fn: string): string {
  const from = code.indexOf(`function ${fn}(`);
  if (from === -1) return '';
  const end = code.indexOf('\n}', from);
  return end === -1 ? code.slice(from) : code.slice(from, end);
}

function rosterMentions(src: string): Array<{ table: string; at: number }> {
  const found: Array<{ table: string; at: number }> = [];
  for (const table of ['conversation_agents', 'conversation_users', 'workspace_users']) {
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
 * The roster reads the placement SQL may contain — ONE PER PRINCIPAL KIND, pinned
 * as source text. `${conversationAlias}` is part of each pin: a fragment must
 * interpolate the SAME alias into the placement predicate and into its correlated
 * subqueries, so a copy that gated on one alias while joining another cannot
 * match.
 *
 * The AGENT pin's principal side is an interpolation too (`${agentIdExpr}`), and
 * since #task:2021 P4-5 that is load-bearing rather than incidental: the agent
 * predicate serves two readings of one text — a point check that binds `'?'` and a
 * correlated enumeration that passes a column of the enclosing query — so a pin
 * holding a literal `?` would match only the point form and go BLIND to a
 * correlated second roster read, which is the exact escape this gate counts.
 * Pinned at the parameter, both readings are the same one fragment.
 *
 * The HUMAN pin keeps its literal `?`, because the human rule has ONE reading:
 * only agents are enumerated (a runtime delivery target is an agent), so nothing
 * asks for the human participants of a conversation as a set. If that changes, the
 * fix is to parameterize the human face and this pin with it — not to widen the
 * pin in advance, which would make it match a form no production caller uses.
 */
const PINNED_AGENT_ROSTER_FRAGMENT = `(\${conversationAlias}.placement_kind = 'workspace'
            AND EXISTS (
              SELECT 1 FROM conversation_agents ca_p
               WHERE ca_p.conversation_id = \${conversationAlias}.id
                 AND ca_p.agent_id = \${agentIdExpr}
            ))`;

/**
 * The SET-shaped roster read (#task:2021 P4-5). The agent rule
 * now has TWO readings — a predicate over one agent and a set of candidate ids
 * produced by the placement — because enumerating with the predicate meant offering
 * every agent in the installation as a candidate (a full `SCAN a` per message).
 *
 * That makes this the SECOND `conversation_agents` mention the file may contain,
 * and the allowance is a PIN rather than a raised count: the workspace predicate is
 * ANDed inside this text too, so a set-shaped read that dropped it — handing every
 * roster row of every placement to the recipient fan-out — matches no pin and is
 * reported. The count still forbids a THIRD reading.
 *
 * No `${…}` interpolation here, unlike the predicate pins: the set form is a
 * self-contained subquery with its own alias and ONE named parameter, so there is
 * no caller-supplied alias or principal expression to travel through. That the two
 * readings AGREE is not checkable from text at all and is asserted over values in
 * `tests/read-model/participation-enumeration.test.ts`.
 */
const PINNED_AGENT_ROSTER_MEMBERS_FRAGMENT = `SELECT ca_p.agent_id AS agent_id
              FROM conversations c_p
              JOIN conversation_agents ca_p
                ON ca_p.conversation_id = c_p.id
             WHERE c_p.id = @conv
               AND c_p.placement_kind = 'workspace'`;

/**
 * The human one. TWO subqueries, and the pin is what makes that load-bearing:
 * human participation in a channel is the v25 PAIR — the `conversation_users`
 * seat AND `workspace_users` membership — so a "simplification" to the seat alone
 * would admit someone removed from the workspace whose channel row outlived the
 * removal. Dropping either conjunct stops matching this text, which is how the
 * gate reports it (`fence self-test` below states that direction explicitly).
 */
const PINNED_HUMAN_ROSTER_FRAGMENT = `(\${conversationAlias}.placement_kind = 'workspace'
            AND EXISTS (
              SELECT 1 FROM conversation_users cu_p
               WHERE cu_p.conversation_id = \${conversationAlias}.id
                 AND cu_p.user_id = ?
            )
            AND EXISTS (
              SELECT 1 FROM workspace_users wu_p
               WHERE wu_p.workspace_id = \${conversationAlias}.workspace_id
                 AND wu_p.user_id = ?
            ))`;

const PINNED_ROSTER_FRAGMENTS = [
  PINNED_AGENT_ROSTER_FRAGMENT,
  PINNED_AGENT_ROSTER_MEMBERS_FRAGMENT,
  PINNED_HUMAN_ROSTER_FRAGMENT,
];

/** How many roster-table mentions the pinned set accounts for: the agent rule's
 *  TWO readings (`conversation_agents` as a membership test and as a set of
 *  members) plus the human pair (`conversation_users`, `workspace_users`). Derived
 *  from the pins rather than written as a literal, so adding a principal kind — or a
 *  third reading of an existing one — cannot pass by editing a magic number. */
const PINNED_MENTION_COUNT = PINNED_ROSTER_FRAGMENTS.reduce(
  (n, fragment) => n + rosterMentions(squash(fragment)).length,
  0,
);

/**
 * The roster mentions in `code` that do NOT lie inside an occurrence of one of
 * `fragments`. This is the whole of the SQL-face claim, and it is countable:
 * a second roster read anywhere in the file — nested however deeply, in any arm,
 * in any new function — is a mention outside every fragment, and turning a
 * fragment's gating `AND` into an `OR` stops that fragment from being found at
 * all.
 */
function rosterReadsOutside(code: string, fragments: readonly string[]): string[] {
  const flatCode = squash(code);
  const spans: Array<{ from: number; to: number }> = [];
  for (const fragment of fragments) {
    const flatFragment = squash(fragment);
    let at = flatCode.indexOf(flatFragment);
    while (at !== -1) {
      spans.push({ from: at, to: at + flatFragment.length });
      at = flatCode.indexOf(flatFragment, at + 1);
    }
  }
  return rosterMentions(flatCode)
    .filter(m => !spans.some(s => m.at >= s.from && m.at + m.table.length <= s.to))
    .map(m => `${m.table} @${m.at} is outside the pinned workspace-gated fragments`);
}

describe('db-boundary: participation authority', () => {
  it('the placement rule module cannot reach a roster at all', () => {
    const src = read(PLACEMENT_RULE);
    // The whole claim in one assertion: a type import erases at compile time, so
    // this module has NO runtime dependency, which is why "it does not consult
    // `conversation_agents`" is a property of the build and not of its author's
    // discipline. Adding any value import here is the reviewed diff that would
    // change that.
    expect(
      importsOf(codeOf(src)),
      `${PLACEMENT_RULE} gained an import — see this file's header`,
    ).toEqual([
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
      'workspace_users',
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

  it('the SQL face contains exactly ONE roster read per READING of the rule, and all of them are the pinned workspace-gated ones', () => {
    // `codeOf` first, for two reasons: this file's prose discusses the roster arm
    // at length, and a prose mention would otherwise count toward the allowance.
    const code = codeOf(read(PLACEMENT_SQL));
    expect(
      rosterReadsOutside(code, PINNED_ROSTER_FRAGMENTS),
      `${PLACEMENT_SQL}: a roster read outside the pinned fragments makes a stray roster row ` +
        'authoritative for a DM or an inbox in every embedded read face (delivery, activity, ' +
        'the runtime control planes, target gates)',
    ).toEqual([]);
    // …and exactly the pinned count, so the fragments are actually THERE. Zero
    // mentions would satisfy the assertion above while meaning the workspace arm
    // had lost its authority — the opposite failure.
    expect(rosterMentions(squash(code))).toHaveLength(PINNED_MENTION_COUNT);
    // The arms that resolve WITHOUT a roster, named so a future edit cannot make
    // them roster-backed and still pass by deleting an arm.
    expect(code).toContain(`placement_kind = 'direct_pair'`);
    expect(code).toContain(`placement_kind = 'agent_inbox'`);
    // Both predicate builders delegate rather than inlining, which is what keeps
    // the per-kind count meaningful as arms are added. The PRINCIPAL side travels
    // through as the expression the caller gave: a builder that dropped it and
    // hard-coded `?` would still read as a delegation while making the correlated
    // form bind a placeholder nobody supplies a parameter for.
    expect(code).toContain('workspaceAgentRosterEdge(conversationAlias, agentIdExpr)');
    expect(code).toContain('workspaceHumanRosterEdge(conversationAlias)');
    // …the SET reading delegates too, so its roster read stays the pinned one …
    expect(code).toContain('workspaceAgentRosterMembers()');
    // …and the agent face's two PUBLIC readings are two calls on ONE arm text, not
    // two copies of it: the point form is the only place `'?'` is introduced, and
    // the correlated form forwards its caller's expression untouched (P4-5).
    expect(code).toContain(`agentParticipatesSql(conversationAlias, '?')`);
    expect(code).toContain('agentParticipatesSql(conversationAlias, agentIdExpr)');

    // The human face's MISSING arm is a rule, not an omission: a human is never a
    // participant of an inbox. Pinned over the ARM TEXT — the builder that lists
    // them — rather than over the exported entry point: since P4-5 the arms live in
    // the shared `…ParticipatesSql` builder and each public face is one call to it,
    // so slicing from `export function userParticipates` now covers code with no
    // arms in it at all and would pass vacuously.
    const humanArms = armTextOf(code, 'userParticipates');
    expect(humanArms).not.toBe('');
    expect(humanArms).not.toContain('agent_inbox');
    // Both directions, so neither assertion can be satisfied by an empty slice: the
    // human arms carry the DM one, and the agent arms are where `agent_inbox` lives.
    expect(humanArms).toContain(`placement_kind = 'direct_pair'`);
    expect(armTextOf(code, 'agentParticipatesSql')).toContain(
      `placement_kind = 'agent_inbox'`,
    );
  });

  /**
   * The parameter-count half of the same refactor. The text gates above cannot see
   * it: the point form interpolates ONE placeholder per arm occurrence, and how
   * many that is depends on the arms — so its `params` list is a hand-written count
   * that an added arm silently invalidates, shifting every later parameter of every
   * caller's query (the failure {@link PlacementSqlFragment} exists to prevent).
   * Checked over VALUES because it is a value fact, and cheaply: the module is pure
   * SQL text with no driver.
   */
  it('the point form binds exactly as many parameters as it has placeholders, and the correlated form binds none', () => {
    const placeholders = (sql: string): number => sql.split('?').length - 1;
    for (const [name, fragment] of [
      ['agentParticipates', agentParticipates('c', 'agent-1')],
      ['userParticipates', userParticipates('c', 'user-1')],
    ] as const) {
      expect(placeholders(fragment.sql), `${name} placeholder/param mismatch`).toBe(
        fragment.params.length,
      );
      // …and every bound value is the SAME principal id, which is what makes the
      // count the only thing that can go wrong here.
      expect(new Set(fragment.params).size).toBe(1);
    }
    // The correlated form introduces no placeholder at all — a caller splices it
    // into a JOIN and binds nothing, so a stray `?` would consume some other
    // clause's parameter.
    expect(placeholders(agentParticipatesCorrelated('c', 'a.id'))).toBe(0);
    // Same text, read two ways: the correlated form given the point form's own
    // expression IS the point form's SQL, character for character. This is the
    // assertion that makes "one authority, two readings" a fact rather than a
    // comment — two hand-maintained copies of the arms would drift and this would
    // report it.
    expect(agentParticipatesCorrelated('c', '?')).toBe(agentParticipates('c', 'x').sql);
  });

  /**
   * The SET reading's shape. Its arms cannot be pinned by the fragment
   * count — only its roster read can — so the two properties that make it ONE
   * authority rather than a hand-rolled second query are asserted here:
   *
   *   - ARM COVERAGE. Every placement that can have an agent participant produces
   *     candidates: the workspace roster, BOTH `direct_pair` endpoints, the inbox
   *     owner. A missing arm is a placement whose recipients are silently nobody —
   *     the defect P4-5 exists to remove — and it returns an empty list rather than
   *     an error, so nothing else reports it. The equivalence test in
   *     `tests/read-model/participation-enumeration.test.ts` is the values-side twin.
   *   - ONE BINDING FOR ONE VALUE. The conversation id appears once per arm and is
   *     bound by NAME, so adding an arm cannot shift a caller's parameters — the
   *     failure `PlacementSqlFragment` exists to prevent, in the text most likely to
   *     grow an arm.
   */
  it('the set reading covers every placement arm and binds the conversation once, by name', () => {
    const sql = PARTICIPANT_AGENT_IDS_SQL;
    // A set, not a bag: each id is one delivery and one wake, and the arms being
    // mutually exclusive today is not what the callers rely on.
    const arms = sql.split(/\bUNION\b/);
    expect(arms).toHaveLength(4);
    expect(sql).not.toContain('UNION ALL');
    // One arm each, named by the column that answers for it — so an arm cannot be
    // deleted, nor two arms collapsed into one, and still pass.
    expect(arms.filter(arm => arm.includes('conversation_agents'))).toHaveLength(1);
    expect(arms.filter(arm => arm.includes('endpoint_a_id'))).toHaveLength(1);
    expect(arms.filter(arm => arm.includes('endpoint_b_id'))).toHaveLength(1);
    expect(arms.filter(arm => arm.includes('inbox_agent_id'))).toHaveLength(1);
    // Every arm projects the same column name, or the compound SELECT would fail at
    // prepare time in some arms only.
    for (const arm of arms) expect(arm).toContain('AS agent_id');
    // Every arm is anchored on ONE conversation by primary key — this is what keeps
    // the enumeration bounded by the conversation instead of by the table …
    expect([...sql.matchAll(/c_p\.id = @conv/g)]).toHaveLength(arms.length);
    // … and the binding is named, so there is exactly one value to supply.
    expect(sql.split('?')).toHaveLength(1);
    // LIVENESS IS NOT HERE (#task:2021 P4-5): the set is candidates. A `JOIN agents`
    // inside this text would redefine participation for every future reader of it;
    // the delivery statement adds it (`LIVE_PARTICIPANT_AGENT_IDS_SQL`).
    expect(sql).not.toContain('agents a');
    expect(sql).not.toContain('deleted_at');
  });

  it('the SQL face has no dependencies, so no roster edge can arrive from outside it', () => {
    // The mention count above is a claim about THIS FILE'S TEXT, and
    // an imported `extraRosterEdge(alias)` ORed into the predicate satisfies it
    // while running a second authority: the table name lives in the other module.
    // What forecloses that is the module's actual shape — SQL text with no
    // dependencies at all — so that is what gets pinned. NO imports is a stronger
    // and simpler claim than a list of banned ones: there is no "harmless helper"
    // exception to argue about, and gaining one is a reviewed diff.
    const src = read(PLACEMENT_SQL);
    expect(
      importsOf(codeOf(src)),
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

  it('fence self-test: only the pinned fragments pass, including B2’s bypasses', () => {
    // The shape the production file has: the pinned fragment and nothing else.
    const gated = `const sql = \`${PINNED_AGENT_ROSTER_FRAGMENT}
      OR (\${conversationAlias}.placement_kind = 'direct_pair' AND \${conversationAlias}.endpoint_a_id = ?)\`;`;
    expect(rosterReadsOutside(gated, PINNED_ROSTER_FRAGMENTS)).toEqual([]);

    // The `OR` bypass, verbatim in shape: the second arm's roster read is wide
    // open (the `OR` short-circuits the predicate away) while its nearest preceding
    // `placement_kind` is still `workspace`. The retired proximity check passed
    // this; the fragment check must not.
    const orBypass = `${gated}
      const more = \`OR (\${conversationAlias}.placement_kind = 'workspace'
        OR EXISTS (SELECT 1 FROM conversation_agents ca WHERE ca.agent_id = ?))\`;`;
    expect(rosterReadsOutside(orBypass, PINNED_ROSTER_FRAGMENTS)).toHaveLength(1);

    // The other half of B2: a bare roster read in a LATER statement, inheriting
    // nothing but the reader's optimism.
    const laterStatement = `${gated}
      const other = \`SELECT 1 FROM conversation_agents ca WHERE ca.agent_id = ?\`;`;
    expect(rosterReadsOutside(laterStatement, PINNED_ROSTER_FRAGMENTS)).toHaveLength(1);

    // A near-copy that swapped the gating `AND` for `OR` INSIDE the fragment is not
    // the pinned fragment at all, so its roster read is reported rather than
    // matched — the pin is what makes weakening it visible.
    const weakened = gated.replace(`placement_kind = 'workspace'
            AND EXISTS`, `placement_kind = 'workspace'
            OR EXISTS`);
    expect(rosterReadsOutside(weakened, PINNED_ROSTER_FRAGMENTS)).toHaveLength(1);

    // A fragment gated on one alias but joined on another must not match either.
    const aliasSwap = gated.replace('ca_p.conversation_id = ${conversationAlias}.id', 'ca_p.conversation_id = other.id');
    expect(rosterReadsOutside(aliasSwap, PINNED_ROSTER_FRAGMENTS)).toHaveLength(1);

    // Reindentation is NOT a violation: the claim is the SQL's shape.
    const reindented = gated.replace(/\n\s+/g, '\n  ');
    expect(rosterReadsOutside(reindented, PINNED_ROSTER_FRAGMENTS)).toEqual([]);

    // THE SET READING'S PIN, and the bypass it exists to report. The
    // pinned text passes …
    const membersGated = `const sql = \`${PINNED_AGENT_ROSTER_MEMBERS_FRAGMENT}\`;`;
    expect(rosterReadsOutside(membersGated, PINNED_ROSTER_FRAGMENTS)).toEqual([]);
    // … and the "simplification" that enumerates the roster for EVERY placement
    // does not. This is the set-shaped version of B2's bypass and the worse of the
    // two: it does not merely admit a stray roster row as a reader, it hands one to
    // the recipient fan-out of a DM or an inbox.
    const ungatedMembers = `const sql = \`SELECT ca_p.agent_id AS agent_id
              FROM conversations c_p
              JOIN conversation_agents ca_p
                ON ca_p.conversation_id = c_p.id
             WHERE c_p.id = @conv\`;`;
    expect(rosterReadsOutside(ungatedMembers, PINNED_ROSTER_FRAGMENTS)).toHaveLength(1);
    // …and so does the same read gated with an `OR`, which is the form that reads as
    // careful and is wide open.
    expect(
      rosterReadsOutside(
        membersGated.replace(`WHERE c_p.id = @conv
               AND c_p.placement_kind = 'workspace'`, `WHERE c_p.id = @conv
               OR c_p.placement_kind = 'workspace'`),
        PINNED_ROSTER_FRAGMENTS,
      ),
    ).toHaveLength(1);

    // THE HUMAN PAIR IS THE PIN. The whole fragment passes …
    const humanGated = `const sql = \`${PINNED_HUMAN_ROSTER_FRAGMENT}\`;`;
    expect(rosterReadsOutside(humanGated, PINNED_ROSTER_FRAGMENTS)).toEqual([]);
    // … and the "simplification" that keeps only the channel seat does NOT: it
    // would admit a person removed from the WORKSPACE whose `conversation_users`
    // row outlived the removal, and this is the assertion that reports it. Both
    // remaining mentions are outside every pin, because a partial fragment matches
    // nothing rather than matching partially.
    const seatOnly = `const sql = \`(\${conversationAlias}.placement_kind = 'workspace'
            AND EXISTS (
              SELECT 1 FROM conversation_users cu_p
               WHERE cu_p.conversation_id = \${conversationAlias}.id
                 AND cu_p.user_id = ?
            ))\`;`;
    expect(rosterReadsOutside(seatOnly, PINNED_ROSTER_FRAGMENTS)).toHaveLength(1);
    // … and so does an UNGATED human read — the same B2 bypass on the other kind.
    expect(
      rosterReadsOutside(
        `EXISTS (SELECT 1 FROM conversation_users cu WHERE cu.user_id = ?)
         AND EXISTS (SELECT 1 FROM workspace_users wu WHERE wu.user_id = ?)`,
        PINNED_ROSTER_FRAGMENTS,
      ),
    ).toHaveLength(2);
    // The mention scan sees `workspace_users` at all — without this, every human
    // assertion above would be counting only half the pair.
    expect(rosterMentions('FROM workspace_users wu_p').map(m => m.table)).toEqual([
      'workspace_users',
    ]);

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

    // The import escape, stated as the two halves it actually has. An EXTERNAL roster
    // edge, ORed into the predicate: the fragment check is BLIND to it (this file's
    // text still holds exactly one literal roster mention, inside the pin) …
    const external = [
      `import { extraRosterEdge } from './extra-roster.js';`,
      'const sql = `' + PINNED_AGENT_ROSTER_FRAGMENT,
      '      OR (${extraRosterEdge(conversationAlias)})`;',
    ].join('\n');
    expect(rosterReadsOutside(codeOf(external), PINNED_ROSTER_FRAGMENTS)).toEqual([]);
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
    // PROSE IS NOT A DEPENDENCY, which is why both call sites feed `codeOf` output
    // in: the multi-line scan reads "…starting from `conversations`" after any
    // line-initial `export` as a re-export, and the natural "fix" for that false
    // positive is deleting the sentence that documents the arm. Both halves are
    // asserted, so neither can be dropped as redundant.
    const prose = [
      'export const WORKSPACE_PLACED = `c.placement_kind = \'workspace\'`;',
      '/**',
      ' * Each arm starts from `conversations` by primary key.',
      ' */',
      'export const SQL = `SELECT 1`;',
    ].join('\n');
    expect(importsOf(prose)).toEqual([{ specifier: 'conversations', typeOnly: false }]);
    expect(importsOf(codeOf(prose))).toEqual([]);
  });

  /**
   * Both assertions are about CODE (`codeOf` blanks comments), because
   * the reason this gate exists is that the history has to stay writable: the
   * docblocks that explain why participation is unconditional necessarily name the
   * field that used to make it conditional. A prose fence would be "fixed" by
   * deleting the explanation.
   */
  it('participation is not a policy field — the send policy cannot express a bypass', () => {
    const code = codeOf(read(SEND_CONTRACTS));
    // The retired field by name, and any future spelling of the same idea: a
    // policy KEY whose name mentions participation.
    expect(code).not.toContain('requireSenderParticipation');
    expect(code.match(/^\s*\w*[Pp]articipa\w*\s*[?:]/gm) ?? []).toEqual([]);

    // Not a vacuous scan: the file's OTHER policy fields are still found here, so
    // a rename of the policy module cannot silently empty this assertion.
    for (const field of ['allowTarget', 'distributeExcludeSender', 'resolveRun']) {
      expect(code).toContain(field);
    }
  });

  it('the send write gate takes no policy object, so no field can gate it', () => {
    const code = codeOf(read(SEND_SERVICE));
    const signature = /private assertPostAuthority\(([^)]*)\)/.exec(code);
    expect(signature, 'assertPostAuthority moved or was renamed').not.toBeNull();
    const params = signature?.[1] ?? '';
    expect(params).toContain('tx: MessageTxScope');
    expect(params).not.toMatch(/SendMessagePolicy|policy/);

    // And the body reads no policy either — a captured `policy` in scope would be
    // the same defect with a different spelling.
    const body = code.slice(code.indexOf('private assertPostAuthority('));
    const end = body.indexOf('\n  }\n');
    expect(end).toBeGreaterThan(0);
    expect(body.slice(0, end)).not.toContain('policy');
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
        PINNED_ROSTER_FRAGMENTS,
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
