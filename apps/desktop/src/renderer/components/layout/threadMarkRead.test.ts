import { describe, expect, it } from 'vitest';
import {
  threadMarkReadSnapshot,
  type ThreadMarkReadGateInput,
} from './threadMarkRead';

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
    // During this open, an optimistic patchReplySummary / live-append bumps the
    // cache via setQueryData. That does NOT advance windowFetchSucceededAt, so
    // even with fresh-looking data present and no fetch in flight, the gate
    // stays closed until the real window response lands.
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
