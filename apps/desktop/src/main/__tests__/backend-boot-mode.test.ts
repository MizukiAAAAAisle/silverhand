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
 *   - profile classifies as remote http WITHOUT dev flag → profile_invalid
 *     (Cindy review fixup P1-B: no silent fallback to embedded)
 *   - profile parse-time obfuscated loopback (saved before a tightened
 *     classifier shipped) → profile_invalid
 *   - URL canonicalization: serverUrl on remote arm is
 *     `URL(input).origin`, not the raw user input
 *   - RemoteModeNotYetWiredError carries serverUrl + insecure
 *   - ProfileUnusableError carries profileUrl + classifyMessage
 *   - evaluateProfileCommitGuard: allow loopback_ok, reject the two
 *     remote arms with typed `remote_backend_not_yet_supported`
 */
import { describe, expect, it } from 'vitest';
import {
  decideBackendBootMode,
  evaluateProfileCommitGuard,
  ProfileUnusableError,
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

  it('no profile (first run) returns embedded/no_profile with empty profileUrl', () => {
    const decision = decideBackendBootMode({
      profileView: null,
      forceEmbedded: false,
      allowInsecureRemote: false,
    });
    expect(decision).toEqual({
      mode: 'embedded',
      reason: 'no_profile',
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

describe('decideBackendBootMode — profile_invalid (Cindy P1-B: no silent embedded fallback)', () => {
  it('http remote profile WITHOUT allowInsecureRemote → profile_invalid (env flag toggled off since commit)', () => {
    // Real-world drift: the user committed the profile under the dev
    // flag, then unset it before relaunching. We MUST NOT silently
    // fall back to embedded — the present profile is data the user
    // committed deliberately. Bootstrap throws ProfileUnusableError;
    // operator clears the profile or restores the env flag.
    const decision = decideBackendBootMode({
      profileView: {
        server_url: 'http://10.0.0.5:8080',
        updated_at: 1,
      },
      forceEmbedded: false,
      allowInsecureRemote: false,
    });
    expect(decision.mode).toBe('profile_invalid');
    if (decision.mode !== 'profile_invalid') throw new Error('unreachable');
    expect(decision.profileUrl).toBe('http://10.0.0.5:8080');
    expect(decision.classifyMessage.length).toBeGreaterThan(0);
    expect(decision.classifyMessage.toLowerCase()).toMatch(/https|insecure|http/);
  });

  it('obfuscated-loopback profile (saved before tightened gate shipped) → profile_invalid', () => {
    // Pin: even though the user may have committed this under an
    // older classifier, the boot-time classifier rejects it as
    // obfuscated_loopback_disallowed; we throw rather than silently
    // re-admitting the form OR silently falling back to embedded.
    const decision = decideBackendBootMode({
      profileView: {
        server_url: 'http://127.000.000.001:8080',
        updated_at: 1,
      },
      forceEmbedded: false,
      allowInsecureRemote: true,
    });
    expect(decision.mode).toBe('profile_invalid');
    if (decision.mode !== 'profile_invalid') throw new Error('unreachable');
    expect(decision.classifyMessage.toLowerCase()).toContain('disguised');
  });

  it('non_origin_url profile → profile_invalid (defense in depth)', () => {
    // Should never happen post-Commit-2 (writer rejects non-origin
    // URLs), but a profile written by an older build could carry
    // one. Boot-time classifier catches it; we throw rather than
    // silently embed.
    const decision = decideBackendBootMode({
      profileView: {
        server_url: 'https://backend.example.test/sub/path',
        updated_at: 1,
      },
      forceEmbedded: false,
      allowInsecureRemote: false,
    });
    expect(decision.mode).toBe('profile_invalid');
    if (decision.mode !== 'profile_invalid') throw new Error('unreachable');
    expect(decision.classifyMessage.toLowerCase()).toContain('origin');
  });

  it('garbage URL profile → profile_invalid (URL constructor rejects)', () => {
    const decision = decideBackendBootMode({
      profileView: {
        server_url: 'not a url',
        updated_at: 1,
      },
      forceEmbedded: false,
      allowInsecureRemote: false,
    });
    expect(decision.mode).toBe('profile_invalid');
    if (decision.mode !== 'profile_invalid') throw new Error('unreachable');
    expect(decision.profileUrl).toBe('not a url');
    expect(decision.classifyMessage.length).toBeGreaterThan(0);
  });
});

describe('decideBackendBootMode — precedence pins', () => {
  it('forceEmbedded fires BEFORE classification (no classifier call when forced)', () => {
    // If forceEmbedded did not short-circuit early, a remote profile
    // with `allowInsecureRemote: false` and an http URL would land
    // on `profile_invalid`. The expected outcome is `forced_by_env`
    // — pin it.
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

  it('present-but-classifying profile lands on remote (not profile_invalid)', () => {
    // Sanity: profile_invalid is reserved for classifier-failures,
    // NOT for "profile is present and the URL is fine but the boot
    // path is not yet wired" — that's `mode: 'remote'` + trip wire.
    const decision = decideBackendBootMode({
      profileView: {
        server_url: 'https://backend.example.test',
        updated_at: 1,
      },
      forceEmbedded: false,
      allowInsecureRemote: false,
    });
    expect(decision.mode).toBe('remote');
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

describe('ProfileUnusableError', () => {
  it('carries profileUrl + classifyMessage for log lines and operator-facing message', () => {
    const err = new ProfileUnusableError({
      mode: 'profile_invalid',
      profileUrl: 'http://10.0.0.5:8080',
      classifyMessage: "Backend host '10.0.0.5' is non-loopback over http://.",
    });
    expect(err.name).toBe('ProfileUnusableError');
    expect(err.profileUrl).toBe('http://10.0.0.5:8080');
    expect(err.classifyMessage).toContain('non-loopback');
    // Operator message must surface all three escape paths so a
    // user without context can self-repair.
    expect(err.message).toContain('Clear saved profile');
    expect(err.message).toContain('SILVERHAND_ALLOW_INSECURE_REMOTE');
    expect(err.message).toContain('SILVERHAND_FORCE_EMBEDDED');
    expect(err.message).toContain('http://10.0.0.5:8080');
  });
});

describe('evaluateProfileCommitGuard (Cindy P1-A: persistence must not write what boot will refuse)', () => {
  it('allows loopback_ok — the only currently-supported commit kind', () => {
    expect(evaluateProfileCommitGuard('loopback_ok')).toEqual({ allow: true });
  });

  it('refuses system_ca_verified with typed `remote_backend_not_yet_supported`', () => {
    const outcome = evaluateProfileCommitGuard('system_ca_verified');
    expect(outcome.allow).toBe(false);
    if (outcome.allow) throw new Error('unreachable');
    expect(outcome.reason).toBe('remote_backend_not_yet_supported');
    expect(outcome.message.toLowerCase()).toContain('remote backend');
    expect(outcome.message).toContain('Commit 5');
  });

  it('refuses insecure_dev_remote and explicitly mentions the dev flag in the message', () => {
    const outcome = evaluateProfileCommitGuard('insecure_dev_remote');
    expect(outcome.allow).toBe(false);
    if (outcome.allow) throw new Error('unreachable');
    expect(outcome.reason).toBe('remote_backend_not_yet_supported');
    // The dev-flag-specific copy distinguishes "you set the dev env
    // and it admitted the URL" from "you typed an https URL" so the
    // operator knows which knob to twist.
    expect(outcome.message).toContain('SILVERHAND_ALLOW_INSECURE_REMOTE');
  });

  it('persistence ↔ boot invariant: every probe kind the guard ALLOWS must boot embedded (loopback) — never trip a wire', () => {
    // Cross-check: if the guard says "allow", the resulting saved
    // profile MUST land in an embedded boot arm (not remote, not
    // profile_invalid) on the next launch. This is the load-bearing
    // contract Cindy P1-A pins.
    const allowedKinds: Array<'loopback_ok' | 'system_ca_verified' | 'insecure_dev_remote'> = [
      'loopback_ok',
      'system_ca_verified',
      'insecure_dev_remote',
    ];
    for (const kind of allowedKinds) {
      const guard = evaluateProfileCommitGuard(kind);
      if (!guard.allow) continue;
      // If we ever widen the guard, the boot-mode side MUST land in
      // a non-throwing arm. Today only loopback_ok is allowed and
      // boots embedded — pin it.
      expect(kind).toBe('loopback_ok');
    }
  });
});
