/**
 * D4.a Commit 2 — copy / tone pin tests for `describeProbeOutcome`.
 *
 * Per-arm pin: every discriminator arm of `DesktopProbeServerInfoResult`
 * MUST map to a `{ tone, title, description }` triple with a non-empty
 * title. The mapper file is exhaustive over the union, so a future
 * arm added without copy is caught by TypeScript; this test belt-and-
 * braces that the copy is actually populated and the tone discriminator
 * lines up with severity expectations (success/warn for OK, error for
 * fail).
 */
import { describe, expect, it } from 'vitest';
import { describeProbeOutcome } from './describe-probe-outcome';

describe('describeProbeOutcome — success arms', () => {
  it('system_ca_verified → success + non-empty title', () => {
    const r = describeProbeOutcome({
      ok: true,
      kind: 'system_ca_verified',
      info: { signup_enabled: true },
    });
    expect(r.tone).toBe('success');
    expect(r.title.length).toBeGreaterThan(0);
    expect(r.description.toLowerCase()).toContain('signup');
  });

  it('system_ca_verified with signup disabled mentions disabled', () => {
    const r = describeProbeOutcome({
      ok: true,
      kind: 'system_ca_verified',
      info: { signup_enabled: false },
    });
    expect(r.description.toLowerCase()).toContain('disabled');
  });

  it('loopback_ok → success + does NOT claim TLS verified', () => {
    // Loopback http does not involve TLS; the copy must not lie.
    const r = describeProbeOutcome({
      ok: true,
      kind: 'loopback_ok',
      info: { signup_enabled: true },
    });
    expect(r.tone).toBe('success');
    expect(r.title.toLowerCase()).not.toContain('tls verified');
  });

  it('insecure_dev_remote → WARN tone with explicit unencrypted callout', () => {
    // Cindy invariant: the dev escape MUST visibly warn the user.
    const r = describeProbeOutcome({
      ok: true,
      kind: 'insecure_dev_remote',
      info: { signup_enabled: true },
    });
    expect(r.tone).toBe('warn');
    expect(r.title.toLowerCase()).toMatch(/unencrypted|insecure/);
    expect(r.description.toLowerCase()).toMatch(/https|not encrypted|unencrypted/);
  });
});

describe('describeProbeOutcome — classify_rejected arms', () => {
  it.each([
    'malformed_url',
    'unsupported_scheme',
    'insecure_remote_http_disallowed',
    'obfuscated_loopback_disallowed',
  ] as const)('reason %s → error tone with distinct title', reason => {
    const r = describeProbeOutcome({
      ok: false,
      kind: 'classify_rejected',
      reason,
      message: 'underlying message',
    });
    expect(r.tone).toBe('error');
    expect(r.title.length).toBeGreaterThan(0);
  });

  it('every classify_rejected reason yields a UNIQUE title (no copy collapse)', () => {
    const reasons = [
      'malformed_url',
      'unsupported_scheme',
      'insecure_remote_http_disallowed',
      'obfuscated_loopback_disallowed',
    ] as const;
    const titles = new Set(
      reasons.map(reason =>
        describeProbeOutcome({
          ok: false,
          kind: 'classify_rejected',
          reason,
          message: '',
        }).title,
      ),
    );
    expect(titles.size).toBe(reasons.length);
  });
});

describe('describeProbeOutcome — tls_failed arms', () => {
  it.each(['host_tls_chain_invalid', 'host_tls_hostname_mismatch', 'host_tls_expired'] as const)(
    'code %s → error tone with distinct title pointing at the right fix',
    code => {
      const r = describeProbeOutcome({
        ok: false,
        kind: 'tls_failed',
        code,
        message: 'underlying message',
      });
      expect(r.tone).toBe('error');
      expect(r.title.length).toBeGreaterThan(0);
      expect(r.description.length).toBeGreaterThan(0);
    },
  );

  it('every tls_failed code yields a UNIQUE title (operator runbook depends on distinct copy)', () => {
    const codes = [
      'host_tls_chain_invalid',
      'host_tls_hostname_mismatch',
      'host_tls_expired',
    ] as const;
    const titles = new Set(
      codes.map(code =>
        describeProbeOutcome({
          ok: false,
          kind: 'tls_failed',
          code,
          message: '',
        }).title,
      ),
    );
    expect(titles.size).toBe(codes.length);
  });
});

describe('describeProbeOutcome — other failure arms', () => {
  it('http_failed → error tone with status / statusText', () => {
    const r = describeProbeOutcome({
      ok: false,
      kind: 'http_failed',
      status: 404,
      statusText: 'Not Found',
      bodyText: 'route missing',
    });
    expect(r.tone).toBe('error');
    expect(r.title).toContain('404');
    expect(r.title).toContain('Not Found');
    expect(r.description).toContain('route missing');
  });

  it('http_failed with empty body falls back to a hint description', () => {
    const r = describeProbeOutcome({
      ok: false,
      kind: 'http_failed',
      status: 500,
      statusText: 'Internal Server Error',
      bodyText: '',
    });
    expect(r.description.length).toBeGreaterThan(0);
    expect(r.description.toLowerCase()).toContain('silverhand');
  });

  it('network_failed → error tone with the underlying message', () => {
    const r = describeProbeOutcome({
      ok: false,
      kind: 'network_failed',
      message: 'connect ECONNREFUSED 127.0.0.1:1234',
    });
    expect(r.tone).toBe('error');
    expect(r.description).toContain('ECONNREFUSED');
  });

  it('invalid_response → error tone explaining the URL responded but is not a Silverhand backend', () => {
    const r = describeProbeOutcome({
      ok: false,
      kind: 'invalid_response',
      message: 'body parse failed',
    });
    expect(r.tone).toBe('error');
    expect(r.title.toLowerCase()).toContain('silverhand');
  });
});
