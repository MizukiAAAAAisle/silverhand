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
    // D4.a Commit 2 fixup (Cindy review) — non_origin_url. Title
    // must mention "origin" so the user understands the rejection
    // shape rather than treating it as a generic URL-validity
    // failure.
    { reason: 'non_origin_url', titleMatch: /origin/i },
    // D4.a Commit 1 — replaces D3's `non_loopback_host` case. Title
    // must point the user at the two valid escape routes (use
    // https, or set the dev env flag) rather than the obsolete
    // "loopback only" message.
    {
      reason: 'insecure_remote_http_disallowed',
      titleMatch: /https:\/\/.*SILVERHAND_ALLOW_INSECURE_REMOTE/i,
    },
    // D4.a Commit 1 review — disguised loopback. Title must mention
    // the "disguised loopback" framing so the user understands the
    // gate fired because their URL form mismatched the host it
    // would actually connect to (not a "this URL is malformed"
    // false positive).
    {
      reason: 'obfuscated_loopback_disallowed',
      titleMatch: /disguised loopback/i,
    },
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

  // D4.a Commit 1 — the `remote_backend_not_yet_supported` arm is
  // a NEW outcome (not a classify_rejected reason) introduced by
  // widening the classifier to admit `kind: 'remote'`. Pin both
  // insecure variants render an error banner with a stable headline.
  it.each([true, false])(
    'remote_backend_not_yet_supported (insecure=%s) → tone=error with not-yet-enabled headline',
    insecure => {
      const banner = describeSaveServerUrlOutcome({
        ok: false,
        kind: 'remote_backend_not_yet_supported',
        insecure,
        message: insecure
          ? 'Remote backend support is not yet enabled in this build (input was non-loopback over http).'
          : 'Remote backend support is not yet enabled in this build (input was non-loopback over https).',
      });
      expect(banner.tone).toBe('error');
      expect(banner.title).toMatch(/not yet enabled/i);
      expect(banner.description).toContain('not yet enabled');
    },
  );
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
