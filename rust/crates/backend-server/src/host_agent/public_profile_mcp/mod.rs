//! Public agent profile-MCP route family (Rust residual wave).
//!
//! Scaffold only: a single PUBLIC namespace under the public-agent family
//! (`host_agent`) rather than a redundant top-level shared module. It is `pub`
//! so it can hold crate-private shared HTTP-wire submodules that the internal
//! profile-MCP router (`crate::internal_agent`) imports, keeping one owner for
//! that shared wire vocabulary. It carries no route, handler, DTO, factory, port
//! or mount yet, and is not named by any composition root — UNMOUNTED. The
//! implementing lane fills it with `mod`/`use` submodule declarations here and
//! files beside this `mod.rs`.
