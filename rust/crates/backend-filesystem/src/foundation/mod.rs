//! `foundation` — a namespace container for backend-filesystem's shared adapters.
//!
//! A namespace container, not a bounded context or a shared lifecycle: it groups the
//! backend-filesystem crate roots the organization map assigns to owner `foundation`
//! under a single Rust module path (`crate::foundation::*`). It declares its members
//! and holds no adapter logic itself.
//!
//! Colocation does NOT merge the members: the categorized audit sink (which owns a log
//! file and its writer lifecycle) and the local blob store (the files this backend
//! owns) remain two distinct adapters that merely share this namespace. Neither is
//! storage of domain data — the line that keeps SQL out of this crate.

pub mod audit_sink;
pub mod blob_store;
