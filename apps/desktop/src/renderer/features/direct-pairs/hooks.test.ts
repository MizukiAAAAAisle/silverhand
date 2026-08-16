import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DirectPairListItem } from '@silverhand/shared';
import {
  decideDirectPairsInvalidation,
  directPairPaneProps,
  projectDirectPairPane,
  type DirectPairListQueryFacts,
  type DirectPairPaneState,
} from './hooks';

// #task:2035 — the two judgments the DM live-discovery chain rests on, both pure:
//
//   1. WHICH viewer-scope frame re-reads the pair list. This is the whole
//      acceptance case (an agent the viewer never created DMs them for the first
//      time and the row must appear with no reload), and it is invisible to every
//      other desktop test: the list is a plain query, so breaking the decision
//      leaves the suite green while the feature silently degrades to
//      "appears after you click something else".
//   2. WHAT the pane may claim while that read is in flight. The trap is React
//      Query's retained `data`: on invalidation the previous rows stay and
//      `isFetching` goes true while `isPending` stays FALSE, so "answered once"
//      is not "the current authority has answered".
//
// Desktop's test env is `node` (no jsdom/RTL) — like the sibling viewer-scope
// fences, the wiring half is asserted on source structure rather than by
// rendering hooks.

function pair(conversationId: string): DirectPairListItem {
  return {
    conversation_id: conversationId,
    counterpart: {
      status: 'active',
      kind: 'agent',
      id: 'a-1',
      name: 'alice',
      display_name: 'Alice',
      avatar_url: null,
      runtime: 'claude',
    },
    unread_count: 1,
    read_only: false,
    created_at: 1,
  };
}

/** Settled-successful facts: a read has answered and nothing is in flight. */
function settled(rows: readonly DirectPairListItem[]): DirectPairListQueryFacts {
  return { rows, isPending: false, isFetching: false, isError: false };
}

describe('decideDirectPairsInvalidation — which viewer frame re-reads the list', () => {
  it('re-reads on direct_pairs_changed', () => {
    expect(
      decideDirectPairsInvalidation({
        type: 'event',
        kind: 'direct_pairs_changed',
      }),
    ).toBe(true);
  });

  it('re-reads on snapshot_required — a replay gap can swallow the only announcement', () => {
    // The frame carries no `kind`. A brand-new pair is a row the client has no
    // other way to learn about, so a gap must re-read rather than wait.
    expect(decideDirectPairsInvalidation({ type: 'snapshot_required' })).toBe(true);
  });

  it('ignores every OTHER viewer-scoped event kind', () => {
    // The viewer scope is shared with the workspace list, unread, presence and
    // the task board; this list must not refetch on their traffic.
    for (const kind of [
      'viewer_workspaces_changed',
      'workspace_channels_changed',
      'unread_updated',
      'task_changed',
      'message',
      'presence_updated',
    ]) {
      expect(decideDirectPairsInvalidation({ type: 'event', kind })).toBe(false);
    }
  });

  it('ignores non-event frames and an event with no kind', () => {
    for (const type of ['ack', 'subscribed', 'pong', 'error']) {
      expect(
        decideDirectPairsInvalidation({ type, kind: 'direct_pairs_changed' }),
      ).toBe(false);
    }
    expect(decideDirectPairsInvalidation({ type: 'event' })).toBe(false);
  });
});

