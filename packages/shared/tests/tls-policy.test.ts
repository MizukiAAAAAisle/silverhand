/**
 * D4.a Commit 1 — unit tests for `classifyTlsError` typed-mapping
 * primitive in `@silverhand/shared`.
 *
 * Test strategy (Cindy lock 2026-05-28): synthesize fake error
 * objects with the `code` / `cause` shape Node produces. We do NOT
 * open real TLS connections, do NOT use a self-signed fixture, do
 * NOT install any `rejectUnauthorized: false` test helper. The
 * primitive is pure error-shape normalization; testing it against
 * literal `{ code }` objects is the canonical form.
 *
 * Coverage:
 *   - Direct `error.code` mapping per category.
 *   - `cause`-chain walk for Node 18+ wrapped errors.
 *   - Specificity: when both an outer generic and an inner specific
 *     code are present, the specific match wins; among specific
 *     codes, the first encountered wins.
 *   - Non-TLS errors return null.
 *   - Cycle / depth guards.
 */
import { describe, expect, it } from 'vitest';
import { classifyTlsError } from '@silverhand/shared';

/**
 * Tiny helper to build an Error-shaped object with a string code
 * (and optionally a cause). We don't use `new Error(...)` everywhere
 * because we want to vary the `code` property and a plain object
 * with `code` is what `classifyTlsError`'s contract requires us to
 * handle (per the JSDoc — it walks `code` and `cause` properties on
 * any object, not just `Error` instances).
 */
function errWith(code: string, cause?: unknown): { code: string; cause?: unknown } {
  return cause !== undefined ? { code, cause } : { code };
}

describe('classifyTlsError — direct code mapping', () => {
  // ── Expired branch ─────────────────────────────────────────────
  it.each(['CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID'])('maps %s to host_tls_expired', (code) => {
    expect(classifyTlsError(errWith(code))).toBe('host_tls_expired');
  });

  // ── Hostname mismatch branch ───────────────────────────────────
  it('maps ERR_TLS_CERT_ALTNAME_INVALID to host_tls_hostname_mismatch', () => {
    expect(classifyTlsError(errWith('ERR_TLS_CERT_ALTNAME_INVALID'))).toBe(
      'host_tls_hostname_mismatch',
    );
  });

  // ── Chain-invalid branch ───────────────────────────────────────
  // Spot-check the most common chain-class codes. The full set
  // lives in the module's TLS_CHAIN_CODES; testing every one is
  // pinning the implementation detail rather than the contract.
  // What we DO need to pin is that the canonical "chain not
  // trusted" categories all land here.
  it.each([
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_GET_ISSUER_CERT',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'CERT_SIGNATURE_FAILURE',
    'CERT_REVOKED',
    'INVALID_CA',
    'CERT_UNTRUSTED',
    'CERT_REJECTED',
    'UNSUPPORTED_CERTIFICATE',
    'ERR_TLS_HANDSHAKE_TIMEOUT',
    'ERR_SSL_CERTIFICATE_VERIFY_FAILED',
    'ERR_SSL_TLSV1_ALERT_UNKNOWN_CA',
    'ERR_SSL_TLSV1_ALERT_BAD_CERTIFICATE',
  ])('maps %s to host_tls_chain_invalid', (code) => {
    expect(classifyTlsError(errWith(code))).toBe('host_tls_chain_invalid');
  });
});

