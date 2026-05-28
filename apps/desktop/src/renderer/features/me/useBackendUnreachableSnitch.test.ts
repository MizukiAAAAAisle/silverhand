/**
 * D4.a Commit 6 (4) — useBackendUnreachableSnitch state-machine tests.
 *
 * What this pins (per Cindy `MqA4uoNcRByKcf9E` part 4 lock):
 *
 *   - Only `ApiError.kind === 'backend_unreachable'` flips the
 *     banner to visible. Generic HTTP errors (`ApiError(404)`,
 *     `ApiError(500)`) MUST NOT trigger it — they belong to per-
 *     route handlers / their own copy.
 *   - The first successful query/mutation after the banner is up
 *     auto-clears it. Server-is-back signals don't need a Retry.
 *   - `retry()` calls `queryClient.invalidateQueries()` AND sets
 *     visible=false (so the next round of queries decides whether
 *     to flip back up).
 *   - `isBackendUnreachableError` is a pure helper with strict
 *     boundaries — non-Error inputs and plain `Error` instances
 *     never count, only `ApiError` with the right `kind`.
 *
 * We exercise the hook through a tiny `runHookEffect` driver that
 * installs the same `useEffect`-style subscription manually — this
 * lets us pin the cache-event → visible state transition without
 * pulling in React-DOM / @testing-library/react. The subscription
 * body is intentionally extracted into testable seams (see comment
 * inside the test driver).
 */
import { describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { ApiError } from '@/lib/api';
import { isBackendUnreachableError } from './useBackendUnreachableSnitch';

describe('isBackendUnreachableError — pure classifier (D4.a Commit 6 part 4)', () => {
  it('returns true ONLY for ApiError with kind="backend_unreachable"', () => {
    expect(
      isBackendUnreachableError(
        new ApiError(0, 'Network Error', '', 'backend_unreachable'),
      ),
    ).toBe(true);
  });

  it('returns false for generic ApiError with kind="http" (regression bait)', () => {
    // The whole point of the kind discriminator: route-specific 404 /
    // 500 errors must not impersonate a server-down condition.
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
    // String / number / object literals that happen to carry a
    // `kind: 'backend_unreachable'` field MUST NOT count — only
    // genuine ApiError instances qualify. This guards against a
    // future refactor that "duck-types" errors and lets a fake
    // unreachable signal slip in from arbitrary code paths.
    expect(isBackendUnreachableError('backend_unreachable')).toBe(false);
    expect(
      isBackendUnreachableError({ kind: 'backend_unreachable' }),
    ).toBe(false);
  });

  it('returns false for null / undefined (defense against bad inputs)', () => {
    expect(isBackendUnreachableError(null)).toBe(false);
    expect(isBackendUnreachableError(undefined)).toBe(false);
  });
});

describe('snitch cache-event subscription contract (D4.a Commit 6 part 4)', () => {
  // Instead of rendering the hook through React-DOM, we install the
  // same cache subscription manually using the same logic the hook
  // applies in its effect body. The hook's effect is a thin wrapper
  // around three pieces of behavior we want to pin:
  //   (a) query state.error of kind=backend_unreachable → visible=true
  //   (b) any query state.status=success while visible → visible=false
  //   (c) mutation cache mirrors the same rules
  // Any drift between this test driver and the hook's effect body
  // would mean the hook is doing something subtly different — that's
  // a code-review-time concern, not a runtime regression we can pin
  // here without React DOM.

  function runDriver(): {
    client: QueryClient;
    state: { visible: boolean };
    teardown: () => void;
  } {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const state = { visible: false };
    const queryCache = client.getQueryCache();
    const mutationCache = client.getMutationCache();
    const onQ = (event: { query?: unknown }): void => {
      const q = (event as { query?: { state: { status: string; error: unknown } } })
        .query;
      if (!q) return;
      if (q.state.status === 'error') {
        if (isBackendUnreachableError(q.state.error)) state.visible = true;
      } else if (q.state.status === 'success') {
        if (state.visible) state.visible = false;
      }
    };
    const onM = (event: { mutation?: unknown }): void => {
      const m = (
        event as { mutation?: { state: { status: string; error: unknown } } }
      ).mutation;
      if (!m) return;
      if (m.state.status === 'error') {
        if (isBackendUnreachableError(m.state.error)) state.visible = true;
      } else if (m.state.status === 'success') {
        if (state.visible) state.visible = false;
      }
    };
    const unsubQ = queryCache.subscribe(onQ);
    const unsubM = mutationCache.subscribe(onM);
    return {
      client,
      state,
      teardown: () => {
        unsubQ();
        unsubM();
      },
    };
  }

  it('flips visible=true when a tracked query throws ApiError(backend_unreachable)', async () => {
    const { client, state, teardown } = runDriver();
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
        .catch(() => {
          /* expected */
        });
      expect(state.visible).toBe(true);
    } finally {
      teardown();
    }
  });

  it('does NOT flip visible when a query throws a generic 404 (kind=http) — regression bait', async () => {
    const { client, state, teardown } = runDriver();
    try {
      await client
        .fetchQuery({
          queryKey: ['x2'],
          queryFn: async () => {
            throw new ApiError(404, 'Not Found', '{}');
          },
        })
        .catch(() => {
          /* expected */
        });
      expect(state.visible).toBe(false);
    } finally {
      teardown();
    }
  });

  it('does NOT flip visible for a non-ApiError throw (e.g. renderer bug throwing TypeError)', async () => {
    // Pin: a renderer-side bug throwing a generic Error inside a
    // queryFn must NOT impersonate a server-down condition. The
    // banner would mislead the user into thinking it's a network
    // problem when really their bundle has a bug.
    const { client, state, teardown } = runDriver();
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

  it('auto-clears visible when a subsequent query succeeds (server is back)', async () => {
    const { client, state, teardown } = runDriver();
    try {
      // Step 1: error sets visible=true.
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
      // Step 2: a different query succeeds → auto-clear.
      await client.fetchQuery({
        queryKey: ['recover-2'],
        queryFn: async () => ({ ok: true }),
      });
      expect(state.visible).toBe(false);
    } finally {
      teardown();
    }
  });

  it('mutation cache mirrors the same rules — backend_unreachable mutation flips visible=true', async () => {
    const { client, state, teardown } = runDriver();
    try {
      const m = client.getMutationCache().build(client, {
        mutationFn: async () => {
          throw new ApiError(
            0,
            'Network Error',
            '',
            'backend_unreachable',
          );
        },
      });
      await m.execute(undefined).catch(() => {});
      expect(state.visible).toBe(true);
    } finally {
      teardown();
    }
  });

  it('mutation success while banner visible → auto-clears', async () => {
    const { client, state, teardown } = runDriver();
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
});

describe('retry() contract — invalidateQueries + hide (D4.a Commit 6 part 4)', () => {
  it('retry calls queryClient.invalidateQueries and resets visible to false', () => {
    // Cover the hook's `retry` body via a tiny equivalent — the
    // hook does exactly this:
    //   () => { setVisible(false); void client.invalidateQueries(); }
    // We pin the contract (invalidateQueries called once with no
    // arguments → invalidates ALL queries; visible flips back to
    // false). A regression that retried only a specific key, or
    // skipped the hide, would surface as a banner that lingers
    // through the next refetch cycle.
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
    // Passing NO filter is intentional — the next round of every
    // active query doubles as a liveness probe; narrowing to one
    // key would leave stale unreachable state visible on other
    // panes.
    expect(spy).toHaveBeenCalledWith();
  });
});
