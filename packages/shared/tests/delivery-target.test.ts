import { describe, expect, it } from 'vitest';
import {
  ADDRESSABLE_ID_PATTERN,
  ADDRESS_TOKEN_MAX_BYTES,
  CONVERSATION_ADDRESS_PREFIX,
  NAMED_STREAM_ADDRESS_PREFIX,
  DIRECT_PAIR_SHORTHAND_PREFIX,
  ENTITY_NAME_MAX_LENGTH,
  ParticipantNameSchema,
  THREAD_ADDRESS_SEPARATOR,
  type DeliveryTarget,
  type NamedStreamTarget,
  addressTokenByteLength,
  addressableId,
  conversationAddressOf,
  decodeTargetForDisplay,
  fixedConversationTitle,
  fixedWorkspaceName,
  formatDeliveryTarget,
  formatDirectPairLabel,
  formatStreamAddressToken,
  formatUntrustedConversationAddress,
  parseDeliveryTarget,
  parseDeliveryTargetInput,
  requireAddressableId,
} from '../src/index.js';

/**
 * #task:2021 — the delivery-target grammar. Six properties carry the contract,
 * one describe block each:
 *
 *  - the DURABLE address is the conversation's own id, for every placement;
 *  - the id domain is the product's ONE id shape, 16 base64url characters, the
 *    same one the prose reference scanner recognises (@Cindy B3);
 *  - a readable coordinate exists, as exactly ONE envelope, and rendering it is
 *    total — a name that cannot be spelled falls back to the id form with a
 *    counted reason rather than being shortened (#task:2016 / #task:2027);
 *  - the DM shorthand is per-viewer and no durable formatter can produce it;
 *  - parsing is strict, with no repair and no ambient default;
 *  - an id becomes addressable only through the constructor, which is what makes
 *    "the formatter emits one header token" a fact about the type rather than a
 *    claim about call sites (@Cindy B2).
 */

// Real id shapes: `randomBytes(12).toString('base64url')` — exactly 16
// characters of base64url, which is what every stored id and every `#conv:`
// token in prose actually looks like.
const CONV = 'Q1VI9x6vUK1a9oN9';
const CONV_ALT = 'aBcDeFgHiJkLmNoP';
const ROOT = 'NbBXIEpDUnSWW48x';
const ROOT_ALT = 'A-b_C9zzzzzzzz12';
const ID_TOO_SHORT = 'aBcDeFgHiJkLmNo'; // 15
const ID_TOO_LONG = 'aBcDeFgHiJkLmNoPq'; // 17

const id = (raw: string) => requireAddressableId(raw, 'test id');
const target = (conversationId: string, threadRootId: string | null = null): DeliveryTarget => ({
  conversationId: id(conversationId),
  threadRootId: threadRootId === null ? null : id(threadRootId),
});

