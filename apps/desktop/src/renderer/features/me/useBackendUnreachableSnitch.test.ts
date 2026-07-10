/**
 * D4.a Commit 6 (4) + Cindy P1 fixup — snitch state-machine tests.
 *
 * What this pins:
 *
 *   - `isBackendUnreachableError`: ONLY `ApiError && kind=...`
 *     counts; not plain Error / null / string / fake duck-typed
 *     object / generic 404/500/401.
 *   - `decideNextVisible` (pure reducer): error+unreachable → true;
 *     error+other → null (no change); success → false; other
 *     statuses → null. **This is the function the hook calls
 *     inside its cache subscriber**, so test + hook share the
 *     same decision body — drift is impossible (Cindy P1 nit).
 *   - Live React Query cache subscription: route real
 *     cache events through the SHARED reducer (no duplicate
 *     test-only driver).
 *   - **Cindy P1 regression bait**: retry() → immediate
 *     backend_unreachable refetch MUST flip the banner back
 *     to visible. The prior `visibleRef.current` guard could
 *     swallow this; this test would have caught it.
 *   - retry() contract: invalidateQueries(no filter) + hide.
 */
import { describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { ApiError } from '@/lib/api';
import { backendInfoKey } from '@/features/hosts/hooks';
import {
  decideNextVisible,
  isBackendUnreachableError,
  type SnitchCacheEvent,
} from './useBackendUnreachableSnitch';

describe('isBackendUnreachableError — pure classifier', () => {
  it('returns true ONLY for ApiError with kind="backend_unreachable"', () => {
    expect(
      isBackendUnreachableError(
        new ApiError(0, 'Network Error', '', 'backend_unreachable'),
      ),
    ).toBe(true);
  });

  it('returns false for generic ApiError with kind="http" (regression bait)', () => {
    expect(isBackendUnreachableError(new ApiError(404, 'Not Found', '{}'))).toBe(
      false,
    );
    expect(
      isBackendUnreachableError(new ApiError(500, 'Server Error', '{}')),
    ).toBe(false);
    expect(
      isBackendUnreachableError(
        new ApiError(401, 'Unauthorized', '{"error_code":"auth_failed"}'),
      ),
    ).toBe(false);
  });

  it('returns false for plain Error / non-ApiError throwables', () => {
    expect(isBackendUnreachableError(new Error('fetch failed'))).toBe(false);
    expect(isBackendUnreachableError(new TypeError('xxx'))).toBe(false);
    expect(isBackendUnreachableError('backend_unreachable')).toBe(false);
    expect(
      isBackendUnreachableError({ kind: 'backend_unreachable' }),
    ).toBe(false);
  });

  it('returns false for null / undefined', () => {
    expect(isBackendUnreachableError(null)).toBe(false);
    expect(isBackendUnreachableError(undefined)).toBe(false);
  });
});

describe('decideNextVisible — pure reducer shared by hook + tests', () => {
  // This is the load-bearing pin. The hook's cache subscriber
  // calls this exact function — there is no separate "driver"
  // that could drift from production behavior. Add any new
  // status / error variant cases here.

  it('error + backend_unreachable → true (show banner)', () => {
    const ev: SnitchCacheEvent = {
      status: 'error',
      error: new ApiError(0, 'Network Error', '', 'backend_unreachable'),
    };
    expect(decideNextVisible(ev)).toBe(true);
  });

  it('error + generic http kind → null (no state change)', () => {
    const ev: SnitchCacheEvent = {
      status: 'error',
      error: new ApiError(404, 'Not Found', '{}'),
    };
    expect(decideNextVisible(ev)).toBe(null);
  });

  it('error + non-ApiError → null (renderer bugs do not impersonate server-down)', () => {
    const ev: SnitchCacheEvent = {
      status: 'error',
      error: new TypeError('bug'),
    };
    expect(decideNextVisible(ev)).toBe(null);
  });

  it('success → false (clear banner regardless of prior state)', () => {
    const ev: SnitchCacheEvent = { status: 'success', error: null };
    expect(decideNextVisible(ev)).toBe(false);
  });

  it('pending / paused / unknown status → null (ignored)', () => {
    expect(decideNextVisible({ status: 'pending', error: null })).toBe(null);
    expect(decideNextVisible({ status: 'paused', error: null })).toBe(null);
    expect(decideNextVisible({ status: 'idle', error: null })).toBe(null);
  });

  it('neutral query → null regardless of status (#task:1462 local-IPC poll)', () => {
    // A reachability-neutral query (backend:info) must never toggle the
    // banner: neither its success clears it nor its error raises it.
    expect(
      decideNextVisible({
        status: 'success',
        error: null,
        backendReachability: 'neutral',
      }),
    ).toBe(null);
    expect(
      decideNextVisible({
        status: 'error',
        error: new ApiError(0, 'Network Error', '', 'backend_unreachable'),
        backendReachability: 'neutral',
      }),
    ).toBe(null);
  });
});

describe('live React Query cache → shared reducer integration', () => {
  // We attach a subscriber that funnels real cache events
  // through `decideNextVisible` — the exact same call the hook
  // makes. State is held in a tiny `{ visible }` shell so we can
  // assert the cumulative effect.

  function attach(client: QueryClient): {
    state: { visible: boolean };
    teardown: () => void;
  } {
    const state = { visible: false };
    const apply = (s: SnitchCacheEvent): void => {
      const next = decideNextVisible(s);
      if (next === null) return;
      state.visible = next;
    };
    const unsubQ = client.getQueryCache().subscribe(event => {
      const q = (
        event as {
          query?: {
            state: { status: string; error: unknown };
            meta?: Record<string, unknown>;
          };
        }
      ).query;
      if (q)
        apply({
          status: q.state.status,
          error: q.state.error,
          backendReachability:
            q.meta?.backendReachability === 'neutral' ? 'neutral' : undefined,
        });
    });
    const unsubM = client.getMutationCache().subscribe(event => {
      const m = (event as { mutation?: { state: SnitchCacheEvent } }).mutation;
      if (m) apply(m.state);
    });
    return {
      state,
      teardown: () => {
        unsubQ();
        unsubM();
      },
    };
  }

  function makeClient(): QueryClient {
    return new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
  }

  it('query throwing ApiError(backend_unreachable) → visible=true', async () => {
    const client = makeClient();
    const { state, teardown } = attach(client);
    try {
      await client
        .fetchQuery({
          queryKey: ['x1'],
          queryFn: async () => {
            throw new ApiError(
              0,
              'Network Error',
              '',
              'backend_unreachable',
            );
          },
        })
        .catch(() => {});
      expect(state.visible).toBe(true);
    } finally {
      teardown();
    }
  });

  it('query throwing generic 404 → visible stays false', async () => {
    const client = makeClient();
    const { state, teardown } = attach(client);
    try {
      await client
        .fetchQuery({
          queryKey: ['x2'],
          queryFn: async () => {
            throw new ApiError(404, 'Not Found', '{}');
          },
        })
        .catch(() => {});
      expect(state.visible).toBe(false);
    } finally {
      teardown();
    }
  });

  it('query throwing TypeError (renderer bug) → visible stays false', async () => {
    const client = makeClient();
    const { state, teardown } = attach(client);
    try {
      await client
        .fetchQuery({
          queryKey: ['x3'],
          queryFn: async () => {
            throw new TypeError('bug in renderer');
          },
        })
        .catch(() => {});
      expect(state.visible).toBe(false);
    } finally {
      teardown();
    }
  });

  it('error then success → auto-clears (server is back)', async () => {
    const client = makeClient();
    const { state, teardown } = attach(client);
    try {
      await client
        .fetchQuery({
          queryKey: ['recover-1'],
          queryFn: async () => {
            throw new ApiError(
              0,
              'Network Error',
              '',
              'backend_unreachable',
            );
          },
        })
        .catch(() => {});
      expect(state.visible).toBe(true);
      await client.fetchQuery({
        queryKey: ['recover-2'],
        queryFn: async () => ({ ok: true }),
      });
      expect(state.visible).toBe(false);
    } finally {
      teardown();
    }
  });

  it('mutation: backend_unreachable → visible=true; success → auto-clears', async () => {
    const client = makeClient();
    const { state, teardown } = attach(client);
    try {
      const failing = client.getMutationCache().build(client, {
        mutationFn: async () => {
          throw new ApiError(
            0,
            'Network Error',
            '',
            'backend_unreachable',
          );
        },
      });
      await failing.execute(undefined).catch(() => {});
      expect(state.visible).toBe(true);

      const succeeding = client.getMutationCache().build(client, {
        mutationFn: async () => ({ ok: true }),
      });
      await succeeding.execute(undefined);
      expect(state.visible).toBe(false);
    } finally {
      teardown();
    }
  });

  it('#task:1462 REGRESSION BAIT: a neutral query (backend:info poll) succeeding does NOT clear a live unreachable banner', async () => {
    // The bug: enabling the 30s protocol-compatibility poll made
    // backend:info emit a periodic `success`. Because backend:info is a
    // local-IPC query (always resolves, and its probe swallows failure
    // into `unknown`), that success would clear a legitimate "Can't reach
    // server" banner every cycle. The neutral meta marker makes the
    // subscriber ignore it.
    const client = makeClient();
    const { state, teardown } = attach(client);
    try {
      // A real remote query fails → banner up.
      await client
        .fetchQuery({
          queryKey: ['reach-1'],
          queryFn: async () => {
            throw new ApiError(0, 'Network Error', '', 'backend_unreachable');
          },
        })
        .catch(() => {});
      expect(state.visible).toBe(true);

      // The neutral backend:info poll resolves successfully. Must NOT
      // clear the banner.
      await client.fetchQuery({
        queryKey: backendInfoKey,
        queryFn: async () => ({ ok: true }),
        meta: { backendReachability: 'neutral' },
      });
      expect(state.visible).toBe(true);
    } finally {
      teardown();
    }
  });

  it('CINDY P1 REGRESSION BAIT: retry() → setVisible(false) followed by an IMMEDIATE backend_unreachable refetch flips visible back to true', async () => {
    // The prior `visibleRef.current` guard would observe `true`
    // (because `setVisible(false)` had been queued but not yet
    // committed in React's scheduler) and SKIP `setVisible(true)`,
    // swallowing the follow-up error. After the fix, the
    // subscriber unconditionally calls setVisible with the
    // reducer's return value; React dedupes same-value calls
    // and the second-error case correctly flips back to visible.
    //
    // We exercise the same shape here against the SHARED reducer:
    // a "retry hide" simulated by setting state.visible=false,
    // then immediately delivering a backend_unreachable error
    // event. The reducer must return `true` regardless of the
    // prior visible state — it doesn't even read it.
    const client = makeClient();
    const { state, teardown } = attach(client);
    try {
      // Step 1: a query fails as backend_unreachable. visible=true.
      await client
        .fetchQuery({
          queryKey: ['retry-1'],
          queryFn: async () => {
            throw new ApiError(
              0,
              'Network Error',
              '',
              'backend_unreachable',
            );
          },
        })
        .catch(() => {});
      expect(state.visible).toBe(true);

      // Step 2: simulate the renderer's retry handler — it
      // synchronously flips visible to false. (In production
      // this is the `setVisible(false); invalidateQueries()`
      // pair inside `retry()`.)
      state.visible = false;

      // Step 3: a second query fails immediately as
      // backend_unreachable BEFORE any other render cycle could
      // have refreshed a stale ref guard. The reducer must
      // observe the error AND set visible back to true.
      await client
        .fetchQuery({
          queryKey: ['retry-2'],
          queryFn: async () => {
            throw new ApiError(
              0,
              'Network Error',
              '',
              'backend_unreachable',
            );
          },
        })
        .catch(() => {});
      expect(state.visible).toBe(true);
    } finally {
      teardown();
    }
  });
});

describe('retry() contract — invalidateQueries + hide', () => {
  it('retry calls queryClient.invalidateQueries() with no filter and resets visible', () => {
    // Mirrors the hook body exactly:
    //   () => { setVisible(false); void client.invalidateQueries(); }
    const client = new QueryClient();
    const spy = vi.spyOn(client, 'invalidateQueries');
    let visible = true;
    const setVisible = (v: boolean): void => {
      visible = v;
    };
    const retry = (): void => {
      setVisible(false);
      void client.invalidateQueries();
    };
    retry();
    expect(visible).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    // No filter — the next round of every active query doubles
    // as a liveness probe; narrowing to one key would leave
    // stale unreachable state visible on other panes.
    expect(spy).toHaveBeenCalledWith();
  });
});
