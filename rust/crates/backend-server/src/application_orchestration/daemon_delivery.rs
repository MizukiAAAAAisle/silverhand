//! Real application assembly for daemon delivery.

use std::{future::Future, pin::Pin, sync::Arc, time::Duration};

use axum::Router;
use silverhand_backend_core::{
    conversation_messaging::runtime_delivery::{RuntimeDispatchReadPort, RuntimeInboxCustodyPort},
    foundation::identity::{ConversationId, HostId, UserId},
    host_runtime::custody::{HostCredentialLookup, VerifyHostTokenFact, verify_host_token},
    host_runtime::runtime_event::DaemonEventDurablePort,
};

use crate::{
    daemon_events::DaemonRuntimeEventError,
    error,
    foundation::daemon_transport::{
        AuthenticatedDaemonHost, DaemonConnectionAuthority, DaemonHostAuthentication,
        DaemonHostReadyEffect, DaemonOwnerFailure, DaemonProtocolAdmission, DaemonStatusSeedEffect,
        DaemonTransport, DaemonTransportController,
    },
    host_agent_background::agent_deletion_resumer::HostReadyObserver,
    host_control::{
        admission::{
            AdmissionUnavailable, DialerId, HostAdmission, ProtocolMismatch, RefusalNews,
            SlotOccupancy,
        },
        status_seed::{HostStatusSeeds, SeedAttempt},
    },
    host_runtime::daemon_runtime_owner::DaemonRuntimeOwner,
    host_runtime::scope_event_publishers::HubHostRuntimeEvents,
    runtime_credential::RuntimeCredentialAuthority,
};

pub use crate::conversation_messaging::daemon_post_commit::{
    DaemonDeliveryEffects, OnboardingDeliveryAdapter,
};
pub use crate::foundation::daemon_transport::{
    DaemonDeliveryBuildError, DaemonDeliveryConfig, DaemonRegistryError, HOST_PROTOCOL_VERSION,
    HOST_WEBSOCKET_PATH, HostDataPlaneCustody, OUTBOUND_PROTOCOL_VERSION, OwningHostDataPlane,
    UPDATE_REQUIRED_CLOSE_REASON,
};
pub use crate::host_control::management::disconnect::DaemonConnectionControlHandle;
pub use crate::host_runtime::cascade_effects::{
    DaemonAgentDeletionFence, DaemonCascadeEffects, DaemonHostConnections,
};
pub use crate::host_runtime::daemon_runtime_owner::DaemonDeliveryError;
pub use crate::host_runtime::detail::ConnectedHostNameView;
pub use crate::host_runtime::rotate_token::{DaemonRotationDeliveryError, DaemonTokenRotation};

pub(crate) use crate::foundation::daemon_command as command;
pub(crate) use crate::foundation::daemon_transport::{
    CommandRefusal, DaemonRefusalCode, HostDataPlaneAnswerMismatch, HostDataPlaneFailure,
    HostDataPlaneRequest, PARSED_EVENT_KINDS,
};

#[derive(Clone)]
pub struct DaemonDeliveryRuntime<C, D, H> {
    transport: DaemonTransport,
    runtime: DaemonRuntimeOwner<C, D>,
    host_credentials: H,
    admission: HostAdmission,
    seeds: HostStatusSeeds,
}

impl<C, D, H> DaemonDeliveryRuntime<C, D, H> {
    pub(crate) fn owning_host_data_plane(&self) -> OwningHostDataPlane {
        self.transport.owning_host_data_plane()
    }

    pub(crate) fn command_timeout(&self) -> Duration {
        self.transport.command_timeout()
    }

    pub(crate) fn credentials(&self) -> RuntimeCredentialAuthority<C>
    where
        C: Clone,
    {
        self.runtime.credentials()
    }

    pub(crate) fn data(&self) -> D
    where
        D: Clone,
    {
        self.runtime.data()
    }

    pub(crate) fn host_credentials(&self) -> H
    where
        H: Clone,
    {
        self.host_credentials.clone()
    }

    pub(crate) fn clear_session_waiters(
        &self,
    ) -> crate::runtime_control::RuntimeClearSessionWaiters {
        self.runtime.clear_session_waiters()
    }

    pub(crate) fn conversation_agent_run_states(
        &self,
        conversation: &ConversationId,
    ) -> Result<Vec<crate::daemon_events::ConversationAgentRunStateSnapshot>, DaemonRuntimeEventError>
    {
        self.runtime.conversation_run_states(conversation)
    }

    #[cfg(test)]
    pub(crate) async fn hydrate_run_states_for_test(
        &self,
        host: &str,
        daemon: &silverhand_backend_core::foundation::identity::DaemonInstanceId,
        connection_id: &str,
        active_agents: std::collections::HashSet<
            silverhand_backend_core::foundation::identity::AgentId,
        >,
        runtimes: Vec<crate::daemon_events::HydratedRuntime>,
    ) -> Result<(), DaemonRuntimeEventError>
    where
        D: DaemonEventDurablePort,
    {
        self.runtime
            .hydrate_run_states_for_test(host, daemon, connection_id, active_agents, runtimes)
            .await
    }
}

