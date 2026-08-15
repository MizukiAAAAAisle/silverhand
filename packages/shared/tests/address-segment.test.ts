// The address-segment codec (#task:2016), consumed by the target grammar in
// #task:2021.
//
// Two properties matter, and only the second one is about escaping:
//
//  1. ROUND TRIP — `decode(encode(title)) === title` for every legal title,
//     including the three characters the codec exists for.
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
    ['a/b', 'a RAW slash: the segment boundary was not respected'],
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
  const ENVELOPE = 'silverhand://conversation/';

  it('is measured in UTF-8 bytes, which a code-unit count under-counts by up to 3x', () => {
    // The defect this replaces: `.length` said a 128-character CJK title cost 128
    // and a 128-pictograph one 256, when the wire cost is 384 and 512.
    const cjk = '中'.repeat(CONVERSATION_TITLE_MAX_CODE_POINTS);
    const astral = '\u{1F680}'.repeat(CONVERSATION_TITLE_MAX_CODE_POINTS);
    expect(cjk.length).toBe(128);
    expect(addressTokenByteLength(cjk)).toBe(384);
    expect(astral.length).toBe(256);
    expect(addressTokenByteLength(astral)).toBe(512);
    // Escaping is ASCII, so the escapable worst case is the cheaper one per
    // character and still the longest in code units — which is exactly why the two
    // measures cannot be used interchangeably.
    const escaped = encodeAddressSegment(
      '%'.repeat(CONVERSATION_TITLE_MAX_CODE_POINTS),
    );
    expect(escaped.length).toBe(384);
    expect(addressTokenByteLength(escaped)).toBe(384);
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
