import { useEffect, useState } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@/lib/api";

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
  return err instanceof ApiError && err.kind === "backend_unreachable";
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
  backendReachability?: "neutral";
}

export function decideNextVisible(event: SnitchCacheEvent): boolean | null {
  if (event.backendReachability === "neutral") return null;
  if (event.status === "error") {
    return isBackendUnreachableError(event.error) ? true : null;
  }
  if (event.status === "success") return false;
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

      queueMicrotask(() => {
        if (!cancelled) setVisible(next);
      });
    };

    const onQueryEvent = (event: { query?: unknown }): void => {
      const q = (
        event as {
          query?: {
            state: { status: string; error: unknown };
            meta?: Record<string, unknown>;
          };
        }
      ).query;
      if (!q) return;
      apply({
        status: q.state.status,
        error: q.state.error,
        // Copy the reachability marker off the query's meta so a
        // local-IPC poll (e.g. backend:info, #task:1462) can't toggle
        // the banner. Read from meta, not the query key string.
        backendReachability: q.meta?.backendReachability === "neutral" ? "neutral" : undefined,
      });
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
    setVisible(false);
    void client.invalidateQueries();
  };

  return { visible, retry };
}
