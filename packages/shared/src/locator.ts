import { ENTITY_NAME_MAX_LENGTH, PARTICIPANT_HANDLE_PATTERN } from './api/name.js';
import { compareEndpointText } from './conversation-placement.js';
import {
  formatConversationUriSegment,
  parseConversationUriSegment,
  type CanonicalConversationTitle,
} from './conversation-title.js';
import { addressableId, type AddressableId } from './delivery-target.js';
import { REFERENCE_PREFIX, mayContainReference } from './reference.js';
import {
  formatWorkspaceUriSegment,
  parseWorkspaceUriSegment,
  type CanonicalWorkspaceName,
} from './workspace-name.js';

/**
 * #task:2119 — the canonical way prose names a CONTAINER: a workspace, a channel,
 * a thread, or a DirectPair.
 *
 *     silverhand://workspace/silverhand
 *     silverhand://workspace/silverhand/UI%2FUX%20优化
 *     silverhand://workspace/silverhand/设计/Wf3kQ2p8Lm1aBc7D
 *     silverhand://dm/Cindy/shiki
 *     silverhand://dm/Cindy/shiki/Wf3kQ2p8Lm1aBc7D
 *
 * spelled as a CommonMark autolink in prose, exactly like a {@link Reference}.
 * That shared spelling is the whole point of the design — a person and an agent
 * write coordinates the same way, and a reader can tell from the literal text what
 * kind of thing a link goes to and where it sits — and it is also the reason this
 * module exists SEPARATELY from `reference.ts`.
 *
 * A LOCATOR IS NOT A REFERENCE, and widening `Reference` to carry container kinds
 * would have been the wrong shape:
 *
 *  - `parseReference` is the ADDRESSING authority. Thread auto-follow and mention
 *    CC read it to decide who a message is aimed at. A container has no inbox: a
 *    locator must never produce a mention, a wake, a CC, a thread follow, or
 *    directed framing for a runtime.
 *  - Widening the union would put the burden on every consumer to narrow it back,
 *    and a consumer that forgot would treat a channel locator as an addressed
 *    principal. That failure is silent, which is the failure mode the reference
 *    design exists to remove.
 *
 * So the two grammars are DISJOINT BY ROOT WORD — `human`/`agent` address a
 * principal, `workspace`/`dm` locate a container — and the disjointness is asserted
 * by a property test derived from both constant arrays rather than by review.
 * `REFERENCE_PREFIX` is shared because the scheme is one scheme; nothing else is.
 *
 * WHAT A LOCATOR RESOLVES THROUGH IS A LIVE NAME (shiki's ruling, 2026-08-21). The
 * URI carries no opaque id and no binding token, so a locator written today points
 * at whatever bears that name when someone clicks it. Renaming a workspace or a
 * channel releases the old name immediately (#task:2016 / #task:2027), so an old
 * locator can go dead — and, if the name is later taken by a different object,
 * silently point at that one instead. shiki priced that risk explicitly and
 * accepted it in exchange for a coordinate a human can read and type; do not
 * reintroduce a stable-id compromise here without reopening that decision.
 *
 * NAVIGABILITY IS NOT PART OF THE GRAMMAR. Parsing tells you the literal names a
 * locator spells; it does not tell you the object exists, or that the viewer may
 * see it. Those are resolution's answers, they are viewer-dependent, and they are
 * deliberately INDISTINGUISHABLE from each other (a missing object and an
 * unauthorized one degrade identically, or the pair would be an existence oracle).
 * A parse that succeeds is what lets the renderer draw a sigil for a container the
 * viewer cannot open — which is exactly what a DM locator posted in a public
 * channel needs.
 */

/** The container kinds a locator's ROOT word can name. Disjoint from
 *  `REFERENCE_KINDS` by construction — see this module's docblock. */
export const LOCATOR_ROOTS = ['workspace', 'dm'] as const;
export type LocatorRoot = (typeof LOCATOR_ROOTS)[number];

