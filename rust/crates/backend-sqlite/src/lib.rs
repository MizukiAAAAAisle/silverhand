#![forbid(unsafe_code)]
//! SQLite adapters for `backend-core`'s ports.
//!
//! Everything specific to the engine stays inside this crate: SQL text, schema,
//! PRAGMAs, transaction modes and driver errors. The ports return application
//! facts and `PersistenceFailure`, so no driver type reaches the application or
//! the wire.

pub mod messaging;

pub mod access;
pub mod agent_availability_read;
pub mod agent_avatar_read;
pub mod agent_detail_read;
pub mod agent_list_read;
pub mod agent_presence_read;
pub mod agent_profile_read;
pub mod agent_profile_write;
pub mod agent_view_acl;

pub mod auth;
pub mod computer_agents_read;
pub mod credential;
pub mod direct_pair_read;
pub mod handle_namespace;
pub mod host_agent;
pub mod host_resources_read;
pub mod host_runtime;
pub mod human_registration;
pub mod runtime_credential;
pub mod runtime_delivery;
pub mod scope_event;
pub mod unread_read;
pub mod user_identity;
pub mod user_presence_cold_read;
pub mod user_presence_last_seen;
pub mod workspace_audience_read;
pub mod workspace_cold_read;
pub mod workspace_detail_read;
pub mod workspace_metadata_write;
pub mod workspace_name_availability;
pub mod write_probe;

#[cfg(test)]
#[path = "../tests/support/current_schema_snapshot.rs"]
mod current_schema;
