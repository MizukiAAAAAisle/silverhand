//! SQLite adapter for the agent runtime-state cold read.
//!
//! It supplies the facts [`silverhand_backend_core::agent_runtime_state_read`]
//! declares, resolved together on ONE `BEGIN DEFERRED` snapshot: the agent's ACL
//! arms + stage, its COMPLETE participation set (each row carrying its archived flag
//! and this viewer's readability), and its durable seats with per-scope undelivered
//! queue depth.
//!
//! The single leaf [`cold_read`] holds the pool, the one deferred-snapshot read, the
//! strict decoders, and the read-model impl; this namespace only re-exports it. See
//! that leaf for the shared-authority (ACL/redaction/participation macros),
//! strict-decode, and TOCTOU-closing contracts.

mod cold_read;

pub use cold_read::{AgentRuntimeStateColdReadError, SqliteAgentRuntimeStateColdRead};

#[cfg(test)]
mod tests;
