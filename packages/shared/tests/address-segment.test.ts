// The address-segment codec (#task:2016), consumed by the target grammar in
// #task:2021.
//
// Two properties matter, and only the second one is about escaping:
//
//  1. ROUND TRIP — `decode(encode(title)) === title` for every legal title,
//     including the characters the codec exists for.
//  2. ONE SPELLING — a segment that is not in canonical form is REJECTED, not
//     decoded. `%2f` and `%41` are what a well-meaning client emits, and both
//     decode to something legal, which is exactly the problem: if two segments
//     decode to the same title then a title has two addresses, and the
//     uniqueness the whole ticket buys is handed back to whoever typed it.
import { describe, expect, it } from 'vitest';
import {
  ADDRESS_TOKEN_MAX_BYTES,
  CONVERSATION_TITLE_MAX_CODE_POINTS,
  addressTokenByteLength,
  decodeAddressSegment,
  encodeAddressSegment,
  parseConversationTitle,
} from '../src/index.js';

describe('address segment round trip (#task:2016)', () => {
  const TITLES: readonly (readonly [string, string, string])[] = [
    ['design', 'design', 'nothing to escape'],
    ['design review', 'design%20review', 'space — the header target is one unquoted token'],
    ['UI/UX 优化', 'UI%2FUX%20优化', 'slash — the structural separator; CJK stays raw'],
    ['100% done', '100%25%20done', 'percent — the escape must itself be escapable'],
    ['%2F', '%252F', 'a literal `%2F` must not decode like an escaped slash'],
    ['a/b c%d', 'a%2Fb%20c%25d', 'all three at once'],
    ['\u{1F680} launch', '\u{1F680}%20launch', 'a pictograph stays raw'],
    ['#2016', '#2016', 'a hash needs no escape — it is not a separator here'],
    ['thread:1', 'thread:1', 'a colon needs none either: `/thread:` cannot appear, the slash is escaped'],
    // The space separators are written as ESCAPES, never as the character itself: a
    // literal U+00A0 or U+2009 in this file is indistinguishable from a space to
    // every reviewer, and which space it is is the entire content of these rows.
    [
      '设计\u{3000}讨论',
      '设计%E3%80%80讨论',
      'U+3000 IDEOGRAPHIC SPACE — one IME keystroke, and whitespace to every reader',
    ],
    [
      'design\u{00A0}review',
      'design%C2%A0review',
      'U+00A0 NO-BREAK SPACE — what a paste from a rendered page carries',
    ],
    [
      'a\u{2009}b',
      'a%E2%80%89b',
      'U+2009 THIN SPACE — the whole Zs category is escaped, not a two-character allowlist',
    ],
  ];

  for (const [title, encoded, why] of TITLES) {
    it(`encodes ${JSON.stringify(title)} as ${JSON.stringify(encoded)} — ${why}`, () => {
      expect(encodeAddressSegment(title)).toBe(encoded);
      expect(decodeAddressSegment(encoded)).toBe(title);
    });
  }

  it('is injective over the corpus: no two titles share an encoding', () => {
    const encodings = TITLES.map(([title]) => encodeAddressSegment(title));
    expect(new Set(encodings).size).toBe(encodings.length);
  });

  /**
   * The property the escape set exists for, stated against the CARRIER rather than
   * against a list of characters: the message header spells `target=<token>`
   * unquoted, so an encoded segment must contain nothing that any reader's
   * whitespace class would split on. `\s` is JS's answer and the strictest of the
   * common ones — Python and Go split on the same set or a subset — so a segment
   * that survives it survives them.
   *
   * Judged over every title the DOMAIN admits rather than over the corpus above,
   * because the failure mode was precisely a legal character nobody had listed:
   * `Zs` is inside `NAME_RENDERABLE_RANGES` on purpose, so `设计　讨论` is storable
   * and used to emit a two-field header.
   */
  it('never emits whitespace, for any title the validator accepts', () => {
    const candidates = [
      'design review',
      '设计\u{3000}讨论',
      'design\u{00A0}review',
      'a\u{2009}b c d e f',
      'UI/UX 优化',
      '\u{1F680} launch',
    ];
    for (const candidate of candidates) {
      const parsed = parseConversationTitle(candidate);
      // Every one of these must be a LEGAL title, or the case proves nothing.
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      const encoded = encodeAddressSegment(parsed.value.title);
      expect(encoded).not.toMatch(/\s/u);
      expect(decodeAddressSegment(encoded)).toBe(parsed.value.title);
    }
  });
});

