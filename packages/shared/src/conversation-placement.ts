// Placement accessors for conversations (agent-scoped-session-v1 §4.1).
//
// A workspace is a property of ONE placement arm, not of every conversation:
// `placement_kind='workspace'` rows carry `workspace_id` and `direct_pair` rows
// carry their two endpoints. That
// is why `workspace_id` is nullable on the row AND on the wire.
//
// Nullable coordinates spread through call sites in two very different ways,
// and the whole point of this module is to keep them apart:
//
//   - A surface whose UNIT IS A WORKSPACE (workspace roster admission, the
//     workspace task board, per-workspace channel lists, `#conv:` resolution
//     inside a workspace) must NOT invent a coordinate for a placement that has
//     none. Reaching such a surface with a non-workspace conversation is a
//     ROUTING bug upstream, so it fails loud here instead of coercing.
//     `requireWorkspacePlacement` is that assertion, and every call site is
//     simultaneously a DECLARATION that the surface is workspace-scoped.
//
//   - A surface whose unit is an AGENT, a USER, or a CONVERSATION ID (the agent
//     activity roster, control-plane stop/purge, search, delivery) must carry
//     the null through and group by placement. Those sites do NOT call this
//     function — they handle `workspace_id === null` explicitly.
//
// Deliberately NOT a coercion (`?? someWorkspaceId`) and NOT a filter: a
// silently-substituted or silently-dropped row is the exact failure mode this
// feature exists to remove (§1 "INNER JOIN 整行消失").
import type { ConversationEndpointKind, ConversationPlacementKind } from './db/schema.js';

/** The minimum shape both DB rows and wire DTOs satisfy. Structural on purpose
 *  so the one rule serves both without a conversion step. */
export interface ConversationPlacementRef {
  id: string;
  workspace_id: string | null;
}

export class ConversationPlacementError extends Error {
  constructor(
    readonly conversationId: string,
    readonly placementKind?: ConversationPlacementKind,
  ) {
    super(
      `conversation ${conversationId} is not workspace-placed` +
        (placementKind ? ` (placement_kind=${placementKind})` : '') +
        ': this surface is workspace-scoped and has no coordinate for it',
    );
    this.name = 'ConversationPlacementError';
  }
}

/** Assert the workspace arm and return its id. Throws
 *  {@link ConversationPlacementError} for every other placement — see the
 *  module docblock for when NOT to use this. */
export function requireWorkspacePlacement(
  conversation: ConversationPlacementRef & {
    placement_kind?: ConversationPlacementKind;
  },
): string {
  if (conversation.workspace_id === null) {
    throw new ConversationPlacementError(conversation.id, conversation.placement_kind);
  }
  return conversation.workspace_id;
}

/** True when the conversation is workspace-placed. For read surfaces that
 *  legitimately SPLIT by placement rather than assert one arm.
 *
 *  A TYPE PREDICATE, so the split narrows `workspace_id` to `string` in the
 *  positive arm: a site that has honestly branched should not then need a `!` or
 *  a second assertion, which is exactly where a mechanical non-null slips in. */
export function isWorkspacePlaced<T extends ConversationPlacementRef>(
  conversation: T,
): conversation is T & { workspace_id: string } {
  return conversation.workspace_id !== null;
}

/** One endpoint of a `direct_pair` placement as a COORDINATE: which kind of
 *  principal, and its id. Says nothing about whether that principal still
 *  exists — that is a lookup, and keeping it out of this type is what stops
 *  "gone" from being stored twice (see {@link directPairEndpointsOf}). */
export interface ConversationEndpointCoordinate {
  kind: ConversationEndpointKind;
  id: string;
  /** WHEN the principal was hard-deleted, when that is known. NEVER read as the
   *  existence question: a stamp may be missing (some future delete path) while
   *  the principal is genuinely gone, so callers must OR this with a failed
   *  lookup. It is here only so a caller that already knows the endpoint is gone
   *  can say WHEN. */
  deletedAt: number | null;
}

/** The columns {@link directPairEndpointsOf} reads. Structural, so a DB row and
 *  any projection of it (the ACL facts, a future DTO) satisfy it unchanged. */
export interface ConversationEndpointRef {
  placement_kind: ConversationPlacementKind;
  endpoint_a_kind: ConversationEndpointKind | null;
  endpoint_a_id: string | null;
  endpoint_b_kind: ConversationEndpointKind | null;
  endpoint_b_id: string | null;
  endpoint_a_deleted_at: number | null;
  endpoint_b_deleted_at: number | null;
}

