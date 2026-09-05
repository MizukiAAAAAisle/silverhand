// Pure recurrence policy for agent schedules — the single authority for
// "given a fired occurrence, does this schedule terminate or rearm, and to
// what next instant". Extracted from ScheduleService so BOTH the production
// service AND the cross-language parity gate call the exact same functions;
// nothing may hold a second copy of this logic (a reimplementation would be
// a self-signing oracle, not a parity check).
//
// This module is intentionally pure and dependency-light: it imports only the
// shared DTO type. The one impurity a cron schedule needs — turning an
// expression + timezone + instant into the next occurrence — is an INJECTED
// port (`CronNext`), never reached for directly here. The production evaluator
// (cron-parser / Intl timezone) lives in ScheduleService and is passed in; the
// Rust port + its real evaluator are the mirror of that same seam. Keeping the
// evaluator external is what lets a deterministic test evaluator be injected
// into the real policy without reimplementing the policy.
//
// The Rust port of this exact policy is
// rust/crates/backend-core/src/messaging/schedule/recurrence.rs; the two are
// kept in lockstep by a checked-in fixture that the TS gate signs (by running
// THESE functions) and the Rust gate consumes.

import type { ScheduleDto } from '@silverhand/shared';

/** The outcome of a SUCCESSFUL fire. */
export interface Advancement {
  /** True when this fire ends the schedule (one-shot; or repeat that hit
   *  `max_occurrences` / would cross `until_at`). */
  terminal: boolean;
  /** When the next fire will land. Null for terminal fires. */
  nextFireAt: number | null;
  /** Planned occurrences skipped while late, NOT counting the current
   *  catch-up fire. 0 for on-time fires and one-shots. */
  missedCount: number;
}

/** Injected cron evaluator: the next occurrence strictly after `after`, read
 *  in `timezone`. Throws when the expression/timezone is invalid. The policy
 *  never parses cron itself — this port is the only door to the evaluator,
 *  which is a separate integration seam (production: cron-parser; parity gate:
 *  a deterministic periodic evaluator). */
export type CronNext = (expression: string, timezone: string, after: number) => number;

/** `fromTime + everySeconds * 1000`. Pure arithmetic; interval cadence never
 *  consults the cron port. */
export function computeIntervalNext(everySeconds: number, fromTime: number): number {
  return fromTime + everySeconds * 1000;
}

/** Compute what should happen after a successful fire — terminal `done` vs
 *  pending-with-rearm — plus the next fire time. Pure: no DB writes.
 *
 *  - `once` → terminal, no missed occurrences.
 *  - repeat → increment the count; if `max_occurrences` is reached, terminal;
 *    else compute the next cadence instant; if it overruns `until_at`,
 *    terminal; else rearm. The caps are independent — either ends the run. */
export function planAdvancement(
  dto: ScheduleDto,
  actualFireAt: number,
  cronNext: CronNext,
): Advancement {
  if (dto.spec.kind === 'once') {
    return { terminal: true, nextFireAt: null, missedCount: 0 };
  }
  const newCount = dto.fired_count + 1;
  if (dto.max_occurrences !== null && newCount >= dto.max_occurrences) {
    return {
      terminal: true,
      nextFireAt: null,
      missedCount: estimateMissedCount(dto, actualFireAt, cronNext),
    };
  }
  let nextFireAt: number;
  if (dto.spec.kind === 'interval') {
    nextFireAt = computeIntervalNext(dto.spec.every_seconds, actualFireAt);
  } else {
    nextFireAt = cronNext(dto.spec.expression, dto.spec.timezone, actualFireAt);
  }
  if (dto.until_at !== null && nextFireAt > dto.until_at) {
    return {
      terminal: true,
      nextFireAt: null,
      missedCount: estimateMissedCount(dto, actualFireAt, cronNext),
    };
  }
  return {
    terminal: false,
    nextFireAt,
    missedCount: estimateMissedCount(dto, actualFireAt, cronNext),
  };
}

/**
 * Compute the next-fire transition for a `cron|interval` schedule whose
 * current fire FAILED. Mirrors `planAdvancement` for the success path, with
 * two differences:
 *
 *   - `max_occurrences` is intentionally NOT consulted. The failed fire
 *     didn't increment `fired_count`, so the plan still owes that occurrence;
 *     retry on the natural next tick rather than terminate.
 *   - `until_at` IS consulted. It's a wall-clock deadline; once past, no
 *     future tick is possible regardless of failure history, so the schedule
 *     terminates as `done`.
 *
 * The caller never invokes this for `kind:'once'` (those terminate via
 * `markFailed`); the branch throws rather than silently returning a default.
 */
export function planFailureRearm(
  dto: ScheduleDto,
  actualFireAt: number,
  cronNext: CronNext,
): { terminal: true; nextFireAt: null } | { terminal: false; nextFireAt: number } {
  if (dto.spec.kind === 'once') {
    throw new Error(
      'planFailureRearm: caller must route kind:once through markFailed, not here',
    );
  }
  let nextFireAt: number;
  if (dto.spec.kind === 'interval') {
    nextFireAt = computeIntervalNext(dto.spec.every_seconds, actualFireAt);
  } else {
    nextFireAt = cronNext(dto.spec.expression, dto.spec.timezone, actualFireAt);
  }
  if (dto.until_at !== null && nextFireAt > dto.until_at) {
    return { terminal: true, nextFireAt: null };
  }
  return { terminal: false, nextFireAt };
}

/**
 * How many planned occurrences were skipped while late, NOT counting the
 * current catch-up fire. For interval this is exact; for cron it iterates the
 * evaluator; for `once` it's always 0. A hint for the agent, bounded to keep
 * cron iteration cheap.
 *
 * The cron iteration is wrapped in one try/catch: ANY evaluator fault (or an
 * expression that stopped parsing between create and fire) discards the
 * partial and yields 0 — a hint never crashes a wake or half-reports.
 */
export function estimateMissedCount(
  dto: ScheduleDto,
  actualFireAt: number,
  cronNext: CronNext,
): number {
  if (dto.spec.kind === 'once') return 0;
  const delta = actualFireAt - dto.next_fire_at;
  if (delta <= 0) return 0;
  if (dto.spec.kind === 'interval') {
    // floor(delta/every) full intervals elapsed; the current fire covers the
    // original `dto.next_fire_at`, so the EXTRA misses are floor(delta/every).
    const everyMs = dto.spec.every_seconds * 1000;
    return Math.floor(delta / everyMs);
  }
  // cron: iterate occurrences strictly between (next_fire_at, actualFireAt),
  // hard-capped so a huge delta can't run away.
  try {
    let count = 0;
    const cap = 1000;
    let cursor = dto.next_fire_at;
    while (count < cap) {
      const occ = cronNext(dto.spec.expression, dto.spec.timezone, cursor);
      if (occ >= actualFireAt) break;
      count++;
      cursor = occ;
    }
    return count;
  } catch {
    return 0;
  }
}
