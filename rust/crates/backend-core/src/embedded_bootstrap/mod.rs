//! Embedded-bootstrap core capability — the choose/create bootstrap unit of work
//! and its own auth/token lifecycle (#task:2248 scaffold). A genuinely new
//! top-level bounded context: not the human-credentialed session, not the runtime
//! credential, so it earns its own crate-root namespace.
//!
//! Scaffold only — no port, use case, DTO or factory yet; UNMOUNTED. The
//! implementing lane fills it with `mod`/`use` declarations here and capability
//! files beside this `mod.rs`, touching no shared declaration.
