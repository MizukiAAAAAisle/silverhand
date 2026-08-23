import { describe, expect, it } from 'vitest';
import {
  ENTITY_NAME_MAX_LENGTH,
  ParticipantNameSchema,
  REFERENCE_KINDS,
  REFERENCE_PREFIX,
  formatReference,
  formatReferenceToken,
  mayContainReference,
  parseReference,
} from '../src/index.js';
import {
  extractMessageReferences,
  isAutolink,
} from '../src/reference-markdown.js';

/**
 * #task:2000 — the reference contract, tested along its two axes separately:
 * `parseReference` owns the DESTINATION grammar, `extractMessageReferences` owns
 * the POSITION/SYNTAX policy. Both must fail closed, and the delivery predicate
 * is their conjunction.
 */

describe('reference destination grammar', () => {
  it('accepts each kind with an exact-case handle', () => {
    expect(parseReference('silverhand://agent/Alice')).toEqual({
      kind: 'agent',
      handle: 'Alice',
    });
    expect(parseReference('silverhand://human/shiki')).toEqual({
      kind: 'human',
      handle: 'shiki',
    });
  });

  it('never lowercases the handle', () => {
    // Handles are exact-case everywhere in the product; a case-folding parser
    // would resolve a DIFFERENT principal than the author addressed, and the
    // cross-namespace uniqueness triggers are case-sensitive too.
    expect(parseReference('silverhand://agent/Alice')?.handle).toBe('Alice');
    expect(parseReference('silverhand://agent/alice')?.handle).toBe('alice');
  });

  it('refuses anything but the exact canonical shape', () => {
    for (const href of [
      'SILVERHAND://agent/Alice', // scheme is lowercase-only
      'Silverhand://agent/Alice',
      'silverhand://Agent/Alice', // kind is a closed lowercase vocabulary
      'silverhand://user/shiki', // `user` is the DB spelling, not a reference kind
      'silverhand://task/2000', // no typed kind exists for these yet
      'silverhand://conv/abc',
      'silverhand://agent/', // handle is mandatory
      'silverhand://agent/Alice/', // nothing may follow the handle
      'silverhand://agent/Alice/profile',
      'silverhand://agent/Alice?x=1',
      'silverhand://agent/Alice#top',
      'silverhand://agent/2b', // handle must start with a letter
      'silverhand://agent/al ice',
      'silverhand://agent/al%20ice', // percent-escapes are not decoded into legality
      'silverhand:/agent/Alice',
      'silverhand://agent/张三',
      'xsilverhand://agent/Alice',
      ' silverhand://agent/Alice',
      'silverhand://agent/Alice ',
      '',
    ]) {
      expect(parseReference(href), href).toBeNull();
    }
  });

  it('applies the stored length bound, not just the character grammar', () => {
    const max = 'a'.repeat(ENTITY_NAME_MAX_LENGTH);
    expect(parseReference(`silverhand://agent/${max}`)?.handle).toBe(max);
    expect(parseReference(`silverhand://agent/${max}a`)).toBeNull();
  });

  it('agrees with the stored-name domain in both directions', () => {
    // The destination grammar and the stored grammar are two spellings of ONE
    // domain: a name the schema admits must be addressable, and a handle the
    // parser accepts must be a name that can exist. Divergence in either
    // direction is a chip that cannot deliver or a delivery to nobody.
    const candidates = [
      'a',
      'alice',
      'Alice',
      'Agent_2',
      'x-y',
      'a1',
      'a'.repeat(ENTITY_NAME_MAX_LENGTH),
      'a'.repeat(ENTITY_NAME_MAX_LENGTH + 1),
      '2b',
      '-a',
      '_a',
      '',
      'al ice',
      'al.ice',
      'al/ice',
      '张三',
    ];
    for (const candidate of candidates) {
      const stored = ParticipantNameSchema.safeParse(candidate).success;
      const parsed = parseReference(`${REFERENCE_PREFIX}agent/${candidate}`);
      expect(parsed !== null, candidate).toBe(stored);
    }
  });

  it('round-trips every kind through both formatters', () => {
    for (const kind of REFERENCE_KINDS) {
      const ref = { kind, handle: 'Alice' } as const;
      expect(parseReference(formatReference(ref))).toEqual(ref);
      expect(extractMessageReferences(formatReferenceToken(ref))).toEqual([ref]);
    }
  });

  it('keeps the fast path sound: whatever parses is admitted by it', () => {
    // `mayContainReference` is what lets the delivery paths skip the Markdown
    // parse entirely, so it may never reject a body a full parse would accept.
    for (const kind of REFERENCE_KINDS) {
      for (const handle of ['a', 'Alice', 'x-y', 'Agent_2']) {
        const href = formatReference({ kind, handle });
        expect(parseReference(href)).not.toBeNull();
        expect(mayContainReference(`prefix ${href} suffix`), href).toBe(true);
      }
    }
    expect(mayContainReference('no references here @alice')).toBe(false);
  });
});

