/**
 * Pure freshness gate for thread mark-read (#task:1226 surface 4, §9).
 *
 * Opening a thread marks its reply-cluster read (read-to-clear), advancing the
 * viewer's per-thread `conversation_reads` cursor to the OPEN-TIME stream head.
 * The hard part is proving the snapshot came from THIS open's window response —
 * not the previous open's cache that React Query serves synchronously on
 * reopen, and not a `setQueryData` mutation (optimistic `patchReplySummary` /
 * live-append) that bumps `dataUpdatedAt` without being a real window read.
 *
 * So the gate keys on `windowFetchSucceededAt` — an epoch stamped ONLY inside
 * the cluster query's success path (unreachable by `setQueryData`) — compared
 * against `openedAt`, captured when the (channel, root) open began. The
 * once-guard (`alreadyMarkedForOpen`) is re-armed per open by the caller, so a
 * stale cache can never lock the guard before a fresh fetch lands.
 *
 * Returns the snapshot seq to mark, or null to wait / skip. Kept pure so the
 * reopen-stale-cache regression is testable without React render timing.
 */
export interface ThreadMarkReadGateInput {
  /** True once this open has already fired mark-read (re-armed per open). */
  alreadyMarkedForOpen: boolean;
  /** A cluster fetch is in flight (initial window or pagination). */
  isFetching: boolean;
  /** `pages[0].stream_head_seq` of the loaded window — may be stale cache. */
  headSeq: number | null;
  /** Epoch (ms) of the last SUCCESSFUL window fetch; stamped only on the
   *  queryFn success path, never by `setQueryData`. */
  windowFetchSucceededAt: number;
  /** Epoch (ms) captured at the moment this (channel, root) open began. */
  openedAt: number;
}

export function threadMarkReadSnapshot(
  input: ThreadMarkReadGateInput,
): number | null {
  // Already marked for this open — do not re-fire (idempotent per open).
  if (input.alreadyMarkedForOpen) return null;
  // Wait for any in-flight fetch to settle before reading the head.
  if (input.isFetching) return null;
  // No window loaded yet.
  if (input.headSeq === null) return null;
  // The decisive gate: the loaded window must come from a fetch that SUCCEEDED
  // at/after this open. A previous-open cache (older success epoch) or a
  // `setQueryData` update (does not advance the epoch) fails here, so the
  // once-guard is never armed on a stale snapshot.
  if (input.windowFetchSucceededAt < input.openedAt) return null;
  return input.headSeq;
}

/**
 * Whether a thread open must trigger a fresh latest-window refetch (#task:1226
 * §9.10). A NORMAL open does: it forces a fresh latest window so its mark
 * snapshot comes from this open. A JUMP open does NOT: `primeAround` already
 * fetched the authoritative around-first-unread window (and stamped the
 * freshness epoch), so a target-less latest refetch here would CLOBBER it —
 * breaking the "click chip → land on first unread" surface-3 contract.
 *
 * Pure so the clobber-prevention decision is locked by a unit test instead of
 * only living in component wiring.
 */
export function threadOpenNeedsLatestRefetch(input: {
  isJumpOpen: boolean;
}): boolean {
  return !input.isJumpOpen;
}
