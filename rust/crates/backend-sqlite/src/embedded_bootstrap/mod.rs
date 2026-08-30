//! SQLite adapter for the embedded-bootstrap core capability (#task:2248 scaffold).
//! Same-named sibling of `silverhand_backend_core::embedded_bootstrap`; owns the SQL
//! text/schema/transaction modes behind that port and returns application facts, no
//! driver type crossing the boundary.
//!
//! The adapter [`SqliteEmbeddedBootstrap`] implements
//! `silverhand_backend_core::embedded_bootstrap::EmbeddedBootstrapUnitOfWork`
//! behind one `BEGIN IMMEDIATE` transaction. UNMOUNTED.

mod adapter;

pub use adapter::{SqliteEmbeddedBootstrap, SqliteEmbeddedBootstrapError};
