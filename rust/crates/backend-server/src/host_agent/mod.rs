//! The host-agent management-plane routes (#2195).
//!
//! This module is the route track's home for the #2192 closed set. It replaces
//! the compile-only scaffold that only resolved the crate-root declaration: each
//! batch adds one reachable vertical here, and the composition-root mount for a
//! batch's `router()` lands with that batch's own checksum and E2E.
//!
//! Landed so far: the public `user_presence` cold read ([`presence`]) and the
//! authenticated `agent availability` cold read ([`availability`]).

pub mod availability;
pub mod host_attachment;
mod online_viewers;
pub mod presence;
