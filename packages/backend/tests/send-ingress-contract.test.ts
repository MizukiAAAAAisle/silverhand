import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { normalizeAttachmentRefs } from '@silverhand/shared';
import {
  UNREADABLE_SEND_BODY,
  admitAgentSend,
  admitHumanSend,
} from '../src/routes/send-ingress.js';

/**
 * WHAT A SEND REQUEST IS is decided by two implementations — these schemas and the Rust
 * ingress — and both must answer the same question about the same bodies. So the ingress
 * contract lives in one checked-in artifact that both consume: inputs plus the expectation,
 * never one side's output taken as the other's truth.
 *
 * THIS FILE IS THE REFERENCE SIDE, and it answers through PRODUCTION CODE. Every refusal comes
 * from `routes/send-ingress`, which is the same authority both send routes call — including the
 * value an unreadable body is judged as, the `invalid input` wrapper, and each door's own
 * content-cap wording. An earlier version restated those three in the test, which made this
 * oracle a second authority: changing a route's wording would have left it green (@Cindy).
 * Reading the body off the wire stays with the routes, because a body-limit error must be
 * rethrown rather than folded into a refusal.
 *
 * IT DOES NOT PROVE IT RAN FIRST. The artifact names this file, which proves only which
 * consumer owns it. What orders the two sides is the checked-in command the artifact names:
 * it runs this oracle, and only on success the Rust consumer. Running `cargo test` alone
 * proves nothing about whether this file passed (@Cindy).
 *
 * THE RULER IS THE APPROVED ERROR PARITY POLICY: status, `error`, and each issue's code, path
 * and contract-defined message. Zod's extra issue metadata is deliberately outside the
 * contract, so real issues are PROJECTED onto that ruler before comparison — a difference the
 * ruler does not measure is not a divergence, and pinning it here would freeze Zod's internals
 * into a cross-language contract.
 */

const here = dirname(fileURLToPath(import.meta.url));
const CONTRACT = join(here, 'send-ingress/contract.json');
const ORACLE = 'packages/backend/tests/send-ingress-contract.test.ts';

/**
 * THE CLOSED SET OF APPROVED DEVIATION POLICIES, each with the KIND of divergence it licenses.
 * A deviation is admitted only if its `policy_ref` is a key here; a ref that merely looks like a
 * residual (`R999`) is not. The kind decides how far the second expectation may travel from the
 * reference:
 *   - 'same-status'      — the two sides accept and refuse the same requests with the SAME status;
 *                          only the refusal body's shape differs (e.g. an issue path).
 *   - 'status-deviation' — a REVIEWED, bounded behavioural divergence: the reference refuses at
 *                          400 with issues, and Rust refuses at 422 with the minimal invalid-input
 *                          envelope. This is NOT a wildcard — the gate below pins that exact shape.
 * `R8` is the send-ingress semantic-admission status deviation frozen under #2236/#2243: Rust
 * semantic faults publish `422 {"error":"invalid input"}` and no Zod/Garde issues. (The former
 * `R7` same-status attachment-path deviation is retired: with issues dropped from the Rust
 * envelope entirely, those cases now diverge in status and fall under `R8`.)
 */
type PolicyKind = 'same-status' | 'status-deviation';
const APPROVED_POLICIES: Readonly<Record<string, PolicyKind>> = { R8: 'status-deviation' };
/** The one Rust shape a status deviation is allowed to be — never a general 422 escape hatch. */
const REVIEWED_STATUS_DEVIATION: Refused = {
  refused: { status: 422, body: { error: 'invalid input' } },
};

/** A case's identity within the artifact — the pair that names it uniquely. */
const identityOf = (testCase: { door: string; name: string }): string =>
  `${testCase.door} ${testCase.name}`;

/**
 * THE R8 AUTHORITY IS A MEMBERSHIP CLOSED SET, NOT A SHAPE. R8 governs exactly these
 * reviewed `(door, name)` cases — the ones the #2236/#2243 review found to enter Rust semantic
 * admission (`PayloadRefusal::Invalid`). Shape alone (400 reference + minimal 422) is not the
 * license: a future or mislabelled 400 case that is NOT semantic must not be able to opt into
 * R8 by wearing the shape. Enumerating the members here — and gating both directions against it
 * — is what keeps R8 from decaying into a 400→422 escape hatch. It also refuses to lean on the
 * incidental fact that every current 400 case happens to be semantic; that is an accident the
 * gate must not depend on.
 */
