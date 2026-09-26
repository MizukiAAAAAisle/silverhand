/**
 * `@silverhand/shared` — typed TLS error mapping primitive.
 *
 * Outbound TLS policy: `docs/auth-and-host-model.md` §1.2.
 *
 * SCOPE LOCK (Cindy review + shiki ack 2026-05-28):
 *   - We do NOT write a custom certificate verifier.
 *   - We do NOT parse / pin certificates.
 *   - We do NOT touch the trust store.
 *   - https requests rely **entirely** on Node/Electron's system-default
 *     CA verification pipeline. This module ONLY post-processes the
 *     errors that pipeline produces, mapping `error.code` (and its
 *     `cause` chain) into a closed set of 3 typed product codes so
 *     UI / logs / runbooks have a stable surface.
 *   - The unverified-TLS bypass (the `rejectUnauthorized` option set to
 *     `false`) is banned in production paths — enforced by a separate
 *     grep gate test, NOT by anything in this module.
 *
 * Why this module exists at all (vs. just throwing the raw error):
 *   - Wizard / Settings UI needs to render different copy for
 *     "your cert chain isn't trusted" vs. "your hostname doesn't match
 *     the cert" vs. "the cert expired" — operator triage is faster
 *     when the typed code is stable.
 *   - Operator runbooks (§12) cite the 3 typed codes; the runbook is
 *     the contract, the wrapper is the implementation.
 *
 * What this module is NOT:
 *   - It does NOT classify network errors (ECONNREFUSED / ENOTFOUND /
 *     ETIMEDOUT / etc). Returns `null` for those — the caller surfaces
 *     them via its own typed code (e.g. `host_unreachable`).
 *   - It does NOT classify auth errors (401 / 403). Those are HTTP-layer
 *     post-handshake; this module only fires when TLS handshake itself
 *     failed before HTTP started.
 */

/**
 * Closed set of typed TLS failure categories. Aligned with the
 * d4-design contract §8.2.
 *
 * Fallback rule (Cindy round-3 lock): a TLS-class error that isn't
 * recognized as expired / hostname-mismatch maps to
 * `host_tls_chain_invalid` — NOT a generic `network_error`. Every
 * TLS-class failure ends up as one of these three codes so the
 * operator runbook covers a closed set.
 */
export type TlsErrorCode =
  | 'host_tls_chain_invalid'
  | 'host_tls_hostname_mismatch'
  | 'host_tls_expired';

/**
 * Node error codes that mean "the certificate is outside its
 * validity window" (expired or not-yet-valid). We collapse both
 * into `host_tls_expired` because the UI treatment is the same:
 * tell the operator their cert time bounds don't match wall-clock.
 */
const TLS_EXPIRED_CODES: ReadonlySet<string> = new Set(['CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID']);

/**
 * Node error codes that mean "the cert is trusted but doesn't match
 * the hostname we asked for". This is the alt-name / SAN mismatch
 * branch.
 */
const TLS_HOSTNAME_CODES: ReadonlySet<string> = new Set(['ERR_TLS_CERT_ALTNAME_INVALID']);

/**
 * Node / OpenSSL error codes that mean "the certificate chain itself
 * is unverifiable" (untrusted issuer, self-signed, revoked, signature
 * failure, generic verify failure, etc).
 *
 * Listed explicitly — NOT matched by regex `^CERT_|^ERR_TLS_` —
 * because a regex would silently swallow new Node-side error codes
 * that may want a more specific typed mapping. Adding a code here is
 * a deliberate decision that "yes, this is chain-class" rather than
 * an accidental classification.
 *
 * Sources: OpenSSL `X509_V_ERR_*` mapped names that Node exposes via
 * `error.code` (verified against Node 20 / 22 source), plus Node's
 * own `_tls_common.js` / `_tls_wrap.js` error code surface.
 */
