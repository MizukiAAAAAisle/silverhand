/**
 * OPENING a direct pair — the mint and its announcement, as one operation
 * (#task:2035, extended by #task:2036).
 *
 * WHY THIS IS ITS OWN MODULE. #task:2035 fused the announcement to the effect
 * rather than to the caller: reaching the allocating arm means having been handed
 * {@link DirectPairOpenedPort}, so "every door announces" is a property of the
 * ALLOCATION and not of who happens to call it (@Cindy B4). That fusion lived
 * inside `delivery-target-resolution.ts`, where the ONE allocating arm was — and
 * #task:2036 adds the second door the fence was written for: a person pressing
 * "Message" on an agent's page, which resolves no address at all (a human client
 * posts where the person is looking, so there is nothing to parse) and therefore
 * cannot reach the pair through the resolver.
 *
 * Two doors could have been served by two mints, each remembering to announce.
 * That is exactly the shape B4 refuted. So the mint moved OUT of the resolver
 * instead: this function is the only place a pair comes into existence, both doors
 * call it, and `guard-direct-pair-open-announced.test.ts` closes the set of files
 * that may name either half.
 *
 * WHAT IT IS NOT. Not an authorization gate and not a validation step: by the time
 * a caller is here, its own door has already decided that this principal may open
 * this line and that the request it is about to serve is well-formed. That
 * ordering is the caller's obligation because only the caller knows its gates —
 * see the human door in `routes/direct-pairs.ts`, which runs every side-effect-free
 * refusal FIRST so that an unauthorized or malformed request cannot leave an empty
 * line behind (@Cindy's #task:2036 boundary).
 */
import type { ConversationEndpointIdentity } from '@silverhand/shared';

/**
 * The obligation that travels WITH the one side effect: a pair that came into
 * existence has been announced to its human participants (#task:2035).
 *
 * Required, and required for a sharper reason than observability: this is the
 * second half of the write. `getOrCreateDirectPair` inserts a row that a human's DM
 * list is the read surface for, and a list that is never invalidated shows a
 * conversation the live client cannot learn about until it restarts — the whole of
 * #task:2035.
 *
 * WHY A PORT AND NOT A `created` FLAG ON THE ANSWER. Both shapes make the
 * announcement possible; only this one makes it unavoidable. A flag is a request
 * that every present and future caller remember to act on it, enforced by nothing a
 * compiler or a test can see — and the caller that forgets is precisely the one
 * being added later, for a door nobody has written yet (which #task:2036 then was).
 * A required port instead makes the effect part of the CAPABILITY the mint must be
 * handed, and the member name is distinctive enough that
 * `guard-direct-pair-open-announced.test.ts` can close the set of production
 * implementations to the one that really publishes.
 *
 * A throw is not swallowed: an announcement path that faults is a wiring bug, and
 * the alternative — an opened line that stays invisible — is the bug this port
 * exists to prevent.
 */
export interface DirectPairOpenedPort {
  directPairOpened(conversationId: string): void;
}

/**
 * The mint, as the one question it answers.
 *
 * Generic in the conversation shape because the two doors need different amounts
 * of the row and neither should be widened to the other's needs: the resolver wants
 * a placement coordinate ({@link DeliveryTargetConversation}), the human send door
 * wants the row it is about to post into. `C` is whatever the caller's port hands
 * back, unread by this module — which owns the ORDER of the two effects and nothing
 * about the row.
 */
export interface DirectPairMintPort<C> {
  getOrCreateDirectPair(
    x: ConversationEndpointIdentity,
    y: ConversationEndpointIdentity,
    now: number,
  ): { conversation: C; created: boolean };
}

export interface OpenDirectPairPorts<C> {
  conversations: DirectPairMintPort<C>;
  allocations: DirectPairOpenedPort;
}

/**
 * Get-or-create the pair for these two endpoints, and announce it if THIS call is
 * the one that created it.
 *
 * The row count elects one winner under the get-or-create race, so a loser
 * announces nothing — the frame says "this row exists", and a caller that lost the
 * race is not the one it came into existence on.
 *
 * WHAT IS ANNOUNCED IS THE ROW, NOT THE OPERATION. The frame is not withdrawn if
 * the caller's door then refuses the request, or if its own transaction later
 * fails: a `schedule create` that fails spec validation, or a first message that
 * fails an attachment check, still leaves a line the viewer now has, and a live
 * client that never heard about it would be strictly worse off than one that
 * re-read the list (`GET /api/direct-pairs` is the authority; the frame is an
 * invalidation).
 *
 * THE DURABILITY OF THE ROW IS A FACT ABOUT TODAY'S CALLERS, NOT ABOUT THIS
 * FUNCTION (@Cindy #task:2035 B5). The mint is a single autocommit statement, and
 * every production caller opens the line BEFORE the transaction its door later
 * runs, so by the time this publishes, the row is committed and the frame cannot
 * point at something a rollback removes. A future caller that opened the line
 * INSIDE a transaction would have this fire pre-commit; it must publish after its
 * own commit or make the port transaction-aware, and may not inherit this
 * reasoning.
 */
export function openDirectPair<C extends { id: string }>(
  ports: OpenDirectPairPorts<C>,
  x: ConversationEndpointIdentity,
  y: ConversationEndpointIdentity,
  now: number,
): C {
  const opened = ports.conversations.getOrCreateDirectPair(x, y, now);
  if (opened.created) ports.allocations.directPairOpened(opened.conversation.id);
  return opened.conversation;
}