const R8_GOVERNED: readonly string[] = [
  'human human: a body with no content names nothing',
  'human human: content must be a string',
  'human human: an empty body says nothing at all',
  'human human: whitespace is not text',
  'human human: U+FEFF is whitespace to the refine, so this body says nothing',
  'human human: an optional list is not a nullable one',
  'human human: a blank bare id is not an id',
  'human human: an attachment id must be a string',
  'human human: an attachment label must be a string',
  'human human: a label must be the shape the contract words',
  'human human: two attachments may not wear the same label',
  'human human: over the count bound, both broken rules answer',
  'human human: a reply target may be absent but not empty',
  'human human: a reply target may not be null',
  "human human: every failing key answers, in the schema's own order",
  'human human: a body that is not an object is judged as a document',
  'human human: an array is not an object either',
  'human human: an unreadable body is judged as an empty object',
  'human human: the shape is judged before the size',
  'agent agent: a send with no address is not a send',
  'agent agent: an address may not be null',
  'agent agent: an address may not be empty',
  "agent agent: both faults answer, in the schema's own order",
  'agent agent: a send may not carry the one resolution a send cannot have',
  'agent agent: the freshness escape hatch is a boolean',
  'agent agent: an unreadable body is missing both required members',
];
const R8_GOVERNED_SET: ReadonlySet<string> = new Set(R8_GOVERNED);

/**
 * The exact metadata every R8 case carries. Pinning it whole — not just `.length > 0` — makes
 * the policy authority (`#2236`/`#2247`, not any ephemeral author) part of the seal, so a case
 * cannot claim R8 with hand-waved boundary/owner/exit text.
 */
const R8_DEVIATION = {
  policy_ref: 'R8',
  boundary:
    'Rust semantic admission (PayloadRefusal::Invalid) publishes 422 {"error":"invalid input"} with no issues, where the TS reference still publishes 400 + projected Zod issues. Applies ONLY to reference-400 refused cases that enter semantic admission; malformed/syntax structural faults keep their native layer and 413 content-cap refusals are unaffected — neither carries this deviation.',
  owner:
    '#2247 send-ingress artifact governance; authority: shiki standing contract #2236, reviewed under #2243.',
  exit: 'Delete this deviation and its rust_expected when the TS send-ingress production converges to the frozen 422 {"error":"invalid input"} contract (reference == rust_expected), or when the TS reference route is retired.',
} as const;

type Issue = { code: string; path: (string | number)[]; message?: string };
type Refused = { refused: { status: number; body: Record<string, unknown> } };
type Admitted = { admitted: Record<string, unknown> };
type Expectation = Refused | Admitted;
type Case = {
  name: string;
  door: 'human' | 'agent';
  body?: unknown;
  raw_body?: string;
  generated_content?: { repeat: string; times: number };
  reference: Expectation;
  rust_expected?: Expectation;
  deviation?: {
    policy_ref: string;
    boundary: string;
    owner: string;
    exit: string;
  };
};
type Contract = { oracle: string; consumer: string; command: string; cases: Case[] };

const contract = JSON.parse(readFileSync(CONTRACT, 'utf8')) as Contract;

/** The ruler: what the contract measures about one issue, and nothing else. */
function projectIssue(issue: { code: string; path: (string | number)[]; message?: string }): Issue {
  const projected: Issue = { code: issue.code, path: issue.path };
  // A message is part of the contract only where the contract words the rule itself; Zod's
  // generated sentences for type and bound failures are not.
  if (issue.code === 'custom' && issue.message !== undefined) projected.message = issue.message;
  return projected;
}

/** The body each case sends, with a generated `content` where the case asks for one. */
function bodyOf(testCase: Case): unknown {
  if (testCase.raw_body !== undefined) {
    try {
      return JSON.parse(testCase.raw_body);
    } catch {
      // WHAT an unreadable body is judged as is the ingress's own decision, imported rather
      // than restated here.
      return UNREADABLE_SEND_BODY;
    }
  }
  if (testCase.generated_content === undefined) return testCase.body;
  const { repeat, times } = testCase.generated_content;
  return { ...(testCase.body as Record<string, unknown>), content: repeat.repeat(times) };
}

