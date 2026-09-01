//! Pure recurrence policy: given a fired occurrence, decide whether a
//! schedule terminates or rearms, and to what next instant.
//!
//! Every decision here mirrors the TypeScript schedule service's
//! `planAdvancement` / `planFailureRearm` / `estimateMissedCount` exactly —
//! this is a contract-parity port, not a re-derivation. Three rules make the
//! parity legible:
//!
//! - **Rearm from the ACTUAL fire instant, not the stale scheduled time.**
//!   A late fire advances by one cadence step from when it really fired
//!   (single catch-up), never a backfill of every missed tick.
//! - **`missed_count` is an agent-facing hint, never a control signal.** It
//!   counts occurrences skipped while late; nothing branches on it, and any
//!   cron fault/exhaustion mid-count discards the partial and yields 0 (the
//!   TS iteration is wrapped in one try/catch → 0; a hint never crashes or
//!   half-reports settlement).
//! - **Arithmetic never panics or wraps, and a non-advancing evaluator is
//!   rejected.** Epoch/count math is checked and surfaces a typed internal
//!   [`PolicyFault`] rather than a debug panic or a release wrap; a cron
//!   evaluator that answers with an instant `<= after` is a contract
//!   violation ([`PolicyFault::NonAdvancingCron`]), caught here rather than
//!   trusted, so a buggy adapter cannot manufacture a past rearm.
//!
//! Computing a cron instant is delegated to [`CronNextOccurrence`], a
//! consumer-language evaluator port. The real implementation and any
//! cron/timezone crate are a separate integration seam; this crate depends
//! only on the trait. The wall clock (current instant) is a different port
//! entirely and is never merged into this one.

use super::spec::{FiredCount, IntervalSeconds, ScheduleCaps, ScheduleSpec};

/// A cron evaluation request. `after` is EXCLUSIVE: the answer is the first
/// occurrence strictly greater than `after`.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CronQuery<'a> {
    pub expression: &'a str,
    pub timezone: &'a str,
    pub after: i64,
}

/// The outcome of evaluating a cron expression. The invalid arms are kept
/// distinct rather than folded into one error so the settlement path can
/// tell "this expression is malformed" from "this timezone is unknown" from
/// "this cron simply has no further occurrence".
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CronOutcome {
    /// Epoch-ms of the next occurrence strictly after the query's `after`.
    NextInstant(i64),
    NoFutureOccurrence,
    InvalidExpression,
    InvalidTimezone,
}

/// Consumer-language evaluator: the next cron instant strictly after a given
/// time, in a given timezone.
///
/// This crate defines the port; the real implementation (and the cron/tz
/// crate it needs) is a Cindy-owned integration seam. It is deliberately NOT
/// a `Clock`: a `Clock` answers "what time is it now", this answers "when
/// does this expression next fire after T". The two never merge.
pub trait CronNextOccurrence {
    fn next_after(&self, query: CronQuery<'_>) -> CronOutcome;
}

/// A domain outcome that prevents computing a next cadence instant. Only
/// reachable for `cron` specs — `interval` cadence never faults this way.
/// Routes to the schedule's fire-failure handling, NOT to a 500.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum CadenceFault {
    #[error("cron expression has no further occurrence")]
    NoFutureOccurrence,
    #[error("cron expression is invalid")]
    InvalidExpression,
    #[error("cron timezone is invalid")]
    InvalidTimezone,
}

/// An internal corruption or evaluator-contract violation. NOT reachable
/// with validated domain values and a correct evaluator; routes to a
/// safe-500, never to an agent-facing product error.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum PolicyFault {
    #[error("schedule cadence arithmetic overflowed")]
    ArithmeticOverflow,
    #[error("cron evaluator returned a non-advancing instant (<= after)")]
    NonAdvancingCron,
}

/// Why a next-cadence computation failed: either a domain cadence outcome or
/// an internal policy fault. The two are kept distinct so the caller routes
/// a cadence fault to fire-failure and a policy fault to a safe-500.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum AdvanceError {
    #[error(transparent)]
    Cadence(#[from] CadenceFault),
    #[error(transparent)]
    Policy(#[from] PolicyFault),
}

/// The outcome of a SUCCESSFUL fire.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Advancement {
    /// The schedule is complete: `once` always, or a repeat that hit a cap.
    Terminal { missed_count: i64 },
    /// The schedule rearms to fire again at `next_fire_at`.
    Rearm {
        next_fire_at: i64,
        missed_count: i64,
    },
}

