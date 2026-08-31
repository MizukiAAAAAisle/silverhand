//! Messaging-owned post-commit daemon wake effects.

use silverhand_backend_core::{
    agent_creation::OnboardingInboxEnsure,
    host_runtime::custody::HostCredentialLookup,
    identity::{AgentId, ConversationId},
    messaging::{
        CreatedMessage, MessageId,
        collaboration::workspace_rename_messaging::{
            BoundWorkspaceRenameMessage, WorkspaceRenameDeliveryPort,
        },
        mention_cc::CommittedMentionCopy,
        post_commit::{
            EffectFailure, IdleStart, MainDelivery, ReplyDelivery, RuntimeDelivery, RuntimeStart,
        },
    },
    runtime_delivery::{RuntimeDispatchReadPort, RuntimeInboxCustodyPort},
    runtime_event::DaemonEventDurablePort,
};

use crate::application_orchestration::daemon_delivery::DaemonDeliveryRuntime;

#[derive(Clone)]
pub struct DaemonDeliveryEffects<C, D, H> {
    runtime: DaemonDeliveryRuntime<C, D, H>,
}

impl<C, D, H> DaemonDeliveryRuntime<C, D, H>
where
    C: silverhand_backend_core::runtime_credential::RuntimeCustodyPort,
    D: RuntimeDispatchReadPort + RuntimeInboxCustodyPort + DaemonEventDurablePort,
    H: HostCredentialLookup,
{
    pub fn effects(&self) -> DaemonDeliveryEffects<C, D, H> {
        DaemonDeliveryEffects::new(self.clone())
    }
}

impl<C, D, H> DaemonDeliveryEffects<C, D, H> {
    pub(crate) fn new(runtime: DaemonDeliveryRuntime<C, D, H>) -> Self {
        Self { runtime }
    }
}

impl<C, D, H> RuntimeStart for DaemonDeliveryEffects<C, D, H>
where
    C: silverhand_backend_core::runtime_credential::RuntimeCustodyPort,
    D: RuntimeDispatchReadPort + RuntimeInboxCustodyPort + DaemonEventDurablePort,
    H: HostCredentialLookup,
{
    async fn start(
        &self,
        conversation: &ConversationId,
        agent: &AgentId,
    ) -> Result<(), EffectFailure> {
        self.runtime
            .start(conversation, agent)
            .await
            .map_err(EffectFailure::from_source)
    }
}

impl<C, D, H> RuntimeDelivery for DaemonDeliveryEffects<C, D, H>
where
    C: silverhand_backend_core::runtime_credential::RuntimeCustodyPort,
    D: RuntimeDispatchReadPort + RuntimeInboxCustodyPort + DaemonEventDurablePort,
    H: HostCredentialLookup,
{
    async fn deliver(
        &self,
        agent: &AgentId,
        copy: &CommittedMentionCopy,
    ) -> Result<(), EffectFailure> {
        self.runtime
            .deliver(&copy.conversation_id, agent)
            .await
            .map_err(EffectFailure::from_source)
    }
}

impl<C, D, H> DaemonDeliveryEffects<C, D, H>
where
    C: silverhand_backend_core::runtime_credential::RuntimeCustodyPort,
    D: RuntimeDispatchReadPort + RuntimeInboxCustodyPort + DaemonEventDurablePort,
    H: HostCredentialLookup,
{
    async fn wake(
        &self,
        conversation: &ConversationId,
        agent: &AgentId,
    ) -> Result<(), EffectFailure> {
        self.runtime
            .deliver(conversation, agent)
            .await
            .map_err(EffectFailure::from_source)
    }
}

#[derive(Clone)]
pub struct OnboardingDeliveryAdapter<Ensure, C, D, H> {
    ensure: Ensure,
    effects: DaemonDeliveryEffects<C, D, H>,
}

impl<Ensure, C, D, H> OnboardingDeliveryAdapter<Ensure, C, D, H> {
    pub fn new(ensure: Ensure, effects: DaemonDeliveryEffects<C, D, H>) -> Self {
        Self { ensure, effects }
    }
}

impl<Ensure, C, D, H> crate::host_agent::agent_create::OnboardingDelivery
    for OnboardingDeliveryAdapter<Ensure, C, D, H>
where
    Ensure: OnboardingInboxEnsure,
    C: silverhand_backend_core::runtime_credential::RuntimeCustodyPort,
    D: RuntimeDispatchReadPort + RuntimeInboxCustodyPort + DaemonEventDurablePort,
    H: HostCredentialLookup,
{
    async fn deliver(
        &self,
        conversation: &ConversationId,
        agent: &AgentId,
        onboarding_message: &MessageId,
    ) -> Result<(), EffectFailure> {
        self.ensure
            .ensure(conversation, agent, onboarding_message)
            .await?;
        self.effects.wake(conversation, agent).await
    }
}

impl<C, D, H> MainDelivery for DaemonDeliveryEffects<C, D, H>
where
    C: silverhand_backend_core::runtime_credential::RuntimeCustodyPort,
    D: RuntimeDispatchReadPort + RuntimeInboxCustodyPort + DaemonEventDurablePort,
    H: HostCredentialLookup,
{
    async fn deliver_to(
        &self,
        recipient: &AgentId,
        message: &CreatedMessage,
    ) -> Result<(), EffectFailure> {
        self.runtime
            .deliver(&message.conversation_id, recipient)
            .await
            .map_err(EffectFailure::from_source)
    }
}

impl<C, D, H> ReplyDelivery for DaemonDeliveryEffects<C, D, H>
where
    C: silverhand_backend_core::runtime_credential::RuntimeCustodyPort,
    D: RuntimeDispatchReadPort + RuntimeInboxCustodyPort + DaemonEventDurablePort,
    H: HostCredentialLookup,
{
    async fn deliver_to(
        &self,
        recipient: &AgentId,
        message: &CreatedMessage,
    ) -> Result<(), EffectFailure> {
        self.runtime
            .deliver(&message.conversation_id, recipient)
            .await
            .map_err(EffectFailure::from_source)
    }
}

impl<C, D, H> WorkspaceRenameDeliveryPort for DaemonDeliveryEffects<C, D, H>
where
    C: silverhand_backend_core::runtime_credential::RuntimeCustodyPort,
    D: RuntimeDispatchReadPort + RuntimeInboxCustodyPort + DaemonEventDurablePort,
    H: HostCredentialLookup,
{
    type Error = EffectFailure;

    async fn deliver(
        &self,
        agent: &AgentId,
        message: &BoundWorkspaceRenameMessage,
    ) -> Result<(), Self::Error> {
        self.runtime
            .deliver(message.draft().conversation(), agent)
            .await
            .map_err(EffectFailure::from_source)
    }
}

impl<C, D, H> IdleStart for DaemonDeliveryEffects<C, D, H>
where
    C: silverhand_backend_core::runtime_credential::RuntimeCustodyPort,
    D: RuntimeDispatchReadPort + RuntimeInboxCustodyPort + DaemonEventDurablePort,
    H: HostCredentialLookup,
{
    async fn start_if_idle(
        &self,
        recipient: &AgentId,
        conversation: &ConversationId,
    ) -> Result<(), EffectFailure> {
        self.runtime
            .start_if_idle(conversation, recipient)
            .await
            .map_err(EffectFailure::from_source)
    }
}
