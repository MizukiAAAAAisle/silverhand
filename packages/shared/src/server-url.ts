/**
 * `@silverhand/shared` — server URL classification primitive used by
 * desktop renderer, desktop main, host daemon, and backend.
 *
 * V1 SCOPE (D4.a Commit 1):
 *   - **loopback http/https** is always accepted (the embedded backend
 *     case from D3 and Wizard local-server case).
 *   - **remote https** is accepted as `kind: 'remote', insecure: false`.
 *     TLS verification at connect time is the **system-default** Node
 *     pipeline — this classifier does NOT verify certificates, parse
 *     CA chains, or pin anything. The typed surface lives in
 *     `tls-policy.ts`.
 *   - **remote http** is accepted as `kind: 'remote', insecure: true`
 *     ONLY when the caller passes `allowInsecureRemote: true` (read
 *     from the dev env flag `SILVERHAND_ALLOW_INSECURE_REMOTE=1`).
 *     Without the flag, remote http is rejected as
 *     `insecure_remote_http_disallowed`.
 *
 * Raw-host strict-allowlist contract preserved from D3.c (Cindy
 * `#task:631`) and tightened in D4.a Commit 1 review (Cindy
 * 2026-05-28): the loopback check runs against the **raw authority
 * host** extracted from the input string, NOT against `URL.hostname`.
 * Obfuscated forms (`http://0x7f000001`, `http://127.000.000.001`,
 * `http://[0:0:0:0:0:0:0:1]`) parse to canonical loopback under
 * `new URL(...)` — their raw authority is not in the allowlist, AND
 * the URL parser would resolve them to a loopback IP, so they are
 * **rejected outright** as `obfuscated_loopback_disallowed`
 * regardless of scheme and regardless of the `allowInsecureRemote`
 * dev flag. Userinfo (`user@host`) and IPv6 bracket-suffix smuggling
 * (`[::1]evil`) are still rejected outright by
 * {@link extractRawAuthorityHost} regardless of flag.
 *
 * Why a shared module:
 *   - Renderer Settings / Setup Wizard needs to enable/disable Save
 *     based on classification (UX).
 *   - Desktop main IPC handler needs to re-validate the URL it
 *     receives from the renderer — never trust renderer input
 *     (security boundary).
 *   - Daemon outbound client needs to gate the WS resolution step.
 *   - All hops MUST agree, or the user sees "I clicked Save and it
 *     looked accepted, then the daemon errored out" (the drift this
 *     module exists to prevent — Cindy D3.c lock C).
 *
 * What this module does NOT do:
 *   - It does NOT authenticate or probe the URL — purely structural.
 *   - It does NOT verify TLS certificates — that lives in the Node
 *     TLS layer; this module just decides whether the URL shape is
 *     acceptable.
 *   - It does NOT normalize trailing slashes / port defaults beyond
 *     what `URL` does (we return the parsed `URL` so callers can
 *     read `.href` / `.hostname` / `.port` directly).
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
 * `/`, `?`, or `#` (path/query/fragment), then **refuse userinfo
 * entirely** (any `@` in the authority slice → null), then strip
 * the port with IPv6 bracket awareness.
 *
 * Userinfo refusal (Cindy `#task:631` D3.c P1 round 2): the
 * earlier draft silently dropped `user[:pass]@` and continued
 * classifying the trailing host. That bypassed the allowlist gate
 * because `http://api.example.com@localhost:18080` would extract
 * to `localhost` and pass — even though the **WHOLE URL** the user
 * provided carries an attacker-controlled cosmetic prefix (and the
 * URL constructor's success-path `.toString()` would propagate it
 * into the wsUrl we hand to the daemon, where `ws://`'s Basic-auth
 * userinfo interpretation could collide with our Bearer auth
 * header). V1 has no use case for HTTP basic-auth on the backend
 * URL, so we refuse the construct entirely. Classifier surfaces
 * this as `malformed_url` (reused on purpose to avoid expanding
 * the UI rejection-reason surface for this edge case).
 *
 * Returns `null` if the input doesn't look like an authority-form
 * URL (no `://`, mid-string `]` without leading `[`, userinfo
 * present, etc.); the caller falls back to a `malformed_url`
 * rejection in that case.
 */
