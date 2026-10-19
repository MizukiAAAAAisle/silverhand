import { describe, expect, it } from 'vitest';

import { compareToMinimum, parsedVersion, versionAtLeast } from '../../src/drivers/version-gate.js';

// ===========================================================================
// CONTRACT (Do Not Weaken) — driver capability version gate, #task:1909
//
// WHY THIS EXISTS: the only version source on the spawn path is
// `probeVersion()`, which returns the first semver-ish token in
// `<bin> --version` and otherwise the RAW first line of output. A gate that
// says "capable" on input it did not fully parse puts a wire frame on stdin
// that the runtime may not understand. So the direction of error is fixed:
// unparseable / short / missing → not capable.
//
// INVARIANTS:
//  1. Missing components count as 0 → `1.1` < `1.1.17`. This is the case a
//     string compare ("1.1" > "1.1.17" lexically is false, but "1.9" > "1.17"
//     is true) and a parseFloat compare (1.1 vs 1.1) both get wrong.
//  2. Components compare NUMERICALLY, not lexically → `1.1.9` < `1.1.17`.
//  3. The numeric prefix must start the string, so a `probeVersion` fallback
//     line that merely contains digits never parses into a capability.
//  4. An unparseable MINIMUM throws: the floor is a code literal owned by a
//     driver, so a bad one is a programming error, never runtime input.
// ===========================================================================
describe('versionAtLeast', () => {
  it('compares components numerically with missing components as 0', () => {
    expect(versionAtLeast('1.1.17', '1.1.17')).toBe(true);
    expect(versionAtLeast('1.1.18', '1.1.17')).toBe(true);
    expect(versionAtLeast('1.2', '1.1.17')).toBe(true);
    expect(versionAtLeast('2', '1.1.17')).toBe(true);

    expect(versionAtLeast('1.1.16', '1.1.17')).toBe(false);
    // lexically "9" > "1", numerically 9 < 17
    expect(versionAtLeast('1.1.9', '1.1.17')).toBe(false);
    // missing patch is 0, not "at least the floor"
    expect(versionAtLeast('1.1', '1.1.17')).toBe(false);
    expect(versionAtLeast('1', '1.1.17')).toBe(false);
    expect(versionAtLeast('0.9.99', '1.1.17')).toBe(false);
  });

  it('accepts a leading v and ignores pre-release / build suffixes', () => {
    expect(versionAtLeast('v1.1.17', '1.1.17')).toBe(true);
    expect(versionAtLeast('1.1.17-beta.2', '1.1.17')).toBe(true);
    expect(versionAtLeast('1.1.17+build.9', '1.1.17')).toBe(true);
    expect(versionAtLeast('  1.1.17  ', '1.1.17')).toBe(true);
  });

  it('fails closed on every input it cannot parse as a leading version', () => {
    for (const bad of [
      null,
      undefined,
      '',
      '   ',
      'unknown',
      // probeVersion's raw-first-line fallback: digits present, but not a
      // leading version token.
      'qodercli (build 9.9.9)',
      'version: 1.1.17',
      'x1.1.17',
    ]) {
      expect(versionAtLeast(bad, '1.1.17'), String(bad)).toBe(false);
    }
  });

  it('throws on an unparseable minimum (programming error, not input)', () => {
    expect(() => versionAtLeast('1.1.17', 'latest')).toThrow(/unparseable minimum/);
  });

  it('classifies against a floor without refusing unknown versions', () => {
    expect(compareToMinimum('1.0.24', '1.0.24')).toBe('ok');
    expect(compareToMinimum('v2.0', '1.0.24')).toBe('ok');
    expect(compareToMinimum('1.0.23', '1.0.24')).toBe('below');
    for (const unknown of [null, undefined, '', 'garbage', 'version: 1.0.0']) {
      expect(compareToMinimum(unknown, '1.0.24'), String(unknown)).toBe('unknown');
    }
    expect(parsedVersion('v1.2.3-beta')).toBe('1.2.3');
    expect(parsedVersion('garbage')).toBeNull();
  });
});
