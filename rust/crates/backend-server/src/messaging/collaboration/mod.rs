//! HTTP adapters for conversation-collaboration capabilities.

// INTEGRATION SEAM: thin capability registration; no route logic belongs here.
pub mod attention_preference;
pub mod attention_projection;
pub mod activity;
pub mod notification;
pub mod reaction;
pub mod runtime_control;
pub mod saved;
