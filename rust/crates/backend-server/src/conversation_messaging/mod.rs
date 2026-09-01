//! Conversation and messaging transport adapters and application effects.
//!
//! Direct-pair reads and the complete messaging transport directory are colocated here as
//! independent mapped leaves. The production namespace is now closed without changing the
//! directory's internal ownership or visibility.

pub(crate) mod daemon_post_commit;
pub mod direct_pairs;
pub mod messaging;
pub mod runtime_activity_publisher;
pub mod scope_event_publishers;
