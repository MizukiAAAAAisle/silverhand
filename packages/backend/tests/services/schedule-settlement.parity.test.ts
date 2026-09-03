// Cross-language settlement-policy parity gate.
//
// This is the SINGLE signer of the settlement fixture. It imports the REAL
// production decision `planSettlement` (the exact function ScheduleService
// calls after a fire delivers or fails) plus `planAdvancement` (whose output
// planSettlement consumes), runs them over a shared set of cases, and there is
// no second copy of the decision anywhere. The Rust port
// (rust/crates/backend-core/src/messaging/schedule/settlement.rs) consumes the
// SAME cases + expected via the generated `settlement_ts_fixture.rs`.
//
// Two artifacts are emitted from one run and checked in:
//   - __fixtures__/settlement-policy-fixture.json — cases + production-signed
//                                        expected, consumed here (diffable).
//   - settlement_ts_fixture.rs        — the identical data as Rust literals,
//                                        `include!`d by the Rust parity test.
//
// Drift is gated on every `vitest run` (no manual step in the loop):
//   1. Assert mode recomputes expected from the CURRENT production decision and
//      compares to the committed JSON — production drift goes red here.
//   2. The SAME run recomputes the Rust literals and asserts the committed
//      `.rs` is byte-identical — a hand-edit of the `.rs` (even with a matching
//      Rust change) goes red here, so the two projections can never diverge.
//   3. The Rust parity test compares the Rust decision's output to the
//      committed `.rs` — Rust drift goes red there.
// `UPDATE_SETTLEMENT_FIXTURE=1` is how a legitimate change regenerates both
// artifacts, not the drift guard itself.
//
// The cron evaluator is injected as the same deterministic periodic evaluator
// the Rust test uses (`(after / step + 1) * step`); the real cron-parser / IANA
// / DST evaluator stays a separate integration seam. The injection goes into
// the real production policy; the policy is never reimplemented.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ScheduleDto, ScheduleSpec } from '@silverhand/shared';
import { type CronNext, planAdvancement } from '../../src/services/schedule-recurrence.js';
import { type DeliveryOutcome, planSettlement } from '../../src/services/schedule-settlement.js';

const JSON_FIXTURE = fileURLToPath(
  new URL('./__fixtures__/settlement-policy-fixture.json', import.meta.url),
);
const RUST_FIXTURE = fileURLToPath(
  new URL(
    '../../../../rust/crates/backend-core/src/conversation_messaging/messaging/schedule/settlement_ts_fixture.rs',
    import.meta.url,
  ),
);

/** A periodic cron evaluator identical to the Rust `SteppingCron`: the next
 *  multiple of `step` strictly greater than `after`. */
const steppingCronNext =
  (step: number): CronNext =>
  (_expr, _tz, after) =>
    (Math.floor(after / step) + 1) * step;

interface CaseInput {
  name: string;
  spec: ScheduleSpec;
  cronStep?: number;
  firedCount: number;
  maxOccurrences: number | null;
  untilAt: number | null;
  scheduledFireAt: number;
  actualFireAt: number;
  outcome: DeliveryOutcome;
}

const REASON = 'wake delivery failed';

