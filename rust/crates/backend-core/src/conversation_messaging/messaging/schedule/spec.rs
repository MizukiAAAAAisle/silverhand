//! Schedule time-policy value objects: the three recurrence specs and the
//! persisted lifecycle status.
//!
//! Pure domain data — no clock, no timezone database, no IO. A `cron` spec
//! holds its expression and IANA timezone opaquely; turning that pair into
//! actual instants is the job of a `recurrence::CronNextOccurrence`
//! evaluator, never this type.
//!
//! The numeric fields that later feed epoch/count arithmetic are validated
//! domain values, not raw integers: [`IntervalSeconds`] and [`ScheduleCaps`]
//! reject the non-positive values that would let the recurrence policy loop
//! forever, rearm into the past, or wrap. A persisted row that violates
//! these is corruption and is rejected at the decode boundary (a safe-500
//! concern), never smuggled into the policy as a legal value. The wire-level
//! quotas (interval ≥ 60s, active-per-agent) stay a create-time concern;
//! this module guarantees only the invariants the arithmetic depends on.

/// Persisted lifecycle status. Mirrors the `schedules.status` CHECK set.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ScheduleStatus {
    Pending,
    Firing,
    Done,
    Cancelled,
    Failed,
}

impl ScheduleStatus {
    /// The persisted/wire token, identical to the `schedules.status` CHECK set
    /// and the `status` field the DTO echoes.
    pub fn as_token(self) -> &'static str {
        match self {
            ScheduleStatus::Pending => "pending",
            ScheduleStatus::Firing => "firing",
            ScheduleStatus::Done => "done",
            ScheduleStatus::Cancelled => "cancelled",
            ScheduleStatus::Failed => "failed",
        }
    }

    /// Parse a persisted token back to the status. `None` for a value outside
    /// the CHECK set — a corrupt `status` column, reported as a safe-500 at the
    /// decode boundary rather than smuggled onto the wire. The schema's CHECK
    /// makes such a value unreachable through any write path.
    pub fn from_token(token: &str) -> Option<Self> {
        match token {
            "pending" => Some(ScheduleStatus::Pending),
            "firing" => Some(ScheduleStatus::Firing),
            "done" => Some(ScheduleStatus::Done),
            "cancelled" => Some(ScheduleStatus::Cancelled),
            "failed" => Some(ScheduleStatus::Failed),
            _ => None,
        }
    }
}

/// The count of times a schedule has already successfully fired.
///
/// Non-negativity is the load-bearing invariant: `plan_advancement` reads it
/// to decide whether the NEXT fire reaches `max_occurrences`, so a negative
/// count would shift the termination boundary (e.g. `-1 + 1 = 0`, never
/// reaching a positive `max`), not merely skew arithmetic. The schema has no
/// CHECK on `fired_count`; a negative persisted value is corruption and is
/// rejected here at the decode boundary (a safe-500 concern), never fed to
/// the policy as a legal value. The increment itself stays checked.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FiredCount(i64);

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("fired_count must be non-negative")]
pub struct NegativeFiredCount;

impl FiredCount {
    pub fn new(count: i64) -> Result<Self, NegativeFiredCount> {
        if count < 0 {
            return Err(NegativeFiredCount);
        }
        Ok(Self(count))
    }

    pub fn get(self) -> i64 {
        self.0
    }
}

/// A strictly-positive interval cadence in seconds.
///
/// Positivity is the load-bearing invariant: a zero or negative cadence
/// would make the recurrence loop non-advancing (missed-count grind) and let
/// a rearm land at or before the fire it came from. The create-time quota
/// (≥ 60s) is stricter and enforced there; this value only promises `> 0`.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct IntervalSeconds(i64);

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("interval seconds must be strictly positive")]
pub struct NonPositiveInterval;

impl IntervalSeconds {
    pub fn new(seconds: i64) -> Result<Self, NonPositiveInterval> {
        if seconds <= 0 {
            return Err(NonPositiveInterval);
        }
        Ok(Self(seconds))
    }

    pub fn get(self) -> i64 {
        self.0
    }
}

/// The caps that can end a repeating schedule. Either ends it independently.
/// When present, each is strictly positive (the wire contract is
/// `positive()`); a non-positive persisted cap is corruption.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Default)]
pub struct ScheduleCaps {
    max_occurrences: Option<i64>,
    until_at: Option<i64>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum InvalidCaps {
    #[error("max_occurrences must be strictly positive when set")]
    NonPositiveMaxOccurrences,
    #[error("until_at must be strictly positive when set")]
    NonPositiveUntil,
}

impl ScheduleCaps {
    /// No caps: an unbounded repeat (the caller opted in via `allow_unbounded`
    /// at create time).
    pub const fn none() -> Self {
        Self {
            max_occurrences: None,
            until_at: None,
        }
    }

    pub fn new(max_occurrences: Option<i64>, until_at: Option<i64>) -> Result<Self, InvalidCaps> {
        if matches!(max_occurrences, Some(n) if n <= 0) {
            return Err(InvalidCaps::NonPositiveMaxOccurrences);
        }
        if matches!(until_at, Some(t) if t <= 0) {
            return Err(InvalidCaps::NonPositiveUntil);
        }
        Ok(Self {
            max_occurrences,
            until_at,
        })
    }

    pub fn max_occurrences(self) -> Option<i64> {
        self.max_occurrences
    }

    pub fn until_at(self) -> Option<i64> {
        self.until_at
    }
}

/// A 5-field cron expression paired with the IANA timezone it is read in.
///
/// The pair is opaque: this crate never parses the expression nor resolves
/// the timezone. `recurrence::CronNextOccurrence` is the only thing that
/// evaluates it, and the real evaluator (plus any cron/tz crate) is an
/// integration seam.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CronSpec {
    expression: String,
    timezone: String,
}

impl CronSpec {
    pub fn new(expression: String, timezone: String) -> Self {
        Self {
            expression,
            timezone,
        }
    }

    pub fn expression(&self) -> &str {
        &self.expression
    }

    pub fn timezone(&self) -> &str {
        &self.timezone
    }
}

/// The time policy. `once` fires a single instant and then terminates;
/// `interval` and `cron` repeat until a cap ends them. All instants are
/// epoch-ms UTC.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ScheduleSpec {
    Once {
        fire_at: i64,
    },
    Interval {
        every: IntervalSeconds,
        /// The FIRST scheduled instant only. It never re-enters the rearm
        /// arithmetic — a repeating interval rearms from the moment it
        /// actually fired, not from `start_at`.
        start_at: Option<i64>,
    },
    Cron(CronSpec),
}

impl ScheduleSpec {
    /// `interval` and `cron` repeat; `once` does not.
    pub fn is_repeating(&self) -> bool {
        !matches!(self, ScheduleSpec::Once { .. })
    }
}
