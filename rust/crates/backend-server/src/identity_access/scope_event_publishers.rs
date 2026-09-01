//! Typed scope-event publishers owned by identity and workspace capabilities.

use silverhand_backend_core::{
    identity::{AgentId, UserId, WorkspaceId},
    identity_access::access::{
        ViewerAnnounceFailure, ViewerWorkspacesChangedSink, WorkspaceHumanAudienceReadPort,
        WorkspaceRole,
    },
    identity_access::agent_profile_write::{AgentChangedAnnounceFailure, AgentChangedSink},
    identity_access::user_identity::{UserChangedAnnounceFailure, UserChangedSink},
    identity_access::workspace_metadata_write::{
        WorkspaceMetadataAnnounceFailure, WorkspaceMetadataChangedSink,
    },
    scope_event::EventScope,
};

use crate::foundation::{
    scope_event_transport::{ScopeEventHub, ScopeEventHubError},
    scope_event_wire::{ProductEvent, ViewerWorkspaceChange},
};

#[derive(Clone)]
pub struct HubWorkspaceMembershipPublisher(ScopeEventHub);

#[derive(Clone)]
pub struct HubUserChangedPublisher(ScopeEventHub);

impl ScopeEventHub {
    pub fn workspace_membership_publisher(&self) -> HubWorkspaceMembershipPublisher {
        HubWorkspaceMembershipPublisher(self.clone())
    }

    /// Builds workspace-metadata fan-out over this hub. The concrete adapter cannot be
    /// constructed across crates with an independently chosen hub.
    ///
    /// ```compile_fail
    /// use silverhand_backend_server::{
    ///     foundation::scope_event_transport::ScopeEventHub,
    ///     identity_access::scope_event_publishers::HubWorkspaceMetadataPublisher,
    /// };
    ///
    /// let hub = ScopeEventHub::production().unwrap();
    /// let _ = HubWorkspaceMetadataPublisher::new(hub, ());
    /// ```
    ///
    /// ```
    /// use silverhand_backend_server::foundation::scope_event_transport::ScopeEventHub;
    ///
    /// let hub = ScopeEventHub::production().unwrap();
    /// let _ = hub.workspace_metadata_changed_sink(());
    /// ```
    pub fn workspace_metadata_changed_sink<R>(
        &self,
        audience: R,
    ) -> HubWorkspaceMetadataPublisher<R> {
        HubWorkspaceMetadataPublisher::new(self.clone(), audience)
    }

    pub fn user_changed_sink(&self) -> HubUserChangedPublisher {
        HubUserChangedPublisher(self.clone())
    }

    /// Builds the agent-change sink over this hub; its raw constructor remains private.
    ///
    /// ```compile_fail
    /// use silverhand_backend_server::{
    ///     foundation::scope_event_transport::ScopeEventHub,
    ///     identity_access::scope_event_publishers::HubAgentChangedSink,
    /// };
    ///
    /// let hub = ScopeEventHub::production().unwrap();
    /// let _ = HubAgentChangedSink::new(hub);
    /// ```
    ///
    /// ```
    /// use silverhand_backend_server::foundation::scope_event_transport::ScopeEventHub;
    ///
    /// let hub = ScopeEventHub::production().unwrap();
    /// let _ = hub.agent_changed_sink();
    /// ```
    pub fn agent_changed_sink(&self) -> HubAgentChangedSink {
        HubAgentChangedSink::new(self.clone())
    }

    pub(crate) fn publish_viewer_added_to_workspace(
        &self,
        viewer: &UserId,
        workspace: &WorkspaceId,
        role: WorkspaceRole,
    ) -> Result<(), ScopeEventHubError> {
        self.publish(
            EventScope::Viewer(viewer.clone()),
            ProductEvent::ViewerWorkspacesChanged {
                change: ViewerWorkspaceChange::Added,
                workspace_id: workspace.as_str().to_owned(),
                role: Some(role.as_str()),
            },
        )
    }

