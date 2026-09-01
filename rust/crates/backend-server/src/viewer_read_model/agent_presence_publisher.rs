//! Viewer-authorized agent-presence fan-out.

use silverhand_backend_core::foundation::identity::{AgentId, UserId};

use crate::foundation::scope_event_transport::ScopeEventHub;
use crate::host_runtime::{
    runtime_event_settlement::{AgentPresenceEffectPort, LiveProjectionFailure},
    scope_event_publishers::{AgentPresenceChangedEdge, HubAgentPresenceChangedEdge},
};

#[derive(Clone)]
pub struct AgentPresencePublisher<E> {
    edge: E,
}

impl ScopeEventHub {
    pub fn agent_presence_publisher(&self) -> AgentPresencePublisher<HubAgentPresenceChangedEdge> {
        AgentPresencePublisher {
            edge: self.agent_presence_changed_edge(),
        }
    }
}

impl<E> AgentPresenceEffectPort for AgentPresencePublisher<E>
where
    E: AgentPresenceChangedEdge + Send + Sync,
{
    fn publish(&self, viewers: &[UserId], agent: &AgentId) -> Result<(), LiveProjectionFailure> {
        let mut first_failure = None;
        for viewer in viewers {
            if let Err(cause) = self.edge.publish_agent_presence_changed(viewer, agent)
                && first_failure.is_none()
            {
                first_failure = Some(cause);
            }
        }
        first_failure.map_or(Ok(()), Err)
    }
}
