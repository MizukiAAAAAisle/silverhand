import { describe, expect, it } from 'vitest';
import {
  selectFocusedConversation,
  selectSecondaryDescriptor,
  selectVisibleConversations,
  shouldSecondaryFullscreen,
  type SecondaryDescriptor,
  type SecondaryLookupChannel,
} from './secondary-pane';

// Tiny in-memory channel directory used for the URL → state matrix.
// Mirrors the shape ChannelListItem exposes to the secondary selector
// (only the fields the selector actually reads).
const channels: SecondaryLookupChannel[] = [
  {
    id: 'c-primary',
    kind: 'channel',
    parent_conversation_id: null,
    workspace_id: 'w-1',
  },
  {
    id: 'c-other',
    kind: 'channel',
    parent_conversation_id: null,
    workspace_id: 'w-1',
  },
  {
    id: 't-of-primary',
    kind: 'thread',
    parent_conversation_id: 'c-primary',
    workspace_id: 'w-1',
  },
  {
    id: 'dm-self',
    kind: 'dm_channel',
    parent_conversation_id: null,
    workspace_id: 'w-1',
  },
];

describe('selectSecondaryDescriptor — URL priority matrix', () => {
  it('returns null when neither ?side nor /t/<tid> is set', () => {
    const out = selectSecondaryDescriptor(
      { sideConversationId: null, threadId: null },
      channels,
    );
    expect(out).toBeNull();
  });

  it('resolves a same-workspace ?side=<channel> to source=side', () => {
    const out = selectSecondaryDescriptor(
      { sideConversationId: 'c-other', threadId: null },
      channels,
    );
    expect(out).toEqual({
      source: 'side',
      status: 'resolved',
      id: 'c-other',
      kind: 'channel',
      parentChannelId: null,
      workspaceId: 'w-1',
    });
  });

  it('resolves a same-workspace ?side=<thread> with parent metadata', () => {
    const out = selectSecondaryDescriptor(
      { sideConversationId: 't-of-primary', threadId: null },
      channels,
    );
    expect(out).toEqual({
      source: 'side',
      status: 'resolved',
      id: 't-of-primary',
      kind: 'thread',
      parentChannelId: 'c-primary',
      workspaceId: 'w-1',
    });
  });

  it('returns unresolved placeholder when ?side id is not in lookup', () => {
    const out = selectSecondaryDescriptor(
      { sideConversationId: 'c-foreign', threadId: null },
      channels,
    );
    expect(out).toEqual({
      source: 'side',
      status: 'unresolved',
      id: 'c-foreign',
    });
  });

  it('falls back to /t/<tid> when no ?side is set', () => {
    const out = selectSecondaryDescriptor(
      { sideConversationId: null, threadId: 't-of-primary' },
      channels,
    );
    expect(out).toMatchObject({
      source: 'thread-path',
      status: 'resolved',
      id: 't-of-primary',
      kind: 'thread',
      parentChannelId: 'c-primary',
    });
  });

  it('?side wins over /t/<tid> when both are present (priority table)', () => {
    const out = selectSecondaryDescriptor(
      { sideConversationId: 'c-other', threadId: 't-of-primary' },
      channels,
    );
    expect(out?.source).toBe('side');
    expect(out).toMatchObject({ id: 'c-other' });
  });

  it('?side unresolved still wins over a resolvable /t/<tid> (no silent strip)', () => {
    // Cindy review point 6: never silently drop ?side. Even if the
    // path-thread *would* resolve, the user-typed `?side` reference
    // takes precedence and surfaces as the unresolved placeholder.
    const out = selectSecondaryDescriptor(
      { sideConversationId: 'c-foreign', threadId: 't-of-primary' },
      channels,
    );
    expect(out).toEqual({
      source: 'side',
      status: 'unresolved',
      id: 'c-foreign',
    });
  });

  it('returns null when /t/<tid> is not in lookup (no ephemeral here)', () => {
    // App.tsx folds ephemeralThread into channelsForLookup, so a
    // freshly-created thread DOES resolve at runtime. The selector
    // itself, given just the persisted lookup, returns null and lets
    // the parent-mismatch effect handle the bad-id case.
    const out = selectSecondaryDescriptor(
      { sideConversationId: null, threadId: 't-deleted' },
      channels,
    );
    expect(out).toBeNull();
  });
});

const primary = { id: 'c-primary' as const, kind: 'channel' as const };
const sideChannelDescriptor: SecondaryDescriptor = {
  source: 'side',
  status: 'resolved',
  id: 'c-other',
  kind: 'channel',
  parentChannelId: null,
  workspaceId: 'w-1',
};
const sideThreadDescriptor: SecondaryDescriptor = {
  source: 'side',
  status: 'resolved',
  id: 't-of-primary',
  kind: 'thread',
  parentChannelId: 'c-primary',
  workspaceId: 'w-1',
};
const threadPathDescriptor: SecondaryDescriptor = {
  source: 'thread-path',
  status: 'resolved',
  id: 't-of-primary',
  kind: 'thread',
  parentChannelId: 'c-primary',
  workspaceId: 'w-1',
};
const unresolvedSide: SecondaryDescriptor = {
  source: 'side',
  status: 'unresolved',
  id: 'c-foreign',
};

