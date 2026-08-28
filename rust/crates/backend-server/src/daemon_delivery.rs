//! Authenticated daemon attachment, delivery custody and Messaging effect adapters.

use std::{
    collections::HashMap,
    error::Error,
    fmt,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime},
};

use axum::{
    Router,
    extract::{
        State, WebSocketUpgrade,
        ws::{CloseFrame, Message, WebSocket},
    },
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Deserialize;
use serde_json::{Value, json};
use silverhand_backend_core::{
    host_runtime::{
        aftermath::{CustodyEffectFailure, DaemonConnectionControl},
        custody::{HostCredentialLookup, VerifyHostTokenFact, verify_host_token},
        rotation::{DaemonRotationAck, DaemonTokenRotationChannel, RotatedTokenDelivery},
    },
    identity::{AgentId, ConversationId, DaemonInstanceId, HostId, UserId},
    messaging::{
        CreatedMessage,
        collaboration::workspace_rename_messaging::{
            BoundWorkspaceRenameMessage, WorkspaceRenameDeliveryPort,
        },
        mention_cc::CommittedMentionCopy,
        post_commit::{
            EffectFailure, IdleStart, MainDelivery, ReplyDelivery, RuntimeDelivery, RuntimeStart,
        },
    },
    persistence::PersistenceFailure,
    runtime_credential::{RuntimeEventTime, RuntimeFinalStatus, RuntimePrincipal, RuntimeScope},
    runtime_delivery::{
        ClaimPendingInbox, ClaimedInboxBatch, DeliveryInstruction, DeliveryLeaseOwner,
        InboxDeliveryId, RuntimeDeliveryFailureReason, RuntimeDispatchReadPort,
        RuntimeDispatchTarget, RuntimeInboxCustodyPort, RuntimeMember, RuntimePlacement,
        RuntimeRoster, RuntimeSpawnPlan,
    },
    runtime_event::{CommitRuntimeConsumed, DaemonEventDurablePort, RuntimeEventAdmission},
    teardown::facts::AgentRuntimeSessionFacts,
};
use tokio::{
    sync::{Notify, mpsc, oneshot, watch},
    time::Instant,
};

use crate::{
    bearer::strict_bearer_credential,
    daemon_events::{
        AgentRunStateWire, DaemonRuntimeEventOwner, HydratedRuntime, RuntimeEventDirective,
        RuntimeProductEvent, decode_product_event,
    },
    error,
    host_control::admission::{
        AdmissionUnavailable, DialerId, HostAdmission, ProtocolMismatch, RefusalNews, SlotOccupancy,
    },
    host_control::status_seed::{
        AttachedStatusCustody, CustodyUnavailable, DaemonCustody, HostStatusSeeds, SeedAttempt,
    },
    host_control::status_snapshot::{self, StatusSnapshotOutcome, StatusSnapshotRequest},
    host_runtime::detail::ConnectedHostName,
    messaging::references::MarkdownReferencePositions,
    runtime_credential::{
        RuntimeCredentialAuthority, RuntimeDispatchFailure, RuntimeStartFailure,
        RuntimeStartHandoff, RuntimeStartTransport, RuntimeStopTransport,
    },
    scope_events::ScopeEventHub,
};

include!(concat!(env!("OUT_DIR"), "/daemon_admission.rs"));

const MAX_DAEMON_FRAME_BYTES: usize = 1024 * 1024;
/// The highest `protocol_version` this server will read out of a `ready` envelope
/// before knowing the schema, mirroring the deployed bound. Above it the number is
/// not treated as a version at all: an unbounded integer from an unauthenticated
/// schema is a corrupt-dialer signal, not an actionable "upgrade this daemon" fact.
const MAX_READABLE_PROTOCOL_VERSION: u32 = 100;
const DEFAULT_COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
/// The purge waits for runtime quiescence before removing the agent home, matching
/// the TS production data-plane budget rather than the ordinary control round trip.
const HOST_LOCAL_PURGE_TIMEOUT: Duration = Duration::from_secs(60);
/// The budget for one `rotate_token` round trip. Deliberately shorter than a general
/// command: it mirrors the TS `HostTokenRotationCoordinator`'s own 10s, and a rotation
/// that has not been acknowledged in that window is read as "may not have stored it",
/// so the database is left alone and the user rotates again.
const HOST_TOKEN_ROTATION_TIMEOUT: Duration = Duration::from_secs(10);
const DEFAULT_LEASE_TTL: Duration = Duration::from_secs(60);
const DEFAULT_PING_INTERVAL: Duration = Duration::from_secs(30);
const DEFAULT_PONG_TIMEOUT: Duration = Duration::from_secs(5);
const DEFAULT_SHUTDOWN_GRACE: Duration = Duration::from_millis(1_500);
const HOST_REVOKED_CLOSE_REASON: &str = "host_revoked";
const HOST_DISCONNECTED_CLOSE_REASON: &str = "host_disconnected";

#[derive(Clone)]
pub struct DaemonDeliveryConfig {
    command_timeout: Duration,
    lease_ttl: Duration,
    ping_interval: Duration,
    pong_timeout: Duration,
    shutdown_grace: Duration,
}

#[derive(Debug)]
pub enum DaemonDeliveryBuildError {
    Entropy(getrandom::Error),
}

impl fmt::Display for DaemonDeliveryBuildError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("daemon delivery process epoch generation failed")
    }
}

impl Error for DaemonDeliveryBuildError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Entropy(source) => Some(source),
        }
    }
}

impl DaemonDeliveryConfig {
    pub fn production() -> Self {
        Self {
            command_timeout: DEFAULT_COMMAND_TIMEOUT,
            lease_ttl: DEFAULT_LEASE_TTL,
            ping_interval: DEFAULT_PING_INTERVAL,
            pong_timeout: DEFAULT_PONG_TIMEOUT,
            shutdown_grace: DEFAULT_SHUTDOWN_GRACE,
        }
    }

    fn lease_ttl_ms(&self) -> i64 {
        i64::try_from(self.lease_ttl.as_millis()).unwrap_or(i64::MAX)
    }
}

#[derive(Clone)]
pub struct DaemonDeliveryRuntime<C, D, H> {
    credentials: RuntimeCredentialAuthority<C>,
    data: D,
    host_credentials: H,
    registry: DaemonRegistry,
    admission: HostAdmission,
    seeds: HostStatusSeeds,
    config: DaemonDeliveryConfig,
    events: DaemonRuntimeEventOwner<D>,
}

impl<C, D, H> DaemonDeliveryRuntime<C, D, H> {
    pub(crate) fn conversation_agent_run_states(
        &self,
        conversation: &ConversationId,
    ) -> Result<
        Vec<crate::daemon_events::ConversationAgentRunStateSnapshot>,
        crate::daemon_events::DaemonRuntimeEventError,
    > {
        self.events.conversation_run_states(conversation)
    }
}

impl<C, D, H> DaemonDeliveryRuntime<C, D, H>
where
    C: silverhand_backend_core::runtime_credential::RuntimeCustodyPort,
    D: RuntimeDispatchReadPort + RuntimeInboxCustodyPort + DaemonEventDurablePort,
    H: HostCredentialLookup,
{
    pub fn production(
        credentials: RuntimeCredentialAuthority<C>,
        data: D,
        host_credentials: H,
        event_hub: ScopeEventHub,
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
        event_hub: ScopeEventHub,
    ) -> Result<Self, DaemonDeliveryBuildError> {
        let registry = DaemonRegistry::new()?;
        let events = DaemonRuntimeEventOwner::new(data.clone(), event_hub);
        Ok(Self {
            credentials,
            seeds: HostStatusSeeds::new(
                Arc::new(OwningHostDataPlane {
                    registry: registry.clone(),
                }),
                Arc::new(events.host_runtime_activity()),
            ),
            events,
            data,
            host_credentials,
            // One ledger per runtime, reading occupancy from the very registry the
            // connection tasks reserve in. Building it here rather than in `router`
            // is what makes "the writer and every reader are the same state" a
            // property of construction: there is no second place to build one.
            admission: HostAdmission::new(Arc::new(registry.clone())),
            registry,
            config,
        })
    }

    pub fn router(&self) -> (Router, DaemonDeliveryController) {
        let controller = DaemonDeliveryController {
            registry: self.registry.clone(),
            admission: self.admission.clone(),
            seeds: self.seeds.clone(),
            shutdown_grace: self.config.shutdown_grace,
        };
        let router = Router::new()
            .route(HOST_WEBSOCKET_PATH, get(daemon_websocket::<C, D, H>))
            .with_state(self.clone());
        (router, controller)
    }

    pub fn effects(&self) -> DaemonDeliveryEffects<C, D, H> {
        DaemonDeliveryEffects {
            runtime: self.clone(),
        }
    }

    /// The authenticated live-run-state HTTP reader, bound to *this* runtime's
    /// owner by construction. The snapshot source is `self.clone()` — a share of
    /// the same `Arc<Mutex<..>>` map that `effects()`/`router()` mutate — and is
    /// fixed here, not exposed as a parameter. That is deliberate: the same
    /// reason `admission` and `seeds` are built in `new` rather than in `router`.
    /// If the composition root could pass an arbitrary
    /// `ConversationAgentRunStateSource`, it could silently wire the reader to a
    /// different owner than the one delivery writes into; producing the reader
    /// here removes that degree of freedom, so "the delivery writer and the
    /// run-state reader are the same owner" is a property of construction, not a
    /// call-site argument the composition root is trusted to get right.
    pub fn agent_run_states_router<A>(&self, admission: A) -> Router
    where
        A: silverhand_backend_core::messaging::collaboration::channel_lifecycle::ChannelDetailReadPort
            + Send
            + Sync
            + 'static,
    {
        crate::messaging::collaboration::conversation_agent_run_states::router(
            admission,
            self.clone(),
        )
    }

    async fn resolve_target(
        &self,
        conversation: &ConversationId,
        agent: &AgentId,
    ) -> Result<RuntimeDispatchTarget, DaemonDeliveryError> {
        self.data
            .resolve_dispatch_target(conversation.clone(), agent.clone())
            .await?
            .ok_or(DaemonDeliveryError::TargetMissing)
    }

    async fn hydrate(&self, attachment: &DaemonAttachment) -> Result<(), DaemonDeliveryError> {
        let result = attachment
            .command("runtime_status", json!({}), self.config.command_timeout)
            .await
            .map_err(|source| DaemonDeliveryError::Hydration(Box::new(source)))?;
        let status = RuntimeStatusResult::decode(result)
            .map_err(|source| DaemonDeliveryError::Hydration(Box::new(source)))?;
        let hydrated = status
            .hydrated(attachment.daemon_instance.clone())
            .map_err(|source| DaemonDeliveryError::Hydration(Box::new(source)))?;
        let persisted = self
            .data
            .current_custodies_for_host(attachment.host_id.clone())
            .await?;
        let active = status
            .active_principals(attachment.daemon_instance.clone())
            .map_err(|source| DaemonDeliveryError::Hydration(Box::new(source)))?;
        let active_set = active
            .iter()
            .cloned()
            .collect::<std::collections::HashSet<_>>();
        self.events
            .hydrate(
                &attachment.host_id,
                &attachment.daemon_instance,
                &attachment.connection_id,
                active_set
                    .iter()
                    .map(|principal| principal.agent().clone())
                    .collect(),
                hydrated,
            )
            .await
            .map_err(|source| DaemonDeliveryError::Hydration(Box::new(source)))?;
        let persisted_set = persisted
            .iter()
            .cloned()
            .collect::<std::collections::HashSet<_>>();
        let stop = StopTransport {
            attachment: attachment.clone(),
            timeout: self.config.command_timeout,
        };
        for principal in active {
            if persisted_set.contains(&principal) {
                self.credentials
                    .reconcile_hydrated(principal, &stop)
                    .await
                    .map_err(|source| DaemonDeliveryError::Hydration(Box::new(source)))?;
            } else {
                stop.stop_exact(&principal)
                    .await
                    .map_err(|source| DaemonDeliveryError::Hydration(Box::new(source)))?;
            }
        }
        for principal in persisted {
            if !active_set.contains(&principal) {
                self.credentials
                    .finalize(principal, RuntimeFinalStatus::Crashed)
                    .await?;
            }
        }
        Ok(())
    }

    async fn start(
        &self,
        conversation: &ConversationId,
        agent: &AgentId,
    ) -> Result<(), DaemonDeliveryError> {
        let target = self.resolve_target(conversation, agent).await?;
        let attachment = self
            .registry
            .attachment(&target.host_id)?
            .ok_or(DaemonDeliveryError::HostNotAttached)?;
        let transport = StartTransport {
            attachment,
            target: target.clone(),
            timeout: self.config.command_timeout,
        };
        self.credentials
            .dispatch_start(
                target.plan.scope.clone(),
                transport.attachment.daemon_instance.clone(),
                &transport,
            )
            .await
            .map(|_| ())
            .map_err(DaemonDeliveryError::start)
    }

    async fn start_if_idle(
        &self,
        conversation: &ConversationId,
        agent: &AgentId,
    ) -> Result<(), DaemonDeliveryError> {
        let target = self.resolve_target(conversation, agent).await?;
        if self
            .credentials
            .current(target.plan.scope.clone())
            .await?
            .is_some()
        {
            return Ok(());
        }
        self.start(conversation, agent).await
    }

    async fn deliver(
        &self,
        conversation: &ConversationId,
        agent: &AgentId,
    ) -> Result<(), DaemonDeliveryError> {
        let target = self.resolve_target(conversation, agent).await?;
        let attachment = self
            .registry
            .attachment(&target.host_id)?
            .ok_or(DaemonDeliveryError::HostNotAttached)?;
        let transport = DeliveryTransport {
            attachment,
            target: target.clone(),
            data: self.data.clone(),
            timeout: self.config.command_timeout,
            lease_ttl_ms: self.config.lease_ttl_ms(),
        };
        match self
            .credentials
            .dispatch_start(
                target.plan.scope.clone(),
                transport.attachment.daemon_instance.clone(),
                &transport,
            )
            .await
        {
            Ok(_) => Ok(()),
            Err(RuntimeStartFailure::ProvenNotDispatched(DeliveryTransportError::NoPending)) => {
                Ok(())
            }
            Err(error) => Err(DaemonDeliveryError::delivery(error)),
        }
    }
}

#[derive(Clone)]
pub struct DaemonDeliveryEffects<C, D, H> {
    runtime: DaemonDeliveryRuntime<C, D, H>,
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
        // The target conversation is the SEALED message's own, never a caller
        // coordinate: a message committed for c1 can only wake c1's agents. The
        // runtime then locates the work by (conversation, agent), identically to the
        // copy/main/reply delivery legs above.
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

#[derive(Debug)]
pub enum DaemonDeliveryError {
    TargetMissing,
    HostNotAttached,
    Persistence(PersistenceFailure),
    Registry(DaemonRegistryError),
    Start(Box<dyn Error + Send + Sync>),
    Delivery(Box<dyn Error + Send + Sync>),
    Hydration(Box<dyn Error + Send + Sync>),
}

impl DaemonDeliveryError {
    fn start<E: Error + Send + Sync + 'static>(source: RuntimeStartFailure<E>) -> Self {
        Self::Start(Box::new(source))
    }

    fn delivery<E: Error + Send + Sync + 'static>(source: RuntimeStartFailure<E>) -> Self {
        Self::Delivery(Box::new(source))
    }
}

impl fmt::Display for DaemonDeliveryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::TargetMissing => "runtime dispatch target does not exist",
            Self::HostNotAttached => "runtime host has no compatible daemon attachment",
            Self::Persistence(_) => "runtime delivery persistence failed",
            Self::Registry(_) => "daemon attachment registry failed",
            Self::Start(_) => "runtime start failed",
            Self::Delivery(_) => "runtime delivery failed",
            Self::Hydration(_) => "daemon runtime hydration failed",
        })
    }
}

impl Error for DaemonDeliveryError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Persistence(source) => Some(source),
            Self::Registry(source) => Some(source),
            Self::Start(source) | Self::Delivery(source) | Self::Hydration(source) => {
                Some(source.as_ref())
            }
            Self::TargetMissing | Self::HostNotAttached => None,
        }
    }
}

impl From<PersistenceFailure> for DaemonDeliveryError {
    fn from(source: PersistenceFailure) -> Self {
        Self::Persistence(source)
    }
}

impl From<DaemonRegistryError> for DaemonDeliveryError {
    fn from(source: DaemonRegistryError) -> Self {
        Self::Registry(source)
    }
}

#[derive(Clone)]
struct DaemonAttachment {
    host_id: String,
    connection_id: String,
    daemon_instance: DaemonInstanceId,
    host_name: String,
    commands: mpsc::Sender<ConnectionControl>,
}

#[derive(Clone)]
struct AttachedDaemon {
    daemon_instance: DaemonInstanceId,
    host_name: String,
}

#[derive(Clone)]
struct DaemonRegistry {
    state: Arc<Mutex<RegistryState>>,
    changed: Arc<Notify>,
    process_epoch: Arc<str>,
}

#[derive(Default)]
struct RegistryState {
    closing: bool,
    next_connection: u64,
    slots: HashMap<String, DaemonSlot>,
}

struct DaemonSlot {
    connection_id: String,
    commands: mpsc::Sender<ConnectionControl>,
    close: watch::Sender<Option<ConnectionClose>>,
    attached: Option<AttachedDaemon>,
}

#[derive(Clone)]
struct GenerationCloseControl {
    connection_id: String,
    sender: watch::Sender<Option<ConnectionClose>>,
}

impl DaemonRegistry {
    fn new() -> Result<Self, DaemonDeliveryBuildError> {
        let mut entropy = [0_u8; 16];
        getrandom::fill(&mut entropy).map_err(DaemonDeliveryBuildError::Entropy)?;
        Ok(Self::with_process_epoch(URL_SAFE_NO_PAD.encode(entropy)))
    }

    fn with_process_epoch(process_epoch: String) -> Self {
        Self {
            state: Arc::new(Mutex::new(RegistryState::default())),
            changed: Arc::new(Notify::new()),
            process_epoch: process_epoch.into(),
        }
    }