describe('projectDirectPairPane — what the pane may claim about the pair', () => {
  it('is idle when the route names no pair', () => {
    expect(projectDirectPairPane(null, settled([]))).toEqual({ kind: 'idle' });
    // Idle even mid-fetch: nothing is being awaited ON BEHALF of a pane.
    expect(
      projectDirectPairPane(null, {
        rows: undefined,
        isPending: true,
        isFetching: true,
        isError: false,
      }),
    ).toEqual({ kind: 'idle' });
  });

  it('resolves a row the current answer contains', () => {
    expect(projectDirectPairPane('c-pair', settled([pair('c-pair')]))).toEqual({
      kind: 'ready',
      pair: pair('c-pair'),
    });
  });

  it('waits on the cold read instead of flashing the empty state', () => {
    expect(
      projectDirectPairPane('c-pair', {
        rows: undefined,
        isPending: true,
        isFetching: true,
        isError: false,
      }),
    ).toEqual({ kind: 'resolving' });
  });

  it('THE ACCEPTANCE SEQUENCE: cached-empty → invalidated refetch → new row', () => {
    // A viewer whose list was fetched before the stranger's first DM. The
    // invalidation arrives; React Query RETAINS the empty rows and raises
    // `isFetching` while `isPending` stays false.
    const cachedEmpty = settled([]);
    expect(projectDirectPairPane('c-new', cachedEmpty)).toEqual({ kind: 'absent' });

    const refetching: DirectPairListQueryFacts = {
      rows: [],
      isPending: false,
      isFetching: true,
      isError: false,
    };
    // The step that an `isPending`-only projection gets WRONG: it would report a
    // settled absence here and the pane would flash "Select a channel" before
    // the row lands.
    expect(projectDirectPairPane('c-new', refetching)).toEqual({
      kind: 'resolving',
    });

    expect(projectDirectPairPane('c-new', settled([pair('c-new')]))).toEqual({
      kind: 'ready',
      pair: pair('c-new'),
    });
  });

  it('calls a cold bad id absent once the read has answered — not a loader that never ends', () => {
    expect(projectDirectPairPane('c-nope', settled([pair('c-other')]))).toEqual({
      kind: 'absent',
    });
  });

  it('reports a failed read as error, never as absence', () => {
    // Nothing was proven about the pair, and with `retry: 1` the client is not
    // going to keep trying: a terminal empty state would be a lie.
    expect(
      projectDirectPairPane('c-pair', {
        rows: undefined,
        isPending: false,
        isFetching: false,
        isError: true,
      }),
    ).toEqual({ kind: 'error' });
    // Same when a refetch fails over rows that don't contain the id: retained
    // rows are the PREVIOUS answer, so absence is still unproven.
    expect(
      projectDirectPairPane('c-pair', {
        rows: [pair('c-other')],
        isPending: false,
        isFetching: false,
        isError: true,
      }),
    ).toEqual({ kind: 'error' });
  });

  it('prefers a row we hold over both an in-flight refetch and a failed one', () => {
    // Precedence `ready > resolving > error`: the pane can render, so it must
    // not blank out just because the list is being revalidated or failed to be.
    expect(
      projectDirectPairPane('c-pair', {
        rows: [pair('c-pair')],
        isPending: false,
        isFetching: true,
        isError: false,
      }),
    ).toMatchObject({ kind: 'ready' });
    expect(
      projectDirectPairPane('c-pair', {
        rows: [pair('c-pair')],
        isPending: false,
        isFetching: false,
        isError: true,
      }),
    ).toMatchObject({ kind: 'ready' });
  });

  it('treats an in-flight retry as resolving, so a stale error never overrides a live attempt', () => {
    // Reachable shape: the query errored with no data, then something (an
    // invalidation, a remount) refetched it. The error is RETAINED while the new
    // fetch runs, so `isError` and `isFetching` are true together and
    // `isPending` is false.
    expect(
      projectDirectPairPane('c-pair', {
        rows: undefined,
        isPending: false,
        isFetching: true,
        isError: true,
      }),
    ).toEqual({ kind: 'resolving' });
  });
});

describe('directPairPaneProps — every state has a rendering (the consumer half)', () => {
  // @Cindy's B8 second round: the five-state projection is only worth having if
  // the shell can express five renderings. It could not — `absent` and `idle`
  // both fell through to "Select a channel", so turning `absent` into `idle`
  // changed the shipped UI by exactly nothing and the state was a test-only
  // classification. This mapping is where that is now falsifiable.
  const props = (state: DirectPairPaneState) => directPairPaneProps(state);

  it('renders nothing and waits for nothing when the route names no pair', () => {
    expect(props({ kind: 'idle' })).toEqual({
      pair: null,
      resolving: false,
      loadFailed: false,
      notFound: false,
    });
  });

  it('carries the row through untouched', () => {
    const row = pair('c-pair');
    expect(props({ kind: 'ready', pair: row })).toEqual({
      pair: row,
      resolving: false,
      loadFailed: false,
      notFound: false,
    });
  });

  it('asks the pane to wait, without claiming a failure or an absence', () => {
    expect(props({ kind: 'resolving' })).toEqual({
      pair: null,
      resolving: true,
      loadFailed: false,
      notFound: false,
    });
  });

  it('reports a failed read as a failure only', () => {
    expect(props({ kind: 'error' })).toEqual({
      pair: null,
      resolving: false,
      loadFailed: true,
      notFound: false,
    });
  });

  it('gives a SETTLED absence its own flag — not idle, not error', () => {
    // `/chat/d/<bad or no-longer-visible id>`: the route names a conversation
    // and the authority answered "not yours". Sharing `idle`'s rendering would
    // tell the viewer they chose nothing.
    expect(props({ kind: 'absent' })).toEqual({
      pair: null,
      resolving: false,
      loadFailed: false,
      notFound: true,
    });
  });

  it('maps the five states to five DISTINCT props — no two collapse', () => {
    // The property that makes the projection load-bearing rather than
    // decorative: if any two states rendered the same, one of them could be
    // deleted with no observable effect.
    const states: DirectPairPaneState[] = [
      { kind: 'idle' },
      { kind: 'resolving' },
      { kind: 'ready', pair: pair('c-pair') },
      { kind: 'error' },
      { kind: 'absent' },
    ];
    const rendered = states.map(s => JSON.stringify(props(s)));
    expect(new Set(rendered).size).toBe(states.length);
  });
});

