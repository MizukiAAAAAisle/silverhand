import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// #task:1773 — freshness seam for the header dot + the `followed ∩ unread`
// Threads dataset. Both read the SAME viewer-scoped signal: the header dot
// boolean rides `useConversationUnread`'s DTO, and the filtered list is a
// SEPARATE HTTP read over the same server predicate. They are two independent
// reads that converge from one invalidation source — never derived from each
// other. So `useConversationUnread` must, on a viewer-scope reconcile or a
// matching `unread_updated`, refetch the filtered sibling ALONGSIDE the unread
// read-model. Two membership-changing events reach only this viewer signal (no
// conversation message frame carries them): a remote observe clearing a followed
// thread's unread, and this viewer follow/unfollowing on another device (backend
// publishes `unread_updated` on a real follow change).
//
// The dual invariant this fence locks:
//   1. a viewer unread signal invalidates the filtered dataset
//      (`channelThreadsUnreadKey`) on BOTH branches (snapshot + unread_updated);
//   2. it NEVER invalidates the exact All key (`channelThreadsKey`) — the All
//      list's membership + order are unread- AND follow-agnostic
//      (`lr.created_at DESC, root.seq DESC`), so a per-viewer unread change must
//      not refetch it (that would defeat the S1 in-place merge). The All list is
//      refreshed only by the message-path ingestor / a follow toggle's own
//      HTTP-success invalidate — never from here.
//
// Desktop test env is `node` (no jsdom/RTL), so — like the sibling viewer-scope
// fences — this asserts the source structure rather than rendering the hook.

describe('useConversationUnread converges the followed∩unread dataset, not the All list', () => {
  const source = readFileSync(
    fileURLToPath(new URL('./message-unread.ts', import.meta.url)),
    'utf8',
  );

  it('gates the signal on the current viewer scope', () => {
    expect(source).toContain('subscribeViewerScope()');
    expect(source).toContain('isCurrentViewerScope(frame.scope)');
  });

  it('invalidates the filtered Unread dataset on BOTH the snapshot and unread_updated branches', () => {
    // The import binding is `channelThreadsUnreadKey` (no arg); the two call
    // sites are `channelThreadsUnreadKey(conversationId)`. Exactly two ⇒ both
    // branches refetch the filtered sibling.
    const calls = source.split('channelThreadsUnreadKey(conversationId)').length - 1;
    expect(calls).toBe(2);
  });

  it('never invalidates the follow-agnostic All threads list from a viewer unread signal', () => {
    // The exact All key must not be touched here — this module doesn't even
    // import it. A viewer unread/follow change is not an All-list membership or
    // order change.
    expect(source).not.toContain('channelThreadsKey(');
  });
});
