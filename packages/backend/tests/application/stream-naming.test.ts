// Which spelling a stream is ALLOWED, per viewer (#task:2021 P4-4).
//
// The policy is stated here rather than through the fanout because it is a pure
// function of the row plus two lookups (`stream-naming.ts` keeps the lookups as
// predicates for exactly this reason). Two families of assertion carry it:
//
//  1. WHICH ARM — placement decides the shape, and the reason attached to an
//     `unnameable` answer is the observability face of #task:2016: `agent_home` is
//     benign, `unrenderable` is an operator's cleanup queue, and confusing the two
//     makes the count useless.
//  2. THE ROUND TRIP — a `named` answer is a PROMISE that the token resolves back
//     to this row, so every conjunct is tested by breaking it on its own: a title
//     the current domain refuses, a title that is not byte-identical after
//     re-normalization, and a stored key that no longer folds from the stored
//     display string.
import { describe, expect, it } from 'vitest';
import {
  fixedConversationTitle,
  fixedWorkspaceName,
  formatStreamAddressToken,
  requireAddressableId,
  type ConversationEndpointIdentity,
} from '@silverhand/shared';
import {
  streamNamingOf,
  type StreamNamingConversation,
  type StreamNamingLookups,
  type StreamNamingRoot,
} from '../../src/application/stream-naming.js';

const CONV = 'Q1VI9x6vUK1a9oN9';
const WORKSPACE_ID = 'wkspc0000000000A';
const VIEWER = 'agentAAAAAAAAAAA';
const OTHER = 'agentBBBBBBBBBBB';
const USER = 'user000000000001';

/** A workspace-placed row whose two names are consistent — the shape every
 *  negative case below is a ONE-FIELD edit of, so a failure names the conjunct
 *  that broke rather than a whole different fixture. */
function conversation(
  overrides: Partial<StreamNamingConversation> = {},
): StreamNamingConversation {
  const title = fixedConversationTitle('UI/UX 优化');
  return {
    id: CONV,
    workspace_id: WORKSPACE_ID,
    title: title.title,
    title_key: title.key,
    placement_kind: 'workspace',
    endpoint_a_kind: null,
    endpoint_a_id: null,
    endpoint_b_kind: null,
    endpoint_b_id: null,
    endpoint_a_deleted_at: null,
    endpoint_b_deleted_at: null,
    ...overrides,
  };
}

function root(overrides: Partial<StreamNamingRoot> = {}): StreamNamingRoot {
  const name = fixedWorkspaceName('silverhand');
  return {
    owner_agent_id: null,
    name: name.name,
    name_key: name.key,
    ...overrides,
  };
}

/** The default lookups resolve everything. A case that is ABOUT a missing lookup
 *  overrides the one it is about. */
function lookups(overrides: Partial<StreamNamingLookups> = {}): StreamNamingLookups {
  const handles = new Map<string, string>([
    [`agent:${VIEWER}`, 'Alice'],
    [`agent:${OTHER}`, 'Cindy'],
    [`human:${USER}`, 'shiki'],
  ]);
  return {
    rootOf: () => root(),
    handleOf: (endpoint: ConversationEndpointIdentity) =>
      handles.get(`${endpoint.kind}:${endpoint.id}`) ?? null,
    ...overrides,
  };
}

const pair = (
  a: ConversationEndpointIdentity,
  b: ConversationEndpointIdentity,
): StreamNamingConversation =>
  conversation({
    workspace_id: null,
    placement_kind: 'direct_pair',
    endpoint_a_kind: a.kind,
    endpoint_a_id: a.id,
    endpoint_b_kind: b.kind,
    endpoint_b_id: b.id,
  });

const naming = (
  conv: StreamNamingConversation,
  look: StreamNamingLookups = lookups(),
) => streamNamingOf(conv, { agentId: VIEWER }, look);

/** What the header would actually carry — asserted alongside the arm wherever the
 *  arm alone would not show the reader anything. */
const token = (conv: StreamNamingConversation, look?: StreamNamingLookups): string =>
  formatStreamAddressToken(
    { conversationId: requireAddressableId(conv.id, 'test id'), threadRootId: null },
    naming(conv, look),
  ).token;

describe('a workspace-placed stream is named by its two names', () => {
  it('renders the stored workspace name and title', () => {
    expect(naming(conversation())).toEqual({
      kind: 'named',
      workspace: fixedWorkspaceName('silverhand'),
      title: fixedConversationTitle('UI/UX 优化'),
    });
    expect(token(conversation())).toBe(
      '#silverhand/UI%2FUX%20优化',
    );
  });

  it('names an agent-home placement by id, and says so without alarm', () => {
    // The benign reason, and the ROOT's OWNERSHIP decides it — see below for why
    // that is not the same question as "is `name_key` null".
    const home = root({ owner_agent_id: VIEWER, name_key: null });
    expect(naming(conversation(), lookups({ rootOf: () => home }))).toEqual({
      kind: 'unnameable',
      reason: 'agent_home',
    });
  });

  it('does not report corruption as privacy: an unowned root with no key is unrenderable', () => {
    // THE TRIPWIRE, and the only machine that can reach it. Two schema CHECKs tie
    // `name_key IS NULL` and `owner_agent_id IS NOT NULL` to each other, so no row
    // the DB accepted can be in this state — it is reachable only by hand-building
    // the struct and calling the pure function, which is exactly why the cell
    // exists: a future table rebuild that loses the CHECK gets caught here instead
    // of silently reporting corruption as the one bucket operators are told to
    // ignore.
    const broken = root({ owner_agent_id: null, name_key: null });
    expect(naming(conversation(), lookups({ rootOf: () => broken }))).toEqual({
      kind: 'unnameable',
      reason: 'unrenderable',
    });
  });

  it('still delivers when the root row cannot be read at all', () => {
    // A framing pass has no option to fail: the message is already claimed.
    expect(naming(conversation(), lookups({ rootOf: () => null }))).toEqual({
      kind: 'unnameable',
      reason: 'unrenderable',
    });
    expect(token(conversation(), lookups({ rootOf: () => null }))).toBe(`#conv:${CONV}`);
  });
});

