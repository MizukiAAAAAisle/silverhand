#![forbid(unsafe_code)]
#![deny(rustdoc::broken_intra_doc_links)]
//! SQLite adapters for `backend-core`'s ports.
//!
//! Everything specific to the engine stays inside this crate: SQL text, schema,
//! PRAGMAs, transaction modes and driver errors. The ports return application
//! facts and `PersistenceFailure`, so no driver type reaches the application or
//! the wire.

pub mod access;
pub mod agent_profile_write;

pub mod auth;
pub mod conversation_messaging;
pub mod embedded_bootstrap;
pub mod foundation;
pub mod host_agent;
pub mod host_runtime;
pub mod human_registration;
pub mod identity_access;
pub mod user_identity;
pub mod viewer_read_model;
pub mod workspace_data_plane;
pub mod workspace_metadata_write;

#[cfg(test)]
#[path = "../tests/support/current_schema_snapshot.rs"]
mod current_schema;
