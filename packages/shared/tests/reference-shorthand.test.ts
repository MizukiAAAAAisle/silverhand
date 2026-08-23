import { describe, expect, it } from 'vitest';
import { ENTITY_NAME_MAX_LENGTH } from '../src/index.js';
import {
  extractMessageReferences,
  findShorthandCandidates,
  rewriteShorthandReferences,
  type ShorthandResolver,
} from '../src/reference-markdown.js';

/**
 * #task:2001 — the composer's send-time shorthand rewrite. Two things are under
 * test and they are not the same thing:
 *
 *  - WHICH positions get rewritten, and
 *  - that a rewritten body then DELIVERS, i.e. `extractMessageReferences`
 *    accepts what this function produced.
 *
 * The second is the one that matters: a rewrite the extractor doesn't read is a
 * body whose bytes changed for nothing, and the author gets no signal. So the
 * round-trip is asserted alongside the positional cases rather than left as an
 * integration concern.
 */

const roster: ShorthandResolver = handle => {
  if (handle === 'Alice' || handle === 'Cindy') return 'agent';
  if (handle === 'shiki' || handle === 'alice') return 'human';
  return null;
};

describe('rewriteShorthandReferences — positions', () => {
  it('rewrites a resolvable handle in prose, with the kind the resolver gave', () => {
    expect(rewriteShorthandReferences('cc @Alice and @shiki', roster)).toBe(
      'cc <silverhand://agent/Alice> and <silverhand://human/shiki>',
    );
  });

  it('returns the body unchanged when it contains no `@` at all', () => {
    const body = 'A plain body with #task:1 and a [link](https://example.com).';
    expect(rewriteShorthandReferences(body, roster)).toBe(body);
  });

  it('leaves an unresolvable handle exactly as written', () => {
    // Still a chip (display alias), still addresses nobody — which is the truth.
    expect(rewriteShorthandReferences('cc @nobody', roster)).toBe('cc @nobody');
  });

  it('is case-sensitive on the handle, like every other resolver', () => {
    expect(rewriteShorthandReferences('cc @alice @Alice', roster)).toBe(
      'cc <silverhand://human/alice> <silverhand://agent/Alice>',
    );
  });

  it('does not rewrite inside inline code, a fenced block, or a quote', () => {
    const body = [
      'Write `@Alice` to address her.',
      '',
      '```',
      '@Alice',
      '```',
      '',
      '> @Alice said so',
    ].join('\n');
    expect(rewriteShorthandReferences(body, roster)).toBe(body);
  });

  it('does not rewrite inside a link label or a reference label', () => {
    // CommonMark links do not nest: the destination would survive as visible
    // text inside someone else's link rather than becoming an autolink.
    const body = [
      '[ask @Alice](https://example.com) and [ask @Cindy][ref]',
      '',
      '[ref]: https://example.com',
    ].join('\n');
    expect(rewriteShorthandReferences(body, roster)).toBe(body);
  });

  it('rewrites a bracketed label whose definition is missing (it is prose)', () => {
    // `[x][ref]` with no `[ref]:` definition is not a link at all — CommonMark
    // leaves it as literal text, so the handle is in prose position and the
    // extractor would read an autolink written there.
    expect(rewriteShorthandReferences('[ask @Cindy][ref]', roster)).toBe(
      '[ask <silverhand://agent/Cindy>][ref]',
    );
  });

  it('rewrites in headings, emphasis, and list items', () => {
    expect(
      rewriteShorthandReferences('# hi @Alice\n\n- *@shiki* please', roster),
    ).toBe(
      '# hi <silverhand://agent/Alice>\n\n- *<silverhand://human/shiki>* please',
    );
  });

  it('keeps email addresses and path segments literal', () => {
    const body = 'mail me@example.com or read docs/@Alice/readme.md';
    expect(rewriteShorthandReferences(body, roster)).toBe(body);
  });

  it('leaves a backslash-escaped @ alone', () => {
    // Rewriting it would emit `\<silverhand://…>`, whose `<` is escaped in turn,
    // so the reader would see the raw destination instead of a chip.
    expect(rewriteShorthandReferences('literal \\@Alice here', roster)).toBe(
      'literal \\@Alice here',
    );
  });

  it('reads the PARITY of the backslash run, not just the nearest one', () => {
    // CommonMark pairs backslashes off before it escapes anything, so an EVEN
    // run leaves the `@` unescaped. mdast agrees — `\\@Alice` decodes to the
    // text `\@Alice` — and the renderer draws its alias chip there. Skipping the
    // rewrite produced a chip that addresses nobody, which is the whole failure
    // this transform exists to remove (#task:2001 review, @Cindy).
    //
    // Written with explicit counts rather than a loop so a failure names the case.
    // Each `\\` below is ONE source backslash.
    expect(rewriteShorthandReferences('\\@Alice', roster)).toBe('\\@Alice');
    expect(rewriteShorthandReferences('\\\\@Alice', roster)).toBe(
      '\\\\<silverhand://agent/Alice>',
    );
    expect(rewriteShorthandReferences('\\\\\\@Alice', roster)).toBe(
      '\\\\\\@Alice',
    );
    expect(rewriteShorthandReferences('\\\\\\\\@Alice', roster)).toBe(
      '\\\\\\\\<silverhand://agent/Alice>',
    );
  });

  it('counts the run without disturbing the bytes around it', () => {
    expect(
      rewriteShorthandReferences('a\\\\@Alice and b\\@Cindy end', roster),
    ).toBe('a\\\\<silverhand://agent/Alice> and b\\@Cindy end');
  });

  it('does not let a preceding node lend its backslashes to the count', () => {
    // The run is bounded by the enclosing text node (@Alice's suggestion): a
    // CommonMark escape cannot reach across a node boundary, so an odd number of
    // backslashes ending an inline-code span must not flip the parity of a
    // handle in the text that follows.
    expect(rewriteShorthandReferences('`x\\`@Alice', roster)).toBe(
      '`x\\`<silverhand://agent/Alice>',
    );
  });

  it('delivers what an even backslash run rewrote, and nothing for an odd one', () => {
    // The round-trip is the point: `\\<silverhand://…>` is a literal backslash
    // followed by a real autolink, so the extractor reads it.
    expect(
      extractMessageReferences(
        rewriteShorthandReferences('\\\\@Alice', roster),
      ),
    ).toEqual([{ kind: 'agent', handle: 'Alice' }]);
    expect(
      extractMessageReferences(rewriteShorthandReferences('\\@Alice', roster)),
    ).toEqual([]);
  });

  it('treats an entity-encoded @ as not the alias form', () => {
    const body = '&commat;Alice is not a mention';
    expect(rewriteShorthandReferences(body, roster)).toBe(body);
  });

  it('rejects a handle longer than the stored bound', () => {
    // Grammar alone would admit it; the destination parser would then reject the
    // result, producing a chip-less literal that also delivers to nothing.
    const long = 'a'.repeat(ENTITY_NAME_MAX_LENGTH + 1);
    const always: ShorthandResolver = () => 'agent';
    expect(rewriteShorthandReferences(`cc @${long}`, always)).toBe(
      `cc @${long}`,
    );
  });

  it('rewrites every occurrence, keeping surrounding bytes intact', () => {
    // Multi-byte prose before and between the handles: offsets come from the
    // source, so a CJK run must not shift a splice.
    expect(
      rewriteShorthandReferences('请 @Alice 复核，然后 @Alice 合并', roster),
    ).toBe(
      '请 <silverhand://agent/Alice> 复核，然后 <silverhand://agent/Alice> 合并',
    );
  });

  it('leaves an already-canonical body untouched while rewriting the rest', () => {
    expect(
      rewriteShorthandReferences('<silverhand://agent/Alice> and @shiki', roster),
    ).toBe('<silverhand://agent/Alice> and <silverhand://human/shiki>');
  });
});

