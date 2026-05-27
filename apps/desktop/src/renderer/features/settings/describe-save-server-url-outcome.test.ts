/**
 * D3.c Commit 4 — pins every `DesktopSaveServerUrlResult` arm to a
 * distinct user-visible banner. The test is the contractual gate
 * against Cindy `#task:634` review note 1: `reloaded` and
 * `connectivity_unverified` MUST NOT share copy, and
 * `connectivity_unverified` MUST NOT claim "Connected".
 */
import { describe, expect, it } from 'vitest';
import type { DesktopSaveServerUrlResult } from '../../../preload/api';
import { describeSaveServerUrlOutcome } from './describe-save-server-url-outcome';

describe('describeSaveServerUrlOutcome — success arms', () => {
  it('reloaded uses tone=success and explicitly says reconnected', () => {
    const banner = describeSaveServerUrlOutcome({
      ok: true,
      kind: 'reloaded',
      elapsedMs: 380,
      attachedAt: 1_700_000_000_000,
    });
    expect(banner.tone).toBe('success');
    expect(banner.title).toMatch(/reconnected/i);
    expect(banner.description).toMatch(/380\s*ms/);
  });

  it('unchanged uses tone=info and does NOT claim connection state', () => {
    const banner = describeSaveServerUrlOutcome({
      ok: true,
      kind: 'unchanged',
    });
    expect(banner.tone).toBe('info');
    expect(banner.title).toMatch(/already that value/i);
    // The connection is whatever it was before; UI must not imply
    // a verified state from this arm.
    expect(banner.title.toLowerCase()).not.toMatch(/connected/);
    expect(banner.description).toBe('');
  });

  it('connectivity_unverified uses tone=info and MUST NOT render as "Connected" (Cindy review note 1)', () => {
    // Load-bearing assertion: if a future refactor collapses
    // connectivity_unverified into the same copy as reloaded, this
    // test fails loud. The user's CONFIG is saved but the WS
    // attachment was not observed within budget — UI must not
    // imply a verified state.
    const banner = describeSaveServerUrlOutcome({
      ok: true,
      kind: 'connectivity_unverified',
      elapsedMs: 10_000,
    });
    expect(banner.tone).toBe('info');
    expect(banner.title).toMatch(/saved/i);
    expect(banner.title).toMatch(/reconnect|reconnecting/i);
    // Anti-claim: the headline MUST NOT say "Connected".
    expect(banner.title.toLowerCase()).not.toMatch(/\bconnected\b/);
    // Cindy note 1 verbatim: the renderer cannot collapse
    // connectivity_unverified into the reloaded copy. Cross-check
    // by direct comparison against the reloaded headline.
    const reloaded = describeSaveServerUrlOutcome({
      ok: true,
      kind: 'reloaded',
      elapsedMs: 380,
      attachedAt: 1_700_000_000_000,
    });
    expect(banner.title).not.toBe(reloaded.title);
    expect(banner.description).toMatch(/10\.0\s*s/);
  });

  it('formatMs switches to seconds at >= 1000ms', () => {
    // Sub-second renders as integer ms; ≥ 1000ms renders as 1dp s.
    const fast = describeSaveServerUrlOutcome({
      ok: true,
      kind: 'reloaded',
      elapsedMs: 999,
      attachedAt: 0,
    });
    expect(fast.description).toMatch(/999\s*ms/);
    const slow = describeSaveServerUrlOutcome({
      ok: true,
      kind: 'reloaded',
      elapsedMs: 1500,
      attachedAt: 0,
    });
    expect(slow.description).toMatch(/1\.5\s*s/);
  });
});

describe('describeSaveServerUrlOutcome — classify_rejected reasons', () => {
  const cases: ReadonlyArray<{
    reason: Extract<DesktopSaveServerUrlResult, { kind: 'classify_rejected' }>['reason'];
    titleMatch: RegExp;
  }> = [
    { reason: 'malformed_url', titleMatch: /not a valid url/i },
    { reason: 'unsupported_scheme', titleMatch: /http:\/\/ or https:\/\//i },
    { reason: 'non_loopback_host', titleMatch: /loopback/i },
  ];

  for (const c of cases) {
    it(`classify_rejected/${c.reason} → tone=error with reason-specific headline`, () => {
      const banner = describeSaveServerUrlOutcome({
        ok: false,
        kind: 'classify_rejected',
        reason: c.reason,
        message: 'classifier verbatim message',
      });
      expect(banner.tone).toBe('error');
      expect(banner.title).toMatch(c.titleMatch);
      expect(banner.description).toBe('classifier verbatim message');
    });
  }
});

describe('describeSaveServerUrlOutcome — reload_rejected reasons', () => {
  const cases: ReadonlyArray<{
    reason: Extract<DesktopSaveServerUrlResult, { kind: 'reload_rejected' }>['reason'];
    titleMatch: RegExp;
  }> = [
    { reason: 'not_attached', titleMatch: /sign in/i },
    { reason: 'config_unreadable', titleMatch: /could not read/i },
    { reason: 'parse_failed', titleMatch: /rejected the new config/i },
    { reason: 'invalid_server_url', titleMatch: /rejected the new server url/i },
  ];

  for (const c of cases) {
    it(`reload_rejected/${c.reason} → tone=error with reason-specific headline`, () => {
      const banner = describeSaveServerUrlOutcome({
        ok: false,
        kind: 'reload_rejected',
        reason: c.reason,
        message: 'daemon verbatim message',
      });
      expect(banner.tone).toBe('error');
      expect(banner.title).toMatch(c.titleMatch);
      expect(banner.description).toBe('daemon verbatim message');
    });
  }
});

describe('describeSaveServerUrlOutcome — other failure arms', () => {
  it('config_write_failed → tone=error with disk-write headline', () => {
    const banner = describeSaveServerUrlOutcome({
      ok: false,
      kind: 'config_write_failed',
      message: 'EACCES /path/daemon-config.json',
    });
    expect(banner.tone).toBe('error');
    expect(banner.title).toMatch(/could not write/i);
    expect(banner.description).toBe('EACCES /path/daemon-config.json');
  });

  it('no_attachment_controller → tone=info (save succeeded; just no verification surface)', () => {
    const banner = describeSaveServerUrlOutcome({
      ok: false,
      kind: 'no_attachment_controller',
      message: 'backend HostWsServerController unavailable',
    });
    expect(banner.tone).toBe('info');
    expect(banner.title).toMatch(/saved/i);
    expect(banner.title).toMatch(/not available/i);
    expect(banner.description).toBe('backend HostWsServerController unavailable');
  });
});
