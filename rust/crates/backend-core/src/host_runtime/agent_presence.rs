//! When an agent's last activity ages into "away".
//!
//! This is pure background policy: it owns the validated instant and away
//! boundary, but no timer, task, sleep, or other driver mechanics.
//!
//! ONE authority for the agent-presence away boundary, shared by the two faces
//! that reason about it and must never disagree:
//!
//! * the runtime-delivery writer, which treats a fresh observation still inside
//!   the window as "already online" and publishes nothing, and
//! * the `GET /api/agents/:id/presence` read, which projects the same boundary
//!   as the wire `away_at`.
//!
//! Both derive from ONE validated [`ActivityInstant`], so the instant a write
//! calls "still present" is exactly the instant a read reports the agent has gone
//! away. The window lives here alone; neither face carries its own copy of the
//! literal.
//!
//! ## The instant is validated, never saturated
//!
//! A stored `last_activity_at` is not a free integer. It is decoded into an
//! [`ActivityInstant`], which is non-negative AND leaves room for the window: the
//! deadline `stamp + AWAY_TTL_MS` must itself stay inside the JS-safe range the
//! `number` wire carries losslessly. A value outside that domain is corruption of
//! a committed row, refused at decode — NOT saturated into [`i64::MAX`], which
//! would wash a corrupt stamp into a legal deadline and let the writer treat it as
//! "still online". Because the domain is closed at construction, `away_at` is a
//! total add that cannot overflow.

use thiserror::Error;

/// Milliseconds an agent stays "present" after its last recorded activity. Past
/// this it is "away". Sole owner of the window.
pub const AWAY_TTL_MS: i64 = 30 * 60_000;

/// The largest integer an IEEE-754 double — the JavaScript `number` the wire
/// contract carries — represents exactly: `2^53 - 1`. A stamp or a deadline beyond
/// it could not round-trip through a client, so it is corruption, not a late
/// instant.
pub const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

/// A stored `last_activity_at` validated as a usable presence instant: non-negative
/// and low enough that its away deadline stays inside the wire-safe range. Fallible
/// to build precisely so a committed row cannot smuggle a value that would either
/// pre-date the epoch or push its deadline past what the `number` wire can carry;
/// the inner integer is reachable only through [`ActivityInstant::get`].
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ActivityInstant(i64);

/// A stored `last_activity_at` outside the usable range. Carries the offending
/// value for the operator log; it is never rendered to the client.
#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
#[error(
    "last_activity_at {0} is negative or so large its away deadline leaves the JS safe-integer range"
)]
pub struct ActivityInstantOutOfRange(pub i64);

impl ActivityInstant {
    /// The largest raw stamp this type accepts: any higher and `stamp + TTL` would
    /// leave the JS-safe range, so the deadline bound — not the raw stamp range —
    /// is what closes the domain.
    pub const MAX: i64 = MAX_SAFE_INTEGER - AWAY_TTL_MS;

    /// Validate a stored value at decode. Corruption — negative, or so large its
    /// deadline could not round-trip through the wire — is refused HERE, not masked
    /// by saturation at projection.
    pub fn new(value: i64) -> Result<Self, ActivityInstantOutOfRange> {
        if (0..=Self::MAX).contains(&value) {
            Ok(Self(value))
        } else {
            Err(ActivityInstantOutOfRange(value))
        }
    }

    /// The validated stamp, for the wire and for the writer to store back.
    pub fn get(self) -> i64 {
        self.0
    }

    /// The instant this agent becomes "away": the stamp plus the window. A total
    /// add — the domain guarantees it stays inside [`MAX_SAFE_INTEGER`], so there is
    /// no saturation to hide an overflow.
    pub fn away_at(self) -> i64 {
        self.0 + AWAY_TTL_MS
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_ordinary_stamp_yields_its_stamp_plus_the_window() {
        let instant = ActivityInstant::new(1_000).expect("an ordinary stamp is in range");
        assert_eq!(instant.get(), 1_000);
        assert_eq!(instant.away_at(), 1_801_000);
    }

    #[test]
    fn the_epoch_is_the_low_boundary() {
        let instant = ActivityInstant::new(0).expect("zero is a legal stamp");
        assert_eq!(instant.away_at(), 1_800_000);
    }

    /// The largest ACCEPTED stamp: its deadline lands exactly on the wire ceiling,
    /// which is the point of pinning the domain to the deadline rather than the raw
    /// stamp.
    #[test]
    fn the_max_acceptable_stamp_deadlines_exactly_on_the_wire_ceiling() {
        let instant =
            ActivityInstant::new(9_007_199_252_940_991).expect("largest wire-safe deadline");
        assert_eq!(instant.away_at(), 9_007_199_254_740_991);
    }

    #[test]
    fn a_negative_stamp_is_refused() {
        assert_eq!(ActivityInstant::new(-1), Err(ActivityInstantOutOfRange(-1)));
    }

    #[test]
    fn a_stamp_beyond_the_wire_ceiling_is_refused() {
        assert_eq!(
            ActivityInstant::new(9_007_199_254_740_992),
            Err(ActivityInstantOutOfRange(9_007_199_254_740_992))
        );
    }

    /// The load-bearing discriminator: this raw stamp is itself JS-safe
    /// (`<= MAX_SAFE_INTEGER`), yet its deadline overflows the wire ceiling. A range
    /// check on the raw stamp alone would accept it; the deadline bound refuses it.
    #[test]
    fn a_stamp_whose_deadline_would_overflow_is_refused_even_though_the_stamp_is_wire_safe() {
        let just_over = 9_007_199_252_940_992;
        assert_eq!(
            ActivityInstant::new(just_over),
            Err(ActivityInstantOutOfRange(just_over))
        );
    }
}
