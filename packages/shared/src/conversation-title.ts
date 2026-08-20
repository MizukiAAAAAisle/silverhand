// A conversation's TITLE and the key its uniqueness is judged on (#task:2016).
//
// The title is the address. There is no separate slug: the one field a user edits
// is the one coordinate a reference resolves through, so `conversations.title`
// carries a uniqueness constraint — case-insensitively, per workspace, over
// workspace-placed conversations.
//
// SQLite cannot express that constraint on `title` itself: `lower()` folds ASCII
// only, `GLOB` has no notion of NFC, and there is no Unicode whitespace class. So
// the key is a stored column and the UNIQUE index proves exactly one thing —
// **stored keys are unique**. It knows nothing about `title`. "Display titles are
// unique" is a CONJUNCTION of three properties, and dropping any one of them
// makes the claim false:
//
//  1. ONE canonicalizer. This module, and no second implementation anywhere.
//  2. A TERMINAL WRITER. `title` and its key are only writable as a
//     {@link CanonicalConversationTitle} pair, which nothing outside this module
//     can construct — so a write path cannot bring its own fold, and cannot pair
//     one title's text with another title's key. That is why the pair is a
//     branded object rather than two parameters.
//  3. HALF-STATE DETECTABLE AT RUNTIME, not just in CI: the production writer has
//     zero bypasses, and an integrity scan recomputes every row's key from its
//     title (before and after the migration, plus on demand) and fails loud with
//     samples.
//
// The case fold is `unicode-case-fold.ts` — pinned DATA, because
// `String.prototype.toLowerCase` is not case folding at all (`ß` stays `ß`) and
// anything derived from the host engine's tables would make a stored key mean
// something different after a Node or Electron upgrade.
import {
  INVISIBLE_CODE_POINTS,
  SEQUENCE_FORMING_EMOJI_PARTS,
  findForbiddenCodePoint,
} from './display-name-charset.js';
import { foldCase } from './unicode-case-fold.js';
import {
  TARGET_SEGMENT_CODEC,
  URI_SEGMENT_CODEC,
  type SegmentCodec,
} from './address-segment.js';

/**
 * Title length, in CODE POINTS — `Array.from`, not UTF-16 units, so an astral
 * character costs one. Grapheme clusters are deliberately not promised (a
 * Devanagari cluster costs more than one): a title is a short label, and
 * `Intl.Segmenter` is not worth a dependency here.
 *
 * The escaped form is longer than the title — a space becomes `%20` — and that
 * NEVER costs a title (#task:2016). When the encoded address token
 * does not fit its budget the formatter falls back to `#conv:<id>`, which is a
 * permanent form; the user's naming freedom is not narrowed to keep a token
 * short.
 */
export const CONVERSATION_TITLE_MAX_CODE_POINTS = 128;

declare const CANONICAL_CONVERSATION_TITLE: unique symbol;

/**
 * A title and the uniqueness key derived FROM THAT TITLE, as one value.
 *
 * The brand is the whole point: the symbol is declared here and exported nowhere,
 * so this object cannot be CONSTRUCTED outside this module. A repo that takes one
 * cannot be handed a hand-folded key, a key belonging to a different title, or a
 * title with no key at all — property 2 above, enforced by the compiler instead of
 * by review.
 *
 * The limit of that guarantee, stated where the guarantee is: a caller who already
 * holds a pair can spread it (`{ ...pair, key }`) and the brand comes along, so the
 * compiler is a wall around construction, not around mischief. What covers the
 * consequence is the pinned write points
 * (`packages/backend/tests/guard-conversation-title-paired-write.test.ts`) and
 * property 3 — a mismatched row fails boot closed.
 */
export interface CanonicalConversationTitle {
  /** The stored display form: NFC, trimmed. Byte-identical to what the user
   *  typed unless their input was un-normalized or padded. */
  readonly title: string;
  /** `NFC(foldCase(title))` — the value the UNIQUE index compares. */
  readonly key: string;
  readonly [CANONICAL_CONVERSATION_TITLE]: true;
}

