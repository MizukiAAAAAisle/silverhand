// Cross-language recurrence-policy parity gate.
//
// This is the SINGLE signer of the recurrence fixture. It imports the REAL
// production policy from `schedule-recurrence.ts` (the exact functions
// ScheduleService calls) and runs them over a shared set of cases; there is no
// second copy of the policy anywhere. The Rust port
// (rust/crates/backend-core/src/messaging/schedule/recurrence.rs) consumes the
// SAME cases + expected via the generated `recurrence_ts_fixture.rs`.
//
// Two artifacts are emitted from one run and checked in:
//   - __fixtures__/recurrence-policy-fixture.json — cases + production-signed
//                                        expected, consumed here (diffable).
//   - recurrence_ts_fixture.rs        — the identical data as Rust literals,
//                                        `include!`d by the Rust parity test.
//
// Drift is gated on every `vitest run` (no manual step in the loop):
//   1. Assert mode recomputes expected from the CURRENT production policy and
//      compares to the committed JSON — production drift without regeneration
//      goes red here.
//   2. The SAME run recomputes the Rust literals from production and asserts
//      the committed `.rs` is byte-identical — a hand-edit of the `.rs`
//      expected (even with a matching Rust impl change) goes red here, so the
//      two projections can never silently diverge.
//   3. The Rust parity test compares the Rust policy's output to the committed
//      `.rs` — Rust policy drift goes red there.
// Together: production is the SINGLE signer of both projections, and each
// projection is locked to it by an automated gate. `UPDATE_SCHEDULE_FIXTURE=1`
// is only how a legitimate change regenerates both artifacts, not the drift
// guard itself.
//
// The cron evaluator is NOT under test in this slice (real cron-parser / IANA
// timezone / DST is a separate integration seam). It is injected as a
// deterministic periodic evaluator identical to the Rust test's `SteppingCron`
// — `(after / step + 1) * step` — chosen so `*/N`-style expressions the real
// parser would emit coincide with it. The injection goes into the real
// production policy; the policy itself is never reimplemented.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ScheduleDto, ScheduleSpec } from '@silverhand/shared';
import {
  type CronNext,
  estimateMissedCount,
  planAdvancement,
  planFailureRearm,
} from '../../src/services/schedule-recurrence.js';

const JSON_FIXTURE = fileURLToPath(
  new URL('./__fixtures__/recurrence-policy-fixture.json', import.meta.url),
);
const RUST_FIXTURE = fileURLToPath(
  new URL(
    '../../../../rust/crates/backend-core/src/conversation_messaging/messaging/schedule/recurrence_ts_fixture.rs',
    import.meta.url,
  ),
);

/** A periodic cron evaluator identical to the Rust `SteppingCron`: the next
 *  multiple of `step` strictly greater than `after`. */
const steppingCronNext =
  (step: number): CronNext =>
  (_expr, _tz, after) =>
    (Math.floor(after / step) + 1) * step;

/** Case inputs. `cronStep` drives the injected periodic evaluator for `cron`
 *  cases; it is the sole source of truth for the case set. */
interface CaseInput {
  name: string;
  spec: ScheduleSpec;
  cronStep?: number;
  firedCount: number;
  maxOccurrences: number | null;
  untilAt: number | null;
  scheduledFireAt: number;
  actualFireAt: number;
}