impl<C, D, H> DaemonDeliveryRuntime<C, D, H>
where
    C: silverhand_backend_core::host_runtime::runtime_credential::RuntimeCustodyPort,
    D: RuntimeDispatchReadPort + RuntimeInboxCustodyPort + DaemonEventDurablePort,
    H: HostCredentialLookup,
{
    pub fn production(
        credentials: RuntimeCredentialAuthority<C>,
        data: D,
        host_credentials: H,
        event_hub: HubHostRuntimeEvents,
    ) -> Result<Self, DaemonDeliveryBuildError> {
        Self::new(
            credentials,
            data,
            host_credentials,
            DaemonDeliveryConfig::production(),
            event_hub,
        )
    }

    pub fn new(
        credentials: RuntimeCredentialAuthority<C>,
        data: D,
        host_credentials: H,
        config: DaemonDeliveryConfig,
        event_hub: HubHostRuntimeEvents,
    ) -> Result<Self, DaemonDeliveryBuildError> {
        let transport = DaemonTransport::new(config)?;
        let runtime = DaemonRuntimeOwner::new(
            credentials,
            data,
            event_hub,
            transport.owning_host_data_plane(),
            transport.command_timeout(),
            transport.lease_ttl_ms(),
        );
        let seeds = HostStatusSeeds::new(
            Arc::new(transport.owning_host_data_plane()),
            Arc::new(runtime.host_runtime_activity()),
        );
        let authority = transport.controller().connection_authority();
        Ok(Self {
            transport,
            runtime,
            host_credentials,
            admission: HostAdmission::new(Arc::new(ProductionSlotOccupancy(authority))),
            seeds,
        })
    }

    pub fn controller(&self) -> DaemonDeliveryController {
        DaemonDeliveryController {
            transport: self.transport.controller(),
            admission: self.admission.clone(),
            seeds: self.seeds.clone(),
        }
    }

    pub fn router(&self, host_ready: Arc<dyn HostReadyObserver>) -> Router {
        self.transport.router(
            Arc::new(ProductionHostAuthentication(self.host_credentials.clone())),
            Arc::new(ProductionProtocolAdmission(self.admission.clone())),
            Arc::new(self.runtime.clone()),
            Arc::new(ProductionHostReady(host_ready)),
            Arc::new(ProductionStatusSeedEffect {
                seeds: self.seeds.clone(),
                runtime: self.runtime.clone(),
            }),
            Arc::new(self.runtime.clone()),
        )
    }

    pub(crate) async fn start(
        &self,
        conversation: &ConversationId,
        agent: &silverhand_backend_core::foundation::identity::AgentId,
    ) -> Result<(), DaemonDeliveryError> {
        self.runtime.start(conversation, agent).await
    }

    pub(crate) async fn start_if_idle(
        &self,
        conversation: &ConversationId,
        agent: &silverhand_backend_core::foundation::identity::AgentId,
    ) -> Result<(), DaemonDeliveryError> {
        self.runtime.start_if_idle(conversation, agent).await
    }

    pub(crate) async fn deliver(
        &self,
        conversation: &ConversationId,
        agent: &silverhand_backend_core::foundation::identity::AgentId,
    ) -> Result<(), DaemonDeliveryError> {
        self.runtime.deliver(conversation, agent).await
    }

    #[cfg(test)]
    pub(crate) fn transport_registry_for_test(
        &self,
    ) -> &crate::foundation::daemon_transport::DaemonRegistry {
        self.transport.registry_for_test()
    }
}

#[derive(Clone)]
pub struct DaemonDeliveryController {
    transport: DaemonTransportController,
    admission: HostAdmission,
    seeds: HostStatusSeeds,
}

impl DaemonDeliveryController {
    pub fn owning_host_data_plane(&self) -> OwningHostDataPlane {
        self.transport.owning_host_data_plane()
    }

    pub(crate) fn connection_authority(&self) -> DaemonConnectionAuthority {
        self.transport.connection_authority()
    }

    pub fn host_admission(&self) -> HostAdmission {
        self.admission.clone()
    }

    pub fn host_status_seeds(&self) -> HostStatusSeeds {
        self.seeds.clone()
    }

    pub fn active_connection_count(&self) -> usize {
        self.transport.active_connection_count()
    }

    pub fn attached_connection_count(&self) -> usize {
        self.transport.attached_connection_count()
    }

    pub fn host_attached(&self, host_id: &str) -> Result<bool, DaemonRegistryError> {
        self.transport.host_attached(host_id)
    }

    pub async fn close(&self) {
        self.transport.close().await;
    }
}

struct ProductionHostAuthentication<H>(H);

