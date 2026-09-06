/**
 * #task:2021 P4-4 — every address refusal the backend publishes arrives at the
 * agent as something it can branch on.
 *
 * The gate exists because the two halves of this contract live in different
 * packages and neither one's type system reaches the other. The backend publishes
 * a closed vocabulary (`DELIVERY_TARGET_REFUSAL_CODES`); the CLI decides what an
 * agent actually reads. Nothing structural connects "the resolver started raising
 * `X`" to "the CLI carries `X` as a subkind" — so a new code would silently arrive
 * as `validation_error: ... (HTTP 400)`, which tells an agent to give up rather
 * than what to fix. This file is that connection: the ADOPTION is asserted per
 * published code, driven off the shared constant, so adding a code without
 * adopting it fails here.
 *
 * It also pins the two properties that make adoption SAFE rather than merely
 * informative:
 *   - `code` is unchanged — the exit class and retriability stay the closed enum's
 *     business, so a subkind can never make a refusal look retriable.
 *   - the collapse survives. The published codes carry no branch: unknown and
 *     unauthorized are one code, and all three ways a suffix can miss are one
 *     code. Publishing them therefore cannot become an existence oracle, and the
 *     test states that as an assertion over the SET rather than as a comment.
 *
 * One published code is not about the address at all: `slot_out_of_scope` is the
 * CREDENTIAL's reach boundary, arrives at 403, and must land as `forbidden` — so
 * the status is asserted per code rather than looped over.
 */
import { describe, expect, it } from 'vitest';
import {
  CONVERSATION_TARGET_SUFFIX_REFUSAL_CODE,
  DELIVERY_TARGET_REFUSAL_CODES,
  SLOT_REACH_REFUSAL_CODE,
} from '@silverhand/shared';
import { exitCodeFor, mapHttpError } from '../src/errors.js';

/** The wire shape `internal-agent/delivery-target.ts` sends: the fixed sentence
 *  in `error`, the refusal code beside it, and nothing else. */
const refusalBody = (code: string, message = 'refused'): string =>
  JSON.stringify({ error: message, code });

/**
 * Every published refusal, with the statuses its route actually uses and the
 * `code` each status must land as.
 *
 * The status is part of the expectation rather than a loop over all three,
 * because the classes differ in a way the agent acts on: an address refusal is
 * the caller's input (fix the token / drop the suffix / ask for access), while a
 * reach refusal is the CREDENTIAL's boundary — nothing about the request can be
 * edited into working, which is why 403 → `forbidden` → exit 3 is the right
 * class and `validation_error` would be the wrong advice.
 */
const PUBLISHED: ReadonlyArray<{ code: string; statuses: readonly number[] }> = [
  ...[...DELIVERY_TARGET_REFUSAL_CODES, CONVERSATION_TARGET_SUFFIX_REFUSAL_CODE].map(
    code => ({ code, statuses: code === 'direct_message_scope_forbidden' ? [403] as const : [400, 404] as const }),
  ),
  { code: SLOT_REACH_REFUSAL_CODE, statuses: [403] as const },
];

const CODE_FOR_STATUS: Record<number, string> = {
  400: 'validation_error',
  403: 'forbidden',
  404: 'not_found',
};

describe('a published address refusal reaches the agent as a subkind', () => {
  for (const { code, statuses } of PUBLISHED) {
    it(`${code}: adopted verbatim, with the backend's own sentence`, () => {
      for (const status of statuses) {
        const err = mapHttpError(status, refusalBody(code, 'the sentence'));
        expect(err.subkind, `${code} @ ${status}`).toBe(code);
        expect(err.message).toBe('the sentence');
        // The class still comes from the status, never from the subkind.
        expect(err.code, `${code} @ ${status}`).toBe(CODE_FOR_STATUS[status]);
        expect(err.retriable).toBe(false);
      }
    });
  }

  it('covers every code the shared vocabulary publishes', () => {
    // The loop above is driven off the constants, but the STATUS column is
    // hand-written per code — so a new code arriving with no row would be
    // exercised at nobody's status. This is the assertion that notices.
    expect(PUBLISHED.map(p => p.code).sort()).toEqual(
      [
        ...DELIVERY_TARGET_REFUSAL_CODES,
        CONVERSATION_TARGET_SUFFIX_REFUSAL_CODE,
        SLOT_REACH_REFUSAL_CODE,
      ].sort(),
    );
  });

  it('a reach refusal stops the agent rather than sending it to edit the address', () => {
    // The behavioural half of the class choice, stated once: same exit class as
    // any other authorization failure, and no retry.
    const err = mapHttpError(403, refusalBody(SLOT_REACH_REFUSAL_CODE, 'anchored'));
    expect(exitCodeFor(err.code)).toBe(3);
    expect(err.retriable).toBe(false);
  });

  it('leaves a code it does not publish out of the subkind entirely', () => {
    // Adoption is a closed list, not "trust whatever the backend called it":
    // an unknown code becomes telemetry noise and an agent-visible field nobody
    // documented. The message still comes through — that part is universal.
    const err = mapHttpError(400, refusalBody('some_new_route_code', 'nope'));
    expect(err.subkind).toBeUndefined();
    expect(err.message).toBe('nope');
    expect(err.code).toBe('validation_error');
  });

  it('carries the sentence from a string-valued `error` body', () => {
    // The shape 134 internal routes actually use. Before P4-4 this reached the
    // agent as `invalid input (HTTP 400)` — the status replacing the diagnosis.
    const err = mapHttpError(400, JSON.stringify({ error: 'conversation not found' }));
    expect(err.message).toBe('conversation not found');
  });

  it('prefers a nested `error.message` when a body carries both', () => {
    const err = mapHttpError(
      404,
      JSON.stringify({ error: { message: 'nested wins', code: 'not_found' } }),
    );
    expect(err.code).toBe('not_found');
    expect(err.message).toBe('nested wins');
  });

  it('publishes no code that distinguishes unknown from unauthorized', () => {
    // The collapse, stated where adoption happens. `target_unresolved` is the one
    // arm both land in; if a second code ever appears with "not_found",
    // "forbidden", "not_participant" or "unknown" in its name, the vocabulary has
    // grown a branch and this adoption would publish it.
    const suspicious = DELIVERY_TARGET_REFUSAL_CODES.filter(
      code =>
        code !== 'target_unresolved'
        && code !== 'direct_message_scope_forbidden' // only after peer visibility, covered by resolver tests
        && /not_found|forbidden|not_participant|unknown|missing/.test(code),
    );
    expect(suspicious).toEqual([]);
  });
});


it('keeps the manual DM instruction, stable scope code and stop exit', () => {
  const message = 'Conversation-scoped agents do not support DMs. Use a shared channel.';
  const error = mapHttpError(403, refusalBody('direct_message_scope_forbidden', message));
  expect(error.message).toBe(message);
  expect(error.subkind).toBe('direct_message_scope_forbidden');
  expect(error.code).toBe('forbidden');
  expect(exitCodeFor(error.code)).toBe(3);
  expect(error.retriable).toBe(false);
});
