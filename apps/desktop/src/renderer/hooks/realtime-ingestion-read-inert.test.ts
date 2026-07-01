import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// #task:1251 — the no-listener-gap fix makes a resubscribe REPLAY the events
// published while no listener was attached. The server re-sends them as
// byte-identical `event` frames over the existing `resume` protocol, so they
// flow through the SAME path live frames do:
//   ws-client onFrame → useConversationStream → onEvent → setQueryData (cache).
// Because replay reuses that path verbatim, two renderer invariants the path
// already satisfies BY CONSTRUCTION become load-bearing for replay correctness,
// and must not be allowed to regress silently:
//
//   (1) READ-INERT (surfaced ≠ eliminated, the #task:1244 invariant one layer
//       down). The realtime ingestion bridge — `useConversationStream`, which
//       EVERY frame, live or replayed, passes through — must never write read
//       state. Read advancement is VISIBILITY-driven (App.tsx
//       selectVisibleConversations → useMarkMessageChannelRead) / explicit
//       intent, NEVER frame-arrival-driven. If the bridge advanced the
//       `conversation_reads` cursor or wrote `notifications.read_at` on arrival,
//       a replayed (or live) frame would mark an unread @me as read merely by
//       being delivered — the exact passive-surface eviction #1244 outlawed,
//       re-opened at the transport layer. (Provenance tagging of replay-vs-live
//       frames is the documented fallback for IF replay is ever routed through a
//       visible-render cursor path; the minimal fix doesn't need it precisely
//       because this bridge is read-inert.)
//
//   (2) IDEMPOTENT MERGE. `acceptEventFrame` dispatches a replayed frame whose
//       seq overlaps the cursor (`seq <= lastSeq`) as a stale frame — reusing
//       the existing live-duplicate semantics rather than forking. So an
//       overlapping replayed message reaches `appendMessageToCache`, which must
//       de-dupe by id (fill the hole, not append a duplicate). That dedup is the
//       contract replay leans on; losing it would double-insert on every
//       overlapping resume.
//
// The desktop test env is `node` (no jsdom/RTL), so — in the spirit of
// `notification-toast-purity` / `protocol-purity` — we statically fence the
// source instead of rendering.
//
// Canonical contract: docs/event-ws-transport-v1.md §2 ("Three independent
// cursors — never conflated") — transport recovery moves only the frame
// cursor, never the `conversation_reads` cursor or `notifications.read_at`; a
// backfilled frame being "available" ≠ "read". §8 (Test coverage) lists this
// guard.

/**
 * Symbols/endpoints that mutate viewer read state. None may appear on the
 * realtime ingestion bridge. `/api/notifications/read` =
 * `useMarkConversationNotificationsRead`; `conversation_reads` cursor =
 * `useMarkMessageChannelRead` / `useMarkThreadRead` (via `observe` /
 * `streamSourceAtSeq`).
 */
const READ_STATE_WRITERS = [
  '/api/notifications/read',
  'markConversationNotificationsRead',
  'markMessageChannelRead',
  'markThreadRead',
  'conversation_reads',
  'streamSourceAtSeq',
];

function sliceFunctionBody(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  if (start === -1) {
    throw new Error(`could not find "${declaration}" — was it renamed?`);
  }
  // The function ends where the next top-level function declaration begins.
  const rest = source.slice(start + declaration.length);
  const nextDecl = rest.search(/\n(?:export )?function /);
  return nextDecl === -1 ? rest : rest.slice(0, nextDecl);
}

describe('realtime ingestion bridge — read-inert (#task:1251)', () => {
  const source = readFileSync(
    fileURLToPath(new URL('./useConversationStream.ts', import.meta.url)),
    'utf8',
  );

  it('useConversationStream is the transport→business bridge (sanity)', () => {
    // Guard the fence itself: if this file stops being the single choke point
    // every realtime frame passes through, the read-inert assertion below is
    // fencing the wrong thing.
    expect(source).toContain('onWsFrame');
    expect(source).toContain('subscribeWsScope');
  });

  it('the bridge never writes read state on frame arrival', () => {
    for (const writer of READ_STATE_WRITERS) {
      expect(source).not.toContain(writer);
    }
  });
});

describe('replayed-frame cache merge — idempotent (#task:1251)', () => {
  const source = readFileSync(
    fileURLToPath(
      new URL('../features/channels/hooks.ts', import.meta.url),
    ),
    'utf8',
  );

  it('appendMessageToCache de-dupes by message id (replay-overlap safe)', () => {
    const body = sliceFunctionBody(source, 'function appendMessageToCache(');
    // The load-bearing dedup: an already-cached id returns the cache untouched.
    // Replay redelivers overlapping seqs; without this it would double-insert.
    expect(body).toContain('cacheHasMessage(data, msg.id)');
  });
});

