//! Workspace data-plane core capability — the shared data-plane/codec/adapter port
//! family the workspace data-plane route surface consumes (#task:2248 scaffold). A
//! new top-level bounded context distinct from the workspace read/detail/metadata
//! verticals, so it owns its own crate-root namespace here and a same-named SQLite
//! adapter namespace.
//!
//! Scaffold only — no port, use case, DTO or factory yet; UNMOUNTED. The
//! implementing lane fills it with `mod`/`use` declarations here and capability
//! files beside this `mod.rs`, touching no shared declaration.
