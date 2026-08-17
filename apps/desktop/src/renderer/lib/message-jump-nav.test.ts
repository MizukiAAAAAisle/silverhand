import { describe, expect, it } from 'vitest';
import type { DirectPairAuthority } from '@/lib/chat-place-restore';
import { resolveJumpNav } from './message-jump-nav';

// Pure decision fence for the jump seam (#task:2052). Not a UI test: which of
// three nav modes a jump takes is a BEHAVIOR branch, and the bug it guards
// against — reading the raw pair set, so a cold/failed read (empty set) routes a
// DM as a channel under the selected workspace — reappears the moment someone
// "simplifies" this back to `directPairIds.has(...)`. The falsifier is a
// workspace-less target while the pair list has not answered.

const ready = (ids: string[]): DirectPairAuthority => ({
  status: 'ready',
  conversationIds: new Set(ids),
});
const refetching = (ids: string[]): DirectPairAuthority => ({
  status: 'refetching',
  conversationIds: new Set(ids),
});
const pending: DirectPairAuthority = { status: 'pending' };
const failed: DirectPairAuthority = { status: 'failed' };

describe('resolveJumpNav', () => {
  it('routes a target that carries its own workspace id straight to the workspace arm', () => {
    // A channel jump must never be gated on the pair list being ready — that
    // would make an unrelated query a precondition for every jump (@Paul #2).
    // Prove it with the list UNANSWERED and mid-refetch: still workspace-resolve.
    for (const pairs of [pending, failed, ready([]), refetching([])]) {
      expect(
        resolveJumpNav({
          hasWorkspaceCoordinate: true,
          channelId: 'chan',
          pairs,
        }),
      ).toBe('workspace-resolve');
    }
  });

  it('opens a workspace-less target that the answered list knows as a pair', () => {
    expect(
      resolveJumpNav({
        hasWorkspaceCoordinate: false,
        channelId: 'pair-conv',
        pairs: ready(['pair-conv', 'other-pair']),
      }),
    ).toBe('to-direct');
  });

  it('sends a workspace-less NON-pair on an answered list to the workspace arm', () => {
    // Answered + miss = a normal channel target that arrived without its
    // workspace id; the pre-existing "use the selected workspace" path still
    // handles it. Only the unanswered case changes behavior.
    expect(
      resolveJumpNav({
        hasWorkspaceCoordinate: false,
        channelId: 'some-channel',
        pairs: ready(['pair-conv']),
      }),
    ).toBe('workspace-resolve');
  });

  it('fails closed on a workspace-less target while the pair list has not answered', () => {
    // Cold deep-link / first refetch with nothing cached / failed read: the list
    // is the sole authority that tells a DM from a channel, and it has not
    // spoken. Guessing the selected workspace is the wrong-place jump this seam
    // prevents. (A refetch that DOES hold rows is its own `refetching` state,
    // covered below.)
    for (const pairs of [pending, failed]) {
      expect(
        resolveJumpNav({
          hasWorkspaceCoordinate: false,
          channelId: 'unknown-conv',
          pairs,
        }),
      ).toBe('fail-closed');
    }
  });

  it('opens a workspace-less HIT even mid-refetch — pair membership only grows', () => {
    // `['direct-pairs']` is viewer-global and every incoming DM invalidates it,
    // so a one-shot jump routinely lands mid-refetch. Making it wait (like
    // restore does) would silently swallow the click with no replay. A hit is
    // safe: the list never drops a pair the viewer already has, so a cached
    // membership can't be revoked by the read in flight.
    expect(
      resolveJumpNav({
        hasWorkspaceCoordinate: false,
        channelId: 'pair-conv',
        pairs: refetching(['pair-conv', 'other-pair']),
      }),
    ).toBe('to-direct');
  });

  it('fails closed on a workspace-less MISS mid-refetch — could be a new pair', () => {
    // The other half of the asymmetry: a miss on a refetching list is exactly
    // the case a freshly minted pair looks like before the in-flight read brings
    // it back. Routing it to the workspace arm would build a wrong-place URL, so
    // it must fail closed even though the list has answered before.
    expect(
      resolveJumpNav({
        hasWorkspaceCoordinate: false,
        channelId: 'maybe-new-pair',
        pairs: refetching(['other-pair']),
      }),
    ).toBe('fail-closed');
  });

  it('never fails closed for a workspaced target, even on a failed pair read', () => {
    // The fail-closed branch is bound to the TARGET's missing coordinate, not to
    // the pair list's health — a failed pair read must not strand channel jumps.
    expect(
      resolveJumpNav({
        hasWorkspaceCoordinate: true,
        channelId: 'chan',
        pairs: failed,
      }),
    ).not.toBe('fail-closed');
  });
});