/// The outcome of a FAILED fire for a repeating schedule. `once` is not
/// representable here — a one-shot failure is terminal and is routed by the
/// caller, never through this function ([`FailureRearmError::OnceHasNoRetry`]).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FailureRearm {
    /// `until_at` overrun: the row settles terminal (done) even on failure.
    Terminal,
    /// Rearm on the natural cadence; the row stays live and re-fires.
    Rearm { next_fire_at: i64 },
}

/// Why a failure rearm could not be planned.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum FailureRearmError {
    #[error("a `once` schedule has no failure retry; it terminates as failed")]
    OnceHasNoRetry,
    #[error(transparent)]
    Advance(#[from] AdvanceError),
}

/// Plan the state transition after a successful fire.
///
/// - `once` → terminal, no missed occurrences.
/// - repeat → increment the count; if `max_occurrences` is reached, terminal;
///   else compute the next cadence instant; if it overruns `until_at`,
///   terminal; else rearm. The caps are independent — either ends the run.
///
/// `scheduled_fire_at` is the row's stored `next_fire_at` (the tick this fire
/// was FOR); `actual_fire_at` is when it really fired. Both feed the missed
/// count and the rearm base.
pub fn plan_advancement<C: CronNextOccurrence>(
    spec: &ScheduleSpec,
    caps: ScheduleCaps,
    fired_count: FiredCount,
    scheduled_fire_at: i64,
    actual_fire_at: i64,
    cron: &C,
) -> Result<Advancement, AdvanceError> {
    if !spec.is_repeating() {
        return Ok(Advancement::Terminal { missed_count: 0 });
    }
    let new_count = fired_count
        .get()
        .checked_add(1)
        .ok_or(PolicyFault::ArithmeticOverflow)?;
    if let Some(max) = caps.max_occurrences()
        && new_count >= max
    {
        return Ok(Advancement::Terminal {
            missed_count: estimate_missed_count(spec, scheduled_fire_at, actual_fire_at, cron),
        });
    }
    let next_fire_at = next_repeat_instant(spec, actual_fire_at, cron)?;
    if let Some(until) = caps.until_at()
        && next_fire_at > until
    {
        return Ok(Advancement::Terminal {
            missed_count: estimate_missed_count(spec, scheduled_fire_at, actual_fire_at, cron),
        });
    }
    Ok(Advancement::Rearm {
        next_fire_at,
        missed_count: estimate_missed_count(spec, scheduled_fire_at, actual_fire_at, cron),
    })
}

/// Plan the state transition after a FAILED fire for a repeating schedule.
///
/// `max_occurrences` is NOT consulted (a failed fire did not consume a
/// successful occurrence); `until_at` IS consulted (an overrun still ends the
/// run). `once` is rejected: its failure is terminal and routed elsewhere.
pub fn plan_failure_rearm<C: CronNextOccurrence>(
    spec: &ScheduleSpec,
    caps: ScheduleCaps,
    actual_fire_at: i64,
    cron: &C,
) -> Result<FailureRearm, FailureRearmError> {
    if !spec.is_repeating() {
        return Err(FailureRearmError::OnceHasNoRetry);
    }
    let next_fire_at = next_repeat_instant(spec, actual_fire_at, cron)?;
    if let Some(until) = caps.until_at()
        && next_fire_at > until
    {
        return Ok(FailureRearm::Terminal);
    }
    Ok(FailureRearm::Rearm { next_fire_at })
}