    fn reserve(
        &self,
        host_id: &str,
        commands: mpsc::Sender<ConnectionControl>,
        close: watch::Sender<Option<ConnectionClose>>,
    ) -> Result<String, ReserveConnectionError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| ReserveConnectionError::Poisoned)?;
        if state.closing {
            return Err(ReserveConnectionError::Closing);
        }
        if state.slots.contains_key(host_id) {
            return Err(ReserveConnectionError::Occupied);
        }
        state.next_connection = state
            .next_connection
            .checked_add(1)
            .ok_or(ReserveConnectionError::Exhausted)?;
        let connection_id = format!(
            "daemon-connection-{}-{}",
            self.process_epoch, state.next_connection
        );
        state.slots.insert(
            host_id.to_owned(),
            DaemonSlot {
                connection_id: connection_id.clone(),
                commands,
                close,
                attached: None,
            },
        );
        self.changed.notify_waiters();
        Ok(connection_id)
    }

    fn attach(
        &self,
        host_id: &str,
        connection_id: &str,
        attached: AttachedDaemon,
    ) -> Result<bool, DaemonRegistryError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| DaemonRegistryError::Poisoned)?;
        let Some(slot) = state.slots.get_mut(host_id) else {
            return Ok(false);
        };
        if slot.connection_id != connection_id {
            return Ok(false);
        }
        slot.attached = Some(attached);
        self.changed.notify_waiters();
        Ok(true)
    }

    fn attachment(&self, host_id: &str) -> Result<Option<DaemonAttachment>, DaemonRegistryError> {
        let state = self
            .state
            .lock()
            .map_err(|_| DaemonRegistryError::Poisoned)?;
        let Some(slot) = state.slots.get(host_id) else {
            return Ok(None);
        };
        let Some(attached) = slot.attached.clone() else {
            return Ok(None);
        };
        Ok(Some(DaemonAttachment {
            host_id: host_id.to_owned(),
            connection_id: slot.connection_id.clone(),
            daemon_instance: attached.daemon_instance,
            host_name: attached.host_name,
            commands: slot.commands.clone(),
        }))
    }

    /// Snapshot exactly the generation that holds `host_id` now.
    ///
    /// The connection id plus its private channel are one generation-bound capability.
    /// If that generation disappears after this lock is released, a replacement gets a
    /// different channel; sending through the captured value can therefore never close
    /// the replacement. Cleanup keeps the slot until the socket task actually exits, so
    /// two live transports are not briefly admitted for one host.
    fn current_close_control(
        &self,
        host_id: &str,
    ) -> Result<Option<GenerationCloseControl>, DaemonRegistryError> {
        Ok(self
            .state
            .lock()
            .map_err(|_| DaemonRegistryError::Poisoned)?
            .slots
            .get(host_id)
            .map(|slot| GenerationCloseControl {
                connection_id: slot.connection_id.clone(),
                sender: slot.close.clone(),
            }))
    }

    fn remove(&self, host_id: &str, connection_id: &str) {
        if let Ok(mut state) = self.state.lock()
            && state
                .slots
                .get(host_id)
                .is_some_and(|slot| slot.connection_id == connection_id)
        {
            state.slots.remove(host_id);
        }
        self.changed.notify_waiters();
    }

    fn active_count(&self) -> usize {
        self.state.lock().map_or(0, |state| state.slots.len())
    }

    fn attached_count(&self) -> usize {
        self.state.lock().map_or(0, |state| {
            state
                .slots
                .values()
                .filter(|slot| slot.attached.is_some())
                .count()
        })
    }

    /// Who holds this host's slot right now, reserved or attached.
    ///
    /// Deliberately narrower than [`Self::attachment`]: it answers only the
    /// question the admission rule asks, and carries neither the command sender nor
    /// the daemon instance, so no caller can grow a second use out of it.
    fn slot_connection_id(&self, host_id: &str) -> Result<Option<String>, DaemonRegistryError> {
        let state = self
            .state
            .lock()
            .map_err(|_| DaemonRegistryError::Poisoned)?;
        Ok(state
            .slots
            .get(host_id)
            .map(|slot| slot.connection_id.clone()))
    }
}

/// The registry is the connection authority, so it is the only implementer of the
/// admission leaf's occupancy port. The direction is load-bearing at compile time:
/// the port is declared where it is consumed, so the rule cannot reach back into
/// this module for the attached-custody fact it must not decide on.
impl SlotOccupancy for DaemonRegistry {
    fn slot_dialer(&self, host_id: &str) -> Result<Option<DialerId>, AdmissionUnavailable> {
        Ok(self
            .slot_connection_id(host_id)
            .map_err(|_| AdmissionUnavailable)?
            .as_deref()
            .map(DialerId::from_connection))
    }
}

/// The seed layer's port, implemented here for the same reason and answered from the
/// same registry — but from the ATTACHED custody, not the reserved slot the admission
/// rule reads. Two questions, two ports, one authority: a reserved socket has no
/// facts to be asked for, and a seed filed against one would be filed against
/// nothing.
///
/// What the status answer means is not decided here either: this forwards to the
/// snapshot leaf, so the seed layer gets a probe whose contract it does not own and
/// cannot restate.
impl DaemonCustody for OwningHostDataPlane {
    fn attached_custody(
        &self,
        host: &HostId,
    ) -> Result<Option<AttachedStatusCustody>, CustodyUnavailable> {
        Ok(self
            .registry
            .attachment(host.as_str())
            .map_err(|_| CustodyUnavailable)?
            .map(|attachment| AttachedStatusCustody {
                daemon_instance: attachment.daemon_instance,
                connection_id: attachment.connection_id,
            }))
    }

    fn probe_status<'a>(
        &'a self,
        request: StatusSnapshotRequest,
    ) -> Pin<Box<dyn Future<Output = StatusSnapshotOutcome> + Send + 'a>> {
        let host = request.host().clone();
        let instance = request.daemon_instance().clone();
        Box::pin(async move {
            match self.resolve(&host) {
                Ok(Some(custody)) if custody.daemon_instance() == &instance => {
                    status_snapshot::probe(self, StatusSnapshotRequest::new(custody)).await
                }
                Ok(_) => StatusSnapshotOutcome::Disconnected,
                Err(_) => StatusSnapshotOutcome::Unreachable(
                    crate::host_control::status_snapshot::UnreachableReason::DaemonUnreachable,
                ),
            }
        })
    }
}

#[derive(Debug)]
enum ReserveConnectionError {
    Closing,
    Occupied,
    Exhausted,
    Poisoned,
}

#[derive(Debug)]
pub enum DaemonRegistryError {
    Poisoned,
}

impl fmt::Display for DaemonRegistryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("daemon attachment registry is unavailable")
    }
}

impl Error for DaemonRegistryError {}

#[derive(Clone)]
pub struct DaemonDeliveryController {
    registry: DaemonRegistry,
    admission: HostAdmission,
    seeds: HostStatusSeeds,
    shutdown_grace: Duration,
}

impl DaemonDeliveryController {
    pub fn owning_host_data_plane(&self) -> OwningHostDataPlane {
        OwningHostDataPlane {
            registry: self.registry.clone(),
        }
    }

    /// The R6 token-rotation transport, bound to a share of the one registry so it names
    /// the same live attachments the delivery path does — never a second registry, which
    /// could rotate a token against a connection this runtime does not hold.
    pub fn host_token_rotation(&self) -> DaemonTokenRotation {
        DaemonTokenRotation {
            registry: self.registry.clone(),
        }
    }

    /// The admission ledger the connection tasks of this runtime write through.
    ///
    /// A clone of one ledger, never a new one: [`HostAdmission`] has no public
    /// constructor and cloning shares the record set, so a composition cannot end up
    /// answering a host from an emptier copy than the one that recorded the refusal.
    pub fn host_admission(&self) -> HostAdmission {
        self.admission.clone()
    }

    /// The status seed store this runtime's attachments seed into.
    ///
    /// A clone of one store, never a new one, for the same reason: cloning shares the
    /// sealed facts, so a read surface cannot answer a host from a store that never
    /// saw its seed — and, having no public constructor, cannot build one either.
    pub fn host_status_seeds(&self) -> HostStatusSeeds {
        self.seeds.clone()
    }

    /// A read-only projection of daemon-reported host names. The handle carries no
    /// dispatch or shutdown methods, so a detail route cannot accidentally grow into a
    /// second connection controller merely because it needs diagnostic metadata.
    pub fn connected_host_names(&self) -> ConnectedHostNameView {
        ConnectedHostNameView {
            registry: self.registry.clone(),
        }
    }

    /// Per-computer connection control sharing this runtime's one registry.
    pub fn connection_control(&self) -> DaemonConnectionControlHandle {
        DaemonConnectionControlHandle {
            registry: self.registry.clone(),
        }
    }

    /// The daemon-backed half of computer-cascade teardown. It can stop an exact
    /// captured seat and purge one agent home, but cannot announce identity changes or
    /// touch the blob store; those authorities are composed separately.
    pub fn cascade_daemon_effects(&self) -> DaemonCascadeEffects {
        DaemonCascadeEffects {
            registry: self.registry.clone(),
        }
    }

    pub fn active_connection_count(&self) -> usize {
        self.registry.active_count()
    }

    pub fn attached_connection_count(&self) -> usize {
        self.registry.attached_count()
    }

    /// Whether the delivery transport currently holds an attachment for one host.
    /// This reads the SAME slot the delivery dispatch gate consults — a slot is
    /// attached exactly when it carries a hydrated `daemon_instance` — so an
    /// availability read and the delivery path observe one fact rather than two
    /// projections that can drift.
    pub fn host_attached(&self, host_id: &str) -> Result<bool, DaemonRegistryError> {
        Ok(self.registry.attachment(host_id)?.is_some())
    }

    pub async fn close(&self) {
        let senders = {
            let Ok(mut state) = self.registry.state.lock() else {
                return;
            };
            state.closing = true;
            state
                .slots
                .values()
                .map(|slot| slot.close.clone())
                .collect::<Vec<_>>()
        };
        for sender in senders {
            let _ = sender.send(Some(ConnectionClose {
                expected_connection_id: None,
                reason: "server_shutdown",
            }));
        }
        let deadline = Instant::now() + self.shutdown_grace;
        while self.active_connection_count() != 0 {
            if tokio::time::timeout_at(deadline, self.registry.changed.notified())
                .await
                .is_err()
            {
                return;
            }
        }
    }
}

/// Diagnostic-only attachment-name view. `Clone` shares the registry; it never
/// snapshots names into a second lifecycle authority.
#[derive(Clone)]
pub struct ConnectedHostNameView {
    registry: DaemonRegistry,
}

impl ConnectedHostName for ConnectedHostNameView {
    fn connected_host_name(&self, computer: &HostId) -> Option<String> {
        self.registry
            .attachment(computer.as_str())
            .ok()
            .flatten()
            .map(|attachment| attachment.host_name)
    }
}

/// The narrow production answer to the core's post-commit disconnect port.
#[derive(Clone)]
pub struct DaemonConnectionControlHandle {
    registry: DaemonRegistry,
}

impl DaemonConnectionControl for DaemonConnectionControlHandle {
    async fn disconnect(&self, computer: HostId) -> Result<(), CustodyEffectFailure> {
        let current = self
            .registry
            .current_close_control(computer.as_str())
            .map_err(CustodyEffectFailure::from_source)?;
        let Some(current) = current else {
            return Ok(());
        };
        // If the captured task ended between the snapshot and this send, there is no
        // live captured generation left to close. Any replacement has a different
        // channel, so the idempotent effect is complete without touching it.
        let _ = current.sender.send(Some(ConnectionClose {
            expected_connection_id: Some(current.connection_id),
            reason: HOST_REVOKED_CLOSE_REASON,
        }));
        Ok(())
    }
}

impl DaemonConnectionControlHandle {
    /// Availability-only user disconnect. The close signal travels through the
    /// captured generation's private channel, so a replacement can never receive
    /// it. Presence of the captured slot is the product's boolean result even if
    /// that socket task exits during the send.
    pub fn disconnect_user_managed(&self, computer: &HostId) -> Result<bool, DaemonRegistryError> {
        let current = self.registry.current_close_control(computer.as_str())?;
        let Some(current) = current else {
            return Ok(false);
        };
        let _ = current.sender.send(Some(ConnectionClose {
            expected_connection_id: Some(current.connection_id),
            reason: HOST_DISCONNECTED_CLOSE_REASON,
        }));
        Ok(true)
    }
}

/// Real daemon transports used by the production computer-cascade composer.
#[derive(Clone)]
pub struct DaemonCascadeEffects {
    registry: DaemonRegistry,
}

impl DaemonCascadeEffects {
    pub(crate) async fn stop_runtime_seat(
        &self,
        computer: &HostId,
        seat: &AgentRuntimeSessionFacts,
    ) -> Result<(), CustodyEffectFailure> {
        let attachment = self
            .attachment(computer)
            .map_err(CustodyEffectFailure::from_source)?;
        let result = attachment
            .command(
                "runtime_stop",
                json!({
                    "runtime_scope": scope_wire(&seat.scope),
                    "runtime_generation": seat.generation.as_i64(),
                    "mode": "hard",
                }),
                DEFAULT_COMMAND_TIMEOUT,
            )
            .await
            .map_err(|source| {
                CustodyEffectFailure::from_source(CascadeDaemonError::Command(source))
            })?;
        if !valid_runtime_stop_result(&result) {
            return Err(CustodyEffectFailure::from_source(
                CascadeDaemonError::InvalidRuntimeStopResponse,
            ));
        }
        Ok(())
    }

    pub(crate) async fn purge_host_local_files(
        &self,
        computer: &HostId,
        agent: &AgentId,
    ) -> Result<(), CustodyEffectFailure> {
        let attachment = self
            .attachment(computer)
            .map_err(CustodyEffectFailure::from_source)?;
        let result = attachment
            .command(
                "agent_files_purge",
                json!({ "agent_id": agent.as_str() }),
                HOST_LOCAL_PURGE_TIMEOUT,
            )
            .await
            .map_err(|source| {
                CustodyEffectFailure::from_source(CascadeDaemonError::Command(source))
            })?;
        if !valid_agent_files_purge_result(&result) {
            return Err(CustodyEffectFailure::from_source(
                CascadeDaemonError::InvalidAgentFilesPurgeResponse,
            ));
        }
        Ok(())
    }

    fn attachment(&self, computer: &HostId) -> Result<DaemonAttachment, CascadeDaemonError> {
        self.registry
            .attachment(computer.as_str())
            .map_err(CascadeDaemonError::Registry)?
            .ok_or(CascadeDaemonError::NoCurrentDaemon)
    }
}

#[derive(Debug)]
enum CascadeDaemonError {
    Registry(DaemonRegistryError),
    NoCurrentDaemon,
    Command(CommandDispatchError),
    InvalidRuntimeStopResponse,
    InvalidAgentFilesPurgeResponse,
}

impl fmt::Display for CascadeDaemonError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Registry(_) => "daemon attachment registry is unavailable",
            Self::NoCurrentDaemon => "host has no attached daemon",
            Self::Command(_) => "daemon cascade command failed",
            Self::InvalidRuntimeStopResponse => "daemon returned an invalid runtime_stop response",
            Self::InvalidAgentFilesPurgeResponse => {
                "daemon returned an invalid agent_files_purge response"
            }
        })
    }
}

impl Error for CascadeDaemonError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Registry(source) => Some(source),
            Self::Command(source) => Some(source),
            Self::NoCurrentDaemon
            | Self::InvalidRuntimeStopResponse
            | Self::InvalidAgentFilesPurgeResponse => None,
        }
    }
}

enum ConnectionControl {
    Command(CommandRequest),
    Hydrated(Result<AttachedDaemon, DaemonDeliveryError>),
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ConnectionClose {
    expected_connection_id: Option<String>,
    reason: &'static str,
}

struct CommandRequest {
    kind: &'static str,
    params: Value,
    deadline: Instant,
    response: oneshot::Sender<Result<Value, CommandDispatchError>>,
}

fn command_expired_before_send(command: &CommandRequest) -> bool {
    command.response.is_closed() || Instant::now() >= command.deadline
}

type PendingCommand = (
    &'static str,
    oneshot::Sender<Result<Value, CommandDispatchError>>,
);

#[derive(Debug)]
enum CommandDispatchError {
    ProvenNotDispatched,
    Ambiguous,
    TimedOut,
    DaemonRefused(CommandRefusal),
    InvalidResponse,
}

impl fmt::Display for CommandDispatchError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::ProvenNotDispatched => "daemon command was proven not dispatched",
            Self::Ambiguous => "daemon command outcome is ambiguous",
            Self::TimedOut => "daemon command timed out",
            Self::DaemonRefused(_) => "daemon refused the command",
            Self::InvalidResponse => "daemon returned an invalid command response",
        })
    }
}

impl Error for CommandDispatchError {}

/// The `ResponseError.code` union every command kind may be refused with. Closed
/// as a type so a token outside it can never reach a caller as a reportable
/// refusal: an unknown code is a corrupt frame, and the decode site fails the
/// connection over it instead of inventing a refusal the caller has no arm for.
/// Private to this module because that admission is all it is for — no caller,
/// here or in the TS contract, acts on which of the five arrived.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DaemonRefusalCode {
    UnknownIntent,
    InvalidParams,
    InternalError,
    ShuttingDown,
    RequestTooLarge,
}

impl DaemonRefusalCode {
    fn parse(raw: &str) -> Option<Self> {
        match raw {
            "unknown_intent" => Some(Self::UnknownIntent),
            "invalid_params" => Some(Self::InvalidParams),
            "internal_error" => Some(Self::InternalError),
            "shutting_down" => Some(Self::ShuttingDown),
            "request_too_large" => Some(Self::RequestTooLarge),
            _ => None,
        }
    }
}

/// Codes only `runtime_start` and `runtime_deliver` may be refused with. Kept in
/// their own type because they are the runtime operation's vocabulary, not the
/// transport's: admitting them for another kind would let a daemon answer a
/// host-control command in a language that command has no arm for.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RuntimeRefusalCode {
    AgentDeleting,
    WorkspaceNotProvisioned,
    WorkspaceBundleMissing,
    RegistryUnavailable,
}

/// Codes scoped to `agent_files_purge`. They are accepted only on that command;
/// seeing one on any other kind is protocol corruption.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AgentFilesPurgeRefusalCode {
    QuiesceFailed,
    PartialPurge,
}

impl AgentFilesPurgeRefusalCode {
    fn parse(raw: &str) -> Option<Self> {
        match raw {
            "quiesce_failed" => Some(Self::QuiesceFailed),
            "partial_purge" => Some(Self::PartialPurge),
            _ => None,
        }
    }
}

impl RuntimeRefusalCode {
    fn parse(raw: &str) -> Option<Self> {
        match raw {
            "agent_deleting" => Some(Self::AgentDeleting),
            "workspace_not_provisioned" => Some(Self::WorkspaceNotProvisioned),
            "workspace_bundle_missing" => Some(Self::WorkspaceBundleMissing),
            "registry_unavailable" => Some(Self::RegistryUnavailable),
            _ => None,
        }
    }
}

/// Which refusal vocabulary the daemon answered a command in. The codes themselves
/// stay closed sets and each `parse` is still what admits a token for a kind, but
/// the admitted value is not carried: nothing reads which code arrived, while the
/// vocabulary decides everything — a response-level code is a refusal, and a
/// runtime-scoped code on a host-control kind is a frame in the wrong language.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CommandRefusal {
    Response,
    RuntimeScoped,
    AgentFilesPurgeScoped,
}

impl CommandRefusal {
    fn decode(kind: &str, value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        if object.len() != 2 || object.get("message").and_then(Value::as_str).is_none() {
            return None;
        }
        let code = object.get("code").and_then(Value::as_str)?;
        if DaemonRefusalCode::parse(code).is_some() {
            return Some(Self::Response);
        }
        if !matches!(kind, "runtime_start" | "runtime_deliver") {
            return (kind == "agent_files_purge")
                .then(|| AgentFilesPurgeRefusalCode::parse(code))
                .flatten()
                .map(|_| Self::AgentFilesPurgeScoped);
        }
        RuntimeRefusalCode::parse(code).map(|_| Self::RuntimeScoped)
    }
}

impl DaemonAttachment {
    async fn command(
        &self,
        kind: &'static str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, CommandDispatchError> {
        let deadline = Instant::now()
            .checked_add(timeout)
            .ok_or(CommandDispatchError::TimedOut)?;
        let (response, receive) = oneshot::channel();
        self.commands
            .try_send(ConnectionControl::Command(CommandRequest {
                kind,
                params,
                deadline,
                response,
            }))
            .map_err(|_| CommandDispatchError::ProvenNotDispatched)?;
        match tokio::time::timeout_at(deadline, receive).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(CommandDispatchError::Ambiguous),
            Err(_) => Err(CommandDispatchError::TimedOut),
        }
    }
}

/// Command kinds admitted through the shared owning-host outbound data plane.
/// Closed here because the wire vocabulary belongs to the transport; payload
/// schemas remain in command-specific adapters.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum HostDataPlaneCommandKind {
    HostStatus,
    RuntimeCatalog,
    ProxyConfigGet,
    ProxyConfigSet,
    RotateToken,
}

