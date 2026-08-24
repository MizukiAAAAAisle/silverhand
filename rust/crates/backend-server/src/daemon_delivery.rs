//! Authenticated daemon attachment, delivery custody and Messaging effect adapters.

use std::{
    collections::HashMap,
    error::Error,
    fmt,
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
    host_runtime::{HostCredentialLookup, VerifyHostTokenFact, verify_host_token},
    identity::{AgentId, ConversationId, DaemonInstanceId},
    messaging::{
        CreatedMessage,
        mention_cc::CommittedMentionCopy,
        post_commit::{
            EffectFailure, IdleStart, MainDelivery, ReplyDelivery, RuntimeDelivery, RuntimeStart,
        },
    },
    persistence::PersistenceFailure,
    runtime_credential::{RuntimeFinalStatus, RuntimePrincipal, RuntimeScope},
    runtime_delivery::{
        ClaimPendingInbox, ClaimedInboxBatch, DeliveryInstruction, DeliveryLeaseOwner,
        InboxDeliveryId, RuntimeDeliveryFailureReason, RuntimeDispatchReadPort,
        RuntimeDispatchTarget, RuntimeInboxCustodyPort, RuntimeMember, RuntimePlacement,
        RuntimeRoster, RuntimeSpawnPlan,
    },
};
use tokio::{
    sync::{Notify, mpsc, oneshot},
    time::Instant,
};

use crate::{
    bearer::strict_bearer_credential,
    error,
    messaging::references::MarkdownReferencePositions,
    runtime_credential::{
        RuntimeCredentialAuthority, RuntimeDispatchFailure, RuntimeStartFailure,
        RuntimeStartHandoff, RuntimeStartTransport, RuntimeStopTransport,
    },
};

include!(concat!(env!("OUT_DIR"), "/daemon_admission.rs"));

const MAX_DAEMON_FRAME_BYTES: usize = 1024 * 1024;
const DEFAULT_COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
const DEFAULT_LEASE_TTL: Duration = Duration::from_secs(60);
const DEFAULT_PING_INTERVAL: Duration = Duration::from_secs(30);
const DEFAULT_PONG_TIMEOUT: Duration = Duration::from_secs(5);
const DEFAULT_SHUTDOWN_GRACE: Duration = Duration::from_millis(1_500);

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
    config: DaemonDeliveryConfig,
}