const TLS_CHAIN_CODES: ReadonlySet<string> = new Set([
  // OpenSSL X509 verify codes that Node surfaces verbatim.
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_GET_CRL',
  'UNABLE_TO_DECRYPT_CERT_SIGNATURE',
  'UNABLE_TO_DECRYPT_CRL_SIGNATURE',
  'UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_SIGNATURE_FAILURE',
  'CRL_SIGNATURE_FAILURE',
  'CRL_NOT_YET_VALID',
  'CRL_HAS_EXPIRED',
  'ERROR_IN_CERT_NOT_BEFORE_FIELD',
  'ERROR_IN_CERT_NOT_AFTER_FIELD',
  'ERROR_IN_CRL_LAST_UPDATE_FIELD',
  'ERROR_IN_CRL_NEXT_UPDATE_FIELD',
  'OUT_OF_MEM',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'CERT_CHAIN_TOO_LONG',
  'CERT_REVOKED',
  'INVALID_CA',
  'PATH_LENGTH_EXCEEDED',
  'INVALID_PURPOSE',
  'CERT_UNTRUSTED',
  'CERT_REJECTED',
  'SUBJECT_ISSUER_MISMATCH',
  'AKID_SKID_MISMATCH',
  'AKID_ISSUER_SERIAL_MISMATCH',
  'KEYUSAGE_NO_CERTSIGN',
  'UNSUPPORTED_CERTIFICATE',
  // Node-side TLS handshake / record layer codes.
  'ERR_TLS_HANDSHAKE_TIMEOUT',
  'ERR_TLS_INVALID_PROTOCOL_VERSION',
  'ERR_TLS_PROTOCOL_VERSION_CONFLICT',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION',
  'ERR_SSL_TLSV1_ALERT_UNKNOWN_CA',
  'ERR_SSL_TLSV1_ALERT_BAD_CERTIFICATE',
  'ERR_SSL_CERTIFICATE_VERIFY_FAILED',
]);

/**
 * Maximum depth we walk through the `Error.cause` chain looking for
 * a recognized code. Real-world chains seen in fetch/undici are 1–3
 * deep; the cap exists only to bound runtime against pathological /
 * adversarial cyclic objects (cycles are also guarded with a
 * WeakSet).
 */
const MAX_CAUSE_DEPTH = 8;

/**
 * Classify a Node error as one of the three typed TLS failure codes,
 * or `null` if the error is not TLS-related.
 *
 * Detection strategy:
 *   - Read `error.code` (string only — numeric codes are ignored).
 *   - Walk the `Error.cause` chain.
 *   - **Specific-wins precedence** (Cindy D4.a Commit 1 review
 *     2026-05-28): the canonical Node 18+ shape wraps the OpenSSL
 *     X509 verify failure with a generic outer
 *     `ERR_SSL_CERTIFICATE_VERIFY_FAILED` whose specific reason
 *     (e.g. `CERT_HAS_EXPIRED`) lives on `cause`. If we returned
 *     `host_tls_chain_invalid` on the outer match we would lose the
 *     operator-meaningful "expired" / "hostname mismatch" signal that
 *     the runbook needs. So:
 *       1. If ANY node in the cause chain has an `_expired` or
 *          `_hostname_mismatch` code, return that immediately —
 *          specific codes always win.
 *       2. Otherwise, if ANY node carries a chain-class code, return
 *          `host_tls_chain_invalid` as the typed fallback.
 *       3. Otherwise return `null` (not TLS-related — caller routes
 *          via its own network/DNS/timeout typed surface).
 *   - First match wins WITHIN a category. If a deeper expired and a
 *     shallower hostname-mismatch are both present we return the
 *     shallower hostname-mismatch (depth-first walk + immediate
 *     return on first specific match). In practice the cause chain
 *     carries at most one TLS code per category, so this ordering
 *     is harmless; pinning it explicitly keeps the contract
 *     deterministic.
 *
 * Returns `null` if no recognized code appears anywhere in the chain
 * — caller treats it as non-TLS (network / DNS / timeout / etc.)
 * and surfaces its own typed code from a different namespace.
 *
 * This function is pure: no I/O, no globals, no clock. Safe to call
 * from any process (main / renderer / worker).
 */
export function classifyTlsError(err: unknown): TlsErrorCode | null {
  const visited = new WeakSet<object>();
  let current: unknown = err;
  let chainFallback: TlsErrorCode | null = null;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current != null; depth++) {
    if (typeof current !== 'object') break;
    const obj = current as object;
    if (visited.has(obj)) break;
    visited.add(obj);
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') {
      // Specific codes win immediately — operator runbooks
      // distinguish "expired" / "hostname mismatch" from generic
      // "chain invalid", so the deepest accurate label matters.
      if (TLS_EXPIRED_CODES.has(code)) return 'host_tls_expired';
      if (TLS_HOSTNAME_CODES.has(code)) return 'host_tls_hostname_mismatch';
      // Chain code: remember as fallback but keep walking the chain.
      // A deeper specific code (Node 18+ wraps OpenSSL's specific
      // X509 verify codes inside generic outer
      // `ERR_SSL_CERTIFICATE_VERIFY_FAILED`) should win over a
      // shallower chain wrapper — without this two-pass behavior we
      // would mis-report "expired" cases as "chain invalid", which
      // the d4-design §8.2 runbook explicitly differentiates.
      if (TLS_CHAIN_CODES.has(code) && chainFallback === null) {
        chainFallback = 'host_tls_chain_invalid';
      }
    }
    current = (current as { cause?: unknown }).cause;
  }
  return chainFallback;
}
