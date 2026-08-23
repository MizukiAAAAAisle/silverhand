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
/** The only residual this artifact is allowed to lean on: the approved shape-issue policy. */
const APPROVED_POLICY_REFS = ['R7'];

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
   * artifact's own shape is checked before any case runs: a second expectation that is equal
   * to the reference is not a divergence, one that differs without a declared deviation is a
   * Rust-only snapshot wearing a contract's clothes, and a difference in STATUS is not a
   * body-shape deviation at all — it is behavioural incompatibility and must be reviewed as
   * such rather than annotated away (@Cindy, @Alice).
   */
  it('admits a second expectation only as a declared, body-only deviation', () => {
    for (const testCase of contract.cases) {
      const { rust_expected: rust, reference, deviation } = testCase;
      if (rust === undefined) {
        expect(deviation, `${testCase.name}: deviation without a second expectation`).toBe(
          undefined,
        );
        continue;
      }
      expect(rust, `${testCase.name}: equal expectations are not a divergence`).not.toEqual(
        reference,
      );
      expect(deviation, `${testCase.name}: an undeclared divergence`).toBeDefined();
      // A CLOSED SET, not a pattern: this artifact has exactly one approved policy, so
      // `R999` must not pass for looking like a residual reference.
      expect(APPROVED_POLICY_REFS).toContain(deviation!.policy_ref);
      expect(deviation!.boundary.length).toBeGreaterThan(0);
      expect(deviation!.owner.length).toBeGreaterThan(0);
      expect(deviation!.exit.length).toBeGreaterThan(0);
      // Body-only: the two sides accept and refuse the same requests with the same status.
      const status = (value: Expectation) =>
        'refused' in value ? value.refused.status : 'admitted';
      expect(
        status(rust),
        `${testCase.name}: a status divergence is not a body-shape deviation`,
      ).toEqual(status(reference));
    }
  });

  it.each(contract.cases)('$door — $name', testCase => {
    expect(answer(testCase)).toEqual(testCase.reference);
  });
});