describe('rewriteShorthandReferences — the rewritten body delivers', () => {
  it('produces exactly the references the extractor then reads', () => {
    const refs = extractMessageReferences(
      rewriteShorthandReferences('cc @Alice and @shiki, also @nobody', roster),
    );
    expect(refs).toEqual([
      { kind: 'agent', handle: 'Alice' },
      { kind: 'human', handle: 'shiki' },
    ]);
  });

  it('delivers nothing for the positions it refuses to rewrite', () => {
    const body = [
      'Write `@Alice`.',
      '',
      '> @Alice said so',
      '',
      '[ask @Cindy](https://example.com)',
      '',
      'mail me@example.com',
    ].join('\n');
    expect(extractMessageReferences(rewriteShorthandReferences(body, roster)))
      .toEqual([]);
  });

  it('delivers once per addressee however many times the shorthand appears', () => {
    const refs = extractMessageReferences(
      rewriteShorthandReferences('@Alice @Alice @Alice', roster),
    );
    expect(refs).toEqual([{ kind: 'agent', handle: 'Alice' }]);
  });
});

/**
 * The roster-independent half of the same predicate: which handles a body's
 * delivery DEPENDS on. The composer asks this before sending so that "the member
 * query hasn't answered yet" cannot be mistaken for "nobody here by that name"
 * (#task:2001 review) — so what matters is that it agrees with the rewrite about
 * position, and that it stays quiet for bodies whose `@` could never address
 * anyone.
 */
describe('findShorthandCandidates', () => {
  it('lists the handles whose delivery depends on the roster, once each', () => {
    expect(findShorthandCandidates('cc @Alice, @nobody and @Alice')).toEqual([
      'Alice',
      'nobody',
    ]);
  });

  it('is empty for a body with no @ at all', () => {
    expect(findShorthandCandidates('just prose and a #task:1')).toEqual([]);
  });

  it('is empty where the rewrite would refuse anyway', () => {
    // Each of these could never have addressed anyone, so stalling a send over
    // them would trade a rare silent miss for a common visible stall.
    for (const body of [
      'mail me@example.com',
      'read docs/@Alice/readme.md',
      'write `@Alice` to address her',
      '```\n@Alice\n```',
      '> @Alice said so',
      '[ask @Alice](https://example.com)',
      '\\@Alice',
      '&commat;Alice',
      `@${'a'.repeat(65)}`,
    ]) {
      expect(findShorthandCandidates(body), body).toEqual([]);
    }
  });

  it('agrees with the rewrite on the even-backslash case', () => {
    // One predicate, so the parity fix cannot land on one side only.
    expect(findShorthandCandidates('\\\\@Alice')).toEqual(['Alice']);
  });

  it('lists a canonical reference as nothing — it needs no roster', () => {
    expect(findShorthandCandidates('<silverhand://agent/Alice> ok')).toEqual([]);
  });
});

