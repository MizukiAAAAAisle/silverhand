import { describe, expect, it } from 'vitest';
import type { ConversationRef, DirectPairListItem } from '@silverhand/shared';
import type { ConversationByIdResult } from '@/features/conversations/useConversationById';
import type { DirectPairListQueryFacts } from '@/features/direct-pairs/hooks';
import {
  conversationPaneDescriptorFromIdentity,
  resolveConversationIdentity,
} from './conversation-identity';

/**
 * Composition of the two identity faces (#task:2038). Every case here is a claim
 * about WHICH face is allowed to decide, and the four bugs the ticket names are
 * the four negative assertions: a private line must not read as deleted, a 404
 * arriving before the pair list answered must not read as deleted, a failed pair
 * read must not read as deleted either, and none of the three may sit on a
 * skeleton forever.
 */

const channelRef: ConversationRef = {
  id: 'c-1',
  placement_kind: 'workspace',
  roster_policy: 'open',
  title: 'planning',
  workspace_id: 'w-1',
  closed_at: null,
  archived_at: null,
};

const pair: DirectPairListItem = {
  conversation_id: 'dp-1',
  counterpart: {
    status: 'active',
    kind: 'agent',
    id: 'a-alice',
    name: 'alice',
    display_name: 'Alice',
    avatar_url: null,
    runtime: 'claude',
  },
  unread_count: 0,
  read_only: false,
  created_at: 1_700_000_000_000,
};

const deletedPair: DirectPairListItem = {
  conversation_id: 'dp-gone',
  counterpart: { status: 'deleted', kind: 'human', id: 'u-gone' },
  unread_count: 0,
  read_only: true,
  created_at: 1_700_000_000_001,
};

/** The workspace face, in each of its five states. */
const workspaceFace = {
  loading: { status: 'loading', ref: null } satisfies ConversationByIdResult,
  resolved: { status: 'resolved', ref: channelRef } satisfies ConversationByIdResult,
  unauthorized: { status: 'unauthorized', ref: null } satisfies ConversationByIdResult,
  notFound: { status: 'not_found', ref: null } satisfies ConversationByIdResult,
  /** Settled in failure (5xx / transport) with the retry budget spent — nothing
   *  proven, nothing in flight (#task:2038 B1). */
  failed: { status: 'unresolved', ref: null } satisfies ConversationByIdResult,
};

/** The pair face. `rows` present ⇔ the list is IN HAND, independent of whether a
 *  refetch is in flight — the distinction the labelling seam deliberately makes
 *  differently from routing (`directPairAuthorityFromQuery`). */
function pairFacts(
  over: Partial<DirectPairListQueryFacts> = {},
): DirectPairListQueryFacts {
  return {
    rows: undefined,
    isPending: false,
    isFetching: false,
    isError: false,
    ...over,
  };
}

describe('resolveConversationIdentity — a held pair row wins outright', () => {
  it('resolves a private line from rows in hand', () => {
    const out = resolveConversationIdentity(
      'dp-1',
      workspaceFace.loading,
      pairFacts({ rows: [pair] }),
    );
    expect(out).toEqual({
      status: 'resolved',
      identity: { placement: 'direct_pair', pair },
    });
  });

  it('resolves from held rows even while the list is REFETCHING', () => {
    // Retained rows are enough to LABEL something already on screen. Collapsing
    // them to `loading` (what the routing authority does on purpose) would blink
    // every DM reference back to `#conv:<id>` on each list invalidation.
    const out = resolveConversationIdentity(
      'dp-1',
      workspaceFace.loading,
      pairFacts({ rows: [pair], isFetching: true }),
    );
    expect(out).toMatchObject({ status: 'resolved' });
  });

  it("resolves even when the workspace face already 404'd for the same id", () => {
    // This IS the bug: a private line is not expressible in `ConversationRef`, so
    // its 404 there is the correct answer and must not outrank the pair row.
    const out = resolveConversationIdentity(
      'dp-1',
      workspaceFace.notFound,
      pairFacts({ rows: [pair] }),
    );
    expect(out).toEqual({
      status: 'resolved',
      identity: { placement: 'direct_pair', pair },
    });
  });

  it('picks the row by conversation id, not by position', () => {
    const out = resolveConversationIdentity(
      'dp-gone',
      workspaceFace.notFound,
      pairFacts({ rows: [pair, deletedPair] }),
    );
    expect(out).toEqual({
      status: 'resolved',
      identity: { placement: 'direct_pair', pair: deletedPair },
    });
  });
});

describe("resolveConversationIdentity — the workspace face's own answers are terminal", () => {
  it('a 200 resolves as a workspace placement', () => {
    const out = resolveConversationIdentity(
      'c-1',
      workspaceFace.resolved,
      pairFacts({ rows: [pair] }),
    );
    expect(out).toEqual({
      status: 'resolved',
      identity: { placement: 'workspace', ref: channelRef },
    });
  });

  it('a 403 is unauthorized without waiting on the pair list', () => {
    // A 403 says the conversation IS in the workspace arm and refuses; a pair
    // cannot 403, so there is nothing the other face could add.
    const out = resolveConversationIdentity(
      'c-1',
      workspaceFace.unauthorized,
      pairFacts({ isPending: true }),
    );
    expect(out).toEqual({ status: 'unauthorized' });
  });

  it('a workspace face still loading is loading, whatever the pair list says', () => {
    const out = resolveConversationIdentity(
      'c-1',
      workspaceFace.loading,
      pairFacts({ rows: [] }),
    );
    expect(out).toEqual({ status: 'loading' });
  });
});

