// The route-side half of delivery-target resolution: an address on the wire
// becomes a stream, or becomes an HTTP refusal (#task:2021 P4-4).
//
// ONE mapping for every P4 surface. The resolver's refusal codes are a closed set
// with a fixed meaning, so the status each one deserves is a property of the CODE
// and not of the surface that asked — a `target_unresolved` on `message send` and
// on `message history` are the same fact about the same address. Restating the
// switch per route is how the two would drift into answering differently, which
// is exactly the signal the existence collapse exists to deny.
//
// It is also where REACH is judged: after the address denotes a stream, before the
// route acts on it. The table is `@silverhand/shared`'s `delivery-reach.ts`; what
// lives here is the same thing as for every other refusal — which status and
// sentence the verdict becomes. So a door gets its confinement by naming its
// OPERATION, not by hand-writing a comparison against the credential's conversation.
//
// The refusal object is serialized WHOLESALE, and that is safe by construction:
// `DeliveryTargetRefusal` has one field, so there is nothing here that must
// remember to strip an operator reason. The reason already left through the
// observer (`observability/delivery-target-log.ts`) before this function saw the
// answer.
import type { Context } from 'hono';
import {
  CONVERSATION_TARGET_SUFFIX_REFUSAL_CODE,
  SLOT_REACH_REFUSAL_CODE,
  type AddressedOperation,
} from '@silverhand/shared';
import type { AppEnv } from '../../auth/principal.js';
import { getRuntimePrincipal } from '../../auth/principal.js';
import {
  judgeDeliveryReach,
  mayAllocateFor,
} from '../../application/delivery-reach.js';
import {
  resolveDeliveryTarget,
  type DeliveryIntent,
  type DeliveryTargetRefusalCode,
  type ResolvedDeliveryTarget,
} from '../../application/delivery-target-resolution.js';
import { deliveryTargetPorts } from '../../repos/delivery-target-persistence.js';
import type { InternalRouteDeps } from './deps.js';

/**
 * Status per refusal code.
 *
 * 400 for the three the caller can fix from the answer alone: a string that is not
 * an address, an inbox used as a write destination, and `dm:@<own handle>`. None
 * of them says anything about what exists — they are all judgements about the
 * token itself, or about a stream the caller already owns.
 *
 * 404 for the two that ARE about existence, and for exactly that reason: they are
 * where unknown and unauthorized collapse, and 403 would re-separate them by
 * status the moment one address gets a different number from another. A
 * non-participant therefore learns nothing beyond "not for you", which is what
 * they would also get for an id nobody ever held.
 */
// Scope refusal is 403 only after the peer visibility gate has passed.
const REFUSAL_STATUS: Record<DeliveryTargetRefusalCode, 400 | 403 | 404> = {
  target_malformed: 400,
  self_pair_not_addressable: 400,
  target_unresolved: 404,
  direct_message_scope_forbidden: 403,
  thread_not_in_target: 404,
};

const REFUSAL_MESSAGE: Record<DeliveryTargetRefusalCode, string> = {
  target_malformed: 'target is not an address',
  self_pair_not_addressable: 'a direct message needs another participant',
  target_unresolved: 'target names no stream you can use',
  direct_message_scope_forbidden: 'Conversation-scoped agents do not support DMs. Use a shared channel.',
  thread_not_in_target: 'target names no reply cluster of that conversation',
};

/**
 * The one refusal a CONVERSATION-granular door adds (#task:2021 P4-4).
 *
 * It is a route code and not a resolver one on purpose: the resolver answers
 * "which stream is this, and may you use it", and the answer does not depend on
 * who asked. Which GRANULARITY an operation acts on is the door's own fact — a
 * roster belongs to a conversation, a reply cluster has no member set — so the
 * refusal belongs where the door is declared. It stays in THIS file so there is
 * still exactly one place a P4 status/message pair can be read off.
 *
 * 400, and it leaks nothing: the verdict is a function of the token the caller
 * wrote and the door they called, with no lookup in it. Ignoring the suffix
 * instead would be the ambient guess P4 exists to remove, one level down —
 * silently acting somewhere other than where the actor pointed.
 */