/**
 * A leading U+FEFF is a coordinate prefix, not content the transform may lose.
 *
 * The parser drops one before parsing and does not adjust the positions it
 * reports, so a rewrite that spliced the author's original value was one character
 * out: the LAST shorthand in the body fell outside the (shifted) text range and was
 * silently left as `@handle`. That is the exact failure this transform exists to
 * remove — a chip renders, the author believes they addressed someone, and nobody is
 * woken — so it is pinned on both faces and through the round-trip.
 */
describe('rewriteShorthandReferences — a body that begins with a BOM', () => {
  const bom = '\ufeff';

  it('finds and rewrites EVERY shorthand, including the last one', () => {
    // Two handles, because the shift only dropped the occurrence nearest the end.
    expect(findShorthandCandidates(`${bom}@Alice and @shiki`)).toEqual([
      'Alice',
      'shiki',
    ]);
    expect(rewriteShorthandReferences(`${bom}@Alice and @shiki`, roster)).toBe(
      `${bom}<silverhand://agent/Alice> and <silverhand://human/shiki>`,
    );
  });

  it('delivers to both people afterwards, by the real extractor', () => {
    const stored = rewriteShorthandReferences(`${bom}@Alice and @shiki`, roster);
    expect(extractMessageReferences(stored)).toEqual([
      { kind: 'agent', handle: 'Alice' },
      { kind: 'human', handle: 'shiki' },
    ]);
  });

  it('preserves the leading BOM run byte for byte', () => {
    const stored = rewriteShorthandReferences(`${bom}@Alice`, roster);
    expect(stored.startsWith(bom)).toBe(true);
    expect(stored.split(bom)).toHaveLength(2);
    // A DOUBLED prefix still rewrites and still comes back whole, but only ONE
    // character is re-prepended: the parser drops one and counts the rest as
    // content, so the survivor is already inside the body being spliced.
    expect(rewriteShorthandReferences(`${bom}${bom}@Alice and @shiki`, roster)).toBe(
      `${bom}${bom}<silverhand://agent/Alice> and <silverhand://human/shiki>`,
    );
  });

  it('rewrites according to what the parser actually sees', () => {
    // The same discriminating pair the extractor has, on this face. Four spaces open
    // an indented code block — where a shorthand could never address anyone — unless
    // something else opens the line first:
    //
    //   one BOM  → dropped, so the line is `    @Alice` → CODE → left alone.
    //   two BOMs → one dropped, one SEEN, so it is a paragraph → rewritten.
    //
    // A coordinate rule that removed the whole run would parse both as code and
    // rewrite neither, which is a body whose author is never told.
    expect(rewriteShorthandReferences(`${bom}    @Alice`, roster)).toBe(
      `${bom}    @Alice`,
    );
    expect(findShorthandCandidates(`${bom}    @Alice`)).toEqual([]);
    expect(rewriteShorthandReferences(`${bom}${bom}    @Alice`, roster)).toBe(
      `${bom}${bom}    <silverhand://agent/Alice>`,
    );
    expect(findShorthandCandidates(`${bom}${bom}    @Alice`)).toEqual(['Alice']);
  });

  it('returns the value the author wrote when nothing resolved', () => {
    // Not a reassembled copy: no rewrite happened, so no byte may move.
    const untouched = `${bom}@nobody at all`;
    expect(rewriteShorthandReferences(untouched, roster)).toBe(untouched);
  });

  it('leaves a mid-body BOM alone, and the neighbouring shorthand rewritable', () => {
    // Only a LEADING BOM is a coordinate prefix; anywhere else it is already text
    // the parser counted, so nothing shifts and nothing is normalized away.
    expect(rewriteShorthandReferences(`hi ${bom}@Alice`, roster)).toBe(
      `hi ${bom}<silverhand://agent/Alice>`,
    );
  });

  it('does not treat the other invisible characters as a prefix', () => {
    // ZWSP and NBSP are content the parser sees, so they never shifted anything and
    // their behaviour must not change: both keep their own boundary semantics.
    for (const invisible of ['\u200b', '\u00a0']) {
      expect(
        rewriteShorthandReferences(`${invisible}@Alice`, roster),
        JSON.stringify(invisible),
      ).toBe(`${invisible}<silverhand://agent/Alice>`);
      expect(
        findShorthandCandidates(`${invisible}@Alice`),
        JSON.stringify(invisible),
      ).toEqual(['Alice']);
    }
  });
});
