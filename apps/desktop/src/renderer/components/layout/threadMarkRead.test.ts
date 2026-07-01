import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import {
  clusterInitialFetchEnabled,
  threadClusterShowsLoader,
  threadLiveMarkReadSeq,
  threadMarkReadSnapshot,
  threadOpenNeedsLatestRefetch,
  type ThreadMarkReadGateInput,
} from './threadMarkRead';
import { clusterFetchEpochKey } from '@/features/channels/hooks';

// Baseline: a clean open whose fetch has succeeded after open, nothing marked
// yet, window head loaded. Each test overrides only what it exercises.
function gate(over: Partial<ThreadMarkReadGateInput>): ThreadMarkReadGateInput {
  return {
    alreadyMarkedForOpen: false,
    isFetching: false,
    headSeq: 42,
    windowFetchSucceededAt: 2_000,
    openedAt: 1_000,
    ...over,
  };
}

describe('threadMarkReadSnapshot — fresh-for-this-open gate (#task:1226 §9)', () => {
  it('marks with the window head once this open’s fetch has succeeded', () => {
    expect(threadMarkReadSnapshot(gate({}))).toBe(42);
  });

  it('does not re-mark within the same open (once-guard)', () => {
    expect(
      threadMarkReadSnapshot(gate({ alreadyMarkedForOpen: true })),
    ).toBeNull();
  });

  it('waits while a fetch is in flight', () => {
    expect(threadMarkReadSnapshot(gate({ isFetching: true }))).toBeNull();
  });

  it('waits until a window has loaded (null head)', () => {
    expect(threadMarkReadSnapshot(gate({ headSeq: null }))).toBeNull();
  });

  // --- The blocker Cindy caught: reopen serves the previous open's cache. ---

  it('NEGATIVE (a): does not mark on the previous open’s stale cache', () => {
    // Reopen at openedAt=5000; React Query synchronously returns the prior
    // open's cached window (head S=42) whose success epoch (2000) predates this
    // open. Must NOT mark, and must NOT arm the once-guard, so the fresh fetch
    // can still mark.
    const stale = gate({
      openedAt: 5_000,
      windowFetchSucceededAt: 2_000, // last success was the PREVIOUS open
      headSeq: 42,
    });
    expect(threadMarkReadSnapshot(stale)).toBeNull();
  });

  it('NEGATIVE (b): does not mark when setQueryData updated data before this open’s refetch succeeded', () => {
    // During this open, a setQueryData mutation (e.g. a live row append) updates
    // the cache. That does NOT advance windowFetchSucceededAt, so even with
    // fresh-looking data present and no fetch in flight, the gate stays closed
    // until the real window response lands.
    const setDataOnly = gate({
      openedAt: 5_000,
      windowFetchSucceededAt: 2_000, // unchanged by setQueryData
      headSeq: 99, // head value present, but not from a window fetch this open
      isFetching: false,
    });
    expect(threadMarkReadSnapshot(setDataOnly)).toBeNull();
  });

  it('marks once this open’s window refetch finally succeeds with the new head', () => {
    // The fix's success path: after the reopen, the real window response lands
    // (success epoch 6000 >= openedAt 5000) carrying the new head S+1.
    const fresh = gate({
      openedAt: 5_000,
      windowFetchSucceededAt: 6_000,
      headSeq: 43, // S+1 — the reply that arrived while the thread was closed
    });
    expect(threadMarkReadSnapshot(fresh)).toBe(43);
  });

  it('treats windowFetchSucceededAt == openedAt as fresh (boundary)', () => {
    expect(
      threadMarkReadSnapshot(
        gate({ openedAt: 5_000, windowFetchSucceededAt: 5_000 }),
      ),
    ).toBe(42);
  });
});

describe('threadOpenNeedsLatestRefetch — jump-window clobber prevention (§9.10)', () => {
  it('forces a latest refetch on a NORMAL open (snapshot must be this open’s)', () => {
    expect(threadOpenNeedsLatestRefetch({ isJumpOpen: false })).toBe(true);
  });

  it('does NOT refetch on a JUMP open (primeAround owns the around-window)', () => {
    // The blocker: a target-less latest refetch would clobber the
    // around-first-unread window primeAround wrote, breaking "click chip → land
    // on first unread". A jump open must rely on primeAround instead.
    expect(threadOpenNeedsLatestRefetch({ isJumpOpen: true })).toBe(false);
  });
});

