// The pinned Unicode full case-folding table (#task:2016).
//
// `conversations.title_key` is `NFC(foldCase(NFC(trim(title))))`, stored and
// compared ACROSS PROCESSES (backend, renderer, CLI, packaged daemon), so the
// fold has to be a pure function of data we ship. That is the claim under test
// here, and it needs two independent witnesses, because the table and the
// canonicalizer come from the same author:
//
//  1. The exhaustive FIXTURE — every mapping, hex-only, emitted by
//     `scripts/generate-case-fold-table.py` straight from CPython's
//     `str.casefold()` before any run-length encoding. It proves the compressed
//     `[start, end, stride, delta]` runs are lossless over the whole Unicode
//     range, including the code points that fold to THEMSELVES: a stride bug
//     shows up as either a missing fold or an invented one.
//  2. The JS engine's OWN simple-fold oracle — regex `iu` canonicalization,
//     which is `scf` (simple case folding) applied by V8's tables, not ours. It
//     is a genuinely separate implementation of the same Unicode data, so a
//     transcription error in the generator's output cannot pass both.
//
// The oracle is asserted in ONE direction on purpose: every mapping we ship must
// agree with the engine, but the engine is allowed to fold code points we say
// nothing about. Unicode's stability policy only adds case mappings, never
// changes existing ones, so an engine carrying a NEWER revision than
// `UNICODE_CASE_FOLD_VERSION` legitimately knows more — and the whole point of
// pinning is that such an upgrade is a no-op for stored keys. Asserting the
// reverse direction would turn every Node/Electron bump into a red test about
// data that did not change.
import { describe, expect, it } from 'vitest';
import {
  UNICODE_CASE_FOLD_VERSION,
  foldCase,
  foldCodePoint,
} from '../src/index.js';
import fixture from './fixtures/unicode-case-fold.json' with { type: 'json' };

const MAX_CODE_POINT = 0x110000;
/** Enough mismatches to see the shape of a systematic error, few enough to read. */
const SAMPLE_LIMIT = 8;

/** `{ '00DF': '0073 0073' }` → `{ 0xDF: 'ss' }`. The fixture is hex-only so it
 *  is diffable without a Unicode-aware editor; this is the only place that
 *  decoding lives. */
const EXPECTED = new Map<number, string>(
  Object.entries(fixture.mappings).map(([source, target]) => [
    Number.parseInt(source, 16),
    target
      .split(' ')
      .map(hex => String.fromCodePoint(Number.parseInt(hex, 16)))
      .join(''),
  ]),
);

function hex(codePoint: number): string {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
}

/** The same string spelled as hex escapes — used for failure messages and test
 *  names, so a case involving a combining mark is readable in terminal output. */
function describeString(value: string): string {
  return Array.from(value)
    .map(character => hex(character.codePointAt(0)!))
    .join(' ');
}

