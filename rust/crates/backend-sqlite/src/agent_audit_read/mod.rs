//! SQLite adapter for the owner-audit read port
//! ([`silverhand_backend_core::identity_access::agent_audit_read`]). Same-named sibling of the core
//! port; source-bound projection reads only, one `BEGIN DEFERRED` snapshot per face.
//!
//! The namespace declares and re-exports only — the projection itself lives in
//! [`store`], which documents how one snapshot carries facts AND data and how every
//! reused authority is the ONE authority.

mod store;

pub use store::{AgentAuditReadError, SqliteAgentAuditRead};
