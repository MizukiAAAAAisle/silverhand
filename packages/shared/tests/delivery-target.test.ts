import { describe, expect, it } from 'vitest';
import {
  ADDRESSABLE_ID_PATTERN,
  CONVERSATION_ADDRESS_PREFIX,
  DIRECT_PAIR_SHORTHAND_PREFIX,
  ENTITY_NAME_MAX_LENGTH,
  ParticipantNameSchema,
  THREAD_ADDRESS_SEPARATOR,
  type DeliveryTarget,
  addressableId,
  formatDeliveryTarget,
  formatDirectPairLabel,
  parseDeliveryTarget,
  parseDeliveryTargetInput,
  requireAddressableId,
} from '../src/index.js';

/**
 * #task:2021 — the delivery-target grammar. Five properties carry the contract,
 * one describe block each:
 *
 *  - the canonical address is the conversation's own id, for every placement;
 *  - the id domain is the product's ONE id shape, 16 base64url characters, the
 *    same one the prose reference scanner recognises (@Cindy B3);
 *  - the DM shorthand is input-only and no formatter can produce it;
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

  it('has no name-shaped arm for any placement', () => {
    // @Cindy B1: no NAME in this product can serve as the absolute root of an
    // address today — a workspace display name is renamed, a principal handle is
    // released by hard delete and reused — so none of these may be a target until
    // #task:2027 / #task:2028 supply those roots. (#task:2016 already made a
    // conversation's own name permanent, but only inside its workspace.) A `dm:`
    // form that spells the principal KIND is in the list too: handles are globally
    // unique across users ⊕ agents (v21), so the kind segment adds no
    // disambiguation and does not survive reuse either.
    for (const raw of [
      '#silverhand/general',
      '#silverhand/general/thread:m_1',
      '#general',
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
      expect(parseDeliveryTargetInput(raw), raw).toBeNull();
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
      `#conv:${CONV}/def`,
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
    // exactly the silent misdelivery the strictness exists to prevent.
    for (const raw of [
      `#conv:${CONV}/thread:`,
      `#conv:${CONV}/thread:/thread:${ROOT}`,
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

  it('splits on the last separator, so a malformed head fails as a head', () => {
    // No id and no handle can contain `/`, so at most one separator is
    // structural. Taking the LAST one means a head that already looks like a
    // thread address is reported instead of being re-cut into something that
    // parses.
    expect(parseDeliveryTarget(`#conv:${CONV}/thread:${ROOT}/thread:${ROOT_ALT}`)).toBeNull();
    expect(parseDeliveryTarget(`#conv:${CONV}/thread:${ROOT}`)).toEqual(target(CONV, ROOT));
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
});
