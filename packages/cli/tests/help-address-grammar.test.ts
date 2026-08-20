/**
 * #task:2021 P4-4 — every address CLI HELP teaches is one the codec accepts,
 * and no help text still teaches a retired one.
 *
 * This is the CLI-side half of a drift gate whose other half lives in
 * `packages/shared/tests/platform-prompt-delivery-target.test.ts`. That one pins
 * the PROMPT against the codec; it cannot see help text, because help is
 * assembled from ~30 hand-written template literals in `src/commands/*` that no
 * type reaches into. So the two agent-facing teaching surfaces could disagree —
 * the prompt saying "paste the token whole" while a command's own `--help`
 * still shows `--target thread:<id>` — and nothing would error. The agent would
 * follow the help, because that is the surface it reads when it is about to act,
 * and land a refusal (or worse, a different stream).
 *
 * The gate is driven from the codec's OWN prefixes and its parser, not from a
 * list of expected strings: any token in any help block that starts like an
 * address is INSTANTIATED (placeholders → real values) and fed to
 * `parseDeliveryTargetInput`. A misspelled example, a fourth invented prefix, a
 * `/thread:` written as `:thread:` — all fail here rather than in a delivery.
 *
 * Two properties keep the fence honest:
 *   - An unknown `<placeholder>` is a FAILURE, not a skip. A new placeholder
 *     spelling must be taught here, so the gate cannot quietly stop covering
 *     the example it no longer understands.
 *   - The checkers are pure functions over text, so they are exercised against
 *     synthetic bad help at the bottom of this file. A fence that cannot fail
 *     proves nothing, and this one has to survive people editing prose.
 */
import { describe, expect, it } from 'vitest';
import {
  CONVERSATION_ADDRESS_PREFIX,
  NAMED_STREAM_ADDRESS_PREFIX,
  DIRECT_PAIR_SHORTHAND_PREFIX,
  THREAD_ADDRESS_SEPARATOR,
  TaskNavRefSchema,
  parseDeliveryTargetInput,
} from '@silverhand/shared';
import {
  facetHelp,
  facetVerbHelp,
  nounHelp,
  topLevelHelp,
  verbHelp,
} from '../src/help.js';
import { COMMAND_GROUPS } from '../src/commands/index.js';

/** Every agent-readable help block, labelled by the command that renders it. */
function allHelpBlocks(): ReadonlyArray<{ label: string; text: string }> {
  const blocks: Array<{ label: string; text: string }> = [
    { label: 'silverhand --help', text: topLevelHelp() },
  ];
  for (const group of COMMAND_GROUPS) {
    blocks.push({
      label: `${group.noun} --help`,
      text: nounHelp(group.noun) ?? '',
    });
    for (const command of group.commands) {
      blocks.push({
        label: `${group.noun} ${command.verb} --help`,
        text: verbHelp(group.noun, command.verb) ?? '',
      });
    }
    for (const facet of group.facets ?? []) {
      blocks.push({
        label: `${group.noun} ${facet.facet} --help`,
        text: facetHelp(group.noun, facet.facet) ?? '',
      });
      for (const command of facet.commands) {
        blocks.push({
          label: `${group.noun} ${facet.facet} ${command.verb} --help`,
          text: facetVerbHelp(group.noun, facet.facet, command.verb) ?? '',
        });
      }
    }
  }
  return blocks;
}

const escapeRe = (raw: string) => raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A candidate address = one of the codec's prefixes plus everything up to the
 * first delimiter help text uses around code (whitespace, quote, backtick, or
 * sentence punctuation). Built from the constants so renaming a prefix moves
 * this gate with it instead of blinding it.
 */
const ADDRESS_RE = new RegExp(
  `(?:${[
    NAMED_STREAM_ADDRESS_PREFIX,
    CONVERSATION_ADDRESS_PREFIX,
    DIRECT_PAIR_SHORTHAND_PREFIX,
  ]
    .map(escapeRe)
    .join('|')})[^\\s'"\`,;)\\]]*`,
  'g',
);