/** The production ingress's own answer, with its issues projected onto the ruler. */
function answer(testCase: Case): Refused | Admitted {
  const body = bodyOf(testCase);
  const admission =
    testCase.door === 'human' ? admitHumanSend(body) : admitAgentSend(body);

  if (admission.refusal) {
    const { status, body: refusalBody } = admission.refusal;
    if (status === 400) {
      return {
        refused: {
          status,
          body: { ...refusalBody, issues: refusalBody.issues.map(projectIssue) },
        },
      };
    }
    // The cap refusal carries no issues, so the ruler measures it whole.
    return { refused: { status, body: refusalBody } };
  }

  const data = admission.admitted;
  const admitted: Record<string, unknown> = {
    content: data.content,
    attachments: normalizeAttachmentRefs(data.attachment_ids).map(ref =>
      ref.label === undefined ? { id: ref.id } : { id: ref.id, label: ref.label },
    ),
  };
  if (testCase.door === 'human') {
    admitted.reply_to_message_id =
      (data as { reply_to_message_id?: string }).reply_to_message_id ?? null;
  } else {
    const agent = data as { target: string; freshness_bypass?: boolean };
    admitted.target = agent.target;
    admitted.freshness_bypass = agent.freshness_bypass ?? false;
  }
  return { admitted };
}

