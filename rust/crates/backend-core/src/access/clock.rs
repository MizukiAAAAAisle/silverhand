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
//! The concrete environment implementation — the host wall clock and its
//! signed, saturating conversion — is an *adapter* concern and lives beside the
//! other adapters; core names only "there is a clock that yields Unix millis".

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