describe('resolveConversationIdentity — only a 404 consults the pair face', () => {
  it('404 + pair list never fetched → loading (absence is not yet decisive)', () => {
    // The precise regression: reporting `not_found` here claimed deletion before
    // the only face that can name a private line had answered.
    const out = resolveConversationIdentity(
      'dp-1',
      workspaceFace.notFound,
      pairFacts({ isPending: true }),
    );
    expect(out).toEqual({ status: 'loading' });
  });

  it('404 + pair list refetching with no row yet → loading', () => {
    const out = resolveConversationIdentity(
      'dp-1',
      workspaceFace.notFound,
      pairFacts({ rows: [], isFetching: true }),
    );
    expect(out).toEqual({ status: 'loading' });
  });

  it('404 + pair read FAILED → unresolved, never not_found', () => {
    // Nothing was proven and nothing is in flight: a skeleton would never end and
    // a deletion claim would be false. Hence the fifth status.
    const out = resolveConversationIdentity(
      'dp-1',
      workspaceFace.notFound,
      pairFacts({ isError: true }),
    );
    expect(out).toEqual({ status: 'unresolved' });
  });

  it('404 + a settled complete list that does not name the id → not_found', () => {
    // Licensed only by the list's COMPLETE-SET contract: the viewer is not an
    // endpoint of it, so the reference may degrade to inert text.
    const out = resolveConversationIdentity(
      'dp-1',
      workspaceFace.notFound,
      pairFacts({ rows: [] }),
    );
    expect(out).toEqual({ status: 'not_found' });
  });

  it('404 + a settled list holding OTHER pairs → not_found for the missing id', () => {
    const out = resolveConversationIdentity(
      'dp-missing',
      workspaceFace.notFound,
      pairFacts({ rows: [pair, deletedPair] }),
    );
    expect(out).toEqual({ status: 'not_found' });
  });
});

describe('resolveConversationIdentity — a FAILED workspace read proves nothing', () => {
  // #task:2038 B1 (@Cindy): before this, a settled 5xx / network failure on the
  // ref face mapped to `loading`, so a chip / `?side` sat on a skeleton that
  // could never end — the retry budget was already spent. The fix must not
  // overshoot in the other direction either: a failed read may not claim
  // `not_found`, because that claim rests on an ANSWER (404) plus the pair list's
  // completeness, and it has neither.
  it('settled failure + a settled list that does not name the id → unresolved', () => {
    const out = resolveConversationIdentity(
      'c-1',
      workspaceFace.failed,
      pairFacts({ rows: [] }),
    );
    expect(out).toEqual({ status: 'unresolved' });
  });

  it('settled failure + no pair list read at all → unresolved', () => {
    const out = resolveConversationIdentity(
      'c-1',
      workspaceFace.failed,
      pairFacts(),
    );
    expect(out).toEqual({ status: 'unresolved' });
  });

  it('settled failure + a held pair row still RESOLVES (the row is an answer)', () => {
    // Precedence 1 is unconditional: the viewer's own row names the conversation,
    // so the other face failing is irrelevant.
    const out = resolveConversationIdentity(
      'dp-1',
      workspaceFace.failed,
      pairFacts({ rows: [pair] }),
    );
    expect(out).toEqual({
      status: 'resolved',
      identity: { placement: 'direct_pair', pair },
    });
  });

  it('settled failure + pair list in flight → loading (that face may still name it)', () => {
    const out = resolveConversationIdentity(
      'dp-1',
      workspaceFace.failed,
      pairFacts({ isPending: true }),
    );
    expect(out).toEqual({ status: 'loading' });
  });

  it('a workspace read still RETRYING is loading, not unresolved', () => {
    // The in-flight/settled split lives in `mapConversationByIdResult`; this case
    // pins that the composition does not invent a terminal state of its own while
    // that face still reports `loading`.
    const out = resolveConversationIdentity(
      'c-1',
      workspaceFace.loading,
      pairFacts({ rows: [] }),
    );
    expect(out).toEqual({ status: 'loading' });
  });
});

describe('conversationPaneDescriptorFromIdentity', () => {
  it('a workspace identity copies the ref coordinate through', () => {
    const out = conversationPaneDescriptorFromIdentity({
      placement: 'workspace',
      ref: channelRef,
    });
    expect(out).toEqual({
      id: 'c-1',
      title: 'planning',
      placement_kind: 'workspace',
      roster_policy: 'open',
      closed_at: null,
      archived_at: null,
      workspace_id: 'w-1',
    });
  });

  it('a pair identity goes through the SAME builder the primary DM pane uses', () => {
    // Counterpart face + read-only state + `workspace_id: null`, so a private line
    // in the side pane is not a second, narrower rendering of a DM.
    const out = conversationPaneDescriptorFromIdentity({
      placement: 'direct_pair',
      pair,
    });
    expect(out).toEqual({
      id: 'dp-1',
      title: 'Alice',
      placement_kind: 'direct_pair',
      roster_policy: 'fixed',
      closed_at: null,
      archived_at: null,
      workspace_id: null,
      read_only: false,
      counterpart: pair.counterpart,
    });
  });

  it("a deleted counterpart's label comes from the endpoint rule, and read_only carries", () => {
    const out = conversationPaneDescriptorFromIdentity({
      placement: 'direct_pair',
      pair: deletedPair,
    });
    expect(out.title).toBe('Deleted user');
    expect(out.read_only).toBe(true);
    expect(out.workspace_id).toBeNull();
  });
});