describe('a named answer promises the token resolves back to this row', () => {
  const UNRENDERABLE = { kind: 'unnameable', reason: 'unrenderable' } as const;

  it('refuses a stored title the CURRENT domain would reject', () => {
    // A row written before the domain was pinned. It still NAMES the stream — the
    // resolver must keep finding it by key — but it must not be emitted as an
    // address, which is the asymmetry `stream-naming.ts` exists to hold.
    expect(naming(conversation({ title: '  ', title_key: '  ' }))).toEqual(UNRENDERABLE);
    expect(naming(conversation({ title: '', title_key: '' }))).toEqual(UNRENDERABLE);
  });

  it('refuses a title whose canonical form is not byte-identical to what is stored', () => {
    // STRICTER THAN RESOLUTION, on purpose: `" design "` parses, folds to the same
    // key, and its canonical spelling would resolve straight back to this row. What
    // is being protected is the header being a QUOTE of the stored title — the
    // string a reader compares against the UI — instead of the render path quietly
    // tidying exactly the rows `conversation-title-audit.ts` exists to surface.
    const trimmable = fixedConversationTitle('design');
    expect(
      naming(conversation({ title: ' design ', title_key: trimmable.key })),
    ).toEqual(UNRENDERABLE);
    // The same thing arriving as NFD, which is what a paste from macOS carries: all
    // three conjuncts hold except this one, so it is the case that isolates it.
    const decomposed = 'de\u{0301}sign';
    expect(decomposed).not.toBe('désign');
    expect(
      naming(
        conversation({
          title: decomposed,
          title_key: fixedConversationTitle('désign').key,
        }),
      ),
    ).toEqual(UNRENDERABLE);
  });

  it('refuses a half state: the stored key no longer folds from the stored title', () => {
    // The conjunct that is NOT implied by the other two, and the one with teeth:
    // the resolver looks up by `title_key`, so an address built from `title` here
    // resolves to nothing at all. Detected and failed-on at boot by
    // `conversation-title-audit.ts`; while it exists, rendering degrades.
    expect(
      naming(conversation({ title_key: fixedConversationTitle('something else').key })),
    ).toEqual(UNRENDERABLE);
    expect(naming(conversation({ title_key: null }))).toEqual(UNRENDERABLE);
  });

  it('applies the same three conjuncts to the workspace name', () => {
    const consistent = fixedWorkspaceName('silverhand');
    for (const broken of [
      root({ name: ' silverhand ' }),
      root({ name: 'silverhand', name_key: fixedWorkspaceName('dalaran').key }),
      root({ name: '', name_key: consistent.key }),
    ]) {
      expect(naming(conversation(), lookups({ rootOf: () => broken })), broken.name)
        .toEqual(UNRENDERABLE);
    }
  });
});

describe('a direct pair is spelled in the first person', () => {
  it('names the OTHER endpoint, for whichever side is reading', () => {
    // Canonical endpoint order is a storage fact, not a viewer fact, so the same
    // row must render each participant's counterpart from either column.
    const viewerFirst = pair({ kind: 'agent', id: VIEWER }, { kind: 'agent', id: OTHER });
    const viewerSecond = pair({ kind: 'agent', id: OTHER }, { kind: 'agent', id: VIEWER });
    for (const conv of [viewerFirst, viewerSecond]) {
      expect(naming(conv)).toEqual({ kind: 'direct_pair', otherHandle: 'Cindy' });
      expect(token(conv)).toBe('dm:@Cindy');
    }
  });

  it('names a human counterpart the same way', () => {
    expect(naming(pair({ kind: 'agent', id: VIEWER }, { kind: 'human', id: USER })))
      .toEqual({ kind: 'direct_pair', otherHandle: 'shiki' });
  });

  it('gives a non-participant the id rather than a stranger as their counterpart', () => {
    // The failure mode this arm is written against: `find(not viewer)` would have
    // handed a viewer who is in NEITHER column the first endpoint of a DM they
    // cannot even read, labelled as their own.
    const strangers = pair({ kind: 'agent', id: OTHER }, { kind: 'human', id: USER });
    expect(naming(strangers)).toEqual({ kind: 'id_only' });
  });

  it('gives the id when the counterpart handle is gone, and counts nothing', () => {
    // A deleted handle is RELEASED and may be reused, so a stale label is worse
    // than no label. Not a naming fallback either: no name machinery would fix it.
    const conv = pair({ kind: 'agent', id: VIEWER }, { kind: 'agent', id: OTHER });
    const gone = lookups({ handleOf: () => null });
    expect(naming(conv, gone)).toEqual({ kind: 'id_only' });
    expect(
      formatStreamAddressToken(
        { conversationId: requireAddressableId(CONV, 'test id'), threadRootId: null },
        naming(conv, gone),
      ),
    ).toEqual({ token: `#conv:${CONV}`, fallback: null });
  });

  it('throws on a pair row the placement arc CHECK cannot produce', () => {
    // One verdict on a malformed pair across the ACL, the write gate and rendering:
    // degrading to `id_only` here would leave the other two the only places that
    // notice a row that cannot exist.
    const half = conversation({
      workspace_id: null,
      placement_kind: 'direct_pair',
      endpoint_a_kind: 'agent',
      endpoint_a_id: VIEWER,
    });
    expect(() => naming(half)).toThrow(/missing an endpoint coordinate/);
  });
});
