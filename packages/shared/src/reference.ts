import { ENTITY_NAME_MAX_LENGTH, PARTICIPANT_HANDLE_PATTERN } from './api/name.js';

/**
 * #task:2000 — the canonical way a message body names a participant.
 *
 * A reference is a typed pointer to a principal, spelled as a URI destination:
 *
 *     silverhand://human/shiki
 *     silverhand://agent/Alice
 *
 * and written into prose as a CommonMark autolink — `<silverhand://agent/Alice>`
 * — which is the only spelling that addresses anyone, is what the composer
 * emits, and round-trips through every plain-text surface unchanged.
 *
 * TWO AXES, one grammar (shiki's ruling, 2026-08-13):
 *
 *  - **addressing** — only a reference destination written as an autolink in
 *    prose position carries mention semantics (viewer notification, thread
 *    follow, mention CC, runtime directed framing). A label-carrying link
 *    (`[Alice](silverhand://human/shiki)`) is refused precisely because the
 *    label can name a different identity than the destination, and the raw-body
 *    surfaces where that lie is visible are not the ones that decide. The plain
 *    `@handle` form addresses nobody either. This axis is NOT the gate on whether
 *    a channel message is delivered: an ordinary main-line message reaches every
 *    member, and a human send starts every idle one, without reading references.
 *    It IS read by thread auto-follow (a referenced member becomes a follower
 *    before the reply's follower-gated recipient plan is computed, so in a thread
 *    a reference can widen who receives it) and by mention CC. What it decides is
 *    who the message is aimed AT.
 *  - **display** — the renderer draws a chip for a reference AND for the plain
 *    `@handle` legacy alias, in more positions than addressing admits. A chip
 *    therefore means "a member reference the UI recognizes", NOT "addressed".
 *
 * This module owns the DESTINATION half and nothing else: it is the single
 * authority on whether a given href is a reference, shared verbatim by the
 * renderer (chip vs. inert text) and the backend (addressed vs. not). Neither
 * side may re-derive it by slicing the prefix itself — a second parser is how
 * the two sides come to disagree, and every disagreement is silent.
 *
 * The POSITION half (which Markdown nodes count as prose) lives in
 * `reference-markdown.ts`, behind its own subpath export because it needs a
 * Markdown parser.
 */

/** The mandatory literal prefix of every reference destination. Also the whole
 *  fast path: a body without this substring cannot contain a reference, which
 *  is what lets the addressing consumers skip Markdown parsing entirely. */
export const REFERENCE_PREFIX = 'silverhand://';

/** The principal kinds a reference can address. Deliberately the two PRINCIPAL
 *  kinds and nothing else: containers (workspace, channel, thread) and tasks
 *  have no handle to spell, so they keep using `#conv:<id>` / `#task:<n>` until
 *  they get one. `all` is not a kind — it is not a principal, so it cannot be
 *  the destination of a typed pointer. */
export const REFERENCE_KINDS = ['human', 'agent'] as const;
export type ReferenceKind = (typeof REFERENCE_KINDS)[number];

/** A parsed reference destination. `handle` is exactly the stored participant
 *  name — case-sensitive, as every resolver in the system already is. */
export interface Reference {
  readonly kind: ReferenceKind;
  readonly handle: string;
}

/**
 * Anchored, case-SENSITIVE, and total: the whole href must be the destination,
 * so a trailing path segment, a query string, a fragment, surrounding
 * whitespace, or an upper-case scheme all fail. Built from
 * {@link REFERENCE_PREFIX} and {@link PARTICIPANT_HANDLE_PATTERN} rather than
 * spelled out, so the fast path and the handle grammar cannot drift from it.
 *
 * Case sensitivity is a deliberate fail-closed choice. The alternative —
 * accepting `Silverhand://…` here while the fast path matches only the
 * lower-case literal — produces the one failure mode this design exists to
 * remove: a chip that is drawn, an author who believes they addressed someone,
 * and no delivery, no error, no signal anywhere.
 */
const REFERENCE_RE = new RegExp(
  `^${REFERENCE_PREFIX}(${REFERENCE_KINDS.join('|')})/(${PARTICIPANT_HANDLE_PATTERN})$`,
);

/**
 * Parse a link destination. Returns `null` for anything that is not exactly a
 * reference — the caller's fail-closed branch (inert text in the renderer, no
 * delivery in the backend).
 *
 * The handle domain is the STORED domain: the character grammar and the length
 * bound are both applied, so this parser accepts a handle if and only if
 * `ParticipantNameSchema` would. A handle no participant could ever have is
 * rejected here rather than left to fail a lookup, so "unresolvable" always
 * means "nobody by that name", never "malformed".
 */
export function parseReference(href: string): Reference | null {
  const match = REFERENCE_RE.exec(href);
  if (!match) return null;
  const handle = match[2]!;
  if (handle.length > ENTITY_NAME_MAX_LENGTH) return null;
  return { kind: match[1] as ReferenceKind, handle };
}

/** The destination form: `silverhand://agent/Alice`. */
export function formatReference(ref: Reference): string {
  return `${REFERENCE_PREFIX}${ref.kind}/${ref.handle}`;
}

/**
 * The canonical PROSE form: `<silverhand://agent/Alice>`.
 *
 * The autolink brackets are what make the destination survive as a destination:
 * bare `silverhand://agent/Alice` in prose is plain text (no autolink literal
 * covers a custom scheme), so it would be neither a chip nor an address. Every
 * producer that writes a reference into a body — the composer, the
 * server-authored system messages, the platform prompt's examples — writes this
 * form.
 */
export function formatReferenceToken(ref: Reference): string {
  return `<${formatReference(ref)}>`;
}

/**
 * Conservative pre-filter for "is it worth parsing this body at all".
 *
 * DERIVED from {@link REFERENCE_RE}, not written alongside it: the regex is
 * anchored on {@link REFERENCE_PREFIX}, so every href the parser accepts
 * contains this substring, and a body containing no accepted href needs no
 * Markdown parse. The implication is covered by a property test — the pair
 * "permissive parser, stricter fast path" is exactly the silent-non-delivery
 * bug, so it must not be possible to tighten one without failing a test.
 */
export function mayContainReference(text: string): boolean {
  return text.includes(REFERENCE_PREFIX);
}