// #task:1255 P1a — the central conversation ingestor takes over the main-stream
// cache writes that used to live in `useChannelMessages.onEvent`. Two structural
// invariants make that move correct, and (like the #1251 fences above) the node
// test env can't render, so we statically fence the source:
//
//   (A) READ-INERT, one layer up. The ingestor is now the sole `onWsFrame`
//       consumer for `conversation:<id>` scope; it must inherit the same
//       read-inert contract the bridge has — never write `conversation_reads`
//       / `notifications.read_at`. Otherwise frame arrival would advance read
//       state, re-opening the #1244 passive-eviction hole at the new choke
//       point.
//
//   (B) GATE-(b): VIEWS ARE PURE READERS. `useChannelMessages` must no longer
//       register `onWsFrame` (directly or via `useConversationStream`) and must
//       not call any main-stream cache MUTATOR — those moved to the ingestor.
//       It keeps INTEREST (`subscribeWsScope`) and reads the gap fact
//       (`useMainlineLiveGap`). Holding zero frame consumers is the precondition
//       Stage-2 P2 needs to drop the orphan gate. See
//       docs/renderer-event-ingestion-v1.md §4.4 / §5.
describe('central conversation ingestor — read-inert (#task:1255)', () => {
  const source = readFileSync(
    fileURLToPath(
      new URL('../features/realtime/conversation-ingestor.ts', import.meta.url),
    ),
    'utf8',
  );

  it('is the App-level frame consumer (sanity)', () => {
    // If the ingestor stops consuming frames, the read-inert assertion below is
    // fencing a dead module rather than the live choke point.
    expect(source).toContain('onWsFrame');
  });

  it('never writes read state on frame arrival', () => {
    for (const writer of READ_STATE_WRITERS) {
      expect(source).not.toContain(writer);
    }
  });
});

describe('useChannelMessages — pure reader / gate-(b) fence (#task:1255)', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../features/channels/hooks.ts', import.meta.url)),
    'utf8',
  );
  const body = sliceFunctionBody(source, 'export function useChannelMessages(');

  it('registers no frame consumer (no onWsFrame / useConversationStream)', () => {
    // Fence the CALL form, not the word — the hook's own comments explain that
    // the ingestor is "the sole onWsFrame consumer", and that prose must not
    // trip the guard.
    expect(body).not.toContain('onWsFrame(');
    expect(body).not.toContain('useConversationStream(');
  });

  it('calls no main-stream cache mutator (writes moved to the ingestor)', () => {
    for (const mutator of [
      'appendMessageToCache(',
      'bumpReplyCountInCache(',
      'applyTaskChangedToCache(',
      'applyReactionChangedToChannelCaches(',
    ]) {
      expect(body).not.toContain(mutator);
    }
  });

  it('keeps scope interest and reads the gap fact (positive)', () => {
    expect(body).toContain('subscribeWsScope');
    expect(body).toContain('useMainlineLiveGap');
  });

  it('clears the LEAVING channel gap on switch/unmount (#1255 blocker-2)', () => {
    // Per-channel cache key (vs the old hook-local useState) means a stale
    // `true` survives a channel switch unless the effect cleanup clears the
    // channel being left — otherwise switching A→B→A flashes a bogus
    // "jump to latest" on the first render back.
    expect(body).toContain('return () => setMainlineLiveGap(qc, channelId, false)');
  });
});

// #task:1255 P1b — useThreadCluster / useThreadRoot / useThreadFollowers move
// their `onEvent` cache writes into the central ingestor and become pure
// readers (same gate-(b) precondition as useChannelMessages, now on the thread
// axis). Fence each: no frame consumer, no cache mutator, keeps scope interest.
describe('thread view hooks — pure reader / gate-(b) fence (#task:1255 P1b)', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../features/channels/hooks.ts', import.meta.url)),
    'utf8',
  );
  const HOOKS = [
    'export function useThreadCluster(',
    'export function useThreadRoot(',
    'export function useThreadFollowers(',
  ];
  // Call-form, not the bare word — these hooks' comments mention onWsFrame /
  // useConversationStream to explain what moved out.
  const FORBIDDEN = [
    'onWsFrame(',
    'useConversationStream(',
    'appendMessageToCache(',
    'bumpReplyCountInCache(',
    'applyTaskChangedToCache(',
    'applyReactionChangedToChannelCaches(',
    'applyReactionChangedToThreadRootCache(',
  ];

  for (const decl of HOOKS) {
    const name = decl.replace('export function ', '').replace('(', '');
    const body = sliceFunctionBody(source, decl);

    it(`${name} registers no frame consumer / cache mutator`, () => {
      for (const sym of FORBIDDEN) expect(body).not.toContain(sym);
    });

    it(`${name} keeps scope interest (subscribeWsScope)`, () => {
      expect(body).toContain('subscribeWsScope');
    });
  }
});

