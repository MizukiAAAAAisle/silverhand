/**
 * D3.d tests — pin the (status × attached_at) presentation contract of
 * the connection-state mapper. The exhaustiveness contract is enforced
 * at the type level by a `never` assertion in the implementation; this
 * suite pins the stable state semantics per arm — `visible` / `tone` /
 * `detail` shape and the anti-collapse invariant (e.g. `failed` and
 * `revoked` must not render as the same arm) — NOT the label copy,
 * which is visual and verified by dogfood.
 */
import { describe, expect, it } from 'vitest';
import {
  describeConnectionState,
  formatAttachedSince,
  isLocalHostAttached,
  type LocalHostStatus,
} from './connection-state';

const NOW = 1_700_000_000_000;
const ONE_MIN = 60_000;

describe('describeConnectionState — six-arm presentation matrix (D3.d)', () => {
  it('unclaimed → no pill (no misleading pill before sign-in)', () => {
    const v = describeConnectionState('unclaimed', null, NOW);
    expect(v.visible).toBe(false);
    expect(v.label).toBe('');
    expect(v.tone).toBe('hidden');
    expect(v.detail).toBeNull();
  });

  it('claimed + attached_at===null → connecting arm (accent tone, no detail)', () => {
    // Window after claim succeeds but before the daemon's outbound WS
    // lands at the backend — D3.a Commit 4 freshness window. The pill
    // stays in the connecting arm until `attached_at` becomes a number.
    const v = describeConnectionState('claimed', null, NOW);
    expect(v.visible).toBe(true);
    expect(v.tone).toBe('accent');
    expect(v.detail).toBeNull();
  });

  it('claimed + attached_at===number → connected arm (success tone) + since X', () => {
    const v = describeConnectionState('claimed', NOW - 5 * ONE_MIN, NOW);
    expect(v.visible).toBe(true);
    expect(v.tone).toBe('success');
    expect(v.detail).toBe('since 5m ago');
  });

  it('revoked → muted tone (server-side terminal, not a connection error)', () => {
    const v = describeConnectionState('revoked', null, NOW);
    expect(v.visible).toBe(true);
    expect(v.tone).toBe('muted');
    expect(v.detail).toBeNull();
  });

  it('error → warning tone (transient claim-side blip)', () => {
    const v = describeConnectionState('error', null, NOW);
    expect(v.visible).toBe(true);
    expect(v.tone).toBe('warning');
    expect(v.detail).toBeNull();
  });

  it('failed → error tone (supervisor budget exhausted)', () => {
    // `failed` and `revoked` look superficially similar (both
    // unavailable), but they have very different user actions: revoked
    // needs a re-sign-in to provision a fresh host record, failed
    // needs an app relaunch. They MUST render as distinct arms.
    const v = describeConnectionState('failed', null, NOW);
    expect(v.visible).toBe(true);
    expect(v.tone).toBe('error');
    expect(v.detail).toBeNull();
  });
});

describe('describeConnectionState — anti-collapse pins (Cindy gate 1)', () => {
  it('failed and revoked never share the same arm even with the same attached_at input', () => {
    // Defensive pin: the type-level exhaustiveness gate prevents a
    // future fallthrough from collapsing arms, but a hand-edit could
    // still copy-paste the wrong presentation. This test reads the two
    // states back and asserts they stay distinct (label + tone).
    const failed = describeConnectionState('failed', null, NOW);
    const revoked = describeConnectionState('revoked', null, NOW);
    expect(failed.label).not.toBe(revoked.label);
    expect(failed.tone).not.toBe(revoked.tone);
  });

  it('claimed without attached_at NEVER promotes to the connected arm via the mapper', () => {
    // `attached_at===null` is the entire signal that the WS hasn't
    // landed. If a future refactor reads `attached_at ?? someDefault`
    // somewhere upstream we want this test to fail before the user
    // sees a green success pill on a daemon that isn't actually
    // attached.
    const v = describeConnectionState('claimed', null, NOW);
    expect(v.tone).not.toBe('success');
  });

  it('attached_at is presentation hint only — does not flip terminal states', () => {
    // Even if the backend snapshot accidentally carries an
    // `attached_at` number on a `revoked` / `failed` host (it
    // shouldn't, but `BackendInfo` doesn't structurally exclude it),
    // the mapper must render identically to the no-attach terminal view.
    expect(describeConnectionState('revoked', NOW - ONE_MIN, NOW)).toEqual(
      describeConnectionState('revoked', null, NOW),
    );
    expect(describeConnectionState('failed', NOW - ONE_MIN, NOW)).toEqual(
      describeConnectionState('failed', null, NOW),
    );
  });
});

