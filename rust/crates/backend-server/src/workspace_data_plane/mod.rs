//! Workspace data-plane route family (Rust residual wave, #task:2252).
//!
//! Two authenticated agent-pane surfaces —
//! `GET /api/agents/{id}/workspace/tree` and `GET /api/agents/{id}/workspace/file`
//! — over the one owning-host correlated-RPC data plane. [`route::router`] mounts
//! the shared admission ladder (principal → visibility → owner-only authority →
//! workspace scope → opaque path) and projects the daemon's answer; the daemon
//! stays the sole virtual-path authority. Backend-app wires the three production ports
//! and mounts this router once behind the human perimeter.
//!
//!  * [`codec`] — the transport-owned params/result schemas for the two commands.
//!  * [`adapter`] — [`ProductionWorkspaceDataPlane`], the daemon-backed port with a
//!    closed fault taxonomy.
//!  * [`route`] — the two public routers and their ladder.

mod adapter;
mod codec;
mod route;

pub use adapter::ProductionWorkspaceDataPlane;
#[cfg(test)]
pub(crate) use adapter::{WORKSPACE_FS_CAPABILITY_CODES, admits_workspace_fs_refusal};
pub use route::{AGENT_WORKSPACE_FILE_PATH, AGENT_WORKSPACE_TREE_PATH, router};
