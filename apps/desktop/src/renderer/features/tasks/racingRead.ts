import { type QueryClient } from "@tanstack/react-query";

/**
 * Restart a read on `key` that was ISSUED BEFORE the patch we just committed.
 *
 * React Query commits a settled response over anything written since it was
 * issued, so a read already in flight will silently undo the value just
 * assigned — and `staleTime` does not re-read on a timer, so nothing corrects it
 * afterwards. This is the same rule as `patchMessageInActiveProjections`
 * (docs/reactions-design.md §5.3), and it lives in its own module because BOTH
 * owners of a task projection need it: the App-level event path
 * (`taskProjection.ts`) and the chip's own cache
 * (`applyTaskChangedToTaskByNumberCache`).
 *
 * Two states, and they need different verbs:
 *
 *   - an entry that HAS data is restarted by `invalidateQueries` alone, which
 *     cancels the old retryer (its promise is already rejected, so that response
 *     can never commit) and issues a read that can only snapshot at-or-after this
 *     commit. Not `cancelQueries` on its own: with `revert` it puts the whole
 *     query back to its pre-fetch state, discarding the patch we are protecting.
 *   - a COLD entry (a first load, `data === undefined`) is NOT restarted by
 *     `invalidateQueries` at all. `Query.fetch` only cancels-and-restarts when
 *     `state.data !== undefined`; a pending fetch is handed back its existing
 *     promise instead. And the invalidation does not even survive that response —
 *     committing it dispatches a success, which clears `isInvalidated` — so the
 *     pre-patch value becomes the FIRST paint and stays. Cancelling first is what
 *     makes the restart possible: the retryer is rejected and the entry returns to
 *     exactly the state it was in before the fetch (pending, idle, no data), so
 *     nothing is discarded and the invalidation below issues a fresh read.
 *
 * A key that is not fetching is left alone — there is no racing read to restart,
 * and invalidating it would spend a request to re-read what the patch already
 * says.
 */
export function restartRacingRead(qc: QueryClient, key: readonly unknown[]): void {
  const state = qc.getQueryState(key);
  if (state?.fetchStatus !== "fetching") return;
  if (state.data === undefined) {
    void qc.cancelQueries({ queryKey: key, exact: true });
  }
  void qc.invalidateQueries({ queryKey: key, exact: true });
}
