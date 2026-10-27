// REACH — how far one credential may act, door by door (#task:2021 P4-4; the 3/4
// boundary @shiki ruled on 2026-08-15, tabled in `docs/agent-scoped-session-v1.md`
// §7.1).
//
// The third of three questions an address passes through, and the only one that is
// about the CREDENTIAL:
//
//   grammar    — is this string an address?               (`delivery-target.ts`)
//   resolution — which stream, and may this AGENT use it?  (backend resolver)
//   reach      — may this CREDENTIAL, through this DOOR, act there?   (this table)
//
// WHY IT LIVES IN SHARED. The boundary has three readers and each one fails
// differently if it holds a stale copy: the backend ENFORCES it, the platform
// prompt TEACHES it, and the CLI's help TRANSLATES it into what to type. A rule
// that lived only where it is enforced is one an agent discovers by being refused —
// so the ruling is data here, and every surface derives its sentence from it rather
// than restating it. This is the same argument that put
// {@link DELIVERY_TARGET_REFUSAL_CODES} here, and the same failure it prevents.
//
// WHY A TABLE AND NOT A PREDICATE PER DOOR. The boundary is not derivable: it is a
// product ruling, door by door, over what a ConversationSlot's credential already
// reaches on `origin/main` (three published cross-stream doors that must not be
// revoked) versus what P4's addressing would newly hand it (four write doors that
// were pinned to the session's own conversation). A rule spelled at each route is a
// rule that drifts at each route, and the drift is silent: nothing fails when one
// door forgets. So the ruling is ONE total function over `(operation, slot kind)`,
// exhaustive at the type level in both axes — a new door or a third slot kind does
// not compile until its cell is decided.

/**
 * The kinds of runtime credential a session can hold.
 *
 * The vocabulary lives here because the reach table is indexed by it and every
 * teaching surface has to name it; the backend's `RuntimePrincipal` discriminant is
 * these same two literals, asserted equal where that type is defined so the table
 * cannot end up exhaustive over a different set than the one being judged.
 */
export const RUNTIME_SLOT_KINDS = ['conversation_slot', 'agent_slot'] as const;

export type RuntimeSlotKind = (typeof RUNTIME_SLOT_KINDS)[number];

/**
 * The doors that take an address — the closed set P4-4 converted, named by
 * OPERATION rather than by route.
 *
 * One entry per door and not per HTTP method: `message_history` covers the read
 * face, `channel_fork_source` names what the create door actually addresses (the
 * conversation whose workspace and roster the new channel is forked from, not the
 * channel being made). A door absent from this union has no address to judge.
 */
export const ADDRESSED_OPERATIONS = [
  'message_send',
  'message_history',
  'task_create',
  'schedule_create',
  'channel_fork_source',
  'file_upload',
  'member_add',
] as const;

export type AddressedOperation = (typeof ADDRESSED_OPERATIONS)[number];

/** The set of destinations a `(door, slot)` pair may act on. */
export type DeliveryReachDomain = 'own_stream' | 'agent_participation';

/**
 * THE RULING, as data.
 *
 * The mapped type is the enforcement: exhaustive over {@link AddressedOperation}
 * and over {@link RuntimeSlotKind}, so neither a new door nor a new slot kind can
 * be added anywhere in the codebase without deciding its reach here.
 *
 * The three `agent_participation` rows for `conversation_slot` are PUBLISHED
 * behaviour on `origin/main` — cross-stream history/search, cross-stream
 * `tasks/create` (`conversation_id: B`), a cross-stream schedule wake
 * (`target_conversation_id: B`) — and narrowing them would be revoking a shipped
 * capability, which is why option "A grants four, B revokes three" was resolved as
 * neither. The four `own_stream` rows are where P4's addressing would have GRANTED
 * a ConversationSlot something it never had; they stay pinned, and the address is
 * still required at the door so nothing is inferred from "here".
 *
 * WHAT THE TWO DOMAINS MEAN:
 *
 *  - `agent_participation` — the destination may be any stream this agent
 *    participates in. Enforcement adds NOTHING here, on purpose: resolution already
 *    proved exactly that. The cell is not a no-op that could be dropped, it is the
 *    STATEMENT that this door is open, made in the one place that also states where
 *    the others are closed.
 *  - `own_stream` — the destination must be the conversation the credential is
 *    scoped to. Only a ConversationSlot HAS one; an AgentSlot is woken in no
 *    stream, so an AgentSlot in an `own_stream` cell is refused. No cell pairs
 *    them today, and the judge fails closed if one ever does.
 */
