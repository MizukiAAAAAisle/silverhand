//! SQLite adapters for conversation-collaboration capabilities.

// INTEGRATION SEAM: thin capability registration; no adapter logic belongs here.
mod attention_preference;
mod notification;
mod reaction;
mod runtime_control;
mod saved;

pub use attention_preference::{AttentionPreferenceStoreError, SqliteAttentionPreferenceStore};
pub use notification::{NotificationStoreError, SqliteNotificationStore};
pub use reaction::{ReactionStoreError, SqliteReactionStore};
pub use runtime_control::{RuntimeControlAdmissionStoreError, SqliteRuntimeControlAdmission};
pub use saved::{SavedStoreError, SqliteSavedStore};