const THREAD_SUFFIX_UNSUPPORTED = {
  code: CONVERSATION_TARGET_SUFFIX_REFUSAL_CODE,
  message: 'this operation addresses a conversation, not a reply cluster',
} as const;

/**
 * The refusal REACH adds: the address named a stream this agent is in, and this
 * door still acts only where the session is anchored (#task:2021 P4-4).
 *
 * 403, and the third status family on purpose. 400 is "the token is wrong", 404 is
 * "no stream you can use" — both would be false here, and the second one would be
 * actively misleading: the actor would go hunting for a better address for a stream
 * it named correctly. 403 says what is true, that the credential and not the
 * address is the limit, and `exitCodeFor('forbidden')` then tells the agent to stop
 * and report rather than to retry — right, because no input change makes a
 * ConversationSlot able to post into another stream.
 *
 * It leaks nothing the caller did not already have: reach is only judged after
 * resolution proved participation, so every 403 here is about a stream the actor
 * can already enumerate. A non-participant still gets the byte-identical 404.
 */
const SLOT_OUT_OF_SCOPE = {
  code: SLOT_REACH_REFUSAL_CODE,
  message: 'this operation acts only in the conversation your session is anchored to',
} as const;

export type ConversationTargetRefusalCode =
  | DeliveryTargetRefusalCode
  | typeof THREAD_SUFFIX_UNSUPPORTED.code
  | typeof SLOT_OUT_OF_SCOPE.code;

export type DeliveryTargetRouteResolution =
  | { ok: true; target: ResolvedDeliveryTarget }
  | { ok: false; response: Response };

/**
 * What resolution needs, and nothing else.
 *
 * A structural subset of {@link InternalRouteDeps} rather than the bag itself:
 * the membership sub-app is composed separately and holds no read model or
 * reaction repo, and "you may only resolve an address if you happen to carry the
 * whole data plane" is a wiring accident, not a rule. `InternalRouteDeps`
 * satisfies this by construction.
 */
export type DeliveryTargetRouteDeps = Pick<
  InternalRouteDeps,
  'ctx' | 'agents' | 'conversations' | 'messages' | 'users' | 'workspaces'
>;

/**
 * Resolve `address` for the calling agent, or produce the refusal Response.
 *
 * THREE STEPS, in this order, and the order is the contract (#task:2021 P4-4):
 * resolution answers which stream the address denotes and whether this AGENT may
 * use it; reach then answers whether this CREDENTIAL may act there through THIS
 * door; and only then does the route get a target to act on. Reach is judged here
 * rather than at the seven doors so that "which doors are confined" has one
 * answer — the shared ruling table — instead of seven that drift silently.
 *
 * The reach verdict needs the runtime PRINCIPAL, not the agent id: the whole
 * boundary is a function of the slot KIND; an AgentSlot has no ambient stream.
 * It comes from
 * {@link getRuntimePrincipal}, which throws if the internal auth middleware did not
 * run — a missing principal is a wiring fault and must not degrade into a
 * reinterpretation of the request (same rule as `task-routes.ts`'s `taskActorFrom`).
 * `agentId` is read off it too, so the participation the resolver proves and the
 * reach this judges are about the same agent by construction.
 *
 * `now` is taken from the caller rather than read here because the one
 * side-effecting arm (`dm:@handle` opening a pair on a write) stamps a row with
 * it, and a route that already has a request clock must not end up with two. That
 * arm is also why `allocation` is derived from the SAME reach table: a confined
 * door must not open a pair one step before refusing to use it. That arm's
 * CONSEQUENCE for a human's DM list is not this funnel's business either — it is
 * carried by the resolver's `allocations` port, so a door that does not come
 * through here still announces what it opened (see the note above the return).
 */