impl HostDataPlaneCommandKind {
    /// Every variant, so the response envelope admits exactly the kinds this face can
    /// send. A variant missing here is not silently tolerated: nothing could answer it.
    const ALL: [Self; 5] = [
        Self::HostStatus,
        Self::RuntimeCatalog,
        Self::ProxyConfigGet,
        Self::ProxyConfigSet,
        Self::RotateToken,
    ];

    fn as_wire(self) -> &'static str {
        match self {
            Self::HostStatus => "host_status",
            Self::RuntimeCatalog => "host_runtime_catalog",
            Self::ProxyConfigGet => "host_proxy_config_get",
            Self::ProxyConfigSet => "host_proxy_config_set",
            Self::RotateToken => "rotate_token",
        }
    }

    fn sends_wire(kind: &str) -> bool {
        Self::ALL
            .iter()
            .any(|candidate| candidate.as_wire() == kind)
    }
}

/// One owning-host data-plane round trip. Crate-private on purpose: a raw command pairs a
/// kind with a free-form payload and a budget, so anything able to build one could
/// send a legal kind with a payload that kind has no contract for. Only the typed
/// command adapters may state that pairing.
pub(crate) struct HostDataPlaneRequest {
    pub(crate) custody: HostDataPlaneCustody,
    pub(crate) kind: HostDataPlaneCommandKind,
    pub(crate) params: Value,
    pub(crate) timeout: Duration,
}

/// The host and daemon instance captured together from the live registry.
/// Fields and constructor are private: a route cannot cross-wire host A with an
/// instance it observed on host B, and a command cannot change the host after
/// resolution.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HostDataPlaneCustody {
    host: HostId,
    instance: DaemonInstanceId,
    connection_id: String,
}

impl HostDataPlaneCustody {
    pub fn host(&self) -> &HostId {
        &self.host
    }

    pub fn daemon_instance(&self) -> &DaemonInstanceId {
        &self.instance
    }
}

/// A daemon answer together with the coordinate it was answered on. The pair is
/// the transport's own — the host is the registry key whose slot served the
/// command, the instance the custody that slot was attached with — and the fields
/// are private with no way to build one from parts.
///
/// The only opening is [`Self::into_result_for`], so a consumer cannot take a
/// value out without naming the coordinate it awaited: one host's legal answer can
/// never be filed under another host's key, not even when both machines happen to
/// spell their daemon instance the same way.
pub(crate) struct HostDataPlaneAnswer {
    host: HostId,
    instance: DaemonInstanceId,
    connection_id: String,
    result: Value,
}

impl HostDataPlaneAnswer {
    pub(crate) fn into_result_for(
        self,
        custody: &HostDataPlaneCustody,
    ) -> Result<Value, HostDataPlaneAnswerMismatch> {
        if self.host != custody.host {
            return Err(HostDataPlaneAnswerMismatch::Host);
        }
        if self.connection_id != custody.connection_id {
            return Err(HostDataPlaneAnswerMismatch::ConnectionGeneration);
        }
        if self.instance != custody.instance {
            return Err(HostDataPlaneAnswerMismatch::DaemonInstance);
        }
        Ok(self.result)
    }
}

/// Which coordinate of an answer failed to match the request that awaited it.
/// Never a refusal an operation may report: an operation asked about one machine's
/// custody and was handed another's, which no caller can act on and no daemon
/// caused. It is this crate's own contract failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum HostDataPlaneAnswerMismatch {
    Host,
    ConnectionGeneration,
    DaemonInstance,
}

#[derive(Debug)]
pub(crate) enum HostDataPlaneFailure {
    NoCurrentDaemon,
    ConnectionGenerationMismatch,
    DaemonInstanceMismatch,
    NotDispatched,
    Ambiguous,
    TimedOut,
    /// The daemon answered with a code the closed set admits for this kind. Which
    /// code it was is deliberately not carried: no reader in this crate — and no
    /// mapper in the TS contract for either host-control operation — distinguishes
    /// them. What the closed set is load-bearing for is the arm itself: a refusal
    /// leaves the connection alive, and anything outside the set does not.
    Refused,
    ProtocolCorruption,
    RegistryUnavailable,
}

impl HostDataPlaneFailure {
    fn from_dispatch(error: CommandDispatchError) -> Self {
        match error {
            CommandDispatchError::ProvenNotDispatched => Self::NotDispatched,
            CommandDispatchError::Ambiguous => Self::Ambiguous,
            CommandDispatchError::TimedOut => Self::TimedOut,
            CommandDispatchError::DaemonRefused(CommandRefusal::Response) => Self::Refused,
            // A runtime-scoped code is not admitted for a host-control kind, so
            // reaching this arm means the frame decoded as something no
            // host-control command can be refused with.
            CommandDispatchError::DaemonRefused(
                CommandRefusal::RuntimeScoped | CommandRefusal::AgentFilesPurgeScoped,
            )
            | CommandDispatchError::InvalidResponse => Self::ProtocolCorruption,
        }
    }
}

impl fmt::Display for HostDataPlaneFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::NoCurrentDaemon => "host has no attached daemon",
            Self::ConnectionGenerationMismatch => {
                "host daemon connection generation changed before dispatch"
            }
            Self::DaemonInstanceMismatch => "host daemon custody changed before dispatch",
            Self::NotDispatched => "host command was proven not dispatched",
            Self::Ambiguous => "host command outcome is ambiguous",
            Self::TimedOut => "host command timed out",
            Self::Refused => "daemon refused the host command",
            Self::ProtocolCorruption => "daemon answered the host command with a corrupt frame",
            Self::RegistryUnavailable => "daemon attachment registry is unavailable",
        })
    }
}

impl Error for HostDataPlaneFailure {}

/// The one production owner for correlated outbound commands to a named host.
/// It resolves a generation-bound custody from the live daemon registry, and the
/// raw round trip remains crate-private so route schemas stay in typed adapters.
///
/// ```compile_fail
/// use silverhand_backend_server::daemon_delivery::{HostDataPlaneRequest, HostDataPlaneCommandKind};
///
/// fn forge() -> HostDataPlaneRequest {
///     HostDataPlaneRequest {
///         host: silverhand_backend_core::identity::HostId::parse("host-1").unwrap(),
///         expected_instance: silverhand_backend_core::identity::DaemonInstanceId::parse("i").unwrap(),
///         kind: HostDataPlaneCommandKind::RuntimeCatalog,
///         params: serde_json::json!({ "force": true }),
///         timeout: std::time::Duration::from_secs(1),
///     }
/// }
/// ```
///
/// ```compile_fail
/// use silverhand_backend_server::daemon_delivery::OwningHostDataPlane;
///
/// // Names no crate-private type, so nothing here fails for a naming reason. The
/// // round trip stays unreachable while ANY part of it — the parameter, the answer,
/// // the failure, or the method — is crate-private: publishing the whole face is
/// // what turns this green.
/// async fn send(dispatch: &OwningHostDataPlane) {
///     let _ = dispatch.dispatch(unreachable!()).await;
/// }
/// ```
///
/// ```
/// use silverhand_backend_core::identity::HostId;
/// use silverhand_backend_server::{
///     daemon_delivery::{DaemonDeliveryController, OwningHostDataPlane},
///     host_control::runtime_catalog::{self, RuntimeCatalogOutcome, RuntimeCatalogRequest},
/// };
///
/// async fn probe(dispatch: &OwningHostDataPlane) -> RuntimeCatalogOutcome {
///     let _ = DaemonDeliveryController::owning_host_data_plane;
///     let custody = dispatch
///         .resolve(&HostId::parse("host-1").unwrap())
///         .unwrap()
///         .expect("host is attached");
///     runtime_catalog::probe(
///         dispatch,
///         RuntimeCatalogRequest::new(custody, true),
///     )
///     .await
/// }
/// ```
#[derive(Clone)]
pub struct OwningHostDataPlane {
    registry: DaemonRegistry,
}

impl OwningHostDataPlane {
    /// Resolve the attached custody for `host`. `None` is the ordinary offline
    /// answer. A later replacement is caught again inside `dispatch` before send.
    pub fn resolve(
        &self,
        host: &HostId,
    ) -> Result<Option<HostDataPlaneCustody>, DaemonRegistryError> {
        Ok(self
            .registry
            .attachment(host.as_str())?
            .map(|attachment| HostDataPlaneCustody {
                host: host.clone(),
                instance: attachment.daemon_instance,
                connection_id: attachment.connection_id,
            }))
    }

    pub(crate) async fn dispatch(
        &self,
        command: HostDataPlaneRequest,
    ) -> Result<HostDataPlaneAnswer, HostDataPlaneFailure> {
        let host = command.custody.host;
        let expected_instance = command.custody.instance;
        let expected_connection_id = command.custody.connection_id;
        let attachment = self
            .registry
            .attachment(host.as_str())
            .map_err(|_| HostDataPlaneFailure::RegistryUnavailable)?
            .ok_or(HostDataPlaneFailure::NoCurrentDaemon)?;
        if attachment.connection_id != expected_connection_id {
            return Err(HostDataPlaneFailure::ConnectionGenerationMismatch);
        }
        if attachment.daemon_instance != expected_instance {
            return Err(HostDataPlaneFailure::DaemonInstanceMismatch);
        }
        let result = attachment
            .command(command.kind.as_wire(), command.params, command.timeout)
            .await
            .map_err(HostDataPlaneFailure::from_dispatch)?;
        Ok(HostDataPlaneAnswer {
            // The lookup either matched this key's slot or there was no attachment
            // at all, so this is the host that served the command, not a coordinate
            // a consumer may restate later.
            host,
            instance: attachment.daemon_instance,
            connection_id: attachment.connection_id,
            result,
        })
    }
}

/// The R6 transport: hands a freshly minted long-lived token to the daemon that must
/// store it and waits for its answer. A share of the one registry, so it names the same
/// live attachment the delivery path does, and public as an opaque handle only — the
/// round trip behind it is the crate-private [`DaemonAttachment::command`], so the sole
/// way to rotate a token from outside is the core operation this satisfies.
#[derive(Clone)]
pub struct DaemonTokenRotation {
    registry: DaemonRegistry,
}

impl DaemonTokenRotation {
    /// Whoever holds this computer's slot right now. No instance is checked: the TS
    /// coordinator sends by host id and lets the acknowledgement's own `host_id` be the
    /// verdict, which is the core's to render, not this transport's.
    fn attachment(
        &self,
        computer: &HostId,
    ) -> Result<DaemonAttachment, DaemonRotationDeliveryError> {
        self.registry
            .attachment(computer.as_str())
            .map_err(|_| DaemonRotationDeliveryError::Unreachable)?
            .ok_or(DaemonRotationDeliveryError::NoConnection)
    }
}

impl DaemonTokenRotationChannel for DaemonTokenRotation {
    type Failure = DaemonRotationDeliveryError;

    async fn deliver_rotated_token(
        &self,
        delivery: RotatedTokenDelivery,
    ) -> Result<DaemonRotationAck, Self::Failure> {
        let attachment = self.attachment(delivery.computer())?;
        // Read the coordinates first and take the secret last: the delivery's own type
        // enforces that order, so the frame is built without a second reader of the token.
        let host_id = delivery.computer().as_str().to_owned();
        let issued_at = delivery.issued_at();
        let grace_until = delivery.grace_until();
        let params = rotation_params(&host_id, delivery.reveal_token(), issued_at, grace_until);
        let result = attachment
            .command(
                HostDataPlaneCommandKind::RotateToken.as_wire(),
                params,
                HOST_TOKEN_ROTATION_TIMEOUT,
            )
            .await
            .map_err(|_| DaemonRotationDeliveryError::Unreachable)?;
        parse_rotation_ack(&result).ok_or(DaemonRotationDeliveryError::Unreachable)
    }
}

/// Why a `rotate_token` round trip produced no answer. Exactly the two the core trait
/// asks this component to tell apart, because they decide the status code: nobody was
/// connected, or a daemon was but the round trip did not complete usably.
#[derive(Debug)]
pub enum DaemonRotationDeliveryError {
    /// No daemon holds this computer's slot. The route answers 503 — `transport_no_connection`.
    NoConnection,
    /// A daemon was attached but the round trip did not complete cleanly: it timed out,
    /// the connection broke, the registry was unreadable, or the answer was unusable. The
    /// route answers 502.
    Unreachable,
}

impl fmt::Display for DaemonRotationDeliveryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::NoConnection => "no daemon is connected for this computer",
            Self::Unreachable => "the daemon could not be reached for a token rotation",
        })
    }
}

impl Error for DaemonRotationDeliveryError {}

/// The `rotate_token` frame the daemon receives, keyed exactly as the TS coordinator
/// sends it: `host_id`, the cleartext `host_token`, and the two instants.
fn rotation_params(host_id: &str, host_token: String, issued_at: i64, grace_until: i64) -> Value {
    json!({
        "host_id": host_id,
        "host_token": host_token,
        "issued_at": issued_at,
        "grace_until": grace_until,
    })
}

/// Decode the daemon's answer into the core's acknowledgement vocabulary.
///
/// `rotated: true` is the only shape that stores anything, and it must carry the computer
/// the daemon refreshed and the instant it did — the core compares that computer against
/// the one we sent, so a wrong-but-parseable host is reported faithfully and rejected
/// there. Anything else is a refusal, matching the TS coordinator's `!rotated` branch; the
/// daemon's prose reason, if it sent one, rides along for the adapter's log. A `rotated:
/// true` frame missing the computer or the instant is not a refusal but a broken
/// acknowledgement, so it returns `None` and the caller reads it as unreachable.
fn parse_rotation_ack(result: &Value) -> Option<DaemonRotationAck> {
    let object = result.as_object()?;
    match object.get("rotated").and_then(Value::as_bool) {
        Some(true) => {
            let acknowledged = object.get("host_id").and_then(Value::as_str)?;
            let computer = HostId::parse(acknowledged).ok()?;
            let config_refreshed_at = object.get("config_refreshed_at").and_then(Value::as_i64)?;
            Some(DaemonRotationAck::Stored {
                computer,
                config_refreshed_at,
            })
        }
        _ => {
            let reason = object
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            Some(DaemonRotationAck::Refused { reason })
        }
    }
}

struct StartTransport {
    attachment: DaemonAttachment,
    target: RuntimeDispatchTarget,
    timeout: Duration,
}

impl RuntimeStartTransport for StartTransport {
    type Error = StartTransportError;

    async fn dispatch(
        &self,
        handoff: &RuntimeStartHandoff,
    ) -> Result<(), RuntimeDispatchFailure<Self::Error>> {
        let params = runtime_start_params(&self.target, handoff);
        match self
            .attachment
            .command("runtime_start", params, self.timeout)
            .await
        {
            Ok(result) if valid_runtime_start_success(&result) => Ok(()),
            Ok(result) if valid_runtime_start_refusal(&result) => Err(
                RuntimeDispatchFailure::ProvenNotDispatched(StartTransportError::Refused),
            ),
            Ok(_) => Err(RuntimeDispatchFailure::Ambiguous(
                StartTransportError::InvalidResponse,
            )),
            Err(CommandDispatchError::ProvenNotDispatched) => Err(
                RuntimeDispatchFailure::ProvenNotDispatched(StartTransportError::Transport),
            ),
            Err(_) => Err(RuntimeDispatchFailure::Ambiguous(
                StartTransportError::Transport,
            )),
        }
    }
}

#[derive(Debug)]
enum StartTransportError {
    Transport,
    Refused,
    InvalidResponse,
}

impl fmt::Display for StartTransportError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Transport => "runtime_start transport failed",
            Self::Refused => "daemon refused runtime_start",
            Self::InvalidResponse => "daemon returned an invalid runtime_start response",
        })
    }
}

impl Error for StartTransportError {}

struct StopTransport {
    attachment: DaemonAttachment,
    timeout: Duration,
}

impl RuntimeStopTransport for StopTransport {
    type Error = StopTransportError;

    async fn stop_exact(&self, principal: &RuntimePrincipal) -> Result<(), Self::Error> {
        let result = self
            .attachment
            .command(
                "runtime_stop",
                json!({
                    "runtime_scope": scope_wire(&principal.scope()),
                    "runtime_generation": principal.custody().generation().as_i64(),
                    "mode": "hard",
                }),
                self.timeout,
            )
            .await
            .map_err(StopTransportError::Command)?;
        if !valid_runtime_stop_result(&result) {
            return Err(StopTransportError::InvalidResponse);
        }
        Ok(())
    }
}

fn valid_runtime_stop_result(result: &Value) -> bool {
    let Some(object) = result.as_object() else {
        return false;
    };
    object.len() == 3
        && object.get("mode").and_then(Value::as_str) == Some("hard")
        && object.get("stopped").and_then(Value::as_bool).is_some()
        && object
            .get("exit_code")
            .is_some_and(|value| value.is_null() || value.as_i64().is_some())
}

fn valid_agent_files_purge_result(result: &Value) -> bool {
    let Some(object) = result.as_object() else {
        return false;
    };
    object.len() == 3
        && object.get("ok").and_then(Value::as_bool) == Some(true)
        && object
            .get("purged_count")
            .and_then(Value::as_i64)
            .is_some_and(|count| count >= 0)
        && object
            .get("quiesced_count")
            .and_then(Value::as_i64)
            .is_some_and(|count| count >= 0)
}

#[derive(Debug)]
enum StopTransportError {
    Command(CommandDispatchError),
    InvalidResponse,
}

impl fmt::Display for StopTransportError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Command(_) => "runtime_stop transport failed",
            Self::InvalidResponse => "daemon returned an invalid runtime_stop response",
        })
    }
}

impl Error for StopTransportError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Command(source) => Some(source),
            Self::InvalidResponse => None,
        }
    }
}

struct DeliveryTransport<D> {
    attachment: DaemonAttachment,
    target: RuntimeDispatchTarget,
    data: D,
    timeout: Duration,
    lease_ttl_ms: i64,
}

impl<D> RuntimeStartTransport for DeliveryTransport<D>
where
    D: RuntimeInboxCustodyPort,
{
    type Error = DeliveryTransportError;

    async fn dispatch(
        &self,
        handoff: &RuntimeStartHandoff,
    ) -> Result<(), RuntimeDispatchFailure<Self::Error>> {
        let owner = DeliveryLeaseOwner::parse(self.attachment.connection_id.clone())
            .expect("registry connection ids are non-empty");
        let batch = self
            .data
            .claim_pending(
                self.attachment.host_id.clone(),
                handoff.principal().clone(),
                self.target.conversation.clone(),
                owner.clone(),
                signed_unix_millis(SystemTime::now()),
                self.lease_ttl_ms,
                &MarkdownReferencePositions,
            )
            .await
            .map_err(|source| {
                RuntimeDispatchFailure::ProvenNotDispatched(DeliveryTransportError::Persistence(
                    source,
                ))
            })?;
        let batch = match batch {
            ClaimPendingInbox::Claimed(batch) => batch,
            ClaimPendingInbox::Empty => {
                return Err(RuntimeDispatchFailure::ProvenNotDispatched(
                    DeliveryTransportError::NoPending,
                ));
            }
            ClaimPendingInbox::StaleCustody => {
                return Err(RuntimeDispatchFailure::ProvenNotDispatched(
                    DeliveryTransportError::StaleCustody,
                ));
            }
        };
        let params = runtime_deliver_params(&self.target, handoff, &batch);
        match self
            .attachment
            .command("runtime_deliver", params, self.timeout)
            .await
        {
            Ok(result) => match delivery_disposition(&result) {
                DeliveryDisposition::Accepted => Ok(()),
                DeliveryDisposition::Refused => {
                    rollback_batch(&self.data, &self.attachment.host_id, &batch).await?;
                    Err(RuntimeDispatchFailure::ProvenNotDispatched(
                        DeliveryTransportError::DaemonRefused,
                    ))
                }
                DeliveryDisposition::Invalid => Err(RuntimeDispatchFailure::Ambiguous(
                    DeliveryTransportError::InvalidResponse,
                )),
            },
            Err(CommandDispatchError::ProvenNotDispatched) => {
                rollback_batch(&self.data, &self.attachment.host_id, &batch).await?;
                Err(RuntimeDispatchFailure::ProvenNotDispatched(
                    DeliveryTransportError::Transport,
                ))
            }
            Err(CommandDispatchError::DaemonRefused(_)) => {
                rollback_batch(&self.data, &self.attachment.host_id, &batch).await?;
                Err(RuntimeDispatchFailure::ProvenNotDispatched(
                    DeliveryTransportError::DaemonRefused,
                ))
            }
            Err(_) => Err(RuntimeDispatchFailure::Ambiguous(
                DeliveryTransportError::Transport,
            )),
        }
    }
}

