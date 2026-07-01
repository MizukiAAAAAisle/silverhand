import type { MessageSeq } from '@silverhand/shared';

/**
 * Pure freshness gate for thread mark-read (#task:1226 surface 4, §9).
 *
 * Opening a thread marks its reply-cluster read (read-to-clear), advancing the
 * viewer's per-thread `conversation_reads` cursor to the OPEN-TIME stream head.
 * The hard part is proving the snapshot came from THIS open's window response —
 * not the previous open's cache that React Query serves synchronously on
 * reopen, and not a `setQueryData` mutation (an optimistic live-append) that
 * bumps `dataUpdatedAt` without being a real window read.
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
  /** `pages[0].stream_head_seq` of the loaded window — may be stale cache.
   *  A MessageSeq (open-time stream head), or null when no window is loaded. */
  headSeq: MessageSeq | null;
  /** Epoch (ms) of the last SUCCESSFUL window fetch; stamped only on the
   *  queryFn success path, never by `setQueryData`. */
  windowFetchSucceededAt: number;
  /** Epoch (ms) captured at the moment this (channel, root) open began. */
  openedAt: number;
}

export function threadMarkReadSnapshot(
  input: ThreadMarkReadGateInput,
): MessageSeq | null {
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

/**
 * Whether `useThreadCluster`'s underlying infinite query may auto-fire its
 * initial fetch (#task:1226 §9.10 — the empty-cache race Cindy caught). React
 * Query fires the initial fetch on an EMPTY cache whenever the query is
 * `enabled`, REGARDLESS of `refetchOnMount` (the flag only governs refetch when
 * a cache already exists). On a jump-open that initial fetch is a target-less
 * LATEST window, and it races `primeAround`'s around-first-unread fetch —
 * whichever lands first writes `clusterMessagesKey` + the freshness epoch and
 * wins, so a latest could clobber the locate window and open the mark-read gate
 * before the around-window arrives.
 *
 * So while a jump-open's prime is still PENDING we keep the query DISABLED:
 * `primeAround` becomes the sole writer of this open's window — no latest can
 * pre-empt it. Once the prime resolves the query re-enables (NOT a mount, so
 * `refetchOnMount:false` still suppresses a refetch): cache present (prime
 * committed) → the around-window is read with no fetch; cache empty (prime
 * failed/aborted) → a latest initial fetch fires as a graceful fallback so the
 * pane is never left blank. A normal open never gates (no prime pending), so it
 * keeps its mount-time latest initial fetch exactly as before.
 *
 * Pure so the "jump-open does not mount as a latest-initial-fetch-enabled
 * query" invariant is locked by a unit test instead of only living in hook
 * wiring (no RTL/jsdom mount harness in this env).
 */
export function clusterInitialFetchEnabled(input: {
  hasChannelAndRoot: boolean;
  jumpPrimePending: boolean;
}): boolean {
  return input.hasChannelAndRoot && !input.jumpPrimePending;
}

/**
 * Whether ThreadPanel's reply area shows the loader vs. its content (#task:1226
 * §9.10, Cindy's locate-deadlock catch). On a jump-open the cluster query is
 * held disabled while priming (`clusterInitialFetchEnabled`), so `isLoading` is
 * false even though no window has landed yet — without a loader the pane would
 * flash "No replies yet". BUT `primeAround` success does NOT clear the prime
 * pending flag: by the controller's existing contract it stays set until the
 * VISUAL locate/flash completes and calls `onJumped → clearJump`. So once the
 * around-window commits into the cache the disabled query's `data` already
 * carries it (`hasWindow` true) and we MUST render it — keeping the loader up on
 * `jumpPrimePending` alone would hide the messages, the locate effect could
 * never find `#msg-<id>` in the DOM, and the jump would time out with the
 * first-unread locate/flash failed.
 *
 * So the loader shows only while there is genuinely nothing to render yet: a
 * real in-flight fetch, OR a still-priming jump whose window has not committed.
 * Pure so the "window present → render, not loader" invariant is unit-tested.
 */
export function threadClusterShowsLoader(input: {
  isLoading: boolean;
  jumpPrimePending: boolean;
  hasWindow: boolean;
}): boolean {
  return input.isLoading || (input.jumpPrimePending && !input.hasWindow);
}

export interface ThreadLiveMarkReadInput {
  /** The viewer is pinned at the tail — the newest reply is on screen. When
   *  false (scrolled up into history) the newest reply isn't seen, so we must
   *  NOT advance: no-swallow means the cursor only follows what was visible. */
  pinnedAtTail: boolean;
  /** The app window / document is visible. A panel that is "open" but
   *  backgrounded hasn't actually been seen, so a live append must not mark it
   *  read (Cindy bar #4). */
  documentVisible: boolean;
  /** Highest seq the viewer has actually seen — at-tail this is the loaded
   *  window's max (tail) reply seq. Deliberately NOT `stream_head_seq` and NOT
   *  the max of every cached reply: the semantic is max-VISIBLE, not
   *  latest-known (Cindy bar #3). Null when the window is empty. */
  maxVisibleSeq: MessageSeq | null;
  /** Highest seq already SUCCESSFULLY marked read this open — a MessageSeq, or
   *  null when nothing has been marked yet (explicit absence, not a 0 sentinel:
   *  #task:1267 Axis-B discipline forbids collapsing "none" into value 0). */
  lastMarkedSeq: MessageSeq | null;
}

/**
 * Visible-live mark-read decision (#task:1226 — shiki dogfood: a reply that
 * arrives while the panel is open + watched should clear unread without a
 * close/reopen). Initial open still marks the open-time snapshot
 * (`threadMarkReadSnapshot`); THIS governs subsequent live appends.
 *
 * Returns the seq to advance the read cursor to, or null to hold unread. We
 * advance ONLY when the newest reply is genuinely on screen (pinned at tail AND
 * the window visible) and it is newer than what we've marked — so a reply that
 * lands while the user is scrolled up, or the app is backgrounded, stays unread
 * until they actually see it. This preserves the no-swallow invariant: the
 * cursor never jumps past an unrendered tail.
 *
 * The caller owns the side-effecting concerns this purposely excludes: advance
 * `lastMarkedSeq` only on mutation SUCCESS (Cindy bar #2), debounce bursts, and
 * skip while a mark is in flight. Pure so the gate is unit-tested without React
 * render/scroll timing.
 */
export function threadLiveMarkReadSeq(
  input: ThreadLiveMarkReadInput,
): MessageSeq | null {
  if (!input.pinnedAtTail) return null;
  if (!input.documentVisible) return null;
  if (input.maxVisibleSeq === null) return null;
  // Same-stream (this thread) MessageSeq compare, guarded on explicit absence:
  // "nothing marked yet" (null) never blocks the first advance (#task:1267 B4).
  if (input.lastMarkedSeq !== null && input.maxVisibleSeq <= input.lastMarkedSeq)
    return null;
  return input.maxVisibleSeq;
}
