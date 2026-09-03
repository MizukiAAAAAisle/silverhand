//! Messaging-owned post-commit daemon wake effects.

use silverhand_backend_core::{
    application_orchestration::agent_creation::OnboardingInboxEnsure,
    conversation_messaging::messaging::{
        CreatedMessage, MessageId,
        collaboration::workspace_rename_messaging::{
            BoundWorkspaceRenameMessage, WorkspaceRenameDeliveryPort,
        },
        mention_cc::CommittedMentionCopy,
        post_commit::{
            EffectFailure, IdleStart, LiveMessageInboxEnsure, MainDelivery, ReplyDelivery,
            RuntimeDelivery, RuntimeStart, SealedMessageInboxEnsure,
        },
    },
    conversation_messaging::runtime_delivery::{RuntimeDispatchReadPort, RuntimeInboxCustodyPort},
    foundation::identity::{AgentId, ConversationId},
    host_runtime::custody::HostCredentialLookup,
    host_runtime::runtime_event::DaemonEventDurablePort,
};

/// Narrow production delivery face for converged effects that already own an
/// immutable conversation coordinate (membership notices, task events, channel
/// rename notices, and schedule wakes).  Unlike [`RuntimeDelivery`], this is not
/// tied to a mention-copy DTO; unlike the owning runtime, it exposes no start,
/// custody, or settlement authority.
pub trait LiveConversationRuntimeDelivery: Clone + Send + Sync + 'static {
    fn deliver_to_live_recipient(
        &self,
        conversation: &ConversationId,
        agent: &AgentId,
        message: &MessageId,
    ) -> impl std::future::Future<Output = Result<(), EffectFailure>> + Send;
}

pub trait SealedConversationRuntimeDelivery: Clone + Send + Sync + 'static {
    fn deliver_to_sealed_recipient(
        &self,
        conversation: &ConversationId,
        agent: &AgentId,
        message: &MessageId,
    ) -> impl std::future::Future<Output = Result<(), EffectFailure>> + Send;
}

use crate::application_orchestration::daemon_delivery::DaemonDeliveryRuntime;

#[derive(Clone)]
pub struct DaemonDeliveryEffects<C, D, H> {
    runtime: DaemonDeliveryRuntime<C, D, H>,
}

impl<C, D, H> DaemonDeliveryRuntime<C, D, H>
where
    C: silverhand_backend_core::host_runtime::runtime_credential::RuntimeCustodyPort,
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
    C: silverhand_backend_core::host_runtime::runtime_credential::RuntimeCustodyPort,
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
    C: silverhand_backend_core::host_runtime::runtime_credential::RuntimeCustodyPort,
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
    C: silverhand_backend_core::host_runtime::runtime_credential::RuntimeCustodyPort,
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
pub struct ConversationMessageDeliveryAdapter<Ensure, C, D, H> {
    ensure: Ensure,
    effects: DaemonDeliveryEffects<C, D, H>,
}

impl<Ensure, C, D, H> ConversationMessageDeliveryAdapter<Ensure, C, D, H> {
    pub fn new(ensure: Ensure, effects: DaemonDeliveryEffects<C, D, H>) -> Self {
        Self { ensure, effects }
    }
}

impl<Ensure, C, D, H> LiveConversationRuntimeDelivery
    for ConversationMessageDeliveryAdapter<Ensure, C, D, H>
where
    Ensure: LiveMessageInboxEnsure,
    C: silverhand_backend_core::host_runtime::runtime_credential::RuntimeCustodyPort,
    D: RuntimeDispatchReadPort + RuntimeInboxCustodyPort + DaemonEventDurablePort,
    H: HostCredentialLookup,
{
    async fn deliver_to_live_recipient(
        &self,
        conversation: &ConversationId,
        agent: &AgentId,
        message: &MessageId,
    ) -> Result<(), EffectFailure> {
        self.ensure
            .ensure_for_live_recipient(conversation, agent, message)
            .await?;
        self.effects.wake(conversation, agent).await
    }
}

impl<Ensure, C, D, H> SealedConversationRuntimeDelivery
    for ConversationMessageDeliveryAdapter<Ensure, C, D, H>
where
    Ensure: SealedMessageInboxEnsure,
    C: silverhand_backend_core::host_runtime::runtime_credential::RuntimeCustodyPort,
    D: RuntimeDispatchReadPort + RuntimeInboxCustodyPort + DaemonEventDurablePort,
    H: HostCredentialLookup,
{
    async fn deliver_to_sealed_recipient(
        &self,
        conversation: &ConversationId,
        agent: &AgentId,
        message: &MessageId,
    ) -> Result<(), EffectFailure> {
        self.ensure
            .ensure_for_sealed_recipient(conversation, agent, message)
            .await?;
        self.effects.wake(conversation, agent).await
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

impl<Ensure, C, D, H> crate::application_orchestration::agent_create::OnboardingDelivery
    for OnboardingDeliveryAdapter<Ensure, C, D, H>
where
    Ensure: OnboardingInboxEnsure,
    C: silverhand_backend_core::host_runtime::runtime_credential::RuntimeCustodyPort,
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
    C: silverhand_backend_core::host_runtime::runtime_credential::RuntimeCustodyPort,
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
    C: silverhand_backend_core::host_runtime::runtime_credential::RuntimeCustodyPort,
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
    C: silverhand_backend_core::host_runtime::runtime_credential::RuntimeCustodyPort,
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
    C: silverhand_backend_core::host_runtime::runtime_credential::RuntimeCustodyPort,
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
