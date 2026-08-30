//! The internal, runtime-credentialed agent-profile & MCP route family
//! (`/internal/agents/{aid}/…`). Every route here is self-scoped: the runtime
//! credential layer pins `{aid}` to the token's own agent before any handler runs.
//!
//! This module owns the handlers, their wire projection, and their orchestration; the
//! composition root (backend-app, #2234 CP7a/CP7b) wires the ports and mounts the routes.

mod wire;

pub mod cli_invoke;
pub mod diagnostics;
pub mod peer_profile;
pub mod profile;
pub mod profile_mcp;
pub mod profile_write;
pub mod profile_write_admission;