export function resolveDeliveryTargetForRoute(
  c: Context<AppEnv>,
  deps: DeliveryTargetRouteDeps,
  params: {
    address: string;
    operation: AddressedOperation;
    intent: DeliveryIntent;
    now: number;
  },
): DeliveryTargetRouteResolution {
  const principal = getRuntimePrincipal(c);
  const resolved = resolveDeliveryTarget(
    deliveryTargetPorts({
      agents: deps.agents,
      conversations: deps.conversations,
      messages: deps.messages,
      users: deps.users,
      workspaces: deps.workspaces,
      logger: deps.ctx.logger,
      events: deps.ctx.events,
    }),
    {
      address: params.address,
      principal: { kind: 'agent', id: principal.agentId },
      intent: params.intent,
      allocation: mayAllocateFor(params.operation, principal),
      now: params.now,
    },
  );
  if (!resolved.ok) {
    const { code } = resolved.refusal;
    return {
      ok: false,
      response: c.json(
        { error: REFUSAL_MESSAGE[code], code },
        REFUSAL_STATUS[code],
      ),
    };
  }
  const reach = judgeDeliveryReach({
    operation: params.operation,
    principal,
    conversationId: resolved.target.stream.conversationId,
  });
  if (!reach.ok) {
    return {
      ok: false,
      response: c.json(
        { error: SLOT_OUT_OF_SCOPE.message, code: reach.code },
        403,
      ),
    };
  }
  // The pair this call may just have MINTED was already announced, by the mint
  // itself (#task:2035). This funnel deliberately holds NO step for it: an
  // announcement that lived here would be a property of every door happening to
  // come through this function, and the door that does not — a human-initiated
  // open, #task:2036 — is exactly the one being written next (@Cindy B4). The
  // obligation therefore travels with the effect, as `allocations` on the
  // resolver's ports; see `application/direct-pairs-changed.ts`.
  //
  // Announcing at the mint also puts the frame BEFORE this reach verdict, which
  // costs nothing that could be missed: `mayAllocateFor` derives `allocation` from
  // the same table `judgeDeliveryReach` reads, so a resolution that ALLOCATED had
  // a non-confined domain and cannot be refused here. That implication is pinned
  // exhaustively over (door × slot kind) in `delivery-reach.test.ts` rather than
  // asserted in prose, because it is what makes the ordering unobservable.
  return { ok: true, target: resolved.target };
}

/**
 * Same address, for a door that acts on a CONVERSATION rather than on a stream
 * inside it — a roster change, a schedule's wake target (#task:2021 P4-4).
 *
 * One grammar still, so a header token pastes into these doors too; what differs
 * is that the optional `/thread:` suffix names something they have no operation
 * for, and is therefore refused rather than dropped.
 *
 * The suffix check runs AFTER resolution, which costs one lookup for an address
 * that was doomed anyway and buys the property that matters: an actor who may not
 * see the conversation gets the SAME 404 they would get without a suffix, so this
 * door cannot become the one place where a malformed-for-me answer distinguishes
 * an existing stream from an absent one. It runs after the REACH verdict for the
 * same reason in the other direction: a door the credential cannot use at all is
 * not a place to start teaching the actor about suffixes.
 */
export function resolveConversationTargetForRoute(
  c: Context<AppEnv>,
  deps: DeliveryTargetRouteDeps,
  params: {
    address: string;
    operation: AddressedOperation;
    intent: DeliveryIntent;
    now: number;
  },
): DeliveryTargetRouteResolution {
  const resolved = resolveDeliveryTargetForRoute(c, deps, params);
  if (!resolved.ok) return resolved;
  if (resolved.target.stream.threadRootId !== null) {
    return {
      ok: false,
      response: c.json(
        {
          error: THREAD_SUFFIX_UNSUPPORTED.message,
          code: THREAD_SUFFIX_UNSUPPORTED.code,
        },
        400,
      ),
    };
  }
  return resolved;
}
