import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSIONS } from '@silverhand/shared';
import { HOST_PROTOCOL_VERSION } from '../src/protocol.js';
import { OUTBOUND_PROTOCOL_VERSION } from '../src/outbound-protocol.js';

/**
 * #task:2110 — the host-axis half of the single-authority DERIVATION guard (see
 * `packages/shared/tests/protocol-versions.test.ts` for the desktop half and the
 * rationale). Both daemon-artifact wire versions must stay equal to the one
 * record in `@silverhand/shared`; this fails RED on export drift after an
 * authority bump. It does NOT prove single-write-point (re-hardcoding the same
 * number stays green) — that is a source-review/grep property of this ticket.
 * This is the only place that can pin the host axis: `@silverhand/shared` may
 * not import host code.
 *
 * Hermetic by design — the `+1`-over-last-published-tag release discipline is a
 * manual runbook check, not asserted here.
 */
describe('protocol-versions single authority — host axis derivation', () => {
  it('the daemon wire versions stay equal to the authority (guards bump drift)', () => {
    expect(HOST_PROTOCOL_VERSION).toBe(PROTOCOL_VERSIONS.host);
    expect(OUTBOUND_PROTOCOL_VERSION).toBe(PROTOCOL_VERSIONS.outbound);
  });
});
