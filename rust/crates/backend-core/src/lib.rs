#![forbid(unsafe_code)]
//! `backend-core` — the driver-free application & domain boundary for the
//! Silverhand Rust backend.
//!
//! Lib dependencies are `std` + `thiserror` only: no Axum, SQLx, SQLite, HTTP,
//! or wire-DTO types. Persistence and wire adapters live in sibling crates and
//! each project from the application facts defined here.

pub mod foundation_message;
