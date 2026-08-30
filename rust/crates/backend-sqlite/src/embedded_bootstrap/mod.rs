//! SQLite adapter for the embedded-bootstrap core capability (#task:2248 scaffold).
//! Same-named sibling of `silverhand_backend_core::embedded_bootstrap`; owns the SQL
//! text/schema/transaction modes behind that port and returns application facts, no
//! driver type crossing the boundary.
//!
//! Scaffold only — no adapter yet; UNMOUNTED. The implementing lane fills it with
//! `mod`/`use` declarations here and adapter files beside this `mod.rs`, touching no
//! shared declaration.
