import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// #task:1251 — replayed frames flow through the same central conversation
// ingestor as live frames. Two renderer invariants remain load-bearing:
//
//   (1) READ-INERT (surfaced ≠ eliminated, the #task:1244 invariant one layer
//       down). The central ingestor must never write read
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

describe('replayed-frame cache merge — idempotent (#task:1251)', () => {
  // #task:1292: the append trio (appendToCache + the two typed helpers) moved to
  // the extracted message-cache-core module; the dedup invariant travels with it
  // (assertions below unchanged — this fence just follows the code to its home).
  const source = readFileSync(
    fileURLToPath(
      new URL('../features/channels/message-cache-core.ts', import.meta.url),
    ),
    'utf8',
  );

  it('appendMessageToCache de-dupes by message id (replay-overlap safe)', () => {
    // The load-bearing dedup: an already-cached id returns the cache untouched.
    // Replay redelivers overlapping seqs; without this it would double-insert.
    // #task:1267 slice B split the append path into a shared `appendToCache`
    // core (which owns the dedup) plus two typed public helpers
    // (`appendMessageToCache` for committed rows, `appendPendingMessage` for
    // optimistic ones) that BOTH delegate to it — so the dedup now guards every
    // append, committed or pending. Fence the core holds it AND both helpers
    // route through it, so neither can regain a non-deduping path.
    const core = sliceFunctionBody(source, 'function appendToCache(');
    expect(core).toContain('cacheHasMessage(data, msg.id)');
    for (const helper of ['appendMessageToCache', 'appendPendingMessage']) {
      const body = sliceFunctionBody(source, `function ${helper}(`);
      expect(body).toContain('appendToCache(');
    }
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

  it('declares scope interest via the registry + reads the gap fact (positive)', () => {
    // #task:1260 P2 slice 6: interest now routes through the registry
    // (`useInterest`); the direct transport subscribe is gone (call-form deny so
    // the hook's prose naming subscribeWsScope doesn't trip it). Body-scoped deny
    // (hooks.ts is now fully migrated — see the file-level guard below).
    expect(body).toContain('useInterest(');
    expect(body).not.toContain('subscribeWsScope(');
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

// #task:1255 P1b — useThreadCluster / useThreadRoot / useThreadFollowers moved
// their `onEvent` cache writes into the central ingestor and became pure readers
// (gate-(b) on the thread axis). All three have since been migrated to the
// InterestRegistry (#task:1260 P2 slices 3-5), so their gate-(b) + interest
// fences now live in the parametrized `MIGRATED` group below rather than a
// separate P1b loop.

// #task:1260 P2 — hooks migrated to the InterestRegistry INSIDE the shared
// channels/hooks.ts, one per slice (slices 3-8). Each entry's deny
// (`subscribeWsScope(` forbidden) is scoped to THAT hook's sliced body. All
// conversation readers in this file are now migrated (P2 complete); the
// file-level guard below therefore asserts the STRONGER terminal invariant —
// no direct transport subscribe remains anywhere in hooks.ts. While the file
// was mid-migration this pattern proved the per-hook deny was body-scoped (a
// migrated hook + its still-raw neighbours went green simultaneously), which is
// why one hook's migration could never open a fence back-door (Alice's slice-3
// transport-gate requirement).
describe('channels/hooks.ts — registry-migrated hooks / body-scoped deny (#task:1260 P2)', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../features/channels/hooks.ts', import.meta.url)),
    'utf8',
  );
  const MIGRATED = [
    'export function useThreadRoot(',      // slice 3 (b729155)
    'export function useThreadFollowers(', // slice 4 (4a73aee)
    'export function useThreadCluster(',   // slice 5
  ];
  const FORBIDDEN = [
    'onWsFrame(',
    'useConversationStream(',
    'appendMessageToCache(',
    'bumpReplyCountInCache(',
    'applyTaskChangedToCache(',
    'applyReactionChangedToChannelCaches(',
    'applyReactionChangedToThreadRootCache(',
  ];

  for (const decl of MIGRATED) {
    const name = decl.replace('export function ', '').replace('(', '');
    const body = sliceFunctionBody(source, decl);

    it(`${name} registers no frame consumer / cache mutator (gate-(b) preserved)`, () => {
      for (const sym of FORBIDDEN) expect(body).not.toContain(sym);
    });

    it(`${name} declares scope interest via the registry, not a direct subscribe (body-scoped deny)`, () => {
      // Call-form deny (prose naming subscribeWsScope must not trip it) on THIS
      // hook's body only.
      expect(body).toContain('useInterest(');
      expect(body).not.toContain('subscribeWsScope(');
    });
  }

  it('hooks.ts is fully migrated: no conversation reader calls subscribeWsScope directly', () => {
    // FLIPPED at slice 8 (useAgentRunStates, the last conversation reader in this
    // file). While the file was mid-migration this required `subscribeWsScope(`
    // (proof the per-hook deny was body-scoped — un-migrated neighbours still
    // called it). Now the file is fully migrated, so the successor guard is the
    // STRONGER one: NO direct transport subscribe remains anywhere in hooks.ts —
    // any hook re-introducing one fails here. Converted, not deleted (Alice's
    // slice-8 requirement: no bare deletion). Comments still name subscribeWsScope
    // in prose; call-form keeps that from tripping.
    expect(source).not.toContain('subscribeWsScope(');
  });
});

// #task:1284 — the mark-read mutations advance the read cursor via `observe`; the
// global/sidebar message-unread badge is then cleared by observe's post-commit
// enriched `unread_updated` patch (the viewer-unread ingestor), NOT by a
// client-side whole-list invalidate. A re-introduced
// `invalidateMessageUnreadQueries` here forces a global refetch and defeats the
// projection — the dogfood FAIL that pulled #1284 back (arrival patched, then
// the focused-channel auto-read refetched). Lock it out; separate read-models
// may still settle narrowly.
describe('mark-read mutations — global badges ride the WS clear patch, no whole-list refetch (#task:1284)', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../features/channels/hooks.ts', import.meta.url)),
    'utf8',
  );

  it('useMarkMessageChannelRead does not invalidate message-unread, settles per-stream via the seam', () => {
    const body = sliceFunctionBody(source, 'export function useMarkMessageChannelRead(');
    expect(body).not.toContain('invalidateMessageUnreadQueries(');
    // #task:1402 — mainline mark-read settles per-stream conversationUnread through
    // the single seam (symmetric with the thread path), never a hand-written
    // conversationUnreadKey invalidate.
    expect(body).toContain('settleStreamUnreadAfterObserve(');
    expect(body).not.toContain('conversationUnreadKey(');
  });

  it('useMarkThreadRead drops message-unread invalidate, settles per-stream via the seam', () => {
    const body = sliceFunctionBody(source, 'export function useMarkThreadRead(');
    expect(body).not.toContain('invalidateMessageUnreadQueries(');
    // #task:1402 — the per-stream reply-chip / Threads-list "N new"
    // (conversationUnread) is settled through the single seam, never a
    // hand-written conversationUnreadKey invalidate at this caller (#task:1400's
    // inline patch is absorbed into the seam).
    expect(body).toContain('settleStreamUnreadAfterObserve(');
    expect(body).not.toContain('conversationUnreadKey(');
    // channelThreadsKey is a DIFFERENT read-model (per-thread metadata) that
    // still legitimately invalidates.
    expect(body).toContain('channelThreadsKey(');
  });
});

// #task:1402 — the audit's ACTUAL red point was the Activity entry point:
// `useClearActivityItem` (per-row hover-✓ / on-open directed dismiss) and
// `useMarkActivityAllRead` cleared a stream item's unread but did NOT locally
// settle the per-stream `conversationUnread`, so a co-visible channel chip sat
// stale until the async `unread_updated` round-trip — the same #task:1400 window,
// one entry point over. The fix routes BOTH through the single seam. This fence
// is the anti-regression Cindy gated #1402 on: the root cause was "ThreadPanel
// patched, Activity missed", so the fence must pin the Activity callers too —
// otherwise a future edit can slide back to a single-point patch. The desktop
// test env is `node` (no jsdom/RTL), so we statically fence the source in the
// spirit of the #1251/#1255/#1284 fences above.
describe('Activity mark-read callers — settle per-stream via the seam, no single-point patch (#task:1402)', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../features/attention/hooks.ts', import.meta.url)),
    'utf8',
  );

  for (const decl of [
    'export function useClearActivityItem(',
    'export function useMarkActivityAllRead(',
  ]) {
    const name = decl.replace('export function ', '').replace('(', '');
    const body = sliceFunctionBody(source, decl);

    it(`${name} settles per-stream conversationUnread through the single seam`, () => {
      expect(body).toContain('settleStreamUnreadAfterObserve(');
    });

    it(`${name} keeps no single-point patch (no bare conversationUnreadKey / global refetch)`, () => {
      // The whole point of the seam: no caller hand-writes the per-stream
      // invalidate, and none re-introduces the #task:1284 global whole-list
      // refetch (that rides the enriched unread_updated ingestor patch).
      expect(body).not.toContain('conversationUnreadKey(');
      expect(body).not.toContain('invalidateMessageUnreadQueries(');
    });
  }
});

