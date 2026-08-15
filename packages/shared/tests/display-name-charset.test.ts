// The name character domain (#task:2016), which is the same question for a
// conversation title and a workspace name: which code points may a name contain?
//
// Three properties are asserted here, and the third is the one that keeps the
// answer stable across processes:
//
//  1. STRUCTURE — every pinned table is sorted, disjoint and non-adjacent, which
//     is what `inCodePointRanges`' binary search assumes and what makes a
//     regenerated table diffable. The renderable table's size is a reviewed
//     constant, so a regeneration that lost a plane shows up on one line.
//  2. VERDICTS — a corpus of named code points, each with a fixed expected class.
//     Whole scripts are not enumerated; what is enumerated is every boundary the
//     ticket argued about.
//  3. NO ENGINE PROPERTIES — the modules that decide a name's domain contain no
//     `\p{…}` class at all. Without this the first two are green while the actual
//     verdict comes from whichever ICU the process carries, which is the entire
//     defect this design exists to remove (#task:2016).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  INVISIBLE_CODE_POINTS,
  NAME_DEFAULT_IGNORABLE_RANGES,
  NAME_EMOJI_MODIFIER_RANGES,
  NAME_ENCLOSING_MARK_RANGES,
  NAME_REGIONAL_INDICATOR_RANGES,
  NAME_RENDERABLE_CODE_POINT_COUNT,
  NAME_RENDERABLE_RANGES,
  SEQUENCE_FORMING_EMOJI_PARTS,
  UNICODE_NAME_CHARSET_VERSION,
  findForbiddenCodePoint,
  inCodePointRanges,
} from '../src/index.js';

const SHARED_SRC = join(dirname(fileURLToPath(import.meta.url)), '../src');

const TABLES: readonly (readonly [
  string,
  readonly (readonly [number, number])[],
])[] = [
  ['NAME_RENDERABLE_RANGES', NAME_RENDERABLE_RANGES],
  ['NAME_DEFAULT_IGNORABLE_RANGES', NAME_DEFAULT_IGNORABLE_RANGES],
  ['NAME_ENCLOSING_MARK_RANGES', NAME_ENCLOSING_MARK_RANGES],
  ['NAME_EMOJI_MODIFIER_RANGES', NAME_EMOJI_MODIFIER_RANGES],
  ['NAME_REGIONAL_INDICATOR_RANGES', NAME_REGIONAL_INDICATOR_RANGES],
];

describe('pinned charset tables (#task:2016)', () => {
  it('is generated from the reviewed Unicode revision', () => {
    // Matches `EXPECTED_UNICODE_VERSION` in `scripts/unicode_pin.py`, which the
    // generators assert before writing. A bump lands here as a deliberate diff.
    expect(UNICODE_NAME_CHARSET_VERSION).toBe('16.0.0');
  });

  for (const [name, ranges] of TABLES) {
    it(`${name} is sorted, disjoint and non-adjacent`, () => {
      expect(ranges.length).toBeGreaterThan(0);
      let previousEnd = -2;
      for (const [start, end] of ranges) {
        expect(start).toBeLessThanOrEqual(end);
        // `> previousEnd + 1`, not `>`: two adjacent ranges are a table that was
        // not collapsed, and the point of asserting canonical form is that the
        // same Unicode data always produces the same bytes.
        expect(start).toBeGreaterThan(previousEnd + 1);
        previousEnd = end;
      }
      expect(previousEnd).toBeLessThan(0x110000);
    });
  }

  it('admits exactly the reviewed number of code points', () => {
    const total = NAME_RENDERABLE_RANGES.reduce(
      (sum, [start, end]) => sum + (end - start + 1),
      0,
    );
    expect(total).toBe(NAME_RENDERABLE_CODE_POINT_COUNT);
  });

  it('bars only code points the allowlist would otherwise admit', () => {
    // A barred set outside the allowlist is dead weight, and dead weight is how a
    // rule comes to look enforced while the thing it names has moved. Every
    // exclusion has to be doing work.
    for (const [name, ranges] of TABLES.slice(1)) {
      for (const [start, end] of ranges) {
        for (const codePoint of [start, end]) {
          expect(
            inCodePointRanges(NAME_RENDERABLE_RANGES, codePoint),
            `${name} bars U+${codePoint.toString(16).toUpperCase()}, which the allowlist already refuses`,
          ).toBe(true);
        }
      }
    }
  });
});

