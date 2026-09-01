//! `viewer_read_model` — the viewer-facing read-model business-owner namespace.
//!
//! A namespace container, not a business unit of its own: it groups the crate
//! roots the organization map assigns to owner `viewer_read_model` under a single
//! Rust module path (`crate::viewer_read_model::*`). It declares its members and
//! holds no domain logic itself.
//!
//! Colocation does NOT merge the members' roles: `user_presence_cold_read` and
//! `viewer_workspace_sort` are read models, while `user_presence_last_seen` is a
//! write-side port (`LastSeenSink`) — three distinct responsibilities that merely
//! share this namespace.

pub mod user_presence_cold_read;
pub mod user_presence_last_seen;
pub mod viewer_workspace_sort;
