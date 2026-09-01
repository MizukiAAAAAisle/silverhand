//! HTTP adapters for conversation-collaboration capabilities.

// INTEGRATION SEAM: thin capability registration; no route logic belongs here.
pub mod activity;
pub mod attachment;
pub mod attention_preference;
pub mod attention_projection;
pub mod channel_directory;
pub mod channel_lifecycle;
pub mod conversation_agent_activity;
pub mod conversation_agent_directory;
pub mod conversation_agent_run_states;
pub mod conversation_agent_runtime;
pub mod conversation_log_debug;
pub mod conversation_message_window;
pub mod conversation_ref;
pub mod conversation_threads;
pub mod conversation_unread;
pub mod direct_pair_initiation;
pub mod human_search;
mod json_body;
pub mod message_unread;
pub mod notification;
mod query_number;
pub mod reaction;
pub mod runtime_control;
pub mod saved;
pub mod stale_message_resolution;
pub mod thread_follow;
