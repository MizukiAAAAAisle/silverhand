/**
 * D3.c Commit 1 — single-source-of-truth tests for the V1 server URL
 * acceptance policy that ships in `@silverhand/shared`.
 *
 * D4.a Commit 1 extension (+ review tightening 2026-05-28):
 * classifier widened to admit `kind: 'remote'` for non-loopback
 * https (always) and non-loopback http (only under the dev flag).
 * The D3.c raw-host strict-allowlist regression coverage (obfuscated
 * IPv4, expanded IPv6, userinfo refusal, IPv6 bracket-suffix
 * smuggling) is preserved verbatim — but obfuscated forms are now
 * **rejected outright** as `obfuscated_loopback_disallowed`
 * regardless of scheme and flag, NOT classified as remote. The
 * positive loopback allowlist gate and the negative obfuscated-form
 * gate are two halves of the same "visible URL form must match the
 * host the daemon actually connects to" invariant.
 *
 * Why these tests live in the shared test runner:
 *   - `@silverhand/shared` is a host-agnostic types/utility package;
 *     contract tests against its modules belong in its own runner so
 *     ownership and gate boundaries match. (Pre-#1 these were parked
 *     under the backend runner because shared had no test config of
 *     its own — that's no longer true.)
 *   - The classifier itself has zero backend dependencies; this file
 *     is a *unit* test against the shared module, not a backend
 *     integration test.
 *
 * Coverage strategy:
 *   1. Every accepted loopback hostname variant + case normalization.
 *   2. Every rejection reason has at least one positive example.
 *   3. Boundary inputs that frequently break naive
 *      "if hostname starts with 127" implementations
 *      (`127.0.0.2`, `0.0.0.0`, IPv6 short forms, DNS aliases that
 *      *resolve* to loopback but should still be rejected).
 *   4. `kind: 'loopback' | 'remote'` discriminant + URL passthrough
 *      + insecure flag honesty.
 *   5. D4.a dev-flag scope invariant (Cindy lock): flag only affects
 *      non-loopback http acceptance — does NOT affect https TLS
 *      verify path, does NOT widen scheme allowlist, does NOT relax
 *      raw-host strict-allowlist defenses.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyServerUrl,
  isLoopbackHost,
  type ServerUrlClassification,
} from '@silverhand/shared';

describe('isLoopbackHost — V1 allowlist', () => {
  // The four canonical literals. Any addition here is a V1 policy
  // change, NOT a bug — review carefully.
  it.each(['localhost', '127.0.0.1', '::1', '[::1]'])(
    'accepts canonical loopback literal: %s',
    (host) => {
      expect(isLoopbackHost(host)).toBe(true);
    },
  );

  it('is case-insensitive (URL.hostname may not be pre-normalized)', () => {
    // Real-world inputs from settings files / hand-typed URLs may
    // carry mixed case. The classifier lowercases before comparing
    // so users don't have to memorize "lowercase localhost only".
    expect(isLoopbackHost('LOCALHOST')).toBe(true);
    expect(isLoopbackHost('LocalHost')).toBe(true);
  });

  it('rejects `127.0.0.2` even though it is technically loopback (127.0.0.0/8)', () => {
    // Strict allowlist by design. Allowing the whole /8 would
    // muddle the V1.1 transition where remote backend support
    // lands and we may want to revisit "what does loopback mean
    // here, exactly". Keep it narrow.
    expect(isLoopbackHost('127.0.0.2')).toBe(false);
  });

  it('rejects `0.0.0.0` (not a routable destination; some platforms map it to localhost but the daemon must NOT connect to it)', () => {
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
  });

  it.each([
    '10.0.0.1', // RFC 1918 private
    '172.16.5.4', // RFC 1918 private
    '192.168.1.1', // RFC 1918 private
    '169.254.10.10', // link-local
    '8.8.8.8', // public
    'example.com', // public DNS
    'mybox.local', // mDNS — could resolve to loopback but
    // accepting it would muddle "loopback" with
    // "trust local DNS resolver".
    '', // empty
  ])('rejects non-loopback hostname: %s', (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});

describe('classifyServerUrl — V1 acceptance policy', () => {
  // Helper: assert ok-path with kind=loopback and that the URL
  // round-tripped through the parser. We don't pin .href verbatim
  // because the URL parser normalizes (e.g. `http://localhost` →
  // `http://localhost/`).
  function expectLoopback(input: string): URL {
    const out = classifyServerUrl(input);
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error('unreachable');
    expect(out.kind).toBe('loopback');
    return out.url;
  }

  function expectReject(
    input: string,
    reason: Exclude<ServerUrlClassification, { ok: true }>['reason'],
  ): string {
    const out = classifyServerUrl(input);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.reason).toBe(reason);
    expect(out.message.length).toBeGreaterThan(0);
    return out.message;
  }

  // ── Happy paths ────────────────────────────────────────────────

  it('accepts http://localhost', () => {
    const u = expectLoopback('http://localhost');
    expect(u.hostname).toBe('localhost');
    expect(u.protocol).toBe('http:');
  });

  it('accepts http://localhost:18080 with explicit port (embedded backend default shape)', () => {
    const u = expectLoopback('http://localhost:18080');
    expect(u.port).toBe('18080');
  });

  it('accepts http://127.0.0.1:8765', () => {
    const u = expectLoopback('http://127.0.0.1:8765');
    expect(u.hostname).toBe('127.0.0.1');
    expect(u.port).toBe('8765');
  });

  it('accepts http://[::1]:1234 (bracketed IPv6 literal — URL.hostname keeps the brackets in Node)', () => {
    // Node's URL parser preserves the brackets on `hostname`
    // (`'[::1]'`) — different runtimes/environments may strip
    // them. The allowlist contains BOTH `[::1]` and `::1` so the
    // classifier accepts the hostname whichever way it arrives.
    const u = expectLoopback('http://[::1]:1234');
    expect(u.hostname).toBe('[::1]');
    expect(u.port).toBe('1234');
  });

  it("accepts https://localhost (remote backend won't happen in V1, but TLS-to-loopback is structurally valid)", () => {
    // V1 backend is plain http; this case is for dev / test
    // scaffolding (mkcert against localhost, etc.). Classifier
    // doesn't require http: — it just requires loopback.
    const u = expectLoopback('https://localhost');
    expect(u.protocol).toBe('https:');
  });

  // ── Rejections ─────────────────────────────────────────────────

  it('rejects malformed URL (`URL` constructor throws)', () => {
    expectReject('not a url at all', 'malformed_url');
    expectReject('', 'malformed_url');
  });

  it('rejects `localhost:8080` (no scheme; `URL` parses this as scheme=`localhost:` so it lands in unsupported_scheme, NOT malformed)', () => {
    // Subtle parser quirk worth pinning: `new URL('localhost:8080')`
    // succeeds with `protocol === 'localhost:'`. The classifier
    // surfaces this as `unsupported_scheme` rather than
    // `malformed_url`, so the UI shows the right hint ("use http://
    // or https://") instead of a confusing "invalid URL" message.
    expectReject('localhost:8080', 'unsupported_scheme');
  });

  it('rejects ws:// (must be http/https; transport WS conversion lives in daemon)', () => {
    expectReject('ws://localhost:18080', 'unsupported_scheme');
    expectReject('wss://localhost:18080', 'unsupported_scheme');
  });

  it('rejects file:// (would otherwise pass the URL parser but is meaningless as a backend URL)', () => {
    expectReject('file:///etc/passwd', 'unsupported_scheme');
  });

  it('rejects ftp:// and other exotic schemes', () => {
    expectReject('ftp://localhost', 'unsupported_scheme');
  });

  it('rejects non-loopback hostnames over http without opt-in (the "use https or explicitly allow" case)', () => {
    // D4.a Commit 1 widened the classifier: non-loopback http used to
    // be `non_loopback_host`; under D4.a it is
    // `insecure_remote_http_disallowed`. Same wire effect (rejection)
    // but the new reason points the operator at the two valid escape
    // routes (use https, or opt in at the caller boundary).
    const msg = expectReject('http://api.example.com', 'insecure_remote_http_disallowed');
    expect(msg).toMatch(/Use https:\/\//);
    expect(msg).toMatch(/explicitly allow insecure remote HTTP/);
  });

  it('rejects LAN IP over http without dev flag — the most common typo when someone copies their dev box IP', () => {
    expectReject('http://192.168.1.10:18080', 'insecure_remote_http_disallowed');
    expectReject('http://10.0.0.5:18080', 'insecure_remote_http_disallowed');
  });

  it('rejects 0.0.0.0 over http (some platforms accept it as bind-all but we must not connect to it)', () => {
    expectReject('http://0.0.0.0:18080', 'insecure_remote_http_disallowed');
  });

  it('rejects mybox.local over http without dev flag (mDNS alias that could resolve to loopback but is not in the allowlist)', () => {
    // Pinning this case is the load-bearing test for the strict
    // "literal allowlist, not DNS resolution" policy. Cindy D3.c
    // round 1 wording: "TLS http exception not for `*.local`".
    expectReject('http://mybox.local:18080', 'insecure_remote_http_disallowed');
  });

  it('rejects 127.0.0.2 over http without dev flag — RFC 1122 loopback but outside the strict allowlist', () => {
    // Strict allowlist holds across the D4.a widening: 127.0.0.2 is
    // not a literal allowlist entry, so it never classifies as
    // loopback. Under http+no-flag it rejects; under https or
    // http+flag it would classify as remote (NOT loopback).
    expectReject('http://127.0.0.2:18080', 'insecure_remote_http_disallowed');
  });

  // ── Obfuscated IP forms (Cindy `#task:631` D3.c P1 + D4.a C1 review) ─
  //
  // Strict-allowlist regression coverage. All five of these inputs
  // have `new URL(input).hostname === '127.0.0.1'` (IPv4 cases) or
  // `=== '[::1]'` (IPv6 case) because `URL` normalizes them — so a
  // naive `isLoopbackHost(url.hostname)` check would accept them AS
  // LOOPBACK and silently widen the policy.
  //
  // D4.a Commit 1 invariant strengthened by Cindy review 2026-05-28:
  // these forms are **rejected outright** with a dedicated
  // `obfuscated_loopback_disallowed` reason, IGNORING scheme and the
  // `allowInsecureRemote` dev flag. Without this strengthening, the
  // dev flag would let an obfuscated loopback form classify as
  // `kind: 'remote', insecure: true` — but the URL would still
  // resolve to loopback at the IP layer, re-admitting the exact
  // regression D3.c's raw-host gate was designed to block.
  //
  // The strict-loopback allowlist gate is positive-only; this
  // obfuscated-form gate is the negative half of the same invariant.
  // Both halves are pinned by the `obfuscation-defense-regardless-
  // of-flag` block below.

  it('rejects dotted-decimal with leading zeros (`127.000.000.001`) — URL.hostname normalizes to 127.0.0.1', () => {
    const msg = expectReject('http://127.000.000.001:18080', 'obfuscated_loopback_disallowed');
    // Message must surface the RAW host as written so the user can
    // see exactly which token failed — comparing against the
    // URL-normalized canonical `127.0.0.1` would be confusing here
    // ("but I typed 127.000.000.001!").
    expect(msg).toContain('127.000.000.001');
  });

  it('rejects octal first octet (`0177.0.0.1`) — URL.hostname normalizes to 127.0.0.1', () => {
    const msg = expectReject('http://0177.0.0.1:18080', 'obfuscated_loopback_disallowed');
    expect(msg).toContain('0177.0.0.1');
  });

  it('rejects 32-bit decimal IPv4 (`2130706433` = 0x7f000001) — URL.hostname normalizes to 127.0.0.1', () => {
    const msg = expectReject('http://2130706433:18080', 'obfuscated_loopback_disallowed');
    expect(msg).toContain('2130706433');
  });

  it('rejects 32-bit hex IPv4 (`0x7f000001`) — URL.hostname normalizes to 127.0.0.1', () => {
    const msg = expectReject('http://0x7f000001:18080', 'obfuscated_loopback_disallowed');
    expect(msg).toContain('0x7f000001');
  });

  it('rejects expanded IPv6 (`[0:0:0:0:0:0:0:1]`) — URL.hostname normalizes to [::1]', () => {
    // Pin the IPv6 branch of the obfuscation defense.
    const msg = expectReject('http://[0:0:0:0:0:0:0:1]:18080', 'obfuscated_loopback_disallowed');
    expect(msg).toContain('[0:0:0:0:0:0:0:1]');
  });

  it('rejects obfuscated IPv4 over https — gate is scheme-agnostic (Cindy D4.a C1 review)', () => {
    // The obfuscated-loopback gate ignores scheme — putting https in
    // front of `0x7f000001` does NOT make it a legitimate remote
    // host. Pin this so a future "let's only gate http" refactor
    // can't quietly re-admit https-disguised loopback.
    const msg = expectReject('https://0x7f000001:8443', 'obfuscated_loopback_disallowed');
    expect(msg).toContain('0x7f000001');
  });

  // ── Userinfo refusal (Cindy `#task:631` D3.c P1 round 2) ───────
  //
  // The earlier draft of `extractRawAuthorityHost` silently dropped
  // `user[:pass]@` and continued classifying the trailing host.
  // That bypassed the V1 allowlist gate because
  // `http://api.example.com@localhost:18080` would extract to
  // `localhost` and pass — even though the WHOLE URL carries an
  // attacker-controlled cosmetic prefix, AND the success-path
  // `URL.toString()` would propagate it into the wsUrl the daemon
  // connects to (where ws:// Basic-auth userinfo semantics could
  // collide with our Bearer header). V1 has no use case for HTTP
  // basic-auth on the backend URL, so the policy refuses the
  // construct entirely. Surfaced under the existing `malformed_url`
  // reason (no new UI branch).

  it('rejects `http://user@localhost:18080` (userinfo would mask a non-loopback host check)', () => {
    const msg = expectReject('http://user@localhost:18080', 'malformed_url');
    // Message must be actionable: the user needs to know which
    // construct was refused, not just "URL is invalid".
    expect(msg).toMatch(/credentials/i);
  });

  it('rejects `http://user:pass@127.0.0.1:18080` (userinfo with password also refused)', () => {
    expectReject('http://user:pass@127.0.0.1:18080', 'malformed_url');
  });

  it('rejects `http://api.example.com@localhost:18080` (the load-bearing attacker-shape case)', () => {
    // Without the userinfo refusal this URL would pass: the host
    // after `@` is `localhost`, an allowlist entry. Pinning this
    // input keeps anyone from "fixing" the helper by re-adding the
    // silent-drop behavior under the misguided belief that the
    // remaining authority is the only thing that matters.
    expectReject('http://api.example.com@localhost:18080', 'malformed_url');
  });

  it('still rejects `@` outside the authority via the non_origin gate, not via userinfo malformed_url', () => {
    // Guard against an over-broad userinfo refusal that would also
    // reject `@` appearing in path / query / fragment. After D4.a
    // Commit 2 fixup the URL gets rejected by the origin-only gate
    // (path + query both make it non-origin-shaped), NOT by the
    // userinfo `malformed_url` branch. The point of this test is to
    // pin that `@` in non-authority contexts is NOT what fails the
    // input — the shape of the URL is.
    expectReject('http://localhost:18080/api?token=a@b', 'non_origin_url');
  });

  // ── IPv6 bracket-suffix validation (Cindy `#task:631` D3.c P1 r3)
  //
  // The authority grammar `IP-literal [ ":" port ]` permits only an
  // empty tail or `:port` after the closing bracket. Inputs that
  // smuggle text after `]` must be rejected by the extractor itself
  // — not by relying on `new URL()` to refuse the form, which is a
  // brittle two-layer dependency we explicitly don't want. Zone-id
  // / percent forms remain rejected via the non-loopback allowlist
  // (their raw text never matches `[::1]` literally).

  it('rejects text after an IPv6 closing bracket as malformed', () => {
    // Public rejection only: the URL parser may reject before the raw-host
    // extractor. This does not claim to exercise that private branch.
    expectReject('http://[::1]evil:18080', 'malformed_url');
  });

  it('rejects `http://[::1%25lo0]:18080` (percent-encoded IPv6 zone-id — same "URL parser semantic equivalence" family as expanded IPv6)', () => {
    // Cindy's spec originally wanted the raw-extract path to fire
    // here so the literal `[::1%25lo0]` shows up in the rejection
    // message; in the current Node version the URL constructor
    // refuses to parse the percent-encoded zone-id at all, so the
    // input lands in `malformed_url` before the raw extractor runs.
    // The load-bearing invariant is "rejected, period" — pin
    // whichever rejection path the runtime takes so we notice if a
    // future Node release loosens its parser and starts normalizing
    // zone-id forms to `[::1]` (which is exactly the "URL parser
    // semantic equivalence" class we explicitly do NOT want to
    // admit into the loopback allowlist).
    //
    // D4.a Commit 1 review (Cindy 2026-05-28): if a future Node DOES
    // accept the zone-id and normalize hostname to `[::1]`, this
    // input would route through the new
    // `obfuscated_loopback_disallowed` gate (raw host
    // `[::1%25lo0]` not in allowlist, but `parsed.hostname === '[::1]'`
    // which IS in allowlist). Either rejection path is acceptable;
    // BOTH `non_loopback_host` (the old D3 reason, no longer
    // defined under D4.a so it cannot appear) and the new typed
    // reasons keep us covered.
    const out = classifyServerUrl('http://[::1%25lo0]:18080');
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    // Acceptable reasons under D4.a:
    //   - `malformed_url` (URL constructor refused — current Node).
    //   - `obfuscated_loopback_disallowed` (constructor accepted +
    //      hostname normalized to `[::1]` — hypothetical future Node).
    //   - `insecure_remote_http_disallowed` (constructor accepted +
    //      hostname stayed `[::1%25lo0]` — also unlikely but pin
    //      defensively).
    // The old D3 `non_loopback_host` is GONE under D4.a; tests must
    // NOT carry it forward.
    expect([
      'malformed_url',
      'obfuscated_loopback_disallowed',
      'insecure_remote_http_disallowed',
    ]).toContain(out.reason);
  });

  // ── D4.a Commit 1 — remote acceptance (https + http+dev-flag) ──
  //
  // Coverage strategy:
  //   - https://<remote> always accepted as kind:'remote', insecure:false.
  //   - http://<remote> + allowInsecureRemote:true accepted as
  //     kind:'remote', insecure:true.
  //   - http://<remote> + no flag rejected (covered above).
  //   - loopback always accepts regardless of flag.
  //   - Dev flag MUST NOT widen scheme allowlist, MUST NOT relax
  //     raw-host strict-allowlist defense (Cindy lock).

  function expectRemote(
    input: string,
    options?: { allowInsecureRemote?: boolean },
    expectedInsecure?: boolean,
  ): URL {
    const out = classifyServerUrl(input, options);
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error('unreachable');
    expect(out.kind).toBe('remote');
    if (out.kind !== 'remote') throw new Error('unreachable');
    if (typeof expectedInsecure === 'boolean') {
      expect(out.insecure).toBe(expectedInsecure);
    }
    return out.url;
  }

  describe('D4.a — remote https (no dev flag needed)', () => {
    it('accepts https://api.example.com as remote+secure', () => {
      const u = expectRemote('https://api.example.com', undefined, false);
      expect(u.protocol).toBe('https:');
      expect(u.hostname).toBe('api.example.com');
    });

    it('accepts https://192.168.1.10:8443 as remote+secure (LAN with TLS termination is fine)', () => {
      expectRemote('https://192.168.1.10:8443', undefined, false);
    });

    it('accepts https://mybox.local:8443 as remote+secure (mDNS with mkcert/private CA is fine — TLS verify is system-default at connect)', () => {
      // Cindy round-1 wording: "TLS http exception not for `*.local`".
      // The flip side: https IS allowed for `*.local` because TLS
      // verification happens at connect via the system trust store,
      // not via hostname allowlist.
      expectRemote('https://mybox.local:8443', undefined, false);
    });
  });

  describe('D4.a — remote http with dev flag', () => {
    it('accepts http://api.example.com when allowInsecureRemote:true (kind=remote, insecure=true)', () => {
      const u = expectRemote('http://api.example.com', { allowInsecureRemote: true }, true);
      expect(u.protocol).toBe('http:');
    });

    it('accepts http://10.0.0.5:18080 when allowInsecureRemote:true (dev LAN box without TLS)', () => {
      expectRemote('http://10.0.0.5:18080', { allowInsecureRemote: true }, true);
    });

    it('accepts http://mybox.local:18080 when allowInsecureRemote:true (dev mDNS escape)', () => {
      expectRemote('http://mybox.local:18080', { allowInsecureRemote: true }, true);
    });

    it('still accepts http://localhost when allowInsecureRemote:true (loopback unchanged; insecure flag is irrelevant)', () => {
      const out = classifyServerUrl('http://localhost', { allowInsecureRemote: true });
      expect(out.ok).toBe(true);
      if (out.ok) expect(out.kind).toBe('loopback');
    });

    it('still accepts http://127.0.0.1:18080 when allowInsecureRemote:true (loopback path)', () => {
      const out = classifyServerUrl('http://127.0.0.1:18080', { allowInsecureRemote: true });
      expect(out.ok).toBe(true);
      if (out.ok) expect(out.kind).toBe('loopback');
    });
  });

  describe('D4.a — dev flag scope invariant (Cindy lock 2026-05-28)', () => {
    // The dev flag is for ONE thing: widening non-loopback http
    // acceptance. The four blocks below pin everything it must NOT
    // do, so a future "helpful" refactor can't quietly broaden it.

    it('flag does NOT widen scheme allowlist — ws:// still rejected with flag on', () => {
      const out = classifyServerUrl('ws://api.example.com:8080', { allowInsecureRemote: true });
      expect(out.ok).toBe(false);
      if (out.ok) throw new Error('unreachable');
      expect(out.reason).toBe('unsupported_scheme');
    });

    it('flag does NOT widen scheme allowlist — file:// still rejected with flag on', () => {
      const out = classifyServerUrl('file:///etc/passwd', { allowInsecureRemote: true });
      expect(out.ok).toBe(false);
      if (out.ok) throw new Error('unreachable');
      expect(out.reason).toBe('unsupported_scheme');
    });

    it('flag does NOT bypass userinfo refusal — `http://user@api.example.com` still malformed_url with flag on', () => {
      // Without this guard the flag could let an attacker disguise
      // a non-loopback URL with cosmetic prefix that Bearer-auth
      // header collisions could exploit. Userinfo refusal is in
      // `extractRawAuthorityHost`, before any flag handling.
      const out = classifyServerUrl('http://user@api.example.com', { allowInsecureRemote: true });
      expect(out.ok).toBe(false);
      if (out.ok) throw new Error('unreachable');
      expect(out.reason).toBe('malformed_url');
    });

    it('flag does NOT bypass IPv6 bracket-suffix smuggling refusal — `http://[::1]evil:18080` still malformed_url with flag on', () => {
      const out = classifyServerUrl('http://[::1]evil:18080', { allowInsecureRemote: true });
      expect(out.ok).toBe(false);
      if (out.ok) throw new Error('unreachable');
      expect(out.reason).toBe('malformed_url');
    });

    it('flag does NOT relax loopback strict-allowlist — obfuscated IPv4 (`0x7f000001`) is rejected as obfuscated_loopback_disallowed, NOT classified as remote, with flag on', () => {
      // Load-bearing for the Cindy review of D4.a Commit 1 (round 1):
      // these forms resolve to 127.0.0.1 at the IP layer. Classifying
      // them as `kind: 'remote', insecure: true` under the flag would
      // re-admit the exact regression D3.c's raw-host gate was
      // designed to block — the dev flag is for non-loopback http,
      // NOT for disguised loopback. Outright rejection (regardless
      // of flag) keeps the visible URL form aligned with the host
      // the daemon would actually connect to.
      const out = classifyServerUrl('http://0x7f000001:18080', { allowInsecureRemote: true });
      expect(out.ok).toBe(false);
      if (out.ok) throw new Error('unreachable');
      expect(out.reason).toBe('obfuscated_loopback_disallowed');
      expect(out.message).toContain('0x7f000001');
    });

    it('flag does NOT relax loopback strict-allowlist — dotted-decimal-zeros (`127.000.000.001`) is rejected as obfuscated_loopback_disallowed with flag on', () => {
      const out = classifyServerUrl('http://127.000.000.001:18080', { allowInsecureRemote: true });
      expect(out.ok).toBe(false);
      if (out.ok) throw new Error('unreachable');
      expect(out.reason).toBe('obfuscated_loopback_disallowed');
    });

    it('flag does NOT relax loopback strict-allowlist — expanded IPv6 (`[0:0:0:0:0:0:0:1]`) is rejected as obfuscated_loopback_disallowed with flag on', () => {
      const out = classifyServerUrl('http://[0:0:0:0:0:0:0:1]:18080', {
        allowInsecureRemote: true,
      });
      expect(out.ok).toBe(false);
      if (out.ok) throw new Error('unreachable');
      expect(out.reason).toBe('obfuscated_loopback_disallowed');
    });

    it('absent options object behaves identically to {allowInsecureRemote: false}', () => {
      // The classifier signature has an optional options bag; pin
      // that "no options" and "explicit false" produce identical
      // outcomes so call sites that forget to pass options don't
      // accidentally get the dev-flag behavior.
      const noOpts = classifyServerUrl('http://api.example.com');
      const explicitFalse = classifyServerUrl('http://api.example.com', {
        allowInsecureRemote: false,
      });
      expect(noOpts.ok).toBe(false);
      expect(explicitFalse.ok).toBe(false);
      if (noOpts.ok || explicitFalse.ok) throw new Error('unreachable');
      expect(noOpts.reason).toBe('insecure_remote_http_disallowed');
      expect(explicitFalse.reason).toBe('insecure_remote_http_disallowed');
    });

    it('https with flag on is unchanged from https without flag (flag has zero https-path effect)', () => {
      // Belt-and-braces: pin that toggling the flag does NOT
      // change anything about how https URLs classify. (The TLS
      // verify behavior at connect time is governed by Node's
      // system-default CA — not by this classifier — but pinning
      // the classifier invariant catches a future refactor that
      // tried to gate https acceptance on the flag.)
      const flagOff = classifyServerUrl('https://api.example.com');
      const flagOn = classifyServerUrl('https://api.example.com', { allowInsecureRemote: true });
      expect(flagOff.ok).toBe(true);
      expect(flagOn.ok).toBe(true);
      if (!flagOff.ok || !flagOn.ok) throw new Error('unreachable');
      expect(flagOff.kind).toBe('remote');
      expect(flagOn.kind).toBe('remote');
      if (flagOff.kind !== 'remote' || flagOn.kind !== 'remote') {
        throw new Error('unreachable');
      }
      expect(flagOff.insecure).toBe(false);
      expect(flagOn.insecure).toBe(false);
    });
  });

  describe('D4.a Commit 2 fixup — non_origin_url rejection (Cindy review 2026-05-28)', () => {
    // Contract: the server
    // connection profile is `{ scheme, host, port }` only. The
    // classifier MUST reject any input with non-trivial path / query
    // / fragment, BEFORE branching on loopback / remote, so the
    // wizard (which strips down to origin when fetching
    // `/api/server/info`) cannot test one base while persistence
    // commits another. Applies uniformly: scheme-agnostic,
    // dev-flag-agnostic, loopback / remote / obfuscated paths all
    // reject equally.

    it('accepts empty path (`https://x.example.test`)', () => {
      const out = classifyServerUrl('https://x.example.test');
      expect(out.ok).toBe(true);
    });

    it('accepts trailing slash (`https://x.example.test/`)', () => {
      const out = classifyServerUrl('https://x.example.test/');
      expect(out.ok).toBe(true);
    });

    it('rejects non-trivial pathname (`https://x.example.test/foo`)', () => {
      const msg = expectReject('https://x.example.test/foo', 'non_origin_url');
      expect(msg).toContain('/foo');
      expect(msg).toContain('https://x.example.test');
    });

    it('rejects nested pathname (`https://x.example.test/foo/bar`)', () => {
      expectReject('https://x.example.test/foo/bar', 'non_origin_url');
    });

    it('rejects query (`https://x.example.test?bar=1`)', () => {
      expectReject('https://x.example.test?bar=1', 'non_origin_url');
    });

    it('rejects fragment (`https://x.example.test/#frag`)', () => {
      expectReject('https://x.example.test/#frag', 'non_origin_url');
    });

    it('rejects path + query + fragment combo', () => {
      expectReject('https://x.example.test/api?foo=1#bar', 'non_origin_url');
    });

    it('rejects loopback with path (gate is loopback-agnostic)', () => {
      expectReject('http://127.0.0.1:18080/foo', 'non_origin_url');
    });

    it('rejects loopback with query (gate is loopback-agnostic)', () => {
      expectReject('http://localhost?x=1', 'non_origin_url');
    });

    it('rejects dev-flag insecure-remote with path (gate is flag-agnostic)', () => {
      const out = classifyServerUrl('http://10.0.0.5/foo', {
        allowInsecureRemote: true,
      });
      expect(out.ok).toBe(false);
      if (out.ok) throw new Error('unreachable');
      expect(out.reason).toBe('non_origin_url');
    });

    it('rejects obfuscated-loopback with path — fires before the obfuscated-loopback gate', () => {
      // Order matters: the non_origin check runs BEFORE the
      // obfuscated-loopback check, so an obfuscated input with a path
      // surfaces as non_origin_url rather than
      // obfuscated_loopback_disallowed. Either is a rejection but the
      // first-rule-to-fire deterministic order is the contract we
      // pin so callers can rely on the reason string.
      const out = classifyServerUrl('http://0x7f000001/foo');
      expect(out.ok).toBe(false);
      if (out.ok) throw new Error('unreachable');
      expect(out.reason).toBe('non_origin_url');
    });

    it('rejects unsupported scheme even with a clean path — unsupported_scheme still wins', () => {
      // Conversely, unsupported_scheme is checked BEFORE non_origin
      // because the URL parser may produce surprising
      // path/host pairs for non-http(s) schemes. Pin the precedence.
      const out = classifyServerUrl('ws://x.example.test/foo');
      expect(out.ok).toBe(false);
      if (out.ok) throw new Error('unreachable');
      expect(out.reason).toBe('unsupported_scheme');
    });
  });
});
