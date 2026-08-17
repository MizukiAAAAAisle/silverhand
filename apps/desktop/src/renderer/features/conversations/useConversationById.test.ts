import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryObserver, onlineManager } from '@tanstack/react-query';
import type { ConversationRef } from '@silverhand/shared';
import { ApiError, api } from '@/lib/api';
import { conversationRefQueryOptions } from './conversation-ref-query';
import { mapConversationByIdResult } from './useConversationById';

// Spread the real module and replace ONLY `api`: `ApiError` has to stay the real
// class, or every `instanceof` in the mapper silently changes meaning.
vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: vi.fn() };
});
const mockApi = vi.mocked(api);

const baseRef: ConversationRef = {
  id: 'conv-1',
  placement_kind: 'workspace', roster_policy: 'open',
  title: 'planning',
  workspace_id: 'ws-a',
  workspace_kind: 'regular',
  closed_at: null,
  archived_at: null,
};

describe('mapConversationByIdResult', () => {
  it('returns loading when id is null', () => {
    const r = mapConversationByIdResult(null, {
      data: undefined,
      error: null as unknown as Error,
      isError: false,
    });
    expect(r).toEqual({ status: 'loading', ref: null });
  });

  it('returns loading when id is set but fetch is pending (no data, no error)', () => {
    const r = mapConversationByIdResult('conv-1', {
      data: undefined,
      error: null as unknown as Error,
      isError: false,
    });
    expect(r).toEqual({ status: 'loading', ref: null });
  });

  it('returns resolved with the ref payload on success', () => {
    const r = mapConversationByIdResult('conv-1', {
      data: { ref: baseRef },
      error: null as unknown as Error,
      isError: false,
    });
    expect(r.status).toBe('resolved');
    expect(r.ref).toEqual(baseRef);
  });

  it('returns not_found on 404 ApiError', () => {
    const r = mapConversationByIdResult('conv-1', {
      data: undefined,
      error: new ApiError(404, 'Not Found', '{"error":"conversation not found"}'),
      isError: true,
    });
    expect(r).toEqual({ status: 'not_found', ref: null });
  });

  it('returns unauthorized on 403 ApiError', () => {
    const r = mapConversationByIdResult('conv-1', {
      data: undefined,
      error: new ApiError(403, 'Forbidden', '{"error":"forbidden"}'),
      isError: true,
    });
    expect(r).toEqual({ status: 'unauthorized', ref: null });
  });

  // #task:2038 B1 (@Cindy): a spent retry budget rendered as `loading` is a
  // skeleton that never ends. The retry predicate stops at `failureCount < 2`,
  // so `isError` with nothing in flight IS the terminal state — and it is
  // `unresolved`, not `not_found`: a failed read proves nothing about existence.
  it('returns unresolved once a 500 has settled (retry budget spent)', () => {
    const r = mapConversationByIdResult('conv-1', {
      data: undefined,
      error: new ApiError(500, 'Internal Server Error', ''),
      isError: true,
    });
    expect(r).toEqual({ status: 'unresolved', ref: null });
  });

  it('returns unresolved once a transport failure has settled', () => {
    const r = mapConversationByIdResult('conv-1', {
      data: undefined,
      error: new Error('network down'),
      isError: true,
    });
    expect(r).toEqual({ status: 'unresolved', ref: null });
  });

  it('keeps a resolved ref while a background refetch runs', () => {
    const r = mapConversationByIdResult('conv-1', {
      data: { ref: baseRef },
      error: null as unknown as Error,
      isError: false,
    });
    expect(r.status).toBe('resolved');
  });
});

/**
 * A ref ALREADY IN HAND outranks a later failure (@Cindy, #task:2038). `isError`
 * and `data` are not mutually exclusive, so ordering the `isError` branch first
 * threw away an answer we still held: one 500 or one dropped socket flipped an
 * already-labelled chip / an open `?side` pane from its real title to an error
 * placeholder. The pair face makes the same call for a held row, and the two
 * faces of one identity may not disagree about what "held" is worth.
 *
 * The 403/404 cases are the boundary: those are ANSWERS about the id, so they
 * stay terminal even with a retained ref.
 */
describe('mapConversationByIdResult — a held ref survives a failed refetch', () => {
  const held = { ref: baseRef };

  it('retained ref + a settled 500 → still resolved', () => {
    const r = mapConversationByIdResult('conv-1', {
      data: held,
      error: new ApiError(500, 'Internal Server Error', ''),
      isError: true,
    });
    expect(r).toEqual({ status: 'resolved', ref: baseRef });
  });

  it('retained ref + a transport failure being refetched → still resolved', () => {
    const r = mapConversationByIdResult('conv-1', {
      data: held,
      error: new Error('network down'),
      isError: true,
    });
    expect(r).toEqual({ status: 'resolved', ref: baseRef });
  });

  it('retained ref + 404 → still not_found (an answer outranks the held ref)', () => {
    const r = mapConversationByIdResult('conv-1', {
      data: held,
      error: new ApiError(404, 'Not Found', '{"error":"conversation not found"}'),
      isError: true,
    });
    expect(r).toEqual({ status: 'not_found', ref: null });
  });

  it('retained ref + 403 → still unauthorized', () => {
    const r = mapConversationByIdResult('conv-1', {
      data: held,
      error: new ApiError(403, 'Forbidden', '{"error":"forbidden"}'),
      isError: true,
    });
    expect(r).toEqual({ status: 'unauthorized', ref: null });
  });
});