describe('name code point verdicts (#task:2016)', () => {
  const ALLOWED: readonly (readonly [number, string])[] = [
    [0x0041, 'LATIN CAPITAL LETTER A'],
    [0x0031, 'DIGIT ONE — `\\p{Emoji}` matches it, which is why that property is banned'],
    [0x0023, 'NUMBER SIGN — `#2016` is a legal title'],
    [0x002a, 'ASTERISK — also `\\p{Emoji}`'],
    [0x0025, 'PERCENT SIGN — escaped by the codec, not refused by the validator'],
    [0x002f, 'SOLIDUS — same'],
    [0x0020, 'SPACE — legal inside a title; only the edges are trimmed'],
    [0x00a0, 'NO-BREAK SPACE — Zs, and a confusable, which is out of scope'],
    [0x3000, 'IDEOGRAPHIC SPACE — Zs'],
    [0x00e9, 'LATIN SMALL LETTER E WITH ACUTE'],
    [0x0301, 'COMBINING ACUTE ACCENT — Mn, the decomposed half of the same title'],
    [0x4e2d, 'CJK IDEOGRAPH 中'],
    [0x1f680, 'ROCKET — a single-code-point pictograph is legal'],
    [0x2705, 'WHITE HEAVY CHECK MARK'],
    [0x2764, 'HEAVY BLACK HEART — legal ALONE; U+FE0F is what makes it reject'],
  ];

  const INVISIBLE: readonly (readonly [number, string])[] = [
    [0x0000, 'NULL'],
    [0x0007, 'BELL — a raw control byte'],
    [0x007f, 'DELETE'],
    [0x00ad, 'SOFT HYPHEN'],
    [0x061c, 'ARABIC LETTER MARK'],
    [0x180e, 'MONGOLIAN VOWEL SEPARATOR'],
    [0x200b, 'ZERO WIDTH SPACE'],
    [0x200c, 'ZERO WIDTH NON-JOINER — the named cost: Persian and Indic titles'],
    [0x200d, 'ZERO WIDTH JOINER — so every ZWJ emoji sequence is out of domain'],
    [0x200e, 'LEFT-TO-RIGHT MARK'],
    [0x202e, 'RIGHT-TO-LEFT OVERRIDE — the spoofing vector'],
    [0x2066, 'LEFT-TO-RIGHT ISOLATE'],
    [0x2028, 'LINE SEPARATOR — Zl'],
    [0x2029, 'PARAGRAPH SEPARATOR — Zp'],
    [0xfeff, 'ZERO WIDTH NO-BREAK SPACE / BOM'],
    [0xd800, 'a lone surrogate — Cs, ill-formed text that survives JSON'],
    [0xe000, 'private use — Co, the glyph is whatever the font vendor chose'],
    [0xfdd0, 'a noncharacter — permanently reserved'],
    [0xfffe, 'a noncharacter, the byte-order-mark twin'],
    [0x10ffff, 'the last code point, also a noncharacter'],
    [0x0378, 'UNASSIGNED in Unicode 16 — barred by ALLOWLISTING, not by `\\p{Cn}`'],
    [0x0e00, 'also unassigned: a gap inside an assigned block'],
    [0xfe0f, 'VARIATION SELECTOR-16'],
    [0xfe0e, 'VARIATION SELECTOR-15'],
    [0x180b, 'MONGOLIAN FREE VARIATION SELECTOR ONE — Mn, so category cannot see it'],
    [0xe0100, 'VARIATION SELECTOR-17'],
    [0x034f, 'COMBINING GRAPHEME JOINER'],
    [0x115f, 'HANGUL CHOSEONG FILLER — Lo, and renders as nothing'],
    [0x1160, 'HANGUL JUNGSEONG FILLER'],
    [0x3164, 'HANGUL FILLER'],
    [0xffa0, 'HALFWIDTH HANGUL FILLER'],
    [0x17b4, 'KHMER VOWEL INHERENT AQ'],
    [0x17b5, 'KHMER VOWEL INHERENT AA'],
  ];

  const SEQUENCE_FORMING: readonly (readonly [number, string])[] = [
    [0x1f3fb, 'EMOJI MODIFIER FITZPATRICK TYPE-1-2'],
    [0x1f3ff, 'EMOJI MODIFIER FITZPATRICK TYPE-6'],
    [0x20e3, 'COMBINING ENCLOSING KEYCAP — Me'],
    [0x1f1e6, 'REGIONAL INDICATOR SYMBOL LETTER A'],
    [0x1f1ff, 'REGIONAL INDICATOR SYMBOL LETTER Z'],
  ];

  for (const [codePoint, why] of ALLOWED) {
    it(`admits U+${codePoint.toString(16).toUpperCase().padStart(4, '0')} — ${why}`, () => {
      const value = String.fromCodePoint(codePoint);
      expect(
        findForbiddenCodePoint(value, [
          INVISIBLE_CODE_POINTS,
          SEQUENCE_FORMING_EMOJI_PARTS,
        ]),
      ).toBeNull();
    });
  }

  for (const [codePoint, why] of INVISIBLE) {
    it(`bars U+${codePoint.toString(16).toUpperCase().padStart(4, '0')} as invisible — ${why}`, () => {
      expect(INVISIBLE_CODE_POINTS.includes(codePoint)).toBe(true);
      // Not sequence-forming: the two classes are consumed separately (a workspace
      // name bars only the first), so overlap would silently widen one surface.
      expect(SEQUENCE_FORMING_EMOJI_PARTS.includes(codePoint)).toBe(false);
    });
  }

  for (const [codePoint, why] of SEQUENCE_FORMING) {
    it(`bars U+${codePoint.toString(16).toUpperCase().padStart(4, '0')} as a sequence part — ${why}`, () => {
      expect(SEQUENCE_FORMING_EMOJI_PARTS.includes(codePoint)).toBe(true);
      expect(INVISIBLE_CODE_POINTS.includes(codePoint)).toBe(false);
    });
  }

  it('reports the offender by CODE POINT index, counting an astral character once', () => {
    // `🚀` is two UTF-16 units; a caller that reports `.indexOf` would name
    // position 3 for a character a person would count as the third.
    const found = findForbiddenCodePoint('\u{1F680}a\u200B', [
      INVISIBLE_CODE_POINTS,
    ]);
    expect(found).toEqual({ codePoint: 0x200b, index: 2 });
  });
});

