// Pure settlement policy for agent schedules — the single authority for
// "a claimed fire has now either delivered or failed; which durable write
// settles it". It sits one layer above the recurrence policy: it composes
// `planAdvancement` (already computed for the wake body) and `planFailureRearm`
// into the exact write the durable store must apply, and nothing else.
//
// Extracted from ScheduleService.processOne so BOTH the production service AND
// the cross-language parity gate call the exact same function; no second copy
// of this decision exists (a reimplementation would be a self-signing oracle).
// The function is pure: it returns a `SettlementAction` describing WHICH write
// to apply. Performing the CAS write (claim → apply, each predicated on
// `status='firing'`), delivering the wake, and the sweep/timer driver are all
// separate seams the service owns; this module never touches the DB or clock.
//
// The Rust port of this exact decision is
// rust/crates/backend-core/src/messaging/schedule/settlement.rs; the two are
// kept in lockstep by a checked-in fixture that the TS gate signs (by running
// THIS function) and the Rust gate consumes.

import type { ScheduleDto } from '@silverhand/shared';
import { type Advancement, type CronNext, planFailureRearm } from './schedule-recurrence.js';

/** The result of attempting the wake delivery for a claimed fire. */
export type DeliveryOutcome = { kind: 'delivered' } | { kind: 'failed'; reason: string };

/** The durable write that settles a claimed (`firing`) fire. Each maps 1:1 to
 *  a `status='firing'`-predicated CAS in the schedule repo:
 *   - `mark_done`        → firing→done      (terminal SUCCESS: delivered final fire)
 *   - `rearm`            → firing→pending    (repeat success; advance to `nextFireAt`)
 *   - `mark_failed`      → firing→failed     (one-shot delivery failure; no retry)
 *   - `mark_fire_failed` → firing→pending    (repeat delivery failure; record + re-arm)
 *   - `mark_plan_ended_after_failure` → firing→done
 *        (repeat delivery FAILED and the next tick is past the plan window: the
 *         plan is over so the terminal state is `done`, but the fire did not
 *         succeed — recorded honestly, without counting an occurrence). */
export type SettlementAction =
  | { kind: 'mark_done' }
  | { kind: 'rearm'; nextFireAt: number }
  | { kind: 'mark_failed'; reason: string }
  | { kind: 'mark_fire_failed'; reason: string; nextFireAt: number }
  | { kind: 'mark_plan_ended_after_failure'; reason: string };

/**
 * Decide the settlement write for a claimed fire. Pure: no DB, no clock.
 *
 * `advancement` is the SUCCESS-path plan already computed before delivery (the
 * wake body needs its `nextFireAt`/`missedCount`); it is reused verbatim on the
 * delivered path. On the failed path the success plan is irrelevant:
 *   - `once` has no future fire to retry → terminal `mark_failed`.
 *   - `cron|interval` must not die on a single bad tick → `planFailureRearm`
 *     decides between natural plan-end (`until_at` overrun →
 *     `mark_plan_ended_after_failure`: terminal `done`, but the failed fire is
 *     recorded honestly rather than counted as a success) and re-arm on the
 *     next cadence tick (`mark_fire_failed`). `max_occurrences` is deliberately
 *     not consulted for a failed fire (see `planFailureRearm`).
 */
export function planSettlement(
  dto: ScheduleDto,
  actualFireAt: number,
  advancement: Advancement,
  outcome: DeliveryOutcome,
  cronNext: CronNext,
): SettlementAction {
  if (outcome.kind === 'delivered') {
    return advancement.terminal
      ? { kind: 'mark_done' }
      : // planAdvancement only returns terminal:false with a concrete number.
        { kind: 'rearm', nextFireAt: advancement.nextFireAt as number };
  }
  if (dto.spec.kind === 'once') {
    return { kind: 'mark_failed', reason: outcome.reason };
  }
  const failureRearm = planFailureRearm(dto, actualFireAt, cronNext);
  return failureRearm.terminal
    ? { kind: 'mark_plan_ended_after_failure', reason: outcome.reason }
    : { kind: 'mark_fire_failed', reason: outcome.reason, nextFireAt: failureRearm.nextFireAt };
}
