/**
 * #task:1417 Stage 3 — fail-loud guard for the delivery-owner token
 * (Cindy P1, §11.4.1).
 *
 * `DeliveryOwnerContext.owner` is a LOAD-BEARING custody key, not logging
 * metadata: a `deferred` entry enqueued under a guessed owner is one that the
 * connection's close cleanup can never reclaim, so the DB row stays in-flight
 * forever with no daemon custody. All three ingresses (control socket,
 * embedded local-outbound, standalone WS) route owner resolution through the
 * single `resolveDeliveryOwner` chokepoint, which throws rather than
 * substitute a sentinel.
 *
 * This is the negative test that keeps a `*:unknown` fallback from being
 * quietly reintroduced at any ingress — the shared helper has no sentinel,
 * and a regression that reintroduces one would have to bypass it (visible in
 * review) to compile.
 */
import { describe, expect, it } from 'vitest';
import { resolveDeliveryOwner } from '../src/daemon/supervisor-contract.js';

describe('resolveDeliveryOwner — fail-loud owner chokepoint', () => {
  it('returns a minted owner unchanged', () => {
    expect(resolveDeliveryOwner('local:1', 'local_outbound')).toBe('local:1');
    expect(resolveDeliveryOwner('control:42', 'control')).toBe('control:42');
    expect(resolveDeliveryOwner('outbound:7', 'outbound_ws')).toBe('outbound:7');
  });

  it('throws (never returns a sentinel) when the owner is missing', () => {
    expect(() => resolveDeliveryOwner(undefined, 'control')).toThrow(
      /no minted delivery owner/i,
    );
    expect(() => resolveDeliveryOwner(undefined, 'local_outbound')).toThrow(
      /local_outbound/,
    );
    expect(() => resolveDeliveryOwner(undefined, 'outbound_ws')).toThrow(
      /outbound_ws/,
    );
  });

  it('treats an empty-string owner as missing (no zero-length sentinel)', () => {
    expect(() => resolveDeliveryOwner('', 'control')).toThrow(
      /no minted delivery owner/i,
    );
  });
});
