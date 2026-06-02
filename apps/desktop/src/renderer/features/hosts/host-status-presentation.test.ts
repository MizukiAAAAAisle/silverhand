import { describe, expect, it } from 'vitest';
import type { HostStatusResponse } from '@silverhand/shared';
import {
  describeHostStatus,
  describeUnreachableReason,
  formatUptime,
} from './host-status-presentation';

/**
 * #task:808 slice 4 — pure mapper tests for `HostStatusResponse` →
 * UI pill view. Pin the four arm cases + the `unreachable.reason`
 * fan-out so a future tone tweak (e.g. switching `unreachable` from
 * `warning` to `error`) lands as an explicit test edit, not a silent
 * theme drift.
 */

function aHost(hostId = 'host-1'): {
  host_id: string;
  last_seen_at: number | null;
} {
  return { host_id: hostId, last_seen_at: 1_700_000_000_000 };
}

describe('describeHostStatus', () => {
  it('maps `available` to Ready + success tone', () => {
    const view = describeHostStatus({
      ...aHost(),
      availability: 'available',
      snapshot: {
        os: 'macOS 14.5',
        daemon_pid: 1,
        daemon_version: '0.1.0',
        started_at: 1,
        uptime_ms: 1,
      },
      agents: [],
    } as HostStatusResponse);
    expect(view).toEqual({
      label: 'Ready',
      tone: 'success',
      detail: null,
    });
  });

  it('maps `disconnected` to Offline + muted tone with explanatory detail', () => {
    const view = describeHostStatus({
      ...aHost(),
      availability: 'disconnected',
      agents: [],
    } as HostStatusResponse);
    expect(view.label).toBe('Offline');
    expect(view.tone).toBe('muted');
    // Detail prepares the user for the offline-but-registration-visible
    // pattern — it is intentionally non-empty.
    expect(view.detail).toContain('Registered agents');
  });

  it('maps `unreachable{timeout}` to Unreachable + warning tone + per-reason detail', () => {
    const view = describeHostStatus({
      ...aHost(),
      availability: 'unreachable',
      reason: 'timeout',
      agents: [],
    } as HostStatusResponse);
    expect(view.label).toBe('Unreachable');
    expect(view.tone).toBe('warning');
    expect(view.detail).toBe(describeUnreachableReason('timeout'));
  });

  it('maps `unreachable{daemon_unreachable}` reason verbatim into detail', () => {
    const view = describeHostStatus({
      ...aHost(),
      availability: 'unreachable',
      reason: 'daemon_unreachable',
      agents: [],
    } as HostStatusResponse);
    expect(view.detail).toBe(describeUnreachableReason('daemon_unreachable'));
  });

  it('maps `revoked` to Removed + muted tone (no `reason` is leaked)', () => {
    const view = describeHostStatus({
      ...aHost(),
      availability: 'revoked',
      agents: [],
    } as HostStatusResponse);
    expect(view.label).toBe('Removed');
    expect(view.tone).toBe('muted');
    // Detail tells the user how to recover — Re-add language.
    expect(view.detail).toContain('Re-add');
  });
});

describe('describeUnreachableReason', () => {
  it('returns user-readable strings for every reason (no daemon vocab leaks)', () => {
    const cases: Array<['timeout' | 'daemon_unreachable' | 'protocol_error', RegExp]> = [
      ['timeout', /took too long|timed/i],
      ['daemon_unreachable', /Could not reach/i],
      ['protocol_error', /unexpected response/i],
    ];
    for (const [reason, pattern] of cases) {
      const text = describeUnreachableReason(reason);
      expect(text).toMatch(pattern);
      // Daemon-lang terms must NOT leak verbatim — keeps the pill in
      // user-facing voice no matter what we add server-side.
      expect(text).not.toMatch(/daemon/i);
      expect(text).not.toMatch(/RPC/i);
      expect(text).not.toMatch(/transport/i);
    }
  });
});

describe('formatUptime', () => {
  it('formats sub-minute as seconds', () => {
    expect(formatUptime(0)).toBe('0s');
    expect(formatUptime(45 * 1000)).toBe('45s');
    expect(formatUptime(59_999)).toBe('59s');
  });

  it('formats sub-hour as whole minutes', () => {
    expect(formatUptime(60 * 1000)).toBe('1m');
    expect(formatUptime(59 * 60 * 1000)).toBe('59m');
  });

  it('formats sub-day as hours (with leftover minutes when present)', () => {
    expect(formatUptime(60 * 60 * 1000)).toBe('1h');
    expect(formatUptime(2 * 60 * 60 * 1000 + 14 * 60 * 1000)).toBe('2h 14m');
    expect(formatUptime(23 * 60 * 60 * 1000 + 59 * 60 * 1000)).toBe('23h 59m');
  });

  it('formats >=1d as days (with leftover hours when present)', () => {
    expect(formatUptime(24 * 60 * 60 * 1000)).toBe('1d');
    expect(formatUptime(5 * 24 * 60 * 60 * 1000 + 6 * 60 * 60 * 1000)).toBe(
      '5d 6h',
    );
  });

  it('clamps negative inputs to 0s rather than throwing or returning NaN', () => {
    expect(formatUptime(-1000)).toBe('0s');
  });
});
