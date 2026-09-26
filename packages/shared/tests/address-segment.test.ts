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
  TARGET_SEGMENT_CODEC,
  URI_SEGMENT_CODEC,
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
    [
      'thread:1',
      'thread:1',
      'a colon needs none either: `/thread:` cannot appear, the slash is escaped',
    ],
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
      expect(TARGET_SEGMENT_CODEC.encode(title)).toBe(encoded);
      expect(TARGET_SEGMENT_CODEC.decode(encoded)).toBe(title);
    });
  }

  it('is injective over the corpus: no two titles share an encoding', () => {
    const encodings = TITLES.map(([title]) => TARGET_SEGMENT_CODEC.encode(title));
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
      const encoded = TARGET_SEGMENT_CODEC.encode(parsed.value.title);
      expect(encoded).not.toMatch(/\s/u);
      expect(TARGET_SEGMENT_CODEC.decode(encoded)).toBe(parsed.value.title);
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
      expect(TARGET_SEGMENT_CODEC.decode(segment)).toBeNull();
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
    const escapedPercent = TARGET_SEGMENT_CODEC.encode(
      '%'.repeat(CONVERSATION_TITLE_MAX_CODE_POINTS),
    );
    expect(escapedPercent.length).toBe(384);
    expect(addressTokenByteLength(escapedPercent)).toBe(384);
    const escapedSpace = TARGET_SEGMENT_CODEC.encode(
      '\u{3000}'.repeat(CONVERSATION_TITLE_MAX_CODE_POINTS),
    );
    expect(escapedSpace.length).toBe(1152);
    expect(addressTokenByteLength(escapedSpace)).toBe(1152);
  });

  it('does not promise that every legal title fits: an astral title falls back', () => {
    // A legal title, refused by no validator, whose token cannot be spelled inside
    // the budget. The formatter's answer is `#conv:<id>` — permanent, total, and
    // the reason a name-shaped address is allowed to be unavailable.
    const token =
      `${ENVELOPE}team/` +
      TARGET_SEGMENT_CODEC.encode('\u{1F680}'.repeat(CONVERSATION_TITLE_MAX_CODE_POINTS));
    expect(addressTokenByteLength(token)).toBeGreaterThan(ADDRESS_TOKEN_MAX_BYTES);
  });

  it('admits the names people actually type, envelope and thread suffix included', () => {
    const token =
      `${ENVELOPE}${TARGET_SEGMENT_CODEC.encode('silverhand 工作区')}` +
      `/${TARGET_SEGMENT_CODEC.encode('UI/UX 优化')}` +
      '/thread:lHtaFjNlIiZNGk_J';
    expect(addressTokenByteLength(token)).toBeLessThanOrEqual(ADDRESS_TOKEN_MAX_BYTES);
  });
});

/**
 * The two carriers (#task:2119).
 *
 * The escape SETS nest — the URI set is the target set plus four characters — and
 * the accept sets deliberately DO NOT. Each carrier accepts exactly one of the two
 * spellings of a differing character, and which one is opposite in the two
 * carriers. This matters because both spellings decode to the same visible name, so
 * an accept set that was a superset would give one name two addresses in that
 * carrier and nothing would look wrong anywhere.
 *
 * All four differing characters are LEGAL IN A NAME (`NAME_RENDERABLE_RANGES`
 * admits `P*` and `S*`), so every cell below is reachable by a user naming a
 * channel — none of them is a hypothetical.
 */
describe('segment carriers (#task:2119)', () => {
  const DIFFERING: readonly (readonly [string, string, string])[] = [
    ['<', '%3C', 'terminates the CommonMark autolink the locator travels inside'],
    ['>', '%3E', 'terminates it from the other side'],
    ['#', '%23', 'the fragment delimiter: a URL parser cuts the href here'],
    ['?', '%3F', 'the query delimiter: the same cut'],
  ];

  for (const [raw, escaped, why] of DIFFERING) {
    it(`${JSON.stringify(raw)} — ${why}`, () => {
      // target: raw is the canonical spelling, and the escape is unknown there.
      expect(TARGET_SEGMENT_CODEC.encode(raw)).toBe(raw);
      expect(TARGET_SEGMENT_CODEC.decode(raw)).toBe(raw);
      expect(TARGET_SEGMENT_CODEC.decode(escaped)).toBeNull();
      // uri: exactly the other way round.
      expect(URI_SEGMENT_CODEC.encode(raw)).toBe(escaped);
      expect(URI_SEGMENT_CODEC.decode(escaped)).toBe(raw);
      expect(URI_SEGMENT_CODEC.decode(raw)).toBeNull();
    });
  }

  it('agrees on every shared member, so the carriers differ ONLY in those four', () => {
    const shared = ['%', '/', ' ', '\u{3000}', '\u{00A0}'];
    for (const character of shared) {
      const encoded = TARGET_SEGMENT_CODEC.encode(character);
      expect(URI_SEGMENT_CODEC.encode(character)).toBe(encoded);
      expect(URI_SEGMENT_CODEC.decode(encoded)).toBe(character);
      expect(URI_SEGMENT_CODEC.decode(character)).toBeNull();
    }
  });

  it('keeps CJK, pictographs and the rest raw in both carriers', () => {
    for (const value of ['UI优化', '\u{1F680}', 'thread:1', 'a@b:c[d]', 'é']) {
      expect(TARGET_SEGMENT_CODEC.encode(value)).toBe(value);
      expect(URI_SEGMENT_CODEC.encode(value)).toBe(value);
      expect(URI_SEGMENT_CODEC.decode(value)).toBe(value);
    }
  });

  it('refuses a non-canonical escape in the URI carrier too', () => {
    for (const segment of ['%3c', '%2f', '%41', '%', '%2', '%C3%A9']) {
      expect(URI_SEGMENT_CODEC.decode(segment)).toBeNull();
    }
  });
});