/**
 * The two endpoints of a `direct_pair` conversation, in the canonical order the
 * DB stores them, or `null` for every other placement — the ONE place the six
 * endpoint columns are turned into a pair, so no caller re-derives "is the b
 * column the one I mean".
 *
 * Throws rather than returning a half pair when a `direct_pair` row is missing a
 * coordinate. The DB's arc CHECK makes that unrepresentable, so reaching it
 * means the row did not come from this schema, and an ACL that silently treated
 * a half pair as "no endpoints" would fail OPEN on the survivor's write gate.
 */
export function directPairEndpointsOf(
  conversation: ConversationEndpointRef,
): readonly [ConversationEndpointCoordinate, ConversationEndpointCoordinate] | null {
  if (conversation.placement_kind !== 'direct_pair') return null;
  const {
    endpoint_a_kind: aKind,
    endpoint_a_id: aId,
    endpoint_b_kind: bKind,
    endpoint_b_id: bId,
  } = conversation;
  if (aKind === null || aId === null || bKind === null || bId === null) {
    throw new Error(
      'direct_pair conversation is missing an endpoint coordinate: the placement arc CHECK cannot produce this row',
    );
  }
  return [
    { kind: aKind, id: aId, deletedAt: conversation.endpoint_a_deleted_at },
    { kind: bKind, id: bId, deletedAt: conversation.endpoint_b_deleted_at },
  ];
}

/** A principal named as a `direct_pair` endpoint, WITHOUT the liveness column:
 *  the get-or-create input, and the unit the canonical order is defined on. */
export interface ConversationEndpointIdentity {
  kind: ConversationEndpointKind;
  id: string;
}

/**
 * Does the principal this endpoint names still exist? Supplied by the caller
 * because it is a LOOKUP, and this module resolves participation without a read
 * port on purpose (see `directPairEndpointsOf`). Passing it as a predicate is
 * what lets the rule below have ONE definition while the request layer answers
 * it from its ACL read port and the write transaction answers it from the
 * transaction's own scope.
 */
export type EndpointPrincipalExists = (endpoint: ConversationEndpointIdentity) => boolean;

/**
 * Is this conversation READ-ONLY because a `direct_pair` endpoint's principal is
 * gone? THE one definition of the write gate's only placement-specific
 * narrowing (#task:2021 P4-4): a DM whose other side has been deleted has nobody
 * to deliver to, so the survivor may still read it and may not post. There is no
 * `readonly` column and no second state machine — the DM's status, archive and
 * close state are all unchanged, so the answer is derived from the endpoints
 * every time it is asked.
 *
 * FALSE for every other placement, vacuously: no other arm has endpoints. That
 * is why the name says `directPair` and says `readOnly` rather than reading like
 * the whole gate — postability is a CONJUNCTION (participation ∧ lifecycle ∧
 * this), and a caller that mistook this for the whole of it would be admitting
 * strangers to every channel.
 *
 * BOTH endpoints are tested, not just "the other one": a principal whose own
 * record is gone cannot be the caller, so testing both costs nothing and keeps
 * the rule stated as a property of the conversation rather than of whoever is
 * asking — which is also why this takes no actor.
 *
 * The stamp is ORed in, never trusted alone. `endpoint_*_deleted_at` is written
 * by a `BEFORE DELETE` trigger today, and a future delete path that failed to
 * stamp must not thereby hand the survivor a live write gate; the lookup alone
 * suffices for correctness (endpoint coordinates are validated at birth and
 * immutable, so a miss can only mean "deleted"), and the stamp alone answers
 * without a query in the common case.
 */
export function directPairIsReadOnlyForSurvivor(
  conversation: ConversationEndpointRef,
  endpointPrincipalExists: EndpointPrincipalExists,
): boolean {
  const endpoints = directPairEndpointsOf(conversation);
  if (endpoints === null) return false;
  return endpoints.some(
    (endpoint) =>
      endpoint.deletedAt !== null ||
      !endpointPrincipalExists({ kind: endpoint.kind, id: endpoint.id }),
  );
}

