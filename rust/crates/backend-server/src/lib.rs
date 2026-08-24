#![forbid(unsafe_code)]
//! HTTP, WebSocket and wire projection boundary.

pub mod auth;
mod bearer;
pub mod daemon_delivery;
mod daemon_events;
mod error;
pub mod host_runtime;
pub mod http;
pub mod messaging;
pub mod runtime_credential;
pub mod scope_events;
pub mod wire;

#[cfg(test)]
#[path = "../../backend-sqlite/tests/support/current_schema_snapshot.rs"]
mod current_schema;
