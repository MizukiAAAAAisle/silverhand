import { describe, expect, it } from 'vitest';
import { isHostProxyOfflineError } from './hooks';
import { ApiError } from '@/lib/api';

/**
 * #task:1350 — contract-boundary parse for the per-computer Proxy editor.
 * Proxy config is host-local truth: the backend can only read/write it while
 * a daemon is attached, so an offline computer fails closed with the shared
 * `computer_offline` envelope (503). The renderer must distinguish that ONE
 * expected non-ok — which collapses to the "Please connect first" hint — from
 * every real error, which has to surface as `query.isError` / a rejected
 * mutation. These pin the shared-schema shape (`error_code` discriminator via
 * `HostProxyConfigOfflineResponseSchema`) so a future wire drift fails here
 * instead of silently swallowing a real failure as "offline".
 */
describe('isHostProxyOfflineError', () => {
  function api503(body: unknown): ApiError {
    return new ApiError(503, 'Service Unavailable', JSON.stringify(body));
  }

  it('detects the shared computer_offline envelope', () => {
    expect(
      isHostProxyOfflineError(
        api503({ error: 'computer is offline', error_code: 'computer_offline' }),
      ),
    ).toBe(true);
  });

  it('does not treat a different error_code as offline', () => {
    expect(
      isHostProxyOfflineError(
        api503({ error: 'nope', error_code: 'daemon_error' }),
      ),
    ).toBe(false);
  });

  it('does not misfire on a malformed / non-JSON body', () => {
    expect(
      isHostProxyOfflineError(new ApiError(503, 'Service Unavailable', '<html>')),
    ).toBe(false);
  });

  it('ignores non-ApiError throwables', () => {
    expect(isHostProxyOfflineError(new Error('boom'))).toBe(false);
    expect(isHostProxyOfflineError('boom')).toBe(false);
    expect(isHostProxyOfflineError(null)).toBe(false);
  });
});