/**
 * Two handles in the locator's canonical order.
 *
 * ORDERED HERE, over HANDLES, and that is NOT the order the database stores. The
 * DirectPair aggregate canonicalizes over `(kind, id)` — `canonicalEndpointOrder`
 * is kind-major and v74's `pair_key` is built from opaque endpoint ids — and a
 * locator cannot evaluate either, because ids are what resolution produces, not
 * what prose carries. What is reused is therefore the COMPARATOR
 * ({@link compareEndpointText}: code points, i.e. UTF-8 bytes, never a locale and
 * never viewer-relative), not the ordering function.
 *
 * The two orders need not agree, and for a human↔agent pair they are not merely
 * unrelated — they FLIP whenever the agent's handle sorts after the human's.
 * `canonicalEndpointOrder` is kind-major and `'agent' < 'human'`, so the aggregate's
 * first endpoint is always the agent and the ids never enter the comparison; this
 * ordering is over handles, so agent `Norman` with human `Ada` is `[Ada, Norman]`
 * here and `[Norman, Ada]` there. Nothing depends on their agreeing — resolution
 * maps handles to principals and then re-orders by `(kind, id)` at the aggregate
 * boundary — but a CONSUMER that mixed them would show it: a chip labelled from the
 * resolved row's endpoints instead of from these parsed handles would swap its two
 * names the moment the locator became navigable, which is precisely the difference
 * an inert sigil promises NOT to have (@Norman, #task:2120). The label comes from
 * here.
 *
 * This ordering exists for one purpose — to make the PARSED value independent of the
 * order the author typed.
 *
 * BRANDED, so that purpose survives outside the parser (@Cindy, #task:2119). A bare
 * `readonly [string, string]` would let an ordinary object literal build a
 * `direct_pair` locator holding a reversed pair, a self-pair, or a string no
 * participant could be named — and {@link formatLocator} would emit it, which makes
 * "the formatter emits only the canonical order" false for every caller that is not
 * the parser. Feeding parser output back into the formatter cannot detect that: the
 * value under test was already normalized. The brand moves the promise from the call
 * sites to the TYPE — the symbol is declared here and exported nowhere, so the only
 * values that exist are the ones {@link parseLocatorEndpoints} produced, exactly as
 * `CanonicalWorkspaceName` and `CanonicalConversationTitle` already do for the two
 * name segments of the same locator.
 */
declare const LOCATOR_ENDPOINTS: unique symbol;

export type LocatorEndpoints = readonly [string, string] & {
  readonly [LOCATOR_ENDPOINTS]: true;
};

/**
 * A parsed locator. Three arms, and `threadRootId` appears only on the two that can
 * legally carry one, so an illegal combination (a workspace with a thread) is not
 * representable rather than merely unreachable.
 *
 * EVERY FIELD IS A VALIDATED VALUE ITS OWN MODULE OWNS — `CanonicalWorkspaceName`,
 * `CanonicalConversationTitle`, {@link LocatorEndpoints}, `AddressableId` — and none
 * of the four is constructible from outside. That is what makes {@link formatLocator}
 * total AND canonical for the whole type rather than only for parser output: there is
 * no `Locator` value whose formatting {@link parseLocator} would refuse.
 */
export type Locator =
  | {
      readonly kind: 'workspace';
      readonly workspace: CanonicalWorkspaceName;
    }
  | {
      readonly kind: 'channel';
      readonly workspace: CanonicalWorkspaceName;
      readonly channel: CanonicalConversationTitle;
      readonly threadRootId: AddressableId | null;
    }
  | {
      readonly kind: 'direct_pair';
      readonly endpoints: LocatorEndpoints;
      readonly threadRootId: AddressableId | null;
    };

const HANDLE_RE = new RegExp(`^${PARTICIPANT_HANDLE_PATTERN}$`);

/**
 * Parse a link destination as a locator, or `null` for anything that is not exactly
 * one.
 *
 * STRICT ARITY, no heuristics: the root word plus the number of path segments
 * decides the arm, and every segment is validated in the domain its position gives
 * it. An empty segment, a missing segment, a fourth segment, a trailing slash, a
 * query, a fragment, surrounding whitespace or an upper-case scheme all fail. There
 * is no "did you mean" recovery, because the two things a recovery could produce —
 * a coordinate the author did not write, or two spellings of one coordinate — are
 * both worse than plain text.
 *
 * FAILING HERE IS COMPLETELY SILENT AT THE PRODUCT LEVEL (@Norman): a destination
 * this rejects is not drawn as an inert sigil, it is not drawn as a chip at all —
 * it stays the literal text the author typed. That is why the accepted set has to
 * cover what people actually type, and why the DM arm accepts both endpoint orders
 * (see below) instead of insisting on the sorted one.
 *
 * FEED IT THE AUTHOR'S BYTES (@Cindy, #task:2119). The argument must be the raw
 * destination as it was written — mdast's `node.url` — never a value round-tripped
 * through `new URL()` or read back from a DOM `anchor.href`. WHATWG URL serialization
 * re-encodes what this grammar deliberately leaves raw (CJK, and `"`, `^`, `` ` ``,
 * `{`, `}`), and this parser then CORRECTLY refuses that second spelling — so a
 * consumer that normalizes before parsing turns a valid locator into plain text, and
 * the one-spelling-per-name rule is what makes the refusal right rather than fixable
 * here by widening the escape set.
 */
