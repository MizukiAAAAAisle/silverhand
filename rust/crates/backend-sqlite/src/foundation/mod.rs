//! `foundation` — a dependency-substrate namespace container for backend-sqlite.
//!
//! A namespace container, not a bounded context or a shared lifecycle: it groups the
//! backend-sqlite crate roots the organization map assigns to owner `foundation` under a
//! single Rust module path (`crate::foundation::*`). It declares its members and holds no
//! SQL, policy, transaction, schema, clock, or lifecycle logic.
//!
//! Colocation does NOT merge the members: the scope-authority SQLite adapter
//! (`scope_event`) and the write-readiness transport (`write_probe`) remain independent —
//! their pools, errors, SQL, traits, factories, and lifecycles are distinct, and there is
//! no generic repository or probe abstraction over them. The cfg-test `current_schema`
//! snapshot the map also assigns to owner `foundation` is a separate axis: it stays a
//! crate-root `#[cfg(test)]`/`#[path]` declaration and is NOT physically colocated here.

pub mod scope_event;
pub mod write_probe;
