import { describe, expect, it } from 'vitest';
import {
  buildChannelPathPreservingSide,
  buildSideOpenUrl,
  parseRouteState,
  withSideQuery,
} from './router';

// Tests focus on the URL → state matrix introduced by PR-1: how the new
// `?side=<id>` query param interacts with the legacy `/t/<tid>` path
// segment and the `?fullscreen=1` flag. The pure parser keeps these
// shapes deterministic; the React selectors layer on top.
describe('parseRouteState — chat URL matrix', () => {
  it('parses workspace + channel without secondary', () => {
    const r = parseRouteState('/chat/w/w-1/c/c-a', '');
    expect(r).toMatchObject({
      section: 'chat',
      chatView: 'channel',
      workspaceId: 'w-1',
      channelId: 'c-a',
      threadId: null,
      sideConversationId: null,
      fullscreen: false,
      threadFullscreen: false,
    });
  });

  it('parses /t/<tid> as legacy thread (no ?side)', () => {
    const r = parseRouteState('/chat/w/w-1/c/c-a/t/t-1', '');
    expect(r).toMatchObject({
      threadId: 't-1',
      sideConversationId: null,
      fullscreen: false,
      threadFullscreen: false,
    });
  });

  it('parses ?side=<id> alone', () => {
    const r = parseRouteState('/chat/w/w-1/c/c-a', '?side=c-other');
    expect(r).toMatchObject({
      threadId: null,
      sideConversationId: 'c-other',
      fullscreen: false,
      threadFullscreen: false,
    });
  });

  it('preserves ?side AND /t/<tid> simultaneously (priority handled by selector)', () => {
    // Parsing must NOT drop either field — the priority decision
    // (side > thread) lives in the selector layer so callers can audit
    // the raw URL state.
    const r = parseRouteState('/chat/w/w-1/c/c-a/t/t-1', '?side=c-other');
    expect(r).toMatchObject({
      threadId: 't-1',
      sideConversationId: 'c-other',
    });
  });

  it('?fullscreen=1 + /t/<tid> (no side) marks threadFullscreen=true', () => {
    const r = parseRouteState('/chat/w/w-1/c/c-a/t/t-1', '?fullscreen=1');
    expect(r.fullscreen).toBe(true);
    expect(r.threadFullscreen).toBe(true);
  });

  it('?fullscreen=1 + ?side suppresses threadFullscreen (back-compat shorthand only fires for path-thread)', () => {
    // `threadFullscreen` is the legacy back-compat shorthand for "the
    // path-thread is fullscreen". When `?side` is present it wins as
    // secondary, so the path-thread is no longer the visible one and
    // the shorthand goes false. Generic `fullscreen` stays true (and
    // applies to the side per the priority table).
    const r = parseRouteState(
      '/chat/w/w-1/c/c-a/t/t-1',
      '?side=c-other&fullscreen=1',
    );
    expect(r.fullscreen).toBe(true);
    expect(r.threadFullscreen).toBe(false);
  });

  it('treats empty ?side= as unset (defensive — prevents spurious unresolved placeholder)', () => {
    const r = parseRouteState('/chat/w/w-1/c/c-a', '?side=');
    expect(r.sideConversationId).toBeNull();
  });

  it('preserves ad-hoc query params untouched', () => {
    // Non-relevant query params (analytics, future flags, etc.) must
    // not be lost by the parser — withSideQuery preserves them too.
    const r = parseRouteState(
      '/chat/w/w-1/c/c-a',
      '?side=c-other&utm_source=test',
    );
    expect(r.sideConversationId).toBe('c-other');
  });

  it('saved/search/archived chat views still parse', () => {
    expect(parseRouteState('/chat/saved', '').chatView).toBe('saved');
    expect(parseRouteState('/chat/search', '').chatView).toBe('search');
    expect(parseRouteState('/chat/archived', '').chatView).toBe('archived');
  });

  it('non-chat sections set section + leave chat ids null', () => {
    const r = parseRouteState('/members/agent-1', '');
    expect(r.section).toBe('members');
    expect(r.agentId).toBe('agent-1');
    expect(r.workspaceId).toBeNull();
  });
});

