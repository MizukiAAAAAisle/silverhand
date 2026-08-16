import { describe, expect, it } from 'vitest';
import {
  chatPlaceForRoute,
  directPairAuthorityFromQuery,
  resolveChatPlaceRestore,
  type DirectPairAuthority,
} from './chat-place-restore';

const pending: DirectPairAuthority = { status: 'pending' };
const failed: DirectPairAuthority = { status: 'failed' };
const ready = (...ids: string[]): DirectPairAuthority => ({
  status: 'ready',
  conversationIds: new Set(ids),
});

describe('chatPlaceForRoute', () => {
  const base = {
    chatSectionActive: true,
    directDraftAgentId: null,
    directConversationId: null,
    selectedWorkspaceId: null,
  };

  it('records the direct arm with the open line id', () => {
    expect(chatPlaceForRoute({ ...base, directConversationId: 'c-dm' })).toEqual({
      kind: 'direct_pair',
      conversationId: 'c-dm',
    });
  });

  it('records the workspace arm as soon as a workspace is selected', () => {
    // No channel yet is still honestly the workspace arm — which workspace and
    // which channel are questions the workspace-keyed memory already answers.
    expect(chatPlaceForRoute({ ...base, selectedWorkspaceId: 'ws-1' })).toEqual({
      kind: 'workspace_channel',
    });
  });

  it('records nothing for the pre-mint draft route', () => {
    // A line that does not exist is not a place to come back to, and its unsent
    // text lives in the pane — persisting the route would imply the text
    // returned with it.
    expect(
      chatPlaceForRoute({ ...base, directDraftAgentId: 'ag-1' }),
    ).toBeNull();
  });

  it('records nothing for bare /chat, so passing through restore keeps the memory', () => {
    expect(chatPlaceForRoute(base)).toBeNull();
  });

  it('records nothing outside the chat section', () => {
    // The Agents / Tasks rails carry no chat place; going there must not erase
    // the arm the viewer expects to come back to.
    expect(
      chatPlaceForRoute({
        ...base,
        chatSectionActive: false,
        selectedWorkspaceId: 'ws-1',
      }),
    ).toBeNull();
  });

  it('prefers the draft over a workspace id if both were somehow set', () => {
    expect(
      chatPlaceForRoute({
        ...base,
        directDraftAgentId: 'ag-1',
        selectedWorkspaceId: 'ws-1',
      }),
    ).toBeNull();
  });
});