const CASES: readonly CaseInput[] = [
  {
    name: 'delivered_once_marks_done',
    spec: { kind: 'once', fire_at: 1000 },
    firedCount: 0,
    maxOccurrences: null,
    untilAt: null,
    scheduledFireAt: 1000,
    actualFireAt: 5000,
    outcome: { kind: 'delivered' },
  },
  {
    name: 'delivered_interval_rearms',
    spec: { kind: 'interval', every_seconds: 60 },
    firedCount: 0,
    maxOccurrences: null,
    untilAt: null,
    scheduledFireAt: 100_000,
    actualFireAt: 100_000,
    outcome: { kind: 'delivered' },
  },
  {
    name: 'delivered_interval_max_reached_marks_done',
    spec: { kind: 'interval', every_seconds: 60 },
    firedCount: 4,
    maxOccurrences: 5,
    untilAt: null,
    scheduledFireAt: 0,
    actualFireAt: 0,
    outcome: { kind: 'delivered' },
  },
  {
    name: 'delivered_cron_rearms',
    spec: { kind: 'cron', expression: '*/5 * * * *', timezone: 'UTC' },
    cronStep: 300_000,
    firedCount: 0,
    maxOccurrences: null,
    untilAt: null,
    scheduledFireAt: 0,
    actualFireAt: 10_000,
    outcome: { kind: 'delivered' },
  },
  {
    name: 'failed_once_marks_failed',
    spec: { kind: 'once', fire_at: 1000 },
    firedCount: 0,
    maxOccurrences: null,
    untilAt: null,
    scheduledFireAt: 1000,
    actualFireAt: 5000,
    outcome: { kind: 'failed', reason: REASON },
  },
  {
    name: 'failed_interval_rearms_fire_failed',
    spec: { kind: 'interval', every_seconds: 60 },
    firedCount: 2,
    maxOccurrences: null,
    untilAt: null,
    scheduledFireAt: 100_000,
    actualFireAt: 100_000,
    outcome: { kind: 'failed', reason: REASON },
  },
  {
    name: 'failed_interval_until_exhausted_marks_plan_ended',
    spec: { kind: 'interval', every_seconds: 60 },
    firedCount: 0,
    maxOccurrences: null,
    untilAt: 120_000,
    scheduledFireAt: 100_000,
    actualFireAt: 100_000,
    outcome: { kind: 'failed', reason: REASON },
  },
  {
    name: 'failed_cron_rearms_fire_failed',
    spec: { kind: 'cron', expression: '*/5 * * * *', timezone: 'UTC' },
    cronStep: 300_000,
    firedCount: 0,
    maxOccurrences: null,
    untilAt: null,
    scheduledFireAt: 0,
    actualFireAt: 10_000,
    outcome: { kind: 'failed', reason: REASON },
  },
  {
    name: 'failed_cron_until_exhausted_marks_plan_ended',
    spec: { kind: 'cron', expression: '*/5 * * * *', timezone: 'UTC' },
    cronStep: 300_000,
    firedCount: 0,
    maxOccurrences: null,
    untilAt: 120_000,
    scheduledFireAt: 0,
    actualFireAt: 10_000,
    outcome: { kind: 'failed', reason: REASON },
  },
];

/** Build a full ScheduleDto from the case's policy-relevant fields; the rest
 *  are inert placeholders the policy never reads. */
function makeDto(c: CaseInput): ScheduleDto {
  return {
    id: c.name,
    owner_agent_id: 'agent',
    target_conversation_id: 'conv',
    target_label: '#x',
    title: 't',
    message: 'm',
    spec: c.spec,
    next_fire_at: c.scheduledFireAt,
    status: 'firing',
    fired_count: c.firedCount,
    last_fired_at: null,
    max_occurrences: c.maxOccurrences,
    until_at: c.untilAt,
    failure_reason: null,
    cancelled_at: null,
    last_failure_reason: null,
    last_failure_at: null,
    consecutive_failure_count: 0,
    created_at: 0,
    updated_at: 0,
  };
}

type ExpAction =
  | { kind: 'mark_done' }
  | { kind: 'rearm'; nextFireAt: number }
  | { kind: 'mark_failed'; reason: string }
  | { kind: 'mark_fire_failed'; reason: string; nextFireAt: number }
  | { kind: 'mark_plan_ended_after_failure'; reason: string };

interface SignedCase {
  name: string;
  spec: ScheduleSpec;
  cronStep: number | null;
  firedCount: number;
  maxOccurrences: number | null;
  untilAt: number | null;
  scheduledFireAt: number;
  actualFireAt: number;
  delivered: boolean;
  reason: string;
  expAction: ExpAction;
}

/** Run the REAL production decision over a case and record its output. The
 *  success plan is computed exactly as ScheduleService does (before delivery)
 *  and fed into planSettlement. */