describe('no engine Unicode properties in the name domain (#task:2016)', () => {
  // The regex-class ban is the whole reason the tables above exist, and it is not
  // provable from behaviour: `\p{Cf}` and the pinned data agree today on this
  // machine's ICU. So it is asserted on the SOURCE.
  const NAME_DOMAIN_SOURCES = [
    'display-name-charset.ts',
    'conversation-title.ts',
    'unicode-name-charset.ts',
    'api/name.ts',
  ] as const;

  const stripComments = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

  for (const relative of NAME_DOMAIN_SOURCES) {
    it(`${relative} decides nothing with a \\p{…} class`, () => {
      const code = stripComments(
        readFileSync(join(SHARED_SRC, relative), 'utf8'),
      );
      expect(code).not.toMatch(/\\p\{/);
    });
  }

  it('strips comments without stripping code, so the scan is not vacuously green', () => {
    const code = stripComments(
      readFileSync(join(SHARED_SRC, 'display-name-charset.ts'), 'utf8'),
    );
    // The docblocks DO mention `\p{Emoji}` and `\p{Cn}`; if the stripper failed,
    // the assertions above would be red rather than falsely green — this pins the
    // other direction, that it did not strip the declarations too.
    expect(code).toContain('export const INVISIBLE_CODE_POINTS');
    expect(code).toContain('export const SEQUENCE_FORMING_EMOJI_PARTS');
    expect(code).not.toContain('NEVER `\\p{Emoji}`');
  });
});