describe('directPairAuthorityFromQuery', () => {
  const cold = { answered: undefined, isFetching: false, isError: false };
  const remembered = { kind: 'direct_pair', conversationId: 'c-dm' } as const;
  /** What the rail would actually DO with this projection — the cells below are
   *  about a wrong navigation, not about an enum value. */
  const restoreFor = (q: Parameters<typeof directPairAuthorityFromQuery>[0]) =>
    resolveChatPlaceRestore({
      place: remembered,
      pairs: directPairAuthorityFromQuery(q),
    });

  it('is pending while the first read is in flight', () => {
    expect(directPairAuthorityFromQuery({ ...cold, isFetching: true })).toEqual({
      status: 'pending',
    });
  });

  it('is pending with no answer, no failure and nothing in flight', () => {
    // A disabled / not-yet-started query. Absence of an answer is not "no pairs".
    expect(directPairAuthorityFromQuery(cold)).toEqual({ status: 'pending' });
  });

  it('is ready on a settled success', () => {
    expect(
      directPairAuthorityFromQuery({ ...cold, answered: new Set(['c-dm']) }),
    ).toEqual({ status: 'ready', conversationIds: new Set(['c-dm']) });
  });

  it('is ready on an answered EMPTY list', () => {
    // "You have no pairs" is an answer, and the caller must be able to act on it.
    expect(
      directPairAuthorityFromQuery({ ...cold, answered: new Set() }),
    ).toEqual({ status: 'ready', conversationIds: new Set() });
  });

  it('does not treat cached rows as the answer while a refetch is in flight', () => {
    // React Query keeps the previous `data` through an invalidation. Whether the
    // viewer is still an endpoint has not been re-answered, so the rail waits
    // instead of re-opening the line from rows that predate the question.
    const q = { answered: new Set(['c-dm']), isFetching: true, isError: false };
    expect(directPairAuthorityFromQuery(q)).toEqual({ status: 'pending' });
    expect(restoreFor(q)).toEqual({ kind: 'wait' });
  });

  it('does not treat cached rows as the answer after a refetch failed', () => {
    // Same rows, but now nothing more is coming: reachability is unknown, so the
    // rail falls back to the workspace arm rather than opening the cached line.
    const q = { answered: new Set(['c-dm']), isFetching: false, isError: true };
    expect(directPairAuthorityFromQuery(q)).toEqual({ status: 'failed' });
    expect(restoreFor(q)).toEqual({ kind: 'workspace' });
  });

  it('is failed on a cold read that failed', () => {
    expect(directPairAuthorityFromQuery({ ...cold, isError: true })).toEqual({
      status: 'failed',
    });
  });

  it('prefers a read in flight over the previous failure', () => {
    // A retry is running: `failed` means "nothing more is coming", which is what
    // licenses it to route instead of wait — so it must not be claimed here.
    const q = { answered: new Set(['c-dm']), isFetching: true, isError: true };
    expect(directPairAuthorityFromQuery(q)).toEqual({ status: 'pending' });
    expect(restoreFor(q)).toEqual({ kind: 'wait' });
  });
});

describe('resolveChatPlaceRestore', () => {
  it('uses the workspace arm on a cold start (nothing recorded)', () => {
    expect(resolveChatPlaceRestore({ place: null, pairs: pending })).toEqual({
      kind: 'workspace',
    });
  });

  it('uses the workspace arm without consulting the pair list', () => {
    // A recorded workspace arm needs no per-viewer verification, so it must not
    // pay the pair list's latency.
    expect(
      resolveChatPlaceRestore({
        place: { kind: 'workspace_channel' },
        pairs: pending,
      }),
    ).toEqual({ kind: 'workspace' });
  });

  it('opens the remembered line when the viewer still has it', () => {
    expect(
      resolveChatPlaceRestore({
        place: { kind: 'direct_pair', conversationId: 'c-dm' },
        pairs: ready('c-other', 'c-dm'),
      }),
    ).toEqual({ kind: 'open-direct', conversationId: 'c-dm' });
  });

  it('waits while the pair list has not answered', () => {
    // Falling through to the workspace arm here would navigate, and a
    // navigation cannot be taken back once the answer arrives.
    expect(
      resolveChatPlaceRestore({
        place: { kind: 'direct_pair', conversationId: 'c-dm' },
        pairs: pending,
      }),
    ).toEqual({ kind: 'wait' });
  });

  it('falls back to the workspace arm when the line is no longer the viewer\'s', () => {
    // Deleted, or the viewer is no longer an endpoint: the answered list is the
    // authority, and memory does not override it.
    expect(
      resolveChatPlaceRestore({
        place: { kind: 'direct_pair', conversationId: 'c-gone' },
        pairs: ready('c-other'),
      }),
    ).toEqual({ kind: 'workspace' });
  });

  it('falls back to the workspace arm when the viewer has no pairs at all', () => {
    expect(
      resolveChatPlaceRestore({
        place: { kind: 'direct_pair', conversationId: 'c-dm' },
        pairs: ready(),
      }),
    ).toEqual({ kind: 'workspace' });
  });

  it('a failed list is a fallback, not a wait', () => {
    // Nothing more is coming, so waiting would hold the bare route forever.
    expect(
      resolveChatPlaceRestore({
        place: { kind: 'direct_pair', conversationId: 'c-dm' },
        pairs: failed,
      }),
    ).toEqual({ kind: 'workspace' });
  });
});
