/**
 * #task:1530 — bounded parse of the desktop client-info telemetry header.
 *
 * The header is UNTRUSTED input at the server boundary. Pins:
 *   1. well-formed + schema-valid → `valid` with normalized payload.
 *   2. absent / empty / whitespace → `missing` (so old desktops are observable).
 *   3. repeated header (array) / oversized / non-JSON / schema mismatch →
 *      `invalid` (never throws, never surfaces the raw payload).
 *   4. `.strict()` rejects unknown keys; each field is charset/length bounded.
 *   5. round-trip: `serializeClientInfoHeader` output parses back to `valid`.
 */
import { describe, expect, it } from 'vitest';
import {
  CLIENT_INFO_HEADER_MAX_BYTES,
  parseClientInfoHeader,
  serializeClientInfoHeader,
  type ClientInfo,
} from '../src/client-telemetry.js';

const VALID: ClientInfo = {
  client_surface: 'desktop',
  deployment: 'remote-only',
  app_version: '0.1.0',
  build_commit: 'a'.repeat(40),
  build_dirty: false,
  platform: 'darwin',
  arch: 'arm64',
  installation_id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
};

describe('parseClientInfoHeader', () => {
  it('accepts a well-formed payload and normalizes it', () => {
    const res = parseClientInfoHeader(JSON.stringify(VALID));
    expect(res.status).toBe('valid');
    if (res.status === 'valid') expect(res.value).toEqual(VALID);
  });

  it('accepts the embedded deployment + dev/dirty build sentinel', () => {
    const res = parseClientInfoHeader(
      JSON.stringify({
        ...VALID,
        deployment: 'embedded',
        build_commit: 'dev',
        build_dirty: true,
        platform: 'linux',
        arch: 'x64',
      }),
    );
    expect(res.status).toBe('valid');
  });

  it('accepts semver prerelease/build variants', () => {
    for (const v of ['0.1.0', '34.0.0', '1.2.3-beta.1', '1.2.3+build.5']) {
      expect(
        parseClientInfoHeader(JSON.stringify({ ...VALID, app_version: v })).status,
        v,
      ).toBe('valid');
    }
  });

  it('rejects pseudo-versions that are not semver (P2 — fleet data quality)', () => {
    for (const v of ['abc', '---', 'dev', '1', '1.2', 'v1.2.3', '1.2.3 ']) {
      expect(
        parseClientInfoHeader(JSON.stringify({ ...VALID, app_version: v })).status,
        v,
      ).toBe('invalid');
    }
  });

  it('reports missing for undefined / empty / whitespace', () => {
    expect(parseClientInfoHeader(undefined).status).toBe('missing');
    expect(parseClientInfoHeader('').status).toBe('missing');
    expect(parseClientInfoHeader('   ').status).toBe('missing');
  });

  it('reports invalid for a repeated header (array)', () => {
    expect(
      parseClientInfoHeader([JSON.stringify(VALID), JSON.stringify(VALID)]).status,
    ).toBe('invalid');
  });

  it('reports invalid for non-JSON', () => {
    expect(parseClientInfoHeader('not json').status).toBe('invalid');
    expect(parseClientInfoHeader('{').status).toBe('invalid');
  });

  it('reports invalid when it exceeds the byte cap', () => {
    const oversized = JSON.stringify({
      ...VALID,
      // pad app_version past the cap; still valid JSON, just too big.
      app_version: 'x'.repeat(CLIENT_INFO_HEADER_MAX_BYTES + 10),
    });
    expect(parseClientInfoHeader(oversized).status).toBe('invalid');
  });

  it('rejects unknown keys (strict)', () => {
    expect(
      parseClientInfoHeader(JSON.stringify({ ...VALID, injected: 'x' })).status,
    ).toBe('invalid');
  });

  it('rejects malformed fields', () => {
    const cases: Array<Partial<Record<keyof ClientInfo, unknown>>> = [
      { client_surface: 'cli' },
      { deployment: 'remote' }, // must be remote-only, never bare `remote`
      { build_commit: 'ABCDEF' }, // not 40-hex, not `dev`
      { build_commit: 'z'.repeat(40) }, // 40 chars but non-hex
      { build_dirty: 'yes' },
      { platform: 'Darwin OS' }, // spaces/case not allowed
      { arch: 'x'.repeat(20) }, // over length
      { installation_id: 'not-a-uuid' },
      { app_version: 'has space' },
    ];
    for (const patch of cases) {
      const res = parseClientInfoHeader(JSON.stringify({ ...VALID, ...patch }));
      expect(res.status, JSON.stringify(patch)).toBe('invalid');
    }
  });

  it('round-trips a serialized header back to valid', () => {
    const res = parseClientInfoHeader(serializeClientInfoHeader(VALID));
    expect(res.status).toBe('valid');
    if (res.status === 'valid') expect(res.value).toEqual(VALID);
  });
});