describe('reference delivery predicate', () => {
  const alice = { kind: 'agent', handle: 'Alice' } as const;

  it('delivers a canonical autolink anywhere in prose', () => {
    for (const body of [
      '<silverhand://agent/Alice>',
      `mid sentence <silverhand://agent/Alice> and more`,
      `- <silverhand://agent/Alice>`,
      `# <silverhand://agent/Alice>`,
      `**<silverhand://agent/Alice>**`,
      `| a | <silverhand://agent/Alice> |`,
      `line one\nline two <silverhand://agent/Alice>`,
    ]) {
      expect(extractMessageReferences(body), body).toEqual([alice]);
    }
  });

  it('refuses a label-carrying link, however it is spelled', () => {
    // The rejected case that motivates the whole predicate: the label is what a
    // reader sees on the raw-body surfaces (agent stdin, `message history`,
    // export) and the destination is what would have delivered.
    for (const body of [
      '[Alice](silverhand://human/shiki)',
      '[silverhand://agent/Alice](silverhand://agent/Alice)',
      '[<silverhand://agent/Alice>](silverhand://agent/Alice)',
      '[Alice](<silverhand://agent/Alice>)',
      '[Alice][a]\n\n[a]: silverhand://agent/Alice',
      '[silverhand://agent/Alice]: https://example.com',
    ]) {
      expect(extractMessageReferences(body), body).toEqual([]);
    }
  });

  it('refuses a reference that is quoted rather than written', () => {
    for (const body of [
      '`<silverhand://agent/Alice>`',
      '```\n<silverhand://agent/Alice>\n```',
      '    <silverhand://agent/Alice>', // indented code block
      '> <silverhand://agent/Alice>', // someone else's words
      '> quoting a reply\n> <silverhand://agent/Alice>',
      '<a href="silverhand://agent/Alice">Alice</a>', // raw HTML is never rendered
      '![Alice](silverhand://agent/Alice)', // an image destination links to nobody
      'bare silverhand://agent/Alice without brackets',
    ]) {
      expect(extractMessageReferences(body), body).toEqual([]);
    }
  });

  it('is a conjunction: an autolink whose destination is not canonical delivers nothing', () => {
    for (const body of [
      '<SILVERHAND://agent/Alice>',
      '<silverhand://user/shiki>',
      '<silverhand://agent/Alice?x=1>',
      '<silverhand://agent/al%20ice>',
      '<https://example.com/silverhand://agent/Alice>',
    ]) {
      expect(extractMessageReferences(body), body).toEqual([]);
    }
  });

  it('does not treat entity-escaped text as a reference', () => {
    // `&#115;ilverhand://…` is the letter `s` on screen but not in the source.
    // Both halves agree it is not a reference, and the fast path already said so.
    const body = '<&#115;ilverhand://agent/Alice>';
    expect(mayContainReference(body)).toBe(false);
    expect(extractMessageReferences(body)).toEqual([]);
  });

  it('deduplicates by principal, in first-occurrence order', () => {
    expect(
      extractMessageReferences(
        '<silverhand://human/shiki> then <silverhand://agent/Alice> '
          + 'then <silverhand://human/shiki> again',
      ),
    ).toEqual([
      { kind: 'human', handle: 'shiki' },
      alice,
    ]);
  });

  it('keeps kinds distinct for the same handle', () => {
    // A typed pointer that names the wrong kind is a wrong address, so the two
    // are different references even when one namespace guarantees one holder.
    expect(
      extractMessageReferences(
        '<silverhand://agent/shiki> <silverhand://human/shiki>',
      ),
    ).toEqual([
      { kind: 'agent', handle: 'shiki' },
      { kind: 'human', handle: 'shiki' },
    ]);
  });

  it('survives a deeply nested body without recursing', () => {
    // The content cap admits thousands of container levels; a recursive walk
    // would overflow the stack on the send path.
    const depth = 2000;
    expect(
      extractMessageReferences(`${'> '.repeat(depth)}<silverhand://agent/Alice>`),
    ).toEqual([]); // quoted, at any depth
    expect(
      extractMessageReferences(`${'- '.repeat(depth)}<silverhand://agent/Alice>`),
    ).toEqual([alice]); // nested lists are still prose, at any depth
  });

  it('costs nothing for a body without the literal', () => {
    expect(extractMessageReferences('plain text @alice and `code`')).toEqual([]);
  });
});

/**
 * The syntax layer on its own, exported because the renderer asks the SAME
 * question of the SAME node shape (#task:2001, ruling C): a chip is drawn only
 * where a bare autolink was written. Tested directly because it is now shared —
 * a change here moves both axes at once, and the two must not be able to disagree
 * about what a body's bytes say.
 *
 * It is syntax and nothing else: it knows no scheme, no grammar, no position
 * policy. Each caller adds its own, which is why those cases are asserted here as
 * TRUE rather than treated as out of scope.
 */