    pub(crate) fn publish_viewer_workspace_metadata_changed(
        &self,
        viewer: &UserId,
        workspace: &WorkspaceId,
    ) -> Result<(), ScopeEventHubError> {
        self.publish(
            EventScope::Viewer(viewer.clone()),
            ProductEvent::ViewerWorkspacesChanged {
                change: ViewerWorkspaceChange::MetadataChanged,
                workspace_id: workspace.as_str().to_owned(),
                role: None,
            },
        )
    }

    pub(crate) fn publish_user_changed(&self, user_id: &UserId) -> Result<(), ScopeEventHubError> {
        self.publish(
            EventScope::App,
            ProductEvent::UserChanged {
                user_id: user_id.as_str().to_owned(),
            },
        )
    }

    pub(crate) fn publish_agent_changed(
        &self,
        agent_id: &AgentId,
    ) -> Result<(), ScopeEventHubError> {
        self.publish(
            EventScope::App,
            ProductEvent::AgentChanged {
                agent_id: agent_id.as_str().to_owned(),
            },
        )
    }
}

impl ViewerWorkspacesChangedSink for HubWorkspaceMembershipPublisher {
    async fn viewer_added_to_workspace(
        &self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
        role: WorkspaceRole,
    ) -> Result<(), ViewerAnnounceFailure> {
        self.0
            .publish_viewer_added_to_workspace(user_id, workspace_id, role)
            .map_err(ViewerAnnounceFailure::from_source)
    }
}

/// The identity context's `user_changed` announce, over the real transport.
///
/// The signup/profile use case decides what is true; this typed adapter only routes
/// the id-only hint to app scope and preserves the transport error as the identity
/// context's failure source.
impl UserChangedSink for HubUserChangedPublisher {
    async fn user_changed(&self, user_id: &UserId) -> Result<(), UserChangedAnnounceFailure> {
        self.0
            .publish_user_changed(user_id)
            .map_err(UserChangedAnnounceFailure::from_source)
    }
}

/// Workspace-metadata fan-out over the real transport. The injected committed
/// audience read decides who receives the metadata invalidation; this adapter only
/// routes to every returned viewer and retains the first publication failure after
/// attempting the full audience.
#[derive(Clone)]
pub struct HubWorkspaceMetadataPublisher<R> {
    hub: ScopeEventHub,
    audience: R,
}

impl<R> HubWorkspaceMetadataPublisher<R> {
    pub(crate) fn new(hub: ScopeEventHub, audience: R) -> Self {
        Self { hub, audience }
    }
}

impl<R: WorkspaceHumanAudienceReadPort> WorkspaceMetadataChangedSink
    for HubWorkspaceMetadataPublisher<R>
{
    async fn workspace_metadata_changed(
        &self,
        workspace_id: &WorkspaceId,
    ) -> Result<(), WorkspaceMetadataAnnounceFailure> {
        let members = self
            .audience
            .human_member_ids(workspace_id)
            .await
            .map_err(WorkspaceMetadataAnnounceFailure::from_source)?;
        let mut first_failure = None;
        for viewer in &members {
            if let Err(cause) = self
                .hub
                .publish_viewer_workspace_metadata_changed(viewer, workspace_id)
                && first_failure.is_none()
            {
                first_failure = Some(WorkspaceMetadataAnnounceFailure::from_source(cause));
            }
        }
        if let Some(failure) = first_failure {
            return Err(failure);
        }
        Ok(())
    }
}

/// Typed `agent_changed` invalidation for identity-owned writes. Its constructor is
/// crate-private and the public factory derives it from an existing hub, so callers
/// cannot silently create a second event authority.
#[derive(Clone)]
pub struct HubAgentChangedSink {
    hub: ScopeEventHub,
}

impl HubAgentChangedSink {
    pub(crate) fn new(hub: ScopeEventHub) -> Self {
        Self { hub }
    }
}

impl AgentChangedSink for HubAgentChangedSink {
    async fn agent_changed(&self, agent: &AgentId) -> Result<(), AgentChangedAnnounceFailure> {
        self.hub
            .publish_agent_changed(agent)
            .map_err(AgentChangedAnnounceFailure::from_source)
    }
}