export const DELIVERY_REACH: {
  readonly [O in AddressedOperation]: {
    readonly [S in RuntimeSlotKind]: DeliveryReachDomain;
  };
} = {
  // Published cross-stream reach — same for both slot kinds.
  message_history: {
    conversation_slot: 'agent_participation',
    agent_slot: 'agent_participation',
  },
  task_create: {
    conversation_slot: 'agent_participation',
    agent_slot: 'agent_participation',
  },
  schedule_create: {
    conversation_slot: 'agent_participation',
    agent_slot: 'agent_participation',
  },
  // Confined for a ConversationSlot; reached by participation for an AgentSlot,
  // which has no stream of its own and would otherwise be unable to act at all.
  message_send: {
    conversation_slot: 'own_stream',
    agent_slot: 'agent_participation',
  },
  file_upload: {
    conversation_slot: 'own_stream',
    agent_slot: 'agent_participation',
  },
  member_add: {
    conversation_slot: 'own_stream',
    agent_slot: 'agent_participation',
  },
  channel_fork_source: {
    conversation_slot: 'own_stream',
    agent_slot: 'agent_participation',
  },
};

export function deliveryReachDomain(
  operation: AddressedOperation,
  slotKind: RuntimeSlotKind,
): DeliveryReachDomain {
  return DELIVERY_REACH[operation][slotKind];
}

/**
 * The command an agent types for each door — the join between the ruling and every
 * surface that TEACHES it.
 *
 * Teaching surfaces speak commands, the ruling speaks operations, and the mapping
 * between them is the one thing a prose sentence would otherwise carry implicitly.
 * With it here, a prompt paragraph and a `--help` line are both DERIVED from the
 * table: no confined door can be described as open (or omitted) without changing
 * the ruling itself.
 */
export const ADDRESSED_OPERATION_COMMAND: {
  readonly [O in AddressedOperation]: string;
} = {
  message_send: 'message send',
  message_history: 'message history',
  task_create: 'task create',
  schedule_create: 'schedule create',
  channel_fork_source: 'channel create',
  file_upload: 'file upload',
  member_add: 'member add',
};

/**
 * The doors a given credential may use only in its own conversation, and the ones
 * it may use wherever it participates — in table order.
 *
 * Both lists from one call, because a teaching surface's real failure is not a wrong
 * list, it is a MISSING door: prose that enumerates the confined ones and then says
 * "everything else is open" is only true while nobody adds a door. The domain is
 * total, so every operation lands in exactly one of these two, and a surface that
 * renders both has enumerated all of them by construction.
 *
 * `confined` is empty for a credential with no confined door (an AgentSlot today) —
 * a real branch, not a fallback: if such a cell were ever ruled, the surfaces would
 * start naming it with no edit.
 */
export function reachTaughtCommands(slotKind: RuntimeSlotKind): {
  readonly confined: readonly string[];
  readonly participation: readonly string[];
} {
  const commandsWhere = (domain: DeliveryReachDomain): readonly string[] =>
    ADDRESSED_OPERATIONS.filter(
      (operation) => deliveryReachDomain(operation, slotKind) === domain,
    ).map((operation) => ADDRESSED_OPERATION_COMMAND[operation]);
  return {
    confined: commandsWhere('own_stream'),
    participation: commandsWhere('agent_participation'),
  };
}
