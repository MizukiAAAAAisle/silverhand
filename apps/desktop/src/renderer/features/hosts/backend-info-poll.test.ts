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

  it('embedded + claimed + attached_at===null → polls (this is the connecting window)', () => {
    // The whole reason this hook exists. The pill is showing
    // "Connecting…" right now and we need the next snapshot to
    // observe the outbound WS landing.
    expect(connectingRefetchIntervalMs(snap())).toBe(CONNECTING_POLL_MS);
  });

  it('remote + claimed + attached_at===null → no poll (`#task:1628`: the window has no exit)', () => {
    // Regression pin. `attached_at` comes from the in-process embedded
    // attachment registry, so on the remote arm it is structurally null
    // forever — even while the daemon is attached and agents run. The
    // old helper saw `claimed + null` and polled `backend:info` every
    // 1.5s for the whole life of the pane; the user read that endless
    // request loop as "this computer keeps retrying".
    expect(connectingRefetchIntervalMs(snap({ mode: 'remote' }))).toBe(false);
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

  it('remote falls back to the 30s protocol poll even with pollWhileConnecting on', () => {
    // This case used to assert the opposite (`CONNECTING_POLL_MS`),
    // which is exactly how the `#task:1628` runaway got codified: a
    // remote snapshot is permanently `claimed + attached_at===null`, so
    // "keep the faster poll" meant "poll forever at 1.5s". Remote
    // connectedness is proven by the event WS, so the only remaining
    // periodic read here is the protocol-compatibility probe.
    expect(
      backendInfoRefetchIntervalMs(snap({ mode: 'remote' }), {
        pollWhileConnecting: true,
        pollProtocolCompatibility: true,
      }),
    ).toBe(PROTOCOL_COMPATIBILITY_POLL_MS);
  });

  it('remote + pollWhileConnecting alone → no polling at all', () => {
    expect(
      backendInfoRefetchIntervalMs(snap({ mode: 'remote' }), {
        pollWhileConnecting: true,
      }),
    ).toBe(false);
  });

  it('embedded keeps the faster connecting poll when both probes are enabled', () => {
    expect(
      backendInfoRefetchIntervalMs(snap(), {
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

// #task:1588 slice 2 — the hostStatusFreshnessPolicy suite formerly here
// pinned the divergent per-consumer policy (staleTime 0 vs Infinity). That
// split was retired with the event-driven single policy: every consumer of
// hostStatusKey now shares one fresh-forever + WS-invalidated model, and
// pollUntilAvailable no longer exists (it had no component consumers).

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
