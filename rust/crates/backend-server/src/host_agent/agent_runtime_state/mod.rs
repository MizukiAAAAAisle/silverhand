//! Agent runtime-state routes — a submodule of the public-agent management
//! plane (`host_agent`), not a new top-level concept.
//!
//! Scaffold only: declared here so the runtime-state lane can land its route
//! surface within the existing public-agent bounded context. No route, handler,
//! DTO, factory, port or mount yet — UNMOUNTED. The implementing lane fills it
//! with `mod`/`use` declarations here and route files beside this `mod.rs`,
//! touching no shared declaration.
