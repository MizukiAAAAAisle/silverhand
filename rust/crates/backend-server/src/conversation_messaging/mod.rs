//! Conversation and messaging transport adapters and application effects.
//!
//! Direct-pair reads are colocated here as an independent leaf; the broader messaging
//! directory remains a separate root until its own closure wave.

pub(crate) mod daemon_post_commit;
pub mod direct_pairs;
pub mod scope_event_publishers;
