/**
 * D4.a Commit 4 — `bind_address_scope` classifier.
 *
 * Backed by `docs/auth-and-host-model.md` §3.2 (Server connection
 * profile):
 *
 *   > On backend boot:
 *   >   - If listen address is non-loopback AND `signup_enabled = true`:
 *   >     `backend-<utc>.log` emits a `WARN` line referencing the
 *   >     runbook lock-down section.
 *   >   - `GET /api/server/info` exposes a structured `bind_address_scope`
 *   >     field (values `{ loopback, lan, public }`) and the existing
 *   >     `signup_enabled` boolean, so desktop and ops tooling can read
 *   >     the combination programmatically.
 *
 * Pure, throw-free, deterministic. The backend boot path uses this to
 * (a) populate the `bind_address_scope` field on `/api/server/info`,
 * and (b) decide whether to emit the WARN log line.
 *
 * Scope discipline: this classifier maps a single hostname / IP
 * literal to one of three buckets. It does NOT resolve DNS,
 * enumerate network interfaces, or talk to the OS. Wildcard binds
 * (`0.0.0.0` / `::`) are classified as `'public'` because the
 * actual reachability depends on what interfaces the OS happens to
 * have at runtime — under-classifying a wildcard would silently
 * suppress the WARN line for the most exposure-risky bind. The
 * conservative direction.
 */

import type { BindAddressScope } from './api/server.js';

/**
 * Loopback literals. Aligned with `LOOPBACK_HOSTNAMES` in
 * `server-url.ts` but kept separate here because the wire-side
 * classifier accepts the WHOLE space of v4 / v6 / DNS hostnames
 * the operator might pass via `SILVERHAND_LISTEN`, not just the
 * narrow set we admit for client-side URL classification. The
 * two surfaces have different threat models — keep them physically
 * separate so changes to one don't accidentally widen the other.
 */
const LOOPBACK_LITERALS = new Set<string>([
  'localhost',
  '127.0.0.1',
  '::1',
  '[::1]',
]);

/**
 * Wildcard / unspecified binds. Treated as `'public'` (see module
 * JSDoc). Both IPv4 `0.0.0.0` and IPv6 `::` map here, with the
 * bracketed `[::]` form because some OS-level config sources
 * surface it that way.
 */
const WILDCARD_LITERALS = new Set<string>([
  '0.0.0.0',
  '::',
  '[::]',
]);

/**
 * Classify a bind hostname / IP literal into one of the three
 * scope buckets surfaced on `/api/server/info`.
 *
 * @param raw The value passed to the HTTP listen call (e.g. from
 * `SILVERHAND_LISTEN`). May be a hostname, an IPv4 literal, or an
 * IPv6 literal with or without brackets. Comparison is
 * case-insensitive on the DNS-style path.
 */
export function classifyBindAddressScope(raw: string): BindAddressScope {
  const lowered = raw.trim().toLowerCase();
  if (lowered === '') {
    // Empty string is most commonly produced by mis-set env defaults.
    // Treat as wildcard — conservative.
    return 'public';
  }
  if (LOOPBACK_LITERALS.has(lowered)) {
    return 'loopback';
  }
  if (WILDCARD_LITERALS.has(lowered)) {
    return 'public';
  }
  // 127.0.0.0/8 — all of 127/8 is loopback per RFC 5735, but our
  // V1 narrow allowlist for URL classification only admits
  // `127.0.0.1`. For the bind-side classifier we accept the wider
  // /8 so an operator binding to `127.0.0.2` (which IS loopback)
  // doesn't get an inappropriate WARN line.
  if (isIpv4InRange(lowered, [127, 0, 0, 0], 8)) return 'loopback';
  // RFC1918 private space.
  if (isIpv4InRange(lowered, [10, 0, 0, 0], 8)) return 'lan';
  if (isIpv4InRange(lowered, [172, 16, 0, 0], 12)) return 'lan';
  if (isIpv4InRange(lowered, [192, 168, 0, 0], 16)) return 'lan';
  // RFC 3927 link-local IPv4 (169.254/16) and RFC 6890 — same
  // bucket as RFC1918: same-LAN reachability but not the public
  // internet.
  if (isIpv4InRange(lowered, [169, 254, 0, 0], 16)) return 'lan';
  // IPv6 link-local fe80::/10 — strip optional brackets first.
  const unbracketed = lowered.startsWith('[') && lowered.endsWith(']')
    ? lowered.slice(1, -1)
    : lowered;
  if (
    unbracketed.startsWith('fe8') ||
    unbracketed.startsWith('fe9') ||
    unbracketed.startsWith('fea') ||
    unbracketed.startsWith('feb')
  ) {
    return 'lan';
  }
  // IPv6 unique-local fc00::/7 — fc.. or fd.. prefix.
  if (unbracketed.startsWith('fc') || unbracketed.startsWith('fd')) {
    return 'lan';
  }
  // mDNS — `*.local` is RFC 6762 local-link multicast DNS. Classify
  // as 'lan' even though formally it's a different namespace —
  // exposure model is "same local network", same bucket.
  if (lowered.endsWith('.local')) {
    return 'lan';
  }
  // Anything else: public IP literal, or a globally resolvable DNS
  // name. Default to 'public' — conservative direction.
  return 'public';
}

/**
 * Parse a dotted-decimal IPv4 string and test whether it falls
 * inside `network/prefixLen`. Strict parser: each octet must be
 * 0..255 with no leading zeros (matches the canonical printable
 * form), four octets exactly. Anything else (e.g. shorthand,
 * hex, decimal) returns `false` — those forms are out of scope
 * for backend bind addresses (HTTP servers don't accept them
 * via `listen({ host })` on Node anyway).
 */
function isIpv4InRange(
  input: string,
  network: [number, number, number, number],
  prefixLen: number,
): boolean {
  const parts = input.split('.');
  if (parts.length !== 4) return false;
  const octets: number[] = [];
  for (const p of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(p)) return false;
    const n = Number.parseInt(p, 10);
    if (n < 0 || n > 255) return false;
    octets.push(n);
  }
  const ip = (octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!;
  const net = (network[0] << 24) | (network[1] << 16) | (network[2] << 8) | network[3];
  const mask = prefixLen === 0 ? 0 : (~0 << (32 - prefixLen)) >>> 0;
  return ((ip >>> 0) & mask) === ((net >>> 0) & mask);
}
