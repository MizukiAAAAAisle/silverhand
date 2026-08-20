// Percent-escaping for ONE SEGMENT of a name-shaped address (#task:2016).
//
// An address token spells a coordinate out of names a person typed:
// `#<workspace>/<title>`, optionally plus `/thread:<id>`. `/` is the STRUCTURAL separator and stays raw; three KINDS of
// character inside a segment must be escaped, and each one is load-bearing:
//
//   - `/` → `%2F`. Unescaped, a title containing a slash makes the segment
//     boundary ambiguous.
//   - `%` → `%25`. Unescaped, a literal `%2F` typed into a title decodes exactly
//     like an escaped slash — the escape mechanism has to be escapable or it is
//     not a codec.
//   - EVERY SPACE SEPARATOR — ASCII space plus the rest of Unicode `Zs`
//     ({@link SPACE_SEPARATOR_RANGES}) → its UTF-8 bytes, percent-encoded.
//     Unescaped, the token stops being a single token: the message header spells
//     `target=<token>` UNQUOTED, so any space re-creates the un-splittable
//     coordinate that absolute targets exist to eliminate. This is the one that
//     looks optional and is not.
//
// THE SPACE RULE IS THE WHOLE CATEGORY, not the ASCII member of it, because the
// readers are not JS: `\s`, `split()` and `strip()` in JS, Python, Go and every
// shell-adjacent tokenizer treat U+00A0 and U+3000 as whitespace, so a channel
// named `设计　讨论` with a full-width space — one keystroke on any CJK IME, and
// legal in a title (`Zs` is inside `NAME_RENDERABLE_RANGES` on purpose) — would
// emit a `target=` field that its reader splits in two and then cannot resolve.
// Escaping ASCII space alone would make the header's "one whitespace-free token"
// promise false for exactly the users this product is being dogfooded by.
//
// Everything else stays RAW, CJK and pictographs included: escaping them would
// make the common case unreadable in a header a person has to be able to skim,
// and none of them is a separator in any grammar we parse.
//
// The parser accepts ONLY the canonical spelling. Lowercase hex (`%2f`),
// over-escaping (`%41` for `A`), and `%` followed by anything else are all
// rejected rather than decoded, because a segment with two legal spellings hands
// round-trip uniqueness back to whoever typed it — and uniqueness of the decoded
// title is exactly what the address depends on.
//
// TWO CARRIERS, ONE ALGORITHM (#task:2119). The same names also travel inside a
// prose URI — `<silverhand://workspace/<name>/<channel>>` — and that carrier has
// structural characters the header does not. It gets its own escape set
// ({@link URI_SEGMENT_CODEC}) rather than its own codec: the algorithm, the
// canonical-only rule and the "escape set is the map's key set" property are the
// parts that must not be written twice.
//
// THE TWO ACCEPT SETS MUST NOT NEST, even though the escape sets do. `#` is a
// legal name character in both carriers, and each carrier accepts exactly one of
// its two spellings: raw `#` under `target` (`%23` is an unknown escape there) and
// `%23` under `uri` (raw `#` is a raw member of that escape set). Letting either
// decoder also accept the other's spelling would give one name two addresses in
// that carrier — and SILENTLY, because both spellings decode to the same visible
// characters. What makes non-nesting structural rather than maintained is that no
// accept table is written at all: every name-level parser (see
// `parseConversationAddressSegment`) re-encodes and demands byte equality with its
// input, so each carrier's accept set is by construction the IMAGE of its own
// `encode`.

const encoder = new TextEncoder();

/**
 * Unicode `Zs` — the code points that render as horizontal space and are legal in
 * a name. PINNED DATA, for the reason `display-name-charset.ts` gives at length: a
 * runtime `\p{Zs}` would make the escape set depend on whichever ICU revision the
 * backend, the renderer, the CLI or a packaged daemon happens to carry, and an
 * escape set that differs between two processes is a coordinate one of them cannot
 * spell.
 *
 * `Zs` and not "everything `\s` matches": the other members of that class are
 * already impossible in a name — `Cc` controls, `Zl`/`Zp` and the `Cf` BOM all sit
 * outside `NAME_RENDERABLE_RANGES` — so escaping them would be dead data. U+180E
 * is likewise absent: it left `Zs` in Unicode 6.3 and is barred as `Cf`.
 */
const SPACE_SEPARATOR_RANGES: readonly (readonly [number, number])[] = [
  [0x0020, 0x0020],
  [0x00a0, 0x00a0],
  [0x1680, 0x1680],
  [0x2000, 0x200a],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
  [0x3000, 0x3000],
];

/** UTF-8 bytes as canonical uppercase `%XX` triplets — one triplet for an ASCII
 *  character, three for U+3000. The ONE spelling of an escape. */
