//! HTTP adapters for conversation-collaboration capabilities.

// INTEGRATION SEAM: thin capability registration; no route logic belongs here.
pub mod activity;
pub mod attention_preference;
pub mod attention_projection;
pub mod channel_directory;
pub mod conversation_agent_directory;
pub mod conversation_ref;
pub mod conversation_unread;
pub mod message_unread;
pub mod notification;
pub mod reaction;
pub mod runtime_control;
pub mod saved;
pub mod thread_follow;
