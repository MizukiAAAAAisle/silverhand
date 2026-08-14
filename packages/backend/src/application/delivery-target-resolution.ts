// Delivery-target RESOLUTION — an address becomes a stream
// (agent-scoped-session-v1 §3 / §6, #task:2021 P4-2).
//
// `packages/shared`'s `delivery-target.ts` owns the GRAMMAR: which strings are
// addresses at all, and how the canonical one is spelled. It cannot answer
// whether an address names anything, because that needs the conversation store,
// the handle registry and the authenticated principal — an address is a REQUEST
// for a stream, never proof that one exists. This module is that second step and
// only that: `DeliveryTargetInput` → `(conversation_id, thread_root_id)`, or a
// typed refusal.
//
// FOUR RULES, all fail-closed, in this order (the order is part of the
// contract — see the numbered comments in `resolveDeliveryTarget`):
//
//   1. the grammar must accept the string;
//   2. the head must name a conversation this principal PARTICIPATES in, judged
//      by the one participation authority (`ConversationRepo.isAgentParticipant`,
//      the boolean face of `conversation-placement-sql.ts`), never by a rule
//      restated here;
//   3. a WRITE may not target an `agent_inbox` placement — the grammar is
//      placement-blind on purpose, so this is the resolver's rule to carry;
//   4. a thread suffix must name a ROOT message of the resolved conversation.
//
// TWO PROPERTIES ARE WORTH MORE THAN THE RULES THEMSELVES:
//
// UNKNOWN AND UNAUTHORIZED ARE ONE OUTCOME. A conversation that does not exist
// and one the principal may not touch both return `target_unresolved` with
// nothing else distinguishing them. Otherwise the resolver becomes an existence
// oracle over every conversation id in the installation: an id is 16 random
// characters, so it cannot be guessed, but it CAN be pasted from a place the
// reader was authorized to see and later removed from — and "does this still
// exist" is not a question a non-participant may ask. The operator-facing reason
// is carried separately ({@link DeliveryTargetRefusal.operatorReason}) so a log
// can still say which branch fired; it must never cross to the actor.
//
// READS NEVER ALLOCATE. `dm:@handle` on a WRITE may open the pair — that is what
// makes a DM reachable without a prior invitation — while every read surface
// (history, search, file, schedule) resolves with a FIND. A read that created its
// own subject would turn a typo into a permanent empty conversation, and would
// make "no such stream" unobservable: the second attempt would succeed.
//
// WHAT THIS MODULE DELIBERATELY DOES NOT DECIDE. Whether the stream accepts a
// message right now — archived, closed, a `direct_pair` whose other endpoint is
// deleted — belongs to the WRITE gate (`canPostToConversation`), which reads the
// same columns for a different question. Resolution answers "which stream is
// this", posting answers "may I post there", and collapsing them would mean an
// address stops resolving because a channel was archived, so an agent could no
// longer even name the conversation it is quoting.
import {
  parseDeliveryTargetInput,
  requireAddressableId,
  type ConversationEndpointIdentity,
  type ConversationPlacementKind,
  type DeliveryTarget,
} from '@silverhand/shared';

/**
 * What the resolver needs to know about a conversation: WHERE it lives, and
 * nothing else.
 *
 * Deliberately not `ConversationIdentity`: the answer here depends on the
 * placement ARM (rule 3) and on nothing else about the row, and a wider shape
 * would invite this module to start judging visibility or archive state — the
 * write gate's job (see the module docblock). `ConversationIdentity` is a
 * structural supertype, so the repository satisfies this port without a
 * conversion step.
 */
export interface DeliveryTargetConversation {
  id: string;
  placement_kind: ConversationPlacementKind;
}

/**
 * The conversation capability, as four questions rather than a repository.
 *
 * `getOrCreateDirectPair` is the only side-effecting member, and it is the only
 * one a read intent never reaches — a property this module keeps by CONSTRUCTION
 * (there is exactly one call site, guarded by `intent === 'write'`) rather than
 * by discipline at each surface.
 */
export interface DeliveryTargetConversationsPort {
  getIdentity(conversationId: string): DeliveryTargetConversation | null;
  /** PARTICIPATION, per placement — the one authority, not the roster table. */
  isAgentParticipant(conversationId: string, agentId: string): boolean;
  findDirectPair(
    x: ConversationEndpointIdentity,
    y: ConversationEndpointIdentity,
  ): DeliveryTargetConversation | null;
  getOrCreateDirectPair(
    x: ConversationEndpointIdentity,
    y: ConversationEndpointIdentity,
    now: number,
  ): { conversation: DeliveryTargetConversation; created: boolean };
}

/** The one message fact a target needs: is this id a ROOT of that conversation's
 *  reply clusters. Scoped by conversation in the query itself, so a root id from
 *  another conversation is indistinguishable from one that does not exist —
 *  the same collapse as rule 2, for the same reason. */