const CASES: readonly CaseInput[] = [
  {
    name: 'once_terminal_no_missed',
    spec: { kind: 'once', fire_at: 1000 },
    firedCount: 0,
    maxOccurrences: null,
    untilAt: null,
    scheduledFireAt: 1000,
    actualFireAt: 5000,
  },
  {
    name: 'interval_on_time_rearm_from_actual',
    spec: { kind: 'interval', every_seconds: 60 },
    firedCount: 0,
    maxOccurrences: null,
    untilAt: null,
    scheduledFireAt: 100_000,
    actualFireAt: 100_000,
  },
  {
    name: 'interval_late_rearm_from_actual_missed_floor',
    spec: { kind: 'interval', every_seconds: 60 },
    firedCount: 3,
    maxOccurrences: null,
    untilAt: null,
    scheduledFireAt: 0,
    actualFireAt: 200_000,
  },
  {
    name: 'interval_max_occurrences_terminal',
    spec: { kind: 'interval', every_seconds: 60 },
    firedCount: 4,
    maxOccurrences: 5,
    untilAt: null,
    scheduledFireAt: 0,
    actualFireAt: 0,
  },
  {
    name: 'interval_until_overrun_terminal',
    spec: { kind: 'interval', every_seconds: 60 },
    firedCount: 0,
    maxOccurrences: null,
    untilAt: 120_000,
    scheduledFireAt: 100_000,
    actualFireAt: 100_000,
  },
  {
    name: 'cron_rearm_next_instant',
    spec: { kind: 'cron', expression: '*/5 * * * *', timezone: 'UTC' },
    cronStep: 300_000,
    firedCount: 0,
    maxOccurrences: null,
    untilAt: null,
    scheduledFireAt: 0,
    actualFireAt: 10_000,
  },
  {
    name: 'cron_late_missed_count_and_rearm',
    spec: { kind: 'cron', expression: '*/5 * * * *', timezone: 'UTC' },
    cronStep: 300_000,
    firedCount: 0,
    maxOccurrences: null,
    untilAt: null,
    scheduledFireAt: 0,
    actualFireAt: 1_000_000,
  },
  {
    name: 'cron_missed_count_caps_at_1000',
    spec: { kind: 'cron', expression: '* * * * *', timezone: 'UTC' },
    cronStep: 60_000,
    firedCount: 0,
    maxOccurrences: null,
    untilAt: null,
    scheduledFireAt: 0,
    // 1500 minutes late: real misses (1499) exceed the 1000 iteration cap.
    actualFireAt: 90_000_000,
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

type ExpAdv =
  | { kind: 'terminal'; missed: number }
  | { kind: 'rearm'; next: number; missed: number };
type ExpFail = { kind: 'rearm'; next: number } | { kind: 'terminal' } | { kind: 'once_no_retry' };

interface SignedCase {
  name: string;
  spec: ScheduleSpec;
  cronStep: number | null;
  firedCount: number;
  maxOccurrences: number | null;
  untilAt: number | null;
  scheduledFireAt: number;
  actualFireAt: number;
  expAdv: ExpAdv;
  expMissed: number;
  expFail: ExpFail;
}

/** Run the REAL production policy over a case and record its outputs. */
function sign(c: CaseInput): SignedCase {
  const dto = makeDto(c);
  const cronNext = steppingCronNext(c.cronStep ?? 1);

  const adv = planAdvancement(dto, c.actualFireAt, cronNext);
  const expAdv: ExpAdv = adv.terminal
    ? { kind: 'terminal', missed: adv.missedCount }
    : { kind: 'rearm', next: adv.nextFireAt as number, missed: adv.missedCount };

  const expMissed = estimateMissedCount(dto, c.actualFireAt, cronNext);

  let expFail: ExpFail;
  if (c.spec.kind === 'once') {
    expFail = { kind: 'once_no_retry' };
  } else {
    const fail = planFailureRearm(dto, c.actualFireAt, cronNext);
    expFail = fail.terminal ? { kind: 'terminal' } : { kind: 'rearm', next: fail.nextFireAt };
  }

  return {
    name: c.name,
    spec: c.spec,
    cronStep: c.cronStep ?? null,
    firedCount: c.firedCount,
    maxOccurrences: c.maxOccurrences,
    untilAt: c.untilAt,
    scheduledFireAt: c.scheduledFireAt,
    actualFireAt: c.actualFireAt,
    expAdv,
    expMissed,
    expFail,
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

function advLit(a: ExpAdv): string {
  return a.kind === 'terminal'
    ? `ExpAdv::Terminal { missed: ${a.missed} }`
    : `ExpAdv::Rearm { next: ${a.next}, missed: ${a.missed} }`;
}

function failLit(f: ExpFail): string {
  if (f.kind === 'once_no_retry') return 'ExpFail::OnceNoRetry';
  if (f.kind === 'terminal') return 'ExpFail::Terminal';
  return `ExpFail::Rearm { next: ${f.next} }`;
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
        exp_adv: ${advLit(c.expAdv)},
        exp_missed: ${c.expMissed},
        exp_fail: ${failLit(c.expFail)},
    },`,
    )
    .join('\n');
  return `// @generated by packages/backend/tests/services/schedule-recurrence.parity.test.ts
// Signed by the REAL production TS policy (schedule-recurrence.ts) — DO NOT
// EDIT BY HAND. Regenerate: UPDATE_SCHEDULE_FIXTURE=1 pnpm --filter @silverhand/backend
// exec vitest run tests/services/schedule-recurrence.parity.test.ts
&[
${rows}
]
`;
}

// --- the gate --------------------------------------------------------------

describe('recurrence policy parity fixture', () => {
  const signed = CASES.map(sign);

  if (process.env.UPDATE_SCHEDULE_FIXTURE === '1') {
    it('regenerates the checked-in fixtures from production', () => {
      writeFileSync(JSON_FIXTURE, `${JSON.stringify(signed, null, 2)}\n`);
      writeFileSync(RUST_FIXTURE, renderRust(signed));
    });
    return;
  }

  it('the committed JSON fixture exists', () => {
    expect(existsSync(JSON_FIXTURE), 'run with UPDATE_SCHEDULE_FIXTURE=1 to generate it').toBe(
      true,
    );
  });

  it('production policy still matches the committed fixture (no undetected drift)', () => {
    const committed = JSON.parse(readFileSync(JSON_FIXTURE, 'utf8')) as SignedCase[];
    expect(signed).toEqual(committed);
  });

  it('committed Rust fixture is byte-identical to the production-signed literals', () => {
    // The Rust gate consumes ONLY the `.rs`. Without this assertion a hand-edit
    // of the `.rs` expected (with a matching Rust impl change) would leave both
    // the JSON/production gate here AND the Rust gate green while the two
    // projections silently diverge. Recomputing `renderRust(signed)` from the
    // CURRENT production policy every run makes production the single signer of
    // BOTH projections and locks them byte-for-byte — no manual regen needed to
    // catch drift.
    expect(readFileSync(RUST_FIXTURE, 'utf8')).toBe(renderRust(signed));
  });
});
