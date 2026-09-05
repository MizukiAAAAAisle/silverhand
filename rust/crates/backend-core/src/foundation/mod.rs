//! `foundation` — the shared foundational vocabulary business-owner namespace.
//!
//! A namespace container, not a business unit of its own: it groups the crate
//! roots the organization map assigns to owner `foundation` under a single Rust
//! module path (`crate::foundation::*`). It declares its members and holds no
//! domain logic itself.
//!
//! Colocation does NOT merge the members' vocabularies: the identity kernel
//! vocabulary, the local blob store, the CLI invoke/preflight audit records, name
//! canonicalization, the shared persistence error/port vocabulary, the scope-event
//! transport port, and the binary64/UTF-16 number/text primitives remain distinct
//! authorities that merely share this namespace. `identity` in particular is broadly
//! imported kernel vocabulary, not a C1 product context — it is NOT part of
//! `identity_access` and carries no principal/service abstraction.

pub mod blob_store;
pub mod cli_invoke_audit;
pub mod cli_preflight_audit;
pub mod identity;
pub mod name_canonicalization;
pub mod persistence;
pub mod scope_event;
pub mod wire_number;
pub mod wire_text;