/**
 * Compare two strings the way SQLite's BINARY collation does: by UTF-8 bytes.
 *
 * Needed because JS `<` compares UTF-16 CODE UNITS, and that is a different
 * order: a lone U+FFFF sorts ABOVE an astral character in UTF-16 (an astral
 * character leads with a surrogate, 0xD800–0xDBFF) and BELOW it in UTF-8. Any
 * comparator used to normalize endpoints must agree with the DB's, because v73's
 * `CHECK ((endpoint_a_kind, endpoint_a_id) < (endpoint_b_kind, endpoint_b_id))`
 * is the thing that accepts or rejects the result — a comparator that disagreed
 * would leave a LEGAL pair of principals with no DM at all, which is worse than
 * a wrong sort: it is a total function that isn't.
 *
 * Comparing CODE POINTS is exactly comparing UTF-8 bytes: UTF-8 is order
 * preserving, so `codePoint(x) < codePoint(y)` iff `utf8(x) < utf8(y)`
 * lexicographically. That equivalence is what makes this a proof rather than a
 * table of cases, and it is the same unit the v74 `pair_key` expression counts
 * with (SQLite `length()` counts code points).
 *
 * A LONE SURROGATE is refused instead of compared. It is the one input where the
 * equivalence breaks: no UTF-8 encoding of it exists, so `better-sqlite3` would
 * store a replacement character and the id in the row would no longer be the id
 * the caller passed — the coordinate itself would be wrong, not just its order.
 * Fail loudly at the boundary where the caller is still visible.
 *
 * VALIDATION IS TOTAL AND PRECEDES COMPARISON — @Cindy B1.1. Refusal is a
 * property of the INPUT, so it cannot be discovered along the way the answer is:
 * a check that rides on the comparison loop only sees the common prefix and stops
 * at the first difference, which leaves `'a'` vs `'a\ud800'` (surrogate past the
 * prefix) and `'a\ud800'` vs `'b'` (surrogate past the first difference) accepted
 * — and an accepted lone surrogate is not a mis-ordering, it is a coordinate the
 * driver rewrites into a DIFFERENT existing principal's id.
 */
export function compareEndpointText(x: string, y: string): number {
  return compareCodePoints(scalarCodePointsOf(x), scalarCodePointsOf(y));
}

/**
 * Every code point of `text`, refusing a lone surrogate ANYWHERE in it.
 *
 * Iterating a string yields code points, so a lone surrogate arrives as its own
 * one-unit element (an astral character never does — it arrives whole), which is
 * why the range test is a test of the element rather than of a UTF-16 unit.
 */
function scalarCodePointsOf(text: string): readonly number[] {
  const points: number[] = [];
  for (const char of text) {
    const point = char.codePointAt(0) ?? 0;
    if (point >= 0xd800 && point <= 0xdfff) throw new Error(LONE_SURROGATE_MESSAGE);
    points.push(point);
  }
  return points;
}

/** Lexicographic order on already-validated code points. */
function compareCodePoints(xs: readonly number[], ys: readonly number[]): number {
  const shared = Math.min(xs.length, ys.length);
  for (let i = 0; i < shared; i += 1) {
    const a = xs[i] ?? 0;
    const b = ys[i] ?? 0;
    if (a !== b) return a < b ? -1 : 1;
  }
  // A prefix sorts before what extends it, in both orders, so the tail needs no
  // inspection beyond its length.
  if (xs.length === ys.length) return 0;
  return xs.length < ys.length ? -1 : 1;
}

const LONE_SURROGATE_MESSAGE =
  'direct_pair endpoint ids must be valid Unicode: a lone surrogate has no UTF-8 encoding, so the id the DB stores would differ from the id given here';

/**
 * The two endpoints in the order the DB stores them (v73's
 * `CHECK ((endpoint_a_kind, endpoint_a_id) < (endpoint_b_kind, endpoint_b_id))`),
 * so a caller may pass the pair in whichever order the product surface produced
 * it and still address the ONE row that pair has.
 *
 * Ordering is the reason `direct_pair` needs no "who initiated" column: a DM is
 * an unordered pair of principals, and normalizing at the boundary is what makes
 * `(a, b)` and `(b, a)` the same aggregate id rather than two rows racing for one
 * conversation.
 *
 * TOTAL over the schema's endpoint domain, which is the load-bearing property and
 * not merely a nicety: this function decides the order the CHECK then judges, so
 * a disagreement with SQLite's BINARY collation would not be a cosmetic sort
 * difference — it would mean two perfectly legal principals can NEVER have a DM,
 * every attempt aborting on a constraint. That is why the comparison runs through
 * {@link compareEndpointText} (UTF-8 / code-point order) instead of JS `<`, whose
 * UTF-16 order disagrees around astral characters. `kind` is an ASCII enum, so the
 * two orders coincide there; it uses the same comparator anyway rather than
 * relying on that coincidence.
 *
 * A SELF-PAIR is rejected here rather than left to that CHECK, because this is
 * where the caller's intent is still visible: "a DM with myself" is a product
 * question (§4.1 leaves it out), not a constraint violation to report as one.
 *
 * BOTH IDS ARE VALIDATED EVEN WHEN ONLY THE KINDS DECIDE THE ORDER. The kind
 * comparison settles every human↔agent pair on its own, so leaving id validation
 * to the id comparison would skip it in the MOST common case — the encoding of an
 * id is a property of the id, not of whether this function happened to look at it
 * (@Cindy B1.1). Validation is therefore hoisted above the decision.
 */
