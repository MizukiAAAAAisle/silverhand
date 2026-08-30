//! Agent audit read port (#task:2248 scaffold). Named `agent_audit_read` — kept
//! distinct from the existing `capability::agent_audit` decision vocabulary — so the
//! two are not conflated: this is the source-bound projection that answers the audit
//! route, with a same-named SQLite adapter.
//!
//! Scaffold only — no port, use case or DTO yet; UNMOUNTED. The implementing lane
//! fills it with `mod`/`use` declarations here and capability files beside this
//! `mod.rs`, touching no shared declaration.