// #task:1255 P1c — the remaining conversation-scope onEvent consumers move into
// the ingestor / become pure readers: useChannelThreads (threads-list
// invalidate), useAgentRunStates (agent_activity + snapshot_required),
// useChannelAgents (agent_status, refcounted buffer), and ChannelView (read
// cursor → cache/visibility-driven, read stays on the read axis). The only one
// still owning its own stream is AgentActivityTimeline (its own increment). Fence
// each migrated reader: zero frame consumers, keep scope interest.
describe('useAgentRunStates — pure reader / gate-(b) fence (#task:1255 P1c)', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../features/channels/hooks.ts', import.meta.url)),
    'utf8',
  );
  const body = sliceFunctionBody(source, 'export function useAgentRunStates(');

  it('registers no frame consumer (no onWsFrame / useConversationStream)', () => {
    expect(body).not.toContain('onWsFrame(');
    expect(body).not.toContain('useConversationStream(');
  });

  it('keeps scope interest (subscribeWsScope)', () => {
    expect(body).toContain('subscribeWsScope');
  });
});

describe('useChannelThreads — pure reader / gate-(b) fence (#task:1255 P1c)', () => {
  const source = readFileSync(
    fileURLToPath(
      new URL('../features/channels/useChannelThreads.ts', import.meta.url),
    ),
    'utf8',
  );
  const body = sliceFunctionBody(source, 'export function useChannelThreads(');

  it('registers no frame consumer (no onWsFrame / useConversationStream)', () => {
    expect(body).not.toContain('onWsFrame(');
    expect(body).not.toContain('useConversationStream(');
  });

  it('keeps scope interest (subscribeWsScope)', () => {
    expect(body).toContain('subscribeWsScope');
  });
});

describe('useChannelAgents — pure reader / gate-(b) fence (#task:1255 P1c)', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../features/channels/hooks.ts', import.meta.url)),
    'utf8',
  );
  const body = sliceFunctionBody(source, 'export function useChannelAgents(');

  it('registers no frame consumer (no onWsFrame / useConversationStream)', () => {
    expect(body).not.toContain('onWsFrame(');
    expect(body).not.toContain('useConversationStream(');
  });

  it('keeps scope interest + drains the ingestor buffer (positive)', () => {
    expect(body).toContain('subscribeWsScope');
    expect(body).toContain('mergePendingAgentStatusPatches(');
    // Per-channel buffer is refcounted — released on leave, cleared only when
    // the last reader for the channel goes (multi-reader safe).
    expect(body).toContain('retainAgentStatusBuffer(');
    expect(body).toContain('releaseAgentStatusBuffer(');
  });
});

// #task:1255 P1c — ChannelView is the read-cursor consumer. Its move is the
// read-inert boundary (#1244/#1251): it MUST drop onWsFrame/useConversationStream
// (gate-(b)) AND keep read advancement on the read axis (useMarkMessageChannelRead),
// but driven by the mainline CACHE (tail advance), never by frame arrival.
describe('ChannelView — read-cursor cache-driven / gate-(b) (#task:1255 P1c)', () => {
  const source = readFileSync(
    fileURLToPath(
      new URL('../components/layout/ChannelView.tsx', import.meta.url),
    ),
    'utf8',
  );

  it('registers no frame consumer (no onWsFrame / useConversationStream)', () => {
    expect(source).not.toContain('onWsFrame(');
    expect(source).not.toContain('useConversationStream(');
  });

  it('still marks read on the read axis (useMarkMessageChannelRead)', () => {
    expect(source).toContain('useMarkMessageChannelRead');
  });

  it('marks read off the mainline tail, not frame arrival (cache-driven)', () => {
    // The decision is the pure `nextTailReadMark` helper (unit-tested in
    // lib/channel-read.test.ts), and the old arrival-driven handler is gone.
    expect(source).toContain('nextTailReadMark(');
    expect(source).not.toContain('onStreamEvent');
  });
});

// #task:1255 P1c #2 — AgentActivityTimeline's conversation_activity feed moves to
// a React Query cache the ingestor writes; the view is a pure reader. The feed
// is CONTENT (read-inert): writing it must never advance a read/transport cursor.
describe('AgentActivityTimeline — pure reader / gate-(b) (#task:1255 P1c #2)', () => {
  const source = readFileSync(
    fileURLToPath(
      new URL('../features/agents/AgentActivityTimeline.tsx', import.meta.url),
    ),
    'utf8',
  );

  it('registers no frame consumer (no onWsFrame / useConversationStream)', () => {
    expect(source).not.toContain('onWsFrame(');
    expect(source).not.toContain('useConversationStream(');
  });

  it('reads the feed via the cache hook (positive)', () => {
    expect(source).toContain('useAgentActivityFeed(');
  });
});

