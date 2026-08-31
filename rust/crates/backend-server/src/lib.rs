#![forbid(unsafe_code)]
#![deny(rustdoc::broken_intra_doc_links)]
//! HTTP, WebSocket and wire projection boundary.

pub mod access;
pub mod agent_materialize;
pub mod agent_name_availability;
pub mod agent_profile_mcp_data_plane;
pub(crate) mod agent_wire;
pub(crate) mod application_orchestration;
pub mod auth;
pub mod avatar_blob;
mod bearer;
pub mod clock;
pub(crate) mod conversation_messaging;
pub mod daemon_delivery;
mod daemon_events;
pub mod direct_pairs;
pub mod embedded_bootstrap;
mod error;
pub(crate) mod foundation;
pub mod host_agent;
pub mod host_agent_background;
pub mod host_control;
pub mod host_resources;
pub mod host_runtime;
pub mod human_auth;
pub(crate) mod identity_access;
pub mod internal_agent;
pub mod messaging;
pub(crate) mod multipart_transport;
pub mod ops;
pub mod password_hasher;
pub mod runtime_control;
pub mod runtime_credential;
pub mod scope_events;
pub mod scope_runtime_stop;
pub mod users;
pub(crate) mod wire_admission;
pub(crate) mod wire_patch;
pub mod workspace_data_plane;
pub mod workspace_detail;
pub mod workspace_metadata_write;
pub mod workspace_name_availability;
pub mod workspace_rename_fanout;
pub mod workspaces;

#[cfg(test)]
#[path = "../../backend-sqlite/tests/support/current_schema_snapshot.rs"]
mod current_schema;