describe('address segment canonical form (#task:2016)', () => {
  const REFUSED: readonly (readonly [string, string])[] = [
    ['%2f', 'lowercase hex: a second spelling of the same slash'],
    ['%41', 'over-escaped `A`: legal percent-encoding, not canonical here'],
    ['%20%41', 'over-escape next to a legal escape'],
    ['%2', 'truncated escape'],
    ['%', 'a bare percent'],
    ['%GG', 'not hex at all'],
    ['%%20', 'percent followed by an escape'],
    ['a b', 'a RAW space: the token was never one token'],
    ['a\u{3000}b', 'a RAW ideographic space: same field-splitting hazard'],
    ['a\u{00A0}b', 'a RAW no-break space'],
    ['a/b', 'a RAW slash: the segment boundary was not respected'],
    ['%e3%80%80', 'lowercase hex in a multi-byte escape'],
    ['%E3%80', 'a truncated multi-byte escape'],
    ['%E3%80%80%80', 'a valid escape followed by a stray continuation byte'],
    ['%C3%A9', 'over-escaped `é`: a raw character the codec leaves alone'],
    ['', 'empty: no title normalizes to the empty string'],
  ];

  for (const [segment, why] of REFUSED) {
    it(`refuses ${JSON.stringify(segment)} — ${why}`, () => {
      expect(decodeAddressSegment(segment)).toBeNull();
    });
  }
});

describe('address token budget (#task:2016)', () => {
  // What a formatted token carries besides the two names, so the budget is judged
  // on the same string the header does.
  const ENVELOPE = '#';

  it('is measured in UTF-8 bytes, which a code-unit count under-counts by up to 3x', () => {
    // The defect this replaces: `.length` said a 128-character CJK title cost 128
    // and a 128-pictograph one 256, when the wire cost is 384 and 512.
    const cjk = '中'.repeat(CONVERSATION_TITLE_MAX_CODE_POINTS);
    const astral = '\u{1F680}'.repeat(CONVERSATION_TITLE_MAX_CODE_POINTS);
    expect(cjk.length).toBe(128);
    expect(addressTokenByteLength(cjk)).toBe(384);
    expect(astral.length).toBe(256);
    expect(addressTokenByteLength(astral)).toBe(512);
    // And ENCODING is a second multiplier on top of that, which is why the budget
    // is judged on the encoded form: an escape is ASCII, but it is one triplet PER
    // UTF-8 BYTE, so a `%` costs 3 and a U+3000 space costs 9 — 3x the 3x. The
    // worst case is therefore not the ASCII one.
    const escapedPercent = encodeAddressSegment(
      '%'.repeat(CONVERSATION_TITLE_MAX_CODE_POINTS),
    );
    expect(escapedPercent.length).toBe(384);
    expect(addressTokenByteLength(escapedPercent)).toBe(384);
    const escapedSpace = encodeAddressSegment(
      '\u{3000}'.repeat(CONVERSATION_TITLE_MAX_CODE_POINTS),
    );
    expect(escapedSpace.length).toBe(1152);
    expect(addressTokenByteLength(escapedSpace)).toBe(1152);
  });

  it('does not promise that every legal title fits: an astral title falls back', () => {
    // A legal title, refused by no validator, whose token cannot be spelled inside
    // the budget. The formatter's answer is `#conv:<id>` — permanent, total, and
    // the reason a name-shaped address is allowed to be unavailable.
    const token
      = `${ENVELOPE}team/`
      + encodeAddressSegment('\u{1F680}'.repeat(CONVERSATION_TITLE_MAX_CODE_POINTS));
    expect(addressTokenByteLength(token)).toBeGreaterThan(
      ADDRESS_TOKEN_MAX_BYTES,
    );
  });

  it('admits the names people actually type, envelope and thread suffix included', () => {
    const token
      = `${ENVELOPE}${encodeAddressSegment('silverhand 工作区')}`
      + `/${encodeAddressSegment('UI/UX 优化')}`
      + '/thread:lHtaFjNlIiZNGk_J';
    expect(addressTokenByteLength(token)).toBeLessThanOrEqual(
      ADDRESS_TOKEN_MAX_BYTES,
    );
  });
});