describe('pinned Unicode case-fold table (#task:2016)', () => {
  it('records the same Unicode revision as the fixture it was generated with', () => {
    expect(UNICODE_CASE_FOLD_VERSION).toBe(fixture.unicodeVersion);
    expect(fixture.generator).toBe('scripts/generate-case-fold-table.py');
  });

  it('reproduces the fixture over EVERY code point, folded or not', () => {
    const mismatches: string[] = [];
    for (let codePoint = 0; codePoint < MAX_CODE_POINT; codePoint += 1) {
      const expected = EXPECTED.get(codePoint) ?? null;
      const actual = foldCodePoint(codePoint);
      if (actual !== expected) {
        mismatches.push(
          `${hex(codePoint)}: expected ${
            expected === null ? 'no fold' : describeString(expected)
          }, got ${actual === null ? 'no fold' : describeString(actual)}`,
        );
        if (mismatches.length > SAMPLE_LIMIT) break;
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('covers the mappings no lowercase mapping can express', () => {
    // Not a spot check of the table — a check that the fixture (hence the table)
    // contains the class that motivates full folding at all. `toLowerCase` leaves
    // every one of these unchanged, so a `toLowerCase`-derived table would pass
    // the test above with these rows simply absent.
    const expansions = [...EXPECTED].filter(
      ([, target]) => Array.from(target).length > 1,
    );
    expect(expansions.length).toBeGreaterThan(100);
    expect(EXPECTED.get(0x00df)).toBe('ss'); // LATIN SMALL LETTER SHARP S
    expect(EXPECTED.get(0x1e9e)).toBe('ss'); // LATIN CAPITAL LETTER SHARP S
  });

  it('agrees with the engine simple-fold oracle on every 1:1 mapping', () => {
    const disagreements: string[] = [];
    for (const [source, target] of EXPECTED) {
      if (Array.from(target).length !== 1) continue;
      // Regex `iu` canonicalization IS `scf`; our 1:1 half is CaseFolding status
      // `C` (common to simple and full), so the engine must agree. `\u{...}` in
      // the pattern keeps this free of metacharacter escaping.
      const oracle = new RegExp(
        `^\\u{${target.codePointAt(0)!.toString(16)}}$`,
        'iu',
      );
      if (!oracle.test(String.fromCodePoint(source))) {
        disagreements.push(`${hex(source)} -> ${describeString(target)}`);
        if (disagreements.length > SAMPLE_LIMIT) break;
      }
    }
    expect(disagreements).toEqual([]);
  });

  it('is idempotent: folding an already-folded value changes nothing', () => {
    const unstable: string[] = [];
    for (const target of EXPECTED.values()) {
      if (foldCase(target) !== target) unstable.push(describeString(target));
      if (unstable.length > SAMPLE_LIMIT) break;
    }
    expect(unstable).toEqual([]);
  });

  it('leaves code points that carry no case alone', () => {
    for (const codePoint of [
      0x0020, // SPACE
      0x0030, // DIGIT ZERO
      0x0061, // LATIN SMALL LETTER A
      0x4f60, // CJK UNIFIED IDEOGRAPH-4F60
      0x1f680, // ROCKET
      0xd800, // lone high surrogate
      0xe000, // private use
      0xfdd0, // noncharacter
      0x10ffff, // last code point, unassigned
    ]) {
      expect(foldCodePoint(codePoint)).toBeNull();
    }
  });
});

describe('foldCase (#task:2016)', () => {
  /**
   * The CaseFolding rulings ON THIS TICKET, spelled out by hand as an
   * independent statement of what the generated data must say.
   *
   * Every cased code point is written as a `\uXXXX` escape with its name: three
   * of these cases are exactly the ones a reviewer cannot check by eye — a
   * combining mark that renders on the previous letter, dotless vs dotted `i`,
   * and a KELVIN SIGN that is pixel-identical to `K`.
   */
  const CASES: readonly (readonly [string, string, string])[] = [
    ['\u00DF', 'ss', 'SHARP S expands — no lowercase mapping does that'],
    [
      '\u1E9E',
      'ss',
      'CAPITAL SHARP S reaches the same key as its small form',
    ],
    [
      '\u1E9B',
      '\u1E61',
      'LATIN SMALL LETTER LONG S WITH DOT ABOVE folds to S WITH DOT ABOVE, NOT to ss',
    ],
    ['\u03C2', '\u03C3', 'GREEK SMALL LETTER FINAL SIGMA folds to SIGMA'],
    ['\u03A3', '\u03C3', 'GREEK CAPITAL LETTER SIGMA reaches the same key'],
    [
      '\u0130',
      'i\u0307',
      'LATIN CAPITAL LETTER I WITH DOT ABOVE keeps its dot as a COMBINING mark',
    ],
    [
      '\u0131',
      '\u0131',
      'LATIN SMALL LETTER DOTLESS I is NOT folded to i — that is a Turkic rule',
    ],
    ['\u212A', 'k', 'KELVIN SIGN folds to plain k'],
    ['\u017F', 's', 'LATIN SMALL LETTER LONG S folds to plain s'],
    [
      '\u{10400}',
      '\u{10428}',
      'astral plane: DESERET CAPITAL LETTER LONG I',
    ],
    ['Design Review', 'design review', 'the ordinary case'],
    ['UI/UX 优化', 'ui/ux 优化', 'CJK is caseless and passes through'],
  ];

  for (const [input, expected, why] of CASES) {
    it(`folds ${describeString(input)} — ${why}`, () => {
      expect(foldCase(input)).toBe(expected);
    });
  }

  it('is total: an unpaired surrogate survives instead of throwing', () => {
    // A fold is a normalization, not a validation. Rejecting ill-formed input is
    // the title validator's job, and it must be able to run AFTER this.
    expect(foldCase('a\uD800b')).toBe('a\uD800b');
  });

  it('is idempotent over the whole corpus', () => {
    for (const [input] of CASES) {
      const once = foldCase(input);
      expect(foldCase(once)).toBe(once);
    }
  });
});
