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
 * tiny allowlist rather than a numeric subnet check (127.0.0.0/8)
 * to keep behavior identical across Node / browser / strict
 * URL.hostname normalization. `[::1]` appears in two forms because
 * `URL.hostname` strips the brackets when parsing `http://[::1]`
 * (`hostname === '::1'`) but some upstream inputs may carry them.
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
 */
const LOOPBACK_HOSTNAMES = new Set<string>([
  'localhost',
  '127.0.0.1',
  '::1',
  '[::1]',
]);

/**
 * Pure host classification. Lowercases before comparing because
 * URL.hostname is case-insensitive but inputs from
 * settings / config files may not be normalized yet.
 *
 * Replaces the previous private `isLoopbackHost` in
 * `packages/host/src/daemon/outbound-client.ts` — that one is now
 * a thin re-export so the V1 loopback allowlist lives in exactly
 * one place.
 */
export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());
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
  if (!isLoopbackHost(parsed.hostname)) {
    return {
      ok: false,
      reason: 'non_loopback_host',
      message:
        `Backend host '${parsed.hostname}' is not a loopback address. ` +
        `Remote backend support is coming in V1.1.`,
    };
  }
  return { ok: true, kind: 'loopback', url: parsed };
}
