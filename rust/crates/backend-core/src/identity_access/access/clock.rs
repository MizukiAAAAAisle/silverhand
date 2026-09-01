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
//! What lives here is the PORT and the pure `Date.now()`-parity conversion
//! ([`unix_millis`]) — both are domain semantics: the trait names the capability,
//! and the signed/saturating rule is the product contract, testable without a
//! wall clock. What does NOT live here is the concrete adapter that reads
//! `SystemTime::now()`: reading the environment is a composition-root concern, so
//! the production `EnrollmentClock` is assembled in the app layer (next segment,
//! once the surface is mounted) as a one-line wrapper over [`unix_millis`]. Until
//! then the only implementations are the deterministic test clocks.

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

/// The signed, saturating Unix-millisecond conversion that defines `Date.now()`
/// parity, as a pure function of its input.
///
/// This is the enrollment slice's time SEMANTICS, and it lives in the domain
/// because it is a product contract, not an environment read: the app-layer
/// production `EnrollmentClock` is the trivial wrapper `unix_millis(SystemTime::
/// now())`, and every edge that could go wrong is in this function, pinned by
/// fixed-input tests rather than the wall clock.
///
/// It matches `Date.now()` for every reachable time. A time at or after the Unix
/// epoch yields a positive millisecond count; a pre-epoch time yields a
/// *negative* one (as `Date.now()` returns for dates before 1970) rather than a
/// faked zero or a refusal; and only a time beyond the `i64` millisecond range —
/// hundreds of millions of years out, unreachable in practice — saturates to the
/// nearest bound instead of wrapping.
pub fn unix_millis(now: SystemTime) -> i64 {
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
