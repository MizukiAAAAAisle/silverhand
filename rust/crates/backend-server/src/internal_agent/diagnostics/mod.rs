//! Internal CLI-diagnostics routes — a submodule of the internal
//! runtime-credentialed agent family (`internal_agent`), not a new top-level
//! concept. Self-scoped like its siblings: the runtime credential layer pins
//! `{aid}` to the token's own agent before any handler runs.
//!
//! Scaffold only: no route, handler, DTO, factory, port or mount yet —
//! UNMOUNTED. The implementing lane fills it with `mod`/`use` declarations here
//! and route files beside this `mod.rs`, touching no shared declaration.
