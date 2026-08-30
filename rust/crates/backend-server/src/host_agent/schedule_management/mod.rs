//! Schedule-management routes — a submodule of the public-agent management
//! plane (`host_agent`), not a new top-level concept. The schedule domain lives
//! in `backend-core::messaging::schedule`; this is only the agent-scoped route
//! surface that mounts it.
//!
//! Scaffold only: no route, handler, DTO, factory, port or mount yet —
//! UNMOUNTED. The implementing lane fills it with `mod`/`use` declarations here
//! and route files beside this `mod.rs`, touching no shared declaration.
