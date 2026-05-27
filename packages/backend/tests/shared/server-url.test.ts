/**
 * D3.c Commit 1 — single-source-of-truth tests for the V1 server URL
 * acceptance policy that ships in `@silverhand/shared`.
 *
 * Why these tests live in the backend test runner:
 *   - `@silverhand/shared` is a host-agnostic types/utility package
 *     that ships no test config of its own.
 *   - The backend already imports from `@silverhand/shared` so its
 *     `vitest` config + better-sqlite3 ABI swap dance happens to be
 *     the convenient runner. The classifier itself has zero backend
 *     dependencies; this file is a *unit* test against the shared
 *     module, not a backend integration test.
 *
 * Coverage strategy:
 *   1. Every accepted loopback hostname variant + case normalization.
 *   2. Every rejection reason has at least one positive example.
 *   3. Boundary inputs that frequently break naive
 *      "if hostname starts with 127" implementations
 *      (`127.0.0.2`, `0.0.0.0`, IPv6 short forms, DNS aliases that
 *      *resolve* to loopback but should still be rejected).
 *   4. `kind: 'loopback'` discriminant + URL passthrough.
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
  it.each([
    'localhost',
    '127.0.0.1',
    '::1',
    '[::1]',
  ])('accepts canonical loopback literal: %s', host => {
    expect(isLoopbackHost(host)).toBe(true);
  });

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
    '10.0.0.1',           // RFC 1918 private
    '172.16.5.4',         // RFC 1918 private
    '192.168.1.1',        // RFC 1918 private
    '169.254.10.10',      // link-local
    '8.8.8.8',            // public
    'example.com',        // public DNS
    'mybox.local',        // mDNS — could resolve to loopback but
                          // accepting it would muddle "loopback" with
                          // "trust local DNS resolver".
    '',                   // empty
  ])('rejects non-loopback hostname: %s', host => {
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

  it('accepts https://localhost (remote backend won\'t happen in V1, but TLS-to-loopback is structurally valid)', () => {
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

  it('rejects non-loopback hostnames (the V1.1 banner case)', () => {
    const msg = expectReject('http://api.example.com', 'non_loopback_host');
    // The message points the user at V1.1, which the Settings UI
    // surfaces as the "Remote backend coming in V1.1" banner.
    expect(msg).toMatch(/V1\.1/);
  });

  it('rejects LAN IP — the most common typo when someone copies their dev box IP', () => {
    expectReject('http://192.168.1.10:18080', 'non_loopback_host');
    expectReject('http://10.0.0.5:18080', 'non_loopback_host');
  });

  it('rejects 0.0.0.0 (some platforms accept it as bind-all but we must not connect to it)', () => {
    expectReject('http://0.0.0.0:18080', 'non_loopback_host');
  });

  it('rejects mybox.local (mDNS alias that could resolve to loopback but is not in the allowlist)', () => {
    // Pinning this case is the load-bearing test for the strict
    // "literal allowlist, not DNS resolution" policy.
    expectReject('http://mybox.local:18080', 'non_loopback_host');
  });

  it('rejects 127.0.0.2 even though it is loopback in the RFC sense', () => {
    expectReject('http://127.0.0.2:18080', 'non_loopback_host');
  });

  // ── Obfuscated IP forms (Cindy `#task:631` D3.c P1) ────────────
  //
  // Strict-allowlist regression coverage. All five of these inputs
  // have `new URL(input).hostname === '127.0.0.1'` (IPv4 cases) or
  // `=== '[::1]'` (IPv6 case) because `URL` normalizes them — so a
  // naive `isLoopbackHost(url.hostname)` check would accept them
  // and silently widen the V1 policy past what Settings UI claims.
  // The classifier compares against the RAW authority host instead,
  // which preserves the literal form the user wrote and falls
  // outside the allowlist.

  it('rejects dotted-decimal with leading zeros (`127.000.000.001`) — URL.hostname normalizes to 127.0.0.1', () => {
    const msg = expectReject('http://127.000.000.001:18080', 'non_loopback_host');
    // Message must surface the RAW host as written so the user can
    // see exactly which token failed the allowlist — comparing
    // against the URL-normalized canonical `127.0.0.1` would be
    // confusing here ("but I typed 127.000.000.001!").
    expect(msg).toContain('127.000.000.001');
  });

  it('rejects octal first octet (`0177.0.0.1`) — URL.hostname normalizes to 127.0.0.1', () => {
    const msg = expectReject('http://0177.0.0.1:18080', 'non_loopback_host');
    expect(msg).toContain('0177.0.0.1');
  });

  it('rejects 32-bit decimal IPv4 (`2130706433` = 0x7f000001) — URL.hostname normalizes to 127.0.0.1', () => {
    const msg = expectReject('http://2130706433:18080', 'non_loopback_host');
    expect(msg).toContain('2130706433');
  });

  it('rejects 32-bit hex IPv4 (`0x7f000001`) — URL.hostname normalizes to 127.0.0.1', () => {
    const msg = expectReject('http://0x7f000001:18080', 'non_loopback_host');
    expect(msg).toContain('0x7f000001');
  });

  it('rejects expanded IPv6 (`[0:0:0:0:0:0:0:1]`) — URL.hostname normalizes to [::1]', () => {
    // Pin the IPv6 branch of the obfuscation defense: the expanded
    // form is semantically equivalent to `::1` but the V1 policy
    // accepts ONLY the literal allowlist entries. Comparing against
    // the raw authority host (`[0:0:0:0:0:0:0:1]`) rejects it.
    const msg = expectReject(
      'http://[0:0:0:0:0:0:0:1]:18080',
      'non_loopback_host',
    );
    expect(msg).toContain('[0:0:0:0:0:0:0:1]');
  });

  // ── Discriminator hygiene ──────────────────────────────────────

  it('the success arm carries kind:"loopback" so V1.1 can add kind:"remote" without breaking callers', () => {
    // Pin the discriminant; future remote-backend acceptance will
    // either widen the union to `'loopback' | 'remote'` or add a
    // separate `classifyRemoteServerUrl` — either way, callers that
    // strictly check `kind === 'loopback'` here MUST be revisited.
    const out = classifyServerUrl('http://localhost:18080');
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.kind).toBe('loopback');
  });
});