/// How many planned occurrences were skipped between the tick this fire was
/// for and when it actually fired. An agent-facing hint only.
///
/// - `once` → always 0.
/// - `interval` → floor(delta / everyMs) for a positive delta, else 0.
/// - `cron` → iterate occurrences strictly between the scheduled and actual
///   instants, capped at 1000. Mirrors the TS try/catch: **any** fault,
///   exhaustion, or non-advancing answer discards the partial and yields 0;
///   only a clean stop (the next occurrence is at/after `actual_fire_at`) or
///   the 1000 cap returns a positive count.
pub fn estimate_missed_count<C: CronNextOccurrence>(
    spec: &ScheduleSpec,
    scheduled_fire_at: i64,
    actual_fire_at: i64,
    cron: &C,
) -> i64 {
    let Some(delta) = actual_fire_at.checked_sub(scheduled_fire_at) else {
        return 0;
    };
    if delta <= 0 {
        return 0;
    }
    match spec {
        ScheduleSpec::Once { .. } => 0,
        ScheduleSpec::Interval { every, .. } => match every.get().checked_mul(1000) {
            Some(every_ms) if every_ms > 0 => delta / every_ms,
            _ => 0,
        },
        ScheduleSpec::Cron(c) => {
            const CAP: i64 = 1000;
            let mut count = 0;
            let mut cursor = scheduled_fire_at;
            while count < CAP {
                match cron.next_after(CronQuery {
                    expression: c.expression(),
                    timezone: c.timezone(),
                    after: cursor,
                }) {
                    // Non-advancing answer is a contract violation; in a
                    // hint, discard rather than loop or over-count.
                    CronOutcome::NextInstant(occ) if occ <= cursor => return 0,
                    // Clean stop: the next occurrence is not before the fire.
                    CronOutcome::NextInstant(occ) if occ >= actual_fire_at => return count,
                    CronOutcome::NextInstant(occ) => {
                        count += 1;
                        cursor = occ;
                    }
                    // Fault or exhaustion mid-count → 0 (TS catch semantics).
                    CronOutcome::NoFutureOccurrence
                    | CronOutcome::InvalidExpression
                    | CronOutcome::InvalidTimezone => return 0,
                }
            }
            CAP
        }
    }
}

/// The next cadence instant for a repeating spec, rearmed from
/// `actual_fire_at`. Interval is checked arithmetic; cron delegates to the
/// evaluator and rejects a non-advancing answer. Never called for `once` —
/// callers route it before reaching here.
fn next_repeat_instant<C: CronNextOccurrence>(
    spec: &ScheduleSpec,
    actual_fire_at: i64,
    cron: &C,
) -> Result<i64, AdvanceError> {
    match spec {
        ScheduleSpec::Interval { every, .. } => {
            let next = checked_interval_next(actual_fire_at, *every)?;
            Ok(next)
        }
        ScheduleSpec::Cron(c) => match cron.next_after(CronQuery {
            expression: c.expression(),
            timezone: c.timezone(),
            after: actual_fire_at,
        }) {
            CronOutcome::NextInstant(next) if next > actual_fire_at => Ok(next),
            // A correct evaluator honors exclusive-`after`; anything at or
            // before it is an ACL violation, not a legal rearm.
            CronOutcome::NextInstant(_) => Err(PolicyFault::NonAdvancingCron.into()),
            CronOutcome::NoFutureOccurrence => Err(CadenceFault::NoFutureOccurrence.into()),
            CronOutcome::InvalidExpression => Err(CadenceFault::InvalidExpression.into()),
            CronOutcome::InvalidTimezone => Err(CadenceFault::InvalidTimezone.into()),
        },
        ScheduleSpec::Once { .. } => {
            unreachable!("callers route `once` to a terminal state before computing a cadence")
        }
    }
}

/// `actual_fire_at + every_seconds * 1000`, checked at every step.
fn checked_interval_next(actual_fire_at: i64, every: IntervalSeconds) -> Result<i64, PolicyFault> {
    let every_ms = every
        .get()
        .checked_mul(1000)
        .ok_or(PolicyFault::ArithmeticOverflow)?;
    actual_fire_at
        .checked_add(every_ms)
        .ok_or(PolicyFault::ArithmeticOverflow)
}

#[cfg(test)]
mod tests {
    use super::super::spec::CronSpec;
    use super::*;

    /// A cron evaluator whose occurrences are a fixed step from the query
    /// base — enough to exercise the policy without a real parser.
    struct SteppingCron {
        step_ms: i64,
    }

    impl CronNextOccurrence for SteppingCron {
        fn next_after(&self, query: CronQuery<'_>) -> CronOutcome {
            // First multiple of `step_ms` strictly greater than `after`.
            let next = (query.after / self.step_ms + 1) * self.step_ms;
            CronOutcome::NextInstant(next)
        }
    }

    /// A cron evaluator that always answers with one fixed outcome.
    struct FixedCron(CronOutcome);

    impl CronNextOccurrence for FixedCron {
        fn next_after(&self, _query: CronQuery<'_>) -> CronOutcome {
            self.0
        }
    }

    /// A cron evaluator that yields a scripted sequence of outcomes, one per
    /// call. Used to drive partial-then-fault paths a real parser can't.
    struct ScriptedCron {
        outcomes: std::cell::RefCell<std::collections::VecDeque<CronOutcome>>,
    }

    impl ScriptedCron {
        fn new(outcomes: Vec<CronOutcome>) -> Self {
            Self {
                outcomes: std::cell::RefCell::new(outcomes.into()),
            }
        }
    }