function percentEncode(character: string): string {
  return [...encoder.encode(character)]
    .map(byte => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`)
    .join('');
}

/** The escape set, DERIVED from the rule above rather than transcribed: the two
 *  structural characters and every space separator. Both directions are built from
 *  this one map, so `encode` and `decode` cannot disagree about a member. */
function buildEscapes(extra: readonly string[]): ReadonlyMap<string, string> {
  return new Map(
    [
      '%',
      '/',
      ...SPACE_SEPARATOR_RANGES.flatMap(([first, last]) => {
        const characters: string[] = [];
        for (let point = first; point <= last; point += 1) {
          characters.push(String.fromCodePoint(point));
        }
        return characters;
      }),
      ...extra,
    ].map(character => [character, percentEncode(character)]),
  );
}

/**
 * One segment codec: an escape set plus the total encode/decode pair over it.
 *
 * A VALUE rather than four free functions, because the carrier is a choice the
 * call site has to make visibly. A default would silently emit header bytes into a
 * URI (or the reverse), and that failure is undetectable at the call site — both
 * spellings decode to the same name, just not in the other carrier.
 */
export interface SegmentCodec {
  /** The characters this carrier escapes. Exposed for tests and for docs that
   *  must enumerate it; the codec itself never consults anything else. */
  readonly escaped: ReadonlySet<string>;
  /**
   * Escape one segment. Total: every string has exactly one encoding.
   *
   * Iterates CODE POINTS rather than replacing over a character class, so an
   * astral character is never cut in half and the escape set stays the map's key
   * set — one place to read what is escaped. Single pass, so the ordering hazard
   * does not exist: escaping `/` first and `%` second would re-escape the `%` of
   * the `%2F` it just produced.
   */
  encode(value: string): string;
  /**
   * Decode one segment, or `null` if it is not in canonical form FOR THIS
   * CARRIER.
   *
   * `null` rather than a best-effort decode: a non-canonical spelling is not a
   * coordinate with a typo, it is a second spelling of a coordinate, and accepting
   * it would mean one title has more than one address. An empty segment is also
   * `null` — no title normalizes to the empty string.
   *
   * LONGEST MATCH FIRST, because an escape is 3, 6 or 9 characters. That is a
   * total rule and not a heuristic: no escape is a prefix of another (every
   * multi-triplet escape starts with a UTF-8 lead byte ≥ `%C2`, which is not
   * itself a member), so exactly one length can match at any position.
   */
  decode(segment: string): string | null;
}

function buildSegmentCodec(extra: readonly string[]): SegmentCodec {
  const escapes = buildEscapes(extra);
  const unescapes: ReadonlyMap<string, string> = new Map(
    [...escapes].map(([raw, escaped]) => [escaped, raw]),
  );
  /** Escape lengths are 3 (ASCII), 6 or 9 (a 3-byte space separator) characters, so
   *  the decoder tries the longest first. Derived, so adding a member to the set
   *  cannot leave the decoder scanning too short a window. */
  const maxEscapeLength = Math.max(
    ...[...escapes.values()].map(escape => escape.length),
  );

  function matchEscape(
    segment: string,
    index: number,
  ): { raw: string; length: number } | null {
    for (let length = maxEscapeLength; length >= 3; length -= 3) {
      const raw = unescapes.get(segment.slice(index, index + length));
      if (raw !== undefined) return { raw, length };
    }
    return null;
  }

  return {
    escaped: new Set(escapes.keys()),
    encode(value) {
      let out = '';
      for (const character of value) out += escapes.get(character) ?? character;
      return out;
    },
    decode(segment) {
      if (segment.length === 0) return null;
      let out = '';
      let index = 0;
      while (index < segment.length) {
        const character = segment[index]!;
        if (character === '%') {
          const escape = matchEscape(segment, index);
          if (escape === null) return null;
          out += escape.raw;
          index += escape.length;
          continue;
        }
        // A raw member of the escape set inside a segment means the token was never
        // split correctly, or was assembled without the codec. Either way it is not
        // this segment's content — and a raw space would already have ended the field
        // it travelled in.
        if (escapes.has(character)) return null;
        out += character;
        index += 1;
      }
      return out;
    },
  };
}

/**
 * The carrier of `#<workspace>/<title>[/thread:<id>]` — the CLI `target=` value and
 * the message header. Its escape set and canonical bytes are a PUBLISHED contract
 * (agents already spell targets by hand), so adding a member here is a wire break;
 * the URI carrier exists precisely so that #task:2119 did not have to.
 */
export const TARGET_SEGMENT_CODEC: SegmentCodec = buildSegmentCodec([]);

/**
 * The carrier of a prose locator segment — `silverhand://workspace/<name>/<channel>`
 * written as a CommonMark autolink (#task:2119).
 *
 * FOUR MEMBERS BEYOND THE TARGET SET, and the criterion that yields exactly those
 * four: a character belongs here when it either (a) terminates or splits the
 * CommonMark autolink the destination travels inside, or (b) is a URI generic-syntax
 * delimiter that a third-party URL parser would strip into a component this grammar
 * does not have. All four are legal in a name (`NAME_RENDERABLE_RANGES` admits `P*`
 * and `S*`), so all four are reachable by a user simply naming a channel:
 *
 *   - `<` and `>` → autolink terminators. `<silverhand://workspace/a<b>` is not an
 *     autolink at all; the whole reference degrades to plain text with no error.
 *   - `#` → the fragment delimiter. `new URL()` and every browser-grade parser cut
 *     the href there, so the segment this grammar sees would be truncated.
 *   - `?` → the query delimiter, same cut.
 *
 * NOT MEMBERS, by the same criterion: `@`, `:`, `[`, `]`, `&`, `=` and `+` are
 * delimiters only of the authority or of a query this grammar never parses, and
 * every URL parser leaves them inside the path segment. Escaping them would only
 * make CJK-adjacent names less readable for no property gained. Control characters
 * and the invisible code points are absent because a NAME cannot contain them.
 *
 * NO BYTE BUDGET, unlike {@link ADDRESS_TOKEN_MAX_BYTES}. That budget exists because
 * a header field is one unquoted whitespace-free token of bounded length; prose has
 * no such limit and no `#conv:<id>` fallback to degrade to, so the only bound on a
 * locator is the name length caps it is built from.
 */
export const URI_SEGMENT_CODEC: SegmentCodec = buildSegmentCodec([
  '<',
  '>',
  '#',
  '?',
]);

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

/**
 * The wire size of a formatted address token — the ONE measure the budget is
 * judged on, so no caller re-derives it with `.length`.
 *
 * `TextEncoder`, not Node's `Buffer`: this module is imported by the renderer.
 */
export function addressTokenByteLength(token: string): number {
  return encoder.encode(token).length;
}