impl<C, D, H> DaemonDeliveryRuntime<C, D, H>
where
    C: silverhand_backend_core::runtime_credential::RuntimeCustodyPort,
    D: RuntimeDispatchReadPort + RuntimeInboxCustodyPort,
    H: HostCredentialLookup,
{
    pub fn production(
        credentials: RuntimeCredentialAuthority<C>,
        data: D,
        host_credentials: H,
    ) -> Result<Self, DaemonDeliveryBuildError> {
        Self::new(
            credentials,
            data,
            host_credentials,
            DaemonDeliveryConfig::production(),
        )
    }

    pub fn new(
        credentials: RuntimeCredentialAuthority<C>,
        data: D,
        host_credentials: H,
        config: DaemonDeliveryConfig,
    ) -> Result<Self, DaemonDeliveryBuildError> {
        Ok(Self {
            credentials,
            data,
            host_credentials,
            registry: DaemonRegistry::new()?,
            config,
        })
    }

    pub fn router(&self) -> (Router, DaemonDeliveryController) {
        let controller = DaemonDeliveryController {
            registry: self.registry.clone(),
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
    D: RuntimeDispatchReadPort + RuntimeInboxCustodyPort,
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
    D: RuntimeDispatchReadPort + RuntimeInboxCustodyPort,
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
    D: RuntimeDispatchReadPort + RuntimeInboxCustodyPort,
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
    D: RuntimeDispatchReadPort + RuntimeInboxCustodyPort,
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

impl<C, D, H> IdleStart for DaemonDeliveryEffects<C, D, H>
where
    C: silverhand_backend_core::runtime_credential::RuntimeCustodyPort,
    D: RuntimeDispatchReadPort + RuntimeInboxCustodyPort,
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
    commands: mpsc::Sender<ConnectionControl>,
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
    daemon_instance: Option<DaemonInstanceId>,
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
                daemon_instance: None,
            },
        );
        self.changed.notify_waiters();
        Ok(connection_id)
    }

    fn attach(
        &self,
        host_id: &str,
        connection_id: &str,
        daemon_instance: DaemonInstanceId,
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
        slot.daemon_instance = Some(daemon_instance);
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
        let Some(daemon_instance) = slot.daemon_instance.clone() else {
            return Ok(None);
        };
        Ok(Some(DaemonAttachment {
            host_id: host_id.to_owned(),
            connection_id: slot.connection_id.clone(),
            daemon_instance,
            commands: slot.commands.clone(),
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
                .filter(|slot| slot.daemon_instance.is_some())
                .count()
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
    shutdown_grace: Duration,
}

impl DaemonDeliveryController {
    pub fn active_connection_count(&self) -> usize {
        self.registry.active_count()
    }

    pub fn attached_connection_count(&self) -> usize {
        self.registry.attached_count()
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
                .map(|slot| slot.commands.clone())
                .collect::<Vec<_>>()
        };
        for sender in senders {
            let _ = sender.send(ConnectionControl::Close).await;
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

enum ConnectionControl {
    Command(CommandRequest),
    CommandTimedOut(String),
    Hydrated(Result<DaemonInstanceId, DaemonDeliveryError>),
    Close,
}

struct CommandRequest {
    kind: &'static str,
    params: Value,
    timeout: Duration,
    response: oneshot::Sender<Result<Value, CommandDispatchError>>,
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
    DaemonRefused,
    InvalidResponse,
}

impl fmt::Display for CommandDispatchError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::ProvenNotDispatched => "daemon command was proven not dispatched",
            Self::Ambiguous => "daemon command outcome is ambiguous",
            Self::TimedOut => "daemon command timed out",
            Self::DaemonRefused => "daemon refused the command",
            Self::InvalidResponse => "daemon returned an invalid command response",
        })
    }
}

impl Error for CommandDispatchError {}

impl DaemonAttachment {
    async fn command(
        &self,
        kind: &'static str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, CommandDispatchError> {
        let (response, receive) = oneshot::channel();
        self.commands
            .try_send(ConnectionControl::Command(CommandRequest {
                kind,
                params,
                timeout,
                response,
            }))
            .map_err(|_| CommandDispatchError::ProvenNotDispatched)?;
        receive.await.map_err(|_| CommandDispatchError::Ambiguous)?
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
        let object = result
            .as_object()
            .ok_or(StopTransportError::InvalidResponse)?;
        if object.len() != 3
            || object.get("mode").and_then(Value::as_str) != Some("hard")
            || object.get("stopped").and_then(Value::as_bool).is_none()
            || !object
                .get("exit_code")
                .is_some_and(|value| value.is_null() || value.as_i64().is_some())
        {
            return Err(StopTransportError::InvalidResponse);
        }
        Ok(())
    }
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
            Err(CommandDispatchError::DaemonRefused) => {
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

async fn daemon_websocket<C, D, H>(
    State(runtime): State<DaemonDeliveryRuntime<C, D, H>>,
    websocket: WebSocketUpgrade,
    headers: HeaderMap,
) -> Response
where
    C: silverhand_backend_core::runtime_credential::RuntimeCustodyPort,
    D: RuntimeDispatchReadPort + RuntimeInboxCustodyPort,
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
    let host_id = match verified {
        Ok(VerifyHostTokenFact::Accepted { host_id, .. }) => host_id,
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
    let connection_id = match runtime.registry.reserve(&host_id, commands.clone()) {
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
            connection(socket, runtime, host_id, connection_id, commands, receive)
        })
}

async fn connection<C, D, H>(
    mut socket: WebSocket,
    runtime: DaemonDeliveryRuntime<C, D, H>,
    host_id: String,
    connection_id: String,
    control: mpsc::Sender<ConnectionControl>,
    mut commands: mpsc::Receiver<ConnectionControl>,
) where
    C: silverhand_backend_core::runtime_credential::RuntimeCustodyPort,
    D: RuntimeDispatchReadPort + RuntimeInboxCustodyPort,
    H: HostCredentialLookup,
{
    let mut pending: HashMap<String, PendingCommand> = HashMap::new();
    let mut next_command = 0_u64;
    let mut compatible: Option<DaemonInstanceId> = None;
    let mut attached: Option<DaemonInstanceId> = None;
    let mut heartbeat = tokio::time::interval_at(
        Instant::now() + runtime.config.ping_interval,
        runtime.config.ping_interval,
    );
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut awaiting_pong: Option<(i64, Instant)> = None;
    loop {
        tokio::select! {
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
            received_control = commands.recv() => match received_control {
                Some(ConnectionControl::Command(command)) if compatible.is_some() => {
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
                    if socket.send(Message::Text(frame.to_string().into())).await.is_err() {
                        let _ = command.response.send(Err(CommandDispatchError::Ambiguous));
                        break;
                    }
                    let timeout_id = id.clone();
                    let timeout_control = control.clone();
                    tokio::spawn(async move {
                        tokio::time::sleep(command.timeout).await;
                        let _ = timeout_control
                            .send(ConnectionControl::CommandTimedOut(timeout_id))
                            .await;
                    });
                    pending.insert(id, (command.kind, command.response));
                }
                Some(ConnectionControl::Command(command)) => {
                    let _ = command.response.send(Err(CommandDispatchError::ProvenNotDispatched));
                }
                Some(ConnectionControl::CommandTimedOut(id)) => {
                    if let Some((_, response)) = pending.remove(&id) {
                        let _ = response.send(Err(CommandDispatchError::TimedOut));
                    }
                }
                Some(ConnectionControl::Hydrated(Ok(instance))) => {
                    if compatible.as_ref() != Some(&instance) {
                        break;
                    }
                    match runtime.registry.attach(&host_id, &connection_id, instance.clone()) {
                        Ok(true) => attached = Some(instance),
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
                Some(ConnectionControl::Hydrated(Err(cause))) => {
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
                Some(ConnectionControl::Close) | None => {
                    let _ = socket.send(Message::Close(Some(CloseFrame {
                        code: 1001,
                        reason: "server_shutdown".into(),
                    }))).await;
                    break;
                }
            },
            inbound = socket.recv() => match inbound {
                Some(Ok(Message::Text(text))) => {
                    let parsed = parse_daemon_frame(&text);
                    match parsed {
                        Ok(DaemonFrame::Ready(ReadyFrame { protocol_version, daemon_pid, started_at })) => {
                            if protocol_version != OUTBOUND_PROTOCOL_VERSION {
                                let _ = socket.send(Message::Close(Some(CloseFrame {
                                    code: 1002,
                                    reason: UPDATE_REQUIRED_CLOSE_REASON.into(),
                                }))).await;
                                break;
                            }
                            let Ok(instance) = silverhand_backend_core::runtime_delivery::daemon_instance_for_ready(daemon_pid, started_at) else {
                                break;
                            };
                            if compatible.is_some() {
                                break;
                            }
                            compatible = Some(instance.clone());
                            let attachment = DaemonAttachment {
                                host_id: host_id.clone(),
                                connection_id: connection_id.clone(),
                                daemon_instance: instance.clone(),
                                commands: control.clone(),
                            };
                            let hydrate_runtime = runtime.clone();
                            let hydrate_control = control.clone();
                            tokio::spawn(async move {
                                let result = hydrate_runtime.hydrate(&attachment).await.map(|()| instance);
                                let _ = hydrate_control.send(ConnectionControl::Hydrated(result)).await;
                            });
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
                            match (result, error) {
                                (Some(result), None) => {
                                    let _ = response.send(Ok(result));
                                }
                                (None, Some(error)) if valid_command_error(expected, &error) => {
                                    let _ = response.send(Err(CommandDispatchError::DaemonRefused));
                                }
                                _ => {
                                    let _ = response.send(Err(CommandDispatchError::InvalidResponse));
                                    let _ = socket.send(Message::Close(Some(CloseFrame {
                                        code: 1002,
                                        reason: "invalid_command_response".into(),
                                    }))).await;
                                    break;
                                }
                            }
                        }
                        Ok(DaemonFrame::DeliveryConsumed(event)) => {
                            let Some(instance) = attached.as_ref() else {
                                let _ = socket.send(Message::Close(Some(CloseFrame {
                                    code: 1008,
                                    reason: "attachment_not_hydrated".into(),
                                }))).await;
                                break;
                            };
                            settle_event(&runtime, &host_id, &connection_id, Some(instance), event, None).await;
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
                            finalize_runtime_event(&runtime, Some(instance), event).await;
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

async fn settle_event<C, D, H>(
    runtime: &DaemonDeliveryRuntime<C, D, H>,
    host_id: &str,
    connection_id: &str,
    attached: Option<&DaemonInstanceId>,
    event: DeliveryEvent,
    failure: Option<RuntimeDeliveryFailureReason>,
) where
    C: silverhand_backend_core::runtime_credential::RuntimeCustodyPort,
    D: RuntimeDispatchReadPort + RuntimeInboxCustodyPort,
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

async fn finalize_runtime_event<C, D, H>(
    runtime: &DaemonDeliveryRuntime<C, D, H>,
    attached: Option<&DaemonInstanceId>,
    event: RuntimeExitEvent,
) where
    C: silverhand_backend_core::runtime_credential::RuntimeCustodyPort,
    D: RuntimeDispatchReadPort + RuntimeInboxCustodyPort,
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
    let status = if event.intentional || event.code == Some(0) {
        RuntimeFinalStatus::Idle
    } else {
        RuntimeFinalStatus::Crashed
    };
    if let Err(cause) = runtime.credentials.finalize(principal, status).await {
        tracing::error!(
            error_chain = %error::describe(&cause),
            observed_at = event.ts,
            "daemon runtime exit finalization failed"
        );
    }
}

enum DaemonFrame {
    Ready(ReadyFrame),
    HeartbeatPing(HeartbeatPingFrame),
    HeartbeatPong(HeartbeatPongFrame),
    DeliveryConsumed(DeliveryEvent),
    DeliveryFailed(FailedDeliveryEvent),
    RuntimeExit(RuntimeExitEvent),
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
    daemon_pid: i64,
    started_at: i64,
}

#[derive(Deserialize)]
struct CommandResponseFrame {
    id: String,
    kind: String,
    result: Option<Value>,
    error: Option<Value>,
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
        && matches!(
            value.get("kind").and_then(Value::as_str),
            Some("runtime_start" | "runtime_stop" | "runtime_deliver" | "runtime_status")
        )
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
}

#[derive(Deserialize)]
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
        self,
        daemon: DaemonInstanceId,
    ) -> Result<Vec<RuntimePrincipal>, EventIdentityError> {
        self.runtimes
            .into_iter()
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
}

#[derive(Deserialize)]
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

#[derive(Deserialize)]
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
            "kind": plan.agent.runtime,
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
                "display_name": display_name, "runtime": runtime,
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

fn valid_command_error(kind: &str, value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    if object.len() != 2 || object.get("message").and_then(Value::as_str).is_none() {
        return false;
    }
    let Some(code) = object.get("code").and_then(Value::as_str) else {
        return false;
    };
    let generic = matches!(
        code,
        "unknown_intent"
            | "invalid_params"
            | "internal_error"
            | "shutting_down"
            | "request_too_large"
    );
    generic
        || matches!(kind, "runtime_start" | "runtime_deliver")
            && matches!(
                code,
                "agent_deleting"
                    | "workspace_not_provisioned"
                    | "workspace_bundle_missing"
                    | "registry_unavailable"
            )
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

        let old_host_a = first_process.reserve("host-a", first_a).unwrap();
        let old_host_b = first_process.reserve("host-b", first_b).unwrap();
        let new_host_b = second_process.reserve("host-b", second_b).unwrap();
        let new_host_a = second_process.reserve("host-a", second_a).unwrap();

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
        let _old_host_a = first_process.reserve("host-a", old_a_tx).unwrap();
        let old_host_b = first_process.reserve("host-b", old_b_tx).unwrap();
        let _new_host_b = second_process.reserve("host-b", new_b_tx).unwrap();
        let new_host_a = second_process.reserve("host-a", new_a_tx).unwrap();
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