    impl CronNextOccurrence for ScriptedCron {
        fn next_after(&self, _query: CronQuery<'_>) -> CronOutcome {
            self.outcomes
                .borrow_mut()
                .pop_front()
                .unwrap_or(CronOutcome::NoFutureOccurrence)
        }
    }

    fn interval(every_seconds: i64) -> ScheduleSpec {
        ScheduleSpec::Interval {
            every: IntervalSeconds::new(every_seconds).unwrap(),
            start_at: None,
        }
    }

    fn cron() -> ScheduleSpec {
        ScheduleSpec::Cron(CronSpec::new("*/5 * * * *".into(), "UTC".into()))
    }

    fn no_cron() -> FixedCron {
        FixedCron(CronOutcome::NoFutureOccurrence)
    }

    #[test]
    fn once_always_terminates_without_rearm_or_missed() {
        let out = plan_advancement(
            &ScheduleSpec::Once { fire_at: 1_000 },
            ScheduleCaps::none(),
            FiredCount::new(0).unwrap(),
            1_000,
            5_000,
            &no_cron(),
        )
        .unwrap();
        assert_eq!(out, Advancement::Terminal { missed_count: 0 });
    }

    #[test]
    fn interval_rearms_from_actual_fire_not_scheduled_tick() {
        let out = plan_advancement(
            &interval(60),
            ScheduleCaps::none(),
            FiredCount::new(3).unwrap(),
            1_000,
            200_000,
            &no_cron(),
        )
        .unwrap();
        let missed_count = estimate_missed_count(&interval(60), 1_000, 200_000, &no_cron());
        assert_eq!(
            out,
            Advancement::Rearm {
                next_fire_at: 200_000 + 60 * 1000,
                missed_count,
            }
        );
    }

    #[test]
    fn max_occurrences_reached_terminates_before_computing_next() {
        // fired_count 4, +1 = 5 >= max 5 → terminal, and cron is never asked
        // (a faulting evaluator would surface as Err if it were consulted).
        let out = plan_advancement(
            &cron(),
            ScheduleCaps::new(Some(5), None).unwrap(),
            FiredCount::new(4).unwrap(),
            1_000,
            1_000,
            &FixedCron(CronOutcome::InvalidExpression),
        )
        .unwrap();
        assert!(matches!(out, Advancement::Terminal { .. }));
    }

    #[test]
    fn until_at_overrun_terminates_after_computing_next() {
        // next interval instant = 100_000 + 60_000 = 160_000 > until 120_000.
        let out = plan_advancement(
            &interval(60),
            ScheduleCaps::new(None, Some(120_000)).unwrap(),
            FiredCount::new(0).unwrap(),
            100_000,
            100_000,
            &no_cron(),
        )
        .unwrap();
        assert!(matches!(out, Advancement::Terminal { .. }));
    }

    #[test]
    fn cron_rearm_uses_evaluator_next_instant() {
        let out = plan_advancement(
            &cron(),
            ScheduleCaps::none(),
            FiredCount::new(0).unwrap(),
            0,
            10_000,
            &SteppingCron { step_ms: 300_000 },
        )
        .unwrap();
        // First 300_000 multiple strictly after 10_000 is 300_000.
        assert_eq!(
            out,
            Advancement::Rearm {
                next_fire_at: 300_000,
                missed_count: 0,
            }
        );
    }

    #[test]
    fn cron_faults_propagate_as_cadence_faults() {
        for (outcome, fault) in [
            (
                CronOutcome::NoFutureOccurrence,
                CadenceFault::NoFutureOccurrence,
            ),
            (
                CronOutcome::InvalidExpression,
                CadenceFault::InvalidExpression,
            ),
            (CronOutcome::InvalidTimezone, CadenceFault::InvalidTimezone),
        ] {
            let err = plan_advancement(
                &cron(),
                ScheduleCaps::none(),
                FiredCount::new(0).unwrap(),
                0,
                10_000,
                &FixedCron(outcome),
            )
            .unwrap_err();
            assert_eq!(err, AdvanceError::Cadence(fault));
        }
    }

    #[test]
    fn non_advancing_cron_is_a_policy_fault_not_a_past_rearm() {
        // Evaluator answers with an instant at/before `after` — a contract
        // violation. It must NOT become a legal (past) rearm.
        let err = plan_advancement(
            &cron(),
            ScheduleCaps::none(),
            FiredCount::new(0).unwrap(),
            0,
            10_000,
            &FixedCron(CronOutcome::NextInstant(9_999)),
        )
        .unwrap_err();
        assert_eq!(err, AdvanceError::Policy(PolicyFault::NonAdvancingCron));
    }

