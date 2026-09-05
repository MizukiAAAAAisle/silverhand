/**
 * D4.a Commit 3 → 5d — unit tests for the boot-mode decision
 * primitive + the 5d adapter (`planBackendStartup`).
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
 *   - ProfileUnusableError carries profileUrl + classifyMessage
 *   - evaluateProfileCommitGuard (5d lift): every probe success
 *     kind allows persistence; the persistence ↔ boot invariant
 *     pins that allowed kinds map to a non-throwing boot arm
 *     (`embedded` or `remote`), never `profile_invalid`.
 *   - planBackendStartup (5d adapter): every BackendBootMode arm
 *     maps to exactly one BackendStartupPlan arm; serverUrl /
 *     insecure / classifyMessage flow through unchanged.
 */
import { describe, expect, it } from 'vitest';
import {
  decideBackendBootMode,
  evaluateProfileCommitGuard,
  planBackendStartup,
  ProfileUnusableError,
  type BackendBootMode,
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

describe('evaluateProfileCommitGuard (D4.a 5d lift: every probe success kind is now safe to persist)', () => {
  it('allows loopback_ok — embedded boot path', () => {
    expect(evaluateProfileCommitGuard('loopback_ok')).toEqual({ allow: true });
  });

  it('allows system_ca_verified — remote boot path (https / valid CA)', () => {
    expect(evaluateProfileCommitGuard('system_ca_verified')).toEqual({ allow: true });
  });

  it('allows insecure_dev_remote — remote boot path admitted via dev flag', () => {
    expect(evaluateProfileCommitGuard('insecure_dev_remote')).toEqual({ allow: true });
  });

  it('persistence ↔ boot invariant: every probe kind the guard ALLOWS must map to a non-throwing boot arm — never profile_invalid', () => {
    // Cross-check (Cindy 5d review boundary 4): if the guard says
    // "allow", the resulting saved profile MUST land in a
    // non-throwing boot-mode arm (`embedded` or `remote`) on the
    // next launch. This is the load-bearing contract — saving a
    // profile must never crash next launch.
    const allowedKinds: Array<'loopback_ok' | 'system_ca_verified' | 'insecure_dev_remote'> = [
      'loopback_ok',
      'system_ca_verified',
      'insecure_dev_remote',
    ];
    // Map each kind to the URL the writer would persist (origin-only
    // per §7.1); decideBackendBootMode would then re-classify and
    // produce a boot decision.
    const kindToUrl = {
      loopback_ok: 'http://127.0.0.1:8080',
      system_ca_verified: 'https://backend.example.test',
      insecure_dev_remote: 'http://10.0.0.5:8080',
    } as const;
    // Whether dev flag was set at write time. `insecure_dev_remote`
    // requires it; the others don't depend on it.
    const allowInsecureRemote = true;
    for (const kind of allowedKinds) {
      const guard = evaluateProfileCommitGuard(kind);
      if (!guard.allow) {
        throw new Error(`5d guard regressed: ${kind} should be allowed`);
      }
      const decision = decideBackendBootMode({
        profileView: { server_url: kindToUrl[kind], updated_at: 0 },
        forceEmbedded: false,
        allowInsecureRemote,
      });
      // The whole point of the invariant: allowed kinds must NOT
      // land in `profile_invalid` on next boot.
      expect(decision.mode === 'embedded' || decision.mode === 'remote').toBe(true);
    }
  });
});

describe('planBackendStartup (D4.a 5d adapter — pure decision → plan converter)', () => {
  it('embedded/no_profile → plan: embedded with no_profile reason', () => {
    const decision: BackendBootMode = {
      mode: 'embedded',
      reason: 'no_profile',
      profileUrl: '',
    };
    const plan = planBackendStartup(decision);
    expect(plan).toEqual({ mode: 'embedded', embeddedReason: 'no_profile' });
  });

  it('embedded/forced_by_env → plan: embedded with forced_by_env reason', () => {
    const decision: BackendBootMode = {
      mode: 'embedded',
      reason: 'forced_by_env',
      profileUrl: '',
    };
    const plan = planBackendStartup(decision);
    expect(plan).toEqual({ mode: 'embedded', embeddedReason: 'forced_by_env' });
  });

  it('embedded/profile_is_loopback → plan: embedded with profile_is_loopback reason', () => {
    const decision: BackendBootMode = {
      mode: 'embedded',
      reason: 'profile_is_loopback',
      profileUrl: 'http://127.0.0.1:8080',
    };
    const plan = planBackendStartup(decision);
    expect(plan).toEqual({ mode: 'embedded', embeddedReason: 'profile_is_loopback' });
  });

  it('remote/insecure=false → plan: remote with serverUrl + insecure=false (https / valid CA)', () => {
    const decision: BackendBootMode = {
      mode: 'remote',
      serverUrl: 'https://backend.example.test',
      insecure: false,
    };
    const plan = planBackendStartup(decision);
    expect(plan).toEqual({
      mode: 'remote',
      serverUrl: 'https://backend.example.test',
      insecure: false,
    });
  });

  it('remote/insecure=true → plan: remote with serverUrl + insecure=true (admitted via dev flag)', () => {
    const decision: BackendBootMode = {
      mode: 'remote',
      serverUrl: 'http://10.0.0.5:8080',
      insecure: true,
    };
    const plan = planBackendStartup(decision);
    expect(plan).toEqual({
      mode: 'remote',
      serverUrl: 'http://10.0.0.5:8080',
      insecure: true,
    });
  });

  it('profile_invalid → plan: refuse with classifier message preserved', () => {
    const decision: BackendBootMode = {
      mode: 'profile_invalid',
      profileUrl: 'http://10.0.0.5:8080',
      classifyMessage: 'http remote requires SILVERHAND_ALLOW_INSECURE_REMOTE=1',
    };
    const plan = planBackendStartup(decision);
    expect(plan).toEqual({
      mode: 'refuse',
      reason: 'profile_invalid',
      profileUrl: 'http://10.0.0.5:8080',
      classifyMessage: 'http remote requires SILVERHAND_ALLOW_INSECURE_REMOTE=1',
    });
  });

  it('plan never silently widens: a remote decision MUST produce a remote plan, NOT an embedded plan, NOT a refuse plan', () => {
    // Cindy 5d review boundary 5: the test seam pins that a remote
    // decision is converted into a `remote` plan verbatim. A
    // refactor that accidentally collapses `mode: 'remote'` into
    // an embedded plan (e.g. by reading the wrong field) breaks
    // this assertion.
    const decision: BackendBootMode = {
      mode: 'remote',
      serverUrl: 'https://backend.example.test',
      insecure: false,
    };
    const plan = planBackendStartup(decision);
    expect(plan.mode).toBe('remote');
    if (plan.mode !== 'remote') throw new Error('unreachable');
    expect(plan.serverUrl).toBe('https://backend.example.test');
    expect(plan.insecure).toBe(false);
  });

  it('plan does NOT throw on profile_invalid — bootstrap site owns the throw', () => {
    // The adapter is pure / throw-free. The bootstrap site is the
    // only place that decides whether to throw `ProfileUnusableError`.
    // This keeps the plan/decision conversion easy to unit-test
    // without standing up the error class' constructor.
    const decision: BackendBootMode = {
      mode: 'profile_invalid',
      profileUrl: 'http://10.0.0.5:8080',
      classifyMessage: 'oops',
    };
    expect(() => planBackendStartup(decision)).not.toThrow();
  });
});
