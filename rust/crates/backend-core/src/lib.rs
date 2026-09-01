#![forbid(unsafe_code)]
#![deny(rustdoc::broken_intra_doc_links)]
//! `backend-core` — the driver-free application & domain boundary for the
//! Silverhand Rust backend.
//!
//! It has no Axum, SQLx, SQLite, HTTP, or wire-DTO dependency. Persistence and
//! wire adapters live in sibling crates and project from application facts.

pub mod access;
pub mod agent_audit_read;
pub mod agent_availability_read;
pub mod agent_avatar;
pub mod agent_avatar_write;
pub mod agent_bulk_stop;
pub mod agent_creation;
pub mod agent_detail_read;
pub mod agent_lifecycle;
pub mod agent_list_read;
pub mod agent_materialization;
pub mod agent_materialize;
pub mod agent_peer_profile;
pub mod agent_presence_read;
pub mod agent_profile_mcp;
pub mod agent_profile_read;
pub mod agent_profile_write;
pub mod agent_runtime_state_read;
pub mod agent_runtime_switch;
pub mod agents;
pub mod auth;
pub mod avatar;
pub mod blob_store;
pub mod capability;
pub mod cli_invoke_audit;
pub mod cli_preflight_audit;
pub mod cold_read;
pub mod credential;
pub mod direct_pair_read;
pub mod embedded_bootstrap;
pub mod host_resources_read;
pub mod host_runtime;
pub mod human_auth_flows;
pub mod identity;
pub mod identity_access;
pub mod internal_profile_write;
pub mod mcp_config;
pub mod messaging;
pub mod name_canonicalization;
pub mod persistence;
pub mod policy;
pub mod runtime_credential;
pub mod runtime_delivery;
pub mod runtime_event;
pub mod runtime_transition;
pub mod scope_event;
pub mod scope_runtime_stop;
pub mod teardown;
pub mod user_identity;
pub mod user_presence_cold_read;
pub mod user_presence_last_seen;
pub mod viewer_workspace_sort;
pub mod wire_number;
pub mod wire_text;
pub mod workspace_cold_read;
pub mod workspace_data_plane;
pub mod workspace_detail_read;
pub mod workspace_face;
pub mod workspace_metadata_write;
pub mod workspace_name;
pub mod workspace_name_availability;