async fn rollback_batch<D: RuntimeInboxCustodyPort>(
    data: &D,
    host_id: &str,
    batch: &ClaimedInboxBatch,
) -> Result<(), RuntimeDispatchFailure<DeliveryTransportError>> {
    data.settle_failed(
        host_id.to_owned(),
        batch.principal().clone(),
        batch.conversation().clone(),
        batch.owner().clone(),
        batch.delivery_ids(),
        RuntimeDeliveryFailureReason::WriteFailed,
        signed_unix_millis(SystemTime::now()),
    )
    .await
    .map_err(|source| {
        RuntimeDispatchFailure::Ambiguous(DeliveryTransportError::Persistence(source))
    })?;
    Ok(())
}

#[derive(Debug)]
enum DeliveryTransportError {
    NoPending,
    StaleCustody,
    DaemonRefused,
    InvalidResponse,
    Transport,
    Persistence(PersistenceFailure),
}

impl fmt::Display for DeliveryTransportError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::NoPending => "runtime inbox has no pending delivery",
            Self::StaleCustody => "runtime custody changed before inbox claim",
            Self::DaemonRefused => "daemon refused runtime delivery custody",
            Self::InvalidResponse => "daemon returned an invalid runtime delivery response",
            Self::Transport => "runtime delivery transport failed",
            Self::Persistence(_) => "runtime delivery persistence failed",
        })
    }
}

impl Error for DeliveryTransportError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Persistence(source) => Some(source),
            _ => None,
        }
    }
}

enum ConnectionInput {
    Close(ConnectionClose),
    Control(ConnectionControl),
    Terminated,
}

enum InterruptibleSend {
    Sent,
    Expired,
    TransportFailed,
    Close(ConnectionClose),
    Terminated,
}

/// Wait for this private connection generation's close signal. A mismatched id can
/// only be produced by a faulty in-process caller or a test; ignoring it preserves
/// the generation boundary instead of turning the private channel into host lookup.
async fn matching_connection_close(
    close: &mut watch::Receiver<Option<ConnectionClose>>,
    connection_id: &str,
) -> Option<ConnectionClose> {
    loop {
        close.changed().await.ok()?;
        let requested = close.borrow_and_update().clone();
        if let Some(requested) = requested
            && requested
                .expected_connection_id
                .as_deref()
                .is_none_or(|expected| expected == connection_id)
        {
            return Some(requested);
        }
    }
}

/// The custody lane is deliberately separate from the bounded business-command
/// FIFO. `biased` is load-bearing: when both are ready after a stalled connection
/// resumes, revocation is observed before any queued command.
async fn next_connection_input(
    close: &mut watch::Receiver<Option<ConnectionClose>>,
    connection_id: &str,
    commands: &mut mpsc::Receiver<ConnectionControl>,
) -> ConnectionInput {
    tokio::select! {
        biased;
        requested = matching_connection_close(close, connection_id) => requested
            .map(ConnectionInput::Close)
            .unwrap_or(ConnectionInput::Terminated),
        received = commands.recv() => received
            .map(ConnectionInput::Control)
            .unwrap_or(ConnectionInput::Terminated),
    }
}

/// A command write that is still backpressured is not allowed to hide a later
/// custody revocation. Cancelling the in-flight send is conservatively ambiguous;
/// the close is then written and no further business command is dequeued.
async fn send_command_interruptibly(
    socket: &mut WebSocket,
    close: &mut watch::Receiver<Option<ConnectionClose>>,
    connection_id: &str,
    message: Message,
    deadline: Instant,
) -> InterruptibleSend {
    let send = socket.send(message);
    tokio::pin!(send);
    tokio::select! {
        biased;
        requested = matching_connection_close(close, connection_id) => requested
            .map(InterruptibleSend::Close)
            .unwrap_or(InterruptibleSend::Terminated),
        _ = tokio::time::sleep_until(deadline) => InterruptibleSend::Expired,
        result = &mut send => if result.is_ok() {
            InterruptibleSend::Sent
        } else {
            InterruptibleSend::TransportFailed
        },
    }
}

async fn send_connection_close(socket: &mut WebSocket, close: ConnectionClose) {
    let _ = socket
        .send(Message::Close(Some(CloseFrame {
            code: 1001,
            reason: close.reason.into(),
        })))
        .await;
}

