import { describe, expect, it } from 'vitest';
import type { ConversationByIdResult } from '@/features/conversations/useConversationById';
import type { ConversationRef } from '@silverhand/shared';
import {
  selectFocusedConversation,
  selectSecondaryDescriptor,
  selectSecondaryViewInputs,
  selectSecondaryWorkspaceContext,
  selectVisibleConversations,
  shouldSecondaryFullscreen,
  type SecondaryDescriptor,
} from './secondary-pane';

function makeRefResult(
  status: ConversationByIdResult['status'],
  ref?: ConversationRef,
): ConversationByIdResult {
  return { status, ref: ref ?? null };
}

const localChannelRef: ConversationRef = {
  id: 'c-other',
  kind: 'channel',
  title: 'planning',
  workspace_id: 'w-1',
  workspace_kind: 'regular',
  workspace_path: '/tmp/w-1',
  parent_channel_id: null,
  parent_title: null,
  closed_at: null,
  archived_at: null,
};

const foreignChannelRef: ConversationRef = {
  id: 'c-foreign',
  kind: 'channel',
  title: 'team-y planning',
  workspace_id: 'w-2',
  workspace_kind: 'regular',
  workspace_path: '/tmp/w-2',
  parent_channel_id: null,
  parent_title: null,
  closed_at: null,
  archived_at: null,
};

const foreignDmRef: ConversationRef = {
  id: 'dm-foreign',
  kind: 'dm_channel',
  title: 'dm-bob',
  workspace_id: 'w-bob-home',
  workspace_kind: 'dm',
  workspace_path: '/tmp/w-bob-home',
  parent_channel_id: null,
  parent_title: null,
  closed_at: null,
  archived_at: null,
};

describe('selectSecondaryDescriptor — URL × ref-hook matrix', () => {
  it('returns null when ?side is not set', () => {
    const out = selectSecondaryDescriptor({ sideConversationId: null }, null);
    expect(out).toBeNull();
  });

  it('?side resolved (same workspace) carries full ref metadata', () => {
    const out = selectSecondaryDescriptor(
      { sideConversationId: 'c-other' },
      makeRefResult('resolved', localChannelRef),
    );
    expect(out).toEqual({
      source: 'side',
      status: 'resolved',
      id: 'c-other',
      kind: 'channel',
      title: 'planning',
      parentChannelId: null,
      parentTitle: null,
      workspaceId: 'w-1',
      workspaceKind: 'regular',
      workspacePath: '/tmp/w-1',
      closedAt: null,
      archivedAt: null,
    });
  });

  it('?side resolved (cross-workspace) surfaces the foreign workspace meta', () => {
    // The whole point of PR-2: `?side=<id>` may live in a workspace
    // other than the one currently in the primary pane.
    const out = selectSecondaryDescriptor(
      { sideConversationId: 'c-foreign' },
      makeRefResult('resolved', foreignChannelRef),
    );
    expect(out).toMatchObject({
      source: 'side',
      status: 'resolved',
      id: 'c-foreign',
      workspaceId: 'w-2',
      workspaceKind: 'regular',
      workspacePath: '/tmp/w-2',
    });
  });

  it("?side resolved to a dm projects workspace_kind='dm' through to the descriptor", () => {
    const out = selectSecondaryDescriptor(
      { sideConversationId: 'dm-foreign' },
      makeRefResult('resolved', foreignDmRef),
    );
    expect(out).toMatchObject({
      source: 'side',
      status: 'resolved',
      kind: 'dm_channel',
      workspaceKind: 'dm',
    });
  });

  it('?side loading produces a loading descriptor that still carries the id', () => {
    // Placeholder/skeleton needs the id to render `#conv:<id>` and offer
    // a Close button while the ref hook is in-flight.
    const out = selectSecondaryDescriptor(
      { sideConversationId: 'c-foreign' },
      makeRefResult('loading'),
    );
    expect(out).toEqual({ source: 'side', status: 'loading', id: 'c-foreign' });
  });

  it("?side null sideRef defaults to loading (component hasn't emitted yet)", () => {
    const out = selectSecondaryDescriptor(
      { sideConversationId: 'c-foreign' },
      null,
    );
    expect(out).toEqual({ source: 'side', status: 'loading', id: 'c-foreign' });
  });

  it('?side unauthorized surfaces the placeholder status (not silently stripped)', () => {
    const out = selectSecondaryDescriptor(
      { sideConversationId: 'c-foreign' },
      makeRefResult('unauthorized'),
    );
    expect(out).toEqual({
      source: 'side',
      status: 'unauthorized',
      id: 'c-foreign',
    });
  });

  it('?side not_found surfaces the placeholder status (not silently stripped)', () => {
    const out = selectSecondaryDescriptor(
      { sideConversationId: 'c-foreign' },
      makeRefResult('not_found'),
    );
    expect(out).toEqual({
      source: 'side',
      status: 'not_found',
      id: 'c-foreign',
    });
  });
});