describe('clusterInitialFetchEnabled — empty-cache jump race (§9.10, Cindy)', () => {
  it('enables the initial fetch on a NORMAL open (no prime pending)', () => {
    // A normal open keeps its mount-time latest initial fetch — that fetch IS
    // this open's window and what arms the mark-read gate.
    expect(
      clusterInitialFetchEnabled({
        hasChannelAndRoot: true,
        jumpPrimePending: false,
      }),
    ).toBe(true);
  });

  it('DISABLES the query while a jump-open is still priming (no latest may pre-empt primeAround)', () => {
    // The blocker: enabled + empty cache → React Query fires a target-less
    // LATEST initial fetch regardless of refetchOnMount, racing primeAround's
    // around-window. Holding the query disabled while the prime is pending
    // makes primeAround the sole writer of this open's window.
    expect(
      clusterInitialFetchEnabled({
        hasChannelAndRoot: true,
        jumpPrimePending: true,
      }),
    ).toBe(false);
  });

  it('re-enables once the jump prime resolves (commit → reads around; fail → latest fallback)', () => {
    // When primeAround resolves, `jumpPrimePending` flips false and the query
    // re-enables. On commit the cache is present → refetchOnMount:false → it
    // reads the around-window with no fetch. On failure the cache is empty → a
    // latest initial fetch fires as a graceful fallback (pane never blank).
    expect(
      clusterInitialFetchEnabled({
        hasChannelAndRoot: true,
        jumpPrimePending: false,
      }),
    ).toBe(true);
  });

  it('stays disabled without a channel/root regardless of prime state', () => {
    expect(
      clusterInitialFetchEnabled({
        hasChannelAndRoot: false,
        jumpPrimePending: false,
      }),
    ).toBe(false);
  });
});

describe('threadClusterShowsLoader — locate-deadlock prevention (§9.10, Cindy)', () => {
  it('shows the loader on a real in-flight fetch', () => {
    expect(
      threadClusterShowsLoader({
        isLoading: true,
        jumpPrimePending: false,
        hasWindow: false,
      }),
    ).toBe(true);
  });

  it('shows the loader while a jump primes with no window yet (avoids "No replies yet" flash)', () => {
    // Pre-commit: query disabled (isLoading false), no around-window in cache.
    expect(
      threadClusterShowsLoader({
        isLoading: false,
        jumpPrimePending: true,
        hasWindow: false,
      }),
    ).toBe(true);
  });

  it('RENDERS the window once primeAround commits, even though prime is still pending', () => {
    // The deadlock Cindy caught: primeAround success does NOT clear
    // `jumpPrimePending` (the controller waits for the visual locate/flash). The
    // around-window is now in the disabled query's cache (hasWindow true), so we
    // must render it — keeping the loader up would starve the locate effect of
    // its `#msg-<id>` DOM node and time the jump out.
    expect(
      threadClusterShowsLoader({
        isLoading: false,
        jumpPrimePending: true,
        hasWindow: true,
      }),
    ).toBe(false);
  });

  it('does not show the loader once settled', () => {
    expect(
      threadClusterShowsLoader({
        isLoading: false,
        jumpPrimePending: false,
        hasWindow: true,
      }),
    ).toBe(false);
  });
});