// #task:1255 P1c — the remaining conversation-scope onEvent consumers move into
// the ingestor / become pure readers: useChannelThreads (threads-list
// invalidate), useAgentRunStates (agent_activity + snapshot_required),
// useChannelAgentRuntime (agent_status, refcounted buffer), and ChannelView (read
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

  it('declares scope interest via the registry, not a direct subscribe (#task:1260 P2 slice 8)', () => {
    // Last conversation reader in hooks.ts migrated. Call-form deny (prose naming
    // subscribeWsScope must not trip it), body-scoped. snapshot_required /
    // agent_activity buffer logic lives in the ingestor, not this hook — untouched.
    expect(body).toContain('useInterest(');
    expect(body).not.toContain('subscribeWsScope(');
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

  it('declares scope interest via the registry, not a direct subscribe (#task:1260 P2)', () => {
    // Migrated in #1260 P2: interest now routes through the InterestRegistry
    // (`useInterest`), and the direct transport subscribe is gone. This is the
    // Direct-subscribe deny-list entry for this reader file: the registry is
    // the sole subscription-lifetime owner for product conversation readers.
    // Call-form assertion (like every fence here): the migration comment above
    // still names `subscribeWsScope` in prose, which must not trip the guard —
    // what's forbidden is the direct *call*.
    expect(body).toContain('useInterest(');
    expect(body).not.toContain('subscribeWsScope(');
  });
});

