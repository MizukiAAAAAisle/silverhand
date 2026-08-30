//! Internal CLI-diagnostics routes — a submodule of the internal
//! runtime-credentialed agent family (`internal_agent`), not a new top-level
//! concept. Self-scoped like its siblings: the runtime credential layer pins
//! `{aid}` to the token's own agent before any handler runs.
//!
//! Route files sit beside this `mod.rs`; each is declared here and mounted by
//! the composition root through the family's self-pin credential layer. The
//! routers stay UNMOUNTED until backend-app wires them.

pub mod cli_trace;