describe('useAgentActivityFeed — read-inert content cache (#task:1255 P1c #2)', () => {
  const source = readFileSync(
    fileURLToPath(
      new URL('../features/agents/useAgentActivityFeed.ts', import.meta.url),
    ),
    'utf8',
  );

  it('never writes read state (content cache only)', () => {
    for (const writer of READ_STATE_WRITERS) {
      expect(source).not.toContain(writer);
    }
  });

  it('keeps scope interest + does not bootstrap on append (positive)', () => {
    expect(source).toContain('subscribeWsScope');
    // The live-append helper leaves an unloaded feed alone (no reader / no
    // snapshot behind it) — `prev ? … : prev`.
    const body = sliceFunctionBody(source, 'export function appendAgentActivityToCache(');
    expect(body).toContain('prev ?');
  });
});

// The realtime bridge no longer carries the `agent_activity` side-effect — it
// moved to the central ingestor (gated on a run-states reader). Fence that the
// bridge is now a pure dispatcher so the side-effect can't silently come back
// in two places.
describe('useConversationStream — no business side-effects (#task:1255 P1c)', () => {
  const source = readFileSync(
    fileURLToPath(new URL('./useConversationStream.ts', import.meta.url)),
    'utf8',
  );

  it('does not apply agent-run-state on the bridge (ingestor owns it)', () => {
    expect(source).not.toContain('applyAgentRunStateToCache');
  });
});

// #task:1255 P2 step-3 — SCOPE PARTITION WHITELIST. Each conversation-scope
// consumer subscribes exactly one transport scope: side consumers (agent_status
// / agent_activity / conversation_activity / members) → `wsConversationSideScope`;
// message-stream consumers (mainline / cluster / root / followers / threads) →
// `wsConversationScope`. This is the whitelist Cindy gated on: a new consumer (or
// a drift) that picks the wrong scope fails HERE rather than silently splitting
// live delivery (side kind published to a scope with no subscriber = broken
// live). Call-form assertions — `wsConversationScope(` is not a substring of
// `wsConversationSideScope(`, so the two never cross. See
// docs/event-ws-recovery-class-scope-v1.md.
describe('conversation-scope subscribe whitelist (#task:1255 P2 step-3)', () => {
  const hooksSrc = readFileSync(
    fileURLToPath(new URL('../features/channels/hooks.ts', import.meta.url)),
    'utf8',
  );

  // Side consumers living in hooks.ts (sliced bodies — the file holds many hooks).
  for (const decl of [
    'export function useChannelAgents(',
    'export function useAgentRunStates(',
  ]) {
    const name = decl.replace('export function ', '').replace('(', '');
    const body = sliceFunctionBody(hooksSrc, decl);
    it(`${name} subscribes the SIDE scope`, () => {
      expect(body).toContain('wsConversationSideScope(');
      expect(body).not.toContain('wsConversationScope(');
    });
  }

  // Message-stream consumers living in hooks.ts stay on the message scope.
  for (const decl of [
    'export function useChannelMessages(',
    'export function useThreadCluster(',
    'export function useThreadRoot(',
    'export function useThreadFollowers(',
  ]) {
    const name = decl.replace('export function ', '').replace('(', '');
    const body = sliceFunctionBody(hooksSrc, decl);
    it(`${name} stays on the MESSAGE-STREAM scope`, () => {
      expect(body).toContain('wsConversationScope(');
      expect(body).not.toContain('wsConversationSideScope(');
    });
  }

  it('useAgentActivityFeed subscribes the SIDE scope', () => {
    const src = readFileSync(
      fileURLToPath(
        new URL('../features/agents/useAgentActivityFeed.ts', import.meta.url),
      ),
      'utf8',
    );
    expect(src).toContain('wsConversationSideScope(');
    expect(src).not.toContain('wsConversationScope(');
  });

  it('useConversationMembers subscribes the SIDE scope (own onWsFrame)', () => {
    const src = readFileSync(
      fileURLToPath(
        new URL('../features/conversations/useConversationMembers.ts', import.meta.url),
      ),
      'utf8',
    );
    expect(src).toContain('wsConversationSideScope(');
    expect(src).not.toContain('wsConversationScope(');
  });

  it('useChannelThreads stays on the MESSAGE-STREAM scope', () => {
    const src = readFileSync(
      fileURLToPath(
        new URL('../features/channels/useChannelThreads.ts', import.meta.url),
      ),
      'utf8',
    );
    expect(src).toContain('wsConversationScope(');
    expect(src).not.toContain('wsConversationSideScope(');
  });
});
