import { ENTITY_NAME_MAX_LENGTH, PARTICIPANT_HANDLE_PATTERN } from './api/name.js';
import {
  ADDRESS_TOKEN_MAX_BYTES,
  addressTokenByteLength,
} from './address-segment.js';
import {
  formatConversationAddressSegment,
  parseConversationAddressSegment,
  type CanonicalConversationTitle,
} from './conversation-title.js';
import {
  formatWorkspaceAddressSegment,
  parseWorkspaceAddressSegment,
  type CanonicalWorkspaceName,
} from './workspace-name.js';

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
 * Why an address at all: the header used to say `target=channel`, which only
 * meant anything because the runtime was pinned to exactly one conversation. An
 * agent-scoped runtime serves N, so `channel` stopped naming a stream and
 * started naming whichever one the reader assumed. The fix was not a second
 * format but a value object: the target is something the message carries (P4-3
 * derives it from the row's own `conversation_id`) and the reply copies
 * verbatim, instead of ambient process state.
 *
 * **There are two absolute forms, and the readable one is the point** (@shiki's
 * ruling on this ticket; #task:2016 / #task:2027 shipped its roots):
 *
 *  - `#<workspace>/<title>` — the coordinate spelled out of the names a person
 *    typed. A regular workspace's display name is unique in the installation and a
 *    channel title is unique in its workspace, both case-insensitively over
 *    `casefold(NFC(trim(…)))`, so the pair names exactly one conversation AT ANY
 *    ONE TIME. This spelling is ADJUDICATED, not chosen here (@shiki, this
 *    channel: "还是用之前定下的 target 语法，同时也用 channel display title") —
 *    an implementation ticket does not get to pick the agent-facing grammar, and a
 *    previous revision of this module shipped a `#…` URI
 *    that no ruling ever authorized (@Cindy B2). `silverhand://` is #task:2000's
 *    PRINCIPAL addressing scheme; a destination is the other axis of the four-layer
 *    model, and spelling it in that vocabulary conflates the two.
 *  - `#conv:<conversation_id>` — permanent, total, and the form every stream
 *    always has. It is the FALLBACK, not the address: a stream whose names cannot
 *    be spelled (an agent-home workspace has no address root, a legal title can
 *    exceed the token budget, a row predating the current character domain) still
 *    has to appear in a header.
 *
 * Readability is a CAPABILITY REQUIREMENT here, not decoration. The header is the
 * context an agent acts from on every wake, and `target=#conv:QVI9x6vU_K1a9oN9`
 * tells it only that some routing worked; `target=#silverhand/UI%2FUX%20优化`
 * tells it where it is. So the id form is the
 * degenerate case, and each fall back to it is COUNTED
 * ({@link AddressFallbackReason}) rather than accepted silently.
 *
 * **A name-shaped address is a coordinate, not a permanent allocation** — the
 * cost @shiki accepted by name. A rename releases the old title immediately and
 * anyone may take it, so `…/silverhand/roadmap` can begin to name a different
 * channel, with nothing able to detect that the sender meant the older one. What
 * IS provable is weaker and sufficient: at any instant one folded key resolves to
 * at most one conversation, and resolution fails closed otherwise. No
 * never-rebind claim may be written anywhere against this grammar, and nothing may
 * be built on retired-name ownership (#task:2016 removed the machinery).
 *
 * Three properties are load-bearing, and the shape below exists to keep them:
 *
 *  - **One token, never split.** The delivery header is fixed-order
 *    `key=value` with no quoting, so an address containing whitespace would make
 *    the header un-tokenizable — and a machine surface that cannot be split is
 *    the #task:2000 failure again (a plain-text read face must round-trip byte
 *    for byte). For ids this is enforced by CONSTRUCTION: an id only becomes an
 *    {@link AddressableId} through {@link addressableId}, so a
 *    {@link DeliveryTarget} carrying a value the parser would reject cannot be
 *    built out of an ordinary object literal (@Cindy B2 — the previous shape had
 *    bare `string` fields, which made the formatter's totality an untested claim
 *    about call sites rather than a fact about the type). For names it is the
 *    segment codec's job: `%20` for a space is the escape that looks optional and
 *    is not (`address-segment.ts`).
 *  - **Absolute, with exactly one first-person arm, and that arm never leaves its
 *    reader.** `#conv:` and the name form mean the same stream to everybody, so
 *    they can be logged, quoted and handed to another principal. `dm:@<handle>`
 *    cannot: it names "the pair between me and them", so it is rendered PER
 *    VIEWER, only into the one surface whose reader is the principal it was
 *    rendered for (the runtime stdin header), and is refused by every formatter
 *    that feeds a durable or cross-principal surface — {@link formatDeliveryTarget}
 *    takes a {@link DeliveryTarget}, which cannot express it.
 *  - **Rendering is total; parsing is strict.** {@link formatDeliveryTarget} is
 *    total on {@link DeliveryTarget} and {@link formatStreamAddressToken} is total
 *    on every naming a stream can have; only the exact forms below parse, with no
 *    repair, no truncation and no case folding of the token itself, because the
 *    alternative to reporting an unparsable target is delivering to the wrong
 *    stream. Case-INSENSITIVITY of names is not parser tolerance: it belongs to
 *    the lookup domain (the stored folded key), which is why this module accepts
 *    only the canonically-spelled segment and the resolver does the folding.
 *
 * This module is grammar and codec only: no lookups, and its only dependencies
 * are the other pure spelling authorities (the name domains and the segment
 * codec). Turning an address into a stream needs the conversation store, the
 * handle registry and the authenticated principal, so it lives in the backend
 * resolver — an address is a REQUEST for a stream, never proof that one exists.
 * The grammar is likewise placement-BLIND: `#conv:<id>` can spell a `direct_pair`
 * the caller has no part in, and refusing that as a destination is the resolver's
 * decision, not the parser's.
 *
 * Deliberately NOT merged with `reference.ts` (#task:2011's object references):
 * that grammar points at principals and objects inside prose and decides
 * addressing; this one names a destination in a header or a flag. They share only
 * the handle character class, and merging the parsers would put "who is this
 * message aimed at" and "where does it go" behind one predicate — which is
 * exactly the conflation the four-layer addressing model exists to prevent.
 */

/** The readable form's sigil: `#<workspace>/<title>`.
 *
 *  Same `#` a message body uses to name a PLACE (`#<channel>`, `#conv:<id>` —
 *  `reference.ts`), because "a place in this installation" is one vocabulary and a
 *  reader should not learn a second one to spell a destination. The parsers stay
 *  separate for the reason the module docblock gives: prose `#<channel>` is
 *  workspace-RELATIVE and single-segment, a target is absolute and two-segment.
 *
 *  A bare `#` is a comment introducer in every shell an agent writes commands for,
 *  so a name-shaped target has to be quoted in argv. That cost is NOT new and NOT
 *  differential: `#conv:<id>` is the PERMANENT fallback and carries it already, so
 *  no target spelling avoids it, and it is not grounds to re-open the grammar. */
export const NAMED_STREAM_ADDRESS_PREFIX = '#';

/** The canonical FALLBACK form: `#conv:<conversation_id>` — the one address every
 *  stream always has, and already the vocabulary agents are taught for naming a
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
 * `markdown.tsx`'s reference scanner only at `{16}`. So the length is not a
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
 * The readable target: a workspace-placed conversation named by the two names a
 * person typed, plus optionally the reply cluster inside it.
 *
 * Both fields are the BRANDED canonical values, not strings, for the same reason
 * {@link DeliveryTarget} carries {@link AddressableId}: only the name authorities
 * can construct them, so a value of this type is already known to be spellable and
 * already carries the folded key the resolver looks up by. A surface cannot pair a
 * display name with someone else's key, and the formatter needs no validation to
 * be total.
 *
 * There is no `workspaceId` here and no conversation id: this type is what the
 * ADDRESS said, and turning it into a stream is the resolver's job. A named target
 * that names nothing is an ordinary outcome, not a malformed value.
 */
export interface NamedStreamTarget {
  readonly kind: 'named_stream';
  readonly workspace: CanonicalWorkspaceName;
  readonly title: CanonicalConversationTitle;
  readonly threadRootId: AddressableId | null;
}

/**
 * `dm:@<handle>` — "the DM between me and this principal", optionally with a
 * reply cluster.
 *
 * The one FIRST-PERSON arm, and the reason it is in the grammar rather than in an
 * error message: it names a pair only relative to whoever reads it, and only for
 * as long as the handle belongs to the same principal (#task:2028 settled that a
 * deleted handle is released and may be reused). So it is admitted on input from
 * any target surface, and produced only by {@link formatStreamAddressToken} for
 * the per-viewer runtime header — never by {@link formatDeliveryTarget}, whose
 * argument type cannot express it, so nothing durable or cross-principal can echo
 * one (see the module docblock).
 */
export interface DirectPairShorthandTarget {
  readonly kind: 'direct_pair_shorthand';
  readonly handle: string;
  readonly threadRootId: AddressableId | null;
}

/** What a target-accepting surface may receive: either absolute form, or the
 *  first-person pair shorthand. */
export type DeliveryTargetInput =
  | { readonly kind: 'stream'; readonly stream: DeliveryTarget }
  | NamedStreamTarget
  | DirectPairShorthandTarget;

/** The reply-cluster suffix, as a fragment of EACH arm's own pattern.
 *
 *  Not a pre-split of the raw token. The suffix is POSITIONAL: every arm knows
 *  exactly how many structural `/` its head has (the id arm and the shorthand
 *  none, the named arm one — a slash inside a name is `%2F`, `address-segment.ts`),
 *  so "is this trailing `/thread:…` structural?" is answered by the arm, not by
 *  scanning for a separator.
 *
 *  That is what makes the formatter TOTAL. A cut-the-last-separator pre-split
 *  cannot see the difference between a suffix and a TITLE that begins with
 *  `thread:` — it cuts `#silverhand/thread:notes` into a one-segment head and
 *  refuses the whole token, so a legally named channel would have an address its
 *  own emitter prints and this parser rejects. Anchored per arm, the same string is
 *  two segments and no suffix (the title), while `#silverhand/room/thread:<id>` is
 *  two segments and a suffix, and a title of literally `thread:<id>` still suffixes
 *  correctly at `#silverhand/thread:<id>/thread:<root>`.
 *
 *  A trailing separator with no valid root id matches no arm, so the whole token is
 *  refused: an empty or malformed thread id must never fall back to "the main line",
 *  which is a different stream. */
const THREAD_SUFFIX_SOURCE = `(?:${THREAD_ADDRESS_SEPARATOR}(${ADDRESSABLE_ID_PATTERN}))?`;

const CONVERSATION_ADDRESS_RE = new RegExp(
  `^${CONVERSATION_ADDRESS_PREFIX}(${ADDRESSABLE_ID_PATTERN})${THREAD_SUFFIX_SOURCE}$`,
);
const DIRECT_PAIR_SHORTHAND_RE = new RegExp(
  `^${DIRECT_PAIR_SHORTHAND_PREFIX}(${PARTICIPANT_HANDLE_PATTERN})${THREAD_SUFFIX_SOURCE}$`,
);
const NAMED_STREAM_RE = new RegExp(
  `^${NAMED_STREAM_ADDRESS_PREFIX}([^/]+)/([^/]+)${THREAD_SUFFIX_SOURCE}$`,
);

/** An arm's suffix group as a reply-cluster id. The group is spelled with
 *  {@link ADDRESSABLE_ID_PATTERN} itself, so this applies the BRAND rather than
 *  validating a second time — and it throws instead of degrading to `null`,
 *  because a `null` here would read as "the main line", i.e. the wrong stream,
 *  and the only way to reach it is for the arm's pattern and the brand to have
 *  drifted apart in this file. */
function threadRootOf(group: string | undefined): AddressableId | null {
  return group === undefined ? null : requireAddressableId(group, 'thread root id');
}

/**
 * Parse the id form. Returns `null` for anything else — including the readable
 * form and the DM shorthand, which is why the surfaces that must accept only what
 * they could have PRODUCED FROM AN ID (a stored reply-to, an audit record) call
 * THIS function rather than {@link parseDeliveryTargetInput}.
 */
export function parseDeliveryTarget(raw: string): DeliveryTarget | null {
  const match = CONVERSATION_ADDRESS_RE.exec(raw);
  if (!match) return null;
  const conversationId = addressableId(match[1]!);
  if (conversationId === null) return null;
  return { conversationId, threadRootId: threadRootOf(match[2]) };
}

/**
 * Parse the readable arm: `#<ws>/<title>` with an optional reply cluster.
 *
 * Exactly two segments after the sigil, and each must be the canonical spelling
 * of a name the current domain accepts (the segment parsers decide that, and
 * refuse an alias). Not `split('/')` with a length check by accident — the count
 * IS the grammar: a third segment is not a nested address, and a missing one is
 * not "the workspace's default channel". The third `/`-delimited part, when there
 * is one, can only be the reply cluster ({@link THREAD_SUFFIX_SOURCE}).
 *
 * The segment count is also what keeps this arm disjoint from the id arm, which
 * shares the `#` sigil: `#conv:<id>` has NO structural `/` (a slash inside a name
 * is `%2F`), so it can never present two segments, and a workspace legitimately
 * NAMED `conv:x` produces `#conv:x/<title>` — two segments, and not an id, because
 * the id arm is anchored on exactly 16 addressable characters. Neither string can
 * be read as the other arm; see {@link parseDeliveryTargetInput}.
 */
function parseNamedArm(
  raw: string,
): Omit<NamedStreamTarget, 'kind'> | null {
  const match = NAMED_STREAM_RE.exec(raw);
  if (!match) return null;
  const workspace = parseWorkspaceAddressSegment(match[1]!);
  if (workspace === null) return null;
  const title = parseConversationAddressSegment(match[2]!);
  if (title === null) return null;
  return { workspace, title, threadRootId: threadRootOf(match[3]) };
}

/**
 * Parse a target from a surface that accepts everything an actor may spell: the
 * readable form, the id fallback, or the first-person pair shorthand. Returns
 * `null` for anything that is not exactly one of the three — the caller's
 * fail-closed branch.
 *
 * The order of the attempts is not a precedence rule, and it is no longer a
 * statement about prefixes: two of the three arms share the `#` sigil, so what
 * makes them disjoint is STRUCTURE. Each arm is anchored end to end, reply-cluster
 * suffix included — the id arm on `^#conv:` plus exactly
 * {@link ADDRESSABLE_ID_PATTERN} (and a name's slash is `%2F`, so it holds no
 * structural `/`); the named arm on exactly two `/`-free segments. `dm:@` is
 * disjoint by prefix. No string satisfies two of the three, so reordering this
 * function cannot change an answer — and a workspace actually named `conv:x` is an
 * ordinary named address rather than a collision.
 *
 * DELIBERATELY NOT SYMMETRIC WITH THE BUDGET. {@link ADDRESS_TOKEN_MAX_BYTES}
 * bounds what the formatter will EMIT, and this parser does not apply it: the
 * budget protects the header line, and refusing to understand a coordinate a
 * person spelled correctly would turn a rendering limit into a naming limit —
 * exactly what the permanent id fallback exists to avoid. A name domain that is
 * too long is refused by the name domains themselves, which is a different fact.
 */
export function parseDeliveryTargetInput(
  raw: string,
): DeliveryTargetInput | null {
  const stream = parseDeliveryTarget(raw);
  if (stream) return { kind: 'stream', stream };

  const named = parseNamedArm(raw);
  if (named) return { kind: 'named_stream', ...named };

  const shorthand = DIRECT_PAIR_SHORTHAND_RE.exec(raw);
  if (!shorthand) return null;
  const handle = shorthand[1]!;
  // The stored bound, applied here so a handle no principal could ever have is
  // reported as malformed instead of surviving to fail a lookup: "unresolved"
  // must always mean "nothing by that name".
  if (handle.length > ENTITY_NAME_MAX_LENGTH) return null;
  return {
    kind: 'direct_pair_shorthand',
    handle,
    threadRootId: threadRootOf(shorthand[2]),
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
 * The CONVERSATION the address names, as an address: the same head, with any
 * reply-cluster suffix dropped. `null` for a token that is not an address at all.
 *
 * A grammar operation, and therefore here: which trailing `/thread:…` is
 * structural is the ARM's fact ({@link THREAD_SUFFIX_SOURCE}), and a surface that
 * re-derived it with `split('/')` or `lastIndexOf` would be a second opinion on
 * where the separator is — one that cannot tell a suffix from a title beginning
 * with `thread:`. Head-preserving on purpose — it returns the actor's own spelling
 * of the conversation (readable, id, or pair shorthand), because turning one form
 * into another is resolution's job and this function has no way to do it.
 *
 * NOT a way for a conversation-granular door to accept a stream address: a door
 * that cannot act on a reply cluster refuses the suffix rather than dropping it
 * (`routes/internal-agent/delivery-target.ts`). The caller this exists for is the
 * one that is DERIVING a second, differently-granular address from one the actor
 * gave: `message send` spooling an oversized body as an attachment, where the
 * message goes to the stream and the attachment is owned by its conversation.
 */
export function conversationAddressOf(raw: string): string | null {
  // The PARSER decides whether this is an address AND where its suffix starts, on
  // the whole token. So the cut here is arithmetic on what the parser already
  // found, never a second scan: `…/thread:a/thread:b` is whatever one arm says it
  // is (a title of `thread:a` plus a cluster) and is cut there, not twice.
  const parsed = parseDeliveryTargetInput(raw);
  if (parsed === null) return null;
  const threadRootId =
    parsed.kind === 'stream' ? parsed.stream.threadRootId : parsed.threadRootId;
  if (threadRootId === null) return raw;
  return raw.slice(
    0,
    raw.length - (THREAD_ADDRESS_SEPARATOR.length + threadRootId.length),
  );
}

/**
 * The same token for an id that arrived OVER THE WIRE, where no schema constrains
 * its shape — the daemon's AgentSlot framing (`daemon/supervisor`), which learns a
 * conversation id from a backend frame rather than from a row it read.
 *
 * Total, and deliberately so: {@link requireAddressableId} would turn a peer's bad
 * coordinate into a thrown compose and a dead AgentSlot, when the correct outcome
 * is a routed delivery whose framing quotes exactly the coordinate that was sent.
 * An id the grammar cannot carry therefore comes back out verbatim after the
 * prefix, and the resulting token will NOT parse — which is the honest result: an
 * unspellable id is unaddressable, and this token is a framing LABEL the agent
 * reads ("which conversation woke me"), not a capability being granted.
 *
 * Here rather than as a prefix concatenation at the call site so the two
 * agent-facing spellings of a conversation address have one authority and cannot
 * drift (the daemon's framing and the stdin header's `target=`).
 */
export function formatUntrustedConversationAddress(conversationId: string): string {
  const id = addressableId(conversationId);
  return `${CONVERSATION_ADDRESS_PREFIX}${id ?? conversationId}`;
}

/**
 * The per-viewer DISPLAY label for a direct pair: `dm:@<other handle>`.
 *
 * Here so the spelling has one authority (the DM board rows in #task:2022 render
 * it too, and {@link formatStreamAddressToken} renders it as the pair's target in
 * the per-viewer runtime header), and separate from every function that formats an
 * ABSOLUTE target so the type system keeps the two apart: this string names a pair
 * only relative to the viewer and only while the handle belongs to the same
 * principal, so it belongs in a label, a list row, a prompt sentence, or a header
 * being written FOR THAT VIEWER — never in a durable field, an audit row, an event
 * payload, or anything a second principal reads.
 */
export function formatDirectPairLabel(otherHandle: string): string {
  return `${DIRECT_PAIR_SHORTHAND_PREFIX}${otherHandle}`;
}

/**
 * The closed vocabulary of ACTOR-facing refusals for an address — the whole of
 * what a caller is ever told about why their target was not accepted.
 *
 * Here rather than in the resolver that raises them, because this vocabulary is a
 * WIRE CONTRACT with three readers: the backend resolver produces exactly these,
 * the route maps each to a status, and the CLI translates each into the refusal an
 * agent reads. A code that existed in only two of the three is how the agent ends
 * up with "HTTP 400" for a fact the backend already named — so the set lives with
 * the grammar it judges and every reader derives from it.
 *
 * What is NOT here, deliberately: the branch that fired. Unknown and unauthorized
 * both surface as `target_unresolved`, and all three ways a suffix can fail to
 * name a cluster as `thread_not_in_target`. The distinction leaves through the
 * backend's operator port and never crosses the wire, so this set is safe to
 * publish in full — no reader can widen it into an existence oracle.
 *
 *  - `target_malformed` — not an address at all. Stays distinct because no lookup
 *    happened and the caller can only fix it if told.
 *  - `target_unresolved` — names no stream this principal may use.
 *  - `thread_not_in_target` — the suffix names no reply cluster of that
 *    conversation.
 *  - `self_pair_not_addressable` — `dm:@<own handle>`; a DM has two participants.
 */
export const DELIVERY_TARGET_REFUSAL_CODES = [
  'target_malformed',
  'target_unresolved',
  // Only for a peer whose profile the caller may already read.
  'direct_message_scope_forbidden',
  'thread_not_in_target',
  'self_pair_not_addressable',
] as const;

export type DeliveryTargetRefusalCode =
  (typeof DELIVERY_TARGET_REFUSAL_CODES)[number];

/**
 * The one refusal a CONVERSATION-granular door adds: it was handed a reply
 * cluster, and it has no operation on one.
 *
 * Separate from the set above because it is not a verdict about the address —
 * resolution succeeded — but about the door: a roster belongs to a conversation
 * and a cluster has no member set. It is still part of the same wire vocabulary,
 * since the CLI has to turn it into something an agent can act on (drop the
 * suffix), which is why it is published here next to the codes it accompanies.
 */
export const CONVERSATION_TARGET_SUFFIX_REFUSAL_CODE =
  'thread_suffix_not_supported';

/**
 * The one refusal that is about the CREDENTIAL rather than the address: this
 * runtime slot may not act on that stream through that door (#task:2021 P4-4).
 *
 * Published here, next to the codes it accompanies, because it has the same three
 * readers as the rest of the vocabulary and the same failure if any one of them
 * misses it — the agent would read "HTTP 403" for a fact the backend already named,
 * and the fact is precisely the one it needs: the token was right, the stream is
 * yours, and this door still acts only where your session is anchored. The reach
 * table itself is `delivery-reach.ts`, beside this; what crosses the wire is this
 * code and a fixed sentence.
 *
 * Not part of {@link DELIVERY_TARGET_REFUSAL_CODES} for the same reason
 * {@link CONVERSATION_TARGET_SUFFIX_REFUSAL_CODE} is not: resolution SUCCEEDED. It
 * is also not an existence oracle — it is only reachable once participation has
 * been proven, so it says nothing about a stream the caller could not already
 * enumerate.
 */
export const SLOT_REACH_REFUSAL_CODE = 'slot_out_of_scope';

/**
 * Why a stream was spelled with its id instead of its names.
 *
 * A closed set of three, and each one is a fact about the STREAM rather than about
 * the renderer, which is what makes the count actionable: the dogfood question
 * behind #task:2016's observability face is "should names get more machinery", and
 * the answer depends on which of these dominates.
 *
 *  - `agent_home` — the conversation is placed in an agent-home workspace, which
 *    has no address root at all (`workspaces.name_key IS NULL`, #task:2027). Not a
 *    defect: an agent's private workspace is not addressed by name.
 *  - `token_budget` — both names are renderable, and the encoded token does not fit
 *    {@link ADDRESS_TOKEN_MAX_BYTES}. The domain deliberately admits titles that
 *    cannot fit (128 astral code points), so this is the designed escape, not a
 *    validation hole.
 *  - `unrenderable` — a stored name or title that the CURRENT name domain would
 *    refuse, i.e. a row written before the domain was pinned, or one grandfathered
 *    by a later table upgrade. The only reason that indicates something an operator
 *    might want to clean up.
 *
 * Deliberately NOT a reason: a `direct_pair` placement. It is not workspace-placed
 * and has no name form by design — the pair renders its first-person label, and
 * counting that as a fallback would bury the three above under traffic that no
 * amount of naming machinery could ever remove.
 */
export type AddressFallbackReason =
  | 'agent_home'
  | 'token_budget'
  | 'unrenderable';

/**
 * What is known about a stream's NAMES at render time — the caller's whole
 * contribution to spelling a header target.
 *
 * Four arms, because there are exactly four cases and the renderer must not have
 * to guess between them: a stream is either nameable, workspace-placed but not
 * nameable (with the reason the caller alone can know), a pair being rendered for
 * one of its two participants, or a row with no name form for THIS viewer. Passing
 * the branded canonical values rather than raw columns is what makes
 * {@link formatStreamAddressToken} total without validating anything.
 */
export type StreamNaming =
  | {
      readonly kind: 'named';
      readonly workspace: CanonicalWorkspaceName;
      readonly title: CanonicalConversationTitle;
    }
  | { readonly kind: 'unnameable'; readonly reason: AddressFallbackReason }
  /** For the ONE viewer this header is being written for. */
  | { readonly kind: 'direct_pair'; readonly otherHandle: string }
  /** No first-person label to render this row in: the viewer is not an endpoint
   *  of the pair, or that endpoint's handle is gone. Addressed by id. */
  | { readonly kind: 'id_only' };

/**
 * Render the target token for a stream — TOTAL, and the one place a header target
 * is spelled.
 *
 * Total in the strong sense: every `(stream, naming)` pair produces a token that
 * {@link parseDeliveryTargetInput} accepts and that resolves back to the same
 * stream, for every reader who may read it. `fallback` is non-null exactly when
 * the readable form was WANTED and could not be produced, and it is the caller's
 * job to count it (the reason is returned rather than logged here because this
 * module has no logger and no notion of a window — #task:2027's
 * `WorkspaceAddressFallbackWindow` owns the aggregation, and a per-message warn is
 * explicitly forbidden).
 *
 * The budget is checked on the FINAL token including the thread suffix, because
 * the header carries the whole token; a check on the head alone could pass and
 * then emit an oversized line.
 */
export function formatStreamAddressToken(
  stream: DeliveryTarget,
  naming: StreamNaming,
): { token: string; fallback: AddressFallbackReason | null } {
  const suffix =
    stream.threadRootId === null
      ? ''
      : `${THREAD_ADDRESS_SEPARATOR}${stream.threadRootId}`;
  switch (naming.kind) {
    case 'named': {
      const token =
        `${NAMED_STREAM_ADDRESS_PREFIX}${formatWorkspaceAddressSegment(naming.workspace)}`
        + `/${formatConversationAddressSegment(naming.title)}${suffix}`;
      return addressTokenByteLength(token) <= ADDRESS_TOKEN_MAX_BYTES
        ? { token, fallback: null }
        : { token: formatDeliveryTarget(stream), fallback: 'token_budget' };
    }
    case 'unnameable':
      return { token: formatDeliveryTarget(stream), fallback: naming.reason };
    case 'direct_pair':
      return {
        token: `${formatDirectPairLabel(naming.otherHandle)}${suffix}`,
        fallback: null,
      };
    case 'id_only':
      return { token: formatDeliveryTarget(stream), fallback: null };
  }
}

/**
 * The human-READABLE spelling of a target token — the display inverse of the
 * address formatters above, and DISPLAY ONLY (#task:2149).
 *
 * Co-located with the formatters and delegating to the SAME grammar authority:
 * it runs the token through {@link parseNamedArm}, so a label is produced ONLY
 * for a canonical named target — one whose segments decode AND whose decoded
 * names are valid in the current name domain. An encoded leading space is
 * canonical as an ESCAPE but not as a NAME, and is refused here exactly as the
 * resolver refuses it, rather than shown as a name no target could carry. Every
 * other input — the id and pair forms (which hold no escapes), a non-canonical
 * escape, or a name the domain rejects — returns RAW and unchanged: no
 * best-effort decode, and no second validator beside the grammar. The structural
 * `/` and the `/thread:<id>` suffix are grammar, not name bytes, and pass
 * through verbatim.
 *
 * NEVER an input to identity, navigation or resolution: a decoded `%2F` is an
 * in-segment `/` the parser would read as a boundary, so the RAW token stays the
 * canonical value a surface stores or hands back to `--target`, and this string
 * only ever reaches a label.
 */
export function decodeTargetForDisplay(raw: string): string {
  const named = parseNamedArm(raw);
  if (named === null) return raw;
  const suffix =
    named.threadRootId === null
      ? ''
      : `${THREAD_ADDRESS_SEPARATOR}${named.threadRootId}`;
  return `${NAMED_STREAM_ADDRESS_PREFIX}${named.workspace.name}/${named.title.title}${suffix}`;
}
