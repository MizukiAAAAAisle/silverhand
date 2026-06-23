/**
 * D4.a Commit 6 (4) + Cindy P1 fixup — `useBackendUnreachableSnitch`
 *
 * Cindy boundary lock (`MqA4uoNcRByKcf9E` part 4):
 *
 *   - mount in `RegisteredAppShell`, NOT in App root
 *   - subscribe to React Query errors
 *   - only `ApiError.kind === 'backend_unreachable'` triggers the
 *     banner — generic 4xx/5xx HTTP errors do NOT
 *   - banner copy: "Can't reach server" + Retry button (NOT a
 *     "Reconnecting…" auto-poll affordance — the user owns the
 *     retry decision)
 *   - Retry = `queryClient.invalidateQueries()` (NOT a custom
 *     ping endpoint; the next round of queries doubles as a
 *     liveness probe)
 *
 * **State machine** (pinned by pure `decideNextVisible` reducer
 * below so tests + hook share the same code path — Cindy P1 nit:
 * the prior version had a separate test driver that duplicated
 * the subscriber body, which let `visibleRef` drift unnoticed).
 *
 *   - hidden (initial): no recent backend_unreachable error.
 *   - visible: at least one tracked query/mutation has settled
 *     with `ApiError && kind === 'backend_unreachable'` since
 *     the last clear. Stays visible until either:
 *       (a) the user clicks Retry → `invalidateQueries()` AND we
 *           reset to hidden; the next round of queries decides
 *           whether to flip back to visible.
 *       (b) any query/mutation succeeds (status='success') →
 *           auto-hide, since the server is now reachable.
 *
 * **Cindy P1 fix.** The previous version guarded both branches on
 * a `visibleRef.current` read so we wouldn't re-call setVisible
 * with the same value. But after `retry()` synchronously calls
 * `setVisible(false)`, the ref does NOT update until React's next
 * render commits — so a refetch that fails immediately would be
 * swallowed by the `if (!visibleRef.current) setVisible(true)`
 * guard reading the stale `true`. We now drop the ref entirely
 * and call `setVisible(next)` directly with whatever the reducer
 * returned; React bails out on same-value setState internally, so
 * we get the dedup behaviour for free without a manual ref guard.
 */
import { useEffect, useState } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from '@/lib/api';

export interface BackendUnreachableSnitch {
  /** Whether the banner should be shown. */
  visible: boolean;
  /** Click handler for the Retry button — runs
   *  `queryClient.invalidateQueries()` and hides the banner. */
  retry: () => void;
}

/**
 * Pure helper: given an arbitrary error, decide whether it counts
 * as a `backend_unreachable` event. Exported for tests AND used
 * by the reducer below.
 *
 * Pin: ONLY `ApiError && kind === 'backend_unreachable'` counts.
 * - Generic `ApiError(404)` → false.
 * - Plain `Error('fetch failed')` → false.
 * - `null` / `undefined` → false.
 * - String / object-with-fake-kind → false (no duck-typing).
 */
export function isBackendUnreachableError(err: unknown): boolean {
  return err instanceof ApiError && err.kind === 'backend_unreachable';
}

/**
 * Cache event shape we care about — both query and mutation
 * cache subscribers normalize into this minimal record before
 * passing it to the reducer. Anything beyond `{status, error}`
 * is ignored.
 */
export interface SnitchCacheEvent {
  status: string;
  error: unknown;
}

/**
 * Pure reducer the hook and the tests both consume. Cindy P1 nit:
 * a separate test-only "driver" that duplicated the subscriber
 * body let `visibleRef` drift go unnoticed — extract the decision
 * to a shared function so drift is impossible.
 *
 * Contract:
 *   - On a `status === 'error'` event where the error matches
 *     `isBackendUnreachableError`, return `true` (banner up).
 *   - On a `status === 'success'` event, return `false` (banner
 *     down — server is back, regardless of prior state).
 *   - On any other status (`pending`, `paused`, etc.) OR an
 *     error that does NOT match, return `null` to mean "no
 *     state change".
 *
 * Returning a sentinel (`null`) instead of mutating `prev` lets
 * callers cheaply ignore irrelevant events without re-issuing
 * `setState(prev)` and triggering subscriber churn.
 */
export function decideNextVisible(event: SnitchCacheEvent): boolean | null {
  if (event.status === 'error') {
    return isBackendUnreachableError(event.error) ? true : null;
  }
  if (event.status === 'success') return false;
  return null;
}

/**
 * Subscribe to React Query's query + mutation caches and mirror
 * the visibility bit into local React state. Pure-reducer based
 * so the hook body cannot drift from tests.
 */
export function useBackendUnreachableSnitch(
  /** Optional injected client — defaults to the React Query
   *  context client. Used by tests to inject a fresh client. */
  injectedClient?: QueryClient,
): BackendUnreachableSnitch {
  const contextClient = useQueryClient();
  const client = injectedClient ?? contextClient;
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const queryCache = client.getQueryCache();
    const mutationCache = client.getMutationCache();
    let cancelled = false;

    const apply = (event: SnitchCacheEvent): void => {
      const next = decideNextVisible(event);
      if (next === null) return;
      // Defer out of the synchronous cache-notification path. React Query
      // notifies cache subscribers SYNCHRONOUSLY, including when a new query
      // observer mounts during another component's render — e.g. a
      // <HumanMention> calling useUsersById() whose query is already cached
      // emits a 'success' event mid-render. Calling setVisible inline there is
      // a render-phase update of THIS component while that other component
      // renders → React's "Cannot update a component while rendering a
      // different component" warning. A microtask runs once the render stack
      // unwinds, so the flip becomes an ordinary post-render update. React
      // still bails out internally when next === prev (the Cindy P1 fix), so
      // no ref guard is needed.
      queueMicrotask(() => {
        if (!cancelled) setVisible(next);
      });
    };

    const onQueryEvent = (event: { query?: unknown }): void => {
      const q = (event as { query?: { state: SnitchCacheEvent } }).query;
      if (!q) return;
      apply(q.state);
    };

    const onMutationEvent = (event: { mutation?: unknown }): void => {
      const m = (event as { mutation?: { state: SnitchCacheEvent } }).mutation;
      if (!m) return;
      apply(m.state);
    };

    const unsubQ = queryCache.subscribe(onQueryEvent);
    const unsubM = mutationCache.subscribe(onMutationEvent);
    return () => {
      cancelled = true;
      unsubQ();
      unsubM();
    };
  }, [client]);

  const retry = (): void => {
    // Hide first so the banner doesn't flicker between
    // invalidate-triggered loading and the next settle. If the
    // next round of queries also errors out as backend_unreachable,
    // the subscriber flips `visible` back to true on its own —
    // without any ref-based guard to swallow that re-fire (Cindy
    // P1 fix).
    setVisible(false);
    void client.invalidateQueries();
  };

  return { visible, retry };
}