describe('selectVisibleConversations — read-cursor visibility matrix', () => {
  it('only primary visible when no secondary', () => {
    const out = selectVisibleConversations({
      primary,
      secondary: null,
      fullscreen: false,
    });
    expect(out).toEqual({ primary, secondary: null });
  });

  it('both visible when resolved secondary present (split view)', () => {
    const out = selectVisibleConversations({
      primary,
      secondary: sideChannelDescriptor,
      fullscreen: false,
    });
    expect(out).toEqual({
      primary,
      secondary: { id: 'c-other', kind: 'channel' },
    });
  });

  it('only secondary visible when fullscreen + resolved secondary', () => {
    const out = selectVisibleConversations({
      primary,
      secondary: threadPathDescriptor,
      fullscreen: true,
    });
    expect(out).toEqual({
      primary: null,
      secondary: { id: 't-of-primary', kind: 'thread' },
    });
  });

  it('only primary visible when secondary is unresolved (placeholder has no id to mark read)', () => {
    const out = selectVisibleConversations({
      primary,
      secondary: unresolvedSide,
      fullscreen: false,
    });
    expect(out).toEqual({ primary, secondary: null });
  });

  it('fullscreen with no secondary is a no-op (primary stays visible)', () => {
    const out = selectVisibleConversations({
      primary,
      secondary: null,
      fullscreen: true,
    });
    expect(out).toEqual({ primary, secondary: null });
  });

  it('fullscreen + unresolved secondary still shows primary (placeholder has no read cursor)', () => {
    // The placeholder pane covers the viewport visually but contributes
    // no conversation to advance read cursors for. Primary stays in the
    // visible set so its cursor still moves on stream events.
    const out = selectVisibleConversations({
      primary,
      secondary: unresolvedSide,
      fullscreen: true,
    });
    expect(out).toEqual({ primary, secondary: null });
  });
});

describe('selectFocusedConversation — single-id focus rule', () => {
  it('returns primary when no secondary', () => {
    const out = selectFocusedConversation({
      primary,
      primaryWorkspaceId: 'w-1',
      secondary: null,
      fullscreen: false,
    });
    expect(out).toEqual({ id: 'c-primary', kind: 'channel', workspaceId: 'w-1' });
  });

  it('resolved secondary wins over primary (preserves legacy openThreadId ?? selectedChannelId)', () => {
    const out = selectFocusedConversation({
      primary,
      primaryWorkspaceId: 'w-1',
      secondary: sideThreadDescriptor,
      fullscreen: false,
    });
    expect(out).toEqual({
      id: 't-of-primary',
      kind: 'thread',
      workspaceId: 'w-1',
    });
  });

  it('fullscreen + secondary keeps secondary focused (the only visible pane)', () => {
    const out = selectFocusedConversation({
      primary,
      primaryWorkspaceId: 'w-1',
      secondary: threadPathDescriptor,
      fullscreen: true,
    });
    expect(out?.id).toBe('t-of-primary');
  });

  it('unresolved secondary does NOT take focus — primary keeps it', () => {
    // Toast suppression / notification-badge clearing should target a
    // real conversation, never the placeholder.
    const out = selectFocusedConversation({
      primary,
      primaryWorkspaceId: 'w-1',
      secondary: unresolvedSide,
      fullscreen: false,
    });
    expect(out).toEqual({ id: 'c-primary', kind: 'channel', workspaceId: 'w-1' });
  });

  it('returns null when nothing is visible', () => {
    const out = selectFocusedConversation({
      primary: null,
      primaryWorkspaceId: null,
      secondary: null,
      fullscreen: false,
    });
    expect(out).toBeNull();
  });

  it('side channel-typed secondary still wins focus (sigil click ux)', () => {
    // PR-3 will route sigil clicks through `openSide(id)`. The secondary
    // pointer is then a channel (not a thread), but the focus rule must
    // still hand attention to the side overlay so toasts for that
    // conversation don't fire while the user is reading it.
    const out = selectFocusedConversation({
      primary,
      primaryWorkspaceId: 'w-1',
      secondary: sideChannelDescriptor,
      fullscreen: false,
    });
    expect(out?.id).toBe('c-other');
    expect(out?.kind).toBe('channel');
  });
});

describe('shouldSecondaryFullscreen — render-time fullscreen gate', () => {
  it('false when there is no secondary at all', () => {
    expect(shouldSecondaryFullscreen(null, true)).toBe(false);
    expect(shouldSecondaryFullscreen(null, false)).toBe(false);
  });

  it('false when fullscreen flag is off (split / overlay render)', () => {
    expect(shouldSecondaryFullscreen(sideChannelDescriptor, false)).toBe(false);
    expect(shouldSecondaryFullscreen(threadPathDescriptor, false)).toBe(false);
    expect(shouldSecondaryFullscreen(unresolvedSide, false)).toBe(false);
  });

  it('true only when secondary is resolved AND fullscreen is set', () => {
    expect(shouldSecondaryFullscreen(sideChannelDescriptor, true)).toBe(true);
    expect(shouldSecondaryFullscreen(sideThreadDescriptor, true)).toBe(true);
    expect(shouldSecondaryFullscreen(threadPathDescriptor, true)).toBe(true);
  });

  it('false for unresolved + fullscreen — DOM falls back to split, no state/render fork', () => {
    // This is the bug Cindy flagged in commit `e9278a7`. Without the
    // gate, `routeFullscreen && secondaryView` rendered only the
    // placeholder while `selectVisibleConversations` /
    // `selectFocusedConversation` kept primary in the visible/focused
    // set — primary's read cursor and notification badge advanced
    // even though the user never saw it.
    expect(shouldSecondaryFullscreen(unresolvedSide, true)).toBe(false);
  });
});