describe('the canonical address is the conversation id', () => {
  it('parses and formats `#conv:<id>`', () => {
    expect(parseDeliveryTarget(`#conv:${CONV}`)).toEqual(target(CONV));
    expect(formatDeliveryTarget(target(CONV))).toBe(`#conv:${CONV}`);
  });

  it('carries a reply cluster as a suffix on the same token', () => {
    expect(parseDeliveryTarget(`#conv:${CONV}/thread:${ROOT}`)).toEqual(target(CONV, ROOT));
    expect(formatDeliveryTarget(target(CONV, ROOT))).toBe(
      `${CONVERSATION_ADDRESS_PREFIX}${CONV}${THREAD_ADDRESS_SEPARATOR}${ROOT}`,
    );
  });

  it('distinguishes the main line from a thread, always explicitly', () => {
    // `threadRootId: null` is a decision, not an absent field: the main line and
    // a reply cluster are different streams and no default may pick between them.
    expect(formatDeliveryTarget(target(CONV))).not.toBe(formatDeliveryTarget(target(CONV, ROOT)));
    expect(parseDeliveryTarget(`#conv:${CONV}`)!.threadRootId).toBeNull();
  });

  it('never case-folds an id', () => {
    expect(parseDeliveryTarget(`#conv:${CONV_ALT}`)!.conversationId).toBe(CONV_ALT);
    expect(parseDeliveryTarget(`#conv:${CONV_ALT.toLowerCase()}`)!.conversationId).toBe(
      CONV_ALT.toLowerCase(),
    );
  });

  it('is the only form the machine-surface parser knows', () => {
    // `parseDeliveryTarget` is what a stored reply-to, an audit row and the
    // resolver's own round-trip call: its domain is ids, so no reader has to hold a
    // name registry to know which stream a durable field points at. The readable
    // form is an INPUT spelling and lives in `parseDeliveryTargetInput` (below).
    for (const raw of [
      `${NAMED_STREAM_ADDRESS_PREFIX}silverhand/general`,
      `${NAMED_STREAM_ADDRESS_PREFIX}silverhand/general/thread:${ROOT}`,
    ]) {
      expect(parseDeliveryTarget(raw), raw).toBeNull();
    }
  });

  it('has exactly one name-shaped spelling, and every other one is refused', () => {
    // #task:2027 supplied the address ROOT (a regular workspace's display name,
    // unique installation-wide) and #task:2016 the second segment (a title, unique
    // inside its workspace), so a readable coordinate exists — as ONE envelope, and
    // it is the ADJUDICATED one: `#<workspace>/<title>`, the same `#` a message body
    // uses to name a place. `silverhand://conversation/…` is in this refused list on
    // purpose: a revision of this codec shipped it without any ruling (@Cindy B2),
    // and `silverhand://` is #task:2000's PRINCIPAL scheme — a destination spelled in
    // that vocabulary conflates the two axes of the addressing model.
    // Every other name-shaped form ever proposed stays refused by both parsers,
    // including a `dm:` spelling that names the principal KIND: handles are globally
    // unique across users ⊕ agents (v21), so a kind segment adds no disambiguation.
    expect(parseDeliveryTargetInput('#silverhand/general')).toMatchObject({
      kind: 'named_stream',
    });
    for (const raw of [
      '#silverhand/general/thread:m_1', // a root id, not a message-id spelling
      '#general',
      'silverhand/general',
      'silverhand://general',
      '#silverhand', // a root with no channel
      '#silverhand/general/extra',
      'silverhand://conversation/silverhand/general', // never adjudicated
      'silverhand://channel/silverhand/general',
      'SILVERHAND://conversation/silverhand/general',
      'home:@Alice/general',
      'inbox:@Alice',
      'dm:human/@shiki',
      'dm:agent/@Alice',
      'dm:human/shiki',
    ]) {
      expect(parseDeliveryTarget(raw), raw).toBeNull();
      expect(parseDeliveryTargetInput(raw), raw).toBeNull();
    }
  });

  it('never reads an id-shaped head as the id it contains', () => {
    // The two absolute arms SHARE the `#` sigil, so this is the property that makes
    // them safe rather than merely different: the id arm is anchored (`^#conv:` plus
    // exactly 16 addressable characters, no structural `/`), and anything else with
    // one `/` is judged purely as two NAMES. So an id-shaped head with junk attached
    // never delivers to the conversation whose id it quotes — it either fails to
    // parse or names a workspace `conv:<id>`, which is a lookup that fails closed.
    //
    // Pinned rather than left implicit because the failure mode is a MISROUTE: a
    // parser that "recovered" the id out of `#conv:<id>/def` would deliver a message
    // whose target the sender spelled wrong, to a real stream.
    for (const raw of [
      `#conv:${CONV}/def`,
      `#conv:${CONV}/thread:/thread:${ROOT}`,
      `#conv:${CONV}/thread:${ROOT}/thread:${ROOT_ALT}`,
    ]) {
      expect(parseDeliveryTarget(raw), raw).toBeNull();
      const parsed = parseDeliveryTargetInput(raw);
      if (parsed === null) continue;
      // A NAME, and only a name: no `conversationId` anywhere in the value, so
      // nothing downstream can route on the id the token quotes. (The id text does
      // survive — as the workspace's NAME, `conv:<id>`, which is a lookup that finds
      // no such workspace.)
      expect(parsed.kind, raw).toBe('named_stream');
      expect(Object.keys(parsed), raw).not.toContain('stream');
      expect((parsed as { conversationId?: unknown }).conversationId, raw).toBeUndefined();
    }
  });
});