/**
 * The REACHABILITY nail. Hand-built enum inputs cannot show WHICH React Query
 * states actually occur, and two beliefs about that shaped this mapper:
 *   - "`isError` implies no data" — false. A refetch failing over a successful
 *     read settles as `isError: true, isFetching: false, data: <held>`, which is
 *     why the failure branch may not run before the held-ref check.
 *   - "a data-less query can be `isError` while an attempt is in flight" — also
 *     false, and the reason this mapper reads NO in-flight criterion
 *     (@Alice, #task:2038): a new attempt on a query with no data resets it to
 *     `pending`, so `isError && !data` is ALWAYS settled. An `isFetching` branch
 *     there would be unreachable code.
 * Both are measured here against the production options, and the observer's own
 * result object is fed into the mapper rather than a re-typed copy of it.
 *
 * FALSIFIER: order the mapper's `isError` branch above the held-data check and
 * the first case goes red with `unresolved` — measured, not argued.
 */
describe('mapConversationByIdResult — over a real QueryObserver', () => {
  function observe() {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const observer = new QueryObserver(qc, {
      ...conversationRefQueryOptions('conv-1'),
      retry: false,
    });
    const unsubscribe = observer.subscribe(() => {});
    return { observer, unsubscribe };
  }

  beforeEach(() => {
    mockApi.mockReset();
  });

  it('a failed refetch over a successful read settles as isError WITH data held', async () => {
    mockApi.mockResolvedValue({ ref: baseRef });
    const { observer, unsubscribe } = observe();
    await observer.refetch();
    expect(observer.getCurrentResult().data).toEqual({ ref: baseRef });

    mockApi.mockReset();
    mockApi.mockRejectedValue(new ApiError(500, 'Internal Server Error', ''));
    await observer.refetch();

    const live = observer.getCurrentResult();
    // The measured shape: settled in failure, nothing in flight, ref still there.
    expect(live.isError).toBe(true);
    expect(live.isFetching).toBe(false);
    expect(live.data).toEqual({ ref: baseRef });

    expect(mapConversationByIdResult('conv-1', live)).toEqual({
      status: 'resolved',
      ref: baseRef,
    });
    unsubscribe();
  });

  it('a data-less query goes back to pending for each new attempt, never error-while-fetching', async () => {
    mockApi.mockRejectedValue(new ApiError(500, 'Internal Server Error', ''));
    const { observer, unsubscribe } = observe();
    await observer.refetch();

    const settled = observer.getCurrentResult();
    expect(settled).toMatchObject({ isError: true, isFetching: false });
    expect(settled.data).toBeUndefined();
    // With no ref ever held, a settled failure is terminal — the
    // skeleton-that-never-ends case (#task:2038 B1).
    expect(mapConversationByIdResult('conv-1', settled)).toEqual({
      status: 'unresolved',
      ref: null,
    });

    // A NEW attempt over that retained error: `isError` drops back to false, so
    // "settled failure" and "attempt running" are already disjoint on `isError`.
    mockApi.mockReset();
    mockApi.mockReturnValue(new Promise(() => {}) as Promise<never>);
    void observer.refetch();
    const inFlight = observer.getCurrentResult();
    expect(inFlight).toMatchObject({
      status: 'pending',
      isError: false,
      isFetching: true,
    });
    expect(mapConversationByIdResult('conv-1', inFlight)).toEqual({
      status: 'loading',
      ref: null,
    });
    unsubscribe();
  });

  it('an offline (paused) attempt over a retained error reads as loading, not a verdict', async () => {
    // @Alice's termination check for the in-flight rule, measured rather than
    // reasoned: offline, React Query dispatches the same `fetch` action with
    // `fetchStatus: 'paused'`, so a data-less query ALSO leaves `isError` behind.
    // The mapper reports `loading` for an attempt that resumes on reconnect, and
    // no branch here can mistake a paused attempt for a spent retry budget.
    mockApi.mockRejectedValue(new ApiError(500, 'Internal Server Error', ''));
    const { observer, unsubscribe } = observe();
    await observer.refetch();
    expect(observer.getCurrentResult().isError).toBe(true);

    onlineManager.setOnline(false);
    try {
      mockApi.mockReset();
      mockApi.mockReturnValue(new Promise(() => {}) as Promise<never>);
      void observer.refetch();

      const paused = observer.getCurrentResult();
      expect(paused.fetchStatus).toBe('paused');
      expect(paused.isError).toBe(false);
      expect(mockApi).not.toHaveBeenCalled();
      expect(mapConversationByIdResult('conv-1', paused)).toEqual({
        status: 'loading',
        ref: null,
      });
    } finally {
      onlineManager.setOnline(true);
      unsubscribe();
    }
  });
});
