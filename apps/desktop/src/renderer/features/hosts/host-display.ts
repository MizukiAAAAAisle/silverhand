import type { HostAvailability, HostDto } from '@silverhand/shared';

/**
 * The single place the renderer turns a computer into a user-facing name:
 * the user's rename (`display_label`) wins, else the stable `name`. Every
 * surface that shows a computer's name — the agent rail grouping, the agent
 * profile, pickers — resolves through here so there is one naming logic, not
 * a second copy per consumer.
 */
export function hostDisplayName(host: HostDto): string {
  return host.display_label?.trim() || host.name;
}

/**
 * Restrained fallback when an agent references a computer that isn't in the
 * owned-computers list — deleted, revoked, or not owned by the viewer.
 */
export const UNKNOWN_COMPUTER_LABEL = 'Unknown computer';

/**
 * Resolve a computer name from an optional host DTO, falling back to the
 * restrained unknown label when it can't be resolved. Shared by the rail and
 * the agent profile so the two never drift.
 */
export function resolveComputerName(host: HostDto | undefined): string {
  return host ? hostDisplayName(host) : UNKNOWN_COMPUTER_LABEL;
}

/**
 * Whether a computer can be a placement target *right now*. Placement needs
 * both axes: lifecycle (`host.placeable` — activated + finalized + not revoked)
 * AND availability (its daemon is actually online). This helper is the
 * availability half — `undefined` means the status probe is still in flight, so
 * it is treated as not-yet-selectable rather than optimistically available.
 */
export function isComputerAvailable(
  availability: HostAvailability | undefined,
): boolean {
  return availability === 'available';
}

/**
 * Short, right-aligned reason a computer can't be picked as a placement target.
 * `available` → null (the row is selectable, no badge); anything else → a terse
 * word the picker shows on the disabled row so the user knows *why* it's
 * greyed out (shiki #task:1359). `undefined` = status still loading.
 *
 * This is the availability axis (`GET /api/hosts/:id/status`), orthogonal to
 * the lifecycle `placeable` predicate — a finalized computer whose daemon is
 * offline is still `placeable`, but not available.
 */
export function computerUnavailableLabel(
  availability: HostAvailability | undefined,
): string | null {
  switch (availability) {
    case 'available':
      return null;
    case 'disconnected':
      return 'Offline';
    case 'unreachable':
      return 'Unreachable';
    case 'revoked':
      return 'Revoked';
    case undefined:
      return 'Checking…';
  }
}