describe('the live-discovery subscription is mounted once, by the session', () => {
  /** Source with comments removed. Load-bearing for the counts below: a probe
   *  that COMMENTS OUT a mount is the likeliest way these obligations die, and
   *  a raw `includes` would still find the call inside the comment and stay
   *  green. (Only `//` that does not follow a `:` is stripped, so a `scheme://`
   *  literal survives.) */
  function code(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
  }
  function read(relative: string): string {
    return code(
      readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8'),
    );
  }
  const hooksSource = read('./hooks.ts');
  const appSource = read('../../App.tsx');
  const shellSource = read('../app-shell/effects.ts');
  const panelSource = read(
    '../../components/layout/DirectMessagesPanel.tsx',
  );

  /** The body of a top-level `function <name>(`, up to the next top-level
   *  declaration. Lets a count be attributed to ONE component instead of to a
   *  2000-line module — `App.tsx` holds both the pre-auth gates and the shell. */
  function topLevelFunction(source: string, name: string): string {
    const start = source.indexOf(`function ${name}(`);
    expect(start).toBeGreaterThan(-1);
    const rest = source.slice(start + 1);
    const end = rest.search(/\n(?:export |function |const |class )/);
    return end === -1 ? rest : rest.slice(0, end);
  }

  it('the comment stripper actually strips — otherwise the counts below prove nothing', () => {
    expect(code('a\n// useDirectPairsSync();\nb')).not.toContain(
      'useDirectPairsSync',
    );
    expect(code('/* useDirectPairsSync(); */')).not.toContain(
      'useDirectPairsSync',
    );
    expect(code("const u = 'silverhand://agent/alice';")).toContain(
      'silverhand://agent/alice',
    );
  });

  it('the function slicer actually slices — a neighbour\'s body must not count', () => {
    const src = 'function A() {\n  mount();\n}\nfunction B() {\n  mount();\n}\n';
    expect(topLevelFunction(src, 'A').split('mount()').length - 1).toBe(1);
  });

  // @Cindy's B6 second round: the chain is only as strong as its weakest link.
  // Pinning `useAppShellGlobalSync`'s BODY proves the helper subscribes; it says
  // nothing about the shell still CALLING the helper. Her probe commented out
  // `useAppShellGlobalSync()` in App — which deletes every viewer-scoped
  // subscription from the shipped tree, so a stranger's first DM can never be
  // discovered — and the suite stayed green. All three links are pinned now.
  it('link 1: the post-auth shell calls the global-sync helper exactly once', () => {
    // `RegisteredAppShell` is the post-auth component by construction: `App`
    // returns it only after the loading, unreachable, epoch and registration
    // gates have each returned first.
    const shellComponent = topLevelFunction(appSource, 'RegisteredAppShell');
    expect(shellComponent.split('useAppShellGlobalSync()').length - 1).toBe(1);
    // And nowhere else in App — a second call would double every invalidation,
    // and a call in a pre-auth branch would subscribe with no viewer.
    expect(appSource.split('useAppShellGlobalSync()').length - 1).toBe(1);
    // The shell has to actually be mounted for any of this to run.
    expect(appSource.split('<RegisteredAppShell').length - 1).toBe(1);
  });

  it('link 2: the helper arms the direct-pair sync exactly once', () => {
    // The row must appear while the viewer is looking at ANY section, so the
    // obligation belongs to the session, not to the surface that renders the
    // list. Exactly once, because every mount invalidates the same key per
    // frame.
    expect(shellSource.split('useDirectPairsSync()').length - 1).toBe(1);
  });

  it('link 3: the section that renders the list arms NOTHING', () => {
    // A stranger's first DM has to arrive when DIRECT MESSAGES is absent from
    // the tree (it renders nothing when the viewer has no pairs) — a
    // subscription owned by that section could not discover the first row.
    expect(panelSource).not.toContain('useDirectPairsSync');
  });

  it('gates the viewer scope and routes the decision at the one key', () => {
    expect(hooksSource).toContain('subscribeViewerScope()');
    expect(hooksSource).toContain('isCurrentViewerScope(frame.scope)');
    expect(hooksSource).toContain('decideDirectPairsInvalidation(frame)');
    expect(hooksSource).toContain('queryKey: directPairsKey');
  });

  it('the pane consumes the pure mapping, and its settled absence reaches the view', () => {
    // The consumer direction for B8: the shell must not re-derive the states
    // (that is how `absent` got flattened), and the flag it derives has to be
    // handed to the pane rather than dropped.
    expect(appSource).toContain('directPairPaneProps(');
    expect(appSource).toContain('notFound={directPairNotFound}');
    expect(read('../../components/layout/ChannelView.tsx')).toContain(
      'props.notFound',
    );
  });
});
