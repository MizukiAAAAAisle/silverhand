//! The CLI preflight-failure audit record and the sink port a handler depends on.
//!
//! When the CLI rejects an invocation *before* it ever reaches a business request
//! (unknown noun/verb, a strict-flag rejection, a stdin pre-flight failure), it POSTs
//! a fire-and-forget trace to the backend. The backend does not act on that trace — it
//! *records* it, as one durable line in a queryable audit log, so an operator can later
//! ask "which preflight failures happened, for whom, on what verb". The TypeScript
//! product writes those lines to `~/.silverhand/logs/cli-<utc>.log`; there is no
//! programmatic reader — the compatibility surface is that JSONL file inspected by
//! external `tail`/`jq`/`grep`.
//!
//! This module owns only the DOMAIN shape of that fact and the PORT the handler talks
//! to. It performs no IO and knows nothing about files, JSON, or the wall clock: the
//! concrete categorized-file sink and the exact wire projection live in the composition
//! layer's OS adapter. Keeping the record and the port here lets `#2250`'s handler
//! depend on nothing but [`CliPreflightAuditSink`], and lets the one production sink be
//! swapped for a test double without the handler noticing.
//!
//! It is deliberately NOT a generic event bus: there is exactly one record type and one
//! port method. A second audit surface (`#2254`) reuses the *file/lifecycle primitive*
//! in the adapter with its own typed facade — never a second port fused into this one.

/// A non-negative, finite `f64`, the exact contract the CLI trace admission already
/// enforces for `duration_ms` (`z.number().nonnegative()`).
///
/// It is a distinct type rather than a bare `f64` so a legal fractional millisecond
/// count (the CLI measures with sub-millisecond precision) is carried and emitted
/// verbatim — never truncated to an integer — while `NaN`, an infinity, or a negative
/// value is unrepresentable rather than silently written to the audit line.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NonNegativeFiniteF64(f64);

impl NonNegativeFiniteF64 {
    /// Admits a value that is finite and `>= 0`; every other input is rejected so the
    /// audit line can never carry a duration the wire contract forbids.
    pub fn new(value: f64) -> Result<Self, NonNegativeFiniteF64OutOfRange> {
        if value.is_finite() && value >= 0.0 {
            Ok(Self(value))
        } else {
            Err(NonNegativeFiniteF64OutOfRange(value))
        }
    }

    /// The carried value, unchanged from what [`new`](Self::new) admitted.
    pub fn get(self) -> f64 {
        self.0
    }
}

/// A `duration_ms` that is not a finite, non-negative number.
#[derive(Clone, Copy, Debug, PartialEq, thiserror::Error)]
#[error("duration_ms must be a finite, non-negative number")]
pub struct NonNegativeFiniteF64OutOfRange(f64);

impl NonNegativeFiniteF64OutOfRange {
    /// The rejected value, for diagnostics.
    pub fn value(self) -> f64 {
        self.0
    }
}

use crate::identity::{AgentId, ConversationId};

/// One `cli.preflight_failure` fact, exactly the queryable field set the product's log
/// line carries. `category` and `status` are not fields: they are invariants of *being*
/// this record (`"cli.preflight_failure"` / `"failure"`), stamped by the sink, not
/// values a caller could vary.
///
/// Optionality mirrors the live contract precisely. `agent_id` is always present (the
/// authenticated principal). `conversation_id` is absent for an agent-slot principal.
/// The five string fields are absent whenever the CLI did not reach far enough to
/// determine them. `flags_seen` is a list that is *empty*, never absent — the sink
/// emits `[]`, never `null`, for it.
#[derive(Clone, Debug, PartialEq)]
pub struct CliPreflightFailure {
    /// The authenticated agent this invocation ran as. Always present.
    pub agent_id: AgentId,
    /// The conversation the principal is scoped to, absent for an agent-slot principal.
    pub conversation_id: Option<ConversationId>,
    /// The parsed noun, absent when parsing did not reach it.
    pub noun: Option<String>,
    /// The parsed verb, absent when parsing did not reach it.
    pub verb: Option<String>,
    /// Every flag token the dispatcher saw before rejecting; empty (`[]`) when none.
    pub flags_seen: Vec<String>,
    /// The CLI error code, absent when the failure carried none.
    pub error_code: Option<String>,
    /// The CLI error subkind, absent when the failure carried none.
    pub error_subkind: Option<String>,
    /// The sanitized first line of the error message, absent when none was carried.
    pub error_message: Option<String>,
    /// The measured pre-flight duration in milliseconds, absent when not measured.
    pub duration_ms: Option<NonNegativeFiniteF64>,
}

/// The seam a preflight-failure handler records through, and the only thing it depends
/// on. Recording is best-effort by contract: the method cannot fail the caller, because
/// a lost audit line must never turn a decided CLI outcome into an error. What happens
/// to a line the sink cannot durably write (a diagnostic signal, a dropped line) is the
/// concrete sink's policy, not the handler's concern.
///
/// `Clone + Send + Sync + 'static` so the one production sink can be injected into axum
/// router state and shared across every concurrent request without a second instance.
pub trait CliPreflightAuditSink: Clone + Send + Sync + 'static {
    /// Records one preflight failure. Returns nothing and never blocks the caller: the
    /// implementation enqueues the fact and returns immediately.
    fn record(&self, failure: CliPreflightFailure);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_finite_non_negative_duration_is_carried_verbatim() {
        for value in [0.0, 0.5, 1.0, 1234.0, 1234.567, f64::MAX] {
            assert_eq!(NonNegativeFiniteF64::new(value).unwrap().get(), value);
        }
    }

    #[test]
    fn a_negative_nan_or_infinite_duration_is_rejected() {
        for value in [-0.001, -1.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert!(
                NonNegativeFiniteF64::new(value).is_err(),
                "{value} must be rejected"
            );
        }
    }

    #[test]
    fn negative_zero_is_admitted_as_zero() {
        // -0.0 >= 0.0 is true and it is finite: it is a legal, if unusual, zero.
        assert_eq!(NonNegativeFiniteF64::new(-0.0).unwrap().get(), -0.0);
    }
}