/**
 * Why a proposed title is not storable. FORMAT only: a collision with another
 * conversation's key is a database fact and a different answer (`title_taken`),
 * decided in the write transaction.
 *
 * `codePoint` is reported because the offending character is usually invisible —
 * "must not contain invisible characters" is unactionable when the user cannot
 * see which one, and naming it `U+200D` is the only useful thing to say.
 */
export type ConversationTitleIssue =
  | { readonly kind: 'empty' }
  | { readonly kind: 'too_long'; readonly codePoints: number }
  | {
      readonly kind: 'forbidden_code_point';
      readonly codePoint: number;
      /** 0-based CODE POINT index in the normalized title. */
      readonly index: number;
    };

export type ConversationTitleResult =
  | { readonly ok: true; readonly value: CanonicalConversationTitle }
  | { readonly ok: false; readonly issue: ConversationTitleIssue };

/**
 * Normalization is exactly TWO steps, NFC then trim, and there is never a third.
 *
 * NFC first or trim first is the same function — NFC neither creates nor removes
 * the whitespace at a string's edges — so the order is not a rule anyone has to
 * remember. `String.prototype.trim` covers Unicode whitespace, so a title padded
 * with U+3000 IDEOGRAPHIC SPACE or U+00A0 normalizes like one padded with ASCII
 * spaces.
 *
 * Nothing else is normalized, and in particular nothing is STRIPPED: an input
 * containing a variation selector is REJECTED whole, never silently rewritten to
 * its bare form (#task:2016). Stripping would change the user's
 * display title behind their back and would be a third normalization step that
 * no reader of this contract knows about.
 */
function normalize(raw: string): string {
  return raw.normalize('NFC').trim();
}

/**
 * Recompute the canonical pair for a title ALREADY IN THE DATABASE — the
 * migration backfill and the integrity scan, and nothing else.
 *
 * TOTAL on purpose, where {@link parseConversationTitle} is not: every title
 * stored before this ticket existed was written under `trim().min(1).max(128)`
 * and nothing more, so rows can legitimately hold titles the new validator
 * rejects. A backfill that could not key those rows would fail the migration on
 * legal existing data, and an integrity scan that could not recompute them would
 * report every one as a half-state. Validation gates NEW writes; keying is total.
 */
export function canonicalizeStoredConversationTitle(
  title: string,
): CanonicalConversationTitle {
  const normalized = normalize(title);
  return {
    title: normalized,
    // The outer NFC is load-bearing: a fold can emit a decomposed sequence
    // (U+01F0 folds to `j` + COMBINING CARON), and a key is compared byte-wise,
    // so it has to be canonical too — not merely derived from canonical input.
    key: foldCase(normalized).normalize('NFC'),
  } as CanonicalConversationTitle;
}

/**
 * The product write path: normalize, validate, and derive the key — one call, so
 * a caller cannot validate one string and store another.
 */
export function parseConversationTitle(raw: string): ConversationTitleResult {
  const value = canonicalizeStoredConversationTitle(raw);
  const codePoints = Array.from(value.title);
  if (codePoints.length === 0) return { ok: false, issue: { kind: 'empty' } };
  if (codePoints.length > CONVERSATION_TITLE_MAX_CODE_POINTS) {
    return {
      ok: false,
      issue: { kind: 'too_long', codePoints: codePoints.length },
    };
  }
  const forbidden = findForbiddenCodePoint(value.title, [
    INVISIBLE_CODE_POINTS,
    SEQUENCE_FORMING_EMOJI_PARTS,
  ]);
  if (forbidden) {
    return {
      ok: false,
      issue: {
        kind: 'forbidden_code_point',
        codePoint: forbidden.codePoint,
        index: forbidden.index,
      },
    };
  }
  return { ok: true, value };
}

