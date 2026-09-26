/**
 * Numeric-tuple version comparison for driver capability gates
 * (#task:1909).
 *
 * The only version source on the spawn path is `probeVersion()` in
 * `packages/host/src/runtimes.ts`, and it is deliberately lenient: it
 * returns the first semver-ish token found in `<bin> --version`, and
 * when there is none it returns the raw first line of output. So a
 * capability gate MUST treat anything it cannot fully parse as "not
 * capable": a wrong `true` puts a wire frame the runtime may not
 * understand on stdin, while a wrong `false` only keeps the more
 * conservative release profile. Fail closed.
 *
 * Deliberately NOT a semver implementation:
 *  - missing components count as 0, so `1.1` < `1.1.17`;
 *  - a pre-release / build suffix is ignored — the numeric dotted
 *    prefix decides (`1.1.17-beta.2` counts as `1.1.17`);
 *  - the numeric prefix must be at the START of the string, so a raw
 *    `probeVersion` fallback line never parses by accident.
 * No dependency is added for this; if real pre-release ordering ever
 * becomes load-bearing, that is the moment to reach for a comparator
 * library, not before.
 *
 * Where the real boundary is (so nobody hardens the wrong function):
 * `probeVersion` extracts with `/\d+\.\d+(?:\.\d+)?/`, which has no
 * suffix group. A pre-release marker is therefore destroyed BEFORE it
 * reaches this comparator — `1.1.17-beta.2` arrives as `1.1.17`, so the
 * suffix rule above is unreachable from the spawn path and no strictness
 * here can recover the distinction. By the same token, that unanchored
 * regex will lift a dotted number out of arbitrary text (usage output
 * included), and this gate cannot tell that apart from a real version.
 * Both properties belong to `probeVersion` and are shared by every
 * consumer of `RuntimeInfo.version`; changing them is a separate,
 * cross-runtime decision, not a local fix in a driver's capability gate.
 */

/** Parsed numeric prefix, or null when the string has none. */
function parseNumericVersion(version: string | null | undefined): number[] | null {
  if (typeof version !== 'string') return null;
  const match = version.trim().match(/^v?(\d+(?:\.\d+)*)/);
  if (!match) return null;
  return match[1]!.split('.').map((part) => Number(part));
}

/**
 * True when `version` is at least `minimum`. `minimum` is a literal
 * owned by the calling driver and must parse — an unparseable floor is
 * a programming error, not a runtime condition, so it throws.
 */
export function versionAtLeast(version: string | null | undefined, minimum: string): boolean {
  const floor = parseNumericVersion(minimum);
  if (!floor) {
    throw new Error(`versionAtLeast: unparseable minimum "${minimum}"`);
  }
  const actual = parseNumericVersion(version);
  if (!actual) return false;
  const len = Math.max(actual.length, floor.length);
  for (let i = 0; i < len; i += 1) {
    const a = actual[i] ?? 0;
    const b = floor[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}