const primary = { id: 'c-primary' as const, kind: 'channel' as const };
const sideChannelDescriptor: SecondaryDescriptor = {
  source: 'side',
  status: 'resolved',
  id: 'c-other',
  kind: 'channel',
  title: 'planning',
  parentChannelId: null,
  parentTitle: null,
  workspaceId: 'w-1',
  workspaceKind: 'regular',
  workspacePath: '/tmp/w-1',
  closedAt: null,
  archivedAt: null,
};
// A second resolved channel-kind side (distinct id from primary) to
// exercise the downstream pure selectors on a resolved secondary.
const sideSecondDescriptor: SecondaryDescriptor = {
  source: 'side',
  status: 'resolved',
  id: 't-of-primary',
  kind: 'channel',
  title: 'investigations',
  parentChannelId: null,
  parentTitle: null,
  workspaceId: 'w-1',
  workspaceKind: 'regular',
  workspacePath: '/tmp/w-1',
  closedAt: null,
  archivedAt: null,
};
const foreignSideDescriptor: SecondaryDescriptor = {
  source: 'side',
  status: 'resolved',
  id: 'c-foreign',
  kind: 'channel',
  title: 'team-y planning',
  parentChannelId: null,
  parentTitle: null,
  workspaceId: 'w-2',
  workspaceKind: 'regular',
  workspacePath: '/tmp/w-2',
  closedAt: null,
  archivedAt: null,
};
const loadingSide: SecondaryDescriptor = {
  source: 'side',
  status: 'loading',
  id: 'c-foreign',
};
const unauthorizedSide: SecondaryDescriptor = {
  source: 'side',
  status: 'unauthorized',
  id: 'c-foreign',
};
const notFoundSide: SecondaryDescriptor = {
  source: 'side',
  status: 'not_found',
  id: 'c-foreign',
};

