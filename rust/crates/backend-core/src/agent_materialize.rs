//! Exact host-side agent-home materialization capability.
//!
//! The create-agent saga owns row reservation and settlement. This capability owns
//! only the one semantic command handed to the daemon that currently owns the
//! selected host. Keeping that split explicit prevents a transport adapter from
//! manufacturing a database verdict or a route from pairing a legal command word
//! with free-form JSON.

use std::{error::Error, future::Future};

use crate::{
    agents::runtime::RuntimeKind,
    identity::{AgentId, HostId, WorkspaceId},
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AgentMaterializeTemplate {
    Default,
    Onboarding,
    Minimal,
}

impl AgentMaterializeTemplate {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::Onboarding => "onboarding",
            Self::Minimal => "minimal",
        }
    }
}

/// The exact already-reserved agent metadata sent to one selected host.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentMaterializeTarget {
    host: HostId,
    agent: AgentId,
    agent_home_workspace: WorkspaceId,
    name: String,
    runtime: RuntimeKind,
    model: Option<String>,
    description: Option<String>,
    template: AgentMaterializeTemplate,
}

impl AgentMaterializeTarget {
    #[allow(clippy::too_many_arguments)]
    pub fn reserved(
        host: HostId,
        agent: AgentId,
        agent_home_workspace: WorkspaceId,
        name: String,
        runtime: RuntimeKind,
        model: Option<String>,
        description: Option<String>,
        template: AgentMaterializeTemplate,
    ) -> Self {
        Self {
            host,
            agent,
            agent_home_workspace,
            name,
            runtime,
            model,
            description,
            template,
        }
    }

    pub fn host(&self) -> &HostId {
        &self.host
    }

    pub fn agent(&self) -> &AgentId {
        &self.agent
    }

    pub fn agent_home_workspace(&self) -> &WorkspaceId {
        &self.agent_home_workspace
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub const fn runtime(&self) -> RuntimeKind {
        self.runtime
    }

    pub fn model(&self) -> Option<&str> {
        self.model.as_deref()
    }

    pub fn description(&self) -> Option<&str> {
        self.description.as_deref()
    }

    pub const fn template(&self) -> AgentMaterializeTemplate {
        self.template
    }
}

/// A schema-checked daemon acknowledgement. Both path fields were equal on the
/// wire; storing one value makes a split impossible after admission.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentMaterializeReceipt {
    agent_home_path: String,
    materialized_at: i64,
}

impl AgentMaterializeReceipt {
    pub fn admitted(agent_home_path: String, materialized_at: i64) -> Self {
        Self {
            agent_home_path,
            materialized_at,
        }
    }

    pub fn agent_dir(&self) -> &str {
        &self.agent_home_path
    }

    pub fn agent_home_workspace_path(&self) -> &str {
        &self.agent_home_path
    }

    pub const fn materialized_at(&self) -> i64 {
        self.materialized_at
    }
}

/// Product-readable refusals admitted specifically for `agent_materialize`.
/// Generic protocol/transport errors do not enter this vocabulary.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AgentMaterializeRefusal {
    HostAttachPending,
    AgentDeleting,
    FsQuotaExceeded,
    FsUnavailable,
    AgentDirCollision,
    UnsupportedTemplate,
    UnsupportedRuntime,
    DaemonShuttingDown,
    DaemonInternalError,
    /// The command was dispatched to the owning daemon but no acknowledgement
    /// arrived within the deadline. It is a product outcome (a distinct
    /// `materialize_timeout` → 504), not a transport fault, because the reserved
    /// row is left pending and the create is retryable exactly like the other
    /// refusals — the caller cannot know whether the host will still land it.
    MaterializeTimeout,
}

pub trait AgentMaterializePort: Clone + Send + Sync + 'static {
    type Error: Error + Send + Sync + 'static;

    fn materialize(
        &self,
        target: &AgentMaterializeTarget,
    ) -> impl Future<
        Output = Result<Result<AgentMaterializeReceipt, AgentMaterializeRefusal>, Self::Error>,
    > + Send;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_keeps_the_selected_host_and_receipt_cannot_split_its_paths() {
        let target = AgentMaterializeTarget::reserved(
            HostId::parse("host-a").unwrap(),
            AgentId::parse("agent-a").unwrap(),
            WorkspaceId::parse("wsah_agent-a").unwrap(),
            "Agent A".to_owned(),
            RuntimeKind::Codex,
            None,
            Some("description".to_owned()),
            AgentMaterializeTemplate::Default,
        );
        assert_eq!(target.host().as_str(), "host-a");
        assert_eq!(target.agent().as_str(), "agent-a");
        assert_eq!(target.agent_home_workspace().as_str(), "wsah_agent-a");

        let receipt = AgentMaterializeReceipt::admitted("/opaque/agent-a".to_owned(), 7);
        assert_eq!(receipt.agent_dir(), receipt.agent_home_workspace_path());
        assert_eq!(receipt.materialized_at(), 7);
    }
}
