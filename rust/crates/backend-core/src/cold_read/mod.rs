//! The values a client reads ONCE, before the live stream keeps them fresh.
//!
//! Each leaf here answers one question a client asks over HTTP and a later event
//! invalidates. Nothing in this namespace reads: facts in, value out, so the same
//! rule serves a route and a test without a driver.
//!
//! ## The value and the event must observe ONE fact
//!
//! A cold read is half of a pair — the other half is the event that tells a client
//! the value it holds is stale. When the two halves derive from DIFFERENT
//! projections of the same underlying state, they drift, and the drift is invisible
//! to both: the read is self-consistent and the event fires on schedule, while the
//! client's value is simply wrong until the next unrelated invalidation. So each
//! leaf names the authority its value must come from, and pairing it with a
//! second projection of the same state is a defect even when both are correct on
//! their own.
//!
//! That is an obligation on whoever wires the adapters, not a property these types
//! enforce: a fact of the right shape read from the wrong authority is
//! well-formed here.

pub mod availability;
pub mod presence;
