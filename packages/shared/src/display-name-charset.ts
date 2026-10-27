// The CHARACTER DOMAIN of a human-visible, retypable name (#task:2016).
//
// A conversation title is an ADDRESS now: someone reads it off the screen and
// types it back to route a message. A workspace name already was one. Both
// therefore share one question — which code points must a name never contain? —
// and this module is its single answer. Copies of a rejection set are how one
// name surface comes to accept what another rejects, and for an address that
// means a coordinate one process resolves and another refuses.
//
// The answer is an ALLOWLIST OVER PINNED DATA, never a runtime `\p{…}` class. The
// reason is the same one that made the case fold a shipped table: the backend on
// Node, the renderer on Electron's V8, the CLI and a packaged daemon carry up to
// four ICU revisions, and EVERY Unicode property drifts between them — `Cn` most
// visibly, but `Cf`, `Default_Ignorable_Code_Point` and `Emoji_Modifier` all gain
// members too. A verdict cannot be "a pure function of data we ship" while a regex
// engine supplies half the table. Allowlisting also fixes the direction of the
// residual risk: a code point assigned after `UNICODE_NAME_CHARSET_VERSION` is
// refused everywhere until the table is deliberately regenerated, where a
// blocklist would have accepted it on whichever process upgraded first.
//
// Split accordingly: `unicode-name-charset.ts` is generated data that only says
// what Unicode says, and this module is the policy — which sets bar a name, for
// which surface, and at what named cost. Neither is a general "safe text" filter:
// the domain of a name is deliberately wide, with CJK, accented Latin, `#`, `/`,
// `%`, spaces and single-code-point pictographs all legal (escaping a separator is
// the address codec's job, not the validator's).
//
// NEVER `\p{Emoji}`: that property matches ASCII digits, `#` and `*`, so a
// blanket emoji rule silently rejects `#2016` and `2026 roadmap`. The classes
// below name what is actually barred.
import {
  NAME_DEFAULT_IGNORABLE_RANGES,
  NAME_EMOJI_MODIFIER_RANGES,
  NAME_ENCLOSING_MARK_RANGES,
  NAME_REGIONAL_INDICATOR_RANGES,
  NAME_RENDERABLE_RANGES,
  inCodePointRanges,
} from './unicode-name-charset.js';

/** A code point that a name may not contain, and WHERE it is — as a code-point
 *  index, not a UTF-16 offset, so an astral character before it counts once and
 *  the index matches what a user would count. */
export interface ForbiddenCodePoint {
  readonly codePoint: number;
  /** 0-based index in `Array.from(value)`. */
  readonly index: number;
}

/**
 * One reason a code point is barred from a name.
 *
 * A predicate over a code point rather than a `RegExp`, because the membership
 * question is answered by pinned tables; `id` exists so a caller can say WHICH
 * rule fired without re-deriving it.
 */
export interface NameCodePointClass {
  readonly id: 'invisible' | 'sequence_forming_emoji_part';
  readonly includes: (codePoint: number) => boolean;
}