describe('classifyTlsError — cause-chain walk (Node 18+ wrapper shape)', () => {
  it('finds the specific expired code on cause when outer code is the generic verify wrapper', () => {
    // This is the canonical Node 18+ shape: undici / fetch wraps
    // the OpenSSL verify failure with a generic outer error whose
    // own `code` is `ERR_SSL_CERTIFICATE_VERIFY_FAILED`. The
    // specific reason (e.g. `CERT_HAS_EXPIRED`) lives on `cause`.
    // Specificity precedence (Cindy D4.a Commit 1 review): the
    // walker MUST descend through the outer chain wrapper and
    // return the specific `host_tls_expired` so the operator sees
    // "your cert expired" rather than the generic "chain invalid".
    const wrapped = errWith('ERR_SSL_CERTIFICATE_VERIFY_FAILED', errWith('CERT_HAS_EXPIRED'));
    expect(classifyTlsError(wrapped)).toBe('host_tls_expired');
  });

  it('finds the specific hostname-mismatch code on cause when outer code is the generic verify wrapper', () => {
    // Symmetric precedence test for hostname mismatch — the
    // d4-design §8.2 runbook explicitly distinguishes this case
    // from chain-invalid, so the specificity precedence must hold
    // for both specific categories, not just expired.
    const wrapped = errWith(
      'ERR_SSL_CERTIFICATE_VERIFY_FAILED',
      errWith('ERR_TLS_CERT_ALTNAME_INVALID'),
    );
    expect(classifyTlsError(wrapped)).toBe('host_tls_hostname_mismatch');
  });

  it('returns chain_invalid only when no specific code appears anywhere in the chain', () => {
    // Pin the fallback path: if the entire chain is chain-class
    // (e.g. self-signed wrapped in generic verify wrapper, no
    // expired / hostname mismatch anywhere), then chain_invalid is
    // the correct typed answer.
    const wrapped = errWith(
      'ERR_SSL_CERTIFICATE_VERIFY_FAILED',
      errWith('DEPTH_ZERO_SELF_SIGNED_CERT'),
    );
    expect(classifyTlsError(wrapped)).toBe('host_tls_chain_invalid');
  });

  it('finds expired on cause when outer code is not a recognized TLS code (descent succeeds)', () => {
    // Realistic shape: some Node libraries wrap with a generic
    // Error that has no `code` (or an unrelated code), and the
    // TLS error is on cause. The walker MUST descend through the
    // outer and reach the cause to classify as TLS.
    const wrapped = errWith('SOMETHING_ELSE', errWith('CERT_HAS_EXPIRED'));
    expect(classifyTlsError(wrapped)).toBe('host_tls_expired');
  });

  it('finds hostname mismatch on a deeper cause', () => {
    // 3-deep wrap: outer / mid / leaf. The walker should reach
    // the leaf within the depth bound.
    const leaf = errWith('ERR_TLS_CERT_ALTNAME_INVALID');
    const mid = errWith('GENERIC_WRAPPER_A', leaf);
    const outer = errWith('GENERIC_WRAPPER_B', mid);
    expect(classifyTlsError(outer)).toBe('host_tls_hostname_mismatch');
  });

  it('prefers a shallower specific code when both layers carry specific codes (depth-first first-match precedence)', () => {
    // Within the specific category, first match wins (depth-first).
    // This is deterministic by design — pinning so a future
    // refactor doesn't accidentally swap to last-match-wins, which
    // would silently mis-classify multi-layer wrapped errors.
    const inner = errWith('CERT_HAS_EXPIRED');
    const outer = errWith('ERR_TLS_CERT_ALTNAME_INVALID', inner);
    expect(classifyTlsError(outer)).toBe('host_tls_hostname_mismatch');
  });

  it('returns null when no recognized TLS code appears anywhere in the chain', () => {
    // Network / DNS / timeout class errors must NOT be classified
    // as TLS — the caller is expected to handle them via a
    // different typed surface. Returning null is the contract.
    expect(classifyTlsError(errWith('ECONNREFUSED'))).toBeNull();
    expect(classifyTlsError(errWith('ENOTFOUND'))).toBeNull();
    expect(classifyTlsError(errWith('ETIMEDOUT'))).toBeNull();
    expect(classifyTlsError(errWith('ECONNRESET', errWith('EPIPE')))).toBeNull();
  });

  it('returns null for non-object input (null, undefined, string, number)', () => {
    expect(classifyTlsError(null)).toBeNull();
    expect(classifyTlsError(undefined)).toBeNull();
    expect(classifyTlsError('CERT_HAS_EXPIRED')).toBeNull();
    expect(classifyTlsError(42)).toBeNull();
    expect(classifyTlsError({})).toBeNull();
  });

  it('handles an object whose code is non-string (numeric, object) by skipping it', () => {
    // Real errors sometimes carry numeric codes (OpenSSL's
    // ssl_error_code at the C layer). We only branch on string
    // codes; non-string codes are ignored (no false positive),
    // and the walker still descends into cause.
    const nonStringCode = { code: 42, cause: errWith('CERT_HAS_EXPIRED') };
    expect(classifyTlsError(nonStringCode)).toBe('host_tls_expired');
    const onlyNonStringCode = { code: 42 };
    expect(classifyTlsError(onlyNonStringCode)).toBeNull();
  });
});

describe('classifyTlsError — depth / cycle guards', () => {
  it('terminates on a cyclic cause chain without recognized codes (returns null)', () => {
    // Only termination and the non-TLS result are contractual; either
    // cycle detection or bounded traversal can provide that behavior.
    const a: { code: string; cause?: unknown } = { code: 'A' };
    const b: { code: string; cause?: unknown } = { code: 'B', cause: a };
    a.cause = b;
    expect(classifyTlsError(a)).toBeNull();
  });

  it('does not inspect the ninth cause-chain node', () => {
    let acc: { code: string; cause?: unknown } = errWith('CERT_HAS_EXPIRED');
    for (let i = 0; i < 8; i++) {
      acc = { code: `WRAPPER_${i}`, cause: acc };
    }
    expect(classifyTlsError(acc)).toBeNull();
  });

  it('finds a TLS code at exactly the depth cap', () => {
    // At depth 7 (under the cap of 8) the walker should still
    // find the code. Pin the boundary so off-by-one in the cap
    // is caught immediately.
    let acc: { code: string; cause?: unknown } = errWith('CERT_HAS_EXPIRED');
    for (let i = 0; i < 7; i++) {
      acc = { code: `WRAPPER_${i}`, cause: acc };
    }
    expect(classifyTlsError(acc)).toBe('host_tls_expired');
  });
});