export interface DeliveryTargetMessagesPort {
  getInConversation(
    conversationId: string,
    messageId: string,
  ): { id: string; thread_root_id: string | null } | null;
}

/** Handle → principal. Two lookups because a handle names a user OR an agent;
 *  the ORDER is irrelevant to the answer, since v21's cross-namespace triggers
 *  make a handle unique across `users.name` ⊕ `agents.name` — which is also why
 *  the shorthand needs no `dm:<kind>/@handle` spelling to disambiguate. */
export interface DeliveryTargetPrincipalsPort {
  getByName(name: string): { id: string } | null;
}

export interface DeliveryTargetPorts {
  conversations: DeliveryTargetConversationsPort;
  messages: DeliveryTargetMessagesPort;
  agents: DeliveryTargetPrincipalsPort;
  users: DeliveryTargetPrincipalsPort;
}

/**
 * Whose first person the shorthand is read in.
 *
 * Agent-only in v1, as a TYPE rather than a runtime check: every P4 surface is an
 * agent-facing CLI, and the human composer resolves a name against the WORKSPACE
 * roster instead (#task:2000's `@handle` shorthand), which is a different
 * function with a different domain. Widening this to `human` therefore has to be
 * a deliberate edit that also brings the human participation face
 * (`resolveParticipation`) with it, not something a call site can do by passing a
 * different kind.
 */
export interface DeliveryTargetPrincipal {
  kind: 'agent';
  id: string;
}

/** Why the address is being resolved. The asymmetry is the point: see "READS
 *  NEVER ALLOCATE" in the module docblock. */
export type DeliveryIntent = 'read' | 'write';

export type DeliveryTargetRefusalCode =
  /** Not an address at all. Says nothing about what exists, so it stays
   *  distinct: telling the actor their string is malformed is the only way they
   *  can fix it, and it is exactly the case where no lookup happened. */
  | 'target_malformed'
  /** The address names no stream this principal may use — unknown and
   *  unauthorized COLLAPSED (module docblock). */
  | 'target_unresolved'
  /** An `agent_inbox` placement is not a write destination (rule 3). */
  | 'inbox_not_writable'
  /** The thread suffix names no reply cluster of the resolved conversation. */
  | 'thread_not_in_target'
  /** `dm:@<own handle>`: a DM has two participants (§4.1). */
  | 'self_pair_not_addressable';

/**
 * The branch that actually fired — FOR LOGS AND TESTS ONLY.
 *
 * Separate field, and named for its audience, because the collapse above is only
 * real if the distinction cannot reach the actor by accident: a route that
 * serializes a refusal object wholesale is then visibly wrong at the call site
 * rather than silently leaking an existence signal.
 */
export type DeliveryTargetOperatorReason =
  | 'grammar'
  | 'conversation_not_found'
  | 'not_participant'
  | 'unknown_handle'
  | 'direct_pair_not_found'
  | 'inbox_write'
  | 'self_pair'
  | 'thread_root_not_found'
  | 'thread_root_not_a_root';

export interface DeliveryTargetRefusal {
  code: DeliveryTargetRefusalCode;
  /** Operator-only. Never rendered to the actor — see the type's docblock. */
  operatorReason: DeliveryTargetOperatorReason;
}

export interface ResolvedDeliveryTarget {
  /** The canonical value object: what the delivery header renders and what a
   *  reply copies back. Built from OUR OWN ids, hence `requireAddressableId` —
   *  a stream whose id cannot be spelled has no address, and omitting the target
   *  is the ambient guess P4 exists to remove. */
  stream: DeliveryTarget;
  placementKind: ConversationPlacementKind;
  /** True iff THIS resolution opened the direct pair. For a caller that must
   *  post a first message or emit an event exactly once; accurate under the
   *  get-or-create race, which the DB elects. */
  created: boolean;
}

export type DeliveryTargetResolution =
  | { ok: true; target: ResolvedDeliveryTarget }
  | { ok: false; refusal: DeliveryTargetRefusal };

export interface DeliveryTargetRequest {
  /** The address exactly as received — from a `--target` flag or copied out of a
   *  delivery header. Not pre-parsed by the caller: the grammar refusal is one of
   *  this function's outcomes, so a surface that parsed first would have to
   *  invent its own error for the same case. */
  address: string;
  principal: DeliveryTargetPrincipal;
  intent: DeliveryIntent;
  /** Creation timestamp for the one write that can allocate. */
  now: number;
}

function refuse(
  code: DeliveryTargetRefusalCode,
  operatorReason: DeliveryTargetOperatorReason,
): DeliveryTargetResolution {
  return { ok: false, refusal: { code, operatorReason } };
}

