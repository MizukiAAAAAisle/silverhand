/**
 * `@silverhand/shared` — server URL classification primitive used by
 * desktop renderer, desktop main, host daemon, and backend.
 *
 * V1 SCOPE: the only acceptable backend deployment is **loopback**
 * (the embedded backend that ships with Electron). Remote backend
 * support is gated to V1.1. This module owns the single source of
 * truth for "is this server URL acceptable in V1?".
 *
 * Why a shared module:
 *   - Renderer Settings UI needs to disable the Save button when the
 *     user enters a non-loopback URL (UX).
 *   - Desktop main IPC handler needs to re-validate the URL it
 *     receives from the renderer — never trust renderer input
 *     (security boundary).
 *   - Daemon outbound client needs to reject non-loopback http://
 *     URLs at the WS resolution step (Stage D2.f fail-closed).
 *   - All three MUST agree, or the user sees "I clicked Save and it
 *     looked accepted, then the daemon errored out". The drift
 *     this module exists to prevent (per Cindy D3.c lock C).
 *
 * What this module does NOT do:
 *   - It doesn't decide V1.1's remote-backend acceptance policy.
 *     When remote backend support lands, extend the result to
 *     `kind: 'remote'` and add the relevant trust/TLS checks there.
 *   - It doesn't authenticate or probe the URL — purely structural
 *     classification.
 *   - It doesn't normalize trailing slashes / port defaults
 *     beyond what `URL` does (we return the parsed `URL` object
 *     so callers can read .href / .hostname / .port as needed).
 */

/**
 * The four hostname literals we treat as loopback in V1. Kept as a
 * tiny exact-match allowlist; the check happens against the **raw
 * authority host** extracted from the URL input string, NOT against
 * `URL.hostname` — see {@link extractRawAuthorityHost} for the
 * rationale (Cindy `#task:631` D3.c P1).
 *
 * `[::1]` appears alongside `::1` because different call sites may
 * carry the bracketed or unbracketed IPv6 literal:
 *   - Raw authority host from `http://[::1]:1234` is `[::1]`
 *     (brackets included — that IS the literal the user wrote).
 *   - Node's `URL.hostname` for the same input is also `[::1]`
 *     (Node keeps the brackets), but other URL parsers/runtimes
 *     may strip them. The dual entry insulates downstream callers
 *     of `isLoopbackHost(hostname)` from that variance.
 *
 * Deliberately excluded:
 *   - `0.0.0.0`: not a routable destination; some platforms map it
 *     to localhost but the daemon should not connect to it.
 *   - `127.0.0.2` etc: technically 127.0.0.0/8 is all loopback,
 *     but allowing only the canonical `127.0.0.1` keeps the V1
 *     surface narrow and the V1.1 transition simpler.
 *   - DNS aliases like `mybox.local`: even if they resolve to a
 *     loopback IP, accepting them muddles "loopback in V1" with
 *     "trust the local DNS resolver" and opens a door for
 *     misconfiguration.
 *   - Numeric obfuscations of `127.0.0.1` (`127.000.000.001`,
 *     `0177.0.0.1`, `2130706433`, `0x7f000001`) and expanded
 *     IPv6 (`[0:0:0:0:0:0:0:1]`): `URL.hostname` would normalize
 *     these into the allowlist literals; comparing against the
 *     raw authority host blocks them at the policy gate.
 */
const LOOPBACK_HOSTNAMES = new Set<string>([
  'localhost',
  '127.0.0.1',
  '::1',
  '[::1]',
]);

/**
 * Pure host classification. Lowercases before comparing because the
 * canonical loopback `localhost` is DNS-style (case-insensitive)
 * and IP literals don't change under casing.
 *
 * Callers that already hold a hostname string (e.g. from
 * `URL.hostname`) can use this directly. Callers that have a raw
 * URL string MUST use {@link classifyServerUrl} instead — that
 * routes through {@link extractRawAuthorityHost} so numeric /
 * obfuscated forms that `URL.hostname` would normalize are still
 * rejected at the policy gate.
 *
 * Replaces the previous private `isLoopbackHost` in
 * `packages/host/src/daemon/outbound-client.ts`.
 */
export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());
}

/**
 * Extract the **literal** authority host text from a raw URL
 * input string. Used by {@link classifyServerUrl} to enforce
 * "exact allowlist" semantics that `URL.hostname` would otherwise
 * defeat by normalizing obfuscated IP forms.
 *
 * Examples — all of these have `URL(input).hostname === '127.0.0.1'`
 * but `extractRawAuthorityHost(input) === '127.000.000.001'` (etc.):
 *   - `http://127.000.000.001:18080`  (dotted-decimal with leading
 *                                       zeros)
 *   - `http://0177.0.0.1:18080`       (octal first octet)
 *   - `http://2130706433:18080`       (single 32-bit decimal)
 *   - `http://0x7f000001:18080`       (single 32-bit hex)
 * Similarly `URL('http://[0:0:0:0:0:0:0:1]').hostname === '[::1]'`
 * but the raw authority is `[0:0:0:0:0:0:0:1]` — the V1 policy
 * rejects the expanded form because allowing it would muddle the
 * "literal allowlist" lock with "URL parser semantic equivalence".
 *
 * Grammar followed (RFC 3986 authority subset, enough for our
 * scheme allowlist of http/https):
 *
 *     authority  = [ userinfo "@" ] host [ ":" port ]
 *     host       = IP-literal / IPv4address / reg-name
 *     IP-literal = "[" IPv6address "]"
 *
 * Algorithm: cut input at `://` (scheme separator), then at first
 * `/`, `?`, or `#` (path/query/fragment), then drop everything up
 * to and including the last `@` (userinfo), then strip the port
 * with IPv6 bracket awareness.
 *
 * Returns `null` if the input doesn't look like an authority-form
 * URL (no `://`, mid-string `]` without leading `[`, etc.); the
 * caller falls back to a `malformed_url` rejection in that case.
 */
