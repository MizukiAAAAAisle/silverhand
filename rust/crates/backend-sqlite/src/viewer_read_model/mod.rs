//! `viewer_read_model` — a namespace container for backend-sqlite's viewer read-side adapters.
//!
//! A namespace container, not a bounded context or a shared lifecycle: it groups the
//! backend-sqlite crate roots the organization map assigns to owner `viewer_read_model`
//! under a single Rust module path (`crate::viewer_read_model::*`). It declares its
//! members and holds no policy, SQL, clock, transaction, projection, or lifecycle logic.
//!
//! Colocation does NOT merge the members: the unread projection (`unread_read`), the
//! presence cold read (`user_presence_cold_read`), and the last-seen SQLite write adapter
//! (`user_presence_last_seen`, implementing the core `LastSeenSink` port) remain three
//! independent responsibilities with their own SQL and transaction boundaries.

pub mod favorites;
pub mod unread_read;
pub mod user_presence_cold_read;
pub mod user_presence_last_seen;
pub mod viewer_sort;