async fn daemon_websocket<C, D, H>(
    State(runtime): State<DaemonDeliveryRuntime<C, D, H>>,
    websocket: WebSocketUpgrade,
    headers: HeaderMap,
) -> Response
where
    C: silverhand_backend_core::runtime_credential::RuntimeCustodyPort,
    D: RuntimeDispatchReadPort + RuntimeInboxCustodyPort + DaemonEventDurablePort,
    H: HostCredentialLookup,
{
    let Some(token) = strict_bearer_credential(&headers) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let verified = verify_host_token(
        &runtime.host_credentials,
        token.to_owned(),
        signed_unix_millis(SystemTime::now()),
    )
    .await;
    let (host_id, owner_user_id) = match verified {
        Ok(VerifyHostTokenFact::Accepted {
            host_id, user_id, ..
        }) => (host_id, user_id),
        Ok(VerifyHostTokenFact::Rejected(_)) => return StatusCode::UNAUTHORIZED.into_response(),
        Err(cause) => {
            tracing::error!(
                error_chain = %error::describe(&cause),
                "daemon host credential authentication failed"
            );
            return (StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error").into_response();
        }
    };
    let (commands, receive) = mpsc::channel(32);
    let (close, close_receive) = watch::channel(None);
    let connection_id = match runtime.registry.reserve(&host_id, commands.clone(), close) {
        Ok(id) => id,
        Err(ReserveConnectionError::Occupied) => return StatusCode::CONFLICT.into_response(),
        Err(ReserveConnectionError::Closing) => {
            return StatusCode::SERVICE_UNAVAILABLE.into_response();
        }
        Err(ReserveConnectionError::Exhausted | ReserveConnectionError::Poisoned) => {
            tracing::error!("daemon attachment registry reservation failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error").into_response();
        }
    };
    websocket
        .max_message_size(MAX_DAEMON_FRAME_BYTES)
        .max_frame_size(MAX_DAEMON_FRAME_BYTES)
        .on_upgrade(move |socket| {
            connection(
                socket,
                runtime,
                AuthenticatedHostConnection {
                    host_id,
                    owner_user_id,
                    connection_id,
                },
                commands,
                receive,
                close_receive,
            )
        })
}

struct AuthenticatedHostConnection {
    host_id: String,
    owner_user_id: UserId,
    connection_id: String,
}

async fn connection<C, D, H>(
    mut socket: WebSocket,
    runtime: DaemonDeliveryRuntime<C, D, H>,
    authenticated: AuthenticatedHostConnection,
    control: mpsc::Sender<ConnectionControl>,
    mut commands: mpsc::Receiver<ConnectionControl>,
    mut close: watch::Receiver<Option<ConnectionClose>>,
) where
    C: silverhand_backend_core::runtime_credential::RuntimeCustodyPort,
    D: RuntimeDispatchReadPort + RuntimeInboxCustodyPort + DaemonEventDurablePort,
    H: HostCredentialLookup,
{
    let AuthenticatedHostConnection {
        host_id,
        owner_user_id,
        connection_id,
    } = authenticated;
    let mut pending: HashMap<String, PendingCommand> = HashMap::new();
    let (timeout_control, mut timed_out_commands) = mpsc::unbounded_channel();
    let mut next_command = 0_u64;
    let mut compatible: Option<AttachedDaemon> = None;
    let mut attached: Option<DaemonInstanceId> = None;
    let mut heartbeat = tokio::time::interval_at(
        Instant::now() + runtime.config.ping_interval,
        runtime.config.ping_interval,
    );
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut awaiting_pong: Option<(i64, Instant)> = None;
    loop {
        tokio::select! {
            Some(id) = timed_out_commands.recv() => {
                if let Some((_, response)) = pending.remove(&id) {
                    let _ = response.send(Err(CommandDispatchError::TimedOut));
                }
            }
            received_control = next_connection_input(&mut close, &connection_id, &mut commands) => match received_control {
                ConnectionInput::Close(requested) => {
                    send_connection_close(&mut socket, requested).await;
                    break;
                }
                ConnectionInput::Control(ConnectionControl::Command(command)) if compatible.is_some() => {
                    if command_expired_before_send(&command) {
                        let _ = command.response.send(Err(CommandDispatchError::TimedOut));
                        continue;
                    }
                    next_command = match next_command.checked_add(1) {
                        Some(next) => next,
                        None => {
                            let _ = command.response.send(Err(CommandDispatchError::ProvenNotDispatched));
                            continue;
                        }
                    };
                    let id = format!("rust-daemon-{next_command}");
                    let frame = json!({
                        "direction": "server_to_daemon",
                        "type": "command",
                        "id": id,
                        "kind": command.kind,
                        "params": command.params,
                    });
                    match send_command_interruptibly(
                        &mut socket,
                        &mut close,
                        &connection_id,
                        Message::Text(frame.to_string().into()),
                        command.deadline,
                    ).await {
                        InterruptibleSend::Sent => {}
                        InterruptibleSend::Expired => {
                            let _ = command.response.send(Err(CommandDispatchError::TimedOut));
                            break;
                        }
                        InterruptibleSend::TransportFailed => {
                            let _ = command.response.send(Err(CommandDispatchError::Ambiguous));
                            break;
                        }
                        InterruptibleSend::Close(requested) => {
                            let _ = command.response.send(Err(CommandDispatchError::Ambiguous));
                            send_connection_close(&mut socket, requested).await;
                            break;
                        }
                        InterruptibleSend::Terminated => {
                            let _ = command.response.send(Err(CommandDispatchError::Ambiguous));
                            break;
                        }
                    }
                    let timeout_id = id.clone();
                    let timeout_sender = timeout_control.clone();
                    tokio::spawn(async move {
                        tokio::time::sleep_until(command.deadline).await;
                        let _ = timeout_sender.send(timeout_id);
                    });
                    pending.insert(id, (command.kind, command.response));
                }
                ConnectionInput::Control(ConnectionControl::Command(command)) => {
                    let _ = command.response.send(Err(CommandDispatchError::ProvenNotDispatched));
                }
                ConnectionInput::Control(ConnectionControl::Hydrated(Ok(ready))) => {
                    if compatible
                        .as_ref()
                        .is_none_or(|current| current.daemon_instance != ready.daemon_instance)
                    {
                        break;
                    }
                    match runtime.registry.attach(&host_id, &connection_id, ready.clone()) {
                        Ok(true) => {
                            attached = Some(ready.daemon_instance.clone());
                            // The only edge that resolves a refusal, and only now: strict
                            // ready passed AND the registry promoted THIS connection. A
                            // parse that never became custody leaves the record standing.
                            if let Err(cause) = runtime.admission.clear(&host_id) {
                                tracing::error!(
                                    error_chain = %error::describe(&cause),
                                    host_id = %host_id,
                                    "host admission refusal could not be cleared after attachment"
                                );
                            }
                            // Status is a zero-RPC HTTP read. Seed this exact admitted
                            // generation in the background at the promotion edge; the
                            // seed owner rechecks custody after every await and drops a
                            // late answer if this socket is replaced.
                            let seeds = runtime.seeds.clone();
                            let seed_events = runtime.events.clone();
                            let seed_registry = runtime.registry.clone();
                            let seed_host = HostId::parse(host_id.clone())
                                .expect("authenticated host ids are validated at lookup");
                            let seed_instance = ready.daemon_instance.clone();
                            let seed_connection_id = connection_id.clone();
                            let seed_owner = owner_user_id.clone();
                            tokio::spawn(async move {
                                let mut attempt = seeds
                                    .seed_on_attach(&seed_host, &seed_instance)
                                    .await;
                                loop {
                                    match attempt {
                                        Ok(SeedAttempt::Deferred { after, ticket }) => {
                                            if !wait_for_seed_retry_or_replacement(
                                                &seed_registry,
                                                &seed_host,
                                                &seed_connection_id,
                                                after,
                                            )
                                            .await
                                            {
                                                break;
                                            }
                                            attempt = seeds
                                                .retry(&seed_host, &seed_instance, ticket)
                                                .await;
                                        }
                                        Ok(SeedAttempt::Sealed) => {
                                            if let Err(cause) = seed_events
                                                .publish_host_connection_changed(
                                                    &seed_owner,
                                                    &seed_host,
                                                )
                                            {
                                                tracing::error!(
                                                    error_chain = %error::describe(&cause),
                                                    host_id = %seed_host.as_str(),
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
                                                host_id = %seed_host.as_str(),
                                                "host status seed chain failed"
                                            );
                                            break;
                                        }
                                    }
                                }
                            });
                        }
                        Ok(false) => break,
                        Err(cause) => {
                            tracing::error!(
                                error_chain = %error::describe(&cause),
                                "daemon attachment registry failed after hydration"
                            );
                            let _ = socket.send(Message::Close(Some(CloseFrame {
                                code: 1011,
                                reason: "attachment_registry_failed".into(),
                            }))).await;
                            break;
                        }
                    }
                }
                ConnectionInput::Control(ConnectionControl::Hydrated(Err(cause))) => {
                    tracing::error!(
                        error_chain = %error::describe(&cause),
                        "daemon runtime hydration failed"
                    );
                    let _ = socket.send(Message::Close(Some(CloseFrame {
                        code: 1011,
                        reason: "runtime_hydration_failed".into(),
                    }))).await;
                    break;
                }
                ConnectionInput::Terminated => break,
            },
            _ = heartbeat.tick() => {
                let ts = signed_unix_millis(SystemTime::now()).max(0);
                let frame = json!({
                    "direction": "server_to_daemon",
                    "type": "heartbeat",
                    "kind": "ping",
                    "ts": ts,
                });
                if socket.send(Message::Text(frame.to_string().into())).await.is_err() {
                    break;
                }
                awaiting_pong = Some((ts, Instant::now() + runtime.config.pong_timeout));
            }
            _ = async {
                if let Some((_, deadline)) = awaiting_pong {
                    tokio::time::sleep_until(deadline).await;
                } else {
                    std::future::pending::<()>().await;
                }
            } => {
                let _ = socket.send(Message::Close(Some(CloseFrame {
                    code: 1008,
                    reason: "heartbeat_timeout".into(),
                }))).await;
                break;
            }
            inbound = socket.recv() => match inbound {
                Some(Ok(Message::Text(text))) => {
                    // Before the schema, because the schema is the current one. The host
                    // is this connection's verified host and the dialer is its own
                    // connection id: a frame never names the host it is refused for.
                    if let Some(offered) = offered_ready_protocol_version(&text)
                        && offered != OUTBOUND_PROTOCOL_VERSION
                    {
                        let recorded = runtime.admission.record(&host_id, ProtocolMismatch {
                            dialer: DialerId::from_connection(&connection_id),
                            offered_protocol_version: offered,
                            expected_protocol_version: OUTBOUND_PROTOCOL_VERSION,
                            observed_at: signed_unix_millis(SystemTime::now()),
                        });
                        match recorded {
                            // A reconnect loop re-observing the same incompatibility is
                            // not news; the record is replaced either way.
                            Ok(RefusalNews::SameUnresolvedFact) => tracing::debug!(
                                host_id = %host_id,
                                connection_id = %connection_id,
                                offered_protocol_version = offered,
                                "refused daemon on the same incompatible wire protocol"
                            ),
                            Ok(RefusalNews::Changed) => tracing::warn!(
                                host_id = %host_id,
                                connection_id = %connection_id,
                                offered_protocol_version = offered,
                                expected_protocol_version = OUTBOUND_PROTOCOL_VERSION,
                                "refused daemon on incompatible wire protocol"
                            ),
                            Err(cause) => tracing::error!(
                                error_chain = %error::describe(&cause),
                                host_id = %host_id,
                                "host admission refusal could not be recorded"
                            ),
                        }
                        // A version we can read but do not speak is terminal: no retry
                        // against this server can succeed until the daemon binary
                        // changes, so the reason has to say so.
                        let _ = socket.send(Message::Close(Some(CloseFrame {
                            code: 1002,
                            reason: UPDATE_REQUIRED_CLOSE_REASON.into(),
                        }))).await;
                        break;
                    }
                    let parsed = parse_daemon_frame(&text);
                    match parsed {
                        Ok(DaemonFrame::Ready(ReadyFrame {
                            protocol_version,
                            instance_id,
                            host_descriptor,
                        })) => {
                            // Reachable only for a version the envelope probe declined to
                            // read: a strictly valid frame whose number is out of the
                            // readable range. Refused, and deliberately not recorded.
                            if protocol_version != OUTBOUND_PROTOCOL_VERSION {
                                let _ = socket.send(Message::Close(Some(CloseFrame {
                                    code: 1002,
                                    reason: UPDATE_REQUIRED_CLOSE_REASON.into(),
                                }))).await;
                                break;
                            }
                            let Ok(instance) = DaemonInstanceId::parse(instance_id) else {
                                break;
                            };
                            if compatible.is_some() {
                                break;
                            }
                            let ready = AttachedDaemon {
                                daemon_instance: instance.clone(),
                                host_name: host_descriptor.name,
                            };
                            compatible = Some(ready.clone());
                            let attachment = DaemonAttachment {
                                host_id: host_id.clone(),
                                connection_id: connection_id.clone(),
                                daemon_instance: instance.clone(),
                                host_name: ready.host_name.clone(),
                                commands: control.clone(),
                            };
                            let hydrate_runtime = runtime.clone();
                            let hydrate_control = control.clone();
                            tokio::spawn(async move {
                                let result = hydrate_runtime.hydrate(&attachment).await.map(|()| ready);
                                let _ = hydrate_control.send(ConnectionControl::Hydrated(result)).await;
                            });
                        }
                        Ok(DaemonFrame::ShuttingDown(frame)) => {
                            tracing::warn!(reason = %frame.reason, "daemon announced shutdown");
                            let _ = socket.send(Message::Close(Some(CloseFrame {
                                code: 1001,
                                reason: "daemon_shutting_down".into(),
                            }))).await;
                            break;
                        }
                        Ok(DaemonFrame::CommandResponse(CommandResponseFrame { id, kind, result, error })) => {
                            let Some((expected, response)) = pending.remove(&id) else { continue; };
                            if expected != kind {
                                let _ = response.send(Err(CommandDispatchError::InvalidResponse));
                                let _ = socket.send(Message::Close(Some(CloseFrame {
                                    code: 1002,
                                    reason: "command_response_kind_mismatch".into(),
                                }))).await;
                                break;
                            }
                            let settled = match (result, error) {
                                (Some(result), None) => Some(Ok(result)),
                                (None, Some(error)) => CommandRefusal::decode(expected, &error)
                                    .map(|refusal| {
                                        Err(CommandDispatchError::DaemonRefused(refusal))
                                    }),
                                _ => None,
                            };
                            let Some(settled) = settled else {
                                let _ = response.send(Err(CommandDispatchError::InvalidResponse));
                                let _ = socket.send(Message::Close(Some(CloseFrame {
                                    code: 1002,
                                    reason: "invalid_command_response".into(),
                                }))).await;
                                break;
                            };
                            let _ = response.send(settled);
                        }
                        Ok(DaemonFrame::DeliveryConsumed(event)) => {
                            let Some(instance) = attached.as_ref() else {
                                let _ = socket.send(Message::Close(Some(CloseFrame {
                                    code: 1008,
                                    reason: "attachment_not_hydrated".into(),
                                }))).await;
                                break;
                            };
                            commit_consumed_event(&runtime, &host_id, &connection_id, instance, event).await;
                        }
                        Ok(DaemonFrame::DeliveryFailed(event)) => {
                            let Some(instance) = attached.as_ref() else {
                                let _ = socket.send(Message::Close(Some(CloseFrame {
                                    code: 1008,
                                    reason: "attachment_not_hydrated".into(),
                                }))).await;
                                break;
                            };
                            let reason = event.reason;
                            settle_event(&runtime, &host_id, &connection_id, Some(instance), event.base, Some(reason.into())).await;
                        }
                        Ok(DaemonFrame::RuntimeExit(event)) => {
                            let Some(instance) = attached.as_ref() else {
                                let _ = socket.send(Message::Close(Some(CloseFrame {
                                    code: 1008,
                                    reason: "attachment_not_hydrated".into(),
                                }))).await;
                                break;
                            };
                            finalize_runtime_event(
                                &runtime,
                                &host_id,
                                &connection_id,
                                Some(instance),
                                event,
                            ).await;
                        }
                        Ok(DaemonFrame::Product(event)) => {
                            let Some(instance) = attached.as_ref() else {
                                let _ = socket.send(Message::Close(Some(CloseFrame {
                                    code: 1008,
                                    reason: "attachment_not_hydrated".into(),
                                }))).await;
                                break;
                            };
                            match runtime
                                .events
                                .handle(&host_id, instance, &connection_id, event)
                                .await
                            {
                                Ok(RuntimeEventDirective::None) => {}
                                Ok(RuntimeEventDirective::Drain {
                                    conversation,
                                    agent,
                                    post_commit_failure,
                                }) => {
                                    let effect_runtime = runtime.clone();
                                    tokio::spawn(async move {
                                        if let Err(cause) =
                                            effect_runtime.deliver(&conversation, &agent).await
                                        {
                                            tracing::error!(
                                                error_chain = %error::describe(&cause),
                                                "daemon runtime drain effect failed"
                                            );
                                        }
                                        if let Some(cause) = post_commit_failure {
                                            tracing::error!(
                                                error_chain = %error::describe(&cause),
                                                "daemon runtime live projection failed after durable commit"
                                            );
                                        }
                                    });
                                }
                                Err(crate::daemon_events::DaemonRuntimeEventError::StaleRuntime) => {
                                    tracing::warn!("dropped stale daemon runtime event");
                                }
                                Err(cause) => {
                                    tracing::error!(
                                        error_chain = %error::describe(&cause),
                                        "daemon runtime event owner failed"
                                    );
                                    let _ = socket.send(Message::Close(Some(CloseFrame {
                                        code: 1011,
                                        reason: "runtime_event_owner_failed".into(),
                                    }))).await;
                                    break;
                                }
                            }
                        }
                        Ok(DaemonFrame::HeartbeatPing(frame)) => {
                            let response = json!({
                                "direction": "server_to_daemon",
                                "type": "heartbeat",
                                "kind": "pong",
                                "ts": signed_unix_millis(SystemTime::now()).max(0),
                                "echo_ts": frame.ts,
                            });
                            if socket.send(Message::Text(response.to_string().into())).await.is_err() {
                                break;
                            }
                        }
                        Ok(DaemonFrame::HeartbeatPong(frame)) => {
                            if awaiting_pong.is_some_and(|(ts, _)| ts == frame.echo_ts) {
                                awaiting_pong = None;
                            }
                        }
                        Err(_) => {
                            let _ = socket.send(Message::Close(Some(CloseFrame {
                                code: 1002,
                                reason: "invalid_daemon_frame".into(),
                            }))).await;
                            break;
                        }
                    }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(Message::Ping(payload))) => {
                    if socket.send(Message::Pong(payload)).await.is_err() { break; }
                }
                Some(Ok(Message::Binary(_))) => break,
                Some(Ok(Message::Pong(_))) => {}
            }
        }
    }
    for (_, (_, response)) in pending {
        let _ = response.send(Err(CommandDispatchError::Ambiguous));
    }
    if let Some(instance) = attached
        .as_ref()
        .or_else(|| compatible.as_ref().map(|ready| &ready.daemon_instance))
        && let Err(cause) = runtime
            .events
            .detach_daemon(&host_id, instance, &connection_id)
    {
        tracing::error!(
            error_chain = %error::describe(&cause),
            "daemon disconnect runtime projection cleanup failed"
        );
    }
    runtime.registry.remove(&host_id, &connection_id);
    if let Ok(owner) = DeliveryLeaseOwner::parse(connection_id)
        && let Err(cause) = runtime.data.release_owner(owner).await
    {
        tracing::error!(
            error_chain = %error::describe(&cause),
            "daemon disconnect inbox lease release failed"
        );
    }
}

async fn wait_for_seed_retry_or_replacement(
    registry: &DaemonRegistry,
    host: &HostId,
    connection_id: &str,
    after: Duration,
) -> bool {
    let deadline = Instant::now() + after;
    loop {
        let changed = registry.changed.notified();
        if registry
            .slot_connection_id(host.as_str())
            .ok()
            .flatten()
            .as_deref()
            != Some(connection_id)
        {
            return false;
        }
        tokio::select! {
            _ = tokio::time::sleep_until(deadline) => return registry
                .slot_connection_id(host.as_str())
                .ok()
                .flatten()
                .as_deref() == Some(connection_id),
            _ = changed => {}
        }
    }
}

async fn settle_event<C, D, H>(
    runtime: &DaemonDeliveryRuntime<C, D, H>,
    host_id: &str,
    connection_id: &str,
    attached: Option<&DaemonInstanceId>,
    event: DeliveryEvent,
    failure: Option<RuntimeDeliveryFailureReason>,
) where
    C: silverhand_backend_core::runtime_credential::RuntimeCustodyPort,
    D: RuntimeDispatchReadPort + RuntimeInboxCustodyPort + DaemonEventDurablePort,
    H: HostCredentialLookup,
{
    let Some(daemon) = attached else {
        return;
    };
    let principal = match event.principal(daemon.clone()) {
        Ok(principal) => principal,
        Err(cause) => {
            tracing::error!(error_chain = %error::describe(&cause), "daemon delivery event identity decode failed");
            return;
        }
    };
    let owner = match DeliveryLeaseOwner::parse(connection_id.to_owned()) {
        Ok(owner) => owner,
        Err(cause) => {
            tracing::error!(error_chain = %error::describe(&cause), "daemon delivery owner decode failed");
            return;
        }
    };
    let conversation = match event.conversation() {
        Ok(conversation) => conversation,
        Err(cause) => {
            tracing::error!(error_chain = %error::describe(&cause), "daemon delivery conversation decode failed");
            return;
        }
    };
    let ids = match event
        .delivery_ids
        .into_iter()
        .map(InboxDeliveryId::parse)
        .collect::<Result<Vec<_>, _>>()
    {
        Ok(ids) => ids,
        Err(cause) => {
            tracing::error!(error_chain = %error::describe(&cause), "daemon delivery ids decode failed");
            return;
        }
    };
    let result = if let Some(reason) = failure {
        runtime
            .data
            .settle_failed(
                host_id.to_owned(),
                principal,
                conversation,
                owner,
                ids,
                reason,
                event.ts,
            )
            .await
    } else {
        runtime
            .data
            .settle_consumed(
                host_id.to_owned(),
                principal,
                conversation,
                owner,
                ids,
                event.ts,
            )
            .await
    };
    if let Err(cause) = result {
        tracing::error!(
            error_chain = %error::describe(&cause),
            "daemon delivery settlement failed"
        );
    }
}

async fn commit_consumed_event<C, D, H>(
    runtime: &DaemonDeliveryRuntime<C, D, H>,
    host_id: &str,
    connection_id: &str,
    daemon: &DaemonInstanceId,
    event: DeliveryEvent,
) where
    C: silverhand_backend_core::runtime_credential::RuntimeCustodyPort,
    D: RuntimeDispatchReadPort + RuntimeInboxCustodyPort + DaemonEventDurablePort,
    H: HostCredentialLookup,
{
    let principal = match event.principal(daemon.clone()) {
        Ok(principal) => principal,
        Err(cause) => {
            tracing::error!(error_chain = %error::describe(&cause), "daemon consumed event identity decode failed");
            return;
        }
    };
    let owner = match DeliveryLeaseOwner::parse(connection_id.to_owned()) {
        Ok(owner) => owner,
        Err(cause) => {
            tracing::error!(error_chain = %error::describe(&cause), "daemon consumed event owner decode failed");
            return;
        }
    };
    let conversation = match event.conversation() {
        Ok(conversation) => conversation,
        Err(cause) => {
            tracing::error!(error_chain = %error::describe(&cause), "daemon consumed event conversation decode failed");
            return;
        }
    };
    let delivery_count = event.delivery_ids.len();
    let delivery_ids = match event
        .delivery_ids
        .into_iter()
        .map(InboxDeliveryId::parse)
        .collect::<Result<Vec<_>, _>>()
    {
        Ok(ids) => ids,
        Err(cause) => {
            tracing::error!(error_chain = %error::describe(&cause), "daemon consumed event ids decode failed");
            return;
        }
    };
    let agent = principal.agent().clone();
    let observed_at = event.ts;
    let result = runtime
        .events
        .durable()
        .commit_consumed(CommitRuntimeConsumed::new(
            RuntimeEventAdmission::new(host_id.to_owned(), principal),
            conversation.clone(),
            owner,
            delivery_ids,
            RuntimeEventTime::from_unix_millis(observed_at),
            RuntimeEventTime::from_unix_millis(signed_unix_millis(SystemTime::now())),
        ))
        .await;
    match result {
        Ok(result)
            if result.disposition()
                == silverhand_backend_core::runtime_delivery::InboxSettlementDisposition::Applied =>
        {
            if let Some(activity_id) = result.activity_id()
                && let Err(cause) = runtime.events.complete_consumed(
                    &conversation,
                    &agent,
                    result.presence_viewers(),
                    observed_at,
                    delivery_count,
                    activity_id,
                )
            {
                tracing::error!(
                    error_chain = %error::describe(&cause),
                    "daemon consumed live projection failed after durable commit"
                );
            }
        }
        Ok(_) => {}
        Err(cause) => tracing::error!(
            error_chain = %error::describe(&cause),
            "daemon consumed durable commit failed"
        ),
    }
}

async fn finalize_runtime_event<C, D, H>(
    runtime: &DaemonDeliveryRuntime<C, D, H>,
    host_id: &str,
    connection_id: &str,
    attached: Option<&DaemonInstanceId>,
    event: RuntimeExitEvent,
) where
    C: silverhand_backend_core::runtime_credential::RuntimeCustodyPort,
    D: RuntimeDispatchReadPort + RuntimeInboxCustodyPort + DaemonEventDurablePort,
    H: HostCredentialLookup,
{
    let Some(daemon) = attached else {
        return;
    };
    let principal = match event.principal(daemon.clone()) {
        Ok(principal) => principal,
        Err(cause) => {
            tracing::error!(
                error_chain = %error::describe(&cause),
                "daemon runtime exit identity decode failed"
            );
            return;
        }
    };
    let commit = match runtime.events.prepare_exit(
        host_id,
        principal.clone(),
        match event.conversation() {
            Ok(conversation) => conversation,
            Err(cause) => {
                tracing::error!(error_chain = %error::describe(&cause), "daemon runtime exit coordinate decode failed");
                return;
            }
        },
        event.code,
        event.intentional,
        event.ts,
    ) {
        Ok(commit) => commit,
        Err(cause) => {
            tracing::error!(
                error_chain = %error::describe(&cause),
                observed_at = event.ts,
                "daemon runtime exit preparation failed"
            );
            return;
        }
    };
    let admission = commit.admission().clone();
    match runtime
        .credentials
        .commit_daemon_exit(runtime.events.durable(), commit)
        .await
    {
        Ok(result) => {
            let conversation = match event.conversation() {
                Ok(conversation) => conversation,
                Err(cause) => {
                    tracing::error!(
                        error_chain = %error::describe(&cause),
                        observed_at = event.ts,
                        "daemon runtime exit post-commit coordinate decode failed"
                    );
                    return;
                }
            };
            match runtime.events.complete_exit_state(
                &admission,
                connection_id,
                &result,
                conversation,
                event.code,
                event.intentional,
            ) {
                Ok(Some(effect)) => {
                    if let Err(cause) = runtime.events.publish_exit(&effect) {
                        tracing::error!(
                            error_chain = %error::describe(&cause),
                            observed_at = event.ts,
                            "daemon runtime exit live projection failed after durable commit"
                        );
                    }
                    if effect.should_respawn() {
                        let effect_runtime = runtime.clone();
                        let conversation = effect.conversation().clone();
                        let agent = effect.agent().clone();
                        let observed_at = event.ts;
                        tokio::spawn(async move {
                            if let Err(cause) = effect_runtime.deliver(&conversation, &agent).await
                            {
                                tracing::error!(
                                    error_chain = %error::describe(&cause),
                                    observed_at,
                                    "daemon runtime exit pending-inbox respawn failed"
                                );
                            }
                        });
                    }
                }
                Ok(None) => {}
                Err(cause) => {
                    tracing::error!(
                        error_chain = %error::describe(&cause),
                        observed_at = event.ts,
                        "daemon runtime exit process-state cleanup failed after durable commit"
                    );
                }
            }
        }
        Err(cause) => {
            tracing::error!(
                error_chain = %error::describe(&cause),
                observed_at = event.ts,
                "daemon runtime exit durable commit failed"
            );
        }
    }
}

enum DaemonFrame {
    Ready(ReadyFrame),
    ShuttingDown(ShuttingDownFrame),
    HeartbeatPing(HeartbeatPingFrame),
    HeartbeatPong(HeartbeatPongFrame),
    DeliveryConsumed(DeliveryEvent),
    DeliveryFailed(FailedDeliveryEvent),
    RuntimeExit(RuntimeExitEvent),
    Product(RuntimeProductEvent),
    CommandResponse(CommandResponseFrame),
}

#[derive(Deserialize)]
struct HeartbeatPingFrame {
    ts: i64,
}

#[derive(Deserialize)]
struct HeartbeatPongFrame {
    echo_ts: i64,
}

#[derive(Deserialize)]
struct ReadyFrame {
    protocol_version: u32,
    instance_id: String,
    host_descriptor: ReadyHostDescriptor,
}

#[derive(Deserialize)]
struct ReadyHostDescriptor {
    name: String,
}

#[derive(Deserialize)]
struct ShuttingDownFrame {
    reason: String,
}

#[derive(Deserialize)]
struct CommandResponseFrame {
    id: String,
    kind: String,
    result: Option<Value>,
    error: Option<Value>,
}

/// The `protocol_version` a `ready` frame OFFERS, read at the envelope level.
///
/// This has to exist separately from [`parse_daemon_frame`] because the only daemon
/// population it describes is the one whose `ready` frame this server's current
/// schema rejects: an older daemon does not merely carry a different number, it
/// carries a different frame (no `instance_id`, for one). Deciding the mismatch
/// after the strict parse would mean the refusal is never recorded for exactly the
/// build the human needs to be told to upgrade.
///
/// The vocabulary is closed on purpose:
///
///  - a readable version that is not ours is an actionable refusal, recorded;
///  - our own version is not this function's business — the strict schema decides,
///    and a frame that fails it records nothing;
///  - anything else (not an envelope, not an integer, negative, out of range)
///    yields `None` and falls through to the strict parse, because a version we
///    cannot read is a corrupt dialer that may retry successfully.
fn offered_ready_protocol_version(raw: &str) -> Option<u32> {
    let value = serde_json::from_str::<Value>(raw).ok()?;
    if value.get("direction").and_then(Value::as_str) != Some("daemon_to_server")
        || value.get("type").and_then(Value::as_str) != Some("event")
        || value.get("kind").and_then(Value::as_str) != Some("ready")
    {
        return None;
    }
    u32::try_from(value.get("protocol_version")?.as_u64()?)
        .ok()
        .filter(|version| *version <= MAX_READABLE_PROTOCOL_VERSION)
}

fn parse_daemon_frame(raw: &str) -> Result<DaemonFrame, DaemonFrameError> {
    let value = serde_json::from_str::<Value>(raw).map_err(DaemonFrameError::Json)?;
    if value.get("direction").and_then(Value::as_str) != Some("daemon_to_server") {
        return Err(DaemonFrameError::Unsupported);
    }
    let frame_type = value.get("type").and_then(Value::as_str);
    let kind = value.get("kind").and_then(Value::as_str);
    match (frame_type, kind) {
        (Some("heartbeat"), Some("ping"))
            if exact_keys(&value, &["direction", "type", "kind", "ts"])
                && value
                    .get("ts")
                    .and_then(Value::as_i64)
                    .is_some_and(|ts| ts >= 0) =>
        {
            serde_json::from_value(value)
                .map(DaemonFrame::HeartbeatPing)
                .map_err(DaemonFrameError::Json)
        }
        (Some("heartbeat"), Some("pong"))
            if exact_keys(&value, &["direction", "type", "kind", "ts", "echo_ts"])
                && value
                    .get("ts")
                    .and_then(Value::as_i64)
                    .is_some_and(|ts| ts >= 0)
                && value
                    .get("echo_ts")
                    .and_then(Value::as_i64)
                    .is_some_and(|ts| ts >= 0) =>
        {
            serde_json::from_value(value)
                .map(DaemonFrame::HeartbeatPong)
                .map_err(DaemonFrameError::Json)
        }
        (Some("event"), Some("ready")) if valid_ready_frame(&value) => {
            serde_json::from_value(value)
                .map(DaemonFrame::Ready)
                .map_err(DaemonFrameError::Json)
        }
        (Some("event"), Some("shutting_down"))
            if exact_keys(&value, &["direction", "type", "kind", "reason"])
                && value.get("reason").is_some_and(Value::is_string) =>
        {
            serde_json::from_value(value)
                .map(DaemonFrame::ShuttingDown)
                .map_err(DaemonFrameError::Json)
        }
        (Some("event"), Some("runtime_delivery_consumed"))
            if exact_keys(
                &value,
                &[
                    "direction",
                    "type",
                    "kind",
                    "runtime_scope",
                    "conversation_id",
                    "agent_id",
                    "runtime_generation",
                    "delivery_ids",
                    "ts",
                ],
            ) && valid_runtime_coordinate(&value)
                && valid_delivery_ids(&value) =>
        {
            serde_json::from_value(value)
                .map(DaemonFrame::DeliveryConsumed)
                .map_err(DaemonFrameError::Json)
        }
        (Some("event"), Some("runtime_delivery_failed"))
            if exact_keys(
                &value,
                &[
                    "direction",
                    "type",
                    "kind",
                    "runtime_scope",
                    "conversation_id",
                    "agent_id",
                    "runtime_generation",
                    "delivery_ids",
                    "reason",
                    "ts",
                ],
            ) && valid_runtime_coordinate(&value)
                && valid_delivery_ids(&value) =>
        {
            serde_json::from_value(value)
                .map(DaemonFrame::DeliveryFailed)
                .map_err(DaemonFrameError::Json)
        }
        (Some("event"), Some("runtime_exit"))
            if exact_keys(
                &value,
                &[
                    "direction",
                    "type",
                    "kind",
                    "runtime_scope",
                    "conversation_id",
                    "agent_id",
                    "runtime_generation",
                    "code",
                    "intentional",
                    "ts",
                ],
            ) && valid_runtime_coordinate(&value)
                && value
                    .get("code")
                    .is_some_and(|code| code.is_null() || code.as_i64().is_some())
                && value.get("intentional").and_then(Value::as_bool).is_some() =>
        {
            serde_json::from_value(value)
                .map(DaemonFrame::RuntimeExit)
                .map_err(DaemonFrameError::Json)
        }
        (Some("event"), Some(kind)) if OUTBOUND_DAEMON_EVENT_KINDS.contains(&kind) => {
            decode_product_event(kind, &value)
                .map(DaemonFrame::Product)
                .map_err(DaemonFrameError::Json)
        }
        (Some("command_response"), Some(_))
            if valid_command_response_envelope(&value)
                && (exact_keys(&value, &["direction", "type", "id", "kind", "result"])
                    || exact_keys(&value, &["direction", "type", "id", "kind", "error"])) =>
        {
            serde_json::from_value(value)
                .map(DaemonFrame::CommandResponse)
                .map_err(DaemonFrameError::Json)
        }
        _ => Err(DaemonFrameError::Unsupported),
    }
}

fn exact_keys(value: &Value, expected: &[&str]) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    object.len() == expected.len() && expected.iter().all(|key| object.contains_key(*key))
}

fn valid_ready_frame(value: &Value) -> bool {
    if !exact_keys(
        value,
        &[
            "direction",
            "type",
            "kind",
            "protocol_version",
            "daemon_version",
            "daemon_id",
            "instance_id",
            "host_descriptor",
            "capabilities",
            "daemon_pid",
            "started_at",
        ],
    ) {
        return false;
    }
    let Some(host) = value.get("host_descriptor") else {
        return false;
    };
    exact_keys(host, &["name", "kind"])
        && host
            .get("name")
            .and_then(Value::as_str)
            .is_some_and(|name| !name.is_empty())
        && matches!(
            host.get("kind").and_then(Value::as_str),
            Some("local" | "remote")
        )
        && value.get("daemon_version").is_some_and(Value::is_string)
        && value
            .get("daemon_id")
            .and_then(Value::as_str)
            .is_some_and(|id| !id.is_empty())
        && value
            .get("instance_id")
            .and_then(Value::as_str)
            .is_some_and(|id| !id.is_empty())
        && value
            .get("capabilities")
            .and_then(Value::as_array)
            .is_some_and(|items| items.iter().all(Value::is_string))
}

fn valid_runtime_coordinate(value: &Value) -> bool {
    let conversation = value
        .get("conversation_id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty());
    let agent = value
        .get("agent_id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty());
    let generation = value
        .get("runtime_generation")
        .and_then(Value::as_i64)
        .is_some_and(|generation| generation > 0);
    let timestamp = value.get("ts").and_then(Value::as_i64).is_some();
    let scope = value.get("runtime_scope");
    conversation.is_some()
        && agent.is_some()
        && generation
        && timestamp
        && scope.is_some_and(|scope| match scope.get("kind").and_then(Value::as_str) {
            Some("conversation") => {
                exact_keys(scope, &["kind", "conversation_id", "agent_id"])
                    && scope
                        .get("conversation_id")
                        .and_then(Value::as_str)
                        .is_some_and(|id| !id.is_empty())
                    && scope
                        .get("agent_id")
                        .and_then(Value::as_str)
                        .is_some_and(|id| !id.is_empty())
            }
            Some("agent") => {
                exact_keys(scope, &["kind", "agent_id"])
                    && scope
                        .get("agent_id")
                        .and_then(Value::as_str)
                        .is_some_and(|id| !id.is_empty())
            }
            _ => false,
        })
}

fn valid_delivery_ids(value: &Value) -> bool {
    value
        .get("delivery_ids")
        .and_then(Value::as_array)
        .is_some_and(|ids| !ids.is_empty() && ids.iter().all(|id| id.as_i64().is_some()))
}

fn valid_command_response_envelope(value: &Value) -> bool {
    value
        .get("id")
        .and_then(Value::as_str)
        .is_some_and(|id| !id.is_empty())
        && value
            .get("kind")
            .and_then(Value::as_str)
            .is_some_and(|kind| {
                matches!(
                    kind,
                    "runtime_start" | "runtime_stop" | "runtime_deliver" | "runtime_status"
                ) || HostDataPlaneCommandKind::sends_wire(kind)
                    || kind == "agent_files_purge"
            })
}

#[derive(Debug)]
enum DaemonFrameError {
    Json(serde_json::Error),
    Unsupported,
}

impl fmt::Display for DaemonFrameError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("invalid daemon frame")
    }
}

impl Error for DaemonFrameError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Json(source) => Some(source),
            Self::Unsupported => None,
        }
    }
}

