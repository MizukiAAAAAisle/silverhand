#!/usr/bin/env python3
"""Generate the pinned Unicode character-domain tables shipped in
`packages/shared/src/unicode-name-charset.ts`.

#task:2016 — a conversation title is an ADDRESS: a person reads it off the screen
and types it back to route a message, so "may a name contain this code point?" has
to have the SAME answer in the backend on Node, the renderer on Electron's V8, the
CLI, and a packaged daemon. Those are up to four ICU revisions. A regex `\\p{…}`
class asks the engine, which means the verdict is a property of the process — the
exact dependence the pinned case-fold table exists to remove, and it cannot be
removed for the fold and left in place for the charset: a title one process accepts
and another refuses is an address that resolves in one place and 404s in the other.

So the domain is expressed as an ALLOWLIST over pinned General_Category data, plus
the few pinned sets whose members are renderable-by-category yet still barred.
Allowlisting is what makes an unbumped table fail CLOSED: a code point Unicode 17
assigns is simply not in the list, so it is refused everywhere until this table is
deliberately regenerated — where `\\p{Cn}` would have flipped it to accepted on
whichever process upgraded first.

The generated module is DATA ONLY. Which class bars what, and why, is policy and
lives in `packages/shared/src/display-name-charset.ts`.

Usage (from the repo root):

    python3 scripts/generate-name-charset-table.py

Nothing in the build or the test suite calls this: it is a data generator and its
output is committed. `scripts/unicode_pin.py` is asserted first, so the revision the
table claims is the reviewed one rather than whichever CPython was on PATH.
"""

from __future__ import annotations

import sys
import unicodedata
from pathlib import Path

from unicode_pin import require_expected_unicode_version

MAX_CODE_POINT = 0x110000
REPO_ROOT = Path(__file__).resolve().parent.parent
TABLE_PATH = REPO_ROOT / 'packages/shared/src/unicode-name-charset.ts'

# General_Category values a name may draw from: every Letter, Mark, Number,
# Punctuation and Symbol, plus the space separator.
#
# Read as a REJECTION and it is the ticket's adjudicated list, arrived at by
# complement rather than by enumerating engine properties: `Cc`, `Cf`, `Cs`, `Co`,
# `Cn` (so unassigned AND every noncharacter), `Zl` and `Zp` are all outside it.
# `Me` is inside — an enclosing mark is renderable, and it is barred by the
# sequence-forming class instead, which is a different question with a different
# answer for workspace names.
RENDERABLE_CATEGORY_PREFIXES = ('L', 'M', 'N', 'P', 'S')
RENDERABLE_CATEGORIES_EXACT = ('Zs',)

# Other_Default_Ignorable_Code_Point (PropList.txt) ∩ renderable categories.
#
# These are the members of "renders as nothing" that a category test cannot see:
# every other default-ignorable is `Cf` or `Cn` and is already outside the
# allowlist. Variation selectors belong to the same property and are derived below
# rather than listed, because there are 275 of them.
#
# This list is the one hand-maintained input in this file. Its cost is named: a
# Unicode revision that adds an Other_Default_Ignorable in a renderable category
# would not appear here on its own, so bumping `scripts/unicode_pin.py` includes
# re-deriving this set from that revision's PropList.txt. Each entry is asserted
# assigned and renderable below, so a stale entry fails loud instead of sitting
# dead.
OTHER_DEFAULT_IGNORABLE_RENDERABLE = (
    0x034F,  # COMBINING GRAPHEME JOINER
    0x115F,  # HANGUL CHOSEONG FILLER
    0x1160,  # HANGUL JUNGSEONG FILLER
    0x17B4,  # KHMER VOWEL INHERENT AQ
    0x17B5,  # KHMER VOWEL INHERENT AA
    0x3164,  # HANGUL FILLER
    0xFFA0,  # HALFWIDTH HANGUL FILLER
)


def code_point_name(cp: int) -> str:
    try:
        return unicodedata.name(chr(cp))
    except ValueError:
        return f'U+{cp:04X}'


def is_renderable(cp: int) -> bool:
    category = unicodedata.category(chr(cp))
    return (
        category[0] in RENDERABLE_CATEGORY_PREFIXES
        or category in RENDERABLE_CATEGORIES_EXACT
    )


