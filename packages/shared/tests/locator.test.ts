// The locator grammar (#task:2119).
//
// Four properties, in the order they matter:
//
//  1. DISJOINT FROM ADDRESSING. No href is accepted by both `parseReference` and
//     `parseLocator`, and a body full of locators addresses nobody. This is the
//     property the module exists for: a container has no inbox, and a consumer that
//     mistook one for a principal would wake a runtime with directed framing.
//  2. STRICT ARITY. Root word plus segment count decides the arm; nothing is
//     guessed. A rejected destination is not an inert sigil, it is plain text — the
//     failure is silent, so the accepted set has to be right rather than forgiving.
//  3. ONE SPELLING PER NAME, in this carrier's escape set. The names travel inside
//     a CommonMark autolink, so `#`, `?`, `<` and `>` — all legal in a name — are
//     escaped here and raw in the `target=` carrier.
//  4. AN UNORDERED PAIR IS UNORDERED. Both DM endpoint orders parse to the same
//     value and the formatter emits one; the residual is that stored prose can
//     hold either spelling, because this ticket does not rewrite bodies.
//  5. THE CONSTRUCTOR BOUNDARY IS THE PROMISE. `formatLocator` claims to be total
//     AND canonical for every `Locator`, not merely for parser output — so the
//     non-canonical values (reversed pair, self-pair, malformed handle, malformed
//     thread id) must be UNCONSTRUCTIBLE rather than untested. Round-tripping
//     parser output through the formatter cannot see that difference, which is why
//     the last suite asserts refusals at the constructors and compile errors at the
//     literals (#task:2119, @Cindy).
import { describe, expect, it } from 'vitest';
import { fromMarkdown } from 'mdast-util-from-markdown';
import {
  LOCATOR_ROOTS,
  REFERENCE_KINDS,
  fixedConversationTitle,
  fixedLocatorEndpoints,
  fixedWorkspaceName,
  formatLocator,
  formatLocatorToken,
  formatReference,
  parseLocator,
  parseLocatorEndpoints,
  parseReference,
  parseWorkspaceAddressSegment,
  requireAddressableId,
  type Locator,
} from '../src/index.js';
import { extractMessageReferences, rewriteShorthandReferences } from '../src/reference-markdown.js';

const WS = 'silverhand://workspace';
const DM = 'silverhand://dm';
const ROOT_ID_TEXT = 'Wf3kQ2p8Lm1aBc7D';
const ROOT_ID = requireAddressableId(ROOT_ID_TEXT, 'test thread root');

describe('locator grammar — accepted shapes (#task:2119)', () => {
  const ACCEPTED: readonly (readonly [string, Locator, string])[] = [
    [
      `${WS}/silverhand`,
      { kind: 'workspace', workspace: fixedWorkspaceName('silverhand') },
      'a workspace root',
    ],
    [
      `${WS}/silverhand/设计`,
      {
        kind: 'channel',
        workspace: fixedWorkspaceName('silverhand'),
        channel: fixedConversationTitle('设计'),
        threadRootId: null,
      },
      'CJK stays raw — the coordinate is meant to be read',
    ],
    [
      `${WS}/silverhand/UI%2FUX%20优化`,
      {
        kind: 'channel',
        workspace: fixedWorkspaceName('silverhand'),
        channel: fixedConversationTitle('UI/UX 优化'),
        threadRootId: null,
      },
      'the structural slash and the space are escaped, the rest is not',
    ],
    [
      `${WS}/silverhand/设计/${ROOT_ID}`,
      {
        kind: 'channel',
        workspace: fixedWorkspaceName('silverhand'),
        channel: fixedConversationTitle('设计'),
        threadRootId: ROOT_ID,
      },
      'a thread leaf under a channel',
    ],
    [
      `${DM}/Cindy/shiki`,
      {
        kind: 'direct_pair',
        endpoints: fixedLocatorEndpoints('Cindy', 'shiki'),
        threadRootId: null,
      },
      'a DirectPair, already in canonical order',
    ],
    [
      `${DM}/Cindy/shiki/${ROOT_ID}`,
      {
        kind: 'direct_pair',
        endpoints: fixedLocatorEndpoints('Cindy', 'shiki'),
        threadRootId: ROOT_ID,
      },
      'a thread inside a DirectPair',
    ],
  ];

  for (const [href, expected, why] of ACCEPTED) {
    it(`${href} — ${why}`, () => {
      expect(parseLocator(href)).toEqual(expected);
      // TOTAL round trip: the formatter emits the canonical spelling, and these
      // inputs ARE canonical, so it must reproduce them byte for byte.
      expect(formatLocator(expected)).toBe(href);
    });
  }

  it('wraps the destination in an autolink, which is the only prose form', () => {
    expect(
      formatLocatorToken({
        kind: 'workspace',
        workspace: fixedWorkspaceName('silverhand'),
      }),
    ).toBe(`<${WS}/silverhand>`);
  });
});

