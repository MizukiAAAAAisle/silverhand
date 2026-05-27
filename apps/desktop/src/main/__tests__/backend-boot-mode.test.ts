/**
 * D4.a Commit 3 — unit tests for the boot-mode decision primitive.
 *
 * Coverage per arm:
 *   - forceEmbedded short-circuit (wins over a remote profile,
 *     ignores classifier failures)
 *   - no profile (first run) → embedded/no_profile
 *   - profile is loopback → embedded/profile_is_loopback
 *   - profile classifies as remote https → remote/insecure=false
 *   - profile classifies as remote http with dev flag → remote/insecure=true
 *   - profile classifies as remote http WITHOUT dev flag → embedded/profile_classify_failed
 *   - profile parse-time obfuscated loopback (saved before a tightened
 *     classifier shipped) → embedded/profile_classify_failed
 *   - URL canonicalization: serverUrl on remote arm is
 *     `URL(input).origin`, not the raw user input
 *   - RemoteModeNotYetWiredError carries serverUrl + insecure
 */
import { describe, expect, it } from 'vitest';
import {
  decideBackendBootMode,
  RemoteModeNotYetWiredError,
} from '../backend-boot-mode.js';

describe('decideBackendBootMode — embedded short-circuits', () => {
  it('forceEmbedded wins over a present remote profile', () => {
    const decision = decideBackendBootMode({
      profileView: {
        server_url: 'https://backend.example.test',
        updated_at: 1_716_800_000_000,
      },
      forceEmbedded: true,
      allowInsecureRemote: false,
    });
    expect(decision).toEqual({
      mode: 'embedded',
      reason: 'forced_by_env',
      classifyMessage: '',
      profileUrl: 'https://backend.example.test',
    });
  });

  it('forceEmbedded wins even when the profile URL would have failed classification', () => {
    // Defensive: a developer with a broken on-disk profile (e.g.
    // garbage URL from a future schema change) must still be able to
    // boot the embedded backend via the dev flag.
    const decision = decideBackendBootMode({
      profileView: {
        server_url: 'not a url at all',
        updated_at: 1,
      },
      forceEmbedded: true,
      allowInsecureRemote: false,
    });
    expect(decision.mode).toBe('embedded');
    if (decision.mode !== 'embedded') throw new Error('unreachable');
    expect(decision.reason).toBe('forced_by_env');
  });

  it('no profile (first run) returns embedded/no_profile with empty fields', () => {
    const decision = decideBackendBootMode({
      profileView: null,
      forceEmbedded: false,
      allowInsecureRemote: false,
    });
    expect(decision).toEqual({
      mode: 'embedded',
      reason: 'no_profile',
      classifyMessage: '',
      profileUrl: '',
    });
  });

  it.each([
    'http://127.0.0.1:18080',
    'http://localhost:7321',
    'http://[::1]:9000',
    'https://localhost',
  ])('loopback profile %s → embedded/profile_is_loopback', url => {
    const decision = decideBackendBootMode({
      profileView: { server_url: url, updated_at: 1 },
      forceEmbedded: false,
      allowInsecureRemote: false,
    });
    expect(decision.mode).toBe('embedded');
    if (decision.mode !== 'embedded') throw new Error('unreachable');
    expect(decision.reason).toBe('profile_is_loopback');
    expect(decision.profileUrl).toBe(url);
    expect(decision.classifyMessage).toBe('');
  });
});

