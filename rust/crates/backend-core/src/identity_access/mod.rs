//! `identity_access` — the C1 (Identity & Access) business-owner namespace.
//!
//! A namespace container, not a business unit of its own: it groups the crate
//! roots the organization map assigns to owner `C1` under a single Rust module
//! path (`crate::identity_access::*`). It declares its members and holds no
//! domain logic itself.

pub mod participant_handle_availability;
