import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { favoritesKey } from '@/features/favorites/hooks';
import { messageUnreadSummaryKey } from '@/features/channels/message-unread';
import {
  reconcileUnreadAfterObserveIfRealtimeUnavailable,
  shouldRefetchUnreadAfterObserve,
} from './observe-cache-fallback';

describe('observe unread fallback while event WS is unavailable', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('only refetches after a changed observe when event WS is not connected', () => {
    expect(shouldRefetchUnreadAfterObserve({ changed: true }, 'disconnected')).toBe(true);
    expect(shouldRefetchUnreadAfterObserve({ changed: true }, 'connecting')).toBe(true);
    expect(shouldRefetchUnreadAfterObserve({ changed: true }, 'connected')).toBe(false);
    expect(shouldRefetchUnreadAfterObserve({ changed: false }, 'disconnected')).toBe(false);
    expect(shouldRefetchUnreadAfterObserve(undefined, 'disconnected')).toBe(false);
  });

  it('invalidates unread-bearing caches only on the fallback path', () => {
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');

    expect(
      reconcileUnreadAfterObserveIfRealtimeUnavailable(qc, { changed: true }, 'connected'),
    ).toBe(false);
    expect(invalidate).not.toHaveBeenCalled();

    expect(
      reconcileUnreadAfterObserveIfRealtimeUnavailable(qc, { changed: true }, 'disconnected'),
    ).toBe(true);

    expect(invalidate).toHaveBeenCalledWith({ queryKey: favoritesKey });
    vi.runOnlyPendingTimers();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: messageUnreadSummaryKey });
    expect(
      invalidate.mock.calls.some(([arg]) => {
        return (
          typeof arg === 'object' &&
          arg !== null &&
          typeof (arg as { predicate?: unknown }).predicate === 'function'
        );
      }),
    ).toBe(true);
  });
});
