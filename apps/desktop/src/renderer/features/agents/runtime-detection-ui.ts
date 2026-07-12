import type { RuntimeAvailabilityState } from '@silverhand/shared';

// Pure decision core for the create-dialog runtime picker (#task:1376). Kept
// out of the component so the load-bearing rule — detection may *disable* a
// runtime ONLY on a fresh, deterministic `absent`, never on a probe gap — is
// unit-testable in isolation. This is the crux of the false-negative the
// feature exists to kill: an offline/loading/errored probe must not trap a
// runtime the user actually has installed.

/** UI mode of the runtime section for the currently-selected computer. */
export type RuntimePickerMode =
  | 'no-host' // no computer chosen yet — nothing to probe
  | 'offline' // chosen computer unavailable — collapse into availability gate
  | 'probing' // a fresh probe is in flight
  | 'probe-failed' // the probe itself errored (transport = unknown-for-all)
  | 'detected'; // fresh catalog for an available host — states authoritative

/** Fold the async signals into one mode. Order matters — earlier branches
 *  short-circuit later ones:
 *    hasHost → host-availability loading (probing) → offline → catalog
 *    loading (probing) → catalog error (probe-failed) → detected.
 *  Host-availability-loading precedes `offline` because the map's initial
 *  read for any host is `undefined` (== "not available yet, per the getter")
 *  until the first status probe settles — treating that gap as offline
 *  would flash "Connect the computer to detect runtimes" for ~50ms on every
 *  mount (Cindy #1472 round-7 HIGH). Consumers that mount only AFTER they
 *  know the host is available pass `isHostAvailabilityLoading: false`. */
export function deriveRuntimePickerMode(input: {
  hasHost: boolean;
  isHostAvailabilityLoading: boolean;
  hostAvailable: boolean;
  isLoading: boolean;
  isError: boolean;
}): RuntimePickerMode {
  if (!input.hasHost) return 'no-host';
  if (input.isHostAvailabilityLoading) return 'probing';
  if (!input.hostAvailable) return 'offline';
  if (input.isLoading) return 'probing';
  if (input.isError) return 'probe-failed';
  return 'detected';
}

/** A runtime chip is disabled ONLY when a fresh probe of an available host
 *  reports the binary as deterministically `absent`. `present` /
 *  `present_unverified` / `unknown` are never disabled, and neither is any
 *  non-`detected` mode — spawn is the ground truth. */
export function runtimeChipDisabled(
  mode: RuntimePickerMode,
  state: RuntimeAvailabilityState | undefined,
): boolean {
  return mode === 'detected' && state === 'absent';
}

/** Section-level hint. Only `offline` / `probe-failed` carry one — `probing`
 *  is conveyed by the Recheck button and `detected` by per-chip markers, so we
 *  never stack redundant lines (and never spend attention on filler copy). */
export function runtimeSectionHint(mode: RuntimePickerMode): string | null {
  switch (mode) {
    case 'offline':
      return 'Connect the computer to detect runtimes';
    case 'probe-failed':
      return "Couldn't check runtimes — use Recheck";
    default:
      return null;
  }
}
