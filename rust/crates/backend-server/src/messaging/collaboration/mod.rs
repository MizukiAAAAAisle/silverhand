//! HTTP adapters for conversation-collaboration capabilities.

// INTEGRATION SEAM: thin capability registration; no route logic belongs here.
pub mod activity;
pub mod attention_preference;
pub mod attention_projection;
pub mod conversation_ref;
pub mod notification;
pub mod reaction;
pub mod runtime_control;
pub mod saved;
