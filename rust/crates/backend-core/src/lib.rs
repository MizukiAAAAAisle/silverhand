#![forbid(unsafe_code)]
//! `backend-core` — the driver-free application & domain boundary for the
//! Silverhand Rust backend.
//!
//! It has no Axum, SQLx, SQLite, HTTP, or wire-DTO dependency. Persistence and
//! wire adapters live in sibling crates and project from application facts.

pub mod access;
pub mod auth;
pub mod foundation_message;
pub mod host_runtime;
pub mod identity;
pub mod messaging;
pub mod persistence;
pub mod runtime_credential;
pub mod runtime_delivery;
pub mod scope_event;