describe('the readable form names a coordinate, not an allocation', () => {
  const naming = (workspace: string, title: string) =>
    ({
      kind: 'named',
      workspace: fixedWorkspaceName(workspace),
      title: fixedConversationTitle(title),
    }) as const;

  it('renders and parses `#<workspace>/<title>`', () => {
    const rendered = formatStreamAddressToken(target(CONV), naming('silverhand', 'general'));
    expect(rendered).toEqual({
      token: '#silverhand/general',
      fallback: null,
    });
    expect(parseDeliveryTargetInput(rendered.token)).toEqual({
      kind: 'named_stream',
      workspace: fixedWorkspaceName('silverhand'),
      title: fixedConversationTitle('general'),
      threadRootId: null,
    });
  });

  it('carries a reply cluster on the same token, as the id form does', () => {
    const rendered = formatStreamAddressToken(
      target(CONV, ROOT),
      naming('silverhand', 'UI/UX 优化'),
    );
    expect(rendered.token).toBe(
      `#silverhand/UI%2FUX%20优化/thread:${ROOT}`,
    );
    expect(parseDeliveryTargetInput(rendered.token)).toEqual({
      kind: 'named_stream',
      workspace: fixedWorkspaceName('silverhand'),
      title: fixedConversationTitle('UI/UX 优化'),
      threadRootId: ROOT,
    });
  });

  it('round-trips every name the domain admits, and stays one header token', () => {
    // The header is split on whitespace and has no quoting, so a name that could
    // not survive `target=<token>` would be a machine read face that cannot be
    // split — the #task:2000 failure mode. `%2F` in particular must never be read
    // back as the segment separator.
    for (const workspace of ['silverhand', 'a', 'Æon 100%', '仓库/主线', 'a'.repeat(64)]) {
      for (const title of [
        'general',
        'UI/UX 优化',
        '100% done',
        'agent dm agent',
        '🚀 ship it',
        'Straße',
        'a'.repeat(128),
        // A title that LOOKS like the reply-cluster suffix. The domain admits it, so
        // the grammar has to: a parser that scanned for the last `/thread:` instead
        // of anchoring each arm would cut these tokens into a one-segment head and
        // refuse a coordinate its own formatter had just printed.
        'thread:',
        'thread:notes',
        `thread:${ROOT}`,
      ]) {
        for (const threadRootId of [null, ROOT]) {
          const stream = target(CONV, threadRootId);
          const { token, fallback } = formatStreamAddressToken(
            stream,
            naming(workspace, title),
          );
          expect(fallback, token).toBeNull();
          expect(token, token).not.toMatch(/[\s="'\\]/);
          expect(`target=${token}`.split(/\s+/), token).toHaveLength(1);
          expect(parseDeliveryTargetInput(token), token).toEqual({
            kind: 'named_stream',
            workspace: fixedWorkspaceName(workspace),
            title: fixedConversationTitle(title),
            threadRootId,
          });
        }
      }
    }
  });

  it('accepts only the canonical spelling of each segment', () => {
    // A NORMALIZATION difference is refused rather than repaired: accepting it would
    // give one title two addresses with no store consulted, and per-workspace
    // uniqueness of the folded key would stop making the ADDRESS unique.
    for (const raw of [
      '#silverhand/%67eneral', // over-escaped
      '#silverhand/UI%2fUX', // lowercase hex
      '#silverhand/general%', // dangling escape
      '#silverhand/%20general', // an encoded pad is not the title
      '#silverhand/general%20',
      '#/general', // an empty segment names nothing
      '#silverhand/',
      `#silverhand/${'a'.repeat(129)}`, // outside the domain
      `#${'a'.repeat(65)}/general`,
      '#silverhand/gene\u200Dral', // invisible, refused whole
    ]) {
      expect(parseDeliveryTargetInput(raw), raw).toBeNull();
      expect(parseDeliveryTarget(raw), raw).toBeNull();
    }
  });

  it('falls back to the id form when the encoded token exceeds its budget', () => {
    // A legal title is NOT promised to fit: 128 pictographs are 512 bytes on their
    // own. The escape is TOTAL and the id form is permanent, so a user's naming
    // freedom is never narrowed to keep a transport happy.
    const long = formatStreamAddressToken(target(CONV), naming('silverhand', '🚀'.repeat(128)));
    expect(long).toEqual({ token: `#conv:${CONV}`, fallback: 'token_budget' });
    expect(parseDeliveryTarget(long.token)).toEqual(target(CONV));
  });

  it('leaves the case fold to the lookup domain, not to parser tolerance', () => {
    // The parser cannot know a stored title's case without the store, so it does NOT
    // refuse `General`: it parses it and reports the folded KEY, and the one row that
    // key selects is the resolver's answer. That is the whole shape of
    // "case-insensitivity belongs to the lookup domain" \u2014 the tolerance is in the
    // stored key both sides derive identically, never in the grammar.
    const cased = parseDeliveryTargetInput('#Silverhand/General');
    const lower = parseDeliveryTargetInput('#silverhand/general');
    expect(cased?.kind).toBe('named_stream');
    expect(lower?.kind).toBe('named_stream');
    const namedCased = cased as NamedStreamTarget;
    const namedLower = lower as NamedStreamTarget;
    expect(namedCased.title.title).toBe('General');
    expect(namedCased.title.key).toBe(namedLower.title.key);
    expect(namedCased.workspace.key).toBe(namedLower.workspace.key);
  });

  it('measures the budget on the WHOLE token, suffix included', () => {
    // A head that fits and a token that does not is exactly what a per-segment cap
    // would miss; the header carries the suffix too. 106 pictographs are 424 bytes,
    // which fits under the sigil plus a 64-byte root and stops fitting once
    // `/thread:<id>` is appended.
    const value = naming('w'.repeat(64), '\uD83D\uDE80'.repeat(106));
    const head = formatStreamAddressToken(target(CONV), value);
    expect(head.fallback).toBeNull();
    expect(addressTokenByteLength(head.token)).toBeLessThanOrEqual(ADDRESS_TOKEN_MAX_BYTES);
    expect(
      addressTokenByteLength(`${head.token}${THREAD_ADDRESS_SEPARATOR}${ROOT}`),
    ).toBeGreaterThan(ADDRESS_TOKEN_MAX_BYTES);
    expect(formatStreamAddressToken(target(CONV, ROOT), value)).toEqual({
      token: `#conv:${CONV}/thread:${ROOT}`,
      fallback: 'token_budget',
    });
  });

  it('spells a stream with no name form without inventing one', () => {
    // Three arms, three different facts. `id_only` is addressed by id and is
    // NOT a fallback — counting a stream that can never have a name would bury
    // the reasons naming machinery could actually fix. A pair renders its
    // first-person label, which is why that label is not a fallback either.
    expect(formatStreamAddressToken(target(CONV), { kind: 'id_only' })).toEqual({
      token: `#conv:${CONV}`,
      fallback: null,
    });
    expect(
      formatStreamAddressToken(target(CONV, ROOT), { kind: 'direct_pair', otherHandle: 'shiki' }),
    ).toEqual({ token: `dm:@shiki/thread:${ROOT}`, fallback: null });
    for (const reason of ['agent_home', 'token_budget', 'unrenderable'] as const) {
      expect(
        formatStreamAddressToken(target(CONV), { kind: 'unnameable', reason }),
        reason,
      ).toEqual({ token: `#conv:${CONV}`, fallback: reason });
    }
  });

  it('is total: every token it can emit is a token some parser accepts', () => {
    // The header's contract is that its target is always actionable. `id_only` and
    // `unnameable` emit the machine form; `direct_pair` emits the per-viewer
    // shorthand, which only `parseDeliveryTargetInput` accepts — and that is the
    // parser the CLI runs on what a person copies out of a header.
    const namings = [
      naming('silverhand', 'general'),
      { kind: 'unnameable', reason: 'agent_home' } as const,
      { kind: 'direct_pair', otherHandle: 'shiki' } as const,
      { kind: 'id_only' } as const,
    ];
    for (const value of namings) {
      for (const threadRootId of [null, ROOT]) {
        const { token } = formatStreamAddressToken(target(CONV, threadRootId), value);
        expect(parseDeliveryTargetInput(token), token).not.toBeNull();
      }
    }
  });
});

describe('the id domain is the product id shape', () => {
  it('is exactly 16 base64url characters, for the conversation and the root alike', () => {
    expect(ADDRESSABLE_ID_PATTERN).toBe('[A-Za-z0-9_-]{16}');
    for (const raw of [
      `#conv:${ID_TOO_SHORT}`,
      `#conv:${ID_TOO_LONG}`,
      `#conv:${CONV}/thread:${ID_TOO_SHORT}`,
      `#conv:${CONV}/thread:${ID_TOO_LONG}`,
      `#conv:${ID_TOO_SHORT}/thread:${ROOT}`,
      `#conv:${ID_TOO_LONG}/thread:${ROOT}`,
    ]) {
      expect(parseDeliveryTarget(raw), raw).toBeNull();
      // On the actor surface an off-domain id is not an id at all, so a token that
      // still presents two segments reads as a NAME that resolves to nothing —
      // never as the id it quotes, and never carrying the root it appears to name.
      const parsed = parseDeliveryTargetInput(raw);
      if (parsed === null) continue;
      expect(parsed.kind, raw).toBe('named_stream');
      expect((parsed as NamedStreamTarget).threadRootId, raw).toBeNull();
    }
  });

  it('agrees with the prose reader, so one token means the same thing everywhere', () => {
    // The renderer's reference scanner recognises `#conv:` at `{16}` only. A
    // token this codec accepted but prose did not would be a live address in a
    // header and inert text in a message body — one surface disagreeing with
    // itself. This test pins the shared domain; fixture ids like `c1` are test
    // data and do not get to widen product identity.
    const proseRef = new RegExp(`#conv:(${ADDRESSABLE_ID_PATTERN})(?![A-Za-z0-9_-])`);
    for (const raw of [CONV, CONV_ALT, ROOT, ROOT_ALT]) {
      expect(proseRef.exec(`see #conv:${raw} here`)?.[1], raw).toBe(raw);
      expect(addressableId(raw), raw).toBe(raw);
    }
    for (const raw of ['c1', 'conversation-1', ID_TOO_SHORT, ID_TOO_LONG]) {
      expect(addressableId(raw), raw).toBeNull();
      // 17 characters match the prose scanner's class for the first 16 and then
      // fail its boundary lookahead, exactly as they fail here: both readers
      // refuse the token rather than truncating it.
      expect(proseRef.test(`see #conv:${raw} here`), raw).toBe(false);
    }
  });
});

describe('the DM shorthand is input-only', () => {
  it('parses `dm:@handle` as an explicitly unresolved target', () => {
    expect(parseDeliveryTargetInput('dm:@shiki')).toEqual({
      kind: 'direct_pair_shorthand',
      handle: 'shiki',
      threadRootId: null,
    });
  });

  it('takes a thread suffix like any other head', () => {
    // A human replying inside a DM thread types the shorthand too; refusing the
    // suffix here would push them back onto the opaque id for no safety gain.
    expect(parseDeliveryTargetInput(`dm:@shiki/thread:${ROOT}`)).toEqual({
      kind: 'direct_pair_shorthand',
      handle: 'shiki',
      threadRootId: ROOT,
    });
  });

  it('is refused by the machine-surface parser', () => {
    // The header, a stored reply-to and an audit record all call
    // `parseDeliveryTarget`: they must not accept a spelling they could not have
    // produced, because its meaning depends on the reader and on the handle still
    // belonging to the same principal.
    expect(parseDeliveryTarget('dm:@shiki')).toBeNull();
    expect(parseDeliveryTarget(`dm:@shiki/thread:${ROOT}`)).toBeNull();
  });

  it('cannot be produced by any target formatter', () => {
    // Type-level fact (`formatDeliveryTarget` takes `DeliveryTarget`, which has
    // no shorthand arm); asserted at runtime as the round-trip's other half.
    for (const t of [target(CONV), target(CONV, ROOT)]) {
      const formatted = formatDeliveryTarget(t);
      expect(formatted.startsWith(DIRECT_PAIR_SHORTHAND_PREFIX), formatted).toBe(false);
      expect(parseDeliveryTarget(formatted), formatted).toEqual(t);
    }
  });

  it('keeps the per-viewer display label out of the target grammar', () => {
    // `dm:@other` remains what a person sees in a list row (#task:2022 renders
    // it), and that label is deliberately NOT a target: it names a pair only
    // relative to the viewer.
    const label = formatDirectPairLabel('shiki');
    expect(label).toBe('dm:@shiki');
    expect(parseDeliveryTarget(label)).toBeNull();
  });

  it('applies the stored handle domain in both directions', () => {
    // The shorthand grammar and the stored grammar are two spellings of ONE
    // domain: a principal that exists must be nameable, and a handle the parser
    // accepts must be one a principal could have — otherwise "unresolved" stops
    // meaning "nothing by that name".
    for (const candidate of [
      'a',
      'shiki',
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
      'sh iki',
      'sh.iki',
      'sh/iki',
      '张三',
    ]) {
      const stored = ParticipantNameSchema.safeParse(candidate).success;
      expect(parseDeliveryTargetInput(`dm:@${candidate}`) !== null, candidate).toBe(stored);
    }
  });
});

describe('strict parsing', () => {
  it('refuses anything that is not exactly one of the forms', () => {
    for (const raw of [
      '',
      'channel', // the ambient token P4 retires: it names no stream
      `thread:${ROOT}`, // a reply cluster with no conversation
      CONV, // a bare id is not an address
      `conversation:${CONV}`, // the pre-P4 `history --target` spelling
      '#conv:', // the id is mandatory
      // NOT here: `#conv:<id>/def` and `#conv:<id>/thread:` — two segments under a
      // shared sigil, so they are NAMED addresses that fail at lookup. Pinned in
      // "never reads an id-shaped head as the id it contains".
      `#conv:${CONV}:def`,
      'aBcDeFgHiJkLmN P', // 16 characters, but not all inside the class
      '#conv:aBcDeFgHiJkLmN P',
      `#CONV:${CONV}`, // the prefix is lowercase-only
      `conv:${CONV}`,
      `#conv:${CONV}#`,
      ` #conv:${CONV}`,
      `#conv:${CONV} `,
      `#conv:${CONV}\n`,
      `#conv:${CONV}\t`,
      'dm:', // a pair with no principal
      'dm:@',
      'dm:shiki', // the handle sigil is part of the grammar
      'dm:@shiki@example.com',
      'dm:@2b', // a handle starts with a letter
      'dm:@张三',
      'DM:@shiki',
    ]) {
      expect(parseDeliveryTarget(raw), raw).toBeNull();
      expect(parseDeliveryTargetInput(raw), raw).toBeNull();
    }
  });

  it('refuses a thread suffix that names no root', () => {
    // An empty root id would read as "the main line" — a different stream, and
    // exactly the silent misdelivery the strictness exists to prevent. Every probe
    // here has a COMPLETE head in front of the broken suffix, which is what makes
    // the degradation reachable; `#<one segment>/thread:` is not in this list
    // because it is an incomplete head, i.e. a two-segment name whose title is
    // `thread:` (see the round-trip corpus), and it names no main line to fall to.
    for (const raw of [
      `#silverhand/general/thread:`,
      `#silverhand/general/thread:${ID_TOO_SHORT}`,
      `#conv:${CONV}/thread:aBcDeFgHiJkLm N`,
      `#conv:${CONV}/thread:aBcDeFgHiJkLm/N`,
      'dm:@shiki/thread:',
      `/thread:${ROOT}`,
      `thread:${ROOT}/thread:${ROOT_ALT}`,
    ]) {
      expect(parseDeliveryTarget(raw), raw).toBeNull();
      expect(parseDeliveryTargetInput(raw), raw).toBeNull();
    }
  });

  it('locates the suffix per arm, so a title may look like one', () => {
    // The suffix is POSITIONAL: each arm knows how many structural `/` its head
    // has, so nothing scans for the last separator. A scan cannot tell a suffix
    // from a title that begins with `thread:`, and would refuse a token the
    // formatter itself emits — the totality the header depends on.
    const titled = parseDeliveryTargetInput(`#silverhand/thread:${ROOT}`);
    expect(titled).toEqual({
      kind: 'named_stream',
      workspace: fixedWorkspaceName('silverhand'),
      title: fixedConversationTitle(`thread:${ROOT}`),
      threadRootId: null,
    });
    expect(parseDeliveryTargetInput(`#silverhand/thread:${ROOT}/thread:${ROOT_ALT}`)).toEqual({
      kind: 'named_stream',
      workspace: fixedWorkspaceName('silverhand'),
      title: fixedConversationTitle(`thread:${ROOT}`),
      threadRootId: ROOT_ALT,
    });
    // And the id arm keeps its own suffix: the machine parser reads exactly one.
    expect(parseDeliveryTarget(`#conv:${CONV}/thread:${ROOT}`)).toEqual(target(CONV, ROOT));
    expect(parseDeliveryTarget(`#conv:${CONV}/thread:${ROOT}/thread:${ROOT_ALT}`)).toBeNull();
  });
});

describe('the conversation head is derivable, in the actor\'s own spelling', () => {
  // For a caller that must address a differently-granular thing than the actor
  // did: `message send` spooling an oversized body, where the message goes to the
  // stream and the attachment is owned by its conversation (#task:2021 P4-4).
  it('drops a reply-cluster suffix and preserves every head form', () => {
    for (const head of [
      `#conv:${CONV}`,
      `${NAMED_STREAM_ADDRESS_PREFIX}silverhand/ui-ux`,
      'dm:@shiki',
    ]) {
      // Idempotent on an address that already names a conversation...
      expect(conversationAddressOf(head), head).toBe(head);
      // ...and the SAME string once a suffix is added, so nothing is normalized
      // on the way through: turning one form into another is resolution's job.
      expect(conversationAddressOf(`${head}${THREAD_ADDRESS_SEPARATOR}${ROOT}`), head).toBe(head);
    }
  });

  it('refuses what the parser refuses, head and suffix alike', () => {
    for (const raw of [
      '',
      'channel',
      CONV,
      `thread:${ROOT}`,
      '#silverhand/general/thread:', // a suffix that names no root is not a head either
      '#silverhand/general/extra',
      `#conv:${CONV} `,
    ]) {
      expect(conversationAddressOf(raw), raw).toBeNull();
    }
    // NOT in that list: `#conv:<id>/thread:<a>/thread:<b>`. Since the readable arm
    // shares the `#` sigil it reads as a workspace `conv:<id>` and a title
    // `thread:<a>` — a coordinate that names nothing, not a malformed token — and
    // this function is head-preserving, so it hands that head back untouched. What
    // matters is that the id is never recovered from it; pinned above in "never
    // reads an id-shaped head as the id it contains".
    expect(conversationAddressOf(`#conv:${CONV}/thread:${ROOT}/thread:${ROOT_ALT}`)).toBe(
      `#conv:${CONV}/thread:${ROOT}`,
    );
  });
});

describe('addressability is a property of the type', () => {
  it('admits exactly the ids an address can carry', () => {
    for (const raw of [CONV, CONV_ALT, ROOT, ROOT_ALT, '0123456789abcdef', '_-_-_-_-_-_-_-_-']) {
      expect(addressableId(raw), raw).toBe(raw);
    }
    for (const raw of [
      '',
      'a',
      'abc123',
      ID_TOO_SHORT,
      ID_TOO_LONG,
      'a'.repeat(64),
      'aBcDeFgHiJkLmN P',
      'aBcDeFgHiJkLmN/P',
      'aBcDeFgHiJkLmN:P',
      'aBcDeFgHiJkLmN#P',
      'aBcDeFgHiJkLmN\nP',
      '张三张三张三张三张三张三张三张三',
    ]) {
      expect(addressableId(raw), raw).toBeNull();
    }
  });

  it('fails loud for an id that came from our own store', () => {
    // A stream whose id cannot be spelled has no address at all, so a renderer
    // has no branch to take: omitting the target would leave the reader guessing,
    // which is the ambient default P4 exists to remove.
    expect(() => requireAddressableId('bad / id', 'conversations.id')).toThrow(
      /conversations\.id is not spellable/,
    );
    expect(requireAddressableId(CONV, 'conversations.id')).toBe(CONV);
  });

  it('emits one unquotable header token for every value the type can hold', () => {
    // The header is split on whitespace and has no quoting, so whitespace or a
    // second `=` in an address would make the whole line un-tokenizable — the
    // #task:2000 failure mode (a machine read face that cannot be split). Because
    // both fields are `AddressableId`, and that type admits exactly one id shape,
    // this holds for the WHOLE type, not just for the values a test chose.
    const ids = [CONV, CONV_ALT, ROOT, ROOT_ALT, '0123456789abcdef', '_-_-_-_-_-_-_-_-'];
    for (const conversationId of ids) {
      for (const threadRootId of [null, ...ids]) {
        const t = target(conversationId, threadRootId);
        const formatted = formatDeliveryTarget(t);
        expect(formatted, formatted).not.toMatch(/[\s="'\\]/);
        expect(`target=${formatted}`.split(/\s+/), formatted).toHaveLength(1);
        expect(parseDeliveryTarget(formatted), formatted).toEqual(t);
      }
    }
  });

  it('round-trips every canonical string the parser accepts', () => {
    for (const raw of [
      `#conv:${CONV}`,
      `#conv:${CONV_ALT}`,
      `#conv:${ROOT_ALT}`,
      `#conv:${CONV}/thread:${ROOT}`,
      `#conv:${CONV}/thread:${ROOT_ALT}`,
    ]) {
      expect(formatDeliveryTarget(parseDeliveryTarget(raw)!), raw).toBe(raw);
    }
  });

  /**
   * The one formatter that is TOTAL over raw strings, because its input did not come
   * from a row: the daemon's AgentSlot framing learns a conversation id from a
   * backend frame (`daemon/supervisor`). The distinction being asserted is the whole
   * reason it exists next to `requireAddressableId`: a peer's bad coordinate must
   * produce a delivered, honestly-labelled message, not a thrown compose and a dead
   * slot.
   */
  it('labels an id that arrived over the wire without trusting it', () => {
    // A well-formed id: identical to the authoritative spelling, so the daemon's
    // framing and the stdin header cannot drift.
    expect(formatUntrustedConversationAddress(CONV)).toBe(
      formatDeliveryTarget(target(CONV, null)),
    );
    // A malformed one: quoted VERBATIM, and the resulting token does not parse.
    // Both halves matter — verbatim so the reader sees exactly what was sent, and
    // unparseable because an unspellable id really is unaddressable, and a label
    // must not read as a capability.
    for (const raw of ['bad / id', '', ID_TOO_SHORT, '张三张三张三张三张三张三张三张三']) {
      const token = formatUntrustedConversationAddress(raw);
      expect(token, raw).toBe(`#conv:${raw}`);
      expect(parseDeliveryTarget(token), raw).toBeNull();
      expect(parseDeliveryTargetInput(token), raw).toBeNull();
    }
  });
});

/**
 * `decodeTargetForDisplay` — the readable inverse of the address formatters, and
 * DISPLAY ONLY. Locked here beside the grammar so a change to either direction
 * shows up in one maintenance face: it must round-trip the encoder over every
 * escaped character (`/`, `%`, and the Unicode space class) while leaving the
 * carrier's raw members (`#`, `?`, `<`, `>`) untouched. It produces a label only
 * for a canonical named target — one whose segments decode AND whose decoded
 * names the grammar accepts — and otherwise returns the raw token, never a
 * best-effort decode: a non-canonical escape and a name the domain rejects (a
 * decoded leading space) both fall back to raw.
 */
describe('decodeTargetForDisplay', () => {
  it('round-trips the encoder: escaped bytes decode, raw members pass through', () => {
    // A title exercising every character the target carrier escapes (`/ %` and a
    // full-width space, U+3000) alongside the ones it leaves raw (`# ? < >`).
    const title = 'a/b%c#d?e<f>g　h';
    const { token, fallback } = formatStreamAddressToken(
      { conversationId: addressableId(CONV)!, threadRootId: null },
      { kind: 'named', workspace: fixedWorkspaceName('silverhand'), title: fixedConversationTitle(title) },
    );
    expect(fallback).toBeNull();
    // The escaped bytes come back to their characters; the raw members are
    // unchanged; the structural `/` between segments stays a separator.
    expect(decodeTargetForDisplay(token)).toBe(`#silverhand/${title}`);
  });

  it('decodes each segment while separators and the thread suffix stay grammar', () => {
    expect(decodeTargetForDisplay('#silverhand/UI%2FUX%20优化')).toBe(
      '#silverhand/UI/UX 优化',
    );
    // The `/thread:<id>` suffix is grammar, not a name byte — passed through.
    expect(
      decodeTargetForDisplay(`#silverhand/room${THREAD_ADDRESS_SEPARATOR}${CONV_ALT}`),
    ).toBe(`#silverhand/room${THREAD_ADDRESS_SEPARATOR}${CONV_ALT}`);
  });

  it('leaves the id and pair forms untouched — neither carries escapes', () => {
    expect(decodeTargetForDisplay(`${CONVERSATION_ADDRESS_PREFIX}${CONV}`)).toBe(
      `${CONVERSATION_ADDRESS_PREFIX}${CONV}`,
    );
    expect(decodeTargetForDisplay(`${DIRECT_PAIR_SHORTHAND_PREFIX}shiki`)).toBe(
      `${DIRECT_PAIR_SHORTHAND_PREFIX}shiki`,
    );
  });

  it('returns the raw token for a non-canonical escape rather than guessing', () => {
    for (const raw of [
      '#silverhand/a%2fb', // lowercase hex — a second spelling, not decoded
      '#silverhand/a%',    // truncated escape
      '#silverhand/a%ZZb', // unknown escape
      'not-a-target',      // not the named arm at all
    ]) {
      expect(decodeTargetForDisplay(raw), raw).toBe(raw);
    }
  });

  it('returns the raw token when the escape is canonical but the decoded name is not', () => {
    // `%20` is a canonical escape, yet a leading space is not a legal name — the
    // grammar refuses it, so this is not a target any surface could carry and it
    // stays raw rather than rendering a name the resolver would reject.
    for (const raw of [
      '#silverhand/%20room', // decoded title has a leading space
      '#%20team/room',       // decoded workspace has a leading space
    ]) {
      expect(decodeTargetForDisplay(raw), raw).toBe(raw);
    }
  });
});
