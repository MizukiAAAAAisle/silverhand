import { describe, expect, it } from 'vitest';
import { classifyOutboundProtocolCompatibility } from './outbound-protocol-compatibility.js';

describe('classifyOutboundProtocolCompatibility', () => {
  it('reports compatible only when both exact protocol versions match', () => {
    expect(
      classifyOutboundProtocolCompatibility({
        appProtocolVersion: 7,
        serverProtocolVersion: 7,
      }),
    ).toEqual({
      status: 'compatible',
      app_protocol_version: 7,
      server_protocol_version: 7,
    });
  });

  it('requires an app update when the bundled daemon is older', () => {
    expect(
      classifyOutboundProtocolCompatibility({
        appProtocolVersion: 7,
        serverProtocolVersion: 8,
      }).status,
    ).toBe('app_update_required');
  });

  it('requires a server update when the app is newer', () => {
    expect(
      classifyOutboundProtocolCompatibility({
        appProtocolVersion: 8,
        serverProtocolVersion: 7,
      }).status,
    ).toBe('server_update_required');
  });

  it('does not guess when connected to a server that predates the capability field', () => {
    expect(
      classifyOutboundProtocolCompatibility({
        appProtocolVersion: 7,
        serverProtocolVersion: undefined,
      }),
    ).toEqual({
      status: 'unknown',
      app_protocol_version: 7,
      server_protocol_version: null,
    });
  });
});