#[derive(Deserialize)]
struct DeliveryEvent {
    runtime_scope: RuntimeScopeWire,
    conversation_id: String,
    agent_id: String,
    runtime_generation: i64,
    delivery_ids: Vec<i64>,
    ts: i64,
}

impl DeliveryEvent {
    fn principal(&self, daemon: DaemonInstanceId) -> Result<RuntimePrincipal, EventIdentityError> {
        principal_from_wire(
            &self.runtime_scope,
            &self.conversation_id,
            &self.agent_id,
            self.runtime_generation,
            daemon,
        )
    }

    fn conversation(&self) -> Result<ConversationId, EventIdentityError> {
        ConversationId::parse(self.conversation_id.clone()).map_err(|_| EventIdentityError)
    }
}

#[derive(Deserialize)]
struct RuntimeExitEvent {
    runtime_scope: RuntimeScopeWire,
    conversation_id: String,
    agent_id: String,
    runtime_generation: i64,
    code: Option<i64>,
    intentional: bool,
    ts: i64,
}

impl RuntimeExitEvent {
    fn principal(&self, daemon: DaemonInstanceId) -> Result<RuntimePrincipal, EventIdentityError> {
        principal_from_wire(
            &self.runtime_scope,
            &self.conversation_id,
            &self.agent_id,
            self.runtime_generation,
            daemon,
        )
    }

    fn conversation(&self) -> Result<ConversationId, EventIdentityError> {
        ConversationId::parse(self.conversation_id.clone()).map_err(|_| EventIdentityError)
    }
}

#[derive(Clone, Deserialize)]
struct RuntimeStatusResult {
    runtimes: Vec<RuntimeStatusRow>,
}

impl RuntimeStatusResult {
    fn decode(value: Value) -> Result<Self, EventIdentityError> {
        if !exact_keys(&value, &["runtimes"]) {
            return Err(EventIdentityError);
        }
        serde_json::from_value(value).map_err(|_| EventIdentityError)
    }

    fn active_principals(
        &self,
        daemon: DaemonInstanceId,
    ) -> Result<Vec<RuntimePrincipal>, EventIdentityError> {
        self.runtimes
            .iter()
            .filter_map(|row| {
                if !row.has_valid_nullable_fields() {
                    return Some(Err(EventIdentityError));
                }
                match row.phase.as_str() {
                    "spawning" | "startup_pending" | "ready" | "draining" => {
                        Some(principal_from_wire(
                            &row.runtime_scope,
                            &row.conversation_id,
                            &row.agent_id,
                            row.runtime_generation,
                            daemon.clone(),
                        ))
                    }
                    "idle" | "exited" => None,
                    _ => Some(Err(EventIdentityError)),
                }
            })
            .collect()
    }

    fn hydrated(
        &self,
        daemon: DaemonInstanceId,
    ) -> Result<Vec<HydratedRuntime>, EventIdentityError> {
        self.runtimes
            .iter()
            .map(|row| {
                if !row.has_valid_nullable_fields() {
                    return Err(EventIdentityError);
                }
                let principal = principal_from_wire(
                    &row.runtime_scope,
                    &row.conversation_id,
                    &row.agent_id,
                    row.runtime_generation,
                    daemon.clone(),
                )?;
                let run_state = if row.run_state.is_null() {
                    None
                } else {
                    let state = serde_json::from_value::<AgentRunStateWire>(row.run_state.clone())
                        .map_err(|_| EventIdentityError)?;
                    if !state.matches_coordinate(&row.agent_id, &row.conversation_id) {
                        return Err(EventIdentityError);
                    }
                    Some(state)
                };
                Ok(HydratedRuntime {
                    principal,
                    run_state,
                })
            })
            .collect()
    }
}

#[derive(Clone, Deserialize)]
struct RuntimeStatusRow {
    runtime_scope: RuntimeScopeWire,
    conversation_id: String,
    agent_id: String,
    runtime_generation: i64,
    pid: Value,
    phase: String,
    run_state: Value,
    started_at: Value,
}

impl RuntimeStatusRow {
    fn has_valid_nullable_fields(&self) -> bool {
        (self.pid.is_null() || self.pid.as_i64().is_some())
            && (self.run_state.is_null() || self.run_state.is_object())
            && (self.started_at.is_null() || self.started_at.as_i64().is_some())
    }
}

fn principal_from_wire(
    runtime_scope: &RuntimeScopeWire,
    conversation_id: &str,
    agent_id: &str,
    runtime_generation: i64,
    daemon: DaemonInstanceId,
) -> Result<RuntimePrincipal, EventIdentityError> {
    let agent = AgentId::parse(agent_id).map_err(|_| EventIdentityError)?;
    let conversation = ConversationId::parse(conversation_id).map_err(|_| EventIdentityError)?;
    let generation =
        silverhand_backend_core::runtime_credential::RuntimeGeneration::new(runtime_generation)
            .map_err(|_| EventIdentityError)?;
    let scope = match runtime_scope {
        RuntimeScopeWire::Conversation {
            conversation_id: source,
            agent_id: scope_agent,
        } => {
            if source != conversation_id || scope_agent != agent_id {
                return Err(EventIdentityError);
            }
            RuntimeScope::ConversationSlot {
                agent,
                source: conversation,
            }
        }
        RuntimeScopeWire::Agent {
            agent_id: scope_agent,
        } => {
            if scope_agent != agent_id {
                return Err(EventIdentityError);
            }
            RuntimeScope::AgentSlot { agent }
        }
    };
    Ok(RuntimePrincipal::for_scope(
        scope,
        silverhand_backend_core::runtime_credential::RuntimeCustody::new(generation, daemon),
    ))
}

#[derive(Deserialize)]
struct FailedDeliveryEvent {
    #[serde(flatten)]
    base: DeliveryEvent,
    reason: RuntimeDeliveryFailureReasonWire,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum RuntimeDeliveryFailureReasonWire {
    ChildExit,
    InitWatchdog,
    WriteFailed,
    DriverRefused,
}

impl From<RuntimeDeliveryFailureReasonWire> for RuntimeDeliveryFailureReason {
    fn from(value: RuntimeDeliveryFailureReasonWire) -> Self {
        match value {
            RuntimeDeliveryFailureReasonWire::ChildExit => Self::ChildExit,
            RuntimeDeliveryFailureReasonWire::InitWatchdog => Self::InitWatchdog,
            RuntimeDeliveryFailureReasonWire::WriteFailed => Self::WriteFailed,
            RuntimeDeliveryFailureReasonWire::DriverRefused => Self::DriverRefused,
        }
    }
}

#[derive(Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum RuntimeScopeWire {
    Conversation {
        conversation_id: String,
        agent_id: String,
    },
    Agent {
        agent_id: String,
    },
}

#[derive(Debug)]
struct EventIdentityError;

impl fmt::Display for EventIdentityError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("daemon delivery event identity is invalid")
    }
}

impl Error for EventIdentityError {}

fn runtime_start_params(target: &RuntimeDispatchTarget, handoff: &RuntimeStartHandoff) -> Value {
    json!({
        "conversation_id": target.conversation.as_str(),
        "agent_id": handoff.principal().agent().as_str(),
        "runtime_generation": handoff.principal().custody().generation().as_i64(),
        "options": spawn_options(&target.plan, handoff.daemon_auth_token()),
    })
}

fn runtime_deliver_params(
    target: &RuntimeDispatchTarget,
    handoff: &RuntimeStartHandoff,
    batch: &ClaimedInboxBatch,
) -> Value {
    let deliveries = batch
        .deliveries()
        .iter()
        .map(|delivery| {
            json!({
                "delivery_id": delivery.id().as_i64(),
                "seq": delivery.seq(),
                "presentation": {
                    "body": delivery.presentation(),
                    "instruction": instruction_wire(delivery.instruction()),
                }
            })
        })
        .collect::<Vec<_>>();
    json!({
        "conversation_id": target.conversation.as_str(),
        "agent_id": handoff.principal().agent().as_str(),
        "runtime_generation": handoff.principal().custody().generation().as_i64(),
        "target": {
            "conversation_id": target.conversation.as_str(),
            "workspace": target.plan.workspace.as_ref().map(workspace_wire),
        },
        "delivery_ids": batch.delivery_ids().into_iter().map(InboxDeliveryId::as_i64).collect::<Vec<_>>(),
        "deliveries": deliveries,
        "kind": "message",
        "text": compose_delivery_text(batch),
        "spawn_options": spawn_options(&target.plan, handoff.daemon_auth_token()),
    })
}

fn spawn_options(plan: &RuntimeSpawnPlan, token: &str) -> Value {
    let common = json!({
        "agent": { "id": plan.agent.id.as_str(), "name": plan.agent.name },
        "driver": {
            "kind": plan.agent.runtime.as_str(),
            "cli_session_id": plan.agent.cli_session_id,
            "model": plan.agent.model,
            "reasoning_effort": plan.agent.reasoning_effort,
            "fast_mode": plan.agent.fast_mode,
        },
        "env_policy": { "silverhand": { "auth_token": token } },
    });
    let mut object = common.as_object().cloned().expect("object literal");
    object.insert("runtime_scope".to_owned(), scope_wire(&plan.scope));
    if let Some(session) = &plan.session {
        object.insert(
            "workspace".to_owned(),
            plan.workspace.as_ref().map_or(Value::Null, workspace_wire),
        );
        object.insert(
            "workspace_memory_index".to_owned(),
            Value::Array(
                plan.workspace_memory_index
                    .iter()
                    .map(workspace_wire)
                    .collect(),
            ),
        );
        object.insert("session".to_owned(), session_wire(session));
    }
    Value::Object(object)
}

fn scope_wire(scope: &RuntimeScope) -> Value {
    match scope {
        RuntimeScope::ConversationSlot { agent, source } => json!({
            "kind": "conversation", "conversation_id": source.as_str(), "agent_id": agent.as_str()
        }),
        RuntimeScope::AgentSlot { agent } => json!({ "kind": "agent", "agent_id": agent.as_str() }),
    }
}

fn workspace_wire(
    workspace: &silverhand_backend_core::runtime_delivery::RuntimeWorkspaceRef,
) -> Value {
    json!({ "id": workspace.id().as_str(), "name": workspace.name() })
}

fn session_wire(session: &silverhand_backend_core::runtime_delivery::RuntimeSessionSpec) -> Value {
    let members = session
        .members
        .iter()
        .map(|member| match member {
            RuntimeMember::Agent {
                id,
                name,
                display_name,
                runtime,
            } => json!({
                "kind": "agent", "agent_id": id.as_str(), "name": name,
                "display_name": display_name, "runtime": runtime.as_str(),
            }),
            RuntimeMember::Human {
                id,
                name,
                display_name,
            } => json!({
                "kind": "human", "user_id": id.as_str(), "name": name,
                "display_name": display_name, "avatar_url": Value::Null,
            }),
        })
        .collect::<Vec<_>>();
    json!({
        "conversation_id": session.conversation.as_str(),
        "placement_kind": match session.placement { RuntimePlacement::Workspace => "workspace", RuntimePlacement::DirectPair => "direct_pair" },
        "roster_policy": match session.roster { RuntimeRoster::Open => "open", RuntimeRoster::Fixed => "fixed" },
        "title": session.title,
        "spawned_by_agent_id": session.spawned_by_agent.as_ref().map(AgentId::as_str),
        "members": members,
    })
}

fn instruction_wire(instruction: DeliveryInstruction) -> &'static str {
    match instruction {
        DeliveryInstruction::UserForRecipient => "user_for_recipient",
        DeliveryInstruction::UserForOther => "user_for_other",
        DeliveryInstruction::NonSystemMention => "non_system_mention",
        DeliveryInstruction::System => "system",
        DeliveryInstruction::Other => "other",
    }
}

fn compose_delivery_text(batch: &ClaimedInboxBatch) -> String {
    let deliveries = batch.deliveries();
    let header = if deliveries.len() == 1 {
        "You have one message waiting since you were last active:".to_owned()
    } else {
        format!(
            "You have {} messages waiting since you were last active (oldest first):",
            deliveries.len()
        )
    };
    let body = deliveries
        .iter()
        .map(|delivery| delivery.presentation())
        .collect::<Vec<_>>()
        .join("\n\n---\n\n");
    let instruction = if deliveries
        .iter()
        .any(|delivery| delivery.instruction() == DeliveryInstruction::UserForRecipient)
    {
        "Respond as appropriate — call `silverhand message send` with a brief reply, progress update, blocker question, or final summary before stopping. Complete ALL your work before stopping."
    } else if deliveries
        .iter()
        .any(|delivery| delivery.instruction() == DeliveryInstruction::UserForOther)
    {
        "The user message appears addressed to another agent. Do not call `silverhand message send` unless you own or were assigned the relevant task, or must flag a concrete blocker. Complete ALL work you choose to take before stopping."
    } else if deliveries
        .iter()
        .any(|delivery| delivery.instruction() == DeliveryInstruction::NonSystemMention)
    {
        "Respond as appropriate — call `silverhand message send` before stopping. Complete ALL your work before stopping."
    } else if deliveries
        .iter()
        .all(|delivery| delivery.instruction() == DeliveryInstruction::System)
    {
        "Respond as appropriate. System messages do not require a reply unless they explicitly ask for one."
    } else {
        "Respond as appropriate."
    };
    format!("{header}\n\n{body}\n\n{instruction}")
}

enum DeliveryDisposition {
    Accepted,
    Refused,
    Invalid,
}

fn valid_runtime_start_success(value: &Value) -> bool {
    exact_keys(value, &["started", "pid", "started_at"])
        && value.get("started").and_then(Value::as_bool) == Some(true)
        && value.get("pid").and_then(Value::as_i64).is_some()
        && value.get("started_at").and_then(Value::as_i64).is_some()
}

fn valid_runtime_start_refusal(value: &Value) -> bool {
    exact_keys(value, &["started", "reason", "cooldown_until"])
        && value.get("started").and_then(Value::as_bool) == Some(false)
        && value.get("reason").and_then(Value::as_str) == Some("init_cooldown")
        && value
            .get("cooldown_until")
            .and_then(Value::as_i64)
            .is_some_and(|value| value > 0)
}

fn delivery_disposition(value: &Value) -> DeliveryDisposition {
    match value.get("disposition").and_then(Value::as_str) {
        Some("spawning" | "admitted" | "deferred")
            if exact_keys(value, &["disposition", "pid", "started_at"])
                && value.get("pid").and_then(Value::as_i64).is_some()
                && value.get("started_at").and_then(Value::as_i64).is_some() =>
        {
            DeliveryDisposition::Accepted
        }
        Some("refused") => match value.get("reason").and_then(Value::as_str) {
            Some("startup_pending" | "draining")
                if exact_keys(value, &["disposition", "reason"]) =>
            {
                DeliveryDisposition::Refused
            }
            Some("cooldown")
                if exact_keys(value, &["disposition", "reason", "cooldown_until"])
                    && value
                        .get("cooldown_until")
                        .and_then(Value::as_i64)
                        .is_some_and(|value| value > 0) =>
            {
                DeliveryDisposition::Refused
            }
            _ => DeliveryDisposition::Invalid,
        },
        _ => DeliveryDisposition::Invalid,
    }
}

