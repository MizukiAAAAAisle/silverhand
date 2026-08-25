//! SQLite adapters for conversation-collaboration capabilities.

// INTEGRATION SEAM: thin capability registration; no adapter logic belongs here.
pub mod activity;
pub mod attention_preference;
pub mod attention_projection;
pub mod conversation_agent_directory;
pub mod conversation_ref;
pub mod conversation_unread;
pub mod message_unread;
mod notification;
mod reaction;
mod runtime_control;
mod saved;
pub mod thread_follow;

pub use attention_preference::{AttentionPreferenceStoreError, SqliteAttentionPreferenceStore};
pub use notification::{NotificationStoreError, SqliteNotificationStore};
pub use reaction::{ReactionStoreError, SqliteReactionStore};
pub use runtime_control::{RuntimeControlAdmissionStoreError, SqliteRuntimeControlAdmission};
pub use saved::{SavedStoreError, SqliteSavedStore};
