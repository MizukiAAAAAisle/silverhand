#![forbid(unsafe_code)]
#![deny(rustdoc::broken_intra_doc_links)]
//! HTTP, WebSocket and wire projection boundary.

pub mod agent_materialize;
pub mod agent_profile_mcp_data_plane;
pub mod application_orchestration;
pub mod conversation_messaging;
pub mod daemon_delivery;
pub mod embedded_bootstrap;
pub mod foundation;
pub mod host_agent;
pub mod host_runtime;
pub mod identity_access;
pub mod internal_agent;
pub mod ops;
pub mod runtime_control;
pub mod scope_runtime_stop;
pub mod viewer_read_model;
pub mod workspace_data_plane;

#[cfg(test)]
#[path = "../../backend-sqlite/tests/support/current_schema_snapshot.rs"]
mod current_schema;
