//! Agent runtime-state read port (#task:2248 scaffold). The `*_read` suffix marks a
//! source-bound projection: the port answers the runtime-state route from a stored
//! fact, minting no write authority. A new crate-root read namespace with a
//! same-named SQLite adapter; distinct from the runtime-switch write saga.
//!
//! Scaffold only — no port, use case or DTO yet; UNMOUNTED. The implementing lane
//! fills it with `mod`/`use` declarations here and capability files beside this
//! `mod.rs`, touching no shared declaration.
