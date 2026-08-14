import { ENTITY_NAME_MAX_LENGTH, PARTICIPANT_HANDLE_PATTERN } from './api/name.js';

/**
 * #task:2021 — how a delivery TARGET is spelled.
 *
 * A target names a message STREAM: the conversation, plus optionally one reply
 * cluster inside it (a thread is a segment of the stream, not another kind of
 * target — `docs/agent-scoped-session-v1.md` §3.0). The persistent authority
 * stays what it always was, `(conversation_id, thread_root_id)`; this module
 * owns the ADDRESS — the readable form a delivery header carries and a CLI flag
 * accepts back — and nothing else.
 *
 * Why an address at all: today's header says `target=channel`, which only means
 * anything because the runtime is pinned to exactly one conversation. An
 * agent-scoped runtime serves N, so `channel` stops naming a stream and starts
 * naming whichever one the reader assumes. The fix is not a second format but a
 * value object: the target becomes something the message carries and the reply
 * copies verbatim, instead of ambient process state.
 *
 * **The canonical form is the conversation's own id, for every placement.** That
 * is the whole grammar, and the reason is identity rather than convenience
 * (@Cindy's P4 ruling, B1): an address that survives in a header must be built
 * from a coordinate that can never be reassigned to another object, and today no
 * NAME can serve as the absolute root of one. A workspace display name can be
 * renamed. A principal handle is released when the principal is hard-deleted and
 * can then be taken by someone else, so a stored `dm:agent/@Alice` would silently
 * begin to name a different pair — and spelling the principal KIND does not help,
 * because the reuse happens within one kind (handles are globally unique across
 * `users.name` ⊕ `agents.name` by v21's cross-namespace triggers, so a kind
 * segment carries no disambiguating information at all). A conversation's own
 * semantic name IS already a permanent allocation (#task:2016), but it is only
 * unique inside its workspace, so spelling it needs a stable workspace root that
 * does not exist yet. Name-shaped addresses therefore wait for the two governance
 * tickets that supply those roots: #task:2027 for a workspace slug, #task:2028 for
 * principal handles. Until then `#conv:<id>` is not a fallback — it is the address.
 *
 * Three properties are load-bearing, and the shape below exists to keep them:
 *
 *  - **One token, never quoted.** The delivery header is fixed-order
 *    `key=value` with no quoting, so an address containing whitespace would make
 *    the header un-tokenizable — and a machine surface that cannot be split is
 *    the #task:2000 failure again (a plain-text read face must round-trip byte
 *    for byte). This is enforced by CONSTRUCTION, not by review: an id only
 *    becomes an {@link AddressableId} through {@link addressableId}, so a
 *    {@link DeliveryTarget} carrying a value the parser would reject cannot be
 *    built out of an ordinary object literal (@Cindy B2 — the previous shape had
 *    bare `string` fields, which made the formatter's totality an untested claim
 *    about call sites rather than a fact about the type).
 *  - **Absolute, and the same for every reader.** No arm is first person, so a
 *    target can be quoted, logged, handed to another principal and still name the
 *    same stream. A DM's per-viewer spelling `dm:@other` survives only as a
 *    DISPLAY LABEL ({@link formatDirectPairLabel}), which is never a target.
 *  - **Rendering is total; parsing is strict.** {@link formatDeliveryTarget} is
 *    total on {@link DeliveryTarget} and its output always parses back to the
 *    same value; only the exact forms below parse, with no repair, no truncation
 *    and no case folding, because the alternative to reporting an unparsable
 *    target is delivering to the wrong stream.
 *
 * One non-canonical spelling is admitted on INPUT only: `dm:@<handle>`, what a
 * human types instead of looking up a pair's id. It is a
 * {@link DirectPairShorthandTarget}, a distinct arm of
 * {@link DeliveryTargetInput}, and no formatter accepts it — a surface that tried
 * to echo one into a header does not compile. That asymmetry is the only durable
 * way to keep human shorthand from becoming a second wire format, because the
 * shorthand's meaning is exactly what #task:2028 has not yet made permanent.
 *
 * This module is grammar and codec only: zero dependencies, no lookups. Turning
 * an address into a stream needs the conversation store, the handle registry and
 * the authenticated principal, so it lives in the backend resolver — an address
 * is a REQUEST for a stream, never proof that one exists. The grammar is likewise
 * placement-BLIND: `#conv:<id>` can spell an `agent_inbox` conversation, and
 * refusing that as a write destination (an inbox is a notification read face, so
 * a mention CC must point at the repliable origin stream instead) is the
 * resolver's decision, not the parser's.
 *
 * Deliberately NOT merged with `reference.ts` (#task:2011's object references):
 * that grammar points at principals and objects inside prose and decides
 * addressing; this one names a destination in a header or a flag. They share only
 * the handle character class, and merging the parsers would put "who is this
 * message aimed at" and "where does it go" behind one predicate — which is
 * exactly the conflation the four-layer addressing model exists to prevent.
 */