    #[test]
    fn interval_cadence_overflow_is_a_policy_fault_not_a_panic() {
        let out = plan_advancement(
            &interval(i64::MAX),
            ScheduleCaps::none(),
            FiredCount::new(0).unwrap(),
            0,
            0,
            &no_cron(),
        );
        assert_eq!(
            out,
            Err(AdvanceError::Policy(PolicyFault::ArithmeticOverflow))
        );
    }

    #[test]
    fn missed_count_interval_floors_lateness() {
        // 200s late on a 60s interval → floor(200/60) = 3.
        assert_eq!(
            estimate_missed_count(&interval(60), 0, 200_000, &no_cron()),
            3
        );
        // On-time or early → 0.
        assert_eq!(
            estimate_missed_count(&interval(60), 5_000, 5_000, &no_cron()),
            0
        );
        assert_eq!(
            estimate_missed_count(&interval(60), 5_000, 1_000, &no_cron()),
            0
        );
    }

    #[test]
    fn missed_count_cron_counts_strictly_between() {
        // step 300_000; scheduled 0, actual 1_000_000 → occurrences at
        // 300_000 / 600_000 / 900_000 are strictly between → 3.
        assert_eq!(
            estimate_missed_count(&cron(), 0, 1_000_000, &SteppingCron { step_ms: 300_000 }),
            3
        );
    }

    #[test]
    fn missed_count_cron_partial_then_fault_yields_zero() {
        // Two clean occurrences then a fault before reaching actual: the TS
        // try/catch discards the partial and returns 0.
        let scripted = ScriptedCron::new(vec![
            CronOutcome::NextInstant(300_000),
            CronOutcome::NextInstant(600_000),
            CronOutcome::InvalidExpression,
        ]);
        assert_eq!(estimate_missed_count(&cron(), 0, 10_000_000, &scripted), 0);
    }

    #[test]
    fn missed_count_cron_caps_at_1000() {
        // A tiny step with a huge window would count forever; the cap holds.
        assert_eq!(
            estimate_missed_count(&cron(), 0, i64::MAX, &SteppingCron { step_ms: 1 }),
            1000
        );
    }

    #[test]
    fn failure_rearm_rejects_once() {
        let err = plan_failure_rearm(
            &ScheduleSpec::Once { fire_at: 1 },
            ScheduleCaps::none(),
            5_000,
            &no_cron(),
        )
        .unwrap_err();
        assert_eq!(err, FailureRearmError::OnceHasNoRetry);
    }

    #[test]
    fn failure_rearm_ignores_max_but_honors_until() {
        // max_occurrences is never consulted on the failure path.
        let out = plan_failure_rearm(
            &interval(60),
            ScheduleCaps::new(Some(1), None).unwrap(),
            100_000,
            &no_cron(),
        )
        .unwrap();
        assert_eq!(
            out,
            FailureRearm::Rearm {
                next_fire_at: 100_000 + 60_000
            }
        );

        // until_at overrun still terminates on failure.
        let out = plan_failure_rearm(
            &interval(60),
            ScheduleCaps::new(None, Some(120_000)).unwrap(),
            100_000,
            &no_cron(),
        )
        .unwrap();
        assert_eq!(out, FailureRearm::Terminal);
    }

    #[test]
    fn failure_rearm_propagates_cadence_fault() {
        let err =
            plan_failure_rearm(&cron(), ScheduleCaps::none(), 10_000, &no_cron()).unwrap_err();
        assert_eq!(
            err,
            FailureRearmError::Advance(AdvanceError::Cadence(CadenceFault::NoFutureOccurrence))
        );
    }
}

/// TS-first parity gate. The expected values in the included fixture are
/// signed by the REAL production TypeScript policy — the pure
/// `planAdvancement` / `planFailureRearm` / `estimateMissedCount` in
/// `schedule-recurrence.ts` that `ScheduleService` itself calls, executed by
/// `schedule-recurrence.parity.test.ts` — not hand-authored here. That single
/// signer emits both the JSON fixture and this `.rs`, and the same Vitest run
/// re-asserts this file byte-for-byte against the production output, so the
/// two projections cannot drift apart. Rust consumes each case WHOLE and must
/// reproduce the advancement, missed-count, and failure-rearm outcomes exactly.
///
/// The fixture's cron cases use a stateless periodic evaluator identical on
/// both sides (`steppingCronNext` ⇔ [`SteppingCron`]); the real cron/timezone
/// evaluator stays a Cindy-owned seam. Fault, overflow, and non-advancing
/// paths — which a stepping evaluator cannot produce — are covered by the
/// unit tests above, justified against the same production policy.
#[cfg(test)]
mod ts_parity {
    use super::super::spec::CronSpec;
    use super::*;