def to_ranges(code_points: list[int]) -> list[tuple[int, int]]:
    """Collapse a sorted code-point list into maximal contiguous ranges."""
    ranges: list[tuple[int, int]] = []
    for cp in code_points:
        if ranges and cp == ranges[-1][1] + 1:
            ranges[-1] = (ranges[-1][0], cp)
        else:
            ranges.append((cp, cp))
    return ranges


def render_ranges(name: str, doc: str, ranges: list[tuple[int, int]]) -> list[str]:
    lines = [doc, f'export const {name}: readonly (readonly [number, number])[] = [']
    for start, end in ranges:
        if start == end:
            comment = code_point_name(start)
        else:
            comment = f'{code_point_name(start)}..{code_point_name(end)}'
        lines.append(f'  [0x{start:04X}, 0x{end:04X}], // {comment}')
    lines.append('];')
    lines.append('')
    return lines


def named_code_points(predicate) -> list[int]:
    return [cp for cp in range(MAX_CODE_POINT) if predicate(code_point_name(cp))]


def main() -> int:
    unicode_version = require_expected_unicode_version()

    renderable = [cp for cp in range(MAX_CODE_POINT) if is_renderable(cp)]
    renderable_ranges = to_ranges(renderable)

    enclosing_marks = to_ranges(
        [cp for cp in range(MAX_CODE_POINT) if unicodedata.category(chr(cp)) == 'Me']
    )
    variation_selectors = named_code_points(lambda n: 'VARIATION SELECTOR' in n)
    emoji_modifiers = named_code_points(lambda n: n.startswith('EMOJI MODIFIER'))
    regional_indicators = named_code_points(
        lambda n: n.startswith('REGIONAL INDICATOR SYMBOL LETTER')
    )

    # Derived-by-name sets get a shape assertion, because a naming convention is a
    # weaker contract than a property file: if a revision renames or extends one of
    # these, the generator must stop rather than emit a table that silently lost
    # members.
    for label, found, expected in (
        ('variation selectors', len(variation_selectors), 260),
        ('emoji modifiers', len(emoji_modifiers), 5),
        ('regional indicators', len(regional_indicators), 26),
    ):
        if found != expected:
            sys.exit(
                f'refusing to generate: found {found} {label}, expected {expected} '
                f'in Unicode {unicode_version}. Re-derive the rule before bumping.'
            )

    for cp in OTHER_DEFAULT_IGNORABLE_RENDERABLE:
        if not is_renderable(cp):
            sys.exit(
                f'refusing to generate: U+{cp:04X} is '
                f'{unicodedata.category(chr(cp))} in Unicode {unicode_version}, so '
                'the allowlist already bars it and listing it as an '
                'other-default-ignorable is dead weight. Remove it.'
            )
        if cp in variation_selectors:
            sys.exit(
                f'refusing to generate: U+{cp:04X} is a variation selector, which '
                'is derived, not listed.'
            )

    default_ignorable = to_ranges(
        sorted([*OTHER_DEFAULT_IGNORABLE_RENDERABLE, *variation_selectors])
    )

    lines: list[str] = [
        f'''// GENERATED by scripts/generate-name-charset-table.py — DO NOT EDIT BY HAND.
//
// The Unicode character domain of a name, pinned as DATA (#task:2016), because a
// title is an address and four processes with four ICU revisions have to agree on
// which code points one may contain. Policy — which of these sets bars a name, and
// why — is `display-name-charset.ts`; this file only says what Unicode says.
//
// `packages/shared/tests/display-name-charset.test.ts` asserts the structural
// invariants every table here relies on (sorted, disjoint, non-adjacent) and that
// each barred set is actually a subset of the allowlist, so no entry is dead.

/**
 * The Unicode revision these tables were generated from, asserted at generation
 * against `scripts/unicode_pin.py` rather than read off the interpreter.
 *
 * Bumping it is a REVIEWED diff, not a free widening. Most of a new revision is
 * newly assigned code points, and every code point missing from these tables
 * fails closed until the tables are regenerated — but General_Category is not
 * frozen, and the hand-picked barred sets are a judgement about a moving target,
 * so a bump CAN change the verdict on an input that is legal today. That makes it
 * a reviewed DOMAIN migration: it decides which titles a NEW write may carry, and
 * it can leave stored rows grandfathered-invalid, so read the regenerated diff and
 * decide about those rows deliberately.
 *
 * What it does NOT do is move a stored key. `title_key` is NFC + full case fold,
 * and this table takes no part in that derivation; only a change to
 * {{@link UNICODE_CASE_FOLD_VERSION}} can require keys to be recomputed and the
 * integrity scan re-run.
 */
export const UNICODE_NAME_CHARSET_VERSION = '{unicode_version}';

/** How many code points {{@link NAME_RENDERABLE_RANGES}} admits. A total, not a
 *  bound: it makes the table's size a reviewed number, so a regeneration that
 *  dropped a plane shows up as a diff on one line. */
export const NAME_RENDERABLE_CODE_POINT_COUNT = {len(renderable)};
''',
    ]

    lines.extend(
        render_ranges(
            'NAME_RENDERABLE_RANGES',
            '''/**
 * General_Category ∈ {L*, M*, N*, P*, S*, Zs} — every code point that renders as
 * something a reader can see and retype.
 *
 * The ALLOWLIST, and the direction is the point: everything outside it is barred,
 * so `Cc`, `Cf`, `Cs`, `Co`, `Zl`, `Zp`, and both halves of `Cn` (unassigned and
 * the permanently-reserved noncharacters) need no rule of their own, and a code
 * point assigned by a Unicode revision newer than
 * {@link UNICODE_NAME_CHARSET_VERSION} is refused until this table is regenerated.
 */''',
            renderable_ranges,
        )
    )
    lines.extend(
        render_ranges(
            'NAME_DEFAULT_IGNORABLE_RANGES',
            '''/**
 * Default_Ignorable_Code_Point members that are renderable BY CATEGORY: the
 * variation selectors, and the fillers / joiners / inherent vowels that Unicode
 * classes as `Mn` or `Lo` while specifying that they render as nothing.
 *
 * Without these the allowlist would admit U+FE0F and U+3164, and two titles could
 * be pixel-identical while folding to different keys — one of them a name nobody
 * can retype.
 */''',
            default_ignorable,
        )
    )
    lines.extend(
        render_ranges(
            'NAME_ENCLOSING_MARK_RANGES',
            '''/** General_Category = Me. Renderable, but only ever as a ring around the
 *  PREVIOUS character — the keycap half of an emoji sequence. */''',
            enclosing_marks,
        )
    )
    lines.extend(
        render_ranges(
            'NAME_EMOJI_MODIFIER_RANGES',
            '''/** The skin-tone modifiers (`Emoji_Modifier`). Derived by name, asserted to be
 *  exactly five, and each one is `Sk` — visible alone, meaningless alone. */''',
            to_ranges(emoji_modifiers),
        )
    )
    lines.extend(
        render_ranges(
            'NAME_REGIONAL_INDICATOR_RANGES',
            '''/** The 26 regional indicator symbols. A pair is one flag on one platform and two
 *  boxed letters on another, which is why they are barred as sequence parts rather
 *  than as invisible characters. */''',
            to_ranges(regional_indicators),
        )
    )

    lines.append(
        '''/**
 * Whether `codePoint` falls in a table from this module.
 *
 * Binary search, which is what every table here is sorted, disjoint and
 * non-adjacent FOR. Total over the whole integer range: a caller iterating a
 * string never has to bounds-check first.
 */
export function inCodePointRanges(
  ranges: readonly (readonly [number, number])[],
  codePoint: number,
): boolean {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const [start, end] = ranges[mid]!;
    if (codePoint < start) {
      high = mid - 1;
      continue;
    }
    if (codePoint > end) {
      low = mid + 1;
      continue;
    }
    return true;
  }
  return false;
}'''
    )

    TABLE_PATH.write_text('\n'.join(lines) + '\n', encoding='utf-8')

    print(
        f'unicode {unicode_version}: {len(renderable)} renderable code points in '
        f'{len(renderable_ranges)} ranges; {len(default_ignorable)} '
        f'default-ignorable ranges, {len(enclosing_marks)} enclosing-mark ranges'
    )
    return 0


if __name__ == '__main__':
    sys.exit(main())