/** The canonical form: `#conv:<conversation_id>` — the one address every stream
 *  always has, and already the vocabulary agents are taught for naming a
 *  conversation unambiguously. */
export const CONVERSATION_ADDRESS_PREFIX = '#conv:';

/** The input-only direct-pair shorthand prefix: `dm:@<handle>`. */
export const DIRECT_PAIR_SHORTHAND_PREFIX = 'dm:@';

/** The reply-cluster suffix, appended to a conversation address:
 *  `#conv:<id>/thread:<root message id>`. A suffix rather than a second arm
 *  because a thread is not addressed independently of its stream — the root
 *  message id is only meaningful inside the conversation that holds it, and the
 *  root IS the reply stream's identity (it is never renamed and never moves). */
export const THREAD_ADDRESS_SEPARATOR = '/thread:';

/**
 * The exact id domain an address can carry: 16 base64url characters.
 *
 * Every id in this product is `randomBytes(12).toString('base64url')`, which is
 * always exactly 16 characters of `[A-Za-z0-9_-]`, and the prose reader already
 * pins that shape — `#conv:` in a message body is recognised by
 * `Markdown.tsx`'s reference scanner only at `{16}`. So the length is not a
 * generosity knob: a token this codec accepted but prose did not would be a
 * live address in a header and inert text in a message, which is the same
 * surface disagreeing with itself (@Cindy B3). One domain, spelled once here,
 * for the conversation id and the thread root alike.
 *
 * Fixtures do not get a vote. Short ids like `c1` exist in tests only, and an
 * address grammar widened to admit them would be defining product identity from
 * test data. If a real id shape is ever added, BOTH the prose parser and this
 * codec move together — never one of them being generous.
 *
 * Exported so the other consumer can share the constant rather than re-spell it.
 */
export const ADDRESSABLE_ID_PATTERN = '[A-Za-z0-9_-]{16}';
const ID_RE = new RegExp(`^${ADDRESSABLE_ID_PATTERN}$`);

declare const ADDRESSABLE_ID: unique symbol;

/**
 * An id that is known to be spellable in a single-token address.
 *
 * Branded so the knowledge lives in the TYPE: {@link formatDeliveryTarget} can
 * be total without validating, and no ordinary object literal can put an
 * unspellable id into a header. The brand is erased at runtime — an
 * `AddressableId` IS the string, so it can be compared and used as a DB
 * parameter directly.
 */
export type AddressableId = string & { readonly [ADDRESSABLE_ID]: true };

/** The only constructor. Returns `null` for an id no address could carry — the
 *  fail-closed branch for anything that came from outside. */
export function addressableId(raw: string): AddressableId | null {
  return ID_RE.test(raw) ? (raw as AddressableId) : null;
}

/**
 * The constructor for ids that came from OUR OWN store, where an unspellable id
 * is corruption rather than input: it throws instead of returning null.
 *
 * Two constructors on purpose. A resolver handed a user's string must fail
 * closed and report; a renderer holding `conversations.id` has no branch to take
 * — a stream whose id cannot be spelled has no address at all, and silently
 * omitting the target would leave the reader guessing, which is the ambient
 * default P4 exists to remove. `what` names the coordinate so the throw says
 * which one, not just that one existed.
 */
export function requireAddressableId(raw: string, what: string): AddressableId {
  const id = addressableId(raw);
  if (id === null) {
    throw new Error(`${what} is not spellable in a delivery target: ${JSON.stringify(raw)}`);
  }
  return id;
}

/**
 * The canonical target: a conversation, plus optionally the reply cluster inside
 * it.
 *
 * `threadRootId` is `null` for the main line — deliberately an explicit null
 * rather than an absent field, because "no thread" is a decision the sender
 * makes and an optional field would let a caller forget to make it (the ambient
 * default is what #task:2021 exists to remove).
 */
export interface DeliveryTarget {
  readonly conversationId: AddressableId;
  readonly threadRootId: AddressableId | null;
}

/**
 * `dm:@<handle>` — a human's shorthand for "the DM between me and this
 * principal", optionally with a reply cluster.
 *
 * In the grammar rather than in an error message because the resolver needs the
 * shorthand to be EXPRESSIBLE and clearly UNRESOLVED: it names a pair only
 * relative to the authenticated principal, and only for as long as the handle
 * belongs to the same person (#task:2028). Never produced by a target formatter,
 * so it cannot reach a header, an audit row or any other durable surface.
 */
