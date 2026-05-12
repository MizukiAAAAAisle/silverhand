import { describe, expect, it } from 'vitest';
import { parseRouteState, withSideQuery } from './router';

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