export function extractRawAuthorityHost(input: string): string | null {
  const schemeIdx = input.indexOf('://');
  if (schemeIdx < 0) return null;
  let rest = input.slice(schemeIdx + 3);
  // Trim at path/query/fragment boundary so we don't pick up
  // `/api` or `?foo=bar` as part of the host.
  const pathIdx = rest.search(/[/?#]/);
  if (pathIdx >= 0) rest = rest.slice(0, pathIdx);
  // Userinfo: `user:pass@host` — drop everything up to and
  // including the LAST `@` (raw passwords can in theory contain
  // `@`, though we don't accept userinfo in V1 anyway).
  const atIdx = rest.lastIndexOf('@');
  if (atIdx >= 0) rest = rest.slice(atIdx + 1);
  // IPv6 literal: `[...]` optionally followed by `:port`. The
  // host text is the bracketed portion INCLUDING the brackets —
  // matches the allowlist's `[::1]` entry literally.
  if (rest.startsWith('[')) {
    const bracketEnd = rest.indexOf(']');
    if (bracketEnd < 0) return null;
    return rest.slice(0, bracketEnd + 1);
  }
  // IPv4 / reg-name: port is the optional `:N` suffix. A `:` that
  // appears here MUST be the port separator (we already handled
  // the IPv6 bracketed case above). Splitting on the LAST `:`
  // would also work; FIRST is more conservative.
  const colonIdx = rest.indexOf(':');
  if (colonIdx >= 0) rest = rest.slice(0, colonIdx);
  return rest;
}

/**
 * Why this is a discriminated union rather than a boolean:
 * different rejection reasons surface different UI messages
 * ("Remote backend coming in V1.1" vs "Use http:// or https://")
 * and the renderer / main / daemon all benefit from a typed
 * `reason` they can branch on without parsing strings.
 *
 * On the `ok: true` path we also hand back the parsed `URL` so
 * callers don't have to re-parse it (and so the structural
 * normalization — e.g. default port stripping — is shared).
 */
export type ServerUrlClassification =
  | { ok: true; kind: 'loopback'; url: URL }
  | {
      ok: false;
      reason: ServerUrlRejectionReason;
      /** Human-readable message safe to surface to logs. Renderer
       *  may use its own i18n string keyed off `reason` instead. */
      message: string;
    };

export type ServerUrlRejectionReason =
  /** `URL` constructor threw (empty, garbage, missing scheme). */
  | 'malformed_url'
  /** Not http: or https: (rejects ws://, file://, ftp://, etc.). */
  | 'unsupported_scheme'
  /** Hostname is not in the V1 loopback allowlist. Covers LAN
   *  IPs, public DNS names, `0.0.0.0`, non-canonical loopback
   *  literals — anything that isn't a literal entry of
   *  {@link isLoopbackHost}. The V1 message points the user at
   *  V1.1 for remote backend support. */
  | 'non_loopback_host';

/**
 * Classify a raw server URL string against the V1 acceptance
 * policy. Pure, throw-free; the result is data the caller can
 * branch on. Callers that need to convert to a WS URL should still
 * go through the daemon's `hostConnectWebSocketUrl` so the
 * http→ws / https→wss transformation stays in one place.
 *
 * Returning `kind: 'loopback'` (rather than a bare `true`) leaves
 * room for V1.1 to add `kind: 'remote'` without breaking the
 * signature — callers will get a typecheck failure when remote
 * backend acceptance lands and they need to think about whether
 * "loopback OR remote" is acceptable for their call site.
 *
 * Strict-allowlist contract (Cindy `#task:631` D3.c P1): the
 * loopback check runs against the **raw authority host** from
 * the input string, NOT against `URL.hostname`. The URL parser
 * would otherwise normalize numeric obfuscations
 * (`127.000.000.001` / `0177.0.0.1` / `2130706433` /
 * `0x7f000001`) and expanded IPv6 (`[0:0:0:0:0:0:0:1]`) into
 * the canonical allowlist literals — accepting those would
 * widen the V1 policy past what the user-facing docs and
 * Settings UI claim. The `URL` constructor is still invoked
 * because it gives us the cheapest scheme validation and the
 * normalized URL object the caller wants to consume on the
 * success path.
 */
export function classifyServerUrl(input: string): ServerUrlClassification {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch (err) {
    return {
      ok: false,
      reason: 'malformed_url',
      message:
        err instanceof Error
          ? `Invalid URL: ${err.message}`
          : 'Invalid URL',
    };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      ok: false,
      reason: 'unsupported_scheme',
      message: `Unsupported scheme '${parsed.protocol}'. Use http:// or https://.`,
    };
  }
  const rawHost = extractRawAuthorityHost(input);
  // `parsed` succeeded for `http://` / `https://`, so the raw
  // extractor should also have found an authority host. A null
  // here would mean the input slipped past both layers — surface
  // it as malformed rather than silently accepting it.
  if (rawHost === null) {
    return {
      ok: false,
      reason: 'malformed_url',
      message: 'Could not extract authority host from URL',
    };
  }
  if (!isLoopbackHost(rawHost)) {
    return {
      ok: false,
      reason: 'non_loopback_host',
      // Surface the RAW host as written so the user can see
      // exactly which token failed the allowlist — important for
      // the obfuscated-IP cases where `parsed.hostname` would
      // misleadingly show the normalized canonical form.
      message:
        `Backend host '${rawHost}' is not a loopback address. ` +
        `Remote backend support is coming in V1.1.`,
    };
  }
  return { ok: true, kind: 'loopback', url: parsed };
}