describe('cluster freshness epoch carrier (primeAround → gate, §9.10)', () => {
  // Integration at the cache layer (no React render harness in this env): the
  // epoch carrier is the channel by which primeAround's around-fetch arms the
  // mark-read gate. A live reply / optimistic patch writes the WINDOW key, not
  // this epoch key, so it must not move the epoch and must not open the gate.
  it('lets a primeAround-style epoch write open the gate, while a window-only write does not', () => {
    const qc = new QueryClient();
    const channelId = 'chan-1';
    const rootId = 'root-1';
    const epochKey = clusterFetchEpochKey(channelId, rootId);

    // This open began at t=5000 (captured at render before any fetch resolved).
    const openedAt = 5_000;
    const headSeq = 43; // S+1 head from the around-window response

    // (1) Before primeAround stamps: no epoch → gate closed.
    const before = (qc.getQueryData<number>(epochKey)) ?? 0;
    expect(before).toBe(0);
    expect(
      threadMarkReadSnapshot({
        alreadyMarkedForOpen: false,
        isFetching: false,
        headSeq,
        windowFetchSucceededAt: before,
        openedAt,
      }),
    ).toBeNull();

    // (2) A live reply / optimistic patch touches the WINDOW, never the epoch
    //     key — so the epoch is still 0 and the gate stays closed.
    const afterSetData = (qc.getQueryData<number>(epochKey)) ?? 0;
    expect(afterSetData).toBe(0);

    // (3) primeAround's around-fetch succeeds and stamps the epoch (>= openedAt)
    //     → gate opens with the around-window head.
    qc.setQueryData(epochKey, 6_000);
    const afterPrime = (qc.getQueryData<number>(epochKey)) ?? 0;
    expect(afterPrime).toBe(6_000);
    expect(
      threadMarkReadSnapshot({
        alreadyMarkedForOpen: false,
        isFetching: false,
        headSeq,
        windowFetchSucceededAt: afterPrime,
        openedAt,
      }),
    ).toBe(headSeq);
  });
});

describe('threadLiveMarkReadSeq (#task:1226 visible-live mark-read)', () => {
  const base = {
    pinnedAtTail: true,
    documentVisible: true,
    maxVisibleSeq: 42,
    lastMarkedSeq: 10,
  };

  it('tail pinned + visible + newer reply → marks to the visible tail seq', () => {
    expect(threadLiveMarkReadSeq(base)).toBe(42);
  });

  it('not pinned at tail (scrolled up) → null (no swallow of unrendered tail)', () => {
    expect(threadLiveMarkReadSeq({ ...base, pinnedAtTail: false })).toBeNull();
  });

  it('document hidden / backgrounded → null even when pinned at tail', () => {
    expect(threadLiveMarkReadSeq({ ...base, documentVisible: false })).toBeNull();
  });

  it('empty window (no visible seq) → null', () => {
    expect(threadLiveMarkReadSeq({ ...base, maxVisibleSeq: null })).toBeNull();
  });

  it('already marked at/after the visible tail → null (forward-only)', () => {
    expect(
      threadLiveMarkReadSeq({ ...base, maxVisibleSeq: 42, lastMarkedSeq: 42 }),
    ).toBeNull();
    expect(
      threadLiveMarkReadSeq({ ...base, maxVisibleSeq: 41, lastMarkedSeq: 42 }),
    ).toBeNull();
  });

  it('retriable: a stalled mark leaves lastMarkedSeq low, so the same seq is still returned next trigger', () => {
    // onSuccess is what advances lastMarkedSeq; a failed mutation leaves it
    // unchanged, so re-evaluating with the same window re-proposes the seq.
    expect(
      threadLiveMarkReadSeq({ ...base, maxVisibleSeq: 42, lastMarkedSeq: 10 }),
    ).toBe(42);
  });

  it('visibility transition: a reply received while hidden marks only after returning to foreground (Cindy review)', () => {
    // A reply arrives while the app is backgrounded and the panel is pinned at
    // the tail. While hidden the gate holds it unread (no swallow of an unseen
    // reply)…
    const reply = { ...base, pinnedAtTail: true, maxVisibleSeq: 42, lastMarkedSeq: 10 };
    expect(threadLiveMarkReadSeq({ ...reply, documentVisible: false })).toBeNull();
    // …and the moment the user returns to the foreground (visibilitychange →
    // documentVisible true, same pinned tail) the SAME seq becomes markable.
    // The component wires `documentVisible` as a state/effect dependency so this
    // transition actually re-runs the gate.
    expect(threadLiveMarkReadSeq({ ...reply, documentVisible: true })).toBe(42);
  });
});
