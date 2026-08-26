//! SQLite adapters for conversation-collaboration capabilities.

// INTEGRATION SEAM: thin capability registration; no adapter logic belongs here.
pub mod activity;
pub mod attachment;
pub mod attention_preference;
pub mod attention_projection;
pub mod channel_directory;
pub mod channel_lifecycle;
pub mod conversation_agent_activity;
pub mod conversation_agent_directory;
pub mod conversation_agent_runtime;
pub mod conversation_message_window;
pub mod conversation_participation;
pub mod conversation_ref;
pub mod conversation_threads;
pub mod conversation_unread;
pub mod direct_pair_initiation;
pub mod human_search;
pub mod message_unread;
mod notification;
mod reaction;
mod runtime_control;
mod saved;
pub mod stale_message_resolution;
pub mod thread_follow;
pub mod workspace_rename_messaging;

pub use attention_preference::{AttentionPreferenceStoreError, SqliteAttentionPreferenceStore};
pub use notification::{NotificationStoreError, SqliteNotificationStore};
pub use reaction::{ReactionStoreError, SqliteReactionStore};
pub use runtime_control::{RuntimeControlAdmissionStoreError, SqliteRuntimeControlAdmission};
pub use saved::{SavedStoreError, SqliteSavedStore};