/**
 * Code points that render as NOTHING, or as nothing dependable — so two different
 * names can be pixel-identical, and one of them is a name nobody can retype.
 *
 * Two pinned tables, and the first does most of the work by exclusion:
 *
 *   - outside `NAME_RENDERABLE_RANGES` (General_Category ∉ {L*, M*, N*, P*, S*,
 *     Zs}). That covers `Cc` controls; the whole `Cf` format class (`U+200B`..
 *     `U+200F` zero-width space / ZWNJ / ZWJ / LRM / RLM, `U+202A`..`U+202E` and
 *     `U+2066`..`U+2069` bidi overrides and isolates — the RLO spoofing vector —
 *     `U+00AD` soft hyphen, `U+180E`, `U+FEFF` BOM, `U+061C`); `Cs` lone
 *     surrogates, which are ill-formed text that survives a JSON round trip; `Co`
 *     private use, whose glyph is whatever a font vendor decided, or tofu; `Zl`
 *     and `Zp`, which are not renderable on one line at all; and both halves of
 *     `Cn` — unassigned code points AND the permanently-reserved noncharacters
 *     `U+FDD0`..`U+FDEF` and the `U+xFFFE` / `U+xFFFF` pairs.
 *   - in `NAME_DEFAULT_IGNORABLE_RANGES`: the members of "renders as nothing"
 *     that ARE renderable by category — the variation selectors (`U+FE0E`,
 *     `U+FE0F`, `U+180B`..`U+180D`, `U+180F`, `U+E0100`..`U+E01EF`, all `Mn`),
 *     `U+034F` COMBINING GRAPHEME JOINER, and the Hangul / Khmer fillers `U+115F`,
 *     `U+1160`, `U+3164`, `U+FFA0`, `U+17B4`, `U+17B5` (`Lo` and `Mn`).
 *
 * Unassigned code points are barred as a CONSEQUENCE of allowlisting rather than
 * by a `Cn` rule, which is what makes the ban stable: `\p{Cn}` means "unassigned as
 * of the revision THIS ENGINE carries", so it would let one process accept a title
 * another refuses. The pinned allowlist gives every process the same answer and
 * moves the decision to a reviewed table bump.
 *
 * Named cost, not hidden: `U+200C` ZWNJ is orthographically REQUIRED in Persian
 * and several Indic scripts, so those titles cannot be typed. Reachability is
 * nil during dogfooding and the fix is additive (a joiner-position allowance,
 * both neighbours Letter/Mark/Number) without touching the key definition or the
 * address carrier — so it is not done here. Same shape for a script assigned in a
 * newer Unicode: regenerate the table, no model change.
 */
export const INVISIBLE_CODE_POINTS: NameCodePointClass = {
  id: 'invisible',
  includes: (codePoint) =>
    !inCodePointRanges(NAME_RENDERABLE_RANGES, codePoint) ||
    inCodePointRanges(NAME_DEFAULT_IGNORABLE_RANGES, codePoint),
};

/**
 * Code points whose only job is to COMBINE with a neighbour into one emoji
 * grapheme — skin-tone modifiers, regional indicators (flags), and enclosing
 * marks (the keycap ring).
 *
 * Barred because a sequence is where the name stops being one visible thing:
 * two regional indicators are one flag on one platform and two boxed letters on
 * another, a base with and without a skin tone are the same name to a reader,
 * and the keycap ring turns `1` into a different-looking `1`. Single-code-point
 * pictographs (`🚀`, `✅`, `❤`) are legal and unaffected — what makes a title
 * ambiguous is invisible characters and raw separators, not visible glyphs
 * (adjudicated on #task:2016).
 *
 * A consequence, stated because it is the rule doing the work rather than a
 * separate check: `❤` + `U+FE0F` is rejected as a WHOLE by
 * {@link INVISIBLE_CODE_POINTS} (the variation selector), and the emoji-family
 * ZWJ sequences by the same class's non-renderable `Cf`. Nothing is ever stripped
 * to make an input legal — see `conversation-title.ts`.
 *
 * ZWJ sequences and variation selectors are NOT repeated here for that reason;
 * this class covers only the parts that are visible on their own and therefore
 * escape the invisibility rule. It is also why these three tables are kept out of
 * the allowlist's complement: a workspace name bars the invisible class only, and
 * an enclosing mark is a different question from an unrenderable code point.
 */
export const SEQUENCE_FORMING_EMOJI_PARTS: NameCodePointClass = {
  id: 'sequence_forming_emoji_part',
  includes: (codePoint) =>
    inCodePointRanges(NAME_EMOJI_MODIFIER_RANGES, codePoint) ||
    inCodePointRanges(NAME_ENCLOSING_MARK_RANGES, codePoint) ||
    inCodePointRanges(NAME_REGIONAL_INDICATOR_RANGES, codePoint),
};

/**
 * The first code point of `value` matched by any of `forbidden`, or `null`.
 *
 * Scans by code point so the report carries a code-point index and the caller can
 * name the offender as `U+XXXX`. An offending code point IS the whole diagnosis
 * here: no rule in this module depends on context, which is what keeps a validator
 * built from it total and order-independent.
 */
export function findForbiddenCodePoint(
  value: string,
  forbidden: readonly NameCodePointClass[],
): ForbiddenCodePoint | null {
  let index = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    for (const rule of forbidden) {
      if (rule.includes(codePoint)) return { codePoint, index };
    }
    index += 1;
  }
  return null;
}
