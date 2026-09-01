#![forbid(unsafe_code)]
#![deny(rustdoc::broken_intra_doc_links)]
//! `backend-core` — the driver-free application & domain boundary for the
//! Silverhand Rust backend.
//!
//! It has no Axum, SQLx, SQLite, HTTP, or wire-DTO dependency. Persistence and
//! wire adapters live in sibling crates and project from application facts.

pub mod agent_bulk_stop;
pub mod agent_creation;
pub mod agent_materialization;
pub mod agent_runtime_state_read;
pub mod agent_runtime_switch;
pub mod blob_store;
pub mod cli_invoke_audit;
pub mod cli_preflight_audit;
pub mod cold_read;
pub mod direct_pair_read;
pub mod embedded_bootstrap;
pub mod host_runtime;
pub mod identity;
pub mod identity_access;
pub mod messaging;
pub mod name_canonicalization;
pub mod persistence;
pub mod policy;
pub mod runtime_delivery;
pub mod scope_event;
pub mod teardown;
pub mod viewer_read_model;
pub mod wire_number;
pub mod wire_text;
pub mod workspace_data_plane;