impl<H> DaemonHostAuthentication for ProductionHostAuthentication<H>
where
    H: HostCredentialLookup,
{
    fn authenticate<'a>(
        &'a self,
        token: String,
        observed_at: i64,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<Option<AuthenticatedDaemonHost>, DaemonOwnerFailure>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            match verify_host_token(&self.0, token, observed_at).await {
                Ok(VerifyHostTokenFact::Accepted {
                    host_id, user_id, ..
                }) => Ok(Some(AuthenticatedDaemonHost {
                    host_id,
                    owner_user_id: user_id,
                })),
                Ok(VerifyHostTokenFact::Rejected(_)) => Ok(None),
                Err(error) => Err(Box::new(error) as DaemonOwnerFailure),
            }
        })
    }
}

struct ProductionProtocolAdmission(HostAdmission);

struct ProductionSlotOccupancy(DaemonConnectionAuthority);

impl SlotOccupancy for ProductionSlotOccupancy {
    fn slot_dialer(&self, host_id: &str) -> Result<Option<DialerId>, AdmissionUnavailable> {
        let host = HostId::parse(host_id.to_owned()).map_err(|_| AdmissionUnavailable)?;
        Ok(self
            .0
            .connection_id(&host)
            .map_err(|_| AdmissionUnavailable)?
            .as_deref()
            .map(DialerId::from_connection))
    }
}

impl DaemonProtocolAdmission for ProductionProtocolAdmission {
    fn incompatible(
        &self,
        host_id: &str,
        connection_id: &str,
        offered_protocol_version: u32,
        expected_protocol_version: u32,
        observed_at: i64,
    ) {
        let recorded = self.0.record(
            host_id,
            ProtocolMismatch {
                dialer: DialerId::from_connection(connection_id),
                offered_protocol_version,
                expected_protocol_version,
                observed_at,
            },
        );
        match recorded {
            Ok(RefusalNews::SameUnresolvedFact) => tracing::debug!(
                host_id,
                connection_id,
                offered_protocol_version,
                "refused daemon on the same incompatible wire protocol"
            ),
            Ok(RefusalNews::Changed) => tracing::warn!(
                host_id,
                connection_id,
                offered_protocol_version,
                expected_protocol_version,
                "refused daemon on incompatible wire protocol"
            ),
            Err(cause) => tracing::error!(
                error_chain = %error::describe(&cause),
                host_id,
                "host admission refusal could not be recorded"
            ),
        }
    }

    fn attached(&self, host_id: &str) {
        if let Err(cause) = self.0.clear(host_id) {
            tracing::error!(
                error_chain = %error::describe(&cause),
                host_id,
                "host admission refusal could not be cleared after attachment"
            );
        }
    }
}

struct ProductionHostReady(Arc<dyn HostReadyObserver>);

impl DaemonHostReadyEffect for ProductionHostReady {
    fn attached(&self, host: &HostId, connection_id: &str) {
        self.0.host_ready(host, connection_id);
    }
}

struct ProductionStatusSeedEffect<C, D> {
    seeds: HostStatusSeeds,
    runtime: DaemonRuntimeOwner<C, D>,
}

impl<C, D> DaemonStatusSeedEffect for ProductionStatusSeedEffect<C, D>
where
    C: silverhand_backend_core::host_runtime::runtime_credential::RuntimeCustodyPort,
    D: RuntimeDispatchReadPort + RuntimeInboxCustodyPort + DaemonEventDurablePort,
{
    fn attached(
        &self,
        host: HostId,
        daemon: silverhand_backend_core::foundation::identity::DaemonInstanceId,
        connection_id: String,
        owner: UserId,
        authority: DaemonConnectionAuthority,
    ) {
        let seeds = self.seeds.clone();
        let runtime = self.runtime.clone();
        tokio::spawn(async move {
            let mut attempt = seeds.seed_on_attach(&host, &daemon).await;
            loop {
                match attempt {
                    Ok(SeedAttempt::Deferred { after, ticket }) => {
                        if !authority
                            .wait_for_same_connection(&host, &connection_id, after)
                            .await
                        {
                            break;
                        }
                        attempt = seeds.retry(&host, &daemon, ticket).await;
                    }
                    Ok(SeedAttempt::Sealed) => {
                        if let Err(cause) = runtime.publish_host_connection_changed(&owner, &host) {
                            tracing::error!(
                                error_chain = %error::describe(&cause),
                                host_id = %host.as_str(),
                                "host status seed landed but connection invalidation failed"
                            );
                        }
                        break;
                    }
                    Ok(
                        SeedAttempt::AlreadySealed
                        | SeedAttempt::AlreadyInFlight
                        | SeedAttempt::Superseded
                        | SeedAttempt::StaleWake
                        | SeedAttempt::Exhausted,
                    ) => break,
                    Err(cause) => {
                        tracing::error!(
                            error_chain = %error::describe(&cause),
                            host_id = %host.as_str(),
                            "host status seed chain failed"
                        );
                        break;
                    }
                }
            }
        });
    }
}
