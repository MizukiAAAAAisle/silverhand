//! The production adapter that satisfies the workspace write route's
//! [`WorkspaceRenameFanout`] requirement by driving the core rename orchestrator
//! ([`fan_out_workspace_rename`]) over the three real ports.
//!
//! The composition root assembles ONE of these from the messaging store (which
//! alone answers all three of the fan-out's read/author obligations — the channel
//! population, the per-channel system-message author, and each channel's agent
//! audience), the daemon delivery effects (the per-agent runtime push), and the
//! scope-event hub (the conversation-scope `message` publication). This module owns
//! only the wiring: the layered best-effort failure contract — author is a
//! per-channel precondition, delivery isolates per agent, publication is always
//! attempted after a successful author, and the aggregate is returned as `Err`
//! without ever downgrading the committed rename — lives entirely in the core
//! orchestrator and is proved by its own tests. This adapter is deliberately NOT
//! mounted here; mounting it into the workspace router is a separate composition
//! step that fills the route contract's already-exposed requirement.

use silverhand_backend_core::{
    identity::WorkspaceId,
    messaging::collaboration::workspace_rename_messaging::{
        ConversationAgentsReadPort, WorkspaceRenameChannelsReadPort, WorkspaceRenameDeliveryPort,
        WorkspaceRenameMessageAuthorPort, WorkspaceRenamePublicationPort, fan_out_workspace_rename,
    },
    workspace_metadata_write::WorkspaceNameChange,
};

use crate::workspace_metadata_write::{WorkspaceRenameFanout, WorkspaceRenameFanoutFailure};

/// Wires the messaging store, daemon delivery, and scope-event hub into the route's
/// [`WorkspaceRenameFanout`] requirement. The messaging store `M` satisfies the
/// three core read/author ports at once; `De` is the per-agent runtime delivery and
/// `Pu` the conversation-scope publication.
#[derive(Clone)]
pub struct WorkspaceRenameFanoutAdapter<M, De, Pu> {
    messaging: M,
    delivery: De,
    publication: Pu,
}

impl<M, De, Pu> WorkspaceRenameFanoutAdapter<M, De, Pu> {
    pub fn new(messaging: M, delivery: De, publication: Pu) -> Self {
        Self {
            messaging,
            delivery,
            publication,
        }
    }
}

impl<M, De, Pu> WorkspaceRenameFanout for WorkspaceRenameFanoutAdapter<M, De, Pu>
where
    M: WorkspaceRenameChannelsReadPort
        + WorkspaceRenameMessageAuthorPort
        + ConversationAgentsReadPort
        + Clone
        + Send
        + Sync
        + 'static,
    De: WorkspaceRenameDeliveryPort + Clone + Send + Sync + 'static,
    Pu: WorkspaceRenamePublicationPort + Clone + Send + Sync + 'static,
{
    async fn fan_out_rename(
        &self,
        workspace_id: &WorkspaceId,
        change: &WorkspaceNameChange,
    ) -> Result<(), WorkspaceRenameFanoutFailure> {
        // The same store answers all three read/author ports; the names come off the
        // sealed change, so this is never a second decision about whether a rename
        // happened — the route only calls this when the commit carried one.
        fan_out_workspace_rename(
            &self.messaging,
            &self.messaging,
            &self.messaging,
            &self.delivery,
            &self.publication,
            workspace_id.clone(),
            change.old_name.clone(),
            change.new_name.clone(),
        )
        .await
        .map_err(WorkspaceRenameFanoutFailure::from_source)
    }
}

#[cfg(test)]
mod tests {
    use silverhand_backend_core::{
        host_runtime::custody::HostCredentialLookup,
        messaging::{SendClock, SendEntropy},
        runtime_credential::RuntimeCustodyPort,
        runtime_delivery::{RuntimeDispatchReadPort, RuntimeInboxCustodyPort},
        runtime_event::DaemonEventDurablePort,
    };
    use silverhand_backend_sqlite::messaging::collaboration::workspace_rename_messaging::SqliteWorkspaceRenameMessaging;

    use super::*;
    use crate::daemon_delivery::DaemonDeliveryEffects;
    use crate::scope_events::ScopeEventHub;

    /// The wiring risk this leaf carries is that the three CONCRETE production types
    /// do not compose into the route's requirement — the store must satisfy all
    /// three read/author ports at once, the daemon effects must be the delivery
    /// port, and the hub the publication port. This static assertion fails to
    /// compile the instant any one of those port impls is dropped or its bounds
    /// drift; it instantiates nothing, so it is free at runtime.
    #[allow(dead_code)]
    fn production_types_compose_into_the_route_requirement<E, C, D, H>()
    where
        E: SendClock + SendEntropy + Clone + Send + Sync + 'static,
        C: RuntimeCustodyPort + Clone + Send + Sync + 'static,
        D: RuntimeDispatchReadPort
            + RuntimeInboxCustodyPort
            + DaemonEventDurablePort
            + Clone
            + Send
            + Sync
            + 'static,
        H: HostCredentialLookup + Clone + Send + Sync + 'static,
    {
        fn assert_fanout<F: WorkspaceRenameFanout>() {}
        assert_fanout::<
            WorkspaceRenameFanoutAdapter<
                SqliteWorkspaceRenameMessaging<E>,
                DaemonDeliveryEffects<C, D, H>,
                ScopeEventHub,
            >,
        >();
    }
}