/**
 * The canonical pair for a title LITERAL THIS CODEBASE OWNS — the `Onboarding`
 * channel a new workspace is born with, an agent home's DM, a test fixture.
 * Throws when the literal is not storable.
 *
 * Never reachable from user input: a caller holding a string a person typed must
 * use {@link parseConversationTitle} and render the issue back to them. The throw
 * is for the other case, where a refusal means a constant in this repository is
 * wrong — and the alternative (every internal creation path carrying an error arm
 * for an outcome that cannot occur) buys nothing and hides the real arms.
 */
export function fixedConversationTitle(literal: string): CanonicalConversationTitle {
  const result = parseConversationTitle(literal);
  if (!result.ok) {
    throw new Error(
      `conversation title literal ${JSON.stringify(literal)} is not storable: ${describeConversationTitleIssue(result.issue)}`,
    );
  }
  return result.value;
}

/** Canonical readable-address segment for a workspace-placed conversation —
 *  the second segment of `#<workspace>/<title>` (#task:2021 P4-4). Symmetric with `formatWorkspaceAddressSegment`, so the two
 *  segments of one token are escaped by the same codec. */
export function formatConversationAddressSegment(
  title: CanonicalConversationTitle,
): string {
  return TARGET_SEGMENT_CODEC.encode(title.title);
}

/**
 * Strict inverse of {@link formatConversationAddressSegment}.
 *
 * Three conditions, all necessary, and the same set the workspace segment
 * applies: the percent codec's own canonicality, the decoded display bytes being
 * ALREADY NFC+trim canonical (so an encoded leading space is not an alias for the
 * trimmed title), and the re-encoding being byte-identical to the input (so
 * nothing that escapes a character the codec leaves raw resolves at all). One
 * title, one spelling — otherwise per-workspace uniqueness of the stored key
 * would not make the ADDRESS unique.
 */
export function parseConversationAddressSegment(
  segment: string,
): CanonicalConversationTitle | null {
  return parseTitleSegment(segment, TARGET_SEGMENT_CODEC);
}

/** The same title in the prose-URI carrier — `silverhand://workspace/<ws>/<title>`
 *  (#task:2119). A separate function rather than a carrier argument so that a call
 *  site cannot pick the wrong escape set by omission. */
export function formatConversationUriSegment(
  title: CanonicalConversationTitle,
): string {
  return URI_SEGMENT_CODEC.encode(title.title);
}

/** Strict inverse of {@link formatConversationUriSegment}, under the same three
 *  conditions {@link parseConversationAddressSegment} applies. The re-encode check
 *  is what makes the two carriers' accept sets DISJOINT where they differ rather
 *  than one being a superset of the other. */
export function parseConversationUriSegment(
  segment: string,
): CanonicalConversationTitle | null {
  return parseTitleSegment(segment, URI_SEGMENT_CODEC);
}

/** One implementation for both carriers: the three conditions are a property of
 *  the NAME domain, and only the escape set differs. */
function parseTitleSegment(
  segment: string,
  codec: SegmentCodec,
): CanonicalConversationTitle | null {
  const decoded = codec.decode(segment);
  if (decoded === null) return null;
  const parsed = parseConversationTitle(decoded);
  if (!parsed.ok || parsed.value.title !== decoded) return null;
  return codec.encode(parsed.value.title) === segment ? parsed.value : null;
}

/** Human-readable form of an issue, shared by the wire schema and the service
 *  error so a user reads the same sentence wherever the title was refused. */
export function describeConversationTitleIssue(
  issue: ConversationTitleIssue,
): string {
  switch (issue.kind) {
    case 'empty':
      return 'title must not be empty';
    case 'too_long':
      return `title must be at most ${CONVERSATION_TITLE_MAX_CODE_POINTS} characters (got ${issue.codePoints})`;
    case 'forbidden_code_point': {
      const point = `U+${issue.codePoint
        .toString(16)
        .toUpperCase()
        .padStart(4, '0')}`;
      return `title must not contain ${point} (position ${issue.index + 1}): invisible characters and multi-code-point emoji sequences are not addressable`;
    }
  }
}
