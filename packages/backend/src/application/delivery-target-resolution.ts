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
// THREE RULES, all fail-closed, in this order (the order is part of the
// contract — see the numbered comments in `resolveDeliveryTarget`):
//
//   1. the grammar must accept the string;
//   2. the head must name a conversation this principal PARTICIPATES in, judged
//      by the one participation authority (`ConversationRepo.isAgentParticipant`,
//      the boolean face of `conversation-placement-sql.ts`), never by a rule
//      restated here;
//   3. a thread suffix must name a ROOT message of the resolved conversation.
//
// A HEAD IS ONE OF THREE THINGS, and rule 1 does not care which: a conversation
// id, a readable `<workspace>/<title>` pair, or a `dm:@handle` shorthand. The
// readable pair composes TWO authorities — the regular workspace namespace
// (#task:2027) and a workspace's title keys (#task:2016) — and this module is
// where they are composed, because it is the only place that also owns what
// happens when either one says no.
//
// TWO PROPERTIES ARE WORTH MORE THAN THE RULES THEMSELVES:
//
// UNKNOWN AND UNAUTHORIZED ARE ONE OUTCOME. A conversation that does not exist
// and one the principal may not touch both return `target_unresolved` with
// nothing else distinguishing them. Otherwise the resolver becomes an existence
// oracle over every conversation id in the installation: an id is 16 random
// characters, so it cannot be guessed, but it CAN be pasted from a place the
// reader was authorized to see and later removed from — and "does this still
// exist" is not a question a non-participant may ask. The branch that fired
// leaves through a DIFFERENT EXIT ({@link DeliveryTargetObserverPort}), not
// through a second field on the answer: an operator reason that travelled inside
// the returned object would be one `json(refusal)` away from the actor at every
// route, and no call-site discipline can make that safe (@Cindy B4). The answer
// therefore carries the code and nothing else — two refusals sharing a code are
// byte-identical objects, so there is no field a serializer must remember to
// strip.
//
// READS NEVER ALLOCATE. `dm:@handle` on a WRITE may open the pair — that is what
// makes a DM reachable without a prior invitation — while every read surface
// (history, search, file, schedule) resolves with a FIND. A read that created its
// own subject would turn a typo into a permanent empty conversation, and would
// make "no such stream" unobservable: the second attempt would succeed. A write
// whose caller may not reach the destination anyway also finds rather than
// allocates ({@link DeliveryAllocation}), so no refusal of any kind leaves a
// conversation behind it.
//
// THE ONE ALLOCATION CARRIES ITS OWN ANNOUNCEMENT ({@link openDirectPair}). A
// pair coming into existence changes what a human's DM list shows, and the
// obligation to say so lives WITH THE MINT rather than on whoever called this
// function (#task:2035, @Cindy B4). The earlier shape reported `created` on the
// answer and had ONE route funnel consume it — which made the invariant "every
// door announces" a property of that funnel being the only caller, not of the
// allocation. A second caller silently minted an unannounced pair, and no test of
// today's doors went red. Now the effect is a REQUIRED port on the operation: the
// answer carries no obligation to forget, and a caller that reaches the allocating
// arm cannot fail to announce, because announcing is what that arm does. Since
// #task:2036 that operation lives in its own module, because the human-initiated
// open resolves no address and so cannot reach it through here.
//
// WHAT THIS MODULE DELIBERATELY DOES NOT DECIDE. Whether the stream accepts a
// message right now — archived, closed, a `direct_pair` whose other endpoint is
// deleted — belongs to the WRITE gate (`canPostToConversation`), which reads the
// same columns for a different question. Resolution answers "which stream is
// this", posting answers "may I post there", and collapsing them would mean an
// address stops resolving because a channel was archived, so an agent could no
// longer even name the conversation it is quoting.
//
// Consequently A RESOLVED TARGET IS A SNAPSHOT, NOT A CAPABILITY TOKEN: the
// participation this module read can be revoked between here and the effect, so
// the write transaction re-checks participation and postability inside itself.
// That is the transaction's own gate, not a second one here — see #task:2021's
// merge acceptance.
import {
  parseDeliveryTargetInput,
  requireAddressableId,
  type CanonicalWorkspaceName,
  type ConversationEndpointIdentity,
  type ConversationPlacementKind,
  type DeliveryTarget,
  type DeliveryTargetRefusalCode as PublishedDeliveryTargetRefusalCode,
} from '@silverhand/shared';
import {
  openDirectPair,
  type DirectPairMintPort,
  type DirectPairOpenedPort,
} from './open-direct-pair.js';