export function extractRawAuthorityHost(input: string): string | null {
  const schemeIdx = input.indexOf('://');
  if (schemeIdx < 0) return null;
  let rest = input.slice(schemeIdx + 3);
  // Trim at path/query/fragment boundary so we don't pick up
  // `/api` or `?foo=bar` as part of the host. (Also so a `@` in a
  // query string or fragment doesn't trigger the userinfo refusal
  // below.)
  const pathIdx = rest.search(/[/?#]/);
  if (pathIdx >= 0) rest = rest.slice(0, pathIdx);
  // Userinfo refusal: any `@` here is part of `[userinfo "@"]`
  // (path/query/fragment were already stripped). V1 does not accept
  // URL credentials on the backend URL — return null so the caller
  // rejects as `malformed_url`. Do NOT try to "be helpful" by
  // dropping the userinfo and continuing; that silently widened the
  // policy in the previous draft.
  if (rest.includes('@')) return null;
  // IPv6 literal: `[...]` optionally followed by `:port`. The
  // host text is the bracketed portion INCLUDING the brackets —
  // matches the allowlist's `[::1]` entry literally.
  if (rest.startsWith('[')) {
    const bracketEnd = rest.indexOf(']');
    if (bracketEnd < 0) return null;
    // IPv6 bracket suffix validation (Cindy `#task:631` D3.c P1
    // round 3): the authority grammar permits ONLY an empty tail
    // or `:port` after the closing bracket. Inputs like
    // `http://[::1]evil:18080` are rejected here because the
    // extractor's contract is "raw authority host per RFC 3986",
    // not "whatever survives URL parsing". Without this check the
    // helper would return `[::1]` (allowlist hit!) for the `]evil`
    // suffix case and we'd rely on `new URL()` to reject — which
    // is a brittle two-layer dependency we explicitly don't want.
    const suffix = rest.slice(bracketEnd + 1);
    if (suffix !== '' && !/^:\d*$/.test(suffix)) return null;
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
 * different acceptance kinds and rejection reasons surface different
 * UI messages (loopback vs remote, http vs https, with/without dev
 * flag) and the renderer / main / daemon all benefit from a typed
 * variant they can branch on without parsing strings.
 *
 * On the `ok: true` path we also hand back the parsed `URL` so
 * callers don't have to re-parse it (and so the structural
 * normalization — e.g. default port stripping — is shared).
 *
 * Discriminator semantics:
 *   - `kind: 'loopback'` — raw authority host is in the V1 loopback
 *     allowlist (`localhost` / `127.0.0.1` / `::1` / `[::1]`).
 *   - `kind: 'remote', insecure: false` — non-loopback over https://.
 *     TLS verification will be Node's system-default at connect time.
 *   - `kind: 'remote', insecure: true` — non-loopback over http://
 *     accepted ONLY because the caller passed `allowInsecureRemote`
 *     (i.e. the dev env flag was set). Callers SHOULD surface a
 *     "connection is unencrypted" warning in any UI that consumes
 *     this variant.
 */
export type ServerUrlClassification =
  | { ok: true; kind: 'loopback'; url: URL }
  | { ok: true; kind: 'remote'; url: URL; insecure: boolean }
  | {
      ok: false;
      reason: ServerUrlRejectionReason;
      /** Human-readable message safe to surface to logs. Renderer
       *  may use its own i18n string keyed off `reason` instead. */
      message: string;
    };

export type ServerUrlRejectionReason =
  /** `URL` constructor threw (empty, garbage, missing scheme). Also
   *  used for the userinfo-refusal and IPv6-bracket-suffix-smuggling
   *  cases — see {@link extractRawAuthorityHost} (reused on purpose
   *  to avoid expanding the UI rejection-reason surface). */
  | 'malformed_url'
  /** Not http: or https: (rejects ws://, file://, ftp://, etc.).
   *  The dev `allowInsecureRemote` flag does NOT widen this — only
   *  http / https are ever acceptable schemes. */
  | 'unsupported_scheme'
  /** Non-loopback host over http://, and the caller did NOT pass
   *  `allowInsecureRemote: true` (i.e.
   *  `SILVERHAND_ALLOW_INSECURE_REMOTE=1` is not set). Use https://
   *  for production, or set the dev env flag for unencrypted dev
   *  scaffolding (`http://10.0.0.5`, `http://mybox.local`, etc.). */
  | 'insecure_remote_http_disallowed'
  /** Raw authority host is not a literal loopback allowlist entry,
   *  but `URL.hostname` normalizes to one (`http://0x7f000001`,
   *  `http://127.000.000.001`, `http://[0:0:0:0:0:0:0:1]`, etc.).
   *  These would resolve to loopback at the IP layer but the
   *  classifier refuses them outright — regardless of scheme,
   *  regardless of the `allowInsecureRemote` dev flag — so the
   *  policy never accepts a URL whose visible form disagrees with
   *  the host it would actually connect to (Cindy review of D4.a
   *  Commit 1: dev flag must not let obfuscated loopback forms
   *  flow into accepted input). The strict-loopback allowlist gate
   *  is positive-only; this obfuscated-form gate is the negative
   *  half of the same invariant. */
  | 'obfuscated_loopback_disallowed';

/**
 * Options for {@link classifyServerUrl}.
 */
export interface ClassifyServerUrlOptions {
  /**
   * When true, accept non-loopback http:// URLs as
   * `{ kind: 'remote', insecure: true }`. Default false.
   *
   * Scope (Cindy D4.a Commit 1 invariant): this flag ONLY widens the
   * non-loopback http acceptance path. It does NOT:
   *   - relax TLS verification on https:// URLs (those still go
   *     through Node's system-default CA pipeline at connect time),
   *   - widen the scheme allowlist (ws/wss/file/ftp still rejected),
   *   - affect the loopback http path (which never needs it),
   *   - change raw-host strict-allowlist behavior (obfuscated forms,
   *     userinfo, IPv6 bracket-suffix smuggling still rejected /
   *     classified as remote, never loopback).
   *
   * Callers are expected to derive this from the dev env flag
   * `SILVERHAND_ALLOW_INSECURE_REMOTE=1` via
   * {@link readAllowInsecureRemoteFlag} (`./config.ts`). The flag
   * value MUST NOT be persisted into the server connection profile
   * (would create profile↔runtime drift if the env toggled).
   */
  allowInsecureRemote?: boolean;
}

/**
 * Classify a raw server URL string against the D4.a acceptance
 * policy. Pure, throw-free; the result is data the caller branches
 * on. Callers that need to convert to a WS URL should still go
 * through the daemon's `hostConnectWebSocketUrl` so the
 * http→ws / https→wss transformation stays in one place.
 *
 * Strict-allowlist contract preserved from D3.c (Cindy `#task:631`)
 * and tightened in D4.a Commit 1 review (Cindy 2026-05-28): the
 * loopback check runs against the **raw authority host** from the
 * input string, NOT against `URL.hostname`. The URL parser would
 * otherwise normalize numeric obfuscations (`127.000.000.001` /
 * `0177.0.0.1` / `2130706433` / `0x7f000001`) and expanded IPv6
 * (`[0:0:0:0:0:0:0:1]`) into the canonical allowlist literals —
 * accepting those AS LOOPBACK would silently widen the policy past
 * what the Wizard/Settings UI claims, AND classifying them as
 * `kind: 'remote'` would still resolve to loopback at the IP layer
 * (re-admitting the regression). Under D4.a those obfuscated inputs
 * are **rejected outright** as `obfuscated_loopback_disallowed`,
 * regardless of scheme and regardless of the `allowInsecureRemote`
 * dev flag. The dev flag's only effect is on non-loopback http
 * acceptance — never on the loopback classification path.
 *
 * The `URL` constructor is still invoked because it gives us the
 * cheapest scheme validation and the normalized URL object the
 * caller wants to consume on the success path.
 */
export function classifyServerUrl(
  input: string,
  options?: ClassifyServerUrlOptions,
): ServerUrlClassification {
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
  // here means either (a) the input slipped past both layers, or
  // (b) the authority included userinfo (`user[:pass]@host`) or
  // an IPv6 bracket suffix (`[::1]evil`) — both refused outright
  // by the extractor. Surface as `malformed_url` (intentionally
  // reusing the existing reason rather than minting a
  // `userinfo_present` / `ipv6_suffix` reason — the UI doesn't
  // need a new branch for these typo / hostile-prefix cases).
  if (rawHost === null) {
    // Detect userinfo specifically so the surfaced message is
    // actionable. The detection mirrors the helper's algorithm
    // (post-`://`, pre-path/query/fragment) but only cares whether
    // an `@` is present, not where.
    const afterScheme = input.slice(input.indexOf('://') + 3);
    const beforePath = afterScheme.replace(/[/?#].*$/, '');
    const message = beforePath.includes('@')
      ? 'URL credentials (user@host) are not accepted'
      : 'Could not extract authority host from URL';
    return { ok: false, reason: 'malformed_url', message };
  }
  if (isLoopbackHost(rawHost)) {
    // Loopback path: scheme doesn't matter (both http and https
    // accepted), `allowInsecureRemote` doesn't matter (loopback http
    // is always accepted). This is the embedded-backend and
    // local-dev case.
    return { ok: true, kind: 'loopback', url: parsed };
  }
  // Obfuscated-loopback gate (Cindy D4.a Commit 1 review): if the
  // raw authority host is NOT in the literal loopback allowlist but
  // the URL parser's normalized hostname IS, the user typed an
  // obfuscated loopback form (`http://0x7f000001`,
  // `http://127.000.000.001`, `http://[0:0:0:0:0:0:0:1]`, etc.).
  // These would resolve to loopback at the IP layer regardless of
  // scheme, so accepting them as `kind: 'remote'` even under the
  // dev flag would silently re-admit the exact regression the D3.c
  // raw-host gate was designed to block. Refuse outright — scheme
  // and flag are ignored on this branch — and route through a
  // dedicated reason so UI / logs can distinguish "you typed a
  // disguised loopback form" from "you typed garbage" or "you
  // typed a non-loopback URL we want over https".
  if (isLoopbackHost(parsed.hostname)) {
    return {
      ok: false,
      reason: 'obfuscated_loopback_disallowed',
      // Surface the RAW host so the operator sees the disguised
      // form they actually typed. Resist normalizing this message
      // to the canonical `127.0.0.1` — the entire point of the
      // gate is to point at the literal text that triggered it.
      message:
        `Backend host '${rawHost}' is a disguised loopback form ` +
        `(URL parser would resolve it to '${parsed.hostname}'). ` +
        `Use a literal loopback address (127.0.0.1 / localhost / [::1]) ` +
        `if loopback is intended, or a non-loopback hostname for remote.`,
    };
  }
  // Non-loopback host. Scheme decides what's required:
  //   - https: always accepted; system-default TLS verifies at connect.
  //   - http: accepted ONLY with `allowInsecureRemote`. Without the
  //     flag, surface a typed rejection that points the operator at
  //     the two valid escape routes (use https, or set the dev env).
  if (parsed.protocol === 'https:') {
    return { ok: true, kind: 'remote', url: parsed, insecure: false };
  }
  if (options?.allowInsecureRemote === true) {
    return { ok: true, kind: 'remote', url: parsed, insecure: true };
  }
  return {
    ok: false,
    reason: 'insecure_remote_http_disallowed',
    // Surface the RAW host as written so the operator can see
    // exactly which token they typed — same rationale as the D3.c
    // obfuscated-IP messages.
    message:
      `Backend host '${rawHost}' is non-loopback over http://. ` +
      `Use https://, or set SILVERHAND_ALLOW_INSECURE_REMOTE=1 for dev use.`,
  };
}
