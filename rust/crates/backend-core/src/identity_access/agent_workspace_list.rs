//! The agent-scoped workspace-list read: every workspace an agent belongs to
//! (regular membership ∪ its own agent-home), for `GET
//! /internal/agents/{aid}/list-workspaces`.
//!
//! The backend NEVER derives `agent_dir` itself — that is a per-daemon fact the
//! outbound data plane stamps. This read owns only the durable workspace facts
//! (id, name, owner-agent arm, archived, updated_at); the route composes the
//! per-workspace `agent_dir` from the daemon `agent_workspace_index` probe. A
//! transport/host/malformed probe fault is a WHOLE-CALL typed failure (Cindy #33), not
//! a per-entry degradation; only within a SUCCESSFUL index does an id the daemon left
//! unresolved degrade to `agent_dir: null` per entry (#1). Mirrors the reference
//! `buildAgentListWorkspacesDto` (`adapter ?? null` inside a resolved index).

use std::future::Future;

use crate::foundation::identity::{AgentId, WorkspaceId};
use crate::foundation::persistence::PersistenceFailure;

/// One workspace an agent belongs to, in the list projection. `agent_dir` is NOT
/// here — it is the daemon's per-workspace fact the route stamps.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentListedWorkspace {
    pub id: WorkspaceId,
    pub name: String,
    /// The owner agent for an agent-home workspace, else `None` (regular).
    pub owner_agent_id: Option<AgentId>,
    /// `archived_at != null` folded to a bool for the wire.
    pub archived: bool,
    pub updated_at: i64,
}

/// Reads every workspace the agent belongs to (regular membership ∪ its own
/// agent-home), ordered as the reference `listForAgent` returns them.
pub trait AgentWorkspaceListRead: Send + Sync + 'static {
    fn list_agent_workspaces(
        &self,
        agent: &AgentId,
    ) -> impl Future<Output = Result<Vec<AgentListedWorkspace>, PersistenceFailure>> + Send;
}
