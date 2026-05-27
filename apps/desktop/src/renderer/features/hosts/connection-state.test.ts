/**
 * D3.d tests — pin every (status × attached_at) arm of the
 * connection-state mapper. The exhaustiveness contract is enforced at
 * the type level by a `never` assertion in the implementation; this
 * suite pins the LABEL + TONE for every arm so a behavioral regression
 * (e.g. accidentally collapsing `failed` and `revoked` into the same
 * label) shows up loud.
 */
import { describe, expect, it } from 'vitest';
import {
  describeConnectionState,
  formatAttachedSince,
  type LocalHostStatus,
} from './connection-state';

const NOW = 1_700_000_000_000;
const ONE_MIN = 60_000;

describe('describeConnectionState — six-arm presentation matrix (D3.d)', () => {
  it('unclaimed → no pill (no misleading "Disconnected" before sign-in)', () => {
    const v = describeConnectionState('unclaimed', null, NOW);
    expect(v.visible).toBe(false);
    expect(v.label).toBe('');
    expect(v.tone).toBe('hidden');
    expect(v.detail).toBeNull();
  });

  it('claimed + attached_at===null → "Connecting…" (accent tone)', () => {
    // Window after claim succeeds but before the daemon's outbound WS
    // lands at the backend — D3.a Commit 4 freshness window. The pill
    // shows "Connecting…" until `attached_at` becomes a number.
    const v = describeConnectionState('claimed', null, NOW);
    expect(v.visible).toBe(true);
    expect(v.label).toBe('Connecting…');
    expect(v.tone).toBe('accent');
    expect(v.detail).toBeNull();
  });

  it('claimed + attached_at===number → "Connected" + since X (success tone)', () => {
    const v = describeConnectionState('claimed', NOW - 5 * ONE_MIN, NOW);
    expect(v.visible).toBe(true);
    expect(v.label).toBe('Connected');
    expect(v.tone).toBe('success');
    expect(v.detail).toBe('since 5m ago');
  });

  it('revoked → "Revoked" (muted tone — server-side terminal, not connection error)', () => {
    const v = describeConnectionState('revoked', null, NOW);
    expect(v.visible).toBe(true);
    expect(v.label).toBe('Revoked');
    expect(v.tone).toBe('muted');
    expect(v.detail).toBeNull();
  });

  it('error → "Disconnected" (warning tone — transient claim-side blip)', () => {
    const v = describeConnectionState('error', null, NOW);
    expect(v.visible).toBe(true);
    expect(v.label).toBe('Disconnected');
    expect(v.tone).toBe('warning');
    expect(v.detail).toBeNull();
  });

  it('failed → "Daemon stopped" (error tone — supervisor budget exhausted)', () => {
    // `failed` and `revoked` look superficially similar (both
    // unavailable), but they have very different user actions: revoked
    // needs a re-sign-in to provision a fresh host record, failed
    // needs an app relaunch. They MUST render as distinct labels.
    const v = describeConnectionState('failed', null, NOW);
    expect(v.visible).toBe(true);
    expect(v.label).toBe('Daemon stopped');
    expect(v.tone).toBe('error');
    expect(v.detail).toBeNull();
  });
});

describe('describeConnectionState — anti-collapse pins (Cindy gate 1)', () => {
  it('failed and revoked never share the same label even with the same attached_at input', () => {
    // Defensive pin: the type-level exhaustiveness gate prevents a
    // future fallthrough from collapsing arms, but a hand-edit could
    // still copy-paste the wrong label. This test reads the two states
    // back and asserts they stay distinct.
    const failed = describeConnectionState('failed', null, NOW);
    const revoked = describeConnectionState('revoked', null, NOW);
    expect(failed.label).not.toBe(revoked.label);
    expect(failed.tone).not.toBe(revoked.tone);
  });

  it('claimed without attached_at NEVER promotes to "Connected" via the mapper', () => {
    // `attached_at===null` is the entire signal that the WS hasn't
    // landed. If a future refactor reads `attached_at ?? someDefault`
    // somewhere upstream we want this test to fail before the user
    // sees a green "Connected" pill on a daemon that isn't actually
    // attached.
    const v = describeConnectionState('claimed', null, NOW);
    expect(v.label).not.toBe('Connected');
    expect(v.tone).not.toBe('success');
  });

  it('attached_at is presentation hint only — does not flip terminal states', () => {
    // Even if the backend snapshot accidentally carries an
    // `attached_at` number on a `revoked` / `failed` host (it
    // shouldn't, but `BackendInfo` doesn't structurally exclude it),
    // the mapper must NOT silently render "Connected".
    const revokedWithStaleAttach = describeConnectionState(
      'revoked',
      NOW - ONE_MIN,
      NOW,
    );
    expect(revokedWithStaleAttach.label).toBe('Revoked');
    const failedWithStaleAttach = describeConnectionState(
      'failed',
      NOW - ONE_MIN,
      NOW,
    );
    expect(failedWithStaleAttach.label).toBe('Daemon stopped');
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