/**
 * What the resolver needs to know about a conversation: WHERE it lives, and
 * nothing else.
 *
 * Deliberately not `ConversationIdentity`: the resolved target carries the
 * placement ARM onward and nothing else about the row, and a wider shape
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
 * (there is exactly one call site, guarded by `intent === 'write'` and by the
 * caller's {@link DeliveryAllocation}) rather than by discipline at each surface.
 * It is inherited from {@link DirectPairMintPort} rather than restated, so that
 * "the resolver's mint is THE mint" is a type relationship and not two
 * declarations that happen to match.
 */
export interface DeliveryTargetConversationsPort
  extends DirectPairMintPort<DeliveryTargetConversation> {
  getIdentity(conversationId: string): DeliveryTargetConversation | null;
  /** The second segment of a readable address: the conversation of `workspaceId`
   *  whose stored title key is `titleKey`, or `null`. The FOLD is the stored
   *  key's, so the caller passes a key it derived with the one canonicalizer and
   *  never a title it hopes matches (#task:2016). */
  findWorkspaceTitle(
    workspaceId: string,
    titleKey: string,
  ): DeliveryTargetConversation | null;
  /** PARTICIPATION, per placement — the one authority, not the roster table. */
  isAgentParticipant(conversationId: string, agentId: string): boolean;
  findDirectPair(
    x: ConversationEndpointIdentity,
    y: ConversationEndpointIdentity,
  ): DeliveryTargetConversation | null;
}

/**
 * The address ROOT: a regular workspace's display name (#task:2027).
 *
 * Three outcomes rather than a nullable id, because `ambiguous` is not "no
 * match": `idx_workspaces_name_key` is UNIQUE over regular workspaces
 * (`owner_agent_id IS NULL`), so a second holder of one key is corruption, and an operator wants to know
 * which of the two happened even though the ACTOR must not (both collapse into
 * `target_unresolved`).
 *
 * The port takes the CANONICAL name, not the raw segment: the segment was already
 * parsed by the grammar, and a port that re-parsed it could disagree with the
 * token that was actually accepted.
 */
export type DeliveryTargetRootResolution =
  | { kind: 'found'; workspaceId: string }
  | { kind: 'unresolved' }
  | { kind: 'ambiguous' };