describe('locator grammar — refusals (#task:2119)', () => {
  const REFUSED: readonly (readonly [string, string])[] = [
    ['silverhand://workspace', 'root word with no name at all'],
    [`${WS}/`, 'an empty name segment'],
    [`${WS}/silverhand/`, 'a trailing slash: an empty channel segment'],
    [`${WS}/silverhand/设计/${ROOT_ID}/more`, 'a fourth segment'],
    [`${WS}/silverhand/设计/short`, 'a thread leaf that is not an addressable id'],
    [`${WS}/silverhand/设计/${ROOT_ID.toLowerCase()}x`, 'a 17-character leaf'],
    [`${DM}/Cindy`, 'one endpoint is not a pair'],
    [`${DM}/Cindy/shiki/Norman`, 'three endpoints, or a bad thread leaf'],
    [`${DM}/Cindy/Cindy`, 'a self-pair has no second participant'],
    [`${DM}/2fast/shiki`, 'a handle may not start with a digit'],
    [`${DM}/Cindy/优化`, 'handles are ASCII: this one no participant could have'],
    [`${WS}/silverhand?x=1`, 'a query string: the raw `?` is not canonical here'],
    [`${WS}/silverhand#top`, 'a fragment: same'],
    [`${WS}/silverhand/UI/UX`, 'an unescaped slash inside a name splits the arity'],
    [`${WS}/silverhand/ui%2fux`, 'lowercase hex — a second spelling'],
    [`${WS}/silverhand/%41`, 'over-escaping a character the codec leaves raw'],
    [`${WS}/silverhand /设计`, 'a raw space, which would also break the autolink'],
    ['silverhand://channel/design', 'not a root word this grammar has'],
    ['silverhand://Workspace/silverhand', 'the root word is case-sensitive'],
    ['Silverhand://workspace/silverhand', 'the scheme is case-sensitive'],
    ['silverhand:/workspace/silverhand', 'a malformed scheme'],
    [` ${WS}/silverhand`, 'leading whitespace'],
    [`${WS}/silverhand `, 'trailing whitespace'],
    ['https://example.com/workspace/silverhand', 'a different scheme entirely'],
  ];

  for (const [href, why] of REFUSED) {
    it(`refuses ${JSON.stringify(href)} — ${why}`, () => {
      expect(parseLocator(href)).toBeNull();
    });
  }
});

/**
 * The four characters that made this carrier necessary. Each one is legal in a
 * channel title, so each is reachable by a user naming a channel — and each would
 * otherwise be cut out of the href by something downstream (the autolink for
 * `<`/`>`, a URL parser for `#`/`?`).
 */
describe('locator names that need the URI escape set (#task:2119)', () => {
  const NAMES: readonly (readonly [string, string])[] = [
    ['#2119', '%232119'],
    ['why?', 'why%3F'],
    ['a<b', 'a%3Cb'],
    ['a>b', 'a%3Eb'],
    ['#? <>', '%23%3F%20%3C%3E'],
  ];

  for (const [title, encoded] of NAMES) {
    it(`round-trips a channel named ${JSON.stringify(title)}`, () => {
      const locator: Locator = {
        kind: 'channel',
        workspace: fixedWorkspaceName('silverhand'),
        channel: fixedConversationTitle(title),
        threadRootId: null,
      };
      const href = `${WS}/silverhand/${encoded}`;
      expect(formatLocator(locator)).toBe(href);
      expect(parseLocator(href)).toEqual(locator);
      // And the token survives Markdown as ONE autolink whose url is exactly the
      // destination — the property the escape set buys. `a<b` raw would end the
      // autolink here and degrade the whole reference to plain text with no error.
      const token = formatLocatorToken(locator);
      const tree = fromMarkdown(`see ${token} please`);
      const paragraph = tree.children[0]!;
      expect(paragraph.type).toBe('paragraph');
      const link = paragraph.type === 'paragraph' ? paragraph.children[1]! : null;
      expect(link?.type).toBe('link');
      expect(link?.type === 'link' ? link.url : null).toBe(formatLocator(locator));
    });
  }

  it('leaves the target= carrier alone: a raw `#` still addresses there', () => {
    // The legacy non-regression that matters most, because the two carriers share a
    // codec: `#2119` is canonical as a `target=` segment and escaped as a URI one.
    expect(parseWorkspaceAddressSegment('#2119')?.name).toBe('#2119');
    expect(parseLocator(`${WS}/#2119`)).toBeNull();
    expect(parseLocator(`${WS}/%232119`)).toEqual({
      kind: 'workspace',
      workspace: fixedWorkspaceName('#2119'),
    });
  });
});