describe('selectSecondaryWorkspaceContext — workspace prop projection', () => {
  it('returns null when there is no secondary', () => {
    expect(selectSecondaryWorkspaceContext(null)).toBeNull();
  });

  it('returns null for non-resolved side (placeholder, no workspace yet)', () => {
    expect(selectSecondaryWorkspaceContext(loadingSide)).toBeNull();
    expect(selectSecondaryWorkspaceContext(unauthorizedSide)).toBeNull();
    expect(selectSecondaryWorkspaceContext(notFoundSide)).toBeNull();
  });

  it('projects workspace id/kind/path for a resolved side descriptor', () => {
    expect(selectSecondaryWorkspaceContext(foreignSideDescriptor)).toEqual({
      workspaceId: 'w-2',
      workspaceKind: 'regular',
      workspacePath: '/tmp/w-2',
    });
  });
});

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
      secondary: sideSecondDescriptor,
      fullscreen: true,
    });
    expect(out).toEqual({
      primary: null,
      secondary: { id: 't-of-primary', kind: 'channel' },
    });
  });

  it('only primary visible when secondary is loading (placeholder has no id to mark read)', () => {
    const out = selectVisibleConversations({
      primary,
      secondary: loadingSide,
      fullscreen: false,
    });
    expect(out).toEqual({ primary, secondary: null });
  });

  it('only primary visible when secondary is unauthorized', () => {
    const out = selectVisibleConversations({
      primary,
      secondary: unauthorizedSide,
      fullscreen: false,
    });
    expect(out).toEqual({ primary, secondary: null });
  });

  it('only primary visible when secondary is not_found', () => {
    const out = selectVisibleConversations({
      primary,
      secondary: notFoundSide,
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

  it('fullscreen + non-resolved secondary still shows primary (placeholder has no read cursor)', () => {
    // The placeholder pane covers the viewport visually but contributes
    // no conversation to advance read cursors for. Primary stays in the
    // visible set so its cursor still moves on stream events.
    const out = selectVisibleConversations({
      primary,
      secondary: loadingSide,
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
      secondary: sideSecondDescriptor,
      fullscreen: false,
    });
    expect(out).toEqual({
      id: 't-of-primary',
      kind: 'channel',
      workspaceId: 'w-1',
    });
  });

  it('cross-workspace resolved secondary focuses on the *foreign* workspace id', () => {
    // PR-2 cross-workspace IPC contract: setActiveConversation must
    // emit the workspace the focused conversation lives in, not the
    // primary pane's workspace.
    const out = selectFocusedConversation({
      primary,
      primaryWorkspaceId: 'w-1',
      secondary: foreignSideDescriptor,
      fullscreen: false,
    });
    expect(out).toEqual({
      id: 'c-foreign',
      kind: 'channel',
      workspaceId: 'w-2',
    });
  });

  it('fullscreen + secondary keeps secondary focused (the only visible pane)', () => {
    const out = selectFocusedConversation({
      primary,
      primaryWorkspaceId: 'w-1',
      secondary: sideSecondDescriptor,
      fullscreen: true,
    });
    expect(out?.id).toBe('t-of-primary');
  });

  it('non-resolved secondary does NOT take focus — primary keeps it', () => {
    // Toast suppression / notification-badge clearing should target a
    // real conversation, never the placeholder. Same rule for the
    // three non-resolved statuses.
    for (const ph of [loadingSide, unauthorizedSide, notFoundSide]) {
      const out = selectFocusedConversation({
        primary,
        primaryWorkspaceId: 'w-1',
        secondary: ph,
        fullscreen: false,
      });
      expect(out).toEqual({ id: 'c-primary', kind: 'channel', workspaceId: 'w-1' });
    }
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
    expect(shouldSecondaryFullscreen(sideSecondDescriptor, false)).toBe(false);
    expect(shouldSecondaryFullscreen(loadingSide, false)).toBe(false);
  });

  it('true only when secondary is resolved AND fullscreen is set', () => {
    expect(shouldSecondaryFullscreen(sideChannelDescriptor, true)).toBe(true);
    expect(shouldSecondaryFullscreen(sideSecondDescriptor, true)).toBe(true);
    expect(shouldSecondaryFullscreen(foreignSideDescriptor, true)).toBe(true);
  });

  it('false for any non-resolved status + fullscreen — DOM falls back to split', () => {
    // This is the bug Cindy flagged in commit `e9278a7`. Without the
    // gate, `routeFullscreen && secondaryView` rendered only the
    // placeholder while `selectVisibleConversations` /
    // `selectFocusedConversation` kept primary in the visible/focused
    // set — primary's read cursor and notification badge advanced
    // even though the user never saw it. The same rule applies to all
    // three non-resolved statuses introduced by PR-2.
    expect(shouldSecondaryFullscreen(loadingSide, true)).toBe(false);
    expect(shouldSecondaryFullscreen(unauthorizedSide, true)).toBe(false);
    expect(shouldSecondaryFullscreen(notFoundSide, true)).toBe(false);
  });
});

// ── PR-2 cross-workspace integration: end-to-end descriptor → ChannelView prop chain ──

describe('selectSecondaryViewInputs — full descriptor → ChannelView prop chain', () => {
  it('returns null/primary fallbacks when there is no secondary', () => {
    const out = selectSecondaryViewInputs({
      secondary: null,
      primaryChannelKind: 'regular',
      primaryWorkspaceId: 'w-1',
    });
    expect(out).toEqual({
      conversationDescriptor: null,
      channelKind: 'regular',
      parentTitle: null,
      archiveWorkspaceId: 'w-1',
    });
  });

  it('cross-workspace ?side resolved channel: ChannelView gets the *foreign* workspace id/kind/path', () => {
    // The end-to-end assertion Cindy asked for (PR-2 review):
    // "?side=<other-workspace-channel> resolved 后，ChannelView 收到
    // other workspace id/kind/path，focused IPC 也用 other workspace
    // id." This locks the descriptor → ChannelView prop chain so a
    // future refactor can't quietly fall back to the primary's
    // workspace metadata.
    const foreignSide: SecondaryDescriptor = {
      source: 'side',
      status: 'resolved',
      id: 'c-foreign',
      kind: 'channel',
      title: 'team-y planning',
      parentChannelId: null,
      parentTitle: null,
      workspaceId: 'w-2',
      workspaceKind: 'regular',
      workspacePath: '/tmp/w-2',
      closedAt: null,
      archivedAt: null,
    };
    const out = selectSecondaryViewInputs({
      secondary: foreignSide,
      // Primary is on a different workspace, with a different kind.
      // The foreign side must IGNORE these primary fallbacks.
      primaryChannelKind: 'dm',
      primaryWorkspaceId: 'w-1',
    });
    expect(out.conversationDescriptor).toEqual({
      id: 'c-foreign',
      title: 'team-y planning',
      kind: 'channel',
      parent_conversation_id: null,
      closed_at: null,
      archived_at: null,
      // The whole point: ChannelView's workspace_id is the FOREIGN
      // one, not the primary's. Workspace-scoped hooks inside ChannelView
      // then target the right workspace cache.
      workspace_id: 'w-2',
    });
    // ChannelView's `channelKind` projects from the FOREIGN workspace,
    // not from `primaryChannelKind`. (Renderer never sees agent_home.)
    expect(out.channelKind).toBe('regular');
    expect(out.parentTitle).toBeNull();
    // Archive mutation invalidation targets the FOREIGN workspace.
    expect(out.archiveWorkspaceId).toBe('w-2');
  });

  it('cross-workspace ?side resolved DM: workspace_kind projects to "dm" (not agent_home)', () => {
    // Forward-compatibility check: the renderer only knows
    // `regular | dm`. The ref endpoint is responsible for projecting
    // `agent_home → dm` server-side; this test locks that the
    // selector pipes that projection through to ChannelView's
    // `channelKind` prop unchanged.
    const foreignDmSide: SecondaryDescriptor = {
      source: 'side',
      status: 'resolved',
      id: 'dm-bob',
      kind: 'dm_channel',
      title: 'dm-bob',
      parentChannelId: null,
      parentTitle: null,
      workspaceId: 'w-bob-home',
      workspaceKind: 'dm',
      workspacePath: '/tmp/w-bob-home',
      closedAt: null,
      archivedAt: null,
    };
    const out = selectSecondaryViewInputs({
      secondary: foreignDmSide,
      primaryChannelKind: 'regular',
      primaryWorkspaceId: 'w-1',
    });
    expect(out.conversationDescriptor?.workspace_id).toBe('w-bob-home');
    expect(out.conversationDescriptor?.kind).toBe('dm_channel');
    expect(out.channelKind).toBe('dm');
    expect(out.archiveWorkspaceId).toBe('w-bob-home');
  });

  it('same-workspace ?side resolved channel: still routes through the ref descriptor', () => {
    // Even when the side conversation lives in the same workspace as
    // primary, PR-2 routes through the ref hook for consistency.
    const localSide: SecondaryDescriptor = {
      source: 'side',
      status: 'resolved',
      id: 'c-other',
      kind: 'channel',
      title: 'planning',
      parentChannelId: null,
      parentTitle: null,
      workspaceId: 'w-1',
      workspaceKind: 'regular',
      workspacePath: '/tmp/w-1',
      closedAt: null,
      archivedAt: null,
    };
    const out = selectSecondaryViewInputs({
      secondary: localSide,
      primaryChannelKind: 'regular',
      primaryWorkspaceId: 'w-1',
    });
    expect(out.conversationDescriptor?.workspace_id).toBe('w-1');
    expect(out.archiveWorkspaceId).toBe('w-1');
  });

  it('non-resolved ?side: descriptor null, primary fallbacks (placeholder pane handles render)', () => {
    const loadingDesc: SecondaryDescriptor = {
      source: 'side',
      status: 'loading',
      id: 'c-foreign',
    };
    const out = selectSecondaryViewInputs({
      secondary: loadingDesc,
      primaryChannelKind: 'regular',
      primaryWorkspaceId: 'w-1',
    });
    expect(out).toEqual({
      conversationDescriptor: null,
      channelKind: 'regular',
      parentTitle: null,
      archiveWorkspaceId: 'w-1',
    });
  });
});