fn signed_unix_millis(time: SystemTime) -> i64 {
    match time.duration_since(SystemTime::UNIX_EPOCH) {
        Ok(duration) => i64::try_from(duration.as_millis()).unwrap_or(i64::MAX),
        Err(error) => -i64::try_from(error.duration().as_millis()).unwrap_or(i64::MAX),
    }
}

#[cfg(test)]
mod tests {
    use std::ops::Range;

    use silverhand_backend_core::{
        messaging::{MessageContent, ReferencePositions},
        runtime_credential::{ClaimRuntimeCustody, RuntimeCustodyPort, RuntimeEventTime},
    };
    use silverhand_backend_sqlite::{
        runtime_credential::SqliteRuntimeCustodyStore, runtime_delivery::SqliteRuntimeDeliveryStore,
    };
    use sqlx::{Connection, SqliteConnection, sqlite::SqliteConnectOptions};

    use crate::current_schema;

    use super::*;

    #[tokio::test(start_paused = true)]
    async fn queued_command_budget_starts_at_admission_and_cancellation_prevents_late_send() {
        let (commands, mut receive) = mpsc::channel(32);
        let attachment = DaemonAttachment {
            host_id: "host-1".to_owned(),
            connection_id: "connection-1".to_owned(),
            daemon_instance: DaemonInstanceId::parse("instance-1").unwrap(),
            host_name: "host".to_owned(),
            commands,
        };

        let first_attachment = attachment.clone();
        let first = tokio::spawn(async move {
            first_attachment
                .command("host_status", json!({}), Duration::from_secs(60))
                .await
        });
        let blocked_write = match receive.recv().await.unwrap() {
            ConnectionControl::Command(command) => command,
            ConnectionControl::Hydrated(_) => panic!("expected command"),
        };

        let second_attachment = attachment.clone();
        let second = tokio::spawn(async move {
            second_attachment
                .command(
                    "host_proxy_config_set",
                    json!({ "proxy_url": "http://proxy" }),
                    Duration::from_secs(10),
                )
                .await
        });
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(10)).await;
        assert!(matches!(
            second.await.unwrap(),
            Err(CommandDispatchError::TimedOut)
        ));

