/**
 * #task:2035 (@Cindy B4) — the theorem the allocating arm's ORDER rests on:
 *
 *   ALLOCATION PERMITTED ⇒ REACH CANNOT REFUSE.
 *
 * The resolver's one side effect now announces itself at the mint, which puts the
 * `direct_pairs_changed` frame BEFORE `judgeDeliveryReach` runs. That is only
 * unobservable if no `(door, slot kind)` pair exists where the resolver may
 * allocate and reach then says no — otherwise a confined credential could open a
 * line, have its request refused, and leave a viewer holding a DM it can never
 * use.
 *
 * Both functions read `DELIVERY_REACH`, so the implication is a fact about that
 * table rather than about either function. It is therefore checked EXHAUSTIVELY
 * over the product of the two published registries: a new door, or a third slot
 * kind, is judged here the day it is added, with no test to remember to extend.
 *
 * The conversation id is chosen ADVERSARIALLY: for the permitted cells, reach is
 * asked about a conversation that is NOT the slot's own stream — the only input an
 * `own_stream` cell could refuse. A test that passed the slot's own conversation
 * would pass vacuously.
 */
import { ADDRESSED_OPERATIONS, RUNTIME_SLOT_KINDS } from '@silverhand/shared';
import { describe, expect, it } from 'vitest';
import {
  judgeDeliveryReach,
  mayAllocateFor,
} from '../src/application/delivery-reach.js';
import {
  agentRuntimePrincipal,
  conversationRuntimePrincipal,
  type RuntimePrincipal,
} from '../src/auth/runtime-principal.js';

const OWN_STREAM = 'ownStreamConv001';
const SOMEWHERE_ELSE = 'otherStreamCon02';

const principalOf = (kind: (typeof RUNTIME_SLOT_KINDS)[number]): RuntimePrincipal =>
  kind === 'agent_slot'
    ? agentRuntimePrincipal({
        agentId: 'agent00000000001',
        generation: 1,
        daemonInstanceId: 'daemon000000001',
      })
    : conversationRuntimePrincipal({
        conversationId: OWN_STREAM,
        agentId: 'agent00000000001',
        generation: 1,
        daemonInstanceId: 'daemon000000001',
      });

describe('the reach table admits no door that allocates on its way to a refusal', () => {
  it('permits allocation only where reach accepts any participating stream', () => {
    // Non-vacuity first: the product really contains both answers, so the
    // implication below is not being satisfied by an empty or uniform table.
    const cells = ADDRESSED_OPERATIONS.flatMap(operation =>
      RUNTIME_SLOT_KINDS.map(kind => ({ operation, kind })),
    );
    const permitted = cells.filter(
      ({ operation, kind }) => mayAllocateFor(operation, principalOf(kind)) === 'permitted',
    );
    expect(permitted.length, 'some door allocates').toBeGreaterThan(0);
    expect(permitted.length, 'some door does not').toBeLessThan(cells.length);

    for (const { operation, kind } of cells) {
      const principal = principalOf(kind);
      if (mayAllocateFor(operation, principal) !== 'permitted') continue;
      const label = `${operation} / ${kind}`;
      // The stream a freshly minted pair IS: never the credential's own
      // conversation, which is why this is the input that matters.
      expect(
        judgeDeliveryReach({ operation, principal, conversationId: SOMEWHERE_ELSE }),
        label,
      ).toEqual({ ok: true });
    }
  });

  it('refuses a confined door before it could have allocated', () => {
    // The other direction, as a live example rather than an argument: a
    // ConversationSlot sending a message may not allocate, and its reach refuses
    // any stream but its own. The two answers come from the same cell.
    const principal = principalOf('conversation_slot');
    expect(mayAllocateFor('message_send', principal)).toBe('forbidden');
    expect(
      judgeDeliveryReach({
        operation: 'message_send',
        principal,
        conversationId: SOMEWHERE_ELSE,
      }).ok,
    ).toBe(false);
    expect(
      judgeDeliveryReach({
        operation: 'message_send',
        principal,
        conversationId: OWN_STREAM,
      }),
    ).toEqual({ ok: true });
  });
});