export function canonicalEndpointOrder(
  x: ConversationEndpointIdentity,
  y: ConversationEndpointIdentity,
): readonly [ConversationEndpointIdentity, ConversationEndpointIdentity] {
  if (x.kind === y.kind && x.id === y.id) {
    throw new Error(
      'direct_pair endpoints must name two different principals: a self-pair has no second participant',
    );
  }
  const xKind = scalarCodePointsOf(x.kind);
  const yKind = scalarCodePointsOf(y.kind);
  const xId = scalarCodePointsOf(x.id);
  const yId = scalarCodePointsOf(y.id);
  const byKind = compareCodePoints(xKind, yKind);
  const order = byKind !== 0 ? byKind : compareCodePoints(xId, yId);
  return order < 0 ? [x, y] : [y, x];
}

/** The columns {@link resolveParticipation} reads: the placement arc in full. */
export interface ConversationParticipationRef extends ConversationEndpointRef {
  id: string;
  workspace_id: string | null;
}

/**
 * A candidate participant reduced to what a PLACEMENT rule can answer without a
 * lookup. Deliberately not the backend's `Principal`: `system` is a delivery
 * principal admitted before participation is asked, so it has no arm here, and
 * keeping this type structural is what lets the rule live in this module (see
 * {@link resolveParticipation}).
 */
export type ConversationActor =
  | { readonly kind: 'human'; readonly userId: string }
  | {
      readonly kind: 'agent';
      readonly agentId: string;
      /** The conversation this session is ACTING INSIDE, or `null` when the
       *  caller is not a session. Naming an agent is never enough: a session in
       *  channel A does not reach into a DM by reference. */
      readonly runningInConversationId: string | null;
    };

/**
 * Is `actor` a participant of `conversation`, when that is decidable FROM THE
 * ROW? `null` means "not decidable here": the workspace arm derives its
 * participants from workspace membership plus the roster tables, which is a
 * query, so it stays with the caller that holds the read port.
 *
 * THE ONE PLACE the placement→participants rule is written (§4.2). Every
 * permission entry point resolves through it, so "who is in this conversation"
 * has a single answer per placement instead of one per call site:
 *
 *   - `direct_pair` — exactly TWO, and they ARE the endpoints: an `agent`
 *     endpoint admits that agent under the same running-in rule, a `human`
 *     endpoint admits that user. Deletion of the OTHER side changes nothing here
 *     — reading one's own history is the whole reason an endpoint is a historical
 *     coordinate rather than a foreign key. What it changes is the WRITE gate,
 *     which is a different question asked of the same endpoints.
 *
 * There is exactly one such arm since #task:2072 retired `agent_inbox` (the
 * single-participant placement, whose sole participant was the owning agent). The
 * shape below is still a per-placement dispatch and not a `direct_pair` special
 * case, because that is what makes the NEXT placement's arm a deliberate addition
 * here rather than an omission at N call sites.
 *
 * THIS MODULE CANNOT READ THE ROSTER, and that is the load-bearing part rather
 * than a happy accident: it has no dependency but a type import, so the arms that
 * must not consult `conversation_users` / `conversation_agents` are structurally
 * unable to. A roster row on a non-workspace row is therefore INERT — not
 * "ignored by a check that a future reader could helpfully extend". Pinned by
 * `tests/db-boundary/participation-authority.test.ts`.
 */
export function resolveParticipation(
  conversation: ConversationParticipationRef,
  actor: ConversationActor,
): boolean | null {
  const endpoints = directPairEndpointsOf(conversation);
  if (endpoints !== null) {
    return endpoints.some((endpoint) =>
      endpoint.kind === 'agent'
        ? actor.kind === 'agent' &&
          actor.agentId === endpoint.id &&
          actor.runningInConversationId === conversation.id
        : actor.kind === 'human' && actor.userId === endpoint.id,
    );
  }
  return null;
}
