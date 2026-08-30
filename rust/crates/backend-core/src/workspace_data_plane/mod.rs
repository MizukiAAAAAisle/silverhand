//! Workspace data-plane core capability: the port family behind the two-column
//! agent workspace pane.
//!
//! A new top-level bounded context, distinct from the workspace
//! read/detail/metadata verticals — its reason to change is "how an agent's own
//! files are reached and scoped", not "how a workspace is described". It owns two
//! seams:
//!
//!  - [`fs`] — the [`WorkspaceDataPlane`] transport port and its transport-neutral
//!    facts/faults. The daemon owns virtual-path resolution; the port keeps the
//!    caller-supplied path opaque.
//!  - [`scope`] — the single-transaction [`AgentWorkspaceScopeRead`] reader and the
//!    pure [`resolve_agent_workspace_scope`] resolver that judges which workspace a
//!    scoped read reaches and whether the caller may reach it.
//!
//! UNMOUNTED at this leaf: the composition root wires the SQLite reader and the
//! owning-host adapter to a route at convergence.

mod fs;
mod scope;

pub use fs::{
    WorkspaceDataPlane, WorkspaceFileRead, WorkspaceFsFault, WorkspaceFsFaultCode,
    WorkspaceNodeKind, WorkspaceTree, WorkspaceTreeNode,
};
pub use scope::{
    AgentWorkspaceScopeFacts, AgentWorkspaceScopeRead, AgentWorkspaceScopeRefusal,
    AgentWorkspaceScopeResolution, resolve_agent_workspace_scope,
};
