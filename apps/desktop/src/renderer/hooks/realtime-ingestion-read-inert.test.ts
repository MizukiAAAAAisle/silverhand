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