export function parseLocator(href: string): Locator | null {
  if (!href.startsWith(REFERENCE_PREFIX)) return null;
  const path = href.slice(REFERENCE_PREFIX.length);
  // Raw `/` is the ONE structural character: every segment escapes its own slashes
  // (`%2F`), so splitting before decoding is exact rather than best-effort.
  const segments = path.split('/');
  const root = segments[0];
  if (root === 'workspace') return parseWorkspaceLocator(segments.slice(1));
  if (root === 'dm') return parseDirectPairLocator(segments.slice(1));
  return null;
}

function parseWorkspaceLocator(rest: readonly string[]): Locator | null {
  if (rest.length === 0 || rest.length > 3) return null;
  const workspace = parseWorkspaceUriSegment(rest[0]!);
  if (workspace === null) return null;
  if (rest.length === 1) return { kind: 'workspace', workspace };
  const channel = parseConversationUriSegment(rest[1]!);
  if (channel === null) return null;
  const threadRootId = rest.length === 3 ? parseThreadRootId(rest[2]!) : null;
  if (rest.length === 3 && threadRootId === null) return null;
  return { kind: 'channel', workspace, channel, threadRootId };
}

/**
 * `dm/<handle>/<handle>[/<thread root>]`.
 *
 * BOTH ENDPOINT ORDERS ARE ACCEPTED, and this is a deliberate, narrow exception to
 * the canonical-only rule the segment codec enforces — the only one in this grammar.
 * A DirectPair is an UNORDERED pair of principals: `dm/Cindy/shiki` and
 * `dm/shiki/Cindy` are two spellings of the same author intent, both natural to
 * type, and rejecting either produces no message anywhere (see
 * {@link parseLocator}). What canonical-only protects is that ONE OBJECT HAS ONE
 * ADDRESS in the sense that matters — a resolvable key — and that still holds:
 * both orders normalize HERE, so no consumer can observe which order was typed, and
 * both reach the one conversation that pair has.
 *
 * The exception is exactly this and nothing more. Every NAME segment stays strictly
 * canonical (case, over-escaping and alias spellings are all still refused), and
 * the formatter emits only the sorted order. The residual to state plainly, because
 * this ticket does not rewrite message bodies: one DM therefore has TWO persistent
 * spellings in stored prose, and a reader of raw bytes can still see which one the
 * author typed.
 *
 * A SELF-PAIR IS REFUSED, matching `canonicalEndpointOrder`: "a DM with myself" is
 * a product question this model leaves out, not a coordinate. Refused as a syntax
 * failure (no chip at all) rather than as an inert sigil, because there is no object
 * whose absence could be reported.
 */
function parseDirectPairLocator(rest: readonly string[]): Locator | null {
  if (rest.length < 2 || rest.length > 3) return null;
  const endpoints = parseLocatorEndpoints(rest[0]!, rest[1]!);
  if (endpoints === null) return null;
  const threadRootId = rest.length === 3 ? parseThreadRootId(rest[2]!) : null;
  if (rest.length === 3 && threadRootId === null) return null;
  return { kind: 'direct_pair', endpoints, threadRootId };
}

/**
 * The ONLY constructor for {@link LocatorEndpoints}: two handles in, the canonical
 * pair out, `null` for anything that is not a pair of distinct participant handles.
 *
 * Validation and ordering are ONE function on purpose. Split apart, a caller could
 * order without validating (the shape B1 reported) or validate without ordering, and
 * either half alone is not the invariant the formatter's contract quotes.
 *
 * IDENTITY OF HANDLES IS BYTE IDENTITY HERE, which is the same relation
 * `parseReference` applies to the handle it addresses: this module holds no fold for
 * participant names because the product has none to borrow — unlike a workspace name
 * or a channel title, a handle has no stored fold key. So `dm/cindy/Cindy` is two
 * endpoints to this grammar. If handle uniqueness is ever case-insensitive at the
 * store, that pair resolves to one principal and the DirectPair aggregate refuses it
 * at ITS boundary, where the fold actually lives; inventing a second fold here is how
 * two authorities come to disagree about who a name is.
 *
 * Ordered by {@link compareEndpointText} rather than JS `<`: handles are ASCII today
 * ({@link PARTICIPANT_HANDLE_PATTERN}), where the two orders coincide, but this is the
 * product's ONE endpoint comparator and borrowing it costs nothing. It also refuses a
 * lone surrogate instead of comparing it, which is the behaviour a coordinate wants at
 * a boundary.
 */