/** How each `TaskNavRef` field may appear in help, as a PARTITION of the DTO's
 *  own fields. Two independent properties ride on this shape:
 *
 *  1. Checked against the live schema, not a frozen copy: the hardcoded table
 *     this replaced kept teaching a key the server no longer sent and stayed
 *     green. Which cell catches a rename depends on how far the rename got, and
 *     the two edges meet with no gap between them:
 *       - schema renamed, partition AND prose untouched → the EXHAUSTIVENESS
 *         cell reds (the partition no longer equals `Object.keys(shape)`);
 *       - schema and partition renamed, prose left behind → the stale
 *         `<nav.ref.old_name>` is an UNKNOWN placeholder, already a failure here.
 *     So the guarded property is "in ONE build, prose and schema do not disagree
 *     about the field's name" — but no single cell owns it, and neither edge is
 *     the one this gate used to rely on (a name in a hardcoded table).
 *  2. NOT every field is addressable. The same paragraph this gate reads teaches
 *     `thread_root_id`, NEVER `message_id`: a reply cluster is addressed by its
 *     ROOT, and a mid-cluster anchor is refused rather than widened. Feeding the
 *     whole schema in would have made that forbidden spelling a KNOWN
 *     placeholder — instantiated to an opaque sample id, accepted by the codec,
 *     green — retiring the only machine constraint on that sentence.
 *     Non-addressable fields therefore stay OUT of the table, so prose that
 *     teaches one fails as an unknown placeholder.
 *
 *  Exhaustiveness is asserted below, so a field added to `TaskNavRef` tomorrow
 *  must be classified here rather than silently becoming quotable (or silently
 *  losing coverage). One sample value serves every field on purpose: the codec
 *  treats ids as opaque, so nothing here depends on what the fields are called. */
const NAV_REF_ADDRESSABLE = ['conversation_id', 'thread_root_id'] as const;
const NAV_REF_NOT_ADDRESSABLE = ['message_id'] as const;

const NAV_REF_PLACEHOLDERS: Readonly<Record<string, string>> = Object.fromEntries(
  NAV_REF_ADDRESSABLE.map(field => [`<nav.ref.${field}>`, 'NbBXIEpDUnSWW48x']),
);

/** Placeholder → a value the codec must accept. Unknown spellings fail loudly
 *  (see the docblock): the gate covers what it understands, and says so. */
const PLACEHOLDERS: Readonly<Record<string, string>> = {
  '<id>': 'Q1VI9x6vUK1a9oN9',
  '<conversation_id>': 'Q1VI9x6vUK1a9oN9',
  '<message_id>': 'NbBXIEpDUnSWW48x',
  '<root_message_id>': 'NbBXIEpDUnSWW48x',
  '<workspace>': 'silverhand',
  '<title>': 'general',
  '<handle>': 'shiki',
  // Field paths: help that tells an agent to BUILD an address out of a DTO.
  ...NAV_REF_PLACEHOLDERS,
};

/**
 * Which grammar a sigil token belongs to.
 *
 * `#` is SHARED: help teaches both the delivery grammar and the chat vocabulary a
 * message BODY uses (`#<channel>` for a place, `#task:<n>` for a task —
 * `cli-command-manifest.ts`). They are told apart the way the codec's own docblock
 * tells them apart: a prose place reference is workspace-RELATIVE and
 * single-segment, while a delivery address is absolute — two segments under the
 * bare sigil, or the `#conv:` / `dm:@` prefixes. Structure, not a list of allowed
 * strings, so a prose sigil added tomorrow is classified without an edit here and
 * a new ADDRESS example is not excused by one.
 *
 * KNOWN LIMIT, stated rather than hidden: an address example that lost its title
 * (`--target '#silverhand'`) is single-segment and is judged prose. This gate's
 * subject is the delivery codec; the chat vocabulary's authority is the renderer's
 * scanner and `reference.ts`, and asserting it from here would be a second opinion
 * on someone else's grammar.
 */
function addressGrammarOf(token: string): 'delivery' | 'prose' {
  if (
    token.startsWith(CONVERSATION_ADDRESS_PREFIX) ||
    token.startsWith(DIRECT_PAIR_SHORTHAND_PREFIX)
  ) {
    return 'delivery';
  }
  return token.includes('/') ? 'delivery' : 'prose';
}

// Field-path placeholders (`<nav.ref.conversation_id>`) count: a spelling this
// regex cannot see would slip past the unknown-placeholder check and be judged
// as a literal, which is a confusing failure rather than a clear one.
const PLACEHOLDER_RE = /<[A-Za-z_][A-Za-z_.]*>/g;

function instantiate(token: string): { value: string; unknown: string[] } {
  const unknown: string[] = [];
  const value = token.replace(PLACEHOLDER_RE, match => {
    const known = PLACEHOLDERS[match];
    if (known === undefined) {
      unknown.push(match);
      return match;
    }
    return known;
  });
  return { value, unknown };
}