/**
 * A locator resolves through a LIVE NAME, so the grammar's job is to hand resolution
 * a name plus the fold key that decides which stored row it means — and nothing that
 * could pin an identity.
 */
describe('locator names carry a fold key, never an id (#task:2119)', () => {
  it('folds case for resolution while preserving what the author typed', () => {
    const lower = parseLocator(`${WS}/silverhand`);
    const upper = parseLocator(`${WS}/SILVERHAND`);
    expect(lower?.kind).toBe('workspace');
    expect(upper?.kind).toBe('workspace');
    if (lower?.kind !== 'workspace' || upper?.kind !== 'workspace') return;
    // The KEY is what the UNIQUE index compares, so both locators name one row…
    expect(upper.workspace.key).toBe(lower.workspace.key);
    // …while the display bytes stay the author's. The formatter round-trips both,
    // which is why two case spellings are two byte-strings and one coordinate.
    expect(upper.workspace.name).toBe('SILVERHAND');
    expect(formatLocator(upper)).toBe(`${WS}/SILVERHAND`);
  });
});

describe('DirectPair endpoints are an unordered pair (#task:2119)', () => {
  it('parses both authoring orders to the same value', () => {
    const sorted = parseLocator(`${DM}/Cindy/shiki`);
    const reversed = parseLocator(`${DM}/shiki/Cindy`);
    expect(reversed).toEqual(sorted);
    // Normalized AT PARSE, so no downstream consumer can observe which order was
    // typed — a renderer label taken from `endpoints` reads the same either way.
    expect(reversed?.kind === 'direct_pair' ? reversed.endpoints : null).toEqual([
      'Cindy',
      'shiki',
    ]);
  });

  it('emits only the canonical order, so ONE spelling is produced', () => {
    const locator = parseLocator(`${DM}/shiki/Cindy`)!;
    expect(formatLocator(locator)).toBe(`${DM}/Cindy/shiki`);
  });

  it('orders by code point, upper-case before lower-case', () => {
    // The consequence worth pinning: the order is BYTES, not "human then agent" and
    // not viewer-relative. `canonicalEndpointOrder` is kind-major over opaque ids,
    // so the DB's order for this same pair may be the other one — and nothing
    // depends on the two agreeing.
    const locator = parseLocator(`${DM}/alice/Bob`)!;
    expect(locator.kind === 'direct_pair' ? locator.endpoints : null).toEqual(['Bob', 'alice']);
  });

  it('keeps the thread leaf attached under either order', () => {
    expect(parseLocator(`${DM}/shiki/Cindy/${ROOT_ID}`)).toEqual(
      parseLocator(`${DM}/Cindy/shiki/${ROOT_ID}`),
    );
  });
});

/**
 * The property the module's separateness exists to guarantee. Derived from the two
 * constant arrays rather than from a list of examples: adding a root word to either
 * grammar that the other already has must fail here.
 */
describe('locators and references are disjoint (#task:2119)', () => {
  it('shares no root word', () => {
    const overlap = LOCATOR_ROOTS.filter((root) =>
      (REFERENCE_KINDS as readonly string[]).includes(root),
    );
    expect(overlap).toEqual([]);
  });

  it('accepts no href the other accepts', () => {
    for (const kind of REFERENCE_KINDS) {
      const href = formatReference({ kind, handle: 'Alice' });
      expect(parseReference(href)).not.toBeNull();
      expect(parseLocator(href)).toBeNull();
    }
    const locators = [
      `${WS}/silverhand`,
      `${WS}/silverhand/设计`,
      `${WS}/silverhand/设计/${ROOT_ID}`,
      `${DM}/Cindy/shiki`,
      `${DM}/Cindy/shiki/${ROOT_ID}`,
    ];
    for (const href of locators) {
      expect(parseLocator(href)).not.toBeNull();
      expect(parseReference(href)).toBeNull();
    }
  });

  it('addresses nobody: a body of locators extracts zero references', () => {
    // The consumer-level statement of the same fact. `extractMessageReferences` is
    // what thread auto-follow and mention CC read, so this is the assertion that a
    // channel locator cannot wake a runtime or add a follower.
    const body = [
      `see <${WS}/silverhand/设计> and <${DM}/Cindy/shiki>`,
      `and the thread <${WS}/silverhand/设计/${ROOT_ID}>`,
    ].join('\n\n');
    expect(extractMessageReferences(body)).toEqual([]);
    // A real reference in the same body still addresses, so the emptiness above is
    // about the locators and not about the extractor being broken.
    expect(extractMessageReferences(`${body}\n\n<silverhand://agent/Alice>`)).toEqual([
      { kind: 'agent', handle: 'Alice' },
    ]);
  });
});

