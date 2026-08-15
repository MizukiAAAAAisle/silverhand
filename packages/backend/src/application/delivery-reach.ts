// The ENFORCING half of reach (#task:2021 P4-4). The ruling itself is data in
// `@silverhand/shared` (`delivery-reach.ts`), because the prompt and the CLI's help
// teach the same boundary and a rule an agent can only discover by being refused is
// a rule that was not published. What lives here is what only the server can do:
// turn a cell into a verdict about a real principal, and stop the resolver from
// allocating on its way to a refusal.
//
// WHY REACH IS NOT FOLDED INTO RESOLUTION. Resolution's answer is a property of the
// agent and the stream: it does not change when the same agent calls a different
// route. An agent participates in a channel whether or not the runtime slot it is
// currently speaking from may post there — participation is about the ROSTER, reach
// is about the CREDENTIAL. Folding them would also make the resolver's refusal codes
// depend on which route asked, and the existence collapse (unknown ≡ unauthorized)
// is only defensible because that answer is route-independent.
//
// ORDER IS PART OF THE CONTRACT: reach is judged AFTER resolution (an address must
// denote a stream before "may I act there" is a question) and BEFORE any side
// effect. The resolver has one — `getOrCreateDirectPair` on a main-line `dm:@handle`
// write — which would run before this judgement and leave a conversation behind a
// refusal. {@link mayAllocateFor} is how that is prevented, from the same table, so
// the two answers cannot disagree.
import {
  deliveryReachDomain,
  SLOT_REACH_REFUSAL_CODE,
  type AddressedOperation,
  type RuntimeSlotKind,
} from '@silverhand/shared';
import type { RuntimePrincipal } from '../auth/runtime-principal.js';
import type { DeliveryAllocation } from './delivery-target-resolution.js';

/**
 * The table is exhaustive over {@link RuntimeSlotKind}; this is the assertion that
 * the set it is exhaustive over is the set actually being judged.
 *
 * Both directions, because each failure is a different silent hole: a principal kind
 * missing from the shared vocabulary could not be judged at all, and a vocabulary
 * entry no principal has would leave a decided cell nothing ever reads — a ruling
 * believed to be in force that is not.
 */
type MutuallyAssignable<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : false
  : false;
const _slotKindsAgree: MutuallyAssignable<
  RuntimePrincipal['kind'],
  RuntimeSlotKind
> = true;
void _slotKindsAgree;

/**
 * What the actor is told when reach refuses: one code, no reason.
 *
 * The same shape as the resolver's refusals and for the same reason — the verdict
 * is a function of the door and the credential, both of which the caller already
 * knows, so there is nothing to widen it with. It is a SEPARATE code from
 * `target_unresolved` because it is a different instruction: the address was fine
 * and names a stream this agent really is in, so "fix the token" would be false
 * advice. Nor can it be read as an existence oracle: it is only reachable AFTER
 * resolution proved participation, i.e. only for streams the caller could already
 * enumerate.
 */
export type DeliveryReachVerdict =
  | { ok: true }
  | { ok: false; code: typeof SLOT_REACH_REFUSAL_CODE };

const REFUSED: DeliveryReachVerdict = {
  ok: false,
  code: SLOT_REACH_REFUSAL_CODE,
};

/**
 * Judge one resolved destination — total, fail-closed, and side-effect free.
 *
 * Takes the RESOLVED conversation id rather than the address: reach is a question
 * about the stream that was denoted, and re-reading the token here would be a
 * second grammar opinion. Takes the {@link RuntimePrincipal} rather than an agent
 * id plus a conversation id, because the whole point is that a slot KIND decides —
 * two loose coordinates are how a caller ends up passing the route anchor of an
 * AgentSlot as though it were an owned stream.
 */
export function judgeDeliveryReach(input: {
  operation: AddressedOperation;
  principal: RuntimePrincipal;
  conversationId: string;
}): DeliveryReachVerdict {
  switch (deliveryReachDomain(input.operation, input.principal.kind)) {
    case 'agent_participation':
      // Resolution already proved it; see the shared table's docblock.
      return { ok: true };
    case 'own_stream':
      return input.principal.kind === 'conversation_slot'
        && input.conversationId === input.principal.conversationId
        ? { ok: true }
        : REFUSED;
  }
}

/**
 * May the resolver ALLOCATE while resolving for this `(door, slot)` pair — read
 * off the same table, which is what makes the answer impossible to disagree with.
 *
 * `forbidden` for an `own_stream` cell, and it changes no permitted outcome: the
 * only allocating arm opens a brand-new `direct_pair`, a conversation that by
 * construction is not the one the credential is scoped to, so every address that
 * WOULD have allocated was already destined for a reach refusal. What it buys is
 * that the refusal leaves no conversation behind — the ordering the ruling
 * requires, enforced by a value the seam passes rather than by remembering to
 * check reach early at seven call sites.
 *
 * An address naming a pair that does not exist therefore comes back `unresolved`
 * from the confined doors, exactly as it already does from every read door: the
 * caller's own pairs are the one existence question they are always entitled to
 * ask, so the two answers do not form an oracle.
 */
export function mayAllocateFor(
  operation: AddressedOperation,
  principal: RuntimePrincipal,
): DeliveryAllocation {
  return deliveryReachDomain(operation, principal.kind) === 'own_stream'
    ? 'forbidden'
    : 'permitted';
}