export interface DeliveryTargetWorkspacesPort {
  /** Current REGULAR namespace only, archived included, and never `agent_home` —
   *  which is why a name-shaped address can never reach an agent's private
   *  workspace, and why `agent_home` is a RENDERING fallback rather than a
   *  resolution outcome. */
  resolveRegularRoot(name: CanonicalWorkspaceName): DeliveryTargetRootResolution;
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
  workspaces: DeliveryTargetWorkspacesPort;
  messages: DeliveryTargetMessagesPort;
  agents: DeliveryTargetPrincipalsPort;
  users: DeliveryTargetPrincipalsPort;
  /** Where a refusal's BRANCH goes. Required: the alternative is an optional sink
   *  that a surface forgets to pass, which loses the operator's only account of
   *  why an address was refused. */
  observer: DeliveryTargetObserverPort;
  /** Where the one side effect's CONSEQUENCE goes. Required for the same shape of
   *  reason and a stronger one — see {@link DirectPairOpenedPort}. */
  allocations: DirectPairOpenedPort;
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

/**
 * May this resolution ALLOCATE — the second axis of the one side-effecting arm.
 *
 * Separate from {@link DeliveryIntent} rather than a third intent value, because
 * `intent` is an OPERATOR WIRE FIELD ({@link DeliveryTargetRefusalReport}, and the
 * dogfood log built on it): widening it for an unrelated reason would silently
 * reshape a vocabulary an operator reads. Also because the two are genuinely
 * independent facts — "this is a write" is about the effect, "you may not open a
 * new pair while doing it" is about the caller's reach — and collapsing them into
 * one value would make a caller who merely wants to avoid the side effect
 * downgrade to `intent: 'read'`, silently changing what the operator log records
 * about the act.
 *
 * Required, not optional-defaulting-to-permitted: the whole value is that every
 * call site states its answer, and a default would put the side effect back one
 * forgotten argument away.
 */
export type DeliveryAllocation = 'permitted' | 'forbidden';

export type DeliveryTargetRefusalCode =
  /** Not an address at all. Says nothing about what exists, so it stays
   *  distinct: telling the actor their string is malformed is the only way they
   *  can fix it, and it is exactly the case where no lookup happened. */
  | 'target_malformed'
  /** The address names no stream this principal may use — unknown and
   *  unauthorized COLLAPSED (module docblock). */
  | 'target_unresolved'
  /** The thread suffix names no reply cluster of the resolved conversation. */
  | 'thread_not_in_target'
  /** `dm:@<own handle>`: a DM has two participants (§4.1). */
  | 'self_pair_not_addressable';

/**
 * This module's refusal codes ARE the published vocabulary, checked structurally.
 *
 * The union above is spelled out rather than aliased so each code keeps the
 * comment explaining the rule it enforces, and this pair of assignments pins it to
 * {@link DELIVERY_TARGET_REFUSAL_CODES} in both directions — adding a code here
 * without publishing it (the CLI would show a bare HTTP status instead of the
 * fact) or publishing one nothing raises both fail to compile.
 */
const _refusalCodesArePublished: DeliveryTargetRefusalCode =
  '' as PublishedDeliveryTargetRefusalCode;
const _publishedRefusalCodesAreRaised: PublishedDeliveryTargetRefusalCode =
  '' as DeliveryTargetRefusalCode;
void _refusalCodesArePublished;
void _publishedRefusalCodesAreRaised;

/**
 * The branch that actually fired — FOR OPERATORS, and unreachable from the answer.
 *
 * It leaves through {@link DeliveryTargetObserverPort} rather than riding on the
 * refusal, because the collapse is only real if the distinction CANNOT reach the
 * actor: a field on the returned object survives every `json(refusal)`, spread and
 * generic error serializer, and "the call site would look obviously wrong" is a
 * review habit, not a boundary.
 */
export type DeliveryTargetOperatorReason =
  | 'grammar'
  | 'conversation_not_found'
  | 'workspace_not_found'
  | 'workspace_ambiguous'
  | 'title_not_found'
  | 'not_participant'
  | 'unknown_handle'
  | 'direct_pair_not_found'
  | 'self_pair'
  | 'thread_root_not_found'
  | 'thread_root_not_a_root';

/**
 * What the actor is told, IN ITS ENTIRETY.
 *
 * One field, so two refusals that share a code are the same object down to the
 * bytes and a route can serialize this wholesale without knowing anything about
 * existence collapse. Widening it is how the oracle comes back, which is why the
 * suite asserts the key set and not just the values.
 */
export interface DeliveryTargetRefusal {
  code: DeliveryTargetRefusalCode;
}

/** The operator's record of ONE refusal: the branch, plus the request that
 *  produced it, so a log line needs nothing from the actor-facing object. */
export interface DeliveryTargetRefusalReport {
  code: DeliveryTargetRefusalCode;
  operatorReason: DeliveryTargetOperatorReason;
  /** The address exactly as received, unrepaired. */
  address: string;
  principalId: string;
  intent: DeliveryIntent;
}

/**
 * The operator-only exit for refusals — a capability like any other port, so a
 * surface has to WIRE observability rather than inherit it, and cannot instead
 * reach for the actor's object.
 *
 * Called exactly once per refusal, before it is returned; never on success. A
 * throwing sink turns a typed refusal into a fault, and that is deliberately not
 * swallowed: a logging boundary that fails is an operator bug, and hiding it here
 * would silently cost the very records the collapse depends on.
 */
export interface DeliveryTargetObserverPort {
  refused(report: DeliveryTargetRefusalReport): void;
}

/**
 * The allocation obligation is declared with the mint it travels with, in
 * `application/open-direct-pair.ts` — see {@link DirectPairOpenedPort}. It is not
 * re-exported here: the resolver is one of TWO doors that open a line (#task:2036
 * added the human one), so the module that owns the operation owns its port, and a
 * second name for it would be a second place to look for the invariant.
 */

export interface ResolvedDeliveryTarget {
  /** The canonical value object: what the delivery header renders and what a
   *  reply copies back. Built from OUR OWN ids, hence `requireAddressableId` —
   *  a stream whose id cannot be spelled has no address, and omitting the target
   *  is the ambient guess P4 exists to remove. */
  stream: DeliveryTarget;
  placementKind: ConversationPlacementKind;
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
  /** Whether the one allocating arm may run for THIS caller — the door's reach,
   *  decided by `delivery-reach.ts` and passed in, never inferred here. */
  allocation: DeliveryAllocation;
  /** Creation timestamp for the one write that can allocate. */
  now: number;
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
 * Total: every input produces either a stream or a typed refusal, and every
 * refusal is reported once through `ports.observer`. The only throw is
 * `requireAddressableId` on a resolved conversation's own id, which is corruption
 * rather than input (a row whose id no address can carry) — plus whatever the
 * observer or the allocation port itself raises, which is not swallowed on
 * purpose.
 */
export function resolveDeliveryTarget(
  ports: DeliveryTargetPorts,
  request: DeliveryTargetRequest,
): DeliveryTargetResolution {
  // The ONE place a refusal is built, which is what makes "every refusal is
  // reported to the operator, and only the code is returned" a property of the
  // function rather than of nine call sites.
  const refuse = (
    code: DeliveryTargetRefusalCode,
    operatorReason: DeliveryTargetOperatorReason,
  ): DeliveryTargetResolution => {
    ports.observer.refused({
      code,
      operatorReason,
      address: request.address,
      principalId: request.principal.id,
      intent: request.intent,
    });
    return { ok: false, refusal: { code } };
  };

  // ── 1. Grammar ────────────────────────────────────────────────
  const input = parseDeliveryTargetInput(request.address);
  if (input === null) return refuse('target_malformed', 'grammar');

  const threadRootId =
    input.kind === 'stream' ? input.stream.threadRootId : input.threadRootId;

  // ── Head → conversation ───────────────────────────────────────
  let conversation: DeliveryTargetConversation;
  if (input.kind === 'stream') {
    const found = ports.conversations.getIdentity(input.stream.conversationId);
    if (found === null) return refuse('target_unresolved', 'conversation_not_found');
    conversation = found;
  } else if (input.kind === 'named_stream') {
    // TWO segments, TWO authorities, and both failures collapse into the same
    // answer: a workspace name nobody holds, a title nobody holds inside it, and a
    // conversation this principal may not touch (rule 2, below) are one outcome to
    // the actor. Otherwise the readable form would be a NAME oracle — worse than
    // the id one, because names are guessable and an id is not.
    //
    // Lifecycle is deliberately absent here, exactly as it is for the id arm: an
    // ARCHIVED workspace still resolves, because "which stream is this" must keep
    // answering for a conversation an agent is quoting. Whether it accepts a
    // message now is the write gate's question (see the module docblock), and
    // because the answer only reaches a PARTICIPANT it is not an oracle either.
    const root = ports.workspaces.resolveRegularRoot(input.workspace);
    if (root.kind !== 'found') {
      return refuse(
        'target_unresolved',
        root.kind === 'ambiguous' ? 'workspace_ambiguous' : 'workspace_not_found',
      );
    }
    const found = ports.conversations.findWorkspaceTitle(
      root.workspaceId,
      input.title.key,
    );
    if (found === null) return refuse('target_unresolved', 'title_not_found');
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
    // Allocation happens only for a MAIN-LINE write whose caller may allocate.
    // A thread suffix names a reply cluster, which a brand-new pair cannot have,
    // so creating the pair first would leave a conversation behind a refusal — the
    // resolver's one side effect must not outlive a rejected resolution. The same
    // property is what `allocation: 'forbidden'` buys for a caller whose REACH will
    // refuse this destination a step later (`delivery-reach.ts`): the pair it would
    // have opened could never have been that caller's own stream, so nothing that
    // would have been permitted becomes unresolved.
    if (
      request.intent === 'write'
      && request.allocation === 'permitted'
      && threadRootId === null
    ) {
      // The mint and its announcement are ONE operation, owned by
      // `open-direct-pair.ts` because a second door now reaches it (the human
      // "Message this agent" open, #task:2036). Ordered after the write and before
      // every remaining rule, because what is announced is THE ROW, not the
      // resolution. Nothing below can refuse this arm anyway (participation holds
      // by the endpoint the pair was built from, and a thread suffix never reaches
      // here), so there is no reachable state in
      // which a refusal leaves an announcement behind.
      conversation = openDirectPair(ports, me, them, request.now);
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

  // ── 3. The thread root must be a root OF THIS CONVERSATION ────
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
    },
  };
}
