/**
 * The `direct_pairs_changed` emit (#task:2035) — one owner for the event name,
 * its payload shape and the scope it rides, exactly like
 * `application/viewer-workspaces.ts` owns `viewer_workspaces_changed`.
 *
 * WHY A LIST SIGNAL AND NOT AN UNREAD FRAME. `unread_updated` is keyed by
 * (viewer, WORKSPACE) — a `direct_pair` has no workspace coordinate, so it has no
 * payload in that read model (see `viewer-scope.ts`). More importantly, the case
 * this feature exists for is a row that does not exist in the client's cache yet:
 * an agent the viewer has never messaged, and never created, sending its FIRST DM.
 * A patch-style frame has nothing to patch, and the conversation's own `message`
 * frame reaches only clients subscribed to that conversation — which this viewer
 * cannot be, because the line has never been open. So the frame is an
 * INVALIDATION: `GET /api/direct-pairs` stays the authority for membership, order
 * and unread, and the consumer re-reads it.
 *
 * AUDIENCE is the pair's human participants, resolved through the placement
 * authority (both endpoints, not "the recipient"): a viewer's own send also moves
 * their list, and read state clearing is a change to the same row.
 *
 * TWO KINDS OF CHANGE, ONE FRAME. What the list shows is membership (the row
 * exists at all), order, unread and the counterpart's identity — so the frame is
 * owed whenever any of those moves: the row was MINTED, a message landed in it, or
 * the viewer's own read state lowered its unread. The membership arm is
 * {@link directPairAllocationPort}, and it is a separate obligation on purpose: a
 * pair is opened by the resolver's allocating arm, which is reached by doors that
 * never send a message (`schedule create` stores a wake destination, so it must
 * exist first — `routes/internal-agent/schedule-routes.ts`). An earlier version of
 * this file claimed a pair "cannot exist without the send that opened it"; that was
 * already false in the tree when it was written (@Cindy's probe:
 * `schedule create --target-conversation dm:@…` created the pair, the sidebar never
 * heard about it, and a cold `GET /api/direct-pairs` then showed a row the live
 * client had no way to learn about).
 *
 * On a first DM SEND both arms fire, and that is two real state changes announced
 * once each rather than a duplicate: the line came into existence, and then it got
 * its first message. Suppressing one would require the allocation site to know
 * whether its caller is going to send afterwards — exactly the per-door knowledge
 * that produced the missing emit above. The frame is an invalidation, so the cost
 * of the honest version is one extra `GET /api/direct-pairs` on the first contact
 * of a pair, ever.
 */
import type { DirectPairsChangedPayload } from '@silverhand/shared';
import type { ScopeEventPublisher } from '../ws/scope-event-bus.js';
import type { DirectPairOpenedPort } from './open-direct-pair.js';

/** Emit to ONE viewer. Takes the narrow publish-only face rather than a
 *  `BackendContext` — or even the bus — because the caller is a service that
 *  holds only its ports (#task:1983 / #task:1990): a post-commit effect needs the
 *  ability to publish and nothing else, and `ScopeEventBus` satisfies it
 *  structurally, so widening this signature costs existing callers nothing. */
export function publishDirectPairsChangedToViewer(
  events: ScopeEventPublisher,
  viewerUserId: string,
  payload: DirectPairsChangedPayload,
): void {
  events.publishToScope(`viewer:${viewerUserId}`, 'direct_pairs_changed', payload);
}

/** Emit to every human participant of a pair. `viewerUserIds` must be the
 *  PLACEMENT authority's answer (`conversationViewerUserIds`), not a roster read:
 *  `conversation_users` is authoritative for the workspace arm only, and for a
 *  `direct_pair` it returns the empty set — the exact bug that made an agent's DM
 *  arrive for nobody (#task:2035). */
export function publishDirectPairsChangedToViewers(
  events: ScopeEventPublisher,
  viewerUserIds: readonly string[],
  conversationId: string,
): void {
  for (const viewerUserId of viewerUserIds) {
    publishDirectPairsChangedToViewer(events, viewerUserId, {
      conversation_id: conversationId,
    });
  }
}

