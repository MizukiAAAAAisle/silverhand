#![forbid(unsafe_code)]
//! HTTP, WebSocket and wire projection boundary.

pub mod access;
pub mod auth;
mod bearer;
pub mod clock;
pub mod daemon_delivery;
mod daemon_events;
pub mod direct_pairs;
mod error;
pub mod host_agent;
pub mod host_agent_background;
pub mod host_control;
pub mod host_resources;
pub mod host_runtime;
pub mod human_auth;
pub mod messaging;
pub mod ops;
pub mod password_hasher;
pub mod runtime_credential;
pub mod scope_events;
pub mod workspace_detail;
pub mod workspace_metadata_write;
pub mod workspace_name_availability;
pub mod workspaces;

#[cfg(test)]
#[path = "../../backend-sqlite/tests/support/current_schema_snapshot.rs"]
mod current_schema;
