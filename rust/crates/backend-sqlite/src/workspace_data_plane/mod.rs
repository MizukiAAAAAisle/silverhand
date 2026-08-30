//! SQLite adapter for the workspace data-plane scope reader.
//!
//! Same-named sibling of `silverhand_backend_core::workspace_data_plane`: it owns
//! the SQL behind [`AgentWorkspaceScopeRead`] and returns application facts only,
//! deciding nothing. The membership rule (home-owner vs explicit edge) is the pure
//! resolver's; this adapter reads BOTH edges plus existence and ownership under one
//! read transaction so the resolver judges a single consistent snapshot.

mod reader;

pub use reader::{SqliteWorkspaceScopeStore, SqliteWorkspaceScopeStoreError};