export interface DirectPairShorthandTarget {
  readonly kind: 'direct_pair_shorthand';
  readonly handle: string;
  readonly threadRootId: AddressableId | null;
}

/** What a target-accepting surface may receive: the canonical form, or the one
 *  human shorthand. */
export type DeliveryTargetInput =
  | { readonly kind: 'stream'; readonly stream: DeliveryTarget }
  | DirectPairShorthandTarget;

const CONVERSATION_ADDRESS_RE = new RegExp(
  `^${CONVERSATION_ADDRESS_PREFIX}(${ADDRESSABLE_ID_PATTERN})$`,
);
const DIRECT_PAIR_SHORTHAND_RE = new RegExp(
  `^${DIRECT_PAIR_SHORTHAND_PREFIX}(${PARTICIPANT_HANDLE_PATTERN})$`,
);

/** Split a raw target into its head and its reply cluster.
 *
 *  The split is on the LAST {@link THREAD_ADDRESS_SEPARATOR}: no id and no
 *  handle can contain `/`, so at most one such separator can be structural, and
 *  taking the last one means a malformed head fails as a head rather than being
 *  silently re-cut. A trailing separator with no root id fails — an empty thread
 *  id would otherwise read as "the main line", i.e. the wrong stream. */
function splitThreadSuffix(
  raw: string,
): { head: string; threadRootId: AddressableId | null } | null {
  const separator = raw.lastIndexOf(THREAD_ADDRESS_SEPARATOR);
  if (separator === -1) return { head: raw, threadRootId: null };
  const threadRootId = addressableId(
    raw.slice(separator + THREAD_ADDRESS_SEPARATOR.length),
  );
  return threadRootId === null
    ? null
    : { head: raw.slice(0, separator), threadRootId };
}

/**
 * Parse a canonical target. Returns `null` for anything else — including the DM
 * shorthand, which is why the machine surfaces (the delivery header, a stored
 * reply-to, an audit record) call THIS function: they must not accept a spelling
 * they could not have produced.
 */
export function parseDeliveryTarget(raw: string): DeliveryTarget | null {
  const split = splitThreadSuffix(raw);
  if (split === null) return null;
  const head = CONVERSATION_ADDRESS_RE.exec(split.head);
  if (!head) return null;
  const conversationId = addressableId(head[1]!);
  return conversationId === null
    ? null
    : { conversationId, threadRootId: split.threadRootId };
}

/**
 * Parse a target from a surface that also accepts human shorthand (a CLI flag).
 * Returns `null` for anything that is not exactly one of the two forms — the
 * caller's fail-closed branch.
 */
export function parseDeliveryTargetInput(
  raw: string,
): DeliveryTargetInput | null {
  const stream = parseDeliveryTarget(raw);
  if (stream) return { kind: 'stream', stream };

  const split = splitThreadSuffix(raw);
  if (split === null) return null;
  const shorthand = DIRECT_PAIR_SHORTHAND_RE.exec(split.head);
  if (!shorthand) return null;
  const handle = shorthand[1]!;
  // The stored bound, applied here so a handle no principal could ever have is
  // reported as malformed instead of surviving to fail a lookup: "unresolved"
  // must always mean "nothing by that name".
  if (handle.length > ENTITY_NAME_MAX_LENGTH) return null;
  return {
    kind: 'direct_pair_shorthand',
    handle,
    threadRootId: split.threadRootId,
  };
}

/**
 * The canonical target form. Total on {@link DeliveryTarget} and round-trips
 * through {@link parseDeliveryTarget} for every value that type can hold — the
 * property the delivery header depends on: an agent copies the token it received
 * into `--target` and must land on the same stream.
 */
export function formatDeliveryTarget(target: DeliveryTarget): string {
  const conversation = `${CONVERSATION_ADDRESS_PREFIX}${target.conversationId}`;
  return target.threadRootId === null
    ? conversation
    : `${conversation}${THREAD_ADDRESS_SEPARATOR}${target.threadRootId}`;
}

/**
 * The per-viewer DISPLAY label for a direct pair: `dm:@<other handle>`.
 *
 * Here so the spelling has one authority (the DM board rows in #task:2022 render
 * it too), and separate from every `format*Target` function so the type system
 * keeps the two apart: this string names a pair only relative to the viewer and
 * only while the handle belongs to the same principal, so it may appear in a
 * label, a list row or a prompt sentence — never as a target, in a header, or in
 * anything durable.
 */
export function formatDirectPairLabel(otherHandle: string): string {
  return `${DIRECT_PAIR_SHORTHAND_PREFIX}${otherHandle}`;
}