describe('channel membership/runtime readers — gate-(b) fence (#task:2026)', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../features/channels/hooks.ts', import.meta.url)),
    'utf8',
  );
  const membershipBody = sliceFunctionBody(
    source,
    'export function useChannelAgents(',
  );
  const runtimeBody = sliceFunctionBody(
    source,
    'export function useChannelAgentRuntime(',
  );

  it('keeps the membership reader free of runtime interest and buffers', () => {
    expect(membershipBody).not.toContain('onWsFrame(');
    expect(membershipBody).not.toContain('useConversationStream(');
    expect(membershipBody).not.toContain('useInterest(');
    expect(membershipBody).not.toContain('AgentStatus');
  });

  it('lets only the runtime reader own scope interest and drain the status buffer', () => {
    // #task:1260 P2 slice 7: interest routes through the registry (`useInterest`);
    // the direct transport subscribe is gone (call-form deny, body-scoped). The
    // refcounted patch buffer is NOT interest — retain/release stay in their own
    // effect and must remain here untouched.
    expect(runtimeBody).toContain('useInterest(');
    expect(runtimeBody).not.toContain('subscribeWsScope(');
    expect(runtimeBody).toContain('mergePendingAgentStatusPatches(');
    // Per-channel buffer is refcounted — released on leave, cleared only when
    // the last reader for the channel goes (multi-reader safe).
    expect(runtimeBody).toContain('retainAgentStatusBuffer(');
    expect(runtimeBody).toContain('releaseAgentStatusBuffer(');
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

  it('declares scope interest via the registry + does not bootstrap on append (positive)', () => {
    // #task:1260 P2 slice 2: interest routes through the registry (`useInterest`),
    // the direct transport subscribe is gone — call-form deny (prose naming
    // `subscribeWsScope` must not trip it). This is the P2 deny-list entry for
    // this reader file.
    expect(source).toContain('useInterest(');
    expect(source).not.toContain('subscribeWsScope(');
    // The live-append helper leaves an unloaded feed alone (no reader / no
    // snapshot behind it) — `prev ? … : prev`.
    const body = sliceFunctionBody(source, 'export function appendAgentActivityToCache(');
    expect(body).toContain('prev ?');
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
// docs/event-ws-transport-v1.md §4.2.
describe('conversation-scope subscribe whitelist (#task:1255 P2 step-3)', () => {
  const hooksSrc = readFileSync(
    fileURLToPath(new URL('../features/channels/hooks.ts', import.meta.url)),
    'utf8',
  );

  // Side consumers living in hooks.ts (sliced bodies — the file holds many hooks).
  for (const decl of [
    'export function useChannelAgentRuntime(',
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

  it('useConversationMembers declares SIDE-scope interest via the registry + keeps its own onWsFrame', () => {
    const src = readFileSync(
      fileURLToPath(
        new URL('../features/conversations/useConversationMembers.ts', import.meta.url),
      ),
      'utf8',
    );
    expect(src).toContain('wsConversationSideScope(');
    expect(src).not.toContain('wsConversationScope(');
    // #task:1260 P2 slice 10 (distinct slice): interest migrated to the registry,
    // the conversation_members_changed listener stays this hook's own — interest
    // ⊥ listener. Call-form deny so prose naming subscribeWsScope can't trip it.
    expect(src).toContain('useInterest(');
    expect(src).not.toContain('subscribeWsScope(');
    expect(src).toContain('onWsFrame(');
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
