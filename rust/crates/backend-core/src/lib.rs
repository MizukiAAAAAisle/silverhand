#![forbid(unsafe_code)]
#![deny(rustdoc::broken_intra_doc_links)]
//! `backend-core` — the driver-free application & domain boundary for the
//! Silverhand Rust backend.
//!
//! It has no Axum, SQLx, SQLite, HTTP, or wire-DTO dependency. Persistence and
//! wire adapters live in sibling crates and project from application facts.

pub mod application_orchestration;
pub mod cold_read;
pub mod conversation_messaging;
pub mod embedded_bootstrap;
pub mod foundation;
pub mod host_runtime;
pub mod identity_access;
pub mod policy;
pub mod viewer_read_model;
pub mod workspace_data_plane;