describe('isAutolink — the shared syntax layer', () => {
  const span = (source: string, url: string, start = 0, end = source.length) =>
    ({ url, position: { start: { offset: start }, end: { offset: end } } });

  /** The span `fromMarkdown` would give the autolink written in `source`. */
  const autoSpan = (source: string, url: string) => {
    const start = source.indexOf(`<${url}>`);
    return span(source, url, start, start + url.length + 2);
  };

  it('accepts a node whose source slice is exactly `<url>`', () => {
    const source = 'cc <silverhand://agent/Alice> please';
    expect(isAutolink(autoSpan(source, 'silverhand://agent/Alice'), source)).toBe(
      true,
    );
  });

  it('refuses a labelled link, whose slice carries a label', () => {
    const source = '[Alice](silverhand://agent/Alice)';
    expect(isAutolink(span(source, 'silverhand://agent/Alice'), source)).toBe(
      false,
    );
  });

  it('refuses a node whose offsets are missing', () => {
    // `fromMarkdown` always positions its nodes, so this is a synthetic tree —
    // not a body anyone sent. Refuse rather than guess.
    expect(isAutolink({ url: 'silverhand://agent/Alice' }, 'x')).toBe(false);
    expect(
      isAutolink(
        {
          url: 'silverhand://agent/Alice',
          position: { start: {}, end: { offset: 3 } },
        },
        'x',
      ),
    ).toBe(false);
  });

  it('refuses a node with no destination at all', () => {
    expect(isAutolink(span('<x>', undefined as unknown as string), '<x>')).toBe(
      false,
    );
  });

  it('says nothing about the scheme or the grammar', () => {
    // Both TRUE: this function reports how the link was WRITTEN. The scheme test
    // and the strict destination parser are separate gates, held by each caller.
    const external = '<https://example.com>';
    expect(isAutolink(span(external, 'https://example.com'), external)).toBe(
      true,
    );
    const malformed = '<silverhand://team/Alice>';
    expect(isAutolink(span(malformed, 'silverhand://team/Alice'), malformed)).toBe(
      true,
    );
  });

  it('says nothing about position, which each axis names for itself', () => {
    // Inside a blockquote: delivery refuses this position, the renderer chips it.
    // The disagreement is legitimate and lives in the callers, not here.
    const source = '> cc <silverhand://agent/Alice>';
    expect(isAutolink(autoSpan(source, 'silverhand://agent/Alice'), source)).toBe(
      true,
    );
  });
});

/**
 * A leading U+FEFF shifts every offset the parser reports, and this predicate is
 * decided BY those offsets.
 *
 * `fromMarkdown` drops one leading BOM before parsing without adjusting its
 * positions, so slicing the value the caller passed was one character out — for
 * every link in the document, not only the first — and a body that began with a BOM
 * addressed NOBODY. Fail-closed and completely silent: the author sees their own
 * reference in the message and no signal that it named no one.
 */
describe('a body that begins with a BOM still addresses the people it names', () => {
  const bom = '\ufeff';
  const alice = { kind: 'agent', handle: 'Alice' } as const;

  it('reads an autolink at the very start and one further in', () => {
    // Both positions, because the shift applies document-wide rather than only to
    // whatever sits against the prefix.
    expect(extractMessageReferences(`${bom}<silverhand://agent/Alice>`)).toEqual([
      alice,
    ]);
    expect(
      extractMessageReferences(`${bom}hi <silverhand://agent/Alice>`),
    ).toEqual([alice]);
    expect(
      extractMessageReferences(
        `${bom}first line\n\nsecond <silverhand://agent/Alice> here`,
      ),
    ).toEqual([alice]);
  });

  it('reads every reference in the body, in the usual order', () => {
    expect(
      extractMessageReferences(
        `${bom}<silverhand://human/shiki> and <silverhand://agent/Alice>`,
      ),
    ).toEqual([{ kind: 'human', handle: 'shiki' }, alice]);
  });

  it('reads through a repeated prefix, not just a single one', () => {
    // The parser strips one BOM from whatever it is handed, so removing a single
    // character would leave a value that still begins with one and shift every
    // offset again. The whole leading run is the coordinate prefix.
    for (const depth of [2, 3, 8]) {
      const body = `${bom.repeat(depth)}<silverhand://agent/Alice>`;
      expect(extractMessageReferences(body), `depth ${depth}`).toEqual([alice]);
    }
  });

  it('keeps the position rules it always had', () => {
    // The prefix is a coordinate origin, not a licence: quoting and code still
    // address nobody, at the same positions as before.
    for (const body of [
      `${bom}\`<silverhand://agent/Alice>\``,
      `${bom}> <silverhand://agent/Alice>`,
      `${bom}[Alice](silverhand://agent/Alice)`,
    ]) {
      expect(extractMessageReferences(body), body).toEqual([]);
    }
  });

  it('treats a BOM elsewhere as the content it already was', () => {
    // Nothing shifted for these, so nothing needed fixing — and nothing may change.
    expect(extractMessageReferences(`hi ${bom}<silverhand://agent/Alice>`)).toEqual(
      [alice],
    );
    for (const invisible of ['\u200b', '\u00a0']) {
      expect(
        extractMessageReferences(`${invisible}<silverhand://agent/Alice>`),
        JSON.stringify(invisible),
      ).toEqual([alice]);
    }
  });
});