/** Address-shaped tokens in one help block, minus bare prose mentions of a
 *  prefix (`no \`#conv:\` prefix`), which name the grammar rather than use it,
 *  and minus the chat vocabulary that shares the `#` sigil
 *  ({@link addressGrammarOf}). */
function addressTokens(text: string): readonly string[] {
  const prefixes = [
    NAMED_STREAM_ADDRESS_PREFIX,
    CONVERSATION_ADDRESS_PREFIX,
    DIRECT_PAIR_SHORTHAND_PREFIX,
  ];
  return (text.match(ADDRESS_RE) ?? [])
    .filter(token => !prefixes.includes(token))
    // A sentence-final period is prose, not part of the address.
    .map(token => token.replace(/\.$/, ''))
    .filter(token => addressGrammarOf(token) === 'delivery');
}

/**
 * Spellings P4-4 retired, with the misroute each one would cause if it survived
 * in help. Matched with `--target` (or `target=`) attached, so prose that merely
 * discusses the word "channel" is not a false positive.
 */
const RETIRED = [
  { pattern: /--target(?:=|\s+'?)channel\b/, why: 'relative write token `channel`' },
  { pattern: /--target(?:=|\s+'?)self\b/, why: 'relative read token `self`' },
  {
    pattern: /--target(?:=|\s+'?)thread:/,
    why: 'bare `thread:<root>` — a cluster is addressed under its conversation',
  },
  {
    pattern: /--target(?:=|\s+'?)conversation:/,
    why: 'read-door token `conversation:<id>`',
  },
  { pattern: /target=channel\b/, why: 'relative header token `channel`' },
] as const;

function retiredHits(text: string): readonly string[] {
  return RETIRED.filter(r => r.pattern.test(text)).map(r => r.why);
}

describe('CLI help teaches only the shipped delivery-address grammar', () => {
  const blocks = allHelpBlocks();

  it('renders a non-empty block for every command (gate has real input)', () => {
    expect(blocks.length).toBeGreaterThan(20);
    for (const block of blocks) {
      expect(block.text.length, block.label).toBeGreaterThan(0);
    }
  });

  it('every address-shaped token in help parses as an address', () => {
    let covered = 0;
    for (const block of blocks) {
      for (const token of addressTokens(block.text)) {
        const { value, unknown } = instantiate(token);
        expect(unknown, `${block.label}: unknown placeholder in ${token}`).toEqual(
          [],
        );
        expect(
          parseDeliveryTargetInput(value),
          `${block.label}: ${token} → ${value}`,
        ).not.toBeNull();
        covered += 1;
      }
    }
    // The doors that take an address are many; if this ever drops to a handful
    // the extraction broke, not the docs.
    expect(covered).toBeGreaterThan(20);
  });

  it('no help block still teaches a retired target token', () => {
    for (const block of blocks) {
      expect(retiredHits(block.text), block.label).toEqual([]);
    }
  });

  it('every TaskNavRef field is classified as addressable or not', () => {
    // The partition IS the contract (see {@link NAV_REF_PLACEHOLDERS}): a field
    // added to the DTO must be given an answer here, because the two outcomes
    // are opposite — quotable in help, or a failure when help quotes it. This
    // cell is also the edge that catches a SCHEMA-ONLY rename: the partition
    // still lists the old name, so it stops equalling the live keys.
    const classified = [...NAV_REF_ADDRESSABLE, ...NAV_REF_NOT_ADDRESSABLE];
    expect([...classified].sort()).toEqual(
      Object.keys(TaskNavRefSchema.shape).sort(),
    );
    expect(new Set(classified).size, 'a field classified twice').toBe(
      classified.length,
    );
  });

  it('no help block teaches a non-addressable nav field as an address', () => {
    // `message_id` addresses nothing: the cluster is addressed by its ROOT. This
    // is the guard the derived table would have dropped, so it is asserted from
    // both ends — the spelling is unknown to the instantiator (below), and no
    // shipped help block contains it.
    for (const field of NAV_REF_NOT_ADDRESSABLE) {
      const forbidden = `<nav.ref.${field}>`;
      expect(PLACEHOLDERS[forbidden], forbidden).toBeUndefined();
      for (const block of blocks) {
        expect(block.text.includes(forbidden), `${block.label}: ${forbidden}`).toBe(
          false,
        );
      }
    }
  });

  it('all three spellings are taught on the two doors an agent replies through', () => {
    // Send and history are where a received token is pasted back. Teaching only
    // `#conv:` there is how an agent learns to mine ids out of a name.
    for (const label of ['send', 'history'] as const) {
      const text = verbHelp('message', label) ?? '';
      expect(text, label).toContain(CONVERSATION_ADDRESS_PREFIX);
      expect(text, label).toContain(NAMED_STREAM_ADDRESS_PREFIX);
      expect(text, label).toContain(DIRECT_PAIR_SHORTHAND_PREFIX);
    }
  });
});

describe('the gate itself fails on bad help', () => {
  // Sensitivity self-check: each fixture is help text a careless edit would
  // produce, and the checker above must reject it. Without these, a broken
  // regex would report a clean sweep of everything.
  it('flags an unparseable example address', () => {
    const bad = "  --target <address>   e.g. `#conv:not-an-id`";
    const [token] = addressTokens(bad);
    expect(token).toBe('#conv:not-an-id');
    expect(parseDeliveryTargetInput(instantiate(token!).value)).toBeNull();
  });

  it('flags a misspelled thread separator', () => {
    const bad = "--target '#conv:Q1VI9x6vUK1a9oN9:thread:NbBXIEpDUnSWW48x'";
    const [token] = addressTokens(bad);
    expect(parseDeliveryTargetInput(instantiate(token!).value)).toBeNull();
  });

  it('flags a placeholder it does not know', () => {
    const bad = '--target `#conv:<channel_id>`';
    const [token] = addressTokens(bad);
    expect(instantiate(token!).unknown).toEqual(['<channel_id>']);
  });

  it('flags help that builds an address out of the WRONG nav field', () => {
    // The failure mode the classified partition exists for: `message_id` is a
    // real `TaskNavRef` field, so a careless edit reaches for it and the address
    // still LOOKS well-formed. Deriving the table from the whole schema would
    // have instantiated it to an opaque sample id and passed. Unknown here means
    // help cannot teach it without turning this gate red.
    const bad =
      '  reply under the task with ' +
      `\`${CONVERSATION_ADDRESS_PREFIX}<nav.ref.conversation_id>` +
      `${THREAD_ADDRESS_SEPARATOR}<nav.ref.message_id>\``;
    const [token] = addressTokens(bad);
    expect(instantiate(token!).unknown).toEqual(['<nav.ref.message_id>']);
    // …while the addressable sibling in the same position is accepted.
    const good = bad.replace('message_id', 'thread_root_id');
    const [goodToken] = addressTokens(good);
    const { value, unknown } = instantiate(goodToken!);
    expect(unknown).toEqual([]);
    expect(parseDeliveryTargetInput(value)).not.toBeNull();
  });

  it('flags every retired token, and does not fire on innocent prose', () => {
    expect(retiredHits('pass `--target channel` for the main line')).toHaveLength(1);
    expect(retiredHits("read your inbox with --target 'self'")).toHaveLength(1);
    expect(retiredHits('reply with --target thread:<root_message_id>')).toHaveLength(1);
    expect(retiredHits("--target 'conversation:Q1VI9x6vUK1a9oN9'")).toHaveLength(1);
    expect(retiredHits('the header used to say target=channel')).toHaveLength(1);
    expect(
      retiredHits(
        'Create a channel only when asked; a channel address is ' +
          `\`${NAMED_STREAM_ADDRESS_PREFIX}<workspace>/<title>\`.`,
      ),
    ).toEqual([]);
  });

  it('does not treat a bare prefix mention as an example', () => {
    expect(
      addressTokens('An OBJECT id, not an address: no `#conv:` prefix'),
    ).toEqual([]);
  });

  it('separates the delivery grammar from the chat vocabulary under one sigil', () => {
    // Help teaches both, and `#` belongs to both. Two segments (or a `#conv:` /
    // `dm:@` prefix) is an ADDRESS and must parse; one segment is a prose place or
    // a task, whose grammar this gate does not own.
    for (const prose of ['#<channel>', '#task:<n>', '#silverhand']) {
      expect(addressGrammarOf(prose), prose).toBe('prose');
    }
    for (const address of [
      '#<workspace>/<title>',
      '#silverhand/general',
      '#conv:<id>',
      'dm:@<handle>',
    ]) {
      expect(addressGrammarOf(address), address).toBe('delivery');
    }
    // And the classification is what the extractor applies: the manifest's prose
    // line yields no candidates, while the same line's address example does.
    expect(addressTokens('#<channel> or #conv:<id> names a place')).toEqual([
      '#conv:<id>',
    ]);
    expect(addressTokens("--target '#<workspace>/<title>'")).toEqual([
      '#<workspace>/<title>',
    ]);
  });
});