    #[derive(Clone, Copy)]
    enum Kind {
        Once { fire_at: i64 },
        Interval { every_seconds: i64 },
        Cron { step: i64 },
    }

    #[derive(Clone, Copy)]
    enum ExpAdv {
        Terminal { missed: i64 },
        Rearm { next: i64, missed: i64 },
    }

    #[derive(Clone, Copy)]
    enum ExpFail {
        Rearm { next: i64 },
        Terminal,
        OnceNoRetry,
    }

    struct Case {
        name: &'static str,
        kind: Kind,
        max_occ: Option<i64>,
        until_at: Option<i64>,
        fired_count: i64,
        scheduled_fire_at: i64,
        actual_fire_at: i64,
        exp_adv: ExpAdv,
        exp_missed: i64,
        exp_fail: ExpFail,
    }

    /// Stateless periodic cron identical to the generator's `steppingNext`:
    /// the next multiple of `step_ms` strictly greater than `after`.
    struct SteppingCron {
        step_ms: i64,
    }

    impl CronNextOccurrence for SteppingCron {
        fn next_after(&self, query: CronQuery<'_>) -> CronOutcome {
            CronOutcome::NextInstant((query.after / self.step_ms + 1) * self.step_ms)
        }
    }

    const CASES: &[Case] = include!("recurrence_ts_fixture.rs");

    #[test]
    fn matches_ts_signed_policy_fixture() {
        for c in CASES {
            // A stepping cron is stateless, so `plan_advancement`'s internal
            // double use (next-instant + missed-count) stays consistent.
            let (spec, step) = match c.kind {
                Kind::Once { fire_at } => (ScheduleSpec::Once { fire_at }, 1),
                Kind::Interval { every_seconds } => (
                    ScheduleSpec::Interval {
                        every: IntervalSeconds::new(every_seconds).unwrap(),
                        start_at: None,
                    },
                    1,
                ),
                Kind::Cron { step } => (
                    ScheduleSpec::Cron(CronSpec::new("*/5 * * * *".into(), "UTC".into())),
                    step,
                ),
            };
            let caps = ScheduleCaps::new(c.max_occ, c.until_at).unwrap();
            let cron = SteppingCron { step_ms: step };

            let adv = plan_advancement(
                &spec,
                caps,
                FiredCount::new(c.fired_count).unwrap(),
                c.scheduled_fire_at,
                c.actual_fire_at,
                &cron,
            )
            .unwrap_or_else(|e| panic!("{}: advancement errored: {e:?}", c.name));
            let expected_adv = match c.exp_adv {
                ExpAdv::Terminal { missed } => Advancement::Terminal {
                    missed_count: missed,
                },
                ExpAdv::Rearm { next, missed } => Advancement::Rearm {
                    next_fire_at: next,
                    missed_count: missed,
                },
            };
            assert_eq!(adv, expected_adv, "{}: advancement", c.name);

            let missed = estimate_missed_count(&spec, c.scheduled_fire_at, c.actual_fire_at, &cron);
            assert_eq!(missed, c.exp_missed, "{}: missed_count", c.name);

            let fail = plan_failure_rearm(&spec, caps, c.actual_fire_at, &cron);
            match c.exp_fail {
                ExpFail::Rearm { next } => assert_eq!(
                    fail.unwrap_or_else(|e| panic!("{}: failure errored: {e:?}", c.name)),
                    FailureRearm::Rearm { next_fire_at: next },
                    "{}: failure rearm",
                    c.name
                ),
                ExpFail::Terminal => assert_eq!(
                    fail.unwrap_or_else(|e| panic!("{}: failure errored: {e:?}", c.name)),
                    FailureRearm::Terminal,
                    "{}: failure terminal",
                    c.name
                ),
                ExpFail::OnceNoRetry => assert_eq!(
                    fail.unwrap_err(),
                    FailureRearmError::OnceHasNoRetry,
                    "{}: failure once",
                    c.name
                ),
            }
        }
    }
}
