/**
 * D4.a Commit 6 (4) — `useBackendUnreachableSnitch`
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
 * **Why a separate hook, not inline in the banner component?**
 * The hook owns the subscription / state machine; the banner is a
 * pure presentation component that takes `(visible, retry)` props.
 * This keeps the load-bearing invariants (which event types trigger
 * visibility, what auto-clears it) testable without React DOM.
 *
 * **State machine.**
 *   - hidden (initial): no recent backend_unreachable error.
 *   - visible: at least one tracked query/mutation has settled
 *     with `ApiError && kind === 'backend_unreachable'` since
 *     the last clear. Stays visible until either:
 *       (a) the user clicks Retry → `invalidateQueries()` AND we
 *           reset to hidden; the next round of queries decides
 *           whether to flip back to visible.
 *       (b) any query/mutation succeeds (status='success') after
 *           the banner was visible → auto-hide, since the server
 *           is now reachable.
 *
 * **What we deliberately don't pin here:**
 *   - Polling / auto-retry. Cindy "Retry button (NOT
 *     Reconnecting...)" excludes it; the renderer trusts the user.
 *   - A "last error message" surface. Banner shows static copy
 *     because the underlying error usually has no UI-actionable
 *     detail (just `0 Network Error: ...`). The
 *     `BackendUnreachableGate` already covers the rich diagnostic
 *     boot-time UX.
 */
import { useEffect, useRef, useState } from 'react';
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
 * Pure helper exposed for tests: given an arbitrary error, decide
 * whether it counts as a `backend_unreachable` event for banner
 * purposes. Exported so the snitch state-machine logic is testable
 * independent of React Query plumbing.
 *
 * Pin: ONLY `ApiError && kind === 'backend_unreachable'` counts.
 * - Generic `ApiError(404)` → false (real backend error, the route
 *   handler should render route-specific copy).
 * - Plain `Error('fetch failed')` → false (not an ApiError; means a
 *   non-API path threw, e.g. a renderer bug — should NOT impersonate
 *   a server-down condition).
 * - `null` / `undefined` → false (defense against bad inputs).
 */
export function isBackendUnreachableError(err: unknown): boolean {
  return err instanceof ApiError && err.kind === 'backend_unreachable';
}

/**
 * Subscribe to React Query's query + mutation caches and mirror
 * the "any backend_unreachable error seen since last clear" bit
 * into local React state. Auto-clears on the first subsequent
 * success.
 */
export function useBackendUnreachableSnitch(
  /** Optional injected client — defaults to the React Query
   *  context client. Used by tests to inject a fresh client. */
  injectedClient?: QueryClient,
): BackendUnreachableSnitch {
  const contextClient = useQueryClient();
  const client = injectedClient ?? contextClient;
  const [visible, setVisible] = useState(false);
  // Keep the latest `visible` value in a ref so the cache
  // subscriber callbacks can read it without re-subscribing on
  // every render (cache.subscribe semantics).
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  useEffect(() => {
    const queryCache = client.getQueryCache();
    const mutationCache = client.getMutationCache();

    const onQueryEvent = (event: { type: string; query?: unknown }): void => {
      // Only react to `updated` events that carry a settled state
      // transition (`fetchStatus` going idle, status flipping).
      // The subscribe API hands us a discriminated union but the
      // exact event shape varies across React Query minor versions —
      // be conservative: peek at the query state directly.
      const q = (event as { query?: { state: { status: string; error: unknown } } })
        .query;
      if (!q) return;
      const state = q.state;
      if (state.status === 'error') {
        if (isBackendUnreachableError(state.error)) {
          if (!visibleRef.current) setVisible(true);
        }
      } else if (state.status === 'success') {
        // First success after the banner went up → server is back.
        if (visibleRef.current) setVisible(false);
      }
    };

    const onMutationEvent = (event: { mutation?: unknown }): void => {
      const m = (
        event as {
          mutation?: { state: { status: string; error: unknown } };
        }
      ).mutation;
      if (!m) return;
      const state = m.state;
      if (state.status === 'error') {
        if (isBackendUnreachableError(state.error)) {
          if (!visibleRef.current) setVisible(true);
        }
      } else if (state.status === 'success') {
        if (visibleRef.current) setVisible(false);
      }
    };

    const unsubQ = queryCache.subscribe(onQueryEvent);
    const unsubM = mutationCache.subscribe(onMutationEvent);
    return () => {
      unsubQ();
      unsubM();
    };
  }, [client]);

  const retry = (): void => {
    // Hide first so the banner doesn't flicker between
    // invalidate-triggered loading and the next settle. If the
    // next round of queries also errors out as backend_unreachable,
    // the subscriber will flip `visible` back to true on its own.
    setVisible(false);
    void client.invalidateQueries();
  };

  return { visible, retry };
}