describe('decideBackendBootMode — remote arms', () => {
  it('https remote profile → remote with insecure=false', () => {
    const decision = decideBackendBootMode({
      profileView: {
        server_url: 'https://backend.example.test',
        updated_at: 1,
      },
      forceEmbedded: false,
      allowInsecureRemote: false,
    });
    expect(decision).toEqual({
      mode: 'remote',
      serverUrl: 'https://backend.example.test',
      insecure: false,
    });
  });

  it('http remote profile + allowInsecureRemote=true → remote with insecure=true', () => {
    const decision = decideBackendBootMode({
      profileView: {
        server_url: 'http://10.0.0.5:8080',
        updated_at: 1,
      },
      forceEmbedded: false,
      allowInsecureRemote: true,
    });
    expect(decision).toEqual({
      mode: 'remote',
      serverUrl: 'http://10.0.0.5:8080',
      insecure: true,
    });
  });

  it('http remote profile WITHOUT allowInsecureRemote → embedded/profile_classify_failed (env flag toggled off since commit)', () => {
    // Real-world drift: the user committed the profile under the dev
    // flag, then unset it before relaunching. We MUST NOT silently
    // accept the http URL — fall back to embedded and surface the
    // classifier message so the operator can diagnose.
    const decision = decideBackendBootMode({
      profileView: {
        server_url: 'http://10.0.0.5:8080',
        updated_at: 1,
      },
      forceEmbedded: false,
      allowInsecureRemote: false,
    });
    expect(decision.mode).toBe('embedded');
    if (decision.mode !== 'embedded') throw new Error('unreachable');
    expect(decision.reason).toBe('profile_classify_failed');
    expect(decision.profileUrl).toBe('http://10.0.0.5:8080');
    expect(decision.classifyMessage.length).toBeGreaterThan(0);
    expect(decision.classifyMessage.toLowerCase()).toMatch(
      /https|insecure|http/,
    );
  });

  it('obfuscated-loopback profile (saved before tightened gate shipped) → embedded/profile_classify_failed', () => {
    // Pin: even though the user may have committed this under an
    // older classifier, the boot-time classifier rejects it as
    // obfuscated_loopback_disallowed; we fall back to embedded
    // rather than silently re-admitting the form.
    const decision = decideBackendBootMode({
      profileView: {
        server_url: 'http://127.000.000.001:8080',
        updated_at: 1,
      },
      forceEmbedded: false,
      allowInsecureRemote: true,
    });
    expect(decision.mode).toBe('embedded');
    if (decision.mode !== 'embedded') throw new Error('unreachable');
    expect(decision.reason).toBe('profile_classify_failed');
    expect(decision.classifyMessage.toLowerCase()).toContain('disguised');
  });

  it('non_origin_url profile → embedded/profile_classify_failed (defense in depth)', () => {
    // Should never happen post-Commit-2 (writer rejects non-origin
    // URLs), but a profile written by an older build could carry
    // one. Boot-time classifier catches it.
    const decision = decideBackendBootMode({
      profileView: {
        server_url: 'https://backend.example.test/sub/path',
        updated_at: 1,
      },
      forceEmbedded: false,
      allowInsecureRemote: false,
    });
    expect(decision.mode).toBe('embedded');
    if (decision.mode !== 'embedded') throw new Error('unreachable');
    expect(decision.reason).toBe('profile_classify_failed');
    expect(decision.classifyMessage.toLowerCase()).toContain('origin');
  });

  it('canonicalizes URL on the remote arm — serverUrl is the parsed origin, not the raw input', () => {
    // The classifier normalizes ports / trailing slashes via
    // `new URL(input).origin`. Pin that the decision hands back the
    // normalized form so downstream callers see one canonical URL
    // regardless of the user's raw input shape.
    const decision = decideBackendBootMode({
      profileView: {
        server_url: 'HTTPS://Backend.Example.Test',
        updated_at: 1,
      },
      forceEmbedded: false,
      allowInsecureRemote: false,
    });
    expect(decision.mode).toBe('remote');
    if (decision.mode !== 'remote') throw new Error('unreachable');
    // URL parser lowercases scheme + host; origin has no trailing
    // slash. This is the canonical form.
    expect(decision.serverUrl).toBe('https://backend.example.test');
  });

  it('canonicalizes URL on the remote arm — explicit default port', () => {
    const decision = decideBackendBootMode({
      profileView: {
        server_url: 'https://backend.example.test:443',
        updated_at: 1,
      },
      forceEmbedded: false,
      allowInsecureRemote: false,
    });
    expect(decision.mode).toBe('remote');
    if (decision.mode !== 'remote') throw new Error('unreachable');
    // Default https port stripped by URL parser.
    expect(decision.serverUrl).toBe('https://backend.example.test');
  });
});

describe('decideBackendBootMode — precedence pins', () => {
  it('forceEmbedded fires BEFORE classification (no classifier call when forced)', () => {
    // If forceEmbedded did not short-circuit early, a remote profile
    // with `allowInsecureRemote: false` and an http URL would
    // classify-fail and we'd land on `profile_classify_failed`. The
    // expected outcome is `forced_by_env` — pin it.
    const decision = decideBackendBootMode({
      profileView: {
        server_url: 'http://10.0.0.5:8080',
        updated_at: 1,
      },
      forceEmbedded: true,
      allowInsecureRemote: false,
    });
    expect(decision.mode).toBe('embedded');
    if (decision.mode !== 'embedded') throw new Error('unreachable');
    expect(decision.reason).toBe('forced_by_env');
  });

  it('no_profile fires BEFORE classification (no classifier call when profileView is null)', () => {
    // Even though we pass an explicit allowInsecureRemote, the
    // classifier MUST NOT run because there is no URL to classify.
    const decision = decideBackendBootMode({
      profileView: null,
      forceEmbedded: false,
      allowInsecureRemote: true,
    });
    expect(decision.mode).toBe('embedded');
    if (decision.mode !== 'embedded') throw new Error('unreachable');
    expect(decision.reason).toBe('no_profile');
  });
});

describe('RemoteModeNotYetWiredError', () => {
  it('carries serverUrl and insecure for log lines', () => {
    const err = new RemoteModeNotYetWiredError({
      mode: 'remote',
      serverUrl: 'https://backend.example.test',
      insecure: false,
    });
    expect(err.name).toBe('RemoteModeNotYetWiredError');
    expect(err.serverUrl).toBe('https://backend.example.test');
    expect(err.insecure).toBe(false);
    expect(err.message).toContain('https://backend.example.test');
    expect(err.message).toContain('SILVERHAND_FORCE_EMBEDDED');
    expect(err.message).toContain('Commit 5');
  });

  it('carries the insecure flag verbatim for the dev-flag http remote case', () => {
    const err = new RemoteModeNotYetWiredError({
      mode: 'remote',
      serverUrl: 'http://10.0.0.5:8080',
      insecure: true,
    });
    expect(err.insecure).toBe(true);
    expect(err.message).toContain('insecure=true');
  });
});