describe('send ingress contract', () => {
  it('names this file as the consumer that owns it', () => {
    // Proves WHICH consumer, not that it ran first — see the header.
    expect(contract.oracle).toBe(ORACLE);
    expect(contract.consumer.endsWith('send_ingress_contract.rs')).toBe(true);
    expect(contract.command).toBe('scripts/parity-send-ingress.sh');
    expect(contract.cases.length).toBeGreaterThan(0);
  });

  /**
   * THE META GATES. A divergence is the one thing this artifact must never hide, so the
   * artifact's own shape is checked before any case runs: a second expectation equal to the
   * reference is not a divergence, and one that differs without a declared deviation is a
   * Rust-only snapshot wearing a contract's clothes.
   *
   * A STATUS DIFFERENCE is behavioural incompatibility, not a body-shape deviation, and used to
   * be barred outright. It now has exactly ONE licensed form: the send-ingress semantic-admission
   * deviation reviewed and frozen under #2236/#2243 (`R8`), where the reference refuses at 400
   * with issues and Rust refuses at 422 with the minimal invalid-input envelope. The gate pins
   * that precise shape — an ungoverned status mismatch, an unknown policy, or any other 422 body
   * still fails — so a reviewed deviation can be expressed without becoming an escape hatch
   * (@Cindy, @Alice).
   */
  const statusOf = (value: Expectation) =>
    'refused' in value ? value.refused.status : 'admitted';

  // One case against one closed policy set — extracted so the falsifier can drive it with
  // synthetic cases and prove the gate still rejects what it must.
  const assertDeclaredDeviation = (
    testCase: Case,
    policies: Readonly<Record<string, PolicyKind>> = APPROVED_POLICIES,
    governed: ReadonlySet<string> = R8_GOVERNED_SET,
  ): void => {
    const { rust_expected: rust, reference, deviation } = testCase;
    if (rust === undefined) {
      expect(deviation, `${testCase.name}: deviation without a second expectation`).toBe(undefined);
      return;
    }
    expect(rust, `${testCase.name}: equal expectations are not a divergence`).not.toEqual(reference);
    expect(deviation, `${testCase.name}: an undeclared divergence`).toBeDefined();
    // A CLOSED SET, not a pattern: a ref that only looks like a residual must not pass.
    const kind = policies[deviation!.policy_ref];
    expect(kind, `${testCase.name}: ${deviation!.policy_ref} is not an approved policy`).toBeDefined();
    expect(deviation!.boundary.length).toBeGreaterThan(0);
    expect(deviation!.owner.length).toBeGreaterThan(0);
    expect(deviation!.exit.length).toBeGreaterThan(0);
    if (kind === 'status-deviation') {
      // The reviewed form only: a 400-with-issues reference against the minimal 422 envelope,
      // AND the case must be an enumerated member of the R8 authority — shape alone is not the
      // license. Anything else — an admitted or non-400 reference, a different 422 body, or a
      // 400 case that is not on the reviewed list — is a bug.
      expect(reference, `${testCase.name}: a status deviation governs a refusal`).toHaveProperty(
        'refused',
      );
      expect(
        (reference as Refused).refused.status,
        `${testCase.name}: a status deviation governs a 400 reference`,
      ).toBe(400);
      expect(rust, `${testCase.name}: the reviewed Rust shape is 422 minimal invalid input`).toEqual(
        REVIEWED_STATUS_DEVIATION,
      );
      expect(
        governed.has(identityOf(testCase)),
        `${testCase.name}: R8 governs only the enumerated reviewed members, not any 400 case`,
      ).toBe(true);
      // The policy authority is pinned whole, so R8 cannot be claimed with hand-waved metadata.
      expect(deviation, `${testCase.name}: the R8 metadata is the sealed policy authority`).toEqual(
        R8_DEVIATION,
      );
    } else {
      // Ordinary deviation: same request, same status; only the body shape differs.
      expect(
        statusOf(rust),
        `${testCase.name}: a status divergence is not a body-shape deviation`,
      ).toEqual(statusOf(reference));
    }
  };

  // The R8 identities the artifact actually carries — the raw material for the membership seal.
  const r8IdentitiesIn = (cases: Case[]): string[] =>
    cases.filter(testCase => testCase.deviation?.policy_ref === 'R8').map(identityOf);

  // Both directions against the enumerated authority — extracted so the falsifier can drive it
  // with synthetic corpora and prove it rejects a drifting list or a drifting artifact.
  const assertGovernedMembership = (
    cases: Case[],
    governed: readonly string[] = R8_GOVERNED,
  ): void => {
    const carried = r8IdentitiesIn(cases);
    // No identity wears R8 twice — a duplicated case cannot smuggle a second license in.
    expect(new Set(carried).size, 'an R8 identity appears more than once').toBe(carried.length);
    // The artifact's R8 set is EXACTLY the authority: no unlisted case wears R8 (no extra), and
    // every reviewed member is present carrying R8 (no missing).
    expect([...carried].sort()).toEqual([...governed].sort());
    for (const id of governed) {
      const matches = cases.filter(testCase => identityOf(testCase) === id);
      expect(matches.length, `${id}: a reviewed member appears exactly once`).toBe(1);
      expect(matches[0]!.deviation?.policy_ref, `${id}: a reviewed member carries R8`).toBe('R8');
    }
  };

  it('admits a second expectation only as a declared, closed-policy deviation', () => {
    for (const testCase of contract.cases) assertDeclaredDeviation(testCase);
  });

  it('binds R8 to exactly the reviewed member set, in both directions', () => {
    assertGovernedMembership(contract.cases);
  });

  it('keeps the resident gate red for an ungoverned or mis-shaped status divergence', () => {
    const base: Case = {
      name: 'synthetic',
      door: 'human',
      body: {},
      reference: { refused: { status: 400, body: { error: 'invalid input', issues: [] } } },
      rust_expected: { refused: { status: 422, body: { error: 'invalid input' } } },
    };
    const dev = { boundary: 'b', owner: 'o', exit: 'e' };
    // 1. A status divergence with NO declared deviation is still a bug.
    expect(() => assertDeclaredDeviation(base)).toThrow();
    // 2. A ref that only looks like a residual is not in the closed set.
    expect(() =>
      assertDeclaredDeviation({ ...base, deviation: { policy_ref: 'R999', ...dev } }),
    ).toThrow();
    // 3. A same-status-only policy cannot license a status change (drives the else branch with
    //    an injected policy set so the production set need carry no dead ref).
    expect(() =>
      assertDeclaredDeviation(
        { ...base, deviation: { policy_ref: 'RS', ...dev } },
        { RS: 'same-status' },
      ),
    ).toThrow();
    // 4. R8 is not a 422 wildcard: a different 422 body is not the reviewed shape.
    expect(() =>
      assertDeclaredDeviation({
        ...base,
        rust_expected: { refused: { status: 422, body: { error: 'nope' } } },
        deviation: { policy_ref: 'R8', ...dev },
      }),
    ).toThrow();
    // 5. R8 governs a 400 reference only — not a 413 cap or an admitted case.
    expect(() =>
      assertDeclaredDeviation({
        ...base,
        reference: { refused: { status: 413, body: { error: 'too large' } } },
        deviation: { policy_ref: 'R8', ...dev },
      }),
    ).toThrow();
    // 6. THE MEMBERSHIP FALSIFIER: a case that wears the exact reviewed shape AND the exact
    //    sealed R8 metadata but is NOT an enumerated member must still be rejected — shape is
    //    not the license. (`base` is `human synthetic`, absent from R8_GOVERNED.)
    expect(() => assertDeclaredDeviation({ ...base, deviation: R8_DEVIATION })).toThrow();
    // 7. The list and the artifact must not drift apart: a reviewed member missing its R8 fails.
    const listed: Case = {
      name: 'x',
      door: 'human',
      body: {},
      reference: { refused: { status: 400, body: {} } },
    };
    expect(() => assertGovernedMembership([listed], ['human x'])).toThrow();
    // 8. Nor may a duplicated identity carry R8 twice.
    const member: Case = { ...listed, rust_expected: REVIEWED_STATUS_DEVIATION, deviation: R8_DEVIATION };
    expect(() => assertGovernedMembership([member, { ...member }], ['human x'])).toThrow();
  });

  it.each(contract.cases)('$door — $name', testCase => {
    expect(answer(testCase)).toEqual(testCase.reference);
  });
});
