/**
 * D3.d follow-up tests (Cindy `#task:636` review P1) — pin the
 * connecting-window refetch matrix for `useBackendInfoSnapshot`.
 *
 * The bug being prevented: before this hook accepted
 * `pollWhileConnecting`, a renderer that mounted while
 * `local_host_status === 'claimed'` AND
 * `local_host_ws_attached_at === null` (the transitional window
 * between claim success and outbound WS landing) would never see the
 * pill flip Connecting → Connected unless another mutation invalidated
 * `backendInfoKey`. The `connectingRefetchIntervalMs` helper now
 * gates polling to exactly that window — and nothing else.
 */
import { describe, expect, it } from 'vitest';
import {
  CONNECTING_POLL_MS,
  PROTOCOL_COMPATIBILITY_POLL_MS,
  backendInfoRefetchIntervalMs,
  connectingRefetchIntervalMs,
  hostStatusFreshnessPolicy,
  type BackendInfoSnapshot,
} from './hooks';

function snap(over: Partial<BackendInfoSnapshot> = {}): BackendInfoSnapshot {
  return {
    mode: 'embedded',
    url: 'http://127.0.0.1:1234',
    outbound_protocol_compatibility: {
      status: 'compatible',
      app_protocol_version: 7,
      server_protocol_version: 7,
    },
    local_host_id: 'host-1',
    local_host_status: 'claimed',
    local_host_ws_attached_at: null,
    local_host_server_url: 'http://127.0.0.1:1234',
    ...over,
  };
}

describe('connectingRefetchIntervalMs — only polls inside the connecting window', () => {
  it('null snapshot (pre-fetch) → no poll', () => {
    expect(connectingRefetchIntervalMs(null)).toBe(false);
  });

  it('claimed + attached_at===null → polls (this is the connecting window)', () => {
    // The whole reason this hook exists. The pill is showing
    // "Connecting…" right now and we need the next snapshot to
    // observe the outbound WS landing.
    expect(connectingRefetchIntervalMs(snap())).toBe(CONNECTING_POLL_MS);
  });

  it('claimed + attached_at===number → stops polling (already connected)', () => {
    // Anti-spam pin: once the pill flips to "Connected" we MUST
    // stop polling. Otherwise ConnectionPane sits open hammering
    // backend:info every 1.5s indefinitely.
    expect(
      connectingRefetchIntervalMs(
        snap({ local_host_ws_attached_at: 1_700_000_000_000 }),
      ),
    ).toBe(false);
  });

  it('unclaimed → no poll (nothing to attach yet)', () => {
    expect(
      connectingRefetchIntervalMs(
        snap({ local_host_status: 'unclaimed', local_host_id: null }),
      ),
    ).toBe(false);
  });

  it('revoked → no poll (terminal, will never attach)', () => {
    expect(
      connectingRefetchIntervalMs(snap({ local_host_status: 'revoked' })),
    ).toBe(false);
  });

  it('error → no poll (transient, but caller refresh will retry)', () => {
    // `error` IS recoverable, but recovery comes from the next user
    // action (refetch on mount, mutation invalidate), not from
    // continuous polling. Polling on `error` would mean every
    // network blip during claim turns into a sustained refetch
    // loop until the user closes the page.
    expect(
      connectingRefetchIntervalMs(snap({ local_host_status: 'error' })),
    ).toBe(false);
  });

  it('failed → no poll (supervisor budget exhausted, needs app relaunch)', () => {
    expect(
      connectingRefetchIntervalMs(snap({ local_host_status: 'failed' })),
    ).toBe(false);
  });
});

describe('connectingRefetchIntervalMs — terminal arms with stale attached_at also stop polling', () => {
  // Defensive pin: even if backend snapshot accidentally carries a
  // stale `attached_at` on a terminal status (it shouldn't —
  // `snapshotLocalHostInfo` only reads it on `claimed`), the helper
  // must not start polling on those rows.
  it('revoked + stale attached_at → no poll', () => {
    expect(
      connectingRefetchIntervalMs(
        snap({
          local_host_status: 'revoked',
          local_host_ws_attached_at: 1_700_000_000_000,
        }),
      ),
    ).toBe(false);
  });

  it('failed + stale attached_at → no poll', () => {
    expect(
      connectingRefetchIntervalMs(
        snap({
          local_host_status: 'failed',
          local_host_ws_attached_at: 1_700_000_000_000,
        }),
      ),
    ).toBe(false);
  });
});

describe('backendInfoRefetchIntervalMs — protocol compatibility', () => {
  it('periodically rechecks the advertised protocol for remote backends', () => {
    expect(
      backendInfoRefetchIntervalMs(snap({ mode: 'remote' }), {
        pollProtocolCompatibility: true,
      }),
    ).toBe(PROTOCOL_COMPATIBILITY_POLL_MS);
  });

  it('keeps the faster connecting poll when both probes are enabled', () => {
    expect(
      backendInfoRefetchIntervalMs(snap({ mode: 'remote' }), {
        pollWhileConnecting: true,
        pollProtocolCompatibility: true,
      }),
    ).toBe(CONNECTING_POLL_MS);
  });

  it('does not poll an embedded backend for outbound compatibility', () => {
    expect(
      backendInfoRefetchIntervalMs(snap(), {
        pollProtocolCompatibility: true,
      }),
    ).toBe(false);
  });
});

describe('hostStatusFreshnessPolicy — pollUntilAvailable must not trust the manual cache (Cindy #task:1011 P1)', () => {
  it('pollUntilAvailable=true → forces a fresh mount probe (staleTime 0, refetchOnMount "always")', () => {
    // The ConnectionPane connection pill shares hostStatusKey(hostId)
    // with HostDetailView's manual-refresh query. HostDetailView caches
    // with staleTime: Infinity, so a prior `available` read could sit in
    // the shared cache indefinitely. If the pill inherited that policy
    // it would read the stale `available` on mount and (because
    // refetchInterval stops as soon as it sees `available`) NEVER
    // re-probe — showing "Connected" while the daemon is actually
    // disconnected. The pill consumer must therefore re-validate.
    const policy = hostStatusFreshnessPolicy(true);
    expect(policy.staleTime).toBe(0);
    expect(policy.refetchOnMount).toBe('always');
  });

  it('pollUntilAvailable=false → keeps the manual-refresh-only policy (staleTime Infinity, no mount refetch)', () => {
    // HostDetailView is unchanged: fresh-as-long-as-in-memory, user
    // pulls fresh data via the explicit Refresh button.
    const policy = hostStatusFreshnessPolicy(false);
    expect(policy.staleTime).toBe(Infinity);
    expect(policy.refetchOnMount).toBe(false);
  });
});

describe('CONNECTING_POLL_MS — sane bound', () => {
  it('is in the [500ms, 5000ms] band so we neither spam nor lag the user', () => {
    // 500ms floor: anything below this is just request spam from a
    // human-time perspective. 5000ms ceiling: the attach watchdog
    // budget is 10s, so a single poll inside that window catches
    // 90%+ of successful attaches; longer than ~5s the user sees
    // "Connecting…" lingering too long after success.
    expect(CONNECTING_POLL_MS).toBeGreaterThanOrEqual(500);
    expect(CONNECTING_POLL_MS).toBeLessThanOrEqual(5000);
  });
});
