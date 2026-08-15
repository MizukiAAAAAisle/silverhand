// Percent-escaping for ONE SEGMENT of a name-shaped address (#task:2016).
//
// An address token spells a coordinate out of names a person typed:
// `silverhand://conversation/<workspace>/<title>`, optionally plus
// `/thread:<id>`. `/` is the STRUCTURAL separator and stays raw; three characters
// inside a segment must be escaped, and each one is load-bearing:
//
//   - `/` → `%2F`. Unescaped, a title containing a slash makes the segment
//     boundary ambiguous.
//   - `%` → `%25`. Unescaped, a literal `%2F` typed into a title decodes exactly
//     like an escaped slash — the escape mechanism has to be escapable or it is
//     not a codec.
//   - space → `%20`. Unescaped, the token stops being a single token: the message
//     header spells `target=<token>` UNQUOTED, so a raw space re-creates the
//     un-splittable coordinate that absolute targets exist to eliminate. This is
//     the one that looks optional and is not.
//
// Everything else stays RAW, CJK and pictographs included: escaping them would
// make the common case unreadable in a header a person has to be able to skim,
// and none of them is a separator in any grammar we parse. Non-ASCII whitespace
// (U+00A0, U+3000) is therefore raw too — it is not a separator anywhere, so the
// token stays one token; that it can look like a space is the same confusable
// class as Cyrillic `а` vs Latin `a`, ruled out of scope on this ticket.
//
// The parser accepts ONLY the canonical spelling. Lowercase hex (`%2f`),
// over-escaping (`%41` for `A`), and `%` followed by anything else are all
// rejected rather than decoded, because a segment with two legal spellings hands
// round-trip uniqueness back to whoever typed it — and uniqueness of the decoded
// title is exactly what the address depends on.

/** The three escapes, canonical spelling. Uppercase hex, and this map is the only
 *  place either direction is written down. */
const ESCAPES: ReadonlyMap<string, string> = new Map([
  [' ', '%20'],
  ['%', '%25'],
  ['/', '%2F'],
]);

const UNESCAPES: ReadonlyMap<string, string> = new Map(
  [...ESCAPES].map(([raw, escaped]) => [escaped, raw]),
);

/**
 * Total budget for a whole formatted address token — scheme, workspace segment,
 * channel segment, and the optional `/thread:<id>` suffix together, measured on
 * the ENCODED form in UTF-8 BYTES.
 *
 * Two decisions, both load-bearing:
 *
 *   - ONE constant for the WHOLE token, not a per-segment cap. A per-segment cap
 *     lets two legal segments compose into an oversized token, which is the thing
 *     a budget is for; and the token is what goes into a message header, so the
 *     token is what has to fit.
 *   - UTF-8 BYTES, not `String.length`. A code-unit count is not the wire: a
 *     Chinese title costs 3 bytes per character and a pictograph 4, so a budget
 *     judged on `.length` under-counts by up to 3x exactly where names are longest
 *     — a CJK-named channel would be measured as fitting and then be truncated by
 *     whatever actually carries the header.
 *
 * A LEGAL TITLE IS NOT PROMISED TO FIT. The domain stays 1..128 code points and
 * nothing here refuses a title for encoding long; a title of 128 pictographs is
 * 512 bytes on its own, so it exceeds this budget and the formatter falls back
 * TOTALLY to `#conv:<id>`, which is a permanent form. That is the whole reason the
 * fallback is permanent — the alternative would be shortening what a user may call
 * a channel to fit a transport.
 */
export const ADDRESS_TOKEN_MAX_BYTES = 512;

const encoder = new TextEncoder();

/**
 * The wire size of a formatted address token — the ONE measure the budget is
 * judged on, so no caller re-derives it with `.length`.
 *
 * `TextEncoder`, not Node's `Buffer`: this module is imported by the renderer.
 */
export function addressTokenByteLength(token: string): number {
  return encoder.encode(token).length;
}

/**
 * Escape one segment. Total: every string has exactly one encoding.
 *
 * Single pass, so the ordering hazard does not exist — escaping `/` first and
 * `%` second would re-escape the `%` of the `%2F` it just produced.
 */
export function encodeAddressSegment(value: string): string {
  return value.replace(/[%/ ]/g, character => ESCAPES.get(character)!);
}

/**
 * Decode one segment, or `null` if it is not in canonical form.
 *
 * `null` rather than a best-effort decode: a non-canonical spelling is not a
 * coordinate with a typo, it is a second spelling of a coordinate, and accepting
 * it would mean one title has more than one address. An empty segment is also
 * `null` — no title normalizes to the empty string.
 */
export function decodeAddressSegment(segment: string): string | null {
  if (segment.length === 0) return null;
  let out = '';
  let index = 0;
  while (index < segment.length) {
    const character = segment[index]!;
    if (character === '%') {
      const raw = UNESCAPES.get(segment.slice(index, index + 3));
      if (raw === undefined) return null;
      out += raw;
      index += 3;
      continue;
    }
    // A raw separator inside a segment means the token was never split
    // correctly, or was assembled without the codec. Either way it is not this
    // segment's content.
    if (character === '/' || character === ' ') return null;
    out += character;
    index += 1;
  }
  return out;
}