export function parseLocatorEndpoints(
  x: string,
  y: string,
): LocatorEndpoints | null {
  if (!isHandle(x) || !isHandle(y)) return null;
  if (x === y) return null;
  const ordered = compareEndpointText(x, y) <= 0 ? [x, y] : [y, x];
  return ordered as unknown as LocatorEndpoints;
}

/**
 * The pair for handle LITERALS THIS CODEBASE OWNS — a fixture, a constant. Throws
 * when the two strings are not a pair, exactly as `fixedWorkspaceName` and
 * `fixedConversationTitle` do for their own domains, and for the same reason: a
 * refusal here means a literal in this repository is wrong, and giving every internal
 * construction path an error arm for an impossible outcome hides the real arms.
 *
 * Never reachable from user input — a string a person typed goes through
 * {@link parseLocatorEndpoints}, whose `null` is the silent no-chip outcome.
 */
export function fixedLocatorEndpoints(x: string, y: string): LocatorEndpoints {
  const endpoints = parseLocatorEndpoints(x, y);
  if (endpoints === null) {
    throw new Error(
      `locator endpoints ${JSON.stringify([x, y])} are not a pair of distinct participant handles`,
    );
  }
  return endpoints;
}

/** The handle domain is the STORED domain, exactly as `parseReference` applies it:
 *  a handle no participant could ever have is rejected here, so "unresolvable"
 *  always means "nobody by that name" and never "malformed". */
function isHandle(segment: string): boolean {
  return segment.length <= ENTITY_NAME_MAX_LENGTH && HANDLE_RE.test(segment);
}

/**
 * The thread leaf reuses the addressable message-id grammar the CLI `target=` suffix
 * already uses — the same CONSTRUCTOR, not a second copy of the pattern, so a root id
 * that addresses a thread in a header addresses the same thread here and neither form
 * can be widened alone.
 *
 * `AddressableId` out, so the check does not have to be re-run or re-trusted
 * downstream (@Cindy, #task:2119): a bare `string` field would have let an object
 * literal carry `'short'` into {@link formatLocator}, which would then emit a locator
 * {@link parseLocator} refuses — the same total-formatter hole `DeliveryTarget` closed
 * with this brand.
 */
function parseThreadRootId(segment: string): AddressableId | null {
  return addressableId(segment);
}

/**
 * The destination form. TOTAL AND CANONICAL over the WHOLE type: every
 * {@link Locator} value has exactly one, sorted endpoints and canonically escaped
 * names, and {@link parseLocator} accepts all of them.
 *
 * That is a property of the TYPE, not of this function's callers. It holds because
 * each field is a validated value only its own module can construct, so there is no
 * non-canonical `Locator` to be handed one; this function therefore validates nothing
 * and has no failure arm to define. Widening any field to a bare `string` would silently
 * demote both words in the sentence above to "if the caller was the parser".
 *
 * There is no length budget and no fallback form, unlike the `target=` token: prose
 * has no field to overflow, and a locator has no `#conv:<id>` equivalent to degrade
 * to. A name that is legal is spellable.
 */
export function formatLocator(locator: Locator): string {
  const path = locatorPath(locator);
  return `${REFERENCE_PREFIX}${path}`;
}

function locatorPath(locator: Locator): string {
  switch (locator.kind) {
    case 'workspace':
      return `workspace/${formatWorkspaceUriSegment(locator.workspace)}`;
    case 'channel': {
      const head =
        `workspace/${formatWorkspaceUriSegment(locator.workspace)}` +
        `/${formatConversationUriSegment(locator.channel)}`;
      return locator.threadRootId === null
        ? head
        : `${head}/${locator.threadRootId}`;
    }
    case 'direct_pair': {
      const head = `dm/${locator.endpoints[0]}/${locator.endpoints[1]}`;
      return locator.threadRootId === null
        ? head
        : `${head}/${locator.threadRootId}`;
    }
  }
}

/**
 * The canonical PROSE form: `<silverhand://workspace/silverhand/设计>`.
 *
 * The autolink brackets are load-bearing for the same reason they are on a
 * reference: no autolink literal covers a custom scheme, so a bare destination in
 * prose is plain text and would be neither a sigil nor navigable. Every producer
 * that writes a locator into a body writes THIS form.
 */
export function formatLocatorToken(locator: Locator): string {
  return `<${formatLocator(locator)}>`;
}

/**
 * Conservative pre-filter — "is it worth parsing this body at all".
 *
 * DELEGATES to {@link mayContainReference} rather than repeating its body: the
 * scheme prefix is shared, so the filter for the two grammars is necessarily the
 * same predicate, and writing it twice would let one copy be tightened alone. The
 * second NAME exists so a call site reads as the grammar it is about to run.
 */
export function mayContainLocator(text: string): boolean {
  return mayContainReference(text);
}
