//! The internal, runtime-credentialed agent-profile & MCP route family
//! (`/internal/agents/{aid}/…`). Every route here is self-scoped: the runtime
//! credential layer pins `{aid}` to the token's own agent before any handler runs.
//!
//! Unmounted: this module owns the handlers, their wire projection, and their
//! orchestration, but the composition root wires the ports and mounts the routes.

mod wire;

pub mod peer_profile;
pub mod profile;
pub mod profile_mcp;
pub mod profile_write_admission;
