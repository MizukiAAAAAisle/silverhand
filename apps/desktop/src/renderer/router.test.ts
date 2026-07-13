import { describe, expect, it } from 'vitest';
import {
  buildAgentPanelOpenUrl,
  buildChannelLayoutUrl,
  buildChannelPathPreservingAgent,
  buildChannelPathPreservingSide,
  buildSideOpenUrl,
  buildTaskOpenUrl,
  buildThreadOpenUrl,
  layoutMemoryFromRoute,
  parseRouteState,
  withAgentQuery,
  withSideQuery,
  withTaskQuery,
  withThreadQuery,
  withThreadsQuery,
  withFilesQuery,
} from './router';
import type { SecondaryRouteFields } from './router';

// Tests focus on the URL → state matrix: the base path is
// `/chat/w/:workspaceId/c/:channelId` (the legacy `/t/<threadId>` fossil
// path segment was removed with the isolated-thread viewer) plus the
// `?side` / `?thread` / `?threads` / `?fullscreen` / `?task` query
// params. The pure parser keeps these shapes deterministic; the React
// selectors layer on top.
describe('parseRouteState — chat URL matrix', () => {
  it('parses workspace + channel without secondary', () => {
    const r = parseRouteState('/chat/w/w-1/c/c-a', '');
    expect(r).toMatchObject({
      section: 'chat',
      chatView: 'channel',
      workspaceId: 'w-1',
      channelId: 'c-a',
      sideConversationId: null,
      fullscreen: false,
    });
  });

  it('parses ?side=<id> alone', () => {
    const r = parseRouteState('/chat/w/w-1/c/c-a', '?side=c-other');
    expect(r).toMatchObject({
      sideConversationId: 'c-other',
      fullscreen: false,
    });
  });

  it('parses ?side with ?fullscreen=1', () => {
    const r = parseRouteState('/chat/w/w-1/c/c-a', '?side=c-other&fullscreen=1');
    expect(r.sideConversationId).toBe('c-other');
    expect(r.fullscreen).toBe(true);
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
    expect(r.userId).toBeNull();
    expect(r.workspaceId).toBeNull();
  });

  it('parses /members/u/:userId into userId and leaves agentId null', () => {
    const r = parseRouteState('/members/u/u-1', '');
    expect(r.section).toBe('members');
    expect(r.userId).toBe('u-1');
    expect(r.agentId).toBeNull();
  });

  it('parses bare /activity into the activity section with no channel', () => {
    const r = parseRouteState('/activity', '');
    expect(r.section).toBe('activity');
    expect(r.workspaceId).toBeNull();
    expect(r.channelId).toBeNull();
  });

  it('parses /activity/w/:wid/c/:cid — same channel shape as chat, activity section', () => {
    const r = parseRouteState('/activity/w/w-1/c/c-a', '');
    expect(r).toMatchObject({
      section: 'activity',
      workspaceId: 'w-1',
      channelId: 'c-a',
    });
  });

  it('parses ?thread on an activity channel route (secondary pane shared with chat)', () => {
    const r = parseRouteState('/activity/w/w-1/c/c-a', '?thread=root-1');
    expect(r.section).toBe('activity');
    expect(r.workspaceId).toBe('w-1');
    expect(r.channelId).toBe('c-a');
    expect(r.threadRootId).toBe('root-1');
  });

  it('workspace-only /activity/w/:wid yields NO workspace selection (no third state)', () => {
    // Activity has exactly two states: bare `/activity` (full-width list) and
    // `/activity/w/:wid/c/:cid` (selected). There is no `/activity/w/:wid`
    // route, so a hand-typed one must NOT resolve a phantom workspace — that
    // would show a titlebar / fire ws-scoped queries for a workspace not
    // derived from any selected Activity item (#task:1394 review).
    const r = parseRouteState('/activity/w/w-1', '');
    expect(r.section).toBe('activity');
    expect(r.workspaceId).toBeNull();
    expect(r.channelId).toBeNull();
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

  it('strips ?side on close', () => {
    const before = '/chat/w/w-1/c/c-a';
    const opened = withSideQuery(before, '', 'c-other');
    expect(opened).toBe(`${before}?side=c-other`);
    const closed = withSideQuery(before, '?side=c-other', null);
    expect(closed).toBe(before);
  });

  it('strips ?side AND ?fullscreen on close', () => {
    // closeSide must drop fullscreen too — leaving fullscreen=1
    // dangling after closing a fullscreened side overlay would yank
    // the primary into fullscreen mode unexpectedly.
    const out = withSideQuery(
      '/chat/w/w-1/c/c-a',
      '?side=c-other&fullscreen=1',
      null,
    );
    expect(out).toBe('/chat/w/w-1/c/c-a');
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
  // primary the user was reading. Locking this behavior here so a future
  // refactor can't silently regress the prompt promise.

  it('writes ?side=<id> on a bare path', () => {
    expect(buildSideOpenUrl('/chat/w/w-1/c/c-a', '', 'c-other')).toBe(
      '/chat/w/w-1/c/c-a?side=c-other',
    );
  });

  it('strips ?fullscreen when opening side from a fullscreen view', () => {
    // User was at a fullscreen view. Clicking #conv:<id> must NOT inherit
    // fullscreen — that would hide the channel under a fullscreen side pane.
    const out = buildSideOpenUrl(
      '/chat/w/w-1/c/c-a',
      '?fullscreen=1',
      'c-other',
    );
    expect(out).toBe('/chat/w/w-1/c/c-a?side=c-other');
    expect(out).not.toContain('fullscreen');
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
  // "View in channel" on a cross-workspace `?side=<conv>` previously
  // navigated primary via `nav.toChannel(wid, cid)`, which writes a
  // bare path and silently drops `?side`. The user's open side pane
  // disappears even though they only asked to see its parent. This
  // helper builds the URL with `?side` preserved.
  it('writes /chat/w/<wid>/c/<cid>?side=<sideId> for cross-workspace parent jump', () => {
    expect(
      buildChannelPathPreservingSide('w-other', 'c-parent', 'c-side'),
    ).toBe('/chat/w/w-other/c/c-parent?side=c-side');
  });

  it('keeps the side overlay even when destination workspace differs from the side', () => {
    // The helper is intentionally indifferent to workspace alignment —
    // `?side=<id>` resolves through `useConversationById` server-side,
    // so any conversation id is legal regardless of the primary's
    // workspace. The helper just writes the URL.
    const out = buildChannelPathPreservingSide('w-A', 'c-A', 'c-in-w-B');
    expect(out).toBe('/chat/w/w-A/c/c-A?side=c-in-w-B');
  });

  it('does not propagate ?fullscreen — view-in-channel implies the user wants primary visible', () => {
    // Hard contract: the helper takes only (workspaceId, channelId,
    // sideId). It never reads or writes `?fullscreen`. Asserting via
    // shape — output never contains the substring.
    const out = buildChannelPathPreservingSide('w-1', 'c-1', 'c-side');
    expect(out).not.toContain('fullscreen');
  });
});

describe('parseRouteState — ?task=<n> focused-task pointer (PR-4 commit 2)', () => {
  // The drawer reads `focusedTaskNumber` to scroll-and-highlight the
  // target row. Validation lives here so the drawer stays dumb: it only
  // ever sees a positive integer or null. Anything else (NaN, zero,
  // negative, alphanumeric, empty) coerces to null so we never try to
  // focus a row that can't exist.
  it('parses a positive integer from ?task=<n>', () => {
    const r = parseRouteState('/chat/w/w-1/c/c-a', '?task=42');
    expect(r.focusedTaskNumber).toBe(42);
  });

  it('coerces non-numeric / zero / negative / empty to null', () => {
    expect(parseRouteState('/chat/w/w-1/c/c-a', '?task=').focusedTaskNumber).toBeNull();
    expect(parseRouteState('/chat/w/w-1/c/c-a', '?task=abc').focusedTaskNumber).toBeNull();
    expect(parseRouteState('/chat/w/w-1/c/c-a', '?task=0').focusedTaskNumber).toBeNull();
    expect(parseRouteState('/chat/w/w-1/c/c-a', '?task=-3').focusedTaskNumber).toBeNull();
  });

  it('rejects mixed-suffix / decimal / leading-zero forms (Cindy review of 80f544e)', () => {
    // `parseInt` would silently turn `12abc` into 12 and `1.5` into 1,
    // both pointing at a row the user did not ask for. Strict
    // `/^[1-9]\d*$/` validation refuses anything that isn't a clean
    // positive-integer string. `01` rejects so URLs round-trip
    // unambiguously with the `String(taskNumber)` writer.
    expect(parseRouteState('/chat/w/w-1/c/c-a', '?task=12abc').focusedTaskNumber)
      .toBeNull();
    expect(parseRouteState('/chat/w/w-1/c/c-a', '?task=1.5').focusedTaskNumber)
      .toBeNull();
    expect(parseRouteState('/chat/w/w-1/c/c-a', '?task=01').focusedTaskNumber)
      .toBeNull();
    expect(parseRouteState('/chat/w/w-1/c/c-a', '?task=  7  ').focusedTaskNumber)
      .toBeNull();
  });

  it('omits ?task entirely → null', () => {
    expect(parseRouteState('/chat/w/w-1/c/c-a', '').focusedTaskNumber).toBeNull();
  });

  it('coexists with ?side and ?fullscreen — independent dimensions', () => {
    // Drawer focus and side overlay are orthogonal URL dimensions; both
    // must survive parsing. The drawer auto-opens via App.tsx based on
    // `focusedTaskNumber`, the side pane via `sideConversationId`.
    const r = parseRouteState(
      '/chat/w/w-1/c/c-a',
      '?side=c-other&task=7&fullscreen=1',
    );
    expect(r.focusedTaskNumber).toBe(7);
    expect(r.sideConversationId).toBe('c-other');
    expect(r.fullscreen).toBe(true);
  });
});

describe('withTaskQuery — URL writer for openTask / closeTask', () => {
  it('writes ?task=<n> on a bare path', () => {
    expect(withTaskQuery('/chat/w/w-1/c/c-a', '', 5)).toBe(
      '/chat/w/w-1/c/c-a?task=5',
    );
  });

  it('overwrites an existing ?task', () => {
    expect(withTaskQuery('/chat/w/w-1/c/c-a', '?task=3', 9)).toBe(
      '/chat/w/w-1/c/c-a?task=9',
    );
  });

  it('strips ?task on close, leaving other params intact', () => {
    // closeTask must drop only `?task` — `?side`, `?fullscreen`, and
    // any unrelated params keep their state. The drawer's open/closed
    // status is React state, decoupled from this URL pointer.
    const out = withTaskQuery(
      '/chat/w/w-1/c/c-a',
      '?side=c-other&task=12&fullscreen=1',
      null,
    );
    expect(out).toContain('side=c-other');
    expect(out).toContain('fullscreen=1');
    expect(out).not.toContain('task=');
  });

  it('returns the bare path when no params remain after close', () => {
    expect(withTaskQuery('/chat/w/w-1/c/c-a', '?task=7', null)).toBe(
      '/chat/w/w-1/c/c-a',
    );
  });

  it('preserves unrelated query params on open', () => {
    const out = withTaskQuery(
      '/chat/w/w-1/c/c-a',
      '?utm_source=test',
      4,
    );
    expect(out).toContain('utm_source=test');
    expect(out).toContain('task=4');
  });
});

describe('buildTaskOpenUrl — openTask URL writer', () => {
  // Mirrors `buildSideOpenUrl` for sigil clicks: additive write of
  // `?task=<n>` with everything else preserved. Unlike `openSide` we
  // do NOT strip `?fullscreen` — focusing a task in the drawer is
  // independent of whichever pane is fullscreen, and stripping it
  // would yank the user out of a fullscreen view they were reading.

  it('writes ?task=<n> on a bare path', () => {
    expect(buildTaskOpenUrl('/chat/w/w-1/c/c-a', '', 7)).toBe(
      '/chat/w/w-1/c/c-a?task=7',
    );
  });

  it('preserves ?side and ?fullscreen — drawer focus is orthogonal', () => {
    const out = buildTaskOpenUrl(
      '/chat/w/w-1/c/c-a',
      '?side=c-other&fullscreen=1',
      11,
    );
    expect(out).toContain('side=c-other');
    expect(out).toContain('fullscreen=1');
    expect(out).toContain('task=11');
  });

  it('overwrites a stale ?task', () => {
    const out = buildTaskOpenUrl(
      '/chat/w/w-1/c/c-a',
      '?task=3&utm_source=test',
      8,
    );
    expect(out).toContain('task=8');
    expect(out).not.toContain('task=3');
    expect(out).toContain('utm_source=test');
  });
});

// Thread pane (`?thread=<rootMessageId>`). A thread is NOT a
// conversation — it points at a main-line message whose replies the right
// pane shows. It is mutually exclusive with `?side` at the nav layer:
// opening one clears the other. (`?cluster=` was retired with the legacy
// `/t/` viewer; the URL now speaks the user-facing "thread".)
describe('parseRouteState — ?thread=<rootMessageId> thread pane pointer', () => {
  it('parses ?thread=<id> alone', () => {
    const r = parseRouteState('/chat/w/w-1/c/c-a', '?thread=m-1');
    expect(r).toMatchObject({
      channelId: 'c-a',
      threadRootId: 'm-1',
      sideConversationId: null,
    });
  });

  it('defaults threadRootId to null with no query', () => {
    const r = parseRouteState('/chat/w/w-1/c/c-a', '');
    expect(r.threadRootId).toBeNull();
  });

  it('treats empty ?thread= as unset', () => {
    const r = parseRouteState('/chat/w/w-1/c/c-a', '?thread=');
    expect(r.threadRootId).toBeNull();
  });
});

describe('withThreadQuery — URL writer for openThread / closeThread', () => {
  it('writes ?thread=<id>, clearing ?side and ?fullscreen', () => {
    const out = withThreadQuery(
      '/chat/w/w-1/c/c-a',
      '?side=c-other&fullscreen=1',
      'm-1',
    );
    expect(out).toContain('thread=m-1');
    expect(out).not.toContain('side=c-other');
    expect(out).not.toContain('fullscreen=1');
  });

  it('clears ?thread (and ?fullscreen) when id is null', () => {
    const closed = withThreadQuery(
      '/chat/w/w-1/c/c-a',
      '?thread=m-1&fullscreen=1',
      null,
    );
    expect(closed).not.toContain('thread');
    expect(closed).not.toContain('fullscreen');
  });

  it('preserves unrelated params (e.g. ?task) when opening', () => {
    const out = withThreadQuery('/chat/w/w-1/c/c-a', '?task=7', 'm-1');
    expect(out).toContain('thread=m-1');
    expect(out).toContain('task=7');
  });
});

describe('buildThreadOpenUrl — openThread URL writer', () => {
  it('is additive over withThreadQuery and mutually exclusive with side', () => {
    expect(buildThreadOpenUrl('/chat/w/w-1/c/c-a', '', 'm-1')).toBe(
      '/chat/w/w-1/c/c-a?thread=m-1',
    );
    const out = buildThreadOpenUrl('/chat/w/w-1/c/c-a', '?side=c-other', 'm-1');
    expect(out).toContain('thread=m-1');
    expect(out).not.toContain('side=c-other');
  });
});

describe('parseRouteState — ?threads=1 channel Threads-list pane (#task:1073)', () => {
  it('parses ?threads=1 as threadsListOpen', () => {
    const r = parseRouteState('/chat/w/w-1/c/c-a', '?threads=1');
    expect(r).toMatchObject({
      channelId: 'c-a',
      threadsListOpen: true,
      sideConversationId: null,
      threadRootId: null,
    });
  });

  it('defaults threadsListOpen to false with no query', () => {
    expect(parseRouteState('/chat/w/w-1/c/c-a', '').threadsListOpen).toBe(false);
  });

  it('treats any value other than "1" as closed', () => {
    expect(parseRouteState('/chat/w/w-1/c/c-a', '?threads=0').threadsListOpen).toBe(
      false,
    );
    expect(parseRouteState('/chat/w/w-1/c/c-a', '?threads=').threadsListOpen).toBe(
      false,
    );
  });
});

describe('withThreadsQuery — URL writer for openThreadsList / closeThreadsList', () => {
  it('writes ?threads=1, clearing ?side, ?thread and ?fullscreen', () => {
    const out = withThreadsQuery(
      '/chat/w/w-1/c/c-a',
      '?side=c-other&thread=m-1&fullscreen=1',
      true,
    );
    expect(out).toContain('threads=1');
    expect(out).not.toContain('side=c-other');
    expect(out).not.toContain('thread=m-1');
    expect(out).not.toContain('fullscreen=1');
  });

  it('clears ?threads (and ?fullscreen) when closing', () => {
    const closed = withThreadsQuery(
      '/chat/w/w-1/c/c-a',
      '?threads=1&fullscreen=1',
      false,
    );
    expect(closed).not.toContain('threads');
    expect(closed).not.toContain('fullscreen');
  });

  it('preserves unrelated params (e.g. ?task) when opening', () => {
    const out = withThreadsQuery('/chat/w/w-1/c/c-a', '?task=7', true);
    expect(out).toContain('threads=1');
    expect(out).toContain('task=7');
  });
});

describe('mutual exclusion — opening side/thread clears ?threads', () => {
  it('buildSideOpenUrl drops an open ?threads', () => {
    const out = buildSideOpenUrl('/chat/w/w-1/c/c-a', '?threads=1', 'c-other');
    expect(out).toContain('side=c-other');
    expect(out).not.toContain('threads');
  });

  it('withThreadQuery (open) drops an open ?threads', () => {
    const out = withThreadQuery('/chat/w/w-1/c/c-a', '?threads=1', 'm-1');
    expect(out).toContain('thread=m-1');
    expect(out).not.toContain('threads=1');
  });
});

describe('parseRouteState — ?files=1 channel Attachments panel', () => {
  it('parses ?files=1 as filesListOpen', () => {
    const r = parseRouteState('/chat/w/w-1/c/c-a', '?files=1');
    expect(r).toMatchObject({
      channelId: 'c-a',
      filesListOpen: true,
      sideConversationId: null,
      threadRootId: null,
      threadsListOpen: false,
    });
  });

  it('defaults filesListOpen to false with no query', () => {
    expect(parseRouteState('/chat/w/w-1/c/c-a', '').filesListOpen).toBe(false);
  });

  it('treats any value other than "1" as closed (falsifier for slack parsing)', () => {
    expect(parseRouteState('/chat/w/w-1/c/c-a', '?files=0').filesListOpen).toBe(
      false,
    );
    expect(parseRouteState('/chat/w/w-1/c/c-a', '?files=').filesListOpen).toBe(
      false,
    );
    expect(parseRouteState('/chat/w/w-1/c/c-a', '?files=true').filesListOpen).toBe(
      false,
    );
  });
});

describe('withFilesQuery — URL writer for openFilesList / closeFilesList', () => {
  it('writes ?files=1, clearing ?side/?agent/?fullscreen but PRESERVING ?thread/?threads', () => {
    // Overlay contract (mirrors ?agent, #task:1433): opening Attachments
    // keeps the underlying conversation pane in the URL so closing restores
    // it. ?side is the exception — a covered CONVERSATION would still count
    // as visible and silence its toasts, so it (and ?agent) is swept.
    const out = withFilesQuery(
      '/chat/w/w-1/c/c-a',
      '?side=c-other&thread=m-1&threads=1&agent=a-9&fullscreen=1',
      true,
    );
    expect(out).toContain('files=1');
    expect(out).not.toContain('side=c-other');
    expect(out).not.toContain('agent=a-9');
    expect(out).not.toContain('fullscreen=1');
    // Preserved — the restore stack.
    expect(out).toContain('thread=m-1');
    expect(out).toContain('threads=1');
  });

  it('closing over a preserved ?thread reveals the thread (thread+files → close files = thread)', () => {
    const opened = withFilesQuery('/chat/w/w-1/c/c-a', '?thread=m-1', true);
    expect(opened).toContain('thread=m-1');
    expect(opened).toContain('files=1');
    const closed = withFilesQuery('/chat/w/w-1/c/c-a', opened.split('?')[1] ?? '', false);
    expect(closed).toContain('thread=m-1');
    expect(closed).not.toContain('files');
  });

  it('closing over a preserved ?threads reveals the list (threads+files → close = threads)', () => {
    const opened = withFilesQuery('/chat/w/w-1/c/c-a', '?threads=1', true);
    expect(opened).toContain('threads=1');
    expect(opened).toContain('files=1');
    const closed = withFilesQuery('/chat/w/w-1/c/c-a', opened.split('?')[1] ?? '', false);
    expect(closed).toContain('threads=1');
    expect(closed).not.toContain('files');
  });

  it('clears ?files (and ?fullscreen defensively) when closing', () => {
    const closed = withFilesQuery(
      '/chat/w/w-1/c/c-a',
      '?files=1&fullscreen=1',
      false,
    );
    expect(closed).not.toContain('files');
    expect(closed).not.toContain('fullscreen');
  });

  it('preserves unrelated params (e.g. ?task) when opening', () => {
    const out = withFilesQuery('/chat/w/w-1/c/c-a', '?task=7', true);
    expect(out).toContain('files=1');
    expect(out).toContain('task=7');
  });

  it('returns the bare path when the resulting query is empty', () => {
    // Falsifier: closing must not leave a dangling `?` on the path.
    expect(withFilesQuery('/chat/w/w-1/c/c-a', '?files=1', false)).toBe(
      '/chat/w/w-1/c/c-a',
    );
  });
});

describe('opening side/thread/threads closes the ?files overlay', () => {
  // The Attachments overlay does not coexist with a freshly-opened
  // conversation pane: navigating to side/thread/threads sweeps ?files so
  // the new pane is visible (the overlay would otherwise render ahead of it
  // by precedence). This is the reverse direction from withFilesQuery, which
  // PRESERVES an already-open thread/threads when Attachments opens.
  it('buildSideOpenUrl drops an open ?files', () => {
    const out = buildSideOpenUrl('/chat/w/w-1/c/c-a', '?files=1', 'c-other');
    expect(out).toContain('side=c-other');
    expect(out).not.toContain('files');
  });

  it('withThreadQuery (open) drops an open ?files', () => {
    const out = withThreadQuery('/chat/w/w-1/c/c-a', '?files=1', 'm-1');
    expect(out).toContain('thread=m-1');
    expect(out).not.toContain('files=1');
  });

  it('withThreadsQuery (open) drops an open ?files', () => {
    const out = withThreadsQuery('/chat/w/w-1/c/c-a', '?files=1', true);
    expect(out).toContain('threads=1');
    expect(out).not.toContain('files=1');
  });
});

describe('?agent + ?files overlay stack (agent > files precedence)', () => {
  // Both are overlays. Opening agent over Files keeps ?files so closing
  // agent reveals Files again (thread+files+agent → close agent = files →
  // close files = thread). Opening Files over agent clears ?agent (files
  // becomes the single visible overlay).
  it('withAgentQuery (open) preserves ?files=1 — closing agent reveals Files', () => {
    const out = withAgentQuery('/chat/w/w-1/c/c-a', '?thread=m-1&files=1', 'a-9');
    expect(out).toContain('agent=a-9');
    expect(out).toContain('files=1');
    expect(out).toContain('thread=m-1');
    // Close agent → files + thread survive.
    const afterAgentClose = withAgentQuery(
      '/chat/w/w-1/c/c-a',
      out.split('?')[1] ?? '',
      null,
    );
    expect(afterAgentClose).not.toContain('agent');
    expect(afterAgentClose).toContain('files=1');
    expect(afterAgentClose).toContain('thread=m-1');
    // Close files → thread survives.
    const afterFilesClose = withFilesQuery(
      '/chat/w/w-1/c/c-a',
      afterAgentClose.split('?')[1] ?? '',
      false,
    );
    expect(afterFilesClose).not.toContain('files');
    expect(afterFilesClose).toContain('thread=m-1');
  });

  it('withFilesQuery (open) clears ?agent — Files is the single visible overlay', () => {
    const out = withFilesQuery('/chat/w/w-1/c/c-a', '?agent=a-9', true);
    expect(out).toContain('files=1');
    expect(out).not.toContain('agent');
  });
});

describe('buildSideOpenUrl — clears ?thread (side/thread mutual exclusion)', () => {
  it('opening a side overlay closes an open thread', () => {
    const out = buildSideOpenUrl('/chat/w/w-1/c/c-a', '?thread=m-1', 'c-other');
    expect(out).toContain('side=c-other');
    expect(out).not.toContain('thread=m-1');
    expect(out).not.toContain('threads');
  });
});

// Agent side panel (`?agent=<agentId>`, #task:1189). Carries an agent id (not
// a conversation), rendered by `AgentView variant="side"` in the chat-section
// right pane. It OVERLAYS the thread panes: `?agent` coexists with `?thread` /
// `?threads` in the URL (App renders it ahead by precedence, closing it
// restores the covered pane — #task:1433). Only `?side` is cleared on open.
describe('parseRouteState — ?agent=<id> agent side panel', () => {
  it('parses ?agent as agentPanelId, distinct from the /members/:agentId route', () => {
    const r = parseRouteState('/chat/w/w-1/c/c-a', '?agent=a-9');
    expect(r).toMatchObject({
      section: 'chat',
      channelId: 'c-a',
      agentPanelId: 'a-9',
      agentId: null,
      sideConversationId: null,
      threadRootId: null,
      threadsListOpen: false,
    });
  });

  it('parses ?agent and ?thread together — overlay coexists at the RouteState layer (#task:1433)', () => {
    const r = parseRouteState('/chat/w/w-1/c/c-a', '?agent=a-9&thread=m-1');
    expect(r).toMatchObject({
      agentPanelId: 'a-9',
      threadRootId: 'm-1',
    });
  });

  it('parses ?agent and ?threads together — overlay coexists with the threads-list (#task:1433)', () => {
    const r = parseRouteState('/chat/w/w-1/c/c-a', '?agent=a-9&threads=1');
    expect(r).toMatchObject({
      agentPanelId: 'a-9',
      threadsListOpen: true,
    });
  });

  it('defaults agentPanelId to null and treats empty as unset', () => {
    expect(parseRouteState('/chat/w/w-1/c/c-a', '').agentPanelId).toBeNull();
    expect(parseRouteState('/chat/w/w-1/c/c-a', '?agent=').agentPanelId).toBeNull();
  });
});

describe('withAgentQuery / buildAgentPanelOpenUrl — open / close the agent panel', () => {
  it('opens ?agent as an overlay: preserves thread / threads-list, clears ?side + fullscreen', () => {
    const out = buildAgentPanelOpenUrl(
      '/chat/w/w-1/c/c-a',
      '?side=c-other&thread=m-1&threads=1&fullscreen=1',
      'a-9',
    );
    expect(out).toContain('agent=a-9');
    // thread / threads-list are channel-context panes with no
    // secondary-model impact → preserved so closing the panel restores
    // them (#task:1433).
    expect(out).toContain('thread=m-1');
    expect(out).toContain('threads=1');
    // ?side is a secondary CONVERSATION (feeds notification suppression) →
    // cleared while covered. ?fullscreen is dropped so the panel opens at
    // its normal width.
    expect(out).not.toContain('side=c-other');
    expect(out).not.toContain('fullscreen=1');
  });

  it('round-trip: opening then closing the panel over a thread restores the thread pane (#task:1433)', () => {
    const opened = buildAgentPanelOpenUrl(
      '/chat/w/w-1/c/c-a',
      '?thread=m-1',
      'a-9',
    );
    const search = opened.slice(opened.indexOf('?'));
    const closed = withAgentQuery('/chat/w/w-1/c/c-a', search, null);
    expect(closed).not.toContain('agent');
    expect(closed).toContain('thread=m-1');
  });


  it('preserves unrelated params (e.g. ?task) when opening', () => {
    const out = buildAgentPanelOpenUrl('/chat/w/w-1/c/c-a', '?task=7', 'a-9');
    expect(out).toContain('agent=a-9');
    expect(out).toContain('task=7');
  });

  it('clears ?agent (and ?fullscreen) when closing', () => {
    const closed = withAgentQuery(
      '/chat/w/w-1/c/c-a',
      '?agent=a-9&fullscreen=1',
      null,
    );
    expect(closed).not.toContain('agent');
    expect(closed).not.toContain('fullscreen');
  });
});

describe('mutual exclusion — opening a conversation pane clears ?agent', () => {
  it('buildSideOpenUrl drops an open ?agent', () => {
    const out = buildSideOpenUrl('/chat/w/w-1/c/c-a', '?agent=a-9', 'c-other');
    expect(out).toContain('side=c-other');
    expect(out).not.toContain('agent');
  });

  it('withThreadQuery (open) drops an open ?agent', () => {
    const out = withThreadQuery('/chat/w/w-1/c/c-a', '?agent=a-9', 'm-1');
    expect(out).toContain('thread=m-1');
    expect(out).not.toContain('agent');
  });

  it('withThreadsQuery (open) drops an open ?agent', () => {
    const out = withThreadsQuery('/chat/w/w-1/c/c-a', '?agent=a-9', true);
    expect(out).toContain('threads=1');
    expect(out).not.toContain('agent');
  });
});

describe('buildChannelPathPreservingAgent — A=Activity-follows-channel (#task:1189)', () => {
  it('writes a fresh channel path carrying ?agent (panel survives the switch)', () => {
    expect(buildChannelPathPreservingAgent('w-1', 'c-new', 'a-9')).toBe(
      '/chat/w/w-1/c/c-new?agent=a-9',
    );
  });

  it('does NOT restore a remembered secondary — only ?agent rides along', () => {
    const out = buildChannelPathPreservingAgent('w-1', 'c-new', 'a-9');
    expect(out).not.toContain('side');
    expect(out).not.toContain('thread');
    expect(out).not.toContain('threads');
    expect(out).not.toContain('fullscreen');
    // round-trips back to the same agentPanelId, distinct from the route segment
    const r = parseRouteState('/chat/w/w-1/c/c-new', '?agent=a-9');
    expect(r.agentPanelId).toBe('a-9');
    expect(r.agentId).toBeNull();
  });
});

// Per-channel layout memory (#task:1081). `layoutMemoryFromRoute`
// projects the route's secondary-pane fields into the persisted shape;
// `buildChannelLayoutUrl` rebuilds the channel URL from that shape so a
// sidebar switch back into the channel restores the same pane.
describe('layoutMemoryFromRoute — RouteState → persisted layout', () => {
  function fields(overrides: Partial<SecondaryRouteFields>): SecondaryRouteFields {
    return {
      sideConversationId: null,
      threadRootId: null,
      threadsListOpen: false,
      ...overrides,
    };
  }

  it('maps a bare channel to { none }', () => {
    expect(layoutMemoryFromRoute(fields({}))).toEqual({ kind: 'none' });
  });

  it('maps ?threads=1 to a threads-list layout', () => {
    expect(layoutMemoryFromRoute(fields({ threadsListOpen: true }))).toEqual({
      kind: 'threads-list',
    });
  });

  it('maps ?thread=<id> to a thread layout', () => {
    expect(layoutMemoryFromRoute(fields({ threadRootId: 'm-1' }))).toEqual({
      kind: 'thread',
      rootId: 'm-1',
    });
  });

  it('maps ?side=<id> to a side layout', () => {
    expect(layoutMemoryFromRoute(fields({ sideConversationId: 'c-x' }))).toEqual({
      kind: 'side',
      id: 'c-x',
    });
  });

  it('does NOT persist the Attachments overlay: files-only route → { none }', () => {
    // The overlay is transient (see ChannelLayout doc): opening Attachments
    // on a bare channel and switching away must not resurrect it on re-entry.
    // `parseRouteState` still carries filesListOpen, but layoutMemoryFromRoute
    // ignores it — a files-only route memoizes as `none`.
    const filesOnly = parseRouteState('/chat/w/w-1/c/c-a', '?files=1');
    expect(filesOnly.filesListOpen).toBe(true);
    expect(layoutMemoryFromRoute(filesOnly)).toEqual({ kind: 'none' });
  });

  it('persists the underlying pane, not the overlay, when files covers a thread', () => {
    // thread+files → the thread is the persisted layout, so channel re-entry
    // restores the thread (files overlay is dropped) rather than the overlay.
    const threadUnderFiles = parseRouteState(
      '/chat/w/w-1/c/c-a',
      '?thread=m-1&files=1',
    );
    expect(layoutMemoryFromRoute(threadUnderFiles)).toEqual({
      kind: 'thread',
      rootId: 'm-1',
    });
  });

  it('resolves side > thread > threads-list when a malformed URL sets several', () => {
    // Priority is the documented render-layer chain (Attachments overlay is
    // not part of it). A re-ordering would silently change persisted memory.
    expect(
      layoutMemoryFromRoute(
        fields({
          sideConversationId: 'c-x',
          threadRootId: 'm-1',
          threadsListOpen: true,
        }),
      ),
    ).toEqual({ kind: 'side', id: 'c-x' });
    expect(
      layoutMemoryFromRoute(fields({ threadsListOpen: true })),
    ).toEqual({ kind: 'threads-list' });
  });
});

describe('buildChannelLayoutUrl — restore a channel with its layout', () => {
  it('yields the bare path for none / null memory', () => {
    expect(buildChannelLayoutUrl('w-1', 'c-a', null)).toBe('/chat/w/w-1/c/c-a');
    expect(buildChannelLayoutUrl('w-1', 'c-a', { kind: 'none' })).toBe(
      '/chat/w/w-1/c/c-a',
    );
  });

  it('restores a threads-list pane', () => {
    expect(
      buildChannelLayoutUrl('w-1', 'c-a', { kind: 'threads-list' }),
    ).toBe('/chat/w/w-1/c/c-a?threads=1');
  });

  it('restores a thread pane', () => {
    expect(
      buildChannelLayoutUrl('w-1', 'c-a', { kind: 'thread', rootId: 'm-1' }),
    ).toBe('/chat/w/w-1/c/c-a?thread=m-1');
  });

  it('restores a side overlay', () => {
    expect(
      buildChannelLayoutUrl('w-1', 'c-a', { kind: 'side', id: 'c-x' }),
    ).toBe('/chat/w/w-1/c/c-a?side=c-x');
  });

  it('round-trips: parse → memory → build → parse is stable', () => {
    const built = buildChannelLayoutUrl('w-1', 'c-a', { kind: 'side', id: 'c-x' });
    const [pathname, search] = built.split('?');
    const r = parseRouteState(pathname!, search ? `?${search}` : '');
    expect(layoutMemoryFromRoute(r)).toEqual({ kind: 'side', id: 'c-x' });
  });
});