        // Releasing the stalled first write lets the FIFO advance. The second
        // request is already expired and its receiver is cancelled, so the exact
        // production pre-wire gate discards it rather than emitting a late SET.
        drop(blocked_write);
        let late = match receive.recv().await.unwrap() {
            ConnectionControl::Command(command) => command,
            ConnectionControl::Hydrated(_) => panic!("expected command"),
        };
        assert!(command_expired_before_send(&late));
        first.abort();
    }

    #[tokio::test]
    async fn disconnect_outranks_a_saturated_command_fifo_and_stays_generation_bound() {
        let registry = DaemonRegistry::with_process_epoch("test-epoch".to_owned());
        let (old_sender, mut old_receiver) = mpsc::channel(1);
        let (old_close, mut old_close_receiver) = watch::channel(None);
        let old_id = registry
            .reserve("host-1", old_sender.clone(), old_close)
            .unwrap();
        let (blocked_response, _blocked_receive) = oneshot::channel();
        old_sender
            .try_send(ConnectionControl::Command(CommandRequest {
                kind: "host_status",
                params: json!({}),
                deadline: Instant::now() + DEFAULT_COMMAND_TIMEOUT,
                response: blocked_response,
            }))
            .unwrap();

        let (other_sender, _) = mpsc::channel(1);
        let (other_close, other_close_receiver) = watch::channel(None);
        registry
            .reserve("host-2", other_sender, other_close)
            .unwrap();

        // This is the real production port. Its completion cannot depend on space in
        // the ordinary FIFO, which is full and deliberately has no active receiver.
        let control = DaemonConnectionControlHandle {
            registry: registry.clone(),
        };
        tokio::time::timeout(
            Duration::from_millis(50),
            control.disconnect(HostId::parse("host-1").unwrap()),
        )
        .await
        .expect("disconnect must not wait for ordinary command capacity")
        .unwrap();

        // The old socket ends and a replacement reserves before the captured close is
        // observed. The close is still on the old generation's private channel.
        registry.remove("host-1", &old_id);
        let (replacement_sender, _) = mpsc::channel(1);
        let (replacement_close, replacement_close_receiver) = watch::channel(None);
        let replacement_id = registry
            .reserve("host-1", replacement_sender, replacement_close)
            .unwrap();

        // Both lanes are ready when the stalled receiver resumes. The production
        // arbitration must select close first and leave the queued command untouched.
        assert!(matches!(
            next_connection_input(&mut old_close_receiver, &old_id, &mut old_receiver).await,
            ConnectionInput::Close(ConnectionClose {
                expected_connection_id: Some(ref expected),
                reason: HOST_REVOKED_CLOSE_REASON,
            }) if expected == &old_id
        ));
        assert!(matches!(
            old_receiver.try_recv(),
            Ok(ConnectionControl::Command(_))
        ));
        assert!(replacement_close_receiver.borrow().is_none());
        assert!(other_close_receiver.borrow().is_none());

        // The old task's eventual cleanup is generation-compared as well.
        registry.remove("host-1", &old_id);
        assert_eq!(
            registry.slot_connection_id("host-1").unwrap().as_deref(),
            Some(replacement_id.as_str())
        );
    }

    /// Wave 3A A2 — load-bearing same-live-owner regression gate for the
    /// `/api/channels/{id}/agent-run-states` door, exercised through the
    /// production composition seam.
    ///
    /// The composed `prepare()` E2E proves the route is mounted and, against a
    /// fresh owner, reads an empty run-state map. That alone cannot show the
    /// reader shares the *specific* live owner the daemon writes into. Nor could
    /// a component gate that hand-wires the correct `.clone()` into the raw
    /// `router` factory: it re-proves the mechanism but never touches the line
    /// that chooses the reader owner, so a `prepare()` edit that forked the
    /// reader onto a fresh owner would leave it green.
    ///
    /// This gate binds to that line by routing through the seam `prepare()` uses:
    /// `DaemonDeliveryRuntime::agent_run_states_router`. The seam takes no owner
    /// argument — it binds the reader to the runtime it is called on by
    /// construction — so the fork `prepare()` could once commit (a second-arg
    /// swap) is now unrepresentable, and the only surviving choice is which
    /// runtime the seam is handed. The daemon reconnection hydration path
    /// (`events.hydrate`, the sole non-WebSocket writer of the live run-state
    /// map) records a non-empty run-state into one runtime's owner; the seam on
    /// that runtime reads the precise row back. The seam on an independently
    /// constructed runtime is empty — so binding the door to any runtime but the
    /// delivery one turns the assertion red.
    mod run_states_same_owner {
        use std::{convert::Infallible, path::Path};

        use axum::{
            body::{Body, to_bytes},
            http::Request,
        };
        use serde_json::{Number, Value};
        use silverhand_backend_core::{
            access::WorkspaceRole,
            identity::{AgentId, ConversationId, DaemonInstanceId, UserId, WorkspaceId},
            messaging::{
                collaboration::{
                    channel_directory::{ChannelStatus, ChannelVisibility, DirectoryRoster},
                    channel_lifecycle::{
                        ChannelDetailFact, ChannelDetailReadPort, ChannelDetailRefusal,
                        ChannelLifecycleRow,
                    },
                },
                conversation_title::CanonicalConversationTitle,
            },
            runtime_credential::{
                RuntimeCustody, RuntimeGeneration, RuntimePrincipal, RuntimeScope,
            },
        };
        use silverhand_backend_sqlite::{
            host_runtime::SqliteHostRuntimeStore, runtime_credential::SqliteRuntimeCustodyStore,
            runtime_delivery::SqliteRuntimeDeliveryStore,
        };
        use sqlx::Connection;
        use tower::ServiceExt;

        use crate::{
            current_schema,
            daemon_delivery::{DaemonDeliveryConfig, DaemonDeliveryRuntime},
            daemon_events::{AgentRunStateWire, AgentRunStatus, HydratedRuntime},
            runtime_credential::RuntimeCredentialAuthority,
            scope_events::ScopeEventHub,
        };

        const CONVERSATION: &str = "conversation0001";
        const AGENT: &str = "agent-1";

        /// Admits the viewer for the requested conversation so the route reaches
        /// its snapshot source; the same-owner claim under test lives entirely in
        /// that source, never in admission.
        #[derive(Clone)]
        struct AdmitViewer;

        impl ChannelDetailReadPort for AdmitViewer {
            type Error = Infallible;

            async fn detail(
                &self,
                viewer: &UserId,
                conversation: &ConversationId,
            ) -> Result<Result<ChannelDetailFact, ChannelDetailRefusal>, Self::Error> {
                Ok(Ok(ChannelDetailFact::projected(
                    viewer.clone(),
                    ChannelLifecycleRow::workspace_placed(
                        conversation.clone(),
                        WorkspaceId::parse("w").unwrap(),
                        DirectoryRoster::Open,
                        CanonicalConversationTitle::parse("General").unwrap(),
                        ChannelStatus::Active,
                        None,
                        None,
                        None,
                        None,
                        0,
                        1,
                        1,
                        ChannelVisibility::Private,
                    )
                    .unwrap(),
                    true,
                    Some(WorkspaceRole::Member),
                    1,
                )
                .unwrap()))
            }
        }

        /// A fresh production runtime. Every construction builds its own live
        /// owner (`DaemonRuntimeEventOwner::new`), so two calls against the same
        /// database are two independent owners — the falsifier's second owner.
        async fn build_runtime(
            path: &Path,
        ) -> DaemonDeliveryRuntime<
            SqliteRuntimeCustodyStore,
            SqliteRuntimeDeliveryStore,
            SqliteHostRuntimeStore,
        > {
            let custody = SqliteRuntimeCustodyStore::open(path).await.unwrap();
            let data = SqliteRuntimeDeliveryStore::open(path).await.unwrap();
            let hosts = SqliteHostRuntimeStore::open(path).await.unwrap();
            DaemonDeliveryRuntime::new(
                RuntimeCredentialAuthority::production(custody),
                data,
                hosts,
                DaemonDeliveryConfig::production(),
                ScopeEventHub::production().unwrap(),
            )
            .unwrap()
        }

        async fn read_states(
            runtime: DaemonDeliveryRuntime<
                SqliteRuntimeCustodyStore,
                SqliteRuntimeDeliveryStore,
                SqliteHostRuntimeStore,
            >,
        ) -> (u16, Value) {
            let mut request = Request::builder()
                .uri(format!("/api/channels/{CONVERSATION}/agent-run-states"))
                .body(Body::empty())
                .unwrap();
            request
                .extensions_mut()
                .insert(UserId::parse("viewer").unwrap());
            // Exercise the PRODUCTION seam `prepare()` mounts. The seam takes no
            // owner argument: it binds the reader to `runtime`'s own owner by
            // construction. So the positive/negative difference below is *which
            // runtime the seam is handed* — the exact choice `prepare()` makes at
            // its `.merge(daemon_runtime.agent_run_states_router(..))` line. There
            // is no second-parameter fork for that line to get wrong.
            let response = runtime
                .agent_run_states_router(AdmitViewer)
                .oneshot(request)
                .await
                .unwrap();
            let status = response.status().as_u16();
            let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            (status, serde_json::from_slice(&body).unwrap())
        }

        #[tokio::test]
        async fn the_door_reads_the_delivery_owner_and_a_second_owner_is_red() {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("run-states-same-owner.sqlite");
            current_schema::create_current_schema(&path)
                .await
                .close()
                .await
                .unwrap();

            let delivery_owner = build_runtime(&path).await;
            // The daemon reconnection hydration path writes a live run-state into
            // this owner's `Arc<Mutex<..>>` map — the very map delivery effects
            // mutate. No storage row backs it; run-state is process memory.
            let principal = RuntimePrincipal::for_scope(
                RuntimeScope::ConversationSlot {
                    agent: AgentId::parse(AGENT).unwrap(),
                    source: ConversationId::parse(CONVERSATION).unwrap(),
                },
                RuntimeCustody::new(
                    RuntimeGeneration::new(1).unwrap(),
                    DaemonInstanceId::parse("daemon-1").unwrap(),
                ),
            );
            let wire = AgentRunStateWire {
                run_id: "run-seeded".to_owned(),
                agent_id: AGENT.to_owned(),
                conversation_id: CONVERSATION.to_owned(),
                status: AgentRunStatus::Thinking,
                started_at: Number::from(1),
                updated_at: Number::from(2),
                last_activity_at: Number::from(2),
                terminal_reason: None,
                activity_snippet: None,
                activity_snippet_kind: None,
                tool_call_counts: None,
                compacting: None,
                compacting_since: None,
                compaction_stale: None,
                detail: None,
            };
            delivery_owner
                .events
                .hydrate(
                    "host-1",
                    principal.clone().custody().daemon_instance(),
                    "connection-test",
                    [principal.agent().clone()].into_iter().collect(),
                    vec![HydratedRuntime {
                        principal,
                        run_state: Some(wire),
                    }],
                )
                .await
                .unwrap();

            // Positive: hand the seeded runtime to the same seam `prepare()`
            // uses. The seam binds this runtime's owner (a share of the seeded
            // `Arc<Mutex<..>>` map) as the reader, so the route reads the exact
            // seeded row — the same-live-owner contract, proven at the seam.
            let (status, body) = read_states(delivery_owner.clone()).await;
            assert_eq!(status, 200);
            let states = body["states"].as_array().unwrap();
            assert_eq!(states.len(), 1);
            assert_eq!(states[0]["runId"], "run-seeded");
            assert_eq!(states[0]["agentId"], AGENT);
            assert_eq!(states[0]["conversationId"], CONVERSATION);

            // Falsifier: hand the seam an independently constructed runtime — a
            // different live owner. Same admission, same seam, same request; the
            // seeded row is gone. This is the only fork the seam still permits
            // (a whole second runtime, not a silent second-arg swap), and it is
            // red — so binding the door to any runtime but delivery's fails here.
            let (status, body) = read_states(build_runtime(&path).await).await;
            assert_eq!(status, 200);
            assert!(body["states"].as_array().unwrap().is_empty());
        }
    }

    struct NoReferences;

    impl ReferencePositions for NoReferences {
        fn autolink_spans(&self, _content: &MessageContent) -> Vec<Range<usize>> {
            Vec::new()
        }
    }

    fn ready() -> Value {
        json!({
            "direction": "daemon_to_server",
            "type": "event",
            "kind": "ready",
            "protocol_version": OUTBOUND_PROTOCOL_VERSION,
            "daemon_version": "test",
            "daemon_id": "daemon-test",
            "instance_id": "instance-test",
            "host_descriptor": { "name": "Test host", "kind": "remote" },
            "capabilities": [],
            "daemon_pid": 42,
            "started_at": 100,
        })
    }

    #[test]
    fn ready_and_command_response_frames_are_strict() {
        assert!(matches!(
            parse_daemon_frame(&ready().to_string()),
            Ok(DaemonFrame::Ready(_))
        ));
        let mut widened = ready();
        widened["unexpected"] = json!(true);
        assert!(parse_daemon_frame(&widened.to_string()).is_err());

        let ambiguous_response = json!({
            "direction": "daemon_to_server",
            "type": "command_response",
            "id": "one",
            "kind": "runtime_status",
            "result": { "runtimes": [] },
            "error": { "code": "internal_error", "message": "hidden" },
        });
        assert!(parse_daemon_frame(&ambiguous_response.to_string()).is_err());
    }

    #[test]
    fn the_offered_version_is_read_from_the_envelope_the_strict_schema_rejects() {
        // The population this probe exists for: a daemon old enough that its `ready`
        // frame predates `instance_id`. The strict schema refuses it, so a mismatch
        // decided after the parse would never see the build a human must upgrade.
        let mut old_schema = ready();
        old_schema["protocol_version"] = json!(OUTBOUND_PROTOCOL_VERSION - 1);
        old_schema
            .as_object_mut()
            .unwrap()
            .remove("instance_id")
            .unwrap();
        let old_schema = old_schema.to_string();
        assert!(parse_daemon_frame(&old_schema).is_err());
        assert_eq!(
            offered_ready_protocol_version(&old_schema),
            Some(OUTBOUND_PROTOCOL_VERSION - 1)
        );

        // Our own version is the strict schema's business, not this probe's.
        assert_eq!(
            offered_ready_protocol_version(&ready().to_string()),
            Some(OUTBOUND_PROTOCOL_VERSION)
        );

        // Out of range: not treated as a version, so nothing is recorded — and the
        // strict arm stays reachable for it, which is where it is refused.
        let mut unreadable = ready();
        unreadable["protocol_version"] = json!(MAX_READABLE_PROTOCOL_VERSION + 1);
        assert_eq!(
            offered_ready_protocol_version(&unreadable.to_string()),
            None
        );
        assert!(matches!(
            parse_daemon_frame(&unreadable.to_string()),
            Ok(DaemonFrame::Ready(_))
        ));

        for unreadable_version in [json!(-1), json!(10.5), json!("10"), json!(null)] {
            let mut frame = ready();
            frame["protocol_version"] = unreadable_version.clone();
            assert_eq!(
                offered_ready_protocol_version(&frame.to_string()),
                None,
                "{unreadable_version} is not a readable protocol version"
            );
        }

        let mut absent = ready();
        absent.as_object_mut().unwrap().remove("protocol_version");
        assert_eq!(offered_ready_protocol_version(&absent.to_string()), None);

        // Not a `ready` envelope at all, and not JSON at all.
        let mut other_kind = ready();
        other_kind["kind"] = json!("shutting_down");
        assert_eq!(
            offered_ready_protocol_version(&other_kind.to_string()),
            None
        );
        let mut other_direction = ready();
        other_direction["direction"] = json!("server_to_daemon");
        assert_eq!(
            offered_ready_protocol_version(&other_direction.to_string()),
            None
        );
        assert_eq!(offered_ready_protocol_version("not json"), None);
    }

    #[test]
    fn refusal_codes_are_admitted_per_kind_and_never_invented() {
        let error = |code: &str| json!({ "code": code, "message": "why" });
        for kind in ["runtime_start", "runtime_deliver", "host_runtime_catalog"] {
            assert_eq!(
                CommandRefusal::decode(kind, &error("shutting_down")),
                Some(CommandRefusal::Response)
            );
            assert_eq!(CommandRefusal::decode(kind, &error("banana")), None);
        }
        assert_eq!(
            [
                "unknown_intent",
                "invalid_params",
                "internal_error",
                "shutting_down",
                "request_too_large",
            ]
            .into_iter()
            .filter_map(|code| CommandRefusal::decode("host_runtime_catalog", &error(code)))
            .count(),
            5
        );
        for code in [
            "agent_deleting",
            "workspace_not_provisioned",
            "workspace_bundle_missing",
            "registry_unavailable",
        ] {
            assert!(CommandRefusal::decode("runtime_start", &error(code)).is_some());
            assert!(CommandRefusal::decode("runtime_deliver", &error(code)).is_some());
            assert_eq!(
                CommandRefusal::decode("host_runtime_catalog", &error(code)),
                None
            );
        }
        assert_eq!(
            CommandRefusal::decode("runtime_start", &json!({ "code": "internal_error" })),
            None
        );
        assert_eq!(
            CommandRefusal::decode(
                "runtime_start",
                &json!({ "code": "internal_error", "message": 7 })
            ),
            None
        );
        assert_eq!(
            CommandRefusal::decode(
                "runtime_start",
                &json!({ "code": "internal_error", "message": "why", "extra": true })
            ),
            None
        );
        assert_eq!(CommandRefusal::decode("runtime_start", &json!("why")), None);
    }

    #[test]
    fn an_answer_opens_only_for_the_coordinate_that_awaited_it() {
        let answer = || HostDataPlaneAnswer {
            host: HostId::parse("host-1").unwrap(),
            instance: DaemonInstanceId::parse("instance-shared").unwrap(),
            connection_id: "connection-current".to_owned(),
            result: json!({ "runtimes": [] }),
        };
        let custody = |host: &str, instance: &str, connection: &str| HostDataPlaneCustody {
            host: HostId::parse(host).unwrap(),
            instance: DaemonInstanceId::parse(instance).unwrap(),
            connection_id: connection.to_owned(),
        };

        assert_eq!(
            answer().into_result_for(&custody("host-1", "instance-shared", "connection-current")),
            Ok(json!({ "runtimes": [] }))
        );
        // Both machines spell the custody the same way, so an instance-only bind
        // would file this answer under the wrong host.
        assert_eq!(
            answer().into_result_for(&custody("host-2", "instance-shared", "connection-current")),
            Err(HostDataPlaneAnswerMismatch::Host)
        );
        assert_eq!(
            answer().into_result_for(&custody("host-1", "instance-shared", "connection-old")),
            Err(HostDataPlaneAnswerMismatch::ConnectionGeneration)
        );
        assert_eq!(
            answer().into_result_for(&custody("host-1", "instance-old", "connection-current")),
            Err(HostDataPlaneAnswerMismatch::DaemonInstance)
        );
        assert_eq!(
            answer().into_result_for(&custody("host-2", "instance-old", "connection-old")),
            Err(HostDataPlaneAnswerMismatch::Host)
        );
    }

    #[test]
    fn every_shared_host_data_plane_word_is_admitted_on_the_response_epoch() {
        for (kind, wire) in [
            (HostDataPlaneCommandKind::HostStatus, "host_status"),
            (
                HostDataPlaneCommandKind::RuntimeCatalog,
                "host_runtime_catalog",
            ),
            (
                HostDataPlaneCommandKind::ProxyConfigGet,
                "host_proxy_config_get",
            ),
            (
                HostDataPlaneCommandKind::ProxyConfigSet,
                "host_proxy_config_set",
            ),
            (HostDataPlaneCommandKind::RotateToken, "rotate_token"),
        ] {
            assert_eq!(kind.as_wire(), wire);
            assert!(HostDataPlaneCommandKind::sends_wire(wire));
            assert!(valid_command_response_envelope(&json!({
                "id": "r1",
                "kind": wire,
                "result": { "ok": true },
            })));
        }
    }

    #[test]
    fn the_rotate_token_frame_is_keyed_as_the_daemon_expects() {
        assert_eq!(
            rotation_params("host-1", "cleartext-token".to_owned(), 100, 61),
            json!({
                "host_id": "host-1",
                "host_token": "cleartext-token",
                "issued_at": 100,
                "grace_until": 61,
            })
        );
    }

    #[test]
    fn a_stored_ack_carries_the_computer_and_the_refresh_instant() {
        assert_eq!(
            parse_rotation_ack(&json!({
                "rotated": true,
                "host_id": "host-1",
                "config_refreshed_at": 42,
            })),
            Some(DaemonRotationAck::Stored {
                computer: HostId::parse("host-1").unwrap(),
                config_refreshed_at: 42,
            })
        );
    }

    #[test]
    fn anything_but_a_clean_success_is_a_refusal_that_keeps_the_reason() {
        assert_eq!(
            parse_rotation_ack(&json!({ "rotated": false, "reason": "daemon_busy" })),
            Some(DaemonRotationAck::Refused {
                reason: "daemon_busy".to_owned(),
            })
        );
        // A daemon that answered without saying it rotated has refused, matching the TS
        // coordinator's `!rotated` branch; with no reason to carry the field is empty.
        assert_eq!(
            parse_rotation_ack(&json!({ "reason": "nope" })),
            Some(DaemonRotationAck::Refused {
                reason: "nope".to_owned(),
            })
        );
        assert_eq!(
            parse_rotation_ack(&json!({ "rotated": false })),
            Some(DaemonRotationAck::Refused {
                reason: String::new(),
            })
        );
    }

    #[test]
    fn a_broken_success_frame_is_not_an_acknowledgement() {
        // `rotated: true` with no computer, or no refresh instant, or not an object at
        // all: none stores anything. The caller reads the `None` as unreachable (502),
        // never as a silent success.
        assert_eq!(
            parse_rotation_ack(&json!({ "rotated": true, "config_refreshed_at": 42 })),
            None
        );
        assert_eq!(
            parse_rotation_ack(&json!({ "rotated": true, "host_id": "host-1" })),
            None
        );
        assert_eq!(parse_rotation_ack(&json!("rotated")), None);
    }

    #[test]
    fn a_rotation_with_no_attached_daemon_is_a_no_connection() {
        let rotation = DaemonTokenRotation {
            registry: DaemonRegistry::with_process_epoch("process-a".to_owned()),
        };
        assert!(matches!(
            rotation.attachment(&HostId::parse("host-unattached").unwrap()),
            Err(DaemonRotationDeliveryError::NoConnection)
        ));
    }

    #[test]
    fn rust_consumes_the_ts_first_exact_daemon_event_fixture() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../packages/host/tests/fixtures/outbound-daemon-events.json"
        ))
        .unwrap();
        let valid = fixture["valid"].as_array().unwrap();
        let valid_kinds = valid
            .iter()
            .map(|frame| frame["kind"].as_str().unwrap())
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(
            valid_kinds,
            OUTBOUND_DAEMON_EVENT_KINDS
                .iter()
                .copied()
                .collect::<std::collections::BTreeSet<_>>()
        );
        for frame in valid {
            assert!(
                parse_daemon_frame(&frame.to_string()).is_ok(),
                "valid fixture rejected: {}",
                frame["kind"]
            );
        }
        let parsed_envelope = valid
            .iter()
            .find(|frame| frame["kind"] == "runtime_parsed_event")
            .unwrap();
        let parsed_kinds = fixture["parsedValid"]
            .as_array()
            .unwrap()
            .iter()
            .map(|parsed| parsed["kind"].as_str().unwrap())
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(
            parsed_kinds,
            PARSED_EVENT_KINDS
                .iter()
                .copied()
                .collect::<std::collections::BTreeSet<_>>()
        );
        assert_eq!(
            crate::daemon_events::ParsedEventWire::IMPLEMENTED_KINDS
                .iter()
                .copied()
                .collect::<std::collections::BTreeSet<_>>(),
            PARSED_EVENT_KINDS
                .iter()
                .copied()
                .collect::<std::collections::BTreeSet<_>>()
        );
        for parsed in fixture["parsedValid"].as_array().unwrap() {
            let mut frame = parsed_envelope.clone();
            frame["parsed"] = parsed.clone();
            let parsed_frame = parse_daemon_frame(&frame.to_string())
                .unwrap_or_else(|_| panic!("valid parsed fixture rejected: {}", parsed["kind"]));
            let DaemonFrame::Product(crate::daemon_events::RuntimeProductEvent::Parsed(event)) =
                parsed_frame
            else {
                panic!("parsed fixture reached the wrong owner: {}", parsed["kind"]);
            };
            assert_eq!(event.parsed.kind(), parsed["kind"].as_str().unwrap());
        }
        let state_envelope = valid
            .iter()
            .find(|frame| frame["kind"] == "runtime_state")
            .unwrap();
        for test_case in fixture["runState"]["valid"].as_array().unwrap() {
            let state = serde_json::from_value::<crate::daemon_events::AgentRunStateWire>(
                test_case["state"].clone(),
            )
            .unwrap_or_else(|_| panic!("valid run state rejected: {}", test_case["name"]));
            assert_eq!(
                serde_json::to_value(&state).unwrap(),
                test_case["canonical"]
            );
            let mut frame = state_envelope.clone();
            frame["runtime_scope"] = json!({
                "kind": "conversation",
                "conversation_id": test_case["state"]["conversationId"],
                "agent_id": test_case["state"]["agentId"],
            });
            frame["conversation_id"] = test_case["state"]["conversationId"].clone();
            frame["agent_id"] = test_case["state"]["agentId"].clone();
            frame["state"] = test_case["state"].clone();
            assert!(
                parse_daemon_frame(&frame.to_string()).is_ok(),
                "valid ingress run state rejected: {}",
                test_case["name"]
            );
        }
        for test_case in fixture["runState"]["invalid"].as_array().unwrap() {
            assert!(
                serde_json::from_value::<crate::daemon_events::AgentRunStateWire>(
                    test_case["state"].clone(),
                )
                .is_err(),
                "invalid hydrate/live run state accepted: {}",
                test_case["name"]
            );
            let mut frame = state_envelope.clone();
            frame["runtime_scope"] = json!({
                "kind": "conversation",
                "conversation_id": test_case["state"]["conversationId"],
                "agent_id": test_case["state"]["agentId"],
            });
            frame["conversation_id"] = test_case["state"]["conversationId"].clone();
            frame["agent_id"] = test_case["state"]["agentId"].clone();
            frame["state"] = test_case["state"].clone();
            assert!(
                parse_daemon_frame(&frame.to_string()).is_err(),
                "invalid ingress run state accepted: {}",
                test_case["name"]
            );
        }
        for test_case in fixture["invalid"].as_array().unwrap() {
            assert!(
                parse_daemon_frame(&test_case["frame"].to_string()).is_err(),
                "invalid fixture accepted: {}",
                test_case["name"]
            );
        }
    }

    #[test]
    fn application_heartbeat_timestamps_are_nonnegative() {
        let ping = json!({
            "direction": "daemon_to_server",
            "type": "heartbeat",
            "kind": "ping",
            "ts": 1,
        });
        assert!(matches!(
            parse_daemon_frame(&ping.to_string()),
            Ok(DaemonFrame::HeartbeatPing(_))
        ));
        let mut negative = ping;
        negative["ts"] = json!(-1);
        assert!(parse_daemon_frame(&negative.to_string()).is_err());
    }

    #[test]
    fn response_result_shapes_do_not_accept_extra_fields() {
        assert!(valid_runtime_start_success(
            &json!({ "started": true, "pid": 1, "started_at": 2 })
        ));
        assert!(!valid_runtime_start_success(&json!({
            "started": true,
            "pid": 1,
            "started_at": 2,
            "extra": true,
        })));
        assert!(matches!(
            delivery_disposition(&json!({ "disposition": "refused", "reason": "startup_pending" })),
            DeliveryDisposition::Refused
        ));
        assert!(matches!(
            delivery_disposition(&json!({
                "disposition": "refused",
                "reason": "startup_pending",
                "cooldown_until": 4,
            })),
            DeliveryDisposition::Invalid
        ));
    }

    #[test]
    fn lease_owner_coordinates_do_not_repeat_across_process_epochs_or_host_order() {
        let first_process = DaemonRegistry::with_process_epoch("process-a".into());
        let second_process = DaemonRegistry::with_process_epoch("process-b".into());
        let (first_a, _) = mpsc::channel(1);
        let (first_b, _) = mpsc::channel(1);
        let (second_b, _) = mpsc::channel(1);
        let (second_a, _) = mpsc::channel(1);

        let old_host_a = first_process
            .reserve("host-a", first_a, watch::channel(None).0)
            .unwrap();
        let old_host_b = first_process
            .reserve("host-b", first_b, watch::channel(None).0)
            .unwrap();
        let new_host_b = second_process
            .reserve("host-b", second_b, watch::channel(None).0)
            .unwrap();
        let new_host_a = second_process
            .reserve("host-a", second_a, watch::channel(None).0)
            .unwrap();

        assert_ne!(old_host_a, new_host_a);
        assert_ne!(old_host_b, new_host_b);
        assert_ne!(old_host_a, new_host_b);
        assert_ne!(old_host_b, new_host_a);
        assert!(old_host_a.starts_with("daemon-connection-process-a-"));
        assert!(new_host_b.starts_with("daemon-connection-process-b-"));
    }

    #[tokio::test]
    async fn a_restarted_process_cannot_release_an_old_hosts_real_inbox_lease() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("lease-owner-process-epoch.sqlite");
        let mut db = current_schema::create_current_schema(&path).await;
        sqlx::query(
            "INSERT INTO users (id, name, display_name, created_at, updated_at)
             VALUES ('user-1', 'user-1', 'User One', 1, 1)",
        )
        .execute(&mut db)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO hosts (id, name, kind, created_at, user_id)
             VALUES ('host-a', 'host-a', 'remote', 1, 'user-1'),
                    ('host-b', 'host-b', 'remote', 1, 'user-1')",
        )
        .execute(&mut db)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO agents (
                id, name, runtime, host_id, created_at, updated_at,
                display_name, created_by_user_id, session_scope
             ) VALUES ('agent-lease', 'agent-lease', 'codex', 'host-b', 1, 1,
                 'Lease Agent', 'user-1', 'conversation')",
        )
        .execute(&mut db)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO workspaces (
                id, name, name_key, created_at, updated_at, owner_user_id
             ) VALUES ('workspace-1', 'Workspace One', 'workspace one', 1, 1, 'user-1')",
        )
        .execute(&mut db)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO workspace_members (workspace_id, agent_id, joined_at)
             VALUES ('workspace-1', 'agent-lease', 1)",
        )
        .execute(&mut db)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO conversations (
                id, workspace_id, placement_kind, roster_policy, title, title_key,
                status, created_at, updated_at
             ) VALUES ('conversation0001', 'workspace-1', 'workspace', 'open',
                 'Conversation One', 'conversation one', 'active', 1, 1)",
        )
        .execute(&mut db)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO conversation_agents (conversation_id, agent_id, joined_at)
             VALUES ('conversation0001', 'agent-lease', 1)",
        )
        .execute(&mut db)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO messages (
                id, conversation_id, from_kind, content, seq, created_at
             ) VALUES ('message-lease', 'conversation0001', 'system', 'lease', 1, 1)",
        )
        .execute(&mut db)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO conversation_inboxes (
                conversation_id, agent_id, message_id, created_at, delivery_kind
             ) VALUES ('conversation0001', 'agent-lease', 'message-lease', 1, 'turn')",
        )
        .execute(&mut db)
        .await
        .unwrap();
        db.close().await.unwrap();

        let first_process = DaemonRegistry::with_process_epoch("process-a".into());
        let second_process = DaemonRegistry::with_process_epoch("process-b".into());
        let (old_a_tx, _) = mpsc::channel(1);
        let (old_b_tx, _) = mpsc::channel(1);
        let (new_b_tx, _) = mpsc::channel(1);
        let (new_a_tx, _) = mpsc::channel(1);
        let _old_host_a = first_process
            .reserve("host-a", old_a_tx, watch::channel(None).0)
            .unwrap();
        let old_host_b = first_process
            .reserve("host-b", old_b_tx, watch::channel(None).0)
            .unwrap();
        let _new_host_b = second_process
            .reserve("host-b", new_b_tx, watch::channel(None).0)
            .unwrap();
        let new_host_a = second_process
            .reserve("host-a", new_a_tx, watch::channel(None).0)
            .unwrap();
        let old_owner = DeliveryLeaseOwner::parse(old_host_b).unwrap();
        let new_owner = DeliveryLeaseOwner::parse(new_host_a).unwrap();

        let custody = SqliteRuntimeCustodyStore::open(&path).await.unwrap();
        let scope = RuntimeScope::ConversationSlot {
            agent: AgentId::parse("agent-lease").unwrap(),
            source: ConversationId::parse("conversation0001").unwrap(),
        };
        let principal = custody
            .claim_or_current(ClaimRuntimeCustody::new(
                scope,
                DaemonInstanceId::parse("daemon-old").unwrap(),
                RuntimeEventTime::from_unix_millis(1),
            ))
            .await
            .unwrap()
            .unwrap()
            .into_principal();
        let store = SqliteRuntimeDeliveryStore::open(&path).await.unwrap();
        let claim = store
            .claim_pending(
                "host-b".into(),
                principal.clone(),
                ConversationId::parse("conversation0001").unwrap(),
                old_owner.clone(),
                100,
                1_000,
                &NoReferences,
            )
            .await
            .unwrap();
        assert!(matches!(claim, ClaimPendingInbox::Claimed(_)));

        assert_eq!(store.release_owner(new_owner).await.unwrap(), 0);
        let mut check = SqliteConnection::connect_with(
            &SqliteConnectOptions::new()
                .filename(&path)
                .foreign_keys(true),
        )
        .await
        .unwrap();
        let persisted_owner: Option<String> = sqlx::query_scalar(
            "SELECT in_flight_owner FROM conversation_inboxes WHERE message_id = 'message-lease'",
        )
        .fetch_one(&mut check)
        .await
        .unwrap();
        assert_eq!(persisted_owner.as_deref(), Some(old_owner.as_str()));
        assert_eq!(
            store
                .claim_pending(
                    "host-b".into(),
                    principal,
                    ConversationId::parse("conversation0001").unwrap(),
                    DeliveryLeaseOwner::parse("third-owner").unwrap(),
                    101,
                    1_000,
                    &NoReferences,
                )
                .await
                .unwrap(),
            ClaimPendingInbox::Empty
        );
        assert_eq!(store.release_owner(old_owner).await.unwrap(), 1);
        let released: Option<String> = sqlx::query_scalar(
            "SELECT in_flight_owner FROM conversation_inboxes WHERE message_id = 'message-lease'",
        )
        .fetch_one(&mut check)
        .await
        .unwrap();
        assert!(released.is_none());
    }

    #[test]
    fn rust_batch_and_novel_remainder_consume_the_shared_presentation_fixture() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../packages/shared/tests/fixtures/runtime-delivery-presentation.json"
        ))
        .unwrap();
        let deliveries = fixture["cases"]
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
            .map(|(index, case)| {
                let instruction = match case["expectedInstruction"].as_str().unwrap() {
                    "user_for_recipient" => DeliveryInstruction::UserForRecipient,
                    "user_for_other" => DeliveryInstruction::UserForOther,
                    "non_system_mention" => DeliveryInstruction::NonSystemMention,
                    "system" => DeliveryInstruction::System,
                    "other" => DeliveryInstruction::Other,
                    other => panic!("unexpected fixture instruction {other}"),
                };
                silverhand_backend_core::runtime_delivery::ClaimedInboxDelivery::decoded(
                    InboxDeliveryId::parse(i64::try_from(index + 1).unwrap()).unwrap(),
                    i64::try_from(index).unwrap(),
                    case["expectedBody"].as_str().unwrap().to_owned(),
                    instruction,
                )
            })
            .collect::<Vec<_>>();
        let principal = RuntimePrincipal::for_scope(
            RuntimeScope::AgentSlot {
                agent: AgentId::parse("fixture-agent").unwrap(),
            },
            silverhand_backend_core::runtime_credential::RuntimeCustody::new(
                silverhand_backend_core::runtime_credential::RuntimeGeneration::new(1).unwrap(),
                DaemonInstanceId::parse("fixture-daemon").unwrap(),
            ),
        );
        let batch = ClaimedInboxBatch::claimed(
            principal,
            ConversationId::parse("aBcDeFgHiJkLmN_P").unwrap(),
            DeliveryLeaseOwner::parse("fixture-owner").unwrap(),
            deliveries,
        )
        .unwrap();

        assert_eq!(
            compose_delivery_text(&batch),
            fixture["expectedBatch"].as_str().unwrap()
        );
        let remainder = ClaimedInboxBatch::claimed(
            batch.principal().clone(),
            batch.conversation().clone(),
            batch.owner().clone(),
            batch.deliveries()[1..].to_vec(),
        )
        .unwrap();
        let recomposed = compose_delivery_text(&remainder);
        assert!(
            recomposed.starts_with(
                "You have 2 messages waiting since you were last active (oldest first):"
            )
        );
        assert!(recomposed.contains("msg_id=msg-agent"));
        assert!(!recomposed.contains("msg_id=msg-human"));
    }
}