/**
 * The principal a handle names, as a DM endpoint — or `null` for a handle nobody
 * holds.
 *
 * The endpoint's KIND comes from WHICH registry answered, and cannot be otherwise:
 * the two namespaces are disjoint by v21's triggers, so at most one lookup can
 * succeed and the lookup order is not a tie-break. That is also the reason the
 * shorthand needs no `dm:<kind>/@handle` spelling — a kind segment would carry no
 * information the handle does not already determine.
 */
function resolveHandleEndpoint(
  ports: DeliveryTargetPorts,
  handle: string,
): ConversationEndpointIdentity | null {
  const agent = ports.agents.getByName(handle);
  if (agent !== null) return { kind: 'agent', id: agent.id };
  const user = ports.users.getByName(handle);
  return user === null ? null : { kind: 'human', id: user.id };
}

/**
 * Resolve an address to the stream it names, for this principal, at this intent.
 *
 * Total: every input produces either a stream or a typed refusal. The only throw
 * is `requireAddressableId` on a resolved conversation's own id, which is
 * corruption rather than input (a row whose id no address can carry).
 */
export function resolveDeliveryTarget(
  ports: DeliveryTargetPorts,
  request: DeliveryTargetRequest,
): DeliveryTargetResolution {
  // ── 1. Grammar ────────────────────────────────────────────────
  const input = parseDeliveryTargetInput(request.address);
  if (input === null) return refuse('target_malformed', 'grammar');

  const threadRootId =
    input.kind === 'stream' ? input.stream.threadRootId : input.threadRootId;

  // ── Head → conversation ───────────────────────────────────────
  let conversation: DeliveryTargetConversation;
  let created = false;
  if (input.kind === 'stream') {
    const found = ports.conversations.getIdentity(input.stream.conversationId);
    if (found === null) return refuse('target_unresolved', 'conversation_not_found');
    conversation = found;
  } else {
    const them = resolveHandleEndpoint(ports, input.handle);
    if (them === null) return refuse('target_unresolved', 'unknown_handle');
    if (them.kind === 'agent' && them.id === request.principal.id) {
      // Refused before the store is asked, so the caller's INTENT is still
      // visible: `canonicalEndpointOrder` would throw on a self-pair, and a
      // thrown constraint is not an answer to "who did you mean".
      return refuse('self_pair_not_addressable', 'self_pair');
    }
    const me: ConversationEndpointIdentity = { kind: 'agent', id: request.principal.id };
    // Allocation happens only for a MAIN-LINE write. A thread suffix names a
    // reply cluster, which a brand-new pair cannot have, so creating the pair
    // first would leave a conversation behind a refusal — the resolver's one
    // side effect must not outlive a rejected resolution.
    if (request.intent === 'write' && threadRootId === null) {
      const opened = ports.conversations.getOrCreateDirectPair(me, them, request.now);
      conversation = opened.conversation;
      created = opened.created;
    } else {
      const found = ports.conversations.findDirectPair(me, them);
      if (found === null) return refuse('target_unresolved', 'direct_pair_not_found');
      conversation = found;
    }
  }

  // ── 2. Participation, through the ONE authority ───────────────
  // Applied to every arm, including a pair this call just opened (where it holds
  // by the endpoint arm): one gate for all placements is what keeps the resolver
  // from growing a per-arm notion of who belongs.
  if (!ports.conversations.isAgentParticipant(conversation.id, request.principal.id)) {
    return refuse('target_unresolved', 'not_participant');
  }

  // ── 3. An inbox is not a write destination ────────────────────
  // Only reachable for the principal's OWN inbox (rule 2 already refused anyone
  // else's), so this code leaks nothing. An inbox is a notification read face
  // with a single participant: a mention CC's header points at the repliable
  // ORIGIN stream, and a reply into the inbox would be a message nobody reads.
  if (request.intent === 'write' && conversation.placement_kind === 'agent_inbox') {
    return refuse('inbox_not_writable', 'inbox_write');
  }

  // ── 4. The thread root must be a root OF THIS CONVERSATION ────
  if (threadRootId !== null) {
    const root = ports.messages.getInConversation(conversation.id, threadRootId);
    if (root === null) return refuse('thread_not_in_target', 'thread_root_not_found');
    if (root.thread_root_id !== null) {
      // A mid-thread reply id is not a stream address. NOT normalized to
      // `root.thread_root_id`: the header always renders the root, so nothing
      // that round-trips needs the repair, and repairing here would make two
      // different addresses name one stream — which is how an address stops
      // being a coordinate.
      return refuse('thread_not_in_target', 'thread_root_not_a_root');
    }
  }

  return {
    ok: true,
    target: {
      stream: {
        conversationId: requireAddressableId(conversation.id, 'conversations.id'),
        threadRootId,
      },
      placementKind: conversation.placement_kind,
      created,
    },
  };
}
