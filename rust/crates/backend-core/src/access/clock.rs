//! The enrollment slice's minimal time capability.
//!
//! Enrollment stamps a *creation-candidate* join time — that is the only reason
//! this slice reads a clock. It is deliberately **not** a global clock
//! abstraction: only the enrollment use cases depend on it, so the seam stays
//! this narrow.
//!
//! The clock is **infallible**, mirroring the product it must match: the
//! TypeScript route stamps `Date.now()`, which never throws and returns a signed
//! millisecond count (negative before 1970). A clock that could fail would add a
//! `500` this surface can never emit, so reading the time is not a failure mode.
//!
//! The host wall clock that implements it lives here too, beside the port and
//! next to the sibling contexts' own system clocks (`auth::SystemSessionClock`,
//! `host_runtime::SystemClock`). Reading `SystemTime` is an environment capability,
//! not a storage driver, so it does not belong to the persistence crate — that
//! crate only persists — and keeping the single production implementation beside
//! the port it satisfies is what the rest of the tree already does.

use std::time::{SystemTime, UNIX_EPOCH};

/// The enrollment slice's clock: it yields the current time as Unix
/// milliseconds.
///
/// It is injected rather than read inline so that a fake can pin a
/// *deterministic* join-time candidate in tests, and so the public `joined_at`
/// value's time source is not hard-wired to any one clock. The use case samples
/// it only after both authorization doors admit and before any write, so the
/// stamped candidate belongs to an already-authorized enrollment.
///
/// The value is infallible and signed to match `Date.now()`: a pre-epoch host
/// clock yields a negative millisecond count rather than a refusal.
pub trait EnrollmentClock: Clone + Send + Sync + 'static {
    fn now_unix_millis(&self) -> i64;
}

/// The production [`EnrollmentClock`]: the host wall clock, read once by the
/// application before the write transaction opens.
///
/// It matches `Date.now()` for every reachable time and never fails. A time at
/// or after the Unix epoch yields a positive millisecond count; a pre-epoch host
/// clock yields a *negative* one (as `Date.now()` returns for dates before 1970)
/// rather than a faked zero or a refusal; and only a time beyond the `i64`
/// millisecond range — hundreds of millions of years out, unreachable in
/// practice — saturates to the nearest bound instead of wrapping. Reading the
/// clock is therefore not a failure mode, so this surface never emits a `500`
/// the product route could not.
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemEnrollmentClock;

impl EnrollmentClock for SystemEnrollmentClock {
    fn now_unix_millis(&self) -> i64 {
        unix_millis(SystemTime::now())
    }
}

/// The signed, saturating Unix-millisecond conversion behind
/// [`SystemEnrollmentClock`], split out as a pure function of its input so the
/// epoch, pre-epoch and overflow edges are pinned by fixed-input tests rather
/// than the wall clock.
fn unix_millis(now: SystemTime) -> i64 {
    match now.duration_since(UNIX_EPOCH) {
        // At or after the epoch: a positive count, saturating only past i64::MAX.
        Ok(elapsed) => i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX),
        // Before the epoch: a negative count, saturating only past i64::MIN.
        Err(before) => match i64::try_from(before.duration().as_millis()) {
            Ok(millis) => -millis,
            Err(_) => i64::MIN,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::unix_millis;
    use std::time::{Duration, UNIX_EPOCH};

    #[test]
    fn the_epoch_maps_to_zero() {
        assert_eq!(unix_millis(UNIX_EPOCH), 0);
    }

    #[test]
    fn a_time_after_the_epoch_is_a_positive_millisecond_count() {
        let now = UNIX_EPOCH + Duration::from_millis(1_700_000_000_123);
        assert_eq!(unix_millis(now), 1_700_000_000_123);
    }

    #[test]
    fn a_pre_epoch_time_is_negative_never_a_faked_zero() {
        let before = UNIX_EPOCH
            .checked_sub(Duration::from_millis(1500))
            .expect("platform represents pre-epoch instants");
        assert_eq!(
            unix_millis(before),
            -1500,
            "a pre-1970 clock must read negative, exactly as Date.now() does"
        );
    }

    #[test]
    fn a_time_beyond_the_i64_millisecond_range_saturates_rather_than_wrapping() {
        let far_future = UNIX_EPOCH
            .checked_add(Duration::from_millis(u64::MAX))
            .expect("platform represents far-future instants");
        assert_eq!(unix_millis(far_future), i64::MAX);
    }
}