/**
 * The MEMBERSHIP arm: the announcement, shaped as the capability the resolver's
 * allocating arm must hold to run at all.
 *
 * WHY A PORT RATHER THAN A FUNCTION CALLERS INVOKE. The previous shape was a
 * function that consumed `ResolvedDeliveryTarget.created`, called by the one route
 * funnel every addressed door happened to go through. That made "every door
 * announces" a property of who the callers are — true on the day it was written
 * and unprovable afterwards: a second caller of `resolveDeliveryTarget` (the
 * human-initiated open, #task:2036, or a wrapper forwarding the same arguments)
 * minted a pair with no announcement, and no test of today's doors went red
 * (@Cindy B4). As a REQUIRED port the announcement is instead attached to the
 * effect: reaching the allocating arm means having been handed this, so the
 * property is about the ALLOCATION, which is what it was always claimed to be.
 *
 * `humanParticipantsOf` must be the PLACEMENT authority's answer
 * (`conversationViewerUserIds`) and is a thunk rather than an array so that the
 * overwhelming majority of resolutions — which allocate nothing, and never call
 * this — cost no query.
 *
 * No `created` check and no placement check: both were the caller's chance to get
 * it wrong. This is only ever invoked for a row that came into existence on THIS
 * call, and the only thing an address can allocate is a `direct_pair` (a
 * workspace channel's own list is invalidated by `workspace_channels_changed`).
 *
 * WHAT IT ANNOUNCES IS THE ROW, NOT THE OPERATION. The frame is not withdrawn if
 * the door then refuses the request: a `schedule create` that fails its spec
 * validation, or a capability check, still leaves a line the viewer now has.
 * Announcing "the operation succeeded" is not this frame's job and never was —
 * the list is the authority.
 *
 * THE DURABILITY OF THE ROW IS A FACT ABOUT THE CALLER, NOT ABOUT THIS PORT
 * (@Cindy B5). For a caller that resolves its target BEFORE the transaction its
 * door later opens, the mint is a single autocommit statement, so by the time this
 * publishes the row is committed and the frame cannot point at something a rollback
 * removes. That is not a general guarantee this port enforces: a caller that mints
 * INSIDE a transaction would have this fire pre-commit, and the assertion above
 * would not hold for it. Such a caller must either publish after its own commit or
 * make the port transaction-aware — it may not inherit this reasoning. Since
 * #task:2072 one caller takes the second route; see {@link recordDirectPairOpens}
 * below, which is why this implementation stayed exactly as narrow as its own
 * assumption.
 */
export function directPairAllocationPort(
  events: ScopeEventPublisher,
  humanParticipantsOf: (conversationId: string) => readonly string[],
): DirectPairOpenedPort {
  return {
    directPairOpened: conversationId => {
      publishDirectPairsChangedToViewers(
        events,
        humanParticipantsOf(conversationId),
        conversationId,
      );
    },
  };
}

/**
 * The TRANSACTION-AWARE form of the same obligation (#task:2072).
 *
 * WHY IT EXISTS. The paragraph above leaves a caller that mints INSIDE a
 * transaction exactly two honest moves: publish after its own commit, or make the
 * port transaction-aware. The mention CC is that caller — its copy is written in
 * the SOURCE SEND's transaction (§5), so the pair it lands in has to roll back
 * with it — and a port that published in the same breath would announce a row a
 * rollback then removes, which is the mirror image of the bug #task:2035 fixed.
 *
 * WHY IT LIVES HERE rather than at the call site. A recorder assembled where it is
 * used is the hand-rolled port literal that
 * `guard-direct-pair-open-announced.test.ts` exists to make someone answer for,
 * and the answer would be invisible next to the mint. Here, the file that owns the
 * frame owns every way of not sending it yet — and the guard's per-file site count
 * is what keeps "every way" from growing a third one unnoticed.
 *
 * (Spelling the hand-rolled shape out in this sentence would have been counted as a
 * site: the guard's pattern is deliberately blind to whether an occurrence is code
 * or prose, so prose here paraphrases rather than quotes it.)
 *
 * WHAT IT DOES NOT DO is decide when the announcement happens: `opened()` is the
 * list of rows THIS mint created, and a caller that never publishes them has the
 * #task:2035 bug back. The ids are exposed for exactly that reason — so the
 * post-commit half can PROVE it covered them (`dispatchMentionCcEffects`) instead
 * of the coverage being a property of whoever wrote the caller.
 */
export function recordDirectPairOpens(): {
  port: DirectPairOpenedPort;
  opened: () => readonly string[];
} {
  const openedConversationIds: string[] = [];
  return {
    port: {
      directPairOpened: conversationId => {
        openedConversationIds.push(conversationId);
      },
    },
    opened: () => openedConversationIds,
  };
}
