//! `viewer_read_model` — the viewer-facing read-model business-owner namespace.
//!
//! A namespace container, not a business unit of its own: it groups the crate
//! roots the organization map assigns to owner `viewer_read_model` under a single
//! Rust module path (`crate::viewer_read_model::*`). It declares its members and
//! holds no domain logic itself.
//!
//! Colocation does NOT merge the members' roles: `presence`,
//! `user_presence_cold_read` are read models;
//! `presence_grace` is pure domain policy with no timer or driver mechanics; and
//! `user_presence_last_seen` is a write-side port (`LastSeenSink`). These are five
//! distinct responsibilities that merely share this namespace.
//!
//! The cold-read value and the event that invalidates it must observe one
//! authoritative presence fact. Composition must not wire the read and event to
//! independent projections of the same state.

pub mod favorites;
pub mod presence;
pub mod presence_grace;
pub mod user_presence_cold_read;
pub mod user_presence_last_seen;
pub mod viewer_sort_state;