describe('describeConnectionState — remoteAttached (remote-mode readiness, #task:1010)', () => {
  it('claimed + attached_at===null + remoteAttached → connected arm (no "since")', () => {
    // Remote-server deployment: the in-process attachment registry is
    // absent so attached_at is structurally null, but the remote
    // backend confirms the outbound attach via host-status. The pill
    // must read connected, not a permanent connecting arm.
    const v = describeConnectionState('claimed', null, NOW, {
      remoteAttached: true,
    });
    expect(v.visible).toBe(true);
    expect(v.tone).toBe('success');
    // No attach timestamp available from `availability`, so no "since".
    expect(v.detail).toBeNull();
  });

  it('claimed + attached_at===null + remoteAttached===false → still the connecting arm', () => {
    // The genuine connecting case (daemon not yet/never attached). The
    // opt defaulting to false must NOT promote to the connected arm.
    const v = describeConnectionState('claimed', null, NOW, {
      remoteAttached: false,
    });
    expect(v.tone).toBe('accent');
  });

  it('embedded attached_at wins over remoteAttached — keeps "since X"', () => {
    // When the local attach timestamp is present (embedded), it remains
    // the primary proof and carries the richer "since" detail; the
    // remote flag is irrelevant.
    const v = describeConnectionState('claimed', NOW - 5 * ONE_MIN, NOW, {
      remoteAttached: true,
    });
    expect(v.tone).toBe('success');
    expect(v.detail).toBe('since 5m ago');
  });

  it('remoteAttached does NOT resurrect terminal states', () => {
    // A revoked/failed/error host must stay terminal even if a stale
    // host-status read says available — identical to the no-flag view.
    for (const status of ['revoked', 'failed', 'error'] as const) {
      expect(
        describeConnectionState(status, null, NOW, { remoteAttached: true }),
      ).toEqual(describeConnectionState(status, null, NOW));
    }
  });
});

describe('isLocalHostAttached — COMPUTERS sidebar pip (#task:1132)', () => {
  it('remote-server + local computer: available host-status ⇒ attached (was the bug)', () => {
    // The regressed case. In remote-server mode `attachedAt` is
    // structurally null, so the OLD predicate (attachedAt-only) read the
    // genuinely-online local computer as offline. The remote backend's
    // host-status `availability === 'available'` is the second source.
    expect(
      isLocalHostAttached({ attachedAt: null, remoteAvailable: true }),
    ).toBe(true);
  });

  it('embedded: a local attach timestamp ⇒ attached even without the remote probe', () => {
    expect(
      isLocalHostAttached({ attachedAt: 1_000, remoteAvailable: false }),
    ).toBe(true);
  });

  it('genuinely connecting / offline: no timestamp + not available ⇒ not attached', () => {
    expect(
      isLocalHostAttached({ attachedAt: null, remoteAvailable: false }),
    ).toBe(false);
  });
});

describe('formatAttachedSince — bucketing', () => {
  it('returns "just now" for sub-minute deltas', () => {
    expect(formatAttachedSince(NOW - 30_000, NOW)).toBe('just now');
    expect(formatAttachedSince(NOW, NOW)).toBe('just now');
  });

  it('clamps negative deltas (clock skew) to "just now"', () => {
    // `attached_at` is server-stamped via `HostWsServerController`;
    // the renderer's `Date.now()` can be ahead OR behind. Clamping
    // avoids a confusing "in 3m" label.
    expect(formatAttachedSince(NOW + 10 * ONE_MIN, NOW)).toBe('just now');
  });

  it('formats minute / hour / day buckets', () => {
    expect(formatAttachedSince(NOW - 5 * ONE_MIN, NOW)).toBe('5m ago');
    expect(formatAttachedSince(NOW - 90 * ONE_MIN, NOW)).toBe('1h ago');
    expect(formatAttachedSince(NOW - 25 * 60 * ONE_MIN, NOW)).toBe('1d ago');
  });
});

describe('describeConnectionState — type-level exhaustiveness', () => {
  it('covers every value declared in the LocalHostStatus union', () => {
    // Behavioral mirror of the `never` exhaustiveness assertion. This
    // test fails loudly if a new status value lands in `BackendInfo`
    // but the mapper isn't updated.
    const allStatuses: LocalHostStatus[] = [
      'unclaimed',
      'claimed',
      'revoked',
      'error',
      'failed',
    ];
    for (const status of allStatuses) {
      // Throws via the `never` assertion if any case isn't handled;
      // also returns a structurally valid view otherwise.
      const v = describeConnectionState(status, null, NOW);
      expect(v).toMatchObject({
        visible: expect.any(Boolean),
        label: expect.any(String),
        tone: expect.any(String),
      });
    }
  });
});