/**
 * Item 4 of the ticket: the bytes a person or an agent typed are the bytes that get
 * stored, and copying a locator out of a body yields a locator.
 *
 * Include a real shorthand so these cases exercise rewriting, not the no-@ fast
 * path. Names inside the locator are not participant shorthand.
 */
describe('locator bytes survive the send path unchanged (#task:2119)', () => {
  // Resolves EVERYTHING, so a rewrite that could happen, would.
  const resolveAll = () => 'agent' as const;

  const BODIES = [
    `see <${WS}/silverhand/UI%2FUX%20优化> for the redesign`,
    `<${DM}/Cindy/shiki> holds the decision`,
    `thread: <${WS}/silverhand/设计/${ROOT_ID}>`,
    `and the workspace root <${WS}/silverhand>`,
  ];

  it('preserves every locator carrier while rewriting a genuine shorthand', () => {
    for (const body of BODIES) {
      expect(rewriteShorthandReferences(`@Norman ${body}`, resolveAll)).toBe(
        `<silverhand://agent/Norman> ${body}`,
      );
    }
  });
});

/**
 * Property 5: the formatter's contract is a property of the TYPE.
 *
 * Everything above feeds parser output back into the formatter, which cannot detect a
 * formatter that merely echoes whatever it was handed (@Cindy, #task:2119). These
 * cases attack the CONSTRUCTORS instead: the values that would make "total and
 * canonical" false must not exist. Two of the assertions are `@ts-expect-error`
 * comments rather than expectations — `tests` is inside this package's `tsconfig`
 * `include`, so `pnpm -r typecheck` fails if either literal ever becomes legal.
 */
describe('a non-canonical Locator is unconstructible (#task:2119)', () => {
  it('normalizes at the constructor, so a reversed pair cannot reach the formatter', () => {
    const endpoints = fixedLocatorEndpoints('shiki', 'Cindy');
    expect(endpoints).toEqual(['Cindy', 'shiki']);
    expect(formatLocator({ kind: 'direct_pair', endpoints, threadRootId: null })).toBe(
      `${DM}/Cindy/shiki`,
    );
  });

  const REFUSED_PAIRS: readonly (readonly [string, string, string])[] = [
    ['Cindy', 'Cindy', 'a self-pair'],
    ['2fast', 'shiki', 'a handle starting with a digit'],
    ['Cindy', '优化', 'a non-ASCII handle no participant could have'],
    ['Cindy', '', 'an empty handle'],
    ['Cindy', 'a b', 'a handle containing a space'],
    ['Cindy', 'shiki@example.com', 'a handle outside the character class'],
    ['Cindy', `a${'b'.repeat(64)}`, 'a handle past the stored length cap'],
  ];

  for (const [x, y, why] of REFUSED_PAIRS) {
    it(`refuses ${why} — parse returns null, the fixed form throws`, () => {
      expect(parseLocatorEndpoints(x, y)).toBeNull();
      expect(() => fixedLocatorEndpoints(x, y)).toThrow();
    });
  }

  it('refuses a hand-built locator at compile time', () => {
    const reversed: Locator = {
      kind: 'direct_pair',
      // @ts-expect-error — a bare tuple is not LocatorEndpoints: this is B1, closed.
      endpoints: ['shiki', 'Cindy'],
      threadRootId: null,
    };
    const shortLeaf: Locator = {
      kind: 'channel',
      workspace: fixedWorkspaceName('silverhand'),
      channel: fixedConversationTitle('设计'),
      // @ts-expect-error — a bare string is not AddressableId: this is B2, closed.
      threadRootId: 'short',
    };
    expect([reversed.kind, shortLeaf.kind]).toEqual(['direct_pair', 'channel']);
  });

  it('every constructible value formats to a locator the parser accepts', () => {
    const values: readonly Locator[] = [
      { kind: 'workspace', workspace: fixedWorkspaceName('#? <>') },
      {
        kind: 'channel',
        workspace: fixedWorkspaceName('silverhand'),
        channel: fixedConversationTitle('UI/UX 优化'),
        threadRootId: null,
      },
      {
        kind: 'channel',
        workspace: fixedWorkspaceName('SILVERHAND'),
        channel: fixedConversationTitle('设计'),
        threadRootId: ROOT_ID,
      },
      {
        kind: 'direct_pair',
        endpoints: fixedLocatorEndpoints('shiki', 'Cindy'),
        threadRootId: ROOT_ID,
      },
      {
        kind: 'direct_pair',
        endpoints: fixedLocatorEndpoints('alice', 'Bob'),
        threadRootId: null,
      },
    ];
    for (const value of values) {
      // Total: no arm throws, and the emitted destination is in the accepted set.
      expect(parseLocator(formatLocator(value))).toEqual(value);
    }
  });
});