describe('withSideQuery — URL writer for openSide / closeSide', () => {
  it('writes ?side=<id> on a bare path', () => {
    const out = withSideQuery('/chat/w/w-1/c/c-a', '', 'c-other');
    expect(out).toBe('/chat/w/w-1/c/c-a?side=c-other');
  });

  it('overwrites an existing ?side', () => {
    const out = withSideQuery(
      '/chat/w/w-1/c/c-a',
      '?side=c-old',
      'c-new',
    );
    expect(out).toBe('/chat/w/w-1/c/c-a?side=c-new');
  });

  it('preserves /t/<tid> on the path so closeSide falls back to thread', () => {
    // The whole point of the overlay model: closing `?side` should not
    // touch the legacy thread path. The thread reappears as secondary.
    const before = '/chat/w/w-1/c/c-a/t/t-1';
    const opened = withSideQuery(before, '', 'c-other');
    expect(opened).toBe(`${before}?side=c-other`);
    const closed = withSideQuery(before, '?side=c-other', null);
    expect(closed).toBe(before); // path-thread untouched
  });

  it('strips ?side AND ?fullscreen on close', () => {
    // closeSide must drop fullscreen too — leaving fullscreen=1
    // dangling after closing a fullscreened side overlay would yank
    // the underlying thread (or primary) into fullscreen mode
    // unexpectedly.
    const out = withSideQuery(
      '/chat/w/w-1/c/c-a/t/t-1',
      '?side=c-other&fullscreen=1',
      null,
    );
    expect(out).toBe('/chat/w/w-1/c/c-a/t/t-1');
  });

  it('preserves unrelated query params on both open and close', () => {
    const opened = withSideQuery(
      '/chat/w/w-1/c/c-a',
      '?utm_source=test',
      'c-other',
    );
    expect(opened).toContain('utm_source=test');
    expect(opened).toContain('side=c-other');
    const closed = withSideQuery(
      '/chat/w/w-1/c/c-a',
      '?side=c-other&utm_source=test',
      null,
    );
    expect(closed).toBe('/chat/w/w-1/c/c-a?utm_source=test');
  });
});

describe('buildSideOpenUrl — openSide URL writer (PR-4 follow-up)', () => {
  // The whole point: sigil clicks promise "side pane, doesn't replace
  // your main view". If openSide inherited a stale `?fullscreen=1`,
  // `shouldSecondaryFullscreen` would render only the side and HIDE the
  // primary + path-thread the user was reading. Locking this behavior
  // here so a future refactor can't silently regress the prompt promise.

  it('writes ?side=<id> on a bare path', () => {
    expect(buildSideOpenUrl('/chat/w/w-1/c/c-a', '', 'c-other')).toBe(
      '/chat/w/w-1/c/c-a?side=c-other',
    );
  });

  it('strips ?fullscreen when opening side from a fullscreen thread', () => {
    // User was at /chat/w/w-1/c/c-a/t/t-1?fullscreen=1 (thread fullscreen).
    // Clicking #~<id> must NOT inherit fullscreen — that would hide both
    // the channel and the thread under a fullscreen side pane.
    const out = buildSideOpenUrl(
      '/chat/w/w-1/c/c-a/t/t-1',
      '?fullscreen=1',
      'c-other',
    );
    expect(out).toBe('/chat/w/w-1/c/c-a/t/t-1?side=c-other');
    expect(out).not.toContain('fullscreen');
  });

  it('preserves /t/<tid> on the path so closeSide falls back to thread', () => {
    const out = buildSideOpenUrl(
      '/chat/w/w-1/c/c-a/t/t-1',
      '',
      'c-other',
    );
    expect(out).toBe('/chat/w/w-1/c/c-a/t/t-1?side=c-other');
  });

  it('preserves unrelated query params and overwrites stale ?side', () => {
    const out = buildSideOpenUrl(
      '/chat/w/w-1/c/c-a',
      '?utm_source=test&side=c-old&fullscreen=1',
      'c-new',
    );
    expect(out).toContain('utm_source=test');
    expect(out).toContain('side=c-new');
    expect(out).not.toContain('side=c-old');
    expect(out).not.toContain('fullscreen');
  });
});

describe('buildChannelPathPreservingSide — view-in-channel keeps side overlay', () => {
  // PR-2 blocker per Cindy review of msg `tEZtWtHiHzpq8PxC`: clicking
  // "View in channel" on a cross-workspace `?side=<thread>` previously
  // navigated primary via `nav.toChannel(wid, cid)`, which writes a
  // bare path and silently drops `?side`. The user's open thread
  // disappears even though they only asked to see its parent. This
  // helper builds the URL with `?side` preserved, and is wired into
  // `handleJumpToOriginal` for the `?side` source.
  it('writes /chat/w/<wid>/c/<cid>?side=<sideId> for cross-workspace parent jump', () => {
    expect(
      buildChannelPathPreservingSide('w-other', 'c-parent', 't-side-thread'),
    ).toBe('/chat/w/w-other/c/c-parent?side=t-side-thread');
  });

  it('keeps the side overlay even when destination workspace differs from the side', () => {
    // The helper is intentionally indifferent to workspace alignment —
    // `?side=<id>` resolves through `useConversationById` server-side,
    // so any conversation id is legal regardless of the primary's
    // workspace. The helper just writes the URL.
    const out = buildChannelPathPreservingSide('w-A', 'c-A', 't-in-w-B');
    expect(out).toBe('/chat/w/w-A/c/c-A?side=t-in-w-B');
  });

  it('does not propagate ?fullscreen — view-in-channel implies the user wants primary visible', () => {
    // Hard contract: the helper takes only (workspaceId, channelId,
    // sideId). It never reads or writes `?fullscreen`. Asserting via
    // shape — output never contains the substring.
    const out = buildChannelPathPreservingSide('w-1', 'c-1', 't-1');
    expect(out).not.toContain('fullscreen');
  });
});
