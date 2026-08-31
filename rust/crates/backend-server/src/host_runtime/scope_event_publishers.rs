//! Typed scope-event publishers owned by host-runtime capabilities.

use std::{error::Error, fmt};

use silverhand_backend_core::{
    agent_availability_read::AgentAvailabilityReadModel,
    capability::agent_view::agent_viewer_user_ids,
    host_runtime::{
        aftermath::{AgentAvailabilityAnnouncer, CustodyEffectFailure},
        agent_roster::ComputerAgentsReadPort,
    },
    identity::{AgentId, ConversationId, HostId, UserId},
    scope_event::EventScope,
};

use crate::foundation::{
    scope_event_transport::{ScopeEventHub, ScopeEventHubError},
    scope_event_wire::{DaemonSideEvent, ProductEvent},
};

/// Typed host-runtime publication surface. Its field and constructor are private;
/// cross-crate callers can only derive it from an existing [`ScopeEventHub`].
#[derive(Clone)]
pub struct HubHostRuntimeEvents(ScopeEventHub);

impl ScopeEventHub {
    pub fn host_runtime_events(&self) -> HubHostRuntimeEvents {
        HubHostRuntimeEvents(self.clone())
    }

    /// Builds custody-driven availability fan-out over this hub. The adapter constructor
    /// stays private, preventing cross-crate callers from selecting another hub.
    ///
    /// ```compile_fail
    /// use silverhand_backend_server::{
    ///     foundation::scope_event_transport::ScopeEventHub,
    ///     host_runtime::scope_event_publishers::HubAgentAvailabilityAnnouncer,
    /// };
    ///
    /// let hub = ScopeEventHub::production().unwrap();
    /// let _ = HubAgentAvailabilityAnnouncer::new(hub, (), ());
    /// ```
    ///
    /// ```
    /// use silverhand_backend_server::foundation::scope_event_transport::ScopeEventHub;
    ///
    /// let hub = ScopeEventHub::production().unwrap();
    /// let _ = hub.agent_availability_announcer((), ());
    /// ```
    pub fn agent_availability_announcer<H, V>(
        &self,
        computer_agents: H,
        view: V,
    ) -> HubAgentAvailabilityAnnouncer<H, V> {
        HubAgentAvailabilityAnnouncer::new(self.clone(), computer_agents, view)
    }

    pub fn agent_availability_edge<V>(&self, view: V) -> HubAgentAvailabilityEdge<V> {
        HubAgentAvailabilityEdge::new(self.clone(), view)
    }

    pub(crate) fn publish_agent_availability_changed(
        &self,
        viewer: &UserId,
        agent: &AgentId,
    ) -> Result<(), ScopeEventHubError> {
        self.publish(
            EventScope::Viewer(viewer.clone()),
            ProductEvent::AgentAvailabilityChanged {
                agent_id: agent.as_str().to_owned(),
            },
        )
    }
}

impl HubHostRuntimeEvents {
    pub(crate) fn publish_host_connection_changed(
        &self,
        viewer: &UserId,
        host: &HostId,
    ) -> Result<(), ScopeEventHubError> {
        self.0.publish(
            EventScope::Viewer(viewer.clone()),
            ProductEvent::HostConnectionChanged {
                host_id: host.as_str().to_owned(),
            },
        )
    }

    pub(crate) fn publish_agent_presence_changed(
        &self,
        viewer: &UserId,
        agent: &AgentId,
    ) -> Result<(), ScopeEventHubError> {
        self.0.publish(
            EventScope::Viewer(viewer.clone()),
            ProductEvent::AgentPresenceChanged {
                agent_id: agent.as_str().to_owned(),
            },
        )
    }

    pub(crate) fn publish_daemon_side(
        &self,
        conversation: &ConversationId,
        event: DaemonSideEvent,
    ) -> Result<(), ScopeEventHubError> {
        let event = match event {
            DaemonSideEvent::AgentActivity(payload) => ProductEvent::AgentActivity(payload),
            DaemonSideEvent::AgentStatus(payload) => ProductEvent::AgentStatus(payload),
            DaemonSideEvent::AgentInitTimeout(payload) => ProductEvent::AgentInitTimeout(payload),
            DaemonSideEvent::CompactionStale(payload) => ProductEvent::CompactionStale(payload),
            DaemonSideEvent::AgentEvent(payload) => ProductEvent::AgentEvent(payload),
            DaemonSideEvent::ConversationActivity(payload) => {
                ProductEvent::ConversationActivity(payload)
            }
        };
        self.0
            .publish(EventScope::ConversationSide(conversation.clone()), event)
    }
}

#[derive(Clone)]
pub struct HubAgentAvailabilityAnnouncer<H, V> {
    hub: ScopeEventHub,
    computer_agents: H,
    view: V,
}

/// The availability view resolved for a DIFFERENT agent than the one asked for — a
/// resolver/composition defect, not a product outcome. Retained as this agent's
/// production failure so a spliced ACL can never fan one agent's availability out
/// to another agent's viewers. Mirrors the availability route's source==request
/// bind ([`crate::host_agent::availability`]).
#[derive(Debug)]
struct AgentAvailabilityAudienceMismatch {
    requested: String,
    resolved: String,
}

impl fmt::Display for AgentAvailabilityAudienceMismatch {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "agent-availability view resolved for the wrong agent: requested {}, resolved {}",
            self.requested, self.resolved
        )
    }
}