function sign(c: CaseInput): SignedCase {
  const dto = makeDto(c);
  const cronNext = steppingCronNext(c.cronStep ?? 1);
  const advancement = planAdvancement(dto, c.actualFireAt, cronNext);
  const expAction = planSettlement(dto, c.actualFireAt, advancement, c.outcome, cronNext);
  return {
    name: c.name,
    spec: c.spec,
    cronStep: c.cronStep ?? null,
    firedCount: c.firedCount,
    maxOccurrences: c.maxOccurrences,
    untilAt: c.untilAt,
    scheduledFireAt: c.scheduledFireAt,
    actualFireAt: c.actualFireAt,
    delivered: c.outcome.kind === 'delivered',
    reason: c.outcome.kind === 'failed' ? c.outcome.reason : '',
    expAction,
  };
}

// --- Rust fixture emission -------------------------------------------------

const opt = (v: number | null): string => (v === null ? 'None' : `Some(${v})`);

function kindLit(c: SignedCase): string {
  if (c.spec.kind === 'once') return `Kind::Once { fire_at: ${c.spec.fire_at} }`;
  if (c.spec.kind === 'interval') {
    return `Kind::Interval { every_seconds: ${c.spec.every_seconds} }`;
  }
  return `Kind::Cron { step: ${c.cronStep} }`;
}

function actionLit(a: ExpAction): string {
  switch (a.kind) {
    case 'mark_done':
      return 'ExpAction::MarkDone';
    case 'rearm':
      return `ExpAction::Rearm { next: ${a.nextFireAt} }`;
    case 'mark_failed':
      return `ExpAction::MarkFailed { reason: ${JSON.stringify(a.reason)} }`;
    case 'mark_fire_failed':
      return `ExpAction::MarkFireFailed { reason: ${JSON.stringify(a.reason)}, next: ${a.nextFireAt} }`;
    case 'mark_plan_ended_after_failure':
      return `ExpAction::MarkPlanEndedAfterFailure { reason: ${JSON.stringify(a.reason)} }`;
  }
}

function renderRust(signed: readonly SignedCase[]): string {
  const rows = signed
    .map(
      (c) => `    Case {
        name: ${JSON.stringify(c.name)},
        kind: ${kindLit(c)},
        max_occ: ${opt(c.maxOccurrences)},
        until_at: ${opt(c.untilAt)},
        fired_count: ${c.firedCount},
        scheduled_fire_at: ${c.scheduledFireAt},
        actual_fire_at: ${c.actualFireAt},
        delivered: ${c.delivered},
        reason: ${JSON.stringify(c.reason)},
        exp_action: ${actionLit(c.expAction)},
    },`,
    )
    .join('\n');
  return `// @generated by packages/backend/tests/services/schedule-settlement.parity.test.ts
// Signed by the REAL production TS decision (schedule-settlement.ts) — DO NOT
// EDIT BY HAND. Regenerate: UPDATE_SETTLEMENT_FIXTURE=1 pnpm --filter @silverhand/backend
// exec vitest run tests/services/schedule-settlement.parity.test.ts
&[
${rows}
]
`;
}

// --- the gate --------------------------------------------------------------

describe('settlement policy parity fixture', () => {
  const signed = CASES.map(sign);

  if (process.env.UPDATE_SETTLEMENT_FIXTURE === '1') {
    it('regenerates the checked-in fixtures from production', () => {
      writeFileSync(JSON_FIXTURE, `${JSON.stringify(signed, null, 2)}\n`);
      writeFileSync(RUST_FIXTURE, renderRust(signed));
    });
    return;
  }

  it('the committed JSON fixture exists', () => {
    expect(existsSync(JSON_FIXTURE), 'run with UPDATE_SETTLEMENT_FIXTURE=1 to generate it').toBe(
      true,
    );
  });

  it('production decision still matches the committed fixture (no undetected drift)', () => {
    const committed = JSON.parse(readFileSync(JSON_FIXTURE, 'utf8')) as SignedCase[];
    expect(signed).toEqual(committed);
  });

  it('committed Rust fixture is byte-identical to the production-signed literals', () => {
    expect(readFileSync(RUST_FIXTURE, 'utf8')).toBe(renderRust(signed));
  });
});
