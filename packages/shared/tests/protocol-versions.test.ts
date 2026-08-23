import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_VERSIONS,
  DESKTOP_SERVER_API_EPOCH,
  MINIMUM_CLIENT_API_EPOCH,
  MINIMUM_SERVER_API_EPOCH,
} from '../src/index.js';

/**
 * #task:2110 — the single-authority DERIVATION guard.
 *
 * Desktop values derive from the generated projection of the shared backend
 * admission artifact. The dedicated artifact suite protects that projection;
 * this suite protects the public version facade and admission constants.
 *
 * Hermetic by design: no git, no tag reader, no filesystem. The `+1`
 * release-step discipline is a manual runbook check (`docs/desktop-server-api-epoch.md`)
 * judged against published tags, deliberately NOT asserted here. The host-axis
 * half (`HOST_PROTOCOL_VERSION` / `OUTBOUND_PROTOCOL_VERSION`) lives in
 * `packages/host/tests`, because the dependency direction forbids
 * `@silverhand/shared` from importing host code.
 */
describe('protocol-versions single authority — desktop axis derivation', () => {
  it('the desktop epoch triple stays equal to the authority (guards bump drift)', () => {
    expect(DESKTOP_SERVER_API_EPOCH).toBe(PROTOCOL_VERSIONS.desktopApi);
    expect(MINIMUM_CLIENT_API_EPOCH).toBe(PROTOCOL_VERSIONS.desktopMinClient);
    expect(MINIMUM_SERVER_API_EPOCH).toBe(PROTOCOL_VERSIONS.desktopMinServer);
  });

  it('every authority value is a positive integer', () => {
    for (const [axis, value] of Object.entries(PROTOCOL_VERSIONS)) {
      expect(Number.isInteger(value), axis).toBe(true);
      expect(value, axis).toBeGreaterThan(0);
    }
  });

  it('a minimum never exceeds its current epoch (would reject this build)', () => {
    // Plan-A lockstep (min === current) is owned and asserted by
    // desktop-server-api-epoch.test.ts; here we only guard the weaker,
    // axis-agnostic sanity bound so the authority can never be edited into a
    // state that refuses every peer including itself.
    expect(PROTOCOL_VERSIONS.desktopMinClient).toBeLessThanOrEqual(
      PROTOCOL_VERSIONS.desktopApi,
    );
    expect(PROTOCOL_VERSIONS.desktopMinServer).toBeLessThanOrEqual(
      PROTOCOL_VERSIONS.desktopApi,
    );
  });
});