impl Error for AgentAvailabilityAudienceMismatch {}

impl<H, V> HubAgentAvailabilityAnnouncer<H, V> {
    pub(crate) fn new(hub: ScopeEventHub, computer_agents: H, view: V) -> Self {
        Self {
            hub,
            computer_agents,
            view,
        }
    }
}

impl<H, V> AgentAvailabilityAnnouncer for HubAgentAvailabilityAnnouncer<H, V>
where
    H: ComputerAgentsReadPort,
    V: AgentAvailabilityReadModel + Clone + Send + Sync + 'static,
{
    async fn agents_availability_changed(
        &self,
        computer: HostId,
    ) -> Result<(), CustodyEffectFailure> {
        let agents = self
            .computer_agents
            .agent_ids_on_computer(&computer)
            .await
            .map_err(CustodyEffectFailure::from_source)?;
        let mut first_failure = None;
        for agent in &agents {
            // Each agent's audience runs through the ONE per-agent fan-out unit
            // (source-bind, viewer oracle, per-viewer publish). A failure for one
            // agent is retained but does not abort the rest.
            if let Err(failure) =
                publish_single_agent_availability(&self.hub, &self.view, agent).await
                && first_failure.is_none()
            {
                first_failure = Some(failure);
            }
        }
        if let Some(failure) = first_failure {
            return Err(failure);
        }
        Ok(())
    }
}

/// Publish an availability invalidation for ONE agent to its full committed viewer
/// audience. The per-agent fan-out unit shared by the host-wide custody announcer
/// ([`HubAgentAvailabilityAnnouncer`]) and the single-agent edge
/// ([`HubAgentAvailabilityEdge`]) so both fire through the SAME source-bind,
/// audience oracle, and per-viewer hub primitive — never a second fan-out path.
///
/// Resolves the agent's viewer audience from the committed view ACL, BINDS the
/// resolved facts to the requested agent BEFORE reading its audience — the same
/// source==request bind the availability route makes ([`crate::host_agent::availability`]).
/// A view whose decoded source is a DIFFERENT agent is a resolver/splice defect:
/// its ACL would send THIS agent's `agent_id` payload to some OTHER agent's viewers
/// (leak + misdelivery) while missing this agent's true audience — fail closed
/// with zero publish. A short read (no row) has nothing to bind: it is the
/// empty-audience arm. Every admitted viewer is attempted; the first failure
/// (read, source-bind, or publish) is returned after the whole audience has run so
/// one dead hop cannot silently drop the rest.
async fn publish_single_agent_availability<V>(
    hub: &ScopeEventHub,
    view: &V,
    agent: &AgentId,
) -> Result<(), CustodyEffectFailure>
where
    V: AgentAvailabilityReadModel,
{
    let view = view
        .read_agent_view(agent)
        .await
        .map_err(CustodyEffectFailure::from_source)?;
    if let Some(facts) = view.as_ref()
        && facts.source() != agent
    {
        return Err(CustodyEffectFailure::from_source(
            AgentAvailabilityAudienceMismatch {
                requested: agent.as_str().to_owned(),
                resolved: facts.source().as_str().to_owned(),
            },
        ));
    }
    let viewers = agent_viewer_user_ids(view.as_ref().map(|facts| facts.visibility()));
    let mut first_failure = None;
    for viewer in &viewers {
        if let Err(cause) = hub.publish_agent_availability_changed(viewer, agent)
            && first_failure.is_none()
        {
            first_failure = Some(CustodyEffectFailure::from_source(cause));
        }
    }
    match first_failure {
        Some(failure) => Err(failure),
        None => Ok(()),
    }
}

/// A narrow, single-agent availability-invalidation effect. One method: publish the
/// availability change for exactly ONE agent to its committed viewer audience.
///
/// This is the seam the public agent-deletion route fires when a delete BEGINS —
/// the agent flips out of `active`, so its viewers must recompute availability. It
/// carries no host id and enumerates no roster: the deleted agent is the only one
/// changing. Backed in production by [`HubAgentAvailabilityEdge`], which routes
/// through the SAME `publish_single_agent_availability` fan-out the host-wide
/// custody announcer uses, so there is exactly ONE availability audience
/// authority — never a second.
pub trait AgentAvailabilityEdge: Clone + Send + Sync + 'static {
    fn agent_availability_changed(
        &self,
        agent: &AgentId,
    ) -> impl std::future::Future<Output = Result<(), CustodyEffectFailure>> + Send;
}

/// The production [`AgentAvailabilityEdge`], bound to the ONE hub and the committed
/// availability view. Its constructor stays crate-private so the single-agent
/// fan-out cannot publish on a hub other than the one this seam owns, mirroring
/// [`HubAgentAvailabilityAnnouncer`].
#[derive(Clone)]
pub struct HubAgentAvailabilityEdge<V> {
    hub: ScopeEventHub,
    view: V,
}

impl<V> HubAgentAvailabilityEdge<V> {
    pub(crate) fn new(hub: ScopeEventHub, view: V) -> Self {
        Self { hub, view }
    }
}

impl<V> AgentAvailabilityEdge for HubAgentAvailabilityEdge<V>
where
    V: AgentAvailabilityReadModel + Clone + Send + Sync + 'static,
{
    async fn agent_availability_changed(
        &self,
        agent: &AgentId,
    ) -> Result<(), CustodyEffectFailure> {
        publish_single_agent_availability(&self.hub, &self.view, agent).await
    }
}
