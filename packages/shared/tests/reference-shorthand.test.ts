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
