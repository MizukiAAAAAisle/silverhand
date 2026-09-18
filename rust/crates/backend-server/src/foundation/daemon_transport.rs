//! Authenticated daemon attachment, delivery custody and raw websocket transport.

pub(crate) use crate::foundation::daemon_command as command;

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
use silverhand_backend_core::foundation::identity::{DaemonInstanceId, HostId, UserId};
use tokio::{
    sync::{Notify, mpsc, oneshot, watch},
    time::Instant,
};

use crate::{foundation::bearer::strict_bearer_credential, foundation::error};

use super::daemon_metrics::{self, ObservedDaemonSocket};

use self::command::{CapabilityRefusalAdmission, EncodedDaemonCommand, IssuedDaemonCommandKind};

include!(concat!(env!("OUT_DIR"), "/daemon_admission.rs"));

const MAX_DAEMON_FRAME_BYTES: usize = 1024 * 1024;
const MAX_WORKSPACE_FILE_FRAME_BYTES: usize = 4 * 1024 * 1024;
/// The highest `protocol_version` this server will read out of a `ready` envelope
/// before knowing the schema, mirroring the deployed bound. Above it the number is
/// not treated as a version at all: an unbounded integer from an unauthenticated
/// schema is a corrupt-dialer signal, not an actionable "upgrade this daemon" fact.
const MAX_READABLE_PROTOCOL_VERSION: u32 = 100;
const DEFAULT_COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
/// The purge waits for runtime quiescence before removing the agent home, matching
/// the TS production data-plane budget rather than the ordinary control round trip.
const DEFAULT_LEASE_TTL: Duration = Duration::from_secs(60);
const DEFAULT_PING_INTERVAL: Duration = Duration::from_secs(30);
const DEFAULT_PONG_TIMEOUT: Duration = Duration::from_secs(5);
const DEFAULT_SHUTDOWN_GRACE: Duration = Duration::from_millis(1_500);

pub(crate) type DaemonOwnerFailure = Box<dyn Error + Send + Sync>;

/// The authenticated identity returned to the raw websocket perimeter.  The
/// credential store and verification policy remain behind the application port.
pub(crate) struct AuthenticatedDaemonHost {
    pub(crate) host_id: String,
    pub(crate) owner_user_id: UserId,
    pub(crate) credential_id: String,
}

pub(crate) trait DaemonHostAuthentication: Send + Sync {
    fn activate<'a>(
        &'a self,
        host: &'a str,
        owner: &'a UserId,
        credential: &'a str,
        now: i64,
    ) -> Pin<Box<dyn Future<Output = Result<bool, DaemonOwnerFailure>> + Send + 'a>>;

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
    >;
}

/// Host-admission effects are deliberately narrower than the admission owner:
/// the transport reports two edges and receives no ledger or decision object.
pub(crate) trait DaemonProtocolAdmission: Send + Sync {
    fn incompatible(
        &self,
        host_id: &str,
        connection_id: &str,
        offered_protocol_version: u32,
        expected_protocol_version: u32,
        observed_at: i64,
    );

    fn attached(&self, host_id: &str);
}

pub(crate) trait DaemonRuntimeHydration: Send + Sync {
    fn hydrate<'a>(
        &'a self,
        plane: AttachedHostDataPlane,
    ) -> Pin<Box<dyn Future<Output = Result<(), DaemonOwnerFailure>> + Send + 'a>>;
}

pub(crate) trait DaemonHostReadyEffect: Send + Sync {
    fn attached(&self, host: &HostId, connection_id: &str);
}

pub(crate) trait DaemonStatusSeedEffect: Send + Sync {
    fn attached(
        &self,
        host: HostId,
        daemon: DaemonInstanceId,
        connection_id: String,
        owner: UserId,
        authority: DaemonConnectionAuthority,
    );
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DaemonRuntimeEventDisposition {
    Continue,
    Close { code: u16, reason: &'static str },
}

pub(crate) trait DaemonRuntimeEventEffects: Send + Sync {
    fn handle<'a>(
        &'a self,
        host_id: &'a str,
        connection_id: &'a str,
        daemon: &'a DaemonInstanceId,
        kind: String,
        value: Value,
    ) -> Pin<Box<dyn Future<Output = DaemonRuntimeEventDisposition> + Send + 'a>>;

    fn detached(&self, host_id: &str, daemon: &DaemonInstanceId, connection_id: &str);

    fn release_connection<'a>(
        &'a self,
        connection_id: &'a str,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>>;
}

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
pub(crate) struct DaemonTransport {
    registry: DaemonRegistry,
    config: DaemonDeliveryConfig,
}

impl DaemonTransport {
    pub(crate) fn new(config: DaemonDeliveryConfig) -> Result<Self, DaemonDeliveryBuildError> {
        Ok(Self {
            registry: DaemonRegistry::new()?,
            config,
        })
    }

    pub(crate) fn command_timeout(&self) -> Duration {
        self.config.command_timeout
    }

    pub(crate) fn lease_ttl_ms(&self) -> i64 {
        self.config.lease_ttl_ms()
    }

    pub(crate) fn owning_host_data_plane(&self) -> OwningHostDataPlane {
        OwningHostDataPlane {
            registry: self.registry.clone(),
        }
    }

    pub(crate) fn controller(&self) -> DaemonTransportController {
        DaemonTransportController {
            registry: self.registry.clone(),
            shutdown_grace: self.config.shutdown_grace,
        }
    }

    pub(crate) fn router(
        &self,
        authentication: Arc<dyn DaemonHostAuthentication>,
        admission: Arc<dyn DaemonProtocolAdmission>,
        hydration: Arc<dyn DaemonRuntimeHydration>,
        host_ready: Arc<dyn DaemonHostReadyEffect>,
        status_seed: Arc<dyn DaemonStatusSeedEffect>,
        runtime_events: Arc<dyn DaemonRuntimeEventEffects>,
    ) -> Router {
        Router::new()
            .route(HOST_WEBSOCKET_PATH, get(daemon_websocket))
            .with_state(DaemonWebsocketState {
                transport: self.clone(),
                authentication,
                admission,
                hydration,
                host_ready,
                status_seed,
                runtime_events,
            })
    }

    #[cfg(test)]
    pub(crate) fn registry_for_test(&self) -> &DaemonRegistry {
        &self.registry
    }
}

#[derive(Clone)]
struct DaemonWebsocketState {
    transport: DaemonTransport,
    authentication: Arc<dyn DaemonHostAuthentication>,
    admission: Arc<dyn DaemonProtocolAdmission>,
    hydration: Arc<dyn DaemonRuntimeHydration>,
    host_ready: Arc<dyn DaemonHostReadyEffect>,
    status_seed: Arc<dyn DaemonStatusSeedEffect>,
    runtime_events: Arc<dyn DaemonRuntimeEventEffects>,
}

#[derive(Clone)]
struct DaemonAttachment {
    host_id: String,
    connection_id: String,
    daemon_instance: DaemonInstanceId,
    host_name: String,
    commands: mpsc::Sender<ConnectionControl>,
}

/// Generation-bound typed command capability handed to context owners. The raw
/// sender, correlation state and wire frame remain private to this transport;
/// owners can submit only a sealed command vocabulary value.
#[derive(Clone)]
pub(crate) struct AttachedHostDataPlane {
    attachment: DaemonAttachment,
}

impl AttachedHostDataPlane {
    fn new(attachment: DaemonAttachment) -> Self {
        Self { attachment }
    }

    pub(crate) fn host_id(&self) -> &str {
        &self.attachment.host_id
    }

    pub(crate) fn connection_id(&self) -> &str {
        &self.attachment.connection_id
    }

    pub(crate) fn daemon_instance(&self) -> &DaemonInstanceId {
        &self.attachment.daemon_instance
    }

    pub(crate) async fn dispatch(
        &self,
        command: EncodedDaemonCommand,
        timeout: Duration,
    ) -> Result<Value, CommandDispatchError> {
        dispatch_attachment(&self.attachment, command, timeout).await
    }
}

#[derive(Clone)]
struct AttachedDaemon {
    daemon_instance: DaemonInstanceId,
    host_name: String,
}

#[derive(Clone)]
pub(crate) struct DaemonRegistry {
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
pub(crate) struct DaemonTransportController {
    registry: DaemonRegistry,
    shutdown_grace: Duration,
}

impl DaemonTransportController {
    pub(crate) fn owning_host_data_plane(&self) -> OwningHostDataPlane {
        OwningHostDataPlane {
            registry: self.registry.clone(),
        }
    }

    pub(crate) fn connection_authority(&self) -> DaemonConnectionAuthority {
        DaemonConnectionAuthority {
            registry: self.registry.clone(),
        }
    }
}

#[derive(Clone)]
pub(crate) struct DaemonConnectionAuthority {
    registry: DaemonRegistry,
}

impl DaemonConnectionAuthority {
    pub(crate) fn connection_id(
        &self,
        host: &HostId,
    ) -> Result<Option<String>, DaemonRegistryError> {
        self.registry.slot_connection_id(host.as_str())
    }

    pub(crate) async fn wait_for_same_connection(
        &self,
        host: &HostId,
        connection_id: &str,
        after: Duration,
    ) -> bool {
        wait_for_seed_retry_or_replacement(&self.registry, host, connection_id, after).await
    }

    pub(crate) fn connected_host_name(&self, host: &HostId) -> Option<String> {
        self.registry
            .attachment(host.as_str())
            .ok()
            .flatten()
            .map(|attachment| attachment.host_name)
    }

    pub(crate) fn request_host_close(
        &self,
        host: &HostId,
        reason: HostCloseReason,
    ) -> Result<bool, DaemonRegistryError> {
        let current = self.registry.current_close_control(host.as_str())?;
        let Some(current) = current else {
            return Ok(false);
        };
        let reason = match reason {
            HostCloseReason::Revoked => "host_revoked",
            HostCloseReason::UserManaged => "host_disconnected",
        };
        let _ = current.sender.send(Some(ConnectionClose {
            expected_connection_id: Some(current.connection_id),
            reason,
        }));
        Ok(true)
    }
}

impl DaemonTransportController {
    pub(crate) fn active_connection_count(&self) -> usize {
        self.registry.active_count()
    }

    pub(crate) fn attached_connection_count(&self) -> usize {
        self.registry.attached_count()
    }

    /// Whether the delivery transport currently holds an attachment for one host.
    /// This reads the SAME slot the delivery dispatch gate consults — a slot is
    /// attached exactly when it carries a hydrated `daemon_instance` — so an
    /// availability read and the delivery path observe one fact rather than two
    /// projections that can drift.
    pub(crate) fn host_attached(&self, host_id: &str) -> Result<bool, DaemonRegistryError> {
        Ok(self.registry.attachment(host_id)?.is_some())
    }

    pub(crate) async fn close(&self) {
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

#[derive(Clone, Copy)]
pub(crate) enum HostCloseReason {
    Revoked,
    UserManaged,
}

enum ConnectionControl {
    Command(CommandRequest),
    Hydrated(Result<AttachedDaemon, DaemonOwnerFailure>),
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ConnectionClose {
    expected_connection_id: Option<String>,
    reason: &'static str,
}

struct CommandRequest {
    kind: IssuedDaemonCommandKind,
    params: Value,
    capability_refusal: CapabilityRefusalAdmission,
    deadline: Instant,
    response: oneshot::Sender<Result<Value, CommandDispatchError>>,
}

fn command_expired_before_send(command: &CommandRequest) -> bool {
    command.response.is_closed() || Instant::now() >= command.deadline
}

trait CommandWireSink {
    async fn send(&mut self, message: Message, deadline: Instant) -> InterruptibleSend;
}

enum DequeuedCommandSend {
    Skipped,
    Sent {
        id: String,
        kind: IssuedDaemonCommandKind,
        capability_refusal: CapabilityRefusalAdmission,
        deadline: Instant,
        response: oneshot::Sender<Result<Value, CommandDispatchError>>,
    },
    Terminate,
    Close(ConnectionClose),
}

/// The sole dequeue-to-wire decision for a business command. The caller has
/// removed `command` from the FIFO, but this function alone decides whether it is
/// still admissible at the wire boundary. Tests drive the same branch through a
/// controlled sink, so removing the expiry/cancellation gate makes a late command
/// observable as a sink write.
async fn send_dequeued_command<S: CommandWireSink>(
    command: CommandRequest,
    next_command: &mut u64,
    sink: &mut S,
) -> DequeuedCommandSend {
    if command_expired_before_send(&command) {
        let _ = command.response.send(Err(CommandDispatchError::TimedOut));
        return DequeuedCommandSend::Skipped;
    }
    *next_command = match next_command.checked_add(1) {
        Some(next) => next,
        None => {
            let _ = command
                .response
                .send(Err(CommandDispatchError::ProvenNotDispatched));
            return DequeuedCommandSend::Skipped;
        }
    };
    let id = format!("rust-daemon-{next_command}");
    let frame = json!({
        "direction": "server_to_daemon",
        "type": "command",
        "id": id,
        "kind": command.kind.as_wire(),
        "params": command.params,
    });
    let encoded = frame.to_string();
    if encoded.len() > MAX_DAEMON_FRAME_BYTES {
        let _ = command
            .response
            .send(Err(CommandDispatchError::ProvenNotDispatched));
        return DequeuedCommandSend::Skipped;
    }
    match sink
        .send(Message::Text(encoded.into()), command.deadline)
        .await
    {
        InterruptibleSend::Sent => DequeuedCommandSend::Sent {
            id,
            kind: command.kind,
            capability_refusal: command.capability_refusal,
            deadline: command.deadline,
            response: command.response,
        },
        InterruptibleSend::Expired => {
            let _ = command.response.send(Err(CommandDispatchError::TimedOut));
            DequeuedCommandSend::Terminate
        }
        InterruptibleSend::TransportFailed | InterruptibleSend::Terminated => {
            let _ = command.response.send(Err(CommandDispatchError::Ambiguous));
            DequeuedCommandSend::Terminate
        }
        InterruptibleSend::Close(requested) => {
            let _ = command.response.send(Err(CommandDispatchError::Ambiguous));
            DequeuedCommandSend::Close(requested)
        }
    }
}

struct PendingCommand {
    kind: IssuedDaemonCommandKind,
    capability_refusal: CapabilityRefusalAdmission,
    response: oneshot::Sender<Result<Value, CommandDispatchError>>,
    deadline: Instant,
}

#[derive(Debug)]
pub(crate) enum CommandDispatchError {
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
pub(crate) enum DaemonRefusalCode {
    UnknownIntent,
    InvalidParams,
    InternalError,
    ShuttingDown,
    RequestTooLarge,
}

impl DaemonRefusalCode {
    const ALL_WIRE: [&'static str; 5] = [
        "unknown_intent",
        "invalid_params",
        "internal_error",
        "shutting_down",
        "request_too_large",
    ];

    fn parse(raw: &str) -> Option<Self> {
        match Self::ALL_WIRE
            .iter()
            .position(|candidate| *candidate == raw)?
        {
            0 => Some(Self::UnknownIntent),
            1 => Some(Self::InvalidParams),
            2 => Some(Self::InternalError),
            3 => Some(Self::ShuttingDown),
            4 => Some(Self::RequestTooLarge),
            _ => None,
        }
    }
}

/// A refusal admitted by the transport. Generic daemon codes remain typed here;
/// capability codes stay opaque until the context owner decodes its own vocabulary.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum CommandRefusal {
    Response(DaemonRefusalCode),
    Capability(CapabilityRefusal),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct CapabilityRefusal {
    code: Box<str>,
    /// The daemon's own `message` string. Retained (not discarded) so a consumer that
    /// mirrors TS `mapDataPlaneError` can surface the daemon's message rather than a
    /// canned one (Cindy #5). Callers that prefer a product-authored message simply
    /// ignore it.
    message: Box<str>,
}

impl CapabilityRefusal {
    pub(crate) fn code(&self) -> &str {
        &self.code
    }

    pub(crate) fn message(&self) -> &str {
        &self.message
    }
}

impl CommandRefusal {
    fn decode(capability_refusal: CapabilityRefusalAdmission, value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        let message = object.get("message").and_then(Value::as_str);
        if object.len() != 2 || message.is_none() {
            return None;
        }
        let message = message?;
        let code = object.get("code").and_then(Value::as_str)?;
        if let Some(code) = DaemonRefusalCode::parse(code) {
            return Some(Self::Response(code));
        }
        if capability_refusal(code) {
            return Some(Self::Capability(CapabilityRefusal {
                code: code.into(),
                message: message.into(),
            }));
        }
        None
    }

    #[cfg(test)]
    pub(crate) fn capability(code: &str) -> Self {
        Self::Capability(CapabilityRefusal {
            code: code.into(),
            message: "daemon capability refusal".into(),
        })
    }

    #[cfg(test)]
    pub(crate) fn capability_with_message(code: &str, message: &str) -> Self {
        Self::Capability(CapabilityRefusal {
            code: code.into(),
            message: message.into(),
        })
    }
}

impl DaemonAttachment {
    #[tracing::instrument(
        target = "silverhand::diagnostics",
        name = "daemon.command",
        skip_all,
        fields(
            elapsed_ms = tracing::field::Empty,
            outcome = tracing::field::Empty,
            operation_finished = tracing::field::Empty,
            command = command.kind().as_wire(),
        )
    )]
    async fn command(
        &self,
        command: EncodedDaemonCommand,
        timeout: Duration,
    ) -> Result<Value, CommandDispatchError> {
        let observation = silverhand_backend_observability::Operation::current();
        let result = async {
            let (kind, params, capability_refusal) = command.into_wire_parts();
            let started = Instant::now();
            let result = async {
                let deadline = Instant::now()
                    .checked_add(timeout)
                    .ok_or(CommandDispatchError::TimedOut)?;
                let (response, receive) = oneshot::channel();
                self.commands
                    .try_send(ConnectionControl::Command(CommandRequest {
                        kind,
                        params,
                        capability_refusal,
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
            .await;
            let outcome = match &result {
                Ok(_) => "ok",
                Err(CommandDispatchError::TimedOut) => "timeout",
                Err(
                    CommandDispatchError::ProvenNotDispatched | CommandDispatchError::Ambiguous,
                ) => "disconnected",
                Err(_) => "error",
            };
            metrics::histogram!(
                "silverhand_daemon_command_duration_seconds",
                "command" => kind.as_wire(),
                "outcome" => outcome,
            )
            .record(started.elapsed().as_secs_f64());
            result
        }
        .await;
        observation.finish(&result);
        result
    }
}

/// One owning-host data-plane round trip. Crate-private on purpose: a raw command pairs a
/// kind with a free-form payload and a budget, so anything able to build one could
/// send a legal kind with a payload that kind has no contract for. Only the typed
/// command adapters may state that pairing.
pub(crate) struct HostDataPlaneRequest {
    pub(crate) custody: HostDataPlaneCustody,
    pub(crate) command: EncodedDaemonCommand,
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
    pub(crate) fn captured(
        host: HostId,
        instance: DaemonInstanceId,
        connection_id: String,
    ) -> Self {
        Self {
            host,
            instance,
            connection_id,
        }
    }

    pub fn host(&self) -> &HostId {
        &self.host
    }

    pub fn daemon_instance(&self) -> &DaemonInstanceId {
        &self.instance
    }

    pub(crate) fn connection_id(&self) -> &str {
        &self.connection_id
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
    /// consumer in this crate distinguishes them. What the closed set is
    /// load-bearing for is the arm itself: a refusal leaves the connection alive,
    /// and anything outside the set does not.
    Refused(CommandRefusal),
    ProtocolCorruption,
    RegistryUnavailable,
}

impl HostDataPlaneFailure {
    fn from_dispatch(error: CommandDispatchError) -> Self {
        match error {
            CommandDispatchError::ProvenNotDispatched => Self::NotDispatched,
            CommandDispatchError::Ambiguous => Self::Ambiguous,
            CommandDispatchError::TimedOut => Self::TimedOut,
            CommandDispatchError::DaemonRefused(refusal) => Self::Refused(refusal),
            CommandDispatchError::InvalidResponse => Self::ProtocolCorruption,
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
            Self::Refused(_) => "daemon refused the host command",
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
/// use silverhand_backend_server::application_orchestration::daemon_delivery::{HostDataPlaneRequest, HostDataPlaneCommandKind};
///
/// fn forge() -> HostDataPlaneRequest {
///     HostDataPlaneRequest {
///         host: silverhand_backend_core::foundation::identity::HostId::parse("host-1").unwrap(),
///         expected_instance: silverhand_backend_core::foundation::identity::DaemonInstanceId::parse("i").unwrap(),
///         kind: HostDataPlaneCommandKind::RuntimeCatalog,
///         params: serde_json::json!({ "force": true }),
///         timeout: std::time::Duration::from_secs(1),
///     }
/// }
/// ```
///
/// ```compile_fail
/// use silverhand_backend_server::application_orchestration::daemon_delivery::OwningHostDataPlane;
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
/// use silverhand_backend_core::foundation::identity::HostId;
/// use silverhand_backend_server::{
///     application_orchestration::daemon_delivery::{
///         DaemonDeliveryController, OwningHostDataPlane,
///     },
///     host_runtime::host_control::runtime_catalog::{
///         self, RuntimeCatalogOutcome, RuntimeCatalogRequest,
///     },
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
    pub(crate) fn capture_attached(
        &self,
        host: &str,
    ) -> Result<Option<AttachedHostDataPlane>, DaemonRegistryError> {
        Ok(self
            .registry
            .attachment(host)?
            .map(AttachedHostDataPlane::new))
    }

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
        let started = Instant::now();
        let admitted = (|| {
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

            Ok(attachment)
        })();
        let attachment = match admitted {
            Ok(attachment) => attachment,
            Err(error) => {
                let outcome = if matches!(error, HostDataPlaneFailure::RegistryUnavailable) {
                    "error"
                } else {
                    "disconnected"
                };
                metrics::histogram!(
                    "silverhand_daemon_command_duration_seconds",
                    "command" => command.command.kind().as_wire(),
                    "outcome" => outcome,
                )
                .record(started.elapsed().as_secs_f64());
                return Err(error);
            }
        };
        let result = dispatch_attachment(&attachment, command.command, command.timeout)
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

/// The only low-level attachment command call in production. Registry-backed and
/// pre-attach callers both hand this boundary an already sealed command; no sibling
/// can reopen or recombine its wire kind and payload.
async fn dispatch_attachment(
    attachment: &DaemonAttachment,
    command: EncodedDaemonCommand,
    timeout: Duration,
) -> Result<Value, CommandDispatchError> {
    attachment.command(command, timeout).await
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
    socket: &mut ObservedDaemonSocket,
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

struct WebSocketCommandSink<'a> {
    socket: &'a mut ObservedDaemonSocket,
    close: &'a mut watch::Receiver<Option<ConnectionClose>>,
    connection_id: &'a str,
}

impl CommandWireSink for WebSocketCommandSink<'_> {
    async fn send(&mut self, message: Message, deadline: Instant) -> InterruptibleSend {
        send_command_interruptibly(
            self.socket,
            self.close,
            self.connection_id,
            message,
            deadline,
        )
        .await
    }
}

async fn send_connection_close(socket: &mut ObservedDaemonSocket, close: ConnectionClose) {
    let _ = socket
        .send(Message::Close(Some(CloseFrame {
            code: 1001,
            reason: close.reason.into(),
        })))
        .await;
}

async fn daemon_websocket(
    State(state): State<DaemonWebsocketState>,
    websocket: Result<WebSocketUpgrade, axum::extract::ws::rejection::WebSocketUpgradeRejection>,
    headers: HeaderMap,
) -> Response {
    daemon_metrics::connection("upgrade", "attempt");
    let websocket = match websocket {
        Ok(websocket) => websocket,
        Err(error) => {
            daemon_metrics::connection("upgrade", "invalid_upgrade");
            return error.into_response();
        }
    };
    let DaemonWebsocketState {
        transport,
        authentication,
        admission,
        hydration,
        host_ready,
        status_seed,
        runtime_events,
    } = state;
    let Some(token) = strict_bearer_credential(&headers) else {
        daemon_metrics::connection("upgrade", "auth_401");
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let authenticated = authentication
        .authenticate(token.to_owned(), signed_unix_millis(SystemTime::now()))
        .await;
    let AuthenticatedDaemonHost {
        host_id,
        owner_user_id,
        credential_id,
    } = match authenticated {
        Ok(Some(authenticated)) => authenticated,
        Ok(None) => {
            daemon_metrics::connection("upgrade", "auth_401");
            return StatusCode::UNAUTHORIZED.into_response();
        }
        Err(cause) => {
            tracing::error!(
                error_chain = crate::foundation::safe_log_field::safe_display(
                    &(error::describe(cause.as_ref()))
                ),
                "daemon host credential authentication failed"
            );
            daemon_metrics::connection("upgrade", "error");
            return (StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error").into_response();
        }
    };
    let (commands, receive) = mpsc::channel(32);
    let (close, close_receive) = watch::channel(None);
    let connection_id = match transport
        .registry
        .reserve(&host_id, commands.clone(), close)
    {
        Ok(id) => id,
        Err(ReserveConnectionError::Occupied) => {
            daemon_metrics::connection("upgrade", "already_connected");
            return StatusCode::CONFLICT.into_response();
        }
        Err(ReserveConnectionError::Closing) => {
            daemon_metrics::connection("upgrade", "server_closing");
            return StatusCode::SERVICE_UNAVAILABLE.into_response();
        }
        Err(ReserveConnectionError::Exhausted | ReserveConnectionError::Poisoned) => {
            tracing::error!("daemon attachment registry reservation failed");
            daemon_metrics::connection("upgrade", "error");
            return (StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error").into_response();
        }
    };
    websocket
        .max_message_size(MAX_WORKSPACE_FILE_FRAME_BYTES)
        .max_frame_size(MAX_WORKSPACE_FILE_FRAME_BYTES)
        .on_upgrade(move |socket| {
            connection(
                socket,
                transport,
                authentication,
                admission,
                hydration,
                host_ready,
                status_seed,
                runtime_events,
                AuthenticatedHostConnection {
                    host_id,
                    owner_user_id,
                    credential_id,
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
    credential_id: String,
    connection_id: String,
}

#[allow(clippy::too_many_arguments)]
async fn connection(
    socket: WebSocket,
    transport: DaemonTransport,
    authentication: Arc<dyn DaemonHostAuthentication>,
    admission: Arc<dyn DaemonProtocolAdmission>,
    hydration: Arc<dyn DaemonRuntimeHydration>,
    host_ready: Arc<dyn DaemonHostReadyEffect>,
    status_seed: Arc<dyn DaemonStatusSeedEffect>,
    runtime_events: Arc<dyn DaemonRuntimeEventEffects>,
    authenticated: AuthenticatedHostConnection,
    control: mpsc::Sender<ConnectionControl>,
    mut commands: mpsc::Receiver<ConnectionControl>,
    mut close: watch::Receiver<Option<ConnectionClose>>,
) {
    let mut socket = ObservedDaemonSocket::new(socket);
    let AuthenticatedHostConnection {
        host_id,
        owner_user_id,
        credential_id,
        connection_id,
    } = authenticated;
    let mut pending: HashMap<String, PendingCommand> = HashMap::new();
    let (timeout_control, mut timed_out_commands) = mpsc::unbounded_channel();
    let mut next_command = 0_u64;
    let mut compatible: Option<AttachedDaemon> = None;
    let mut attached: Option<DaemonInstanceId> = None;
    let mut heartbeat = tokio::time::interval_at(
        Instant::now() + transport.config.ping_interval,
        transport.config.ping_interval,
    );
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut awaiting_pong: Option<(i64, Instant)> = None;
    loop {
        tokio::select! {
            Some(id) = timed_out_commands.recv() => {
                if let Some(pending_command) = pending.remove(&id) {
                    if Instant::now() < pending_command.deadline {
                        pending.insert(id, pending_command);
                        continue;
                    }
                    let _ = pending_command.response.send(Err(CommandDispatchError::TimedOut));
                }
            }
            received_control = next_connection_input(&mut close, &connection_id, &mut commands) => match received_control {
                ConnectionInput::Close(requested) => {
                    send_connection_close(&mut socket, requested).await;
                    break;
                }
                ConnectionInput::Control(ConnectionControl::Command(command)) if compatible.is_some() => {
                    let mut sink = WebSocketCommandSink {
                        socket: &mut socket,
                        close: &mut close,
                        connection_id: &connection_id,
                    };
                    let sent = send_dequeued_command(command, &mut next_command, &mut sink).await;
                    let (id, kind, capability_refusal, deadline, response) = match sent {
                        DequeuedCommandSend::Skipped => continue,
                        DequeuedCommandSend::Sent { id, kind, capability_refusal, deadline, response } => {
                            (id, kind, capability_refusal, deadline, response)
                        }
                        DequeuedCommandSend::Terminate => break,
                        DequeuedCommandSend::Close(requested) => {
                            send_connection_close(&mut socket, requested).await;
                            break;
                        }
                    };
                    let timeout_id = id.clone();
                    let timeout_sender = timeout_control.clone();
                    tokio::spawn(async move {
                        tokio::time::sleep_until(deadline).await;
                        let _ = timeout_sender.send(timeout_id);
                    });
                    pending.insert(id, PendingCommand {
                        kind,
                        capability_refusal,
                        response,
                        deadline,
                    });
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
                    let current = match transport.registry.slot_connection_id(&host_id) {
                        Ok(current) => current,
                        Err(cause) => {
                            tracing::error!(
                                error_chain = crate::foundation::safe_log_field::safe_display(&error::describe(&cause)),
                                "daemon generation lookup failed before activation"
                            );
                            break;
                        }
                    };
                    if current.as_deref() != Some(&connection_id) {
                        break;
                    }

                    let activated = tokio::select! {
                        biased;
                        requested = matching_connection_close(&mut close, &connection_id) => {
                            if let Some(requested) = requested {
                                send_connection_close(&mut socket, requested).await;
                            }
                            break;
                        },
                        result = authentication.activate(&host_id, &owner_user_id, &credential_id, signed_unix_millis(SystemTime::now())) => result,
                    };
                    match activated {
                        Ok(true) => {}
                        Ok(false) => {
                            let _ = socket.send(Message::Close(Some(CloseFrame {
                                code: 1008,
                                reason: "host_revoked".into(),
                            }))).await;
                            break;
                        }
                        Err(cause) => {
                            tracing::error!(
                                error_chain = crate::foundation::safe_log_field::safe_display(&error::describe(cause.as_ref())),
                                "daemon activation failed"
                            );
                            let _ = socket.send(Message::Close(Some(CloseFrame {
                                code: 1011,
                                reason: "host_activation_failed".into(),
                            }))).await;
                            break;
                        }
                    }

                    match transport.registry.attach(&host_id, &connection_id, ready.clone()) {
                        Ok(true) => {
                            attached = Some(ready.daemon_instance.clone());
                            admission.attached(&host_id);
                            let seed_host = HostId::parse(host_id.clone())
                                .expect("authenticated host ids are validated at lookup");
                            host_ready.attached(&seed_host, &connection_id);
                            status_seed.attached(
                                seed_host,
                                ready.daemon_instance,
                                connection_id.clone(),
                                owner_user_id.clone(),
                                transport.controller().connection_authority(),
                            );
                        }
                        Ok(false) => break,
                        Err(cause) => {
                            tracing::error!(
                                error_chain = crate::foundation::safe_log_field::safe_display(&(error::describe(&cause))),
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
                        error_chain = crate::foundation::safe_log_field::safe_display(&(error::describe(cause.as_ref()))),
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
                awaiting_pong = Some((ts, Instant::now() + transport.config.pong_timeout));
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
                    let offered = offered_ready_protocol_version(&text);
                    if let Some(version) = offered
                        && version != OfferedReadyVersion::Readable(OUTBOUND_PROTOCOL_VERSION)
                    {
                        let actual = match version {
                            OfferedReadyVersion::Readable(value) => value.to_string(),
                            OfferedReadyVersion::Invalid => "invalid".to_owned(),
                        };
                        metrics::counter!(
                            "silverhand_host_ws_protocol_mismatch_total",
                            "actual_version" => actual,
                            "supported_version" => OUTBOUND_PROTOCOL_VERSION.to_string(),
                        ).increment(1);
                    }

                    // Only actionable numeric versions change per-host admission state.
                    if let Some(OfferedReadyVersion::Readable(offered)) = offered
                        && offered != OUTBOUND_PROTOCOL_VERSION
                    {
                        admission.incompatible(
                            &host_id,
                            &connection_id,
                            offered,
                            OUTBOUND_PROTOCOL_VERSION,
                            signed_unix_millis(SystemTime::now()),
                        );
                        let _ = socket.send(Message::Close(Some(CloseFrame {
                            code: 1002,
                            reason: UPDATE_REQUIRED_CLOSE_REASON.into(),
                        }))).await;
                        break;
                    }
                    let decoded = parse_daemon_frame(&text);
                    if !daemon_frame_fits_budget(text.len(), decoded.as_ref().ok(), &pending) {
                        let _ = socket.send(Message::Close(Some(CloseFrame {
                            code: 1009,
                            reason: "frame_too_large".into(),
                        }))).await;
                        break;
                    }
                    match decoded {
                        Ok(DaemonFrame::Ready(ReadyFrame {
                            protocol_version,
                            instance_id,
                            host_descriptor,
                        })) => {
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
                            socket.ready(protocol_version);
                            compatible = Some(ready.clone());
                            let attachment = AttachedHostDataPlane::new(DaemonAttachment {
                                host_id: host_id.clone(),
                                connection_id: connection_id.clone(),
                                daemon_instance: instance,
                                host_name: ready.host_name.clone(),
                                commands: control.clone(),
                            });
                            let hydration = Arc::clone(&hydration);
                            let hydrate_control = control.clone();
                            tokio::spawn(async move {
                                let result = hydration.hydrate(attachment).await.map(|()| ready);
                                let _ = hydrate_control.send(ConnectionControl::Hydrated(result)).await;
                            });
                        }
                        Ok(DaemonFrame::ShuttingDown(frame)) => {
                            tracing::warn!(reason = crate::foundation::safe_log_field::safe_display(&(frame.reason)), "daemon announced shutdown");
                            let _ = socket.send(Message::Close(Some(CloseFrame {
                                code: 1001,
                                reason: "daemon_shutting_down".into(),
                            }))).await;
                            break;
                        }
                        Ok(DaemonFrame::CommandResponse(CommandResponseFrame { id, kind, result, error })) => {
                            let Some(pending_command) = pending.remove(&id) else { continue; };
                            if pending_command.kind.as_wire() != kind {
                                let _ = pending_command.response.send(Err(CommandDispatchError::InvalidResponse));
                                let _ = socket.send(Message::Close(Some(CloseFrame {
                                    code: 1002,
                                    reason: "command_response_kind_mismatch".into(),
                                }))).await;
                                break;
                            }
                            let settled = match (result, error) {
                                (Some(result), None) => Some(Ok(result)),
                                (None, Some(error)) => CommandRefusal::decode(
                                    pending_command.capability_refusal,
                                    &error,
                                ).map(|refusal| Err(CommandDispatchError::DaemonRefused(refusal))),
                                _ => None,
                            };
                            let Some(settled) = settled else {
                                let _ = pending_command.response.send(Err(CommandDispatchError::InvalidResponse));
                                let _ = socket.send(Message::Close(Some(CloseFrame {
                                    code: 1002,
                                    reason: "invalid_command_response".into(),
                                }))).await;
                                break;
                            };
                            let _ = pending_command.response.send(settled);
                        }
                        Ok(DaemonFrame::Runtime { kind, value }) => {
                            let Some(instance) = attached.as_ref() else {
                                let _ = socket.send(Message::Close(Some(CloseFrame {
                                    code: 1008,
                                    reason: "attachment_not_hydrated".into(),
                                }))).await;
                                break;
                            };
                            match runtime_events
                                .handle(&host_id, &connection_id, instance, kind, value)
                                .await
                            {
                                DaemonRuntimeEventDisposition::Continue => {}
                                DaemonRuntimeEventDisposition::Close { code, reason } => {
                                    let _ = socket.send(Message::Close(Some(CloseFrame {
                                        code,
                                        reason: reason.into(),
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
    for (_, pending) in pending {
        let _ = pending.response.send(Err(CommandDispatchError::Ambiguous));
    }
    if let Some(instance) = attached
        .as_ref()
        .or_else(|| compatible.as_ref().map(|ready| &ready.daemon_instance))
    {
        runtime_events.detached(&host_id, instance, &connection_id);
    }
    transport.registry.remove(&host_id, &connection_id);
    runtime_events.release_connection(&connection_id).await;
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

enum DaemonFrame {
    Ready(ReadyFrame),
    ShuttingDown(ShuttingDownFrame),
    HeartbeatPing(HeartbeatPingFrame),
    HeartbeatPong(HeartbeatPongFrame),
    Runtime { kind: String, value: Value },
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OfferedReadyVersion {
    Readable(u32),
    Invalid,
}

/// Inspect the ready envelope before strict schema parsing so old or malformed
/// ready frames remain observable. Invalid versions use one fixed metric bucket;
/// only readable incompatible versions may change per-host admission state.
/// Non-ready frames are outside this observation and return `None`.
fn offered_ready_protocol_version(raw: &str) -> Option<OfferedReadyVersion> {
    let value = serde_json::from_str::<Value>(raw).ok()?;
    if value.get("direction").and_then(Value::as_str) != Some("daemon_to_server")
        || value.get("type").and_then(Value::as_str) != Some("event")
        || value.get("kind").and_then(Value::as_str) != Some("ready")
    {
        return None;
    }
    let version = value
        .get("protocol_version")
        .and_then(Value::as_u64)
        .and_then(|version| u32::try_from(version).ok())
        .filter(|version| *version <= MAX_READABLE_PROTOCOL_VERSION);

    Some(match version {
        Some(version) => OfferedReadyVersion::Readable(version),
        None => OfferedReadyVersion::Invalid,
    })
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
        (Some("event"), Some(kind))
            if OUTBOUND_DAEMON_EVENT_KINDS.contains(&kind)
                && !matches!(kind, "ready" | "shutting_down") =>
        {
            Ok(DaemonFrame::Runtime {
                kind: kind.to_owned(),
                value,
            })
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

/// Large results require a live request on THIS connection, not a claimed wire kind.
fn daemon_frame_fits_budget(
    bytes: usize,
    frame: Option<&DaemonFrame>,
    pending: &HashMap<String, PendingCommand>,
) -> bool {
    if bytes <= MAX_DAEMON_FRAME_BYTES {
        return true;
    }
    if bytes > MAX_WORKSPACE_FILE_FRAME_BYTES {
        return false;
    }
    let Some(DaemonFrame::CommandResponse(response)) = frame else {
        return false;
    };
    response.result.is_some()
        && response.error.is_none()
        && pending.get(&response.id).is_some_and(|command| {
            matches!(
                command.kind,
                IssuedDaemonCommandKind::AgentWorkspaceFileRead
            ) && command.kind.as_wire() == response.kind
                && Instant::now() < command.deadline
        })
}

fn valid_command_response_envelope(value: &Value) -> bool {
    value
        .get("id")
        .and_then(Value::as_str)
        .is_some_and(|id| !id.is_empty())
        && value
            .get("kind")
            .and_then(Value::as_str)
            .and_then(IssuedDaemonCommandKind::from_wire)
            .is_some()
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

fn signed_unix_millis(time: SystemTime) -> i64 {
    match time.duration_since(SystemTime::UNIX_EPOCH) {
        Ok(duration) => i64::try_from(duration.as_millis()).unwrap_or(i64::MAX),
        Err(error) => -i64::try_from(error.duration().as_millis()).unwrap_or(i64::MAX),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn workspace_frame_budget_requires_live_correlated_success_and_complete_envelope() {
        use super::*;
        let (tx, _rx) = oneshot::channel();
        let mut pending = HashMap::from([(
            "read-1".to_owned(),
            PendingCommand {
                kind: IssuedDaemonCommandKind::AgentWorkspaceFileRead,
                capability_refusal: command::rejects_every_capability_refusal,
                response: tx,
                deadline: Instant::now() + Duration::from_secs(30),
            },
        )]);
        let wire = json!({"direction":"daemon_to_server", "type":"command_response", "id":"read-1",
            "kind":"agent_workspace_file_read", "result":{"content":"\u{1}".repeat(512*1024)}})
        .to_string();
        assert!(wire.len() > 3 * 1024 * 1024);
        let frame = parse_daemon_frame(&wire).unwrap();
        assert!(daemon_frame_fits_budget(wire.len(), Some(&frame), &pending));
        assert!(daemon_frame_fits_budget(
            MAX_WORKSPACE_FILE_FRAME_BYTES,
            Some(&frame),
            &pending
        ));
        assert!(!daemon_frame_fits_budget(
            MAX_WORKSPACE_FILE_FRAME_BYTES + 1,
            Some(&frame),
            &pending
        ));
        assert!(!daemon_frame_fits_budget(
            wire.len(),
            Some(&frame),
            &HashMap::new()
        ));
        pending.get_mut("read-1").unwrap().kind = IssuedDaemonCommandKind::HostStatus;
        assert!(!daemon_frame_fits_budget(
            wire.len(),
            Some(&frame),
            &pending
        ));
        pending.get_mut("read-1").unwrap().kind = IssuedDaemonCommandKind::AgentWorkspaceFileRead;
        pending.get_mut("read-1").unwrap().deadline = Instant::now();
        assert!(!daemon_frame_fits_budget(
            wire.len(),
            Some(&frame),
            &pending
        ));
        pending.get_mut("read-1").unwrap().deadline = Instant::now() + Duration::from_secs(30);
        let error = parse_daemon_frame(
            &json!({"direction":"daemon_to_server", "type":"command_response", "id":"read-1",
            "kind":"agent_workspace_file_read", "error":{"code":"internal_error", "message":"x"}})
            .to_string(),
        )
        .unwrap();
        assert!(!daemon_frame_fits_budget(
            MAX_DAEMON_FRAME_BYTES + 1,
            Some(&error),
            &pending
        ));
        assert!(daemon_frame_fits_budget(
            MAX_DAEMON_FRAME_BYTES,
            Some(&error),
            &pending
        ));
        assert!(!daemon_frame_fits_budget(
            MAX_DAEMON_FRAME_BYTES + 1,
            None,
            &pending
        ));
    }

    use std::ops::Range;

    use silverhand_backend_core::{
        conversation_messaging::messaging::{MessageContent, ReferencePositions},
        conversation_messaging::runtime_delivery::{
            ClaimPendingInbox, ClaimedInboxBatch, DeliveryInstruction, DeliveryLeaseOwner,
            InboxDeliveryId, RuntimeDispatchReadPort, RuntimeDispatchTarget,
            RuntimeInboxCustodyPort,
        },
        foundation::identity::{AgentId, ConversationId},
        foundation::persistence::PersistenceFailure,
        host_runtime::runtime_credential::{
            ClaimRuntimeCustody, RuntimeCustodyPort, RuntimeEventTime, RuntimePrincipal,
            RuntimeScope,
        },
        host_runtime::{
            aftermath::DaemonConnectionControl, read::ComputerReadModel,
            rotation::DaemonRotationAck,
        },
    };
    use silverhand_backend_sqlite::{
        conversation_messaging::runtime_delivery::SqliteRuntimeDeliveryStore,
        host_runtime::SqliteHostRuntimeStore,
        host_runtime::runtime_credential::SqliteRuntimeCustodyStore,
    };
    use sqlx::{Connection, SqliteConnection, sqlite::SqliteConnectOptions};

    use crate::{
        application_orchestration::daemon_delivery::DaemonDeliveryRuntime,
        current_schema,
        foundation::scope_event_transport::ScopeEventHub,
        host_runtime::daemon_runtime_transport::{
            DeliveryDisposition, compose_delivery_text, delivery_disposition,
        },
        host_runtime::host_agent_background::agent_deletion_resumer::DeletionFenceBinder,
        host_runtime::host_control::management::disconnect::DaemonConnectionControlHandle,
        host_runtime::host_control::{
            status_seed::DaemonCustody, status_snapshot::StatusSnapshotOutcome,
        },
        host_runtime::runtime_credential::RuntimeCredentialAuthority,
        host_runtime::scope_runtime_stop::ProductionScopeRuntimeStop,
        host_runtime::{
            cascade_effects::{DaemonCascadeEffects, DaemonHostConnections},
            daemon_runtime_codecs::runtime_start as runtime_start_codec,
            rotate_token::{parse_rotation_ack, rotation_params},
        },
    };

    use super::*;

    fn attach_for_command_test(
        registry: &DaemonRegistry,
        host: &HostId,
        instance: DaemonInstanceId,
    ) -> (String, mpsc::Receiver<ConnectionControl>) {
        let (commands, receive) = mpsc::channel(4);
        let (close, _close_receive) = watch::channel(None);
        let connection = registry.reserve(host.as_str(), commands, close).unwrap();
        assert!(
            registry
                .attach(
                    host.as_str(),
                    &connection,
                    AttachedDaemon {
                        daemon_instance: instance,
                        host_name: host.as_str().to_owned(),
                    },
                )
                .unwrap()
        );
        (connection, receive)
    }

    struct ControlledCommandSink {
        entered_first_write: Arc<Notify>,
        release_first_write: Arc<Notify>,
        frames: Arc<Mutex<Vec<Value>>>,
        sends: usize,
    }

    impl CommandWireSink for ControlledCommandSink {
        async fn send(&mut self, message: Message, _deadline: Instant) -> InterruptibleSend {
            self.sends += 1;
            if self.sends == 1 {
                self.entered_first_write.notify_one();
                self.release_first_write.notified().await;
            }
            let Message::Text(frame) = message else {
                panic!("business command sink received a non-text frame");
            };
            self.frames
                .lock()
                .unwrap()
                .push(serde_json::from_str(&frame).unwrap());
            InterruptibleSend::Sent
        }
    }

    #[tokio::test]
    async fn command_metrics_observe_timeout_success_and_disconnection_once() {
        let recorder = metrics_exporter_prometheus::PrometheusBuilder::new()
            .set_buckets(&[0.001, 0.01])
            .unwrap()
            .build_recorder();
        let _guard = metrics::set_default_local_recorder(&recorder);
        let (commands, mut receive) = mpsc::channel(32);
        let attachment = DaemonAttachment {
            host_id: "private-host-id".to_owned(),
            connection_id: "private-connection-id".to_owned(),
            daemon_instance: DaemonInstanceId::parse("instance-test").unwrap(),
            host_name: "private-name".into(),
            commands,
        };
        let encode = || command::host_status(json!({}));
        let timed_out = attachment.command(encode(), Duration::from_millis(5)).await;
        assert!(matches!(timed_out, Err(CommandDispatchError::TimedOut)));
        let _ = receive.recv().await.unwrap();
        let respond = async {
            let ConnectionControl::Command(request) = receive.recv().await.unwrap() else {
                panic!("command expected")
            };
            request.response.send(Ok(json!({"ok":true}))).unwrap();
        };
        let (success, ()) = tokio::join!(
            attachment.command(encode(), Duration::from_secs(1)),
            respond
        );
        assert!(success.is_ok());
        drop(receive);
        assert!(matches!(
            attachment.command(encode(), Duration::from_secs(1)).await,
            Err(CommandDispatchError::ProvenNotDispatched)
        ));
        let text = recorder.handle().render();
        for outcome in ["timeout", "ok", "disconnected"] {
            let line = text
                .lines()
                .find(|line| {
                    line.starts_with("silverhand_daemon_command_duration_seconds_count{")
                        && line.contains(&format!("outcome=\"{outcome}\""))
                })
                .unwrap();
            assert!(line.contains("command=\"host_status\""));
            assert!(line.ends_with(" 1"));
        }
        assert!(!text.contains("private-"));
    }

    #[tokio::test(start_paused = true)]
    async fn production_dequeue_to_wire_gate_drops_a_queued_set_after_its_budget_expires() {
        let (commands, mut receive) = mpsc::channel(32);
        let attachment = DaemonAttachment {
            host_id: "host-1".to_owned(),
            connection_id: "connection-1".to_owned(),
            daemon_instance: DaemonInstanceId::parse("instance-1").unwrap(),
            host_name: "host".to_owned(),
            commands,
        };

        let entered_first_write = Arc::new(Notify::new());
        let release_first_write = Arc::new(Notify::new());
        let frames = Arc::new(Mutex::new(Vec::new()));
        let wire = tokio::spawn({
            let entered_first_write = Arc::clone(&entered_first_write);
            let release_first_write = Arc::clone(&release_first_write);
            let frames = Arc::clone(&frames);
            async move {
                let mut sink = ControlledCommandSink {
                    entered_first_write,
                    release_first_write,
                    frames,
                    sends: 0,
                };
                let mut next_command = 0;
                let mut pending_responses = Vec::new();
                for _ in 0..2 {
                    let command = match receive.recv().await.unwrap() {
                        ConnectionControl::Command(command) => command,
                        ConnectionControl::Hydrated(_) => panic!("expected command"),
                    };
                    match send_dequeued_command(command, &mut next_command, &mut sink).await {
                        DequeuedCommandSend::Skipped => {}
                        DequeuedCommandSend::Sent { response, .. } => {
                            pending_responses.push(response);
                        }
                        DequeuedCommandSend::Terminate | DequeuedCommandSend::Close(_) => {
                            panic!("controlled sink cannot terminate the command loop")
                        }
                    }
                }
                pending_responses
            }
        });

        let first_attachment = attachment.clone();
        let first = tokio::spawn(async move {
            first_attachment
                .command(command::host_status(json!({})), Duration::from_secs(60))
                .await
        });
        entered_first_write.notified().await;

        let second_attachment = attachment.clone();
        let second = tokio::spawn(async move {
            second_attachment
                .command(
                    command::proxy_config_set(json!({ "proxy_url": "http://proxy" })),
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

        // The controlled sink is the socket-write seam used by the same production
        // dequeue function. Once the first write resumes, the late SET is dequeued
        // but must be rejected before this sink can observe it. Removing the
        // production expiry/cancellation branch records a second frame and kills the
        // assertion below.
        release_first_write.notify_one();
        let pending_responses = wire.await.unwrap();
        assert_eq!(pending_responses.len(), 1);
        let frames = frames.lock().unwrap();
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0]["kind"], "host_status");
        first.abort();
    }

    #[tokio::test]
    async fn production_status_adapter_never_re_resolves_captured_custody_by_host_and_instance() {
        let registry = DaemonRegistry::with_process_epoch("test-epoch".to_owned());
        let host = HostId::parse("host-1").unwrap();
        let instance = DaemonInstanceId::parse("instance-1").unwrap();

        let (a_commands, _a_receive) = mpsc::channel(4);
        let (a_close, _a_close_receive) = watch::channel(None);
        let connection_a = registry
            .reserve(host.as_str(), a_commands, a_close)
            .unwrap();
        assert!(
            registry
                .attach(
                    host.as_str(),
                    &connection_a,
                    AttachedDaemon {
                        daemon_instance: instance.clone(),
                        host_name: "host-a".to_owned(),
                    },
                )
                .unwrap()
        );
        let data_plane = OwningHostDataPlane {
            registry: registry.clone(),
        };
        let captured_a = DaemonCustody::attached_custody(&data_plane, &host)
            .unwrap()
            .expect("connection A is attached");
        assert_eq!(captured_a.connection_id, connection_a);

        registry.remove(host.as_str(), &connection_a);
        let (b_commands, mut b_receive) = mpsc::channel(4);
        let (b_close, _b_close_receive) = watch::channel(None);
        let connection_b = registry
            .reserve(host.as_str(), b_commands, b_close)
            .unwrap();
        assert!(
            registry
                .attach(
                    host.as_str(),
                    &connection_b,
                    AttachedDaemon {
                        daemon_instance: instance,
                        host_name: "host-b".to_owned(),
                    },
                )
                .unwrap()
        );

        // This call crosses the production DaemonCustody adapter and the real
        // OwningHostDataPlane pre-send check. An implementation that discards A's
        // connection id and re-resolves by host+same-instance queues host_status on
        // B, then waits for B's answer. Preserve the queue assertion even if the
        // probe times out so that mutation fails on the generation leak itself.
        let outcome = tokio::time::timeout(
            Duration::from_millis(50),
            DaemonCustody::probe_status(&data_plane, host, captured_a),
        )
        .await;
        assert!(matches!(
            b_receive.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty)
        ));
        assert!(matches!(
            outcome.expect("captured A must settle without waiting on B"),
            StatusSnapshotOutcome::Disconnected
        ));
    }

    mod scope_runtime_stop_adapter {
        use std::{io, thread};

        use silverhand_backend_core::{
            foundation::identity::{AgentId, ConversationId, UserId},
            foundation::wire_number::JsSafeInteger,
            host_runtime::scope_runtime_stop::{
                ScopeRuntimeStopOutcome, ScopeRuntimeStopPort, ScopeRuntimeStopRefusal,
                ScopeRuntimeStopTarget,
            },
            host_runtime::{
                computer::{ComputerRecord, HostKind, ProvisioningSource},
                read::ComputerReadModel,
            },
        };

        use crate::host_runtime::daemon_runtime_codecs::runtime_stop::RuntimeStopCommand;
        use crate::host_runtime::scope_runtime_stop::{
            ProductionScopeRuntimeStop, ScopeRuntimeStopFailure, stop_captured,
        };

        use super::*;

        #[derive(Clone)]
        struct StopComputerRead {
            record: Option<ComputerRecord>,
            fails: bool,
        }

        impl ComputerReadModel for StopComputerRead {
            async fn list_for_owner(
                &self,
                _owner: UserId,
            ) -> Result<Vec<ComputerRecord>, PersistenceFailure> {
                unreachable!("exact-host runtime stop never lists computers")
            }

            async fn read_computer(
                &self,
                _computer: HostId,
            ) -> Result<Option<ComputerRecord>, PersistenceFailure> {
                if self.fails {
                    Err(PersistenceFailure::from_source(io::Error::other(
                        "host read failed",
                    )))
                } else {
                    Ok(self.record.clone())
                }
            }
        }

        fn computer(
            id: &str,
            activated_at: Option<i64>,
            finalized_at: Option<i64>,
            revoked_at: Option<i64>,
        ) -> ComputerRecord {
            ComputerRecord {
                id: HostId::parse(id).unwrap(),
                name: id.to_owned(),
                kind: HostKind::Remote,
                created_at: 1,
                owner: Some(UserId::parse("owner-1").unwrap()),
                installation_id: None,
                last_seen_at: None,
                activated_at,
                finalized_at,
                revoked_at,
                provisioning_source: ProvisioningSource::UserInvite,
                display_label: None,
            }
        }

        fn target(host: &str, scope: RuntimeScope, generation: i64) -> ScopeRuntimeStopTarget {
            ScopeRuntimeStopTarget::new(
                HostId::parse(host).unwrap(),
                scope,
                silverhand_backend_core::host_runtime::runtime_credential::RuntimeGeneration::new(
                    generation,
                )
                .unwrap(),
            )
        }

        fn attach(
            registry: &DaemonRegistry,
            host: &HostId,
            instance: DaemonInstanceId,
            capacity: usize,
        ) -> (String, mpsc::Receiver<ConnectionControl>) {
            let (commands, receive) = mpsc::channel(capacity);
            let (close, _close_receive) = watch::channel(None);
            let connection = registry.reserve(host.as_str(), commands, close).unwrap();
            assert!(
                registry
                    .attach(
                        host.as_str(),
                        &connection,
                        AttachedDaemon {
                            daemon_instance: instance,
                            host_name: host.as_str().to_owned(),
                        },
                    )
                    .unwrap()
            );
            (connection, receive)
        }

        fn plane(registry: &DaemonRegistry) -> OwningHostDataPlane {
            OwningHostDataPlane {
                registry: registry.clone(),
            }
        }

        fn adapter(
            record: Option<ComputerRecord>,
            registry: &DaemonRegistry,
        ) -> ProductionScopeRuntimeStop<StopComputerRead> {
            ProductionScopeRuntimeStop::new(
                StopComputerRead {
                    record,
                    fails: false,
                },
                plane(registry),
                Duration::from_secs(10),
            )
        }

        async fn receive_runtime_stop(
            receive: &mut mpsc::Receiver<ConnectionControl>,
        ) -> CommandRequest {
            let ConnectionControl::Command(command) = receive.recv().await.unwrap() else {
                panic!("runtime stop must enter the command FIFO")
            };
            assert_eq!(command.kind, IssuedDaemonCommandKind::RuntimeStop);
            command
        }

        fn success() -> Value {
            json!({ "mode": "hard", "stopped": true, "exit_code": 0 })
        }

        #[tokio::test]
        async fn exact_host_scope_and_generation_reach_only_the_captured_hosts_fifo() {
            let registry = DaemonRegistry::with_process_epoch("test-epoch".to_owned());
            let host_a = HostId::parse("host-a").unwrap();
            let host_b = HostId::parse("host-b").unwrap();
            let instance = DaemonInstanceId::parse("same-instance").unwrap();
            let (_connection_a, mut receive_a) = attach(&registry, &host_a, instance.clone(), 4);
            let (_connection_b, mut receive_b) = attach(&registry, &host_b, instance, 4);
            let stop = adapter(Some(computer("host-a", Some(1), Some(2), None)), &registry);
            let exact = target(
                "host-a",
                RuntimeScope::ConversationSlot {
                    agent: AgentId::parse("agent-a").unwrap(),
                    source: ConversationId::parse("conversation-a").unwrap(),
                },
                17,
            );

            let call = tokio::spawn(async move { stop.hard_stop(&exact).await });
            let command = receive_runtime_stop(&mut receive_a).await;
            assert_eq!(
                command.params,
                json!({
                    "runtime_scope": {
                        "kind": "conversation",
                        "conversation_id": "conversation-a",
                        "agent_id": "agent-a",
                    },
                    "runtime_generation": 17,
                    "mode": "hard",
                })
            );
            assert!(matches!(
                receive_b.try_recv(),
                Err(tokio::sync::mpsc::error::TryRecvError::Empty)
            ));
            command.response.send(Ok(success())).unwrap();
            assert_eq!(call.await.unwrap().unwrap(), Ok(ScopeRuntimeStopOutcome));
        }

        #[tokio::test]
        async fn agent_slot_keeps_max_safe_generation_exact_on_the_wire() {
            let registry = DaemonRegistry::with_process_epoch("test-epoch".to_owned());
            let host = HostId::parse("host-a").unwrap();
            let (_connection, mut receive) = attach(
                &registry,
                &host,
                DaemonInstanceId::parse("instance-a").unwrap(),
                4,
            );
            let stop = adapter(Some(computer("host-a", Some(1), Some(2), None)), &registry);
            let exact = target(
                "host-a",
                RuntimeScope::AgentSlot {
                    agent: AgentId::parse("agent-a").unwrap(),
                },
                JsSafeInteger::MAX,
            );

            let call = tokio::spawn(async move { stop.hard_stop(&exact).await });
            let command = receive_runtime_stop(&mut receive).await;
            assert_eq!(
                command.params,
                json!({
                    "runtime_scope": { "kind": "agent", "agent_id": "agent-a" },
                    "runtime_generation": JsSafeInteger::MAX,
                    "mode": "hard",
                })
            );
            command.response.send(Ok(success())).unwrap();
            assert_eq!(call.await.unwrap().unwrap(), Ok(ScopeRuntimeStopOutcome));
        }

        #[tokio::test]
        async fn production_composition_binds_the_sqlite_host_facts_to_its_own_registry() {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("scope-runtime-stop.sqlite");
            let mut database = crate::current_schema::create_current_schema(&path).await;
            sqlx::query(
                "INSERT INTO users (id, name, display_name, created_at, updated_at)
                 VALUES ('owner-1', 'owner-1', 'Owner', 1, 1)",
            )
            .execute(&mut database)
            .await
            .unwrap();
            sqlx::query(
                "INSERT INTO hosts
                    (id, name, kind, created_at, user_id, activated_at, finalized_at,
                     provisioning_source)
                 VALUES ('host-a', 'host-a', 'remote', 1, 'owner-1', 2, 3, 'user_invite')",
            )
            .execute(&mut database)
            .await
            .unwrap();
            database.close().await.unwrap();

            let event_hub = ScopeEventHub::production().unwrap();
            let runtime = DaemonDeliveryRuntime::new(
                RuntimeCredentialAuthority::production(
                    SqliteRuntimeCustodyStore::open(&path).await.unwrap(),
                ),
                SqliteRuntimeDeliveryStore::open(&path).await.unwrap(),
                SqliteHostRuntimeStore::open(&path).await.unwrap(),
                DaemonDeliveryConfig::production(),
                event_hub.runtime_activity_publisher(),
                event_hub.agent_presence_publisher(),
                event_hub.runtime_status_publisher(),
            )
            .unwrap();
            let host = HostId::parse("host-a").unwrap();
            let (_connection, mut receive) = attach(
                runtime.transport_registry_for_test(),
                &host,
                DaemonInstanceId::parse("instance-a").unwrap(),
                4,
            );
            let stop = runtime.scope_runtime_stop();
            let exact = target(
                "host-a",
                RuntimeScope::AgentSlot {
                    agent: AgentId::parse("agent-a").unwrap(),
                },
                29,
            );

            let call = tokio::spawn(async move { stop.hard_stop(&exact).await });
            let command = receive_runtime_stop(&mut receive).await;
            assert_eq!(command.params["runtime_generation"], 29);
            command.response.send(Ok(success())).unwrap();
            assert_eq!(call.await.unwrap().unwrap(), Ok(ScopeRuntimeStopOutcome));
        }

        #[tokio::test]
        async fn same_instance_successor_cannot_receive_a_stop_captured_for_its_predecessor() {
            let registry = DaemonRegistry::with_process_epoch("test-epoch".to_owned());
            let host = HostId::parse("host-a").unwrap();
            let instance = DaemonInstanceId::parse("instance-shared").unwrap();
            let (connection_a, _receive_a) = attach(&registry, &host, instance.clone(), 4);
            let data_plane = plane(&registry);
            let captured_a = data_plane.resolve(&host).unwrap().unwrap();
            let command = RuntimeStopCommand::encode(
                &RuntimeScope::AgentSlot {
                    agent: AgentId::parse("agent-a").unwrap(),
                },
                silverhand_backend_core::host_runtime::runtime_credential::RuntimeGeneration::new(
                    31,
                )
                .unwrap(),
            )
            .unwrap();

            registry.remove(host.as_str(), &connection_a);
            let (_connection_b, mut receive_b) = attach(&registry, &host, instance, 4);
            let outcome =
                stop_captured(&data_plane, captured_a, command, Duration::from_secs(10)).await;

            assert_eq!(
                outcome.unwrap(),
                Err(ScopeRuntimeStopRefusal::HostAttachPending)
            );
            assert!(matches!(
                receive_b.try_recv(),
                Err(tokio::sync::mpsc::error::TryRecvError::Empty)
            ));
        }

        #[tokio::test]
        async fn persisted_lifecycle_refusals_short_circuit_before_the_registry() {
            let registry = DaemonRegistry::with_process_epoch("test-epoch".to_owned());
            let poisoned = Arc::clone(&registry.state);
            let _ = thread::spawn(move || {
                let _guard = poisoned.lock().unwrap();
                panic!("poison registry for the discriminator");
            })
            .join();
            let exact = target(
                "host-a",
                RuntimeScope::AgentSlot {
                    agent: AgentId::parse("agent-a").unwrap(),
                },
                1,
            );

            for (record, expected) in [
                (None, ScopeRuntimeStopRefusal::HostMissing),
                (
                    Some(computer("host-a", None, None, None)),
                    ScopeRuntimeStopRefusal::HostPendingAttach,
                ),
                (
                    Some(computer("host-a", Some(1), None, None)),
                    ScopeRuntimeStopRefusal::HostPendingAttach,
                ),
                (
                    Some(computer("host-a", Some(1), Some(2), Some(3))),
                    ScopeRuntimeStopRefusal::HostRevoked,
                ),
            ] {
                assert_eq!(
                    adapter(record, &registry).hard_stop(&exact).await.unwrap(),
                    Err(expected)
                );
            }

            assert!(matches!(
                adapter(Some(computer("host-a", Some(1), Some(2), None)), &registry)
                    .hard_stop(&exact)
                    .await,
                Err(ScopeRuntimeStopFailure::RegistryUnavailable)
            ));
        }

        #[tokio::test]
        async fn active_without_attachment_is_the_only_live_placement_refusal() {
            let registry = DaemonRegistry::with_process_epoch("test-epoch".to_owned());
            let exact = target(
                "host-a",
                RuntimeScope::AgentSlot {
                    agent: AgentId::parse("agent-a").unwrap(),
                },
                1,
            );
            assert_eq!(
                adapter(Some(computer("host-a", Some(1), Some(2), None)), &registry)
                    .hard_stop(&exact)
                    .await
                    .unwrap(),
                Err(ScopeRuntimeStopRefusal::HostAttachPending)
            );
        }

        #[tokio::test]
        async fn zero_and_max_safe_plus_one_fail_before_registry_and_fifo() {
            let registry = DaemonRegistry::with_process_epoch("test-epoch".to_owned());
            let host = HostId::parse("host-a").unwrap();
            let (_connection, mut receive) = attach(
                &registry,
                &host,
                DaemonInstanceId::parse("instance-a").unwrap(),
                4,
            );
            let poisoned = Arc::clone(&registry.state);
            let _ = thread::spawn(move || {
                let _guard = poisoned.lock().unwrap();
                panic!("poison registry after attachment for the generation discriminator");
            })
            .join();

            for generation in [0, JsSafeInteger::MAX + 1] {
                let exact = target(
                    "host-a",
                    RuntimeScope::AgentSlot {
                        agent: AgentId::parse("agent-a").unwrap(),
                    },
                    generation,
                );
                assert!(matches!(
                    adapter(
                        Some(computer("host-a", Some(1), Some(2), None)),
                        &registry
                    )
                    .hard_stop(&exact)
                    .await,
                    Err(ScopeRuntimeStopFailure::GenerationOutOfWireRange {
                        generation: actual
                    }) if actual == generation
                ));
                assert!(matches!(
                    receive.try_recv(),
                    Err(tokio::sync::mpsc::error::TryRecvError::Empty)
                ));
            }
        }

        #[tokio::test]
        async fn returned_host_facts_are_bound_to_the_requested_host_before_dispatch() {
            let registry = DaemonRegistry::with_process_epoch("test-epoch".to_owned());
            let host = HostId::parse("host-a").unwrap();
            let (_connection, mut receive) = attach(
                &registry,
                &host,
                DaemonInstanceId::parse("instance-a").unwrap(),
                4,
            );
            let exact = target(
                "host-a",
                RuntimeScope::AgentSlot {
                    agent: AgentId::parse("agent-a").unwrap(),
                },
                1,
            );
            let outcome = adapter(Some(computer("host-b", Some(1), Some(2), None)), &registry)
                .hard_stop(&exact)
                .await;

            assert!(matches!(
                outcome,
                Err(ScopeRuntimeStopFailure::HostFactsMismatch { expected, actual })
                    if expected.as_str() == "host-a" && actual.as_str() == "host-b"
            ));
            assert!(matches!(
                receive.try_recv(),
                Err(tokio::sync::mpsc::error::TryRecvError::Empty)
            ));
        }

        #[tokio::test]
        async fn queue_saturation_is_a_hard_not_dispatched_failure() {
            let registry = DaemonRegistry::with_process_epoch("test-epoch".to_owned());
            let host = HostId::parse("host-a").unwrap();
            let (_connection, _receive) = attach(
                &registry,
                &host,
                DaemonInstanceId::parse("instance-a").unwrap(),
                1,
            );
            let attachment = registry.attachment(host.as_str()).unwrap().unwrap();
            let (response, _receive_response) = oneshot::channel();
            attachment
                .commands
                .try_send(ConnectionControl::Command(CommandRequest {
                    kind: IssuedDaemonCommandKind::HostStatus,
                    params: json!({}),
                    capability_refusal: command::rejects_every_capability_refusal,
                    deadline: Instant::now() + Duration::from_secs(60),
                    response,
                }))
                .unwrap();
            let exact = target(
                "host-a",
                RuntimeScope::AgentSlot {
                    agent: AgentId::parse("agent-a").unwrap(),
                },
                1,
            );

            assert!(matches!(
                adapter(Some(computer("host-a", Some(1), Some(2), None)), &registry)
                    .hard_stop(&exact)
                    .await,
                Err(ScopeRuntimeStopFailure::NotDispatched)
            ));
        }

        #[tokio::test]
        async fn daemon_refusal_ambiguous_completion_and_bad_response_are_hard_faults() {
            #[derive(Clone, Copy)]
            enum Answer {
                Refused,
                Drop,
                Invalid,
            }

            for (suffix, answer) in [
                ("refused", Answer::Refused),
                ("drop", Answer::Drop),
                ("invalid", Answer::Invalid),
            ] {
                let registry = DaemonRegistry::with_process_epoch(format!("test-epoch-{suffix}"));
                let host = HostId::parse(format!("host-{suffix}")).unwrap();
                let (_connection, mut receive) = attach(
                    &registry,
                    &host,
                    DaemonInstanceId::parse(format!("instance-{suffix}")).unwrap(),
                    4,
                );
                let stop = adapter(
                    Some(computer(host.as_str(), Some(1), Some(2), None)),
                    &registry,
                );
                let exact = target(
                    host.as_str(),
                    RuntimeScope::AgentSlot {
                        agent: AgentId::parse("agent-a").unwrap(),
                    },
                    1,
                );
                let call = tokio::spawn(async move { stop.hard_stop(&exact).await });
                let command = receive_runtime_stop(&mut receive).await;
                match answer {
                    Answer::Refused => command
                        .response
                        .send(Err(CommandDispatchError::DaemonRefused(
                            CommandRefusal::Response(DaemonRefusalCode::ShuttingDown),
                        )))
                        .unwrap(),
                    Answer::Drop => drop(command.response),
                    Answer::Invalid => command
                        .response
                        .send(Ok(json!({
                            "mode": "hard",
                            "stopped": true,
                            "exit_code": 0,
                            "extra": true,
                        })))
                        .unwrap(),
                }
                let outcome = call.await.unwrap();
                assert!(matches!(
                    (answer, outcome),
                    (Answer::Refused, Err(ScopeRuntimeStopFailure::DaemonRefused))
                        | (Answer::Drop, Err(ScopeRuntimeStopFailure::Ambiguous))
                        | (
                            Answer::Invalid,
                            Err(ScopeRuntimeStopFailure::ProtocolCorruption)
                        )
                ));
            }
        }

        #[tokio::test(start_paused = true)]
        async fn timeout_is_a_hard_fault_not_a_placement_refusal() {
            let registry = DaemonRegistry::with_process_epoch("test-epoch".to_owned());
            let host = HostId::parse("host-a").unwrap();
            let (_connection, mut receive) = attach(
                &registry,
                &host,
                DaemonInstanceId::parse("instance-a").unwrap(),
                4,
            );
            let stop = ProductionScopeRuntimeStop::new(
                StopComputerRead {
                    record: Some(computer("host-a", Some(1), Some(2), None)),
                    fails: false,
                },
                plane(&registry),
                Duration::from_secs(5),
            );
            let exact = target(
                "host-a",
                RuntimeScope::AgentSlot {
                    agent: AgentId::parse("agent-a").unwrap(),
                },
                1,
            );
            let call = tokio::spawn(async move { stop.hard_stop(&exact).await });
            let _held_response = receive_runtime_stop(&mut receive).await.response;
            tokio::time::advance(Duration::from_secs(5)).await;

            assert!(matches!(
                call.await.unwrap(),
                Err(ScopeRuntimeStopFailure::TimedOut)
            ));
        }
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
                kind: IssuedDaemonCommandKind::HostStatus,
                params: json!({}),
                capability_refusal: command::rejects_every_capability_refusal,
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
        let control = DaemonConnectionControlHandle::new(DaemonConnectionAuthority {
            registry: registry.clone(),
        });
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
                reason: "host_revoked",
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
            conversation_messaging::messaging::{
                collaboration::{
                    channel_directory::{ChannelStatus, ChannelVisibility, DirectoryRoster},
                    channel_lifecycle::{
                        ChannelDetailFact, ChannelDetailReadPort, ChannelDetailRefusal,
                        ChannelLifecycleRow,
                    },
                },
                conversation_title::CanonicalConversationTitle,
            },
            foundation::identity::{
                AgentId, ConversationId, DaemonInstanceId, UserId, WorkspaceId,
            },
            host_runtime::runtime_credential::{
                RuntimeCustody, RuntimeGeneration, RuntimePrincipal, RuntimeScope,
            },
            identity_access::access::WorkspaceRole,
        };
        use silverhand_backend_sqlite::{
            conversation_messaging::runtime_delivery::SqliteRuntimeDeliveryStore,
            host_runtime::SqliteHostRuntimeStore,
            host_runtime::runtime_credential::SqliteRuntimeCustodyStore,
        };
        use sqlx::Connection;
        use tower::ServiceExt;

        use crate::{
            application_orchestration::daemon_delivery::{
                DaemonDeliveryConfig, DaemonDeliveryRuntime,
            },
            current_schema,
            foundation::scope_event_transport::ScopeEventHub,
            host_runtime::runtime_credential::RuntimeCredentialAuthority,
            host_runtime::runtime_event_settlement::{
                AgentRunStateWire, AgentRunStatus, HydratedRuntime,
            },
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
        /// owner (`RuntimeEventSettlement::new`), so two calls against the same
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
            let event_hub = ScopeEventHub::production().unwrap();
            DaemonDeliveryRuntime::new(
                RuntimeCredentialAuthority::production(custody),
                data,
                hosts,
                DaemonDeliveryConfig::production(),
                event_hub.runtime_activity_publisher(),
                event_hub.agent_presence_publisher(),
                event_hub.runtime_status_publisher(),
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
                .hydrate_run_states_for_test(
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

    fn daemon_ingress_is_valid(raw: &str) -> bool {
        match parse_daemon_frame(raw) {
            Ok(DaemonFrame::Runtime { kind, value }) => {
                crate::host_runtime::daemon_runtime_owner::runtime_inbound_is_valid_for_test(
                    &kind, &value,
                )
            }
            Ok(_) => true,
            Err(_) => false,
        }
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
            Some(OfferedReadyVersion::Readable(OUTBOUND_PROTOCOL_VERSION - 1))
        );

        // Our own version is the strict schema's business, not this probe's.
        assert_eq!(
            offered_ready_protocol_version(&ready().to_string()),
            Some(OfferedReadyVersion::Readable(OUTBOUND_PROTOCOL_VERSION))
        );

        // Out-of-range versions remain observable as invalid without admission state.
        let mut unreadable = ready();
        unreadable["protocol_version"] = json!(MAX_READABLE_PROTOCOL_VERSION + 1);
        assert_eq!(
            offered_ready_protocol_version(&unreadable.to_string()),
            Some(OfferedReadyVersion::Invalid)
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
                Some(OfferedReadyVersion::Invalid),
                "{unreadable_version} is not a readable protocol version"
            );
        }

        let mut absent = ready();
        absent.as_object_mut().unwrap().remove("protocol_version");
        assert_eq!(
            offered_ready_protocol_version(&absent.to_string()),
            Some(OfferedReadyVersion::Invalid)
        );

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
        for admission in [
            command::rejects_every_capability_refusal as CapabilityRefusalAdmission,
            crate::host_runtime::runtime_control::admits_runtime_refusal,
            crate::host_runtime::agent_materialize::admits_agent_materialize_refusal,
            crate::identity_access::agent_profile_mcp_data_plane::admits_profile_mcp_read_refusal,
            crate::identity_access::agent_profile_mcp_data_plane::admits_profile_mcp_write_refusal,
            crate::identity_access::agent_profile_mcp_data_plane::admits_mcp_probe_refusal,
            crate::workspace_data_plane::admits_workspace_fs_refusal,
            crate::host_runtime::cascade_effects::admits_agent_files_purge_refusal,
        ] {
            assert_eq!(
                CommandRefusal::decode(admission, &error("shutting_down")),
                Some(CommandRefusal::Response(DaemonRefusalCode::ShuttingDown))
            );
            assert_eq!(CommandRefusal::decode(admission, &error("banana")), None);
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
            .filter_map(|code| CommandRefusal::decode(
                command::rejects_every_capability_refusal,
                &error(code),
            ))
            .count(),
            5
        );
        for code in [
            "agent_deleting",
            "workspace_not_provisioned",
            "workspace_bundle_missing",
            "registry_unavailable",
        ] {
            assert!(
                CommandRefusal::decode(
                    crate::host_runtime::runtime_control::admits_runtime_refusal,
                    &error(code),
                )
                .is_some()
            );
            assert_eq!(
                CommandRefusal::decode(command::rejects_every_capability_refusal, &error(code)),
                None
            );
        }
        assert!(matches!(
            CommandRefusal::decode(
                crate::identity_access::agent_profile_mcp_data_plane::admits_profile_mcp_read_refusal,
                &error("fs_unavailable"),
            ),
            Some(CommandRefusal::Capability(_))
        ));
        assert_eq!(
            CommandRefusal::decode(
                crate::identity_access::agent_profile_mcp_data_plane::admits_profile_mcp_read_refusal,
                &error("agent_deleting"),
            ),
            None
        );
        for (admission, code) in [
            (
                crate::identity_access::agent_profile_mcp_data_plane::admits_profile_mcp_write_refusal
                    as CapabilityRefusalAdmission,
                "invalid_config",
            ),
            (
                crate::identity_access::agent_profile_mcp_data_plane::admits_profile_mcp_write_refusal,
                "agent_deleting",
            ),
            (
                crate::identity_access::agent_profile_mcp_data_plane::admits_mcp_probe_refusal,
                "agent_deleting",
            ),
            (
                crate::identity_access::agent_profile_mcp_data_plane::admits_mcp_probe_refusal,
                "fs_unavailable",
            ),
        ] {
            assert!(matches!(
                CommandRefusal::decode(admission, &error(code)),
                Some(CommandRefusal::Capability(_))
            ));
        }
        assert_eq!(
            CommandRefusal::decode(
                crate::identity_access::agent_profile_mcp_data_plane::admits_mcp_probe_refusal,
                &error("invalid_config"),
            ),
            None
        );
        for code in [
            "agent_deleting",
            "fs_quota_exceeded",
            "fs_unavailable",
            "agent_dir_collision",
            "unsupported_template",
            "unsupported_runtime",
        ] {
            assert!(matches!(
                CommandRefusal::decode(
                    crate::host_runtime::agent_materialize::admits_agent_materialize_refusal,
                    &error(code),
                ),
                Some(CommandRefusal::Capability(_))
            ));
            assert_eq!(
                CommandRefusal::decode(command::rejects_every_capability_refusal, &error(code)),
                None
            );
        }
        assert_eq!(
            CommandRefusal::decode(
                crate::host_runtime::runtime_control::admits_runtime_refusal,
                &json!({ "code": "internal_error" }),
            ),
            None
        );
        assert_eq!(
            CommandRefusal::decode(
                crate::host_runtime::runtime_control::admits_runtime_refusal,
                &json!({ "code": "internal_error", "message": 7 })
            ),
            None
        );
        assert_eq!(
            CommandRefusal::decode(
                crate::host_runtime::runtime_control::admits_runtime_refusal,
                &json!({ "code": "internal_error", "message": "why", "extra": true })
            ),
            None
        );
        assert_eq!(
            CommandRefusal::decode(
                crate::host_runtime::runtime_control::admits_runtime_refusal,
                &json!("why"),
            ),
            None
        );
    }

    #[test]
    fn refusal_matrix_is_exact_for_all_eighteen_issued_kinds() {
        use std::collections::BTreeSet;

        let empty: &[&str] = &[];
        let matrix: [(IssuedDaemonCommandKind, CapabilityRefusalAdmission, &[&str]); 18] = [
            (
                IssuedDaemonCommandKind::AgentFilesPurge,
                crate::host_runtime::cascade_effects::admits_agent_files_purge_refusal,
                &crate::host_runtime::cascade_effects::AGENT_FILES_PURGE_CAPABILITY_CODES,
            ),
            (
                IssuedDaemonCommandKind::AgentMaterialize,
                crate::host_runtime::agent_materialize::admits_agent_materialize_refusal,
                &crate::host_runtime::agent_materialize::AGENT_MATERIALIZE_CAPABILITY_CODES,
            ),
            (
                IssuedDaemonCommandKind::AgentProfileMcpRead,
                crate::identity_access::agent_profile_mcp_data_plane::admits_profile_mcp_read_refusal,
                &crate::identity_access::agent_profile_mcp_data_plane::PROFILE_MCP_READ_CAPABILITY_CODES,
            ),
            (
                IssuedDaemonCommandKind::AgentProfileMcpWrite,
                crate::identity_access::agent_profile_mcp_data_plane::admits_profile_mcp_write_refusal,
                &crate::identity_access::agent_profile_mcp_data_plane::PROFILE_MCP_WRITE_CAPABILITY_CODES,
            ),
            (
                // The agent-workspace-index dispatch (#2341 list-workspaces daemon
                // probe) admits the `registry_unavailable` capability refusal (#7);
                // any other code stays foreign and fails closed.
                IssuedDaemonCommandKind::AgentWorkspaceIndex,
                crate::identity_access::agent_workspace_index_probe::admits_agent_workspace_index_refusal,
                &crate::identity_access::agent_workspace_index_probe::AGENT_WORKSPACE_INDEX_CAPABILITY_CODES,
            ),
            (
                IssuedDaemonCommandKind::AgentWorkspaceFileRead,
                crate::workspace_data_plane::admits_workspace_fs_refusal,
                &crate::workspace_data_plane::WORKSPACE_FS_CAPABILITY_CODES,
            ),
            (
                IssuedDaemonCommandKind::AgentWorkspaceTree,
                crate::workspace_data_plane::admits_workspace_fs_refusal,
                &crate::workspace_data_plane::WORKSPACE_FS_CAPABILITY_CODES,
            ),
            (
                IssuedDaemonCommandKind::HostStatus,
                command::rejects_every_capability_refusal,
                empty,
            ),
            (
                IssuedDaemonCommandKind::McpProbe,
                crate::identity_access::agent_profile_mcp_data_plane::admits_mcp_probe_refusal,
                &crate::identity_access::agent_profile_mcp_data_plane::MCP_PROBE_CAPABILITY_CODES,
            ),
            (
                IssuedDaemonCommandKind::ProxyConfigGet,
                command::rejects_every_capability_refusal,
                empty,
            ),
            (
                IssuedDaemonCommandKind::ProxyConfigSet,
                command::rejects_every_capability_refusal,
                empty,
            ),
            (
                IssuedDaemonCommandKind::RotateToken,
                command::rejects_every_capability_refusal,
                empty,
            ),
            (
                IssuedDaemonCommandKind::RuntimeCatalog,
                command::rejects_every_capability_refusal,
                empty,
            ),
            (
                IssuedDaemonCommandKind::RuntimeClearSession,
                command::rejects_every_capability_refusal,
                empty,
            ),
            (
                IssuedDaemonCommandKind::RuntimeDeliver,
                crate::host_runtime::runtime_control::admits_runtime_refusal,
                &crate::host_runtime::runtime_control::RUNTIME_CAPABILITY_CODES,
            ),
            (
                IssuedDaemonCommandKind::RuntimeStart,
                crate::host_runtime::runtime_control::admits_runtime_refusal,
                &crate::host_runtime::runtime_control::RUNTIME_CAPABILITY_CODES,
            ),
            (
                IssuedDaemonCommandKind::RuntimeStatus,
                command::rejects_every_capability_refusal,
                empty,
            ),
            (
                IssuedDaemonCommandKind::RuntimeStop,
                command::rejects_every_capability_refusal,
                empty,
            ),
        ];
        assert_eq!(
            matrix
                .iter()
                .map(|(kind, _, _)| *kind)
                .collect::<BTreeSet<_>>(),
            IssuedDaemonCommandKind::ALL.into_iter().collect(),
        );

        let capability_universe: BTreeSet<&str> = matrix
            .iter()
            .flat_map(|(_, _, codes)| codes.iter().copied())
            .collect();
        let error = |code: &str| json!({ "code": code, "message": "why" });
        for (kind, admission, expected_codes) in matrix {
            for generic in DaemonRefusalCode::ALL_WIRE {
                assert!(matches!(
                    CommandRefusal::decode(admission, &error(generic)),
                    Some(CommandRefusal::Response(_))
                ));
            }
            let actual: BTreeSet<&str> = capability_universe
                .iter()
                .copied()
                .filter(|code| {
                    matches!(
                        CommandRefusal::decode(admission, &error(code)),
                        Some(CommandRefusal::Capability(_))
                    )
                })
                .collect();
            assert_eq!(
                actual,
                expected_codes.iter().copied().collect(),
                "capability refusal matrix drifted for {}",
                kind.as_wire(),
            );
        }
    }

    #[test]
    fn runtime_stop_refusal_vocabulary_stays_on_the_hard_fault_side() {
        let error = |code: &str| json!({ "code": code, "message": "why" });
        let response = CommandRefusal::decode(
            command::rejects_every_capability_refusal,
            &error("shutting_down"),
        )
        .expect("response-level refusal is admitted for runtime_stop");
        assert!(matches!(
            HostDataPlaneFailure::from_dispatch(CommandDispatchError::DaemonRefused(response)),
            HostDataPlaneFailure::Refused(CommandRefusal::Response(
                DaemonRefusalCode::ShuttingDown,
            ))
        ));

        // runtime_stop has no operation-scoped refusal arm. The real connection
        // loop turns this failed decode into InvalidResponse; the shared data plane
        // then preserves it as protocol corruption, never a placement refusal.
        assert_eq!(
            CommandRefusal::decode(
                command::rejects_every_capability_refusal,
                &error("agent_deleting"),
            ),
            None
        );
        assert!(matches!(
            HostDataPlaneFailure::from_dispatch(CommandDispatchError::InvalidResponse),
            HostDataPlaneFailure::ProtocolCorruption
        ));
    }

    #[test]
    fn the_workspace_fs_family_admits_its_four_codes_on_both_reads_and_nothing_else() {
        let error = |code: &str| json!({ "code": code, "message": "why" });
        // Both wire kinds share ONE fault vocabulary, so each admits all four codes.
        for _kind in ["agent_workspace_tree", "agent_workspace_file_read"] {
            for code in [
                "fs_unavailable",
                "registry_unavailable",
                "forbidden_path",
                "not_found",
            ] {
                assert!(
                    matches!(
                        CommandRefusal::decode(
                            crate::workspace_data_plane::admits_workspace_fs_refusal,
                            &error(code),
                        ),
                        Some(CommandRefusal::Capability(_))
                    ),
                    "workspace reads must admit {code}"
                );
            }
            // A code from a sibling family is not this family's language.
            assert_eq!(
                CommandRefusal::decode(
                    crate::workspace_data_plane::admits_workspace_fs_refusal,
                    &error("agent_deleting"),
                ),
                None
            );
            assert_eq!(
                CommandRefusal::decode(
                    crate::workspace_data_plane::admits_workspace_fs_refusal,
                    &error("invalid_config"),
                ),
                None
            );
        }
        // A response-level code still outranks the operation vocabulary, and a
        // workspace-fs code offered to a kind that does not speak it is not admitted.
        assert!(matches!(
            CommandRefusal::decode(
                crate::workspace_data_plane::admits_workspace_fs_refusal,
                &error("internal_error"),
            ),
            Some(CommandRefusal::Response(DaemonRefusalCode::InternalError))
        ));
        assert_eq!(
            CommandRefusal::decode(
                crate::host_runtime::runtime_control::admits_runtime_refusal,
                &error("forbidden_path"),
            ),
            None
        );
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
    fn every_issued_word_is_admitted_on_the_response_epoch() {
        for kind in IssuedDaemonCommandKind::ALL {
            let wire = kind.as_wire();
            assert_eq!(IssuedDaemonCommandKind::from_wire(wire), Some(kind));
            assert!(valid_command_response_envelope(&json!({
                "id": "r1",
                "kind": wire,
                "result": { "ok": true },
            })));
        }
    }

    #[tokio::test]
    async fn materialize_command_stays_on_its_captured_host_and_connection_generation() {
        use silverhand_backend_core::{
            foundation::identity::WorkspaceId,
            host_runtime::agent_materialize::{
                AgentMaterializePort, AgentMaterializeTarget, AgentMaterializeTemplate,
            },
            identity_access::agents::runtime::RuntimeKind,
        };

        let registry = DaemonRegistry::with_process_epoch("materialize-test".to_owned());
        let host_a = HostId::parse("host-a").unwrap();
        let host_b = HostId::parse("host-b").unwrap();
        let instance = DaemonInstanceId::parse("same-instance").unwrap();
        let (connection_a, mut receive_a) =
            attach_for_command_test(&registry, &host_a, instance.clone());
        let (_connection_b, mut receive_b) =
            attach_for_command_test(&registry, &host_b, instance.clone());
        let plane = OwningHostDataPlane {
            registry: registry.clone(),
        };
        let adapter = crate::host_runtime::agent_materialize::ProductionAgentMaterialize::new(
            plane.clone(),
            Duration::from_secs(10),
        );
        let target = AgentMaterializeTarget::reserved(
            host_a.clone(),
            AgentId::parse("agent-a").unwrap(),
            WorkspaceId::parse("wsah_agent-a").unwrap(),
            "Agent A".to_owned(),
            RuntimeKind::Codex,
            None,
            None,
            AgentMaterializeTemplate::Default,
        );
        let call_target = target.clone();
        let captured = adapter
            .capture(&host_a)
            .await
            .unwrap()
            .expect("host A is attached at capture time");
        let call = tokio::spawn(async move { adapter.materialize(captured, &call_target).await });
        let ConnectionControl::Command(command) = receive_a.recv().await.unwrap() else {
            panic!("materialize must enter host A FIFO")
        };
        assert_eq!(command.kind, IssuedDaemonCommandKind::AgentMaterialize);
        assert_eq!(command.params["agent_id"], "agent-a");
        assert!(matches!(
            receive_b.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty)
        ));
        command
            .response
            .send(Ok(json!({
                "ok":true,"agent_dir":"/agent-a",
                "agent_home_workspace_path":"/agent-a","materialized_at":1
            })))
            .unwrap();
        assert!(call.await.unwrap().unwrap().is_ok());

        let captured_a = plane.resolve(&host_a).unwrap().unwrap();
        registry.remove(host_a.as_str(), &connection_a);
        let (_successor_connection, mut successor_receive) =
            attach_for_command_test(&registry, &host_a, instance);
        let params =
            crate::application_orchestration::daemon_materialize_codec::encode(&target).unwrap();
        assert!(matches!(
            crate::host_runtime::agent_materialize::materialize_captured(
                &plane,
                captured_a,
                params,
                Duration::from_secs(10),
            )
            .await
            .unwrap(),
            Err(silverhand_backend_core::host_runtime::agent_materialize::AgentMaterializeRefusal::HostAttachPending)
        ));
        assert!(matches!(
            successor_receive.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty)
        ));
    }

    #[derive(Clone)]
    struct McpPlacementRead {
        fact: Option<
            silverhand_backend_core::identity_access::agent_profile_mcp::AgentProfileMcpPlacement,
        >,
    }

    impl silverhand_backend_core::identity_access::agent_profile_mcp::AgentProfileMcpPlacementRead
        for McpPlacementRead
    {
        async fn read_mcp_placement(
            &self,
            _agent: &AgentId,
        ) -> Result<
            Option<silverhand_backend_core::identity_access::agent_profile_mcp::AgentProfileMcpPlacement>,
            PersistenceFailure,
        >{
            Ok(self.fact.clone())
        }
    }

    fn mcp_placement(
        source: &str,
        host: &str,
        deletion_pending: bool,
    ) -> silverhand_backend_core::identity_access::agent_profile_mcp::AgentProfileMcpPlacement {
        silverhand_backend_core::identity_access::agent_profile_mcp::AgentProfileMcpPlacement::new(
            AgentId::parse(source).unwrap(),
            HostId::parse(host).unwrap(),
            deletion_pending,
        )
    }

    #[tokio::test]
    async fn profile_mcp_commands_are_typed_host_bound_and_generation_bound() {
        use silverhand_backend_core::identity_access::agent_profile_mcp::{
            AgentProfileMcpDataPlane, McpProbeCommand, McpProbePhase,
        };

        let registry = DaemonRegistry::with_process_epoch("profile-mcp-test".to_owned());
        let host_a = HostId::parse("host-a").unwrap();
        let host_b = HostId::parse("host-b").unwrap();
        let instance = DaemonInstanceId::parse("same-instance").unwrap();
        let (connection_a, mut receive_a) =
            attach_for_command_test(&registry, &host_a, instance.clone());
        let (_connection_b, mut receive_b) =
            attach_for_command_test(&registry, &host_b, instance.clone());
        let plane = OwningHostDataPlane {
            registry: registry.clone(),
        };
        let adapter = crate::identity_access::agent_profile_mcp_data_plane::ProductionAgentProfileMcpDataPlane::new(
            McpPlacementRead {
                fact: Some(mcp_placement("agent-a", "host-a", false)),
            },
            plane.clone(),
        );
        let agent = AgentId::parse("agent-a").unwrap();

        let read_adapter = adapter.clone();
        let read_agent = agent.clone();
        let read = tokio::spawn(async move { read_adapter.read_config(&read_agent).await });
        let ConnectionControl::Command(command) = receive_a.recv().await.unwrap() else {
            panic!("MCP read must enter host A FIFO")
        };
        assert_eq!(command.kind, IssuedDaemonCommandKind::AgentProfileMcpRead);
        assert_eq!(command.params, json!({ "agent_id": "agent-a" }));
        assert!(matches!(
            receive_b.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty)
        ));
        command
            .response
            .send(Ok(json!({ "ok": true, "raw": null })))
            .unwrap();
        assert_eq!(read.await.unwrap().unwrap(), None);

        let raw = "{\n  \"mcpServers\": {\"sky😀\": {\"command\": \"x\"}}\n}\n";
        let write_adapter = adapter.clone();
        let write_agent = agent.clone();
        let write_raw = raw.to_owned();
        let write =
            tokio::spawn(async move { write_adapter.write_config(&write_agent, &write_raw).await });
        let ConnectionControl::Command(command) = receive_a.recv().await.unwrap() else {
            panic!("MCP write must enter host A FIFO")
        };
        assert_eq!(command.kind, IssuedDaemonCommandKind::AgentProfileMcpWrite);
        assert_eq!(command.params["agent_id"], "agent-a");
        assert_eq!(command.params["raw"].as_str(), Some(raw));
        command
            .response
            .send(Ok(json!({ "ok": true, "bytes_written": 61 })))
            .unwrap();
        assert_eq!(write.await.unwrap().unwrap().get(), 61);

        let probe_adapter = adapter.clone();
        let probe_agent = agent.clone();
        let probe = tokio::spawn(async move {
            probe_adapter
                .probe(
                    &probe_agent,
                    &McpProbeCommand {
                        server_name: "sky".to_owned(),
                        include_tools: true,
                    },
                )
                .await
        });
        let ConnectionControl::Command(command) = receive_a.recv().await.unwrap() else {
            panic!("MCP probe must enter host A FIFO")
        };
        assert_eq!(command.kind, IssuedDaemonCommandKind::McpProbe);
        assert_eq!(
            command.params,
            json!({
                "source": { "kind": "profile", "agent_id": "agent-a" },
                "server_name": "sky",
                "include_tools": true,
            })
        );
        command
            .response
            .send(Ok(json!({
                "ok": false,
                "phase": "connect",
                "message": "connection failed"
            })))
            .unwrap();
        let outcome = probe.await.unwrap().unwrap();
        assert!(!outcome.ok);
        assert_eq!(outcome.phase, McpProbePhase::Connect);

        // Admission captured A. A same-instance successor has a different
        // connection generation and must receive none of the old attempt.
        let captured_a = plane.resolve(&host_a).unwrap().unwrap();
        registry.remove(host_a.as_str(), &connection_a);
        let (_successor, mut successor_receive) =
            attach_for_command_test(&registry, &host_a, instance);
        let failure = crate::identity_access::agent_profile_mcp_data_plane::read_captured(
            &plane,
            captured_a,
            &agent,
            Duration::from_secs(10),
        )
        .await
        .unwrap_err();
        assert_eq!(
            failure.code,
            silverhand_backend_core::identity_access::agent_profile_mcp::McpDataPlaneFaultCode::HostAttachPending
        );
        assert!(matches!(
            successor_receive.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty)
        ));
    }

    #[tokio::test]
    async fn profile_mcp_write_decoder_closes_every_unsafe_byte_count() {
        use silverhand_backend_core::{
            foundation::wire_number::JsSafeInteger,
            identity_access::agent_profile_mcp::{AgentProfileMcpDataPlane, McpDataPlaneFaultCode},
        };

        let registry = DaemonRegistry::with_process_epoch("profile-mcp-number".to_owned());
        let host = HostId::parse("host-a").unwrap();
        let (_connection, mut receive) = attach_for_command_test(
            &registry,
            &host,
            DaemonInstanceId::parse("instance-a").unwrap(),
        );
        let adapter = crate::identity_access::agent_profile_mcp_data_plane::ProductionAgentProfileMcpDataPlane::new(
            McpPlacementRead {
                fact: Some(mcp_placement("agent-a", "host-a", false)),
            },
            OwningHostDataPlane { registry },
        );
        let agent = AgentId::parse("agent-a").unwrap();

        for unsafe_count in [json!(-1), json!(1.5), json!(JsSafeInteger::MAX + 1)] {
            let call_adapter = adapter.clone();
            let call_agent = agent.clone();
            let call =
                tokio::spawn(async move { call_adapter.write_config(&call_agent, "{}").await });
            let ConnectionControl::Command(command) = receive.recv().await.unwrap() else {
                panic!("write must enter FIFO")
            };
            command
                .response
                .send(Ok(json!({ "ok": true, "bytes_written": unsafe_count })))
                .unwrap();
            assert_eq!(
                call.await.unwrap().unwrap_err().code,
                McpDataPlaneFaultCode::DaemonInternalError
            );
        }

        let call_adapter = adapter.clone();
        let call_agent = agent.clone();
        let call = tokio::spawn(async move { call_adapter.write_config(&call_agent, "{}").await });
        let ConnectionControl::Command(command) = receive.recv().await.unwrap() else {
            panic!("write must enter FIFO")
        };
        command
            .response
            .send(Ok(json!({
                "ok": true,
                "bytes_written": JsSafeInteger::MAX
            })))
            .unwrap();
        assert_eq!(call.await.unwrap().unwrap().get(), JsSafeInteger::MAX);
    }

    #[tokio::test]
    async fn profile_mcp_persisted_refusals_bind_source_before_registry_or_deletion() {
        use silverhand_backend_core::identity_access::agent_profile_mcp::{
            AgentProfileMcpDataPlane, McpDataPlaneFaultCode,
        };
        use std::thread;

        let registry = DaemonRegistry::with_process_epoch("profile-mcp-poison".to_owned());
        let poisoned = Arc::clone(&registry.state);
        let _ = thread::spawn(move || {
            let _guard = poisoned.lock().unwrap();
            panic!("poison registry for the pre-transport discriminator");
        })
        .join();
        let plane = OwningHostDataPlane { registry };
        let requested = AgentId::parse("agent-a").unwrap();

        for (fact, expected) in [
            (
                Some(mcp_placement("agent-a", "host-a", true)),
                McpDataPlaneFaultCode::AgentDeleting,
            ),
            (
                Some(mcp_placement("agent-b", "host-a", true)),
                McpDataPlaneFaultCode::DaemonInternalError,
            ),
            (None, McpDataPlaneFaultCode::DaemonInternalError),
        ] {
            let adapter =
                crate::identity_access::agent_profile_mcp_data_plane::ProductionAgentProfileMcpDataPlane::new(
                    McpPlacementRead { fact },
                    plane.clone(),
                );
            assert_eq!(
                adapter.read_config(&requested).await.unwrap_err().code,
                expected
            );
        }
    }

    #[tokio::test]
    async fn materialize_refuses_a_target_that_names_a_different_host_than_the_capture() {
        use silverhand_backend_core::{
            foundation::identity::WorkspaceId,
            host_runtime::agent_materialize::{
                AgentMaterializePort, AgentMaterializeTarget, AgentMaterializeTemplate,
            },
            identity_access::agents::runtime::RuntimeKind,
        };

        // Both hosts are legitimately attached: A's capture and B's reserved target are each
        // valid on their own. The single custody authority must still refuse the *pairing*
        // before any send, so neither FIFO ever sees a byte.
        let registry = DaemonRegistry::with_process_epoch("materialize-cross-host".to_owned());
        let host_a = HostId::parse("host-a").unwrap();
        let host_b = HostId::parse("host-b").unwrap();
        let instance = DaemonInstanceId::parse("same-instance").unwrap();
        let (_connection_a, mut receive_a) =
            attach_for_command_test(&registry, &host_a, instance.clone());
        let (_connection_b, mut receive_b) =
            attach_for_command_test(&registry, &host_b, instance.clone());
        let plane = OwningHostDataPlane {
            registry: registry.clone(),
        };
        let adapter = crate::host_runtime::agent_materialize::ProductionAgentMaterialize::new(
            plane.clone(),
            Duration::from_secs(10),
        );
        let captured_a = adapter
            .capture(&host_a)
            .await
            .unwrap()
            .expect("host A is attached at capture time");
        let target_b = AgentMaterializeTarget::reserved(
            host_b.clone(),
            AgentId::parse("agent-b").unwrap(),
            WorkspaceId::parse("wsah_agent-b").unwrap(),
            "Agent B".to_owned(),
            RuntimeKind::Codex,
            None,
            None,
            AgentMaterializeTemplate::Default,
        );
        assert!(matches!(
            adapter.materialize(captured_a, &target_b).await,
            Err(crate::host_runtime::agent_materialize::AgentMaterializeFailure::TargetCrossedCustody)
        ));
        assert!(matches!(
            receive_a.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty)
        ));
        assert!(matches!(
            receive_b.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty)
        ));
    }

    #[tokio::test]
    async fn clear_command_replacement_is_attach_pending_and_successor_fifo_stays_empty() {
        let registry = DaemonRegistry::with_process_epoch("clear-test".to_owned());
        let host = HostId::parse("host-a").unwrap();
        let instance = DaemonInstanceId::parse("same-instance").unwrap();
        let (connection_a, _receive_a) =
            attach_for_command_test(&registry, &host, instance.clone());
        let plane = OwningHostDataPlane {
            registry: registry.clone(),
        };
        let captured_a = plane.resolve(&host).unwrap().unwrap();
        registry.remove(host.as_str(), &connection_a);
        let (_connection_b, mut receive_b) = attach_for_command_test(&registry, &host, instance);
        let result = crate::host_runtime::runtime_control::clear_captured(
            &plane,
            captured_a,
            &RuntimeScope::AgentSlot {
                agent: AgentId::parse("agent-a").unwrap(),
            },
            silverhand_backend_core::host_runtime::runtime_credential::RuntimeGeneration::new(1)
                .unwrap(),
            Duration::from_secs(10),
        )
        .await
        .unwrap();
        assert!(matches!(
            result,
            crate::host_runtime::runtime_control::ClearDispatchOutcome::AttachPending
        ));
        assert!(matches!(
            receive_b.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty)
        ));
    }

    #[derive(Clone)]
    struct ClearCustody;

    impl silverhand_backend_core::host_runtime::runtime_credential::RuntimeCustodyPort
        for ClearCustody
    {
        async fn claim_or_current(
            &self,
            _claim: silverhand_backend_core::host_runtime::runtime_credential::ClaimRuntimeCustody,
        ) -> Result<
            Option<silverhand_backend_core::host_runtime::runtime_credential::ClaimedRuntime>,
            PersistenceFailure,
        > {
            unreachable!("clear never claims custody")
        }

        async fn current(
            &self,
            _scope: RuntimeScope,
        ) -> Result<Option<RuntimePrincipal>, PersistenceFailure> {
            unreachable!("clear never asks current custody")
        }

        async fn is_current(
            &self,
            _principal: RuntimePrincipal,
        ) -> Result<bool, PersistenceFailure> {
            unreachable!("clear never authenticates custody")
        }

        async fn finalize(
            &self,
            _finalization: silverhand_backend_core::host_runtime::runtime_credential::FinalizeRuntimeCustody,
        ) -> Result<bool, PersistenceFailure> {
            Ok(true)
        }
    }

    #[derive(Clone)]
    struct ClearSeat {
        snapshot: silverhand_backend_core::conversation_messaging::messaging::collaboration::RuntimeControlSeatSnapshot,
        settles: Arc<std::sync::atomic::AtomicUsize>,
    }

    impl RuntimeDispatchReadPort for ClearSeat {
        async fn resolve_dispatch_target(
            &self,
            _conversation: ConversationId,
            _agent: AgentId,
        ) -> Result<Option<RuntimeDispatchTarget>, PersistenceFailure> {
            unreachable!("clear never resolves a start target")
        }

        async fn resolve_start_dispatch(
            &self,
            _agent: AgentId,
            _candidate_origin: ConversationId,
        ) -> Result<Option<RuntimeDispatchTarget>, PersistenceFailure> {
            unreachable!("clear never resolves a start target")
        }

        async fn current_custodies_for_host(
            &self,
            _host_id: String,
        ) -> Result<Vec<RuntimePrincipal>, PersistenceFailure> {
            unreachable!("clear never hydrates")
        }
    }

    impl silverhand_backend_core::conversation_messaging::messaging::collaboration::RuntimeControlSeatPort for ClearSeat {
        type Error = std::io::Error;

        async fn snapshot(
            &self,
            _scope: &silverhand_backend_core::host_runtime::runtime_credential::RuntimeScope,
        ) -> Result<
            Option<silverhand_backend_core::conversation_messaging::messaging::collaboration::RuntimeControlSeatSnapshot>,
            Self::Error,
        > {
            Ok(Some(self.snapshot.clone()))
        }

        async fn settle_clear(
            &self,
            _target: &silverhand_backend_core::conversation_messaging::messaging::collaboration::RuntimeSeatTarget,
            before: &silverhand_backend_core::conversation_messaging::messaging::collaboration::BoundRuntimeControlSeat,
        ) -> Result<
            Option<silverhand_backend_core::conversation_messaging::messaging::collaboration::ClearSessionCommitReceipt>,
            Self::Error,
        > {
            self.settles
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(Some(
                silverhand_backend_core::conversation_messaging::messaging::collaboration::ClearSessionCommitReceipt::decoded(
                    before.scope().clone(),
                    before.generation(),
                    before.previous_cli_session().cloned(),
                    before.was_running(),
                    None,
                    silverhand_backend_core::conversation_messaging::messaging::collaboration::ClearSessionAuditWitness::Agent(
                        before.agent().clone(),
                    ),
                ),
            ))
        }
    }

    #[derive(Clone)]
    struct ClearComputer(HostId);

    impl ComputerReadModel for ClearComputer {
        async fn list_for_owner(
            &self,
            _owner: UserId,
        ) -> Result<
            Vec<silverhand_backend_core::host_runtime::computer::ComputerRecord>,
            PersistenceFailure,
        > {
            unreachable!("exact clear never lists hosts")
        }

        async fn read_computer(
            &self,
            computer: HostId,
        ) -> Result<
            Option<silverhand_backend_core::host_runtime::computer::ComputerRecord>,
            PersistenceFailure,
        > {
            use silverhand_backend_core::host_runtime::computer::{
                ComputerRecord, HostKind, ProvisioningSource,
            };
            assert_eq!(computer, self.0);
            Ok(Some(ComputerRecord {
                id: self.0.clone(),
                name: "host".to_owned(),
                kind: HostKind::Remote,
                created_at: 0,
                owner: Some(UserId::parse("user-1").unwrap()),
                installation_id: None,
                last_seen_at: None,
                activated_at: Some(1),
                finalized_at: Some(1),
                revoked_at: None,
                provisioning_source: ProvisioningSource::UserInvite,
                display_label: None,
            }))
        }
    }

    struct ProductionClearFixture {
        control: crate::host_runtime::runtime_control::ProductionRuntimeControl<
            ClearCustody,
            ClearSeat,
            ClearComputer,
        >,
        receive: mpsc::Receiver<ConnectionControl>,
        waiters: crate::host_runtime::runtime_control::RuntimeClearSessionWaiters,
        principal: RuntimePrincipal,
        actor: UserId,
        agent: AgentId,
        settles: Arc<std::sync::atomic::AtomicUsize>,
    }

    /// A deterministic agent-scope admission fake. The seat target is minted only
    /// by the core `clear_agent_session` use case (never a cross-crate
    /// `RuntimeSeatTarget::new`), so these production-provider tests drive the same
    /// entry as production: agent ladder (existence + edit), then the row-owned
    /// `agent` session scope. Conversation reads are `unreachable!` — an agent-scope
    /// clear touches no conversation.
    #[derive(Clone)]
    struct AgentSeatAdmission {
        agent: AgentId,
    }

    struct AgentSeatAdmissionScope {
        agent: AgentId,
    }

    impl silverhand_backend_core::conversation_messaging::messaging::collaboration::RuntimeControlAdmissionScope
        for AgentSeatAdmissionScope
    {
        type Error = std::io::Error;

        async fn conversation_exists(
            &mut self,
            _: &silverhand_backend_core::foundation::identity::ConversationId,
        ) -> Result<bool, Self::Error> {
            unreachable!("agent-scope clear reads no conversation")
        }

        async fn agent_exists(&mut self, agent: &AgentId) -> Result<bool, Self::Error> {
            Ok(agent == &self.agent)
        }

        async fn agent_is_member(
            &mut self,
            _: &silverhand_backend_core::foundation::identity::ConversationId,
            _: &AgentId,
        ) -> Result<bool, Self::Error> {
            unreachable!("agent-scope clear checks no membership")
        }

        async fn actor_may_post(
            &mut self,
            _: &silverhand_backend_core::foundation::identity::ConversationId,
            _: &UserId,
        ) -> Result<bool, Self::Error> {
            unreachable!("agent-scope clear runs no post gate")
        }

        async fn actor_may_edit_agent(
            &mut self,
            _: &UserId,
            agent: &AgentId,
        ) -> Result<bool, Self::Error> {
            Ok(agent == &self.agent)
        }

        async fn agent_session_scope(
            &mut self,
            agent: &AgentId,
        ) -> Result<
            Option<
                silverhand_backend_core::identity_access::agents::session_scope::AgentSessionScope,
            >,
            Self::Error,
        > {
            Ok((agent == &self.agent).then_some(
                silverhand_backend_core::identity_access::agents::session_scope::AgentSessionScope::Agent,
            ))
        }

        async fn finish(self) -> Result<(), Self::Error> {
            Ok(())
        }
    }

    impl silverhand_backend_core::conversation_messaging::messaging::collaboration::RuntimeControlAdmission
        for AgentSeatAdmission
    {
        type Error = std::io::Error;
        type Scope = AgentSeatAdmissionScope;

        async fn begin_snapshot(&self) -> Result<Self::Scope, Self::Error> {
            Ok(AgentSeatAdmissionScope {
                agent: self.agent.clone(),
            })
        }
    }

    fn production_clear_fixture() -> ProductionClearFixture {
        use silverhand_backend_core::conversation_messaging::messaging::collaboration::{
            CliSessionId, RuntimeControlObservedStatus, RuntimeControlSeatSnapshot,
        };
        let registry = DaemonRegistry::with_process_epoch("clear-production".to_owned());
        let host = HostId::parse("host-a").unwrap();
        let daemon = DaemonInstanceId::parse("daemon-a").unwrap();
        let (_connection, receive) = attach_for_command_test(&registry, &host, daemon.clone());
        let scope = RuntimeScope::AgentSlot {
            agent: AgentId::parse("agent-a").unwrap(),
        };
        let generation =
            silverhand_backend_core::host_runtime::runtime_credential::RuntimeGeneration::new(7)
                .unwrap();
        let principal = RuntimePrincipal::for_scope(
            scope.clone(),
            silverhand_backend_core::host_runtime::runtime_credential::RuntimeCustody::new(
                generation,
                daemon.clone(),
            ),
        );
        let settles = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let seats = ClearSeat {
            snapshot: RuntimeControlSeatSnapshot::decoded(
                AgentId::parse("agent-a").unwrap(),
                host.clone(),
                scope,
                generation,
                Some(daemon),
                Some(CliSessionId::parse("session-a").unwrap()),
                RuntimeControlObservedStatus::Active,
                "agent-a".to_owned(),
            ),
            settles: Arc::clone(&settles),
        };
        let plane = OwningHostDataPlane {
            registry: registry.clone(),
        };
        let computers = ClearComputer(host);
        let waiters = crate::host_runtime::runtime_control::RuntimeClearSessionWaiters::default();
        let stop = ProductionScopeRuntimeStop::new(
            computers.clone(),
            plane.clone(),
            Duration::from_secs(30),
        );
        let control = crate::host_runtime::runtime_control::ProductionRuntimeControl::new(
            RuntimeCredentialAuthority::production(ClearCustody),
            seats,
            computers,
            plane,
            stop,
            waiters.clone(),
            Duration::from_secs(30),
        );
        ProductionClearFixture {
            control,
            receive,
            waiters,
            principal,
            actor: UserId::parse("user-1").unwrap(),
            agent: AgentId::parse("agent-a").unwrap(),
            settles,
        }
    }

    #[tokio::test(start_paused = true)]
    async fn clear_ack_alone_times_out_without_settlement_and_finally_releases_single_flight() {
        use silverhand_backend_core::conversation_messaging::messaging::collaboration::{
            ClearSessionProviderRefusal, ClearSessionRefusal, clear_agent_session,
        };
        let ProductionClearFixture {
            control,
            mut receive,
            waiters,
            principal,
            actor,
            agent,
            settles,
        } = production_clear_fixture();
        let admission = AgentSeatAdmission {
            agent: agent.clone(),
        };
        let first_control = control.clone();
        let first_admission = admission.clone();
        let first_actor = actor.clone();
        let first_agent = agent.clone();
        let first = tokio::spawn(async move {
            clear_agent_session(&first_admission, &first_control, first_actor, first_agent).await
        });
        let ConnectionControl::Command(command) = receive.recv().await.unwrap() else {
            panic!("clear must enter the production FIFO")
        };
        assert_eq!(command.kind, IssuedDaemonCommandKind::RuntimeClearSession);
        assert_eq!(command.params["runtime_generation"], 7);
        command.response.send(Ok(json!({"cleared":true}))).unwrap();

        let concurrent = clear_agent_session(&admission, &control, actor.clone(), agent.clone())
            .await
            .unwrap();
        assert_eq!(
            concurrent,
            Err(ClearSessionRefusal::Provider(
                ClearSessionProviderRefusal::InProgress
            ))
        );
        waiters.notify_exit(&RuntimePrincipal::for_scope(
            principal.scope(),
            silverhand_backend_core::host_runtime::runtime_credential::RuntimeCustody::new(
                silverhand_backend_core::host_runtime::runtime_credential::RuntimeGeneration::new(
                    8,
                )
                .unwrap(),
                principal.custody().daemon_instance().clone(),
            ),
        ));
        tokio::time::advance(Duration::from_secs(10)).await;
        assert_eq!(
            first.await.unwrap().unwrap(),
            Err(ClearSessionRefusal::Provider(
                ClearSessionProviderRefusal::Timeout
            ))
        );
        assert_eq!(settles.load(std::sync::atomic::Ordering::SeqCst), 0);

        let retry_control = control.clone();
        let retry_admission = admission.clone();
        let retry_actor = actor.clone();
        let retry_agent = agent.clone();
        let retry = tokio::spawn(async move {
            clear_agent_session(&retry_admission, &retry_control, retry_actor, retry_agent).await
        });
        let ConnectionControl::Command(command) = receive.recv().await.unwrap() else {
            panic!("finally cleanup must admit a retry")
        };
        command.response.send(Ok(json!({"cleared":false}))).unwrap();
        assert!(retry.await.unwrap().unwrap().is_ok());
        assert_eq!(settles.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn exact_exit_before_clear_response_is_latched_then_settled() {
        use silverhand_backend_core::conversation_messaging::messaging::collaboration::clear_agent_session;
        let ProductionClearFixture {
            control,
            mut receive,
            waiters,
            principal,
            actor,
            agent,
            settles,
        } = production_clear_fixture();
        let admission = AgentSeatAdmission {
            agent: agent.clone(),
        };
        let call =
            tokio::spawn(
                async move { clear_agent_session(&admission, &control, actor, agent).await },
            );
        let ConnectionControl::Command(command) = receive.recv().await.unwrap() else {
            panic!("clear must enter the production FIFO")
        };
        waiters.notify_exit(&principal);
        command.response.send(Ok(json!({"cleared":true}))).unwrap();
        assert!(call.await.unwrap().unwrap().is_ok());
        assert_eq!(settles.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[derive(Clone)]
    struct StartCustody;

    impl silverhand_backend_core::host_runtime::runtime_credential::RuntimeCustodyPort
        for StartCustody
    {
        async fn claim_or_current(
            &self,
            claim: silverhand_backend_core::host_runtime::runtime_credential::ClaimRuntimeCustody,
        ) -> Result<
            Option<silverhand_backend_core::host_runtime::runtime_credential::ClaimedRuntime>,
            PersistenceFailure,
        > {
            Ok(Some(
                silverhand_backend_core::host_runtime::runtime_credential::ClaimedRuntime::new(
                    RuntimePrincipal::for_scope(
                        claim.scope().clone(),
                        silverhand_backend_core::host_runtime::runtime_credential::RuntimeCustody::new(
                            silverhand_backend_core::host_runtime::runtime_credential::RuntimeGeneration::new(1)
                                .unwrap(),
                            claim.daemon_instance().clone(),
                        ),
                    ),
                    true,
                ),
            ))
        }

        async fn current(
            &self,
            _scope: RuntimeScope,
        ) -> Result<Option<RuntimePrincipal>, PersistenceFailure> {
            Ok(None)
        }

        async fn is_current(
            &self,
            _principal: RuntimePrincipal,
        ) -> Result<bool, PersistenceFailure> {
            Ok(true)
        }

        async fn finalize(
            &self,
            _finalization: silverhand_backend_core::host_runtime::runtime_credential::FinalizeRuntimeCustody,
        ) -> Result<bool, PersistenceFailure> {
            Ok(true)
        }
    }

    #[derive(Clone)]
    struct StartSeat(RuntimeDispatchTarget);

    impl RuntimeDispatchReadPort for StartSeat {
        async fn resolve_dispatch_target(
            &self,
            _conversation: ConversationId,
            _agent: AgentId,
        ) -> Result<Option<RuntimeDispatchTarget>, PersistenceFailure> {
            unreachable!("start resolves through resolve_start_dispatch")
        }

        async fn resolve_start_dispatch(
            &self,
            agent: AgentId,
            candidate_origin: ConversationId,
        ) -> Result<Option<RuntimeDispatchTarget>, PersistenceFailure> {
            assert_eq!(candidate_origin, self.0.conversation);
            assert_eq!(agent, *self.0.plan.scope.agent());
            Ok(Some(self.0.clone()))
        }

        async fn current_custodies_for_host(
            &self,
            _host_id: String,
        ) -> Result<Vec<RuntimePrincipal>, PersistenceFailure> {
            unreachable!("runtime control start never hydrates")
        }
    }

    impl silverhand_backend_core::conversation_messaging::messaging::collaboration::RuntimeControlSeatPort for StartSeat {
        type Error = std::io::Error;

        async fn snapshot(
            &self,
            _scope: &silverhand_backend_core::host_runtime::runtime_credential::RuntimeScope,
        ) -> Result<
            Option<silverhand_backend_core::conversation_messaging::messaging::collaboration::RuntimeControlSeatSnapshot>,
            Self::Error,
        > {
            unreachable!("start resolves the spawn plan")
        }

        async fn settle_clear(
            &self,
            _target: &silverhand_backend_core::conversation_messaging::messaging::collaboration::RuntimeSeatTarget,
            _before: &silverhand_backend_core::conversation_messaging::messaging::collaboration::BoundRuntimeControlSeat,
        ) -> Result<
            Option<silverhand_backend_core::conversation_messaging::messaging::collaboration::ClearSessionCommitReceipt>,
            Self::Error,
        > {
            unreachable!("start never settles clear")
        }
    }

    #[tokio::test]
    async fn runtime_control_start_traverses_typed_codec_and_production_fifo() {
        use silverhand_backend_core::{
            conversation_messaging::messaging::collaboration::{
                RuntimeControlPort, RuntimeStartTarget,
            },
            conversation_messaging::runtime_delivery::{RuntimeAgentSpec, RuntimeSpawnPlan},
            host_runtime::runtime_credential::{AgentSlotPresentationFocusPort, RuntimeCustody},
            identity_access::agents::runtime::RuntimeKind,
        };
        let registry = DaemonRegistry::with_process_epoch("start-production".to_owned());
        let host = HostId::parse("host-a").unwrap();
        let (_connection, mut receive) = attach_for_command_test(
            &registry,
            &host,
            DaemonInstanceId::parse("daemon-a").unwrap(),
        );
        let conversation = ConversationId::parse("conversation-a").unwrap();
        let agent = AgentId::parse("agent-a").unwrap();
        let seats = StartSeat(RuntimeDispatchTarget {
            host_id: host.as_str().to_owned(),
            conversation: conversation.clone(),
            plan: RuntimeSpawnPlan {
                scope: RuntimeScope::AgentSlot {
                    agent: agent.clone(),
                },
                agent: RuntimeAgentSpec {
                    id: agent.clone(),
                    name: "agent-a".to_owned(),
                    runtime: RuntimeKind::Codex,
                    model: None,
                    reasoning_effort: None,
                    fast_mode: None,
                    cli_session_id: None,
                },
                workspace: None,
                workspace_memory_index: Vec::new(),
                session: None,
            },
        });
        let plane = OwningHostDataPlane {
            registry: registry.clone(),
        };
        let computers = ClearComputer(host);
        let stop = ProductionScopeRuntimeStop::new(
            computers.clone(),
            plane.clone(),
            Duration::from_secs(30),
        );
        let credentials = RuntimeCredentialAuthority::production(StartCustody);
        let focus = credentials.clone();
        let expected_principal = RuntimePrincipal::for_scope(
            RuntimeScope::AgentSlot {
                agent: agent.clone(),
            },
            RuntimeCustody::new(
                silverhand_backend_core::host_runtime::runtime_credential::RuntimeGeneration::new(
                    1,
                )
                .unwrap(),
                DaemonInstanceId::parse("daemon-a").unwrap(),
            ),
        );
        let control = crate::host_runtime::runtime_control::ProductionRuntimeControl::new(
            credentials,
            seats,
            computers,
            plane,
            stop,
            crate::host_runtime::runtime_control::RuntimeClearSessionWaiters::default(),
            Duration::from_secs(30),
        );
        let target = RuntimeStartTarget::new(UserId::parse("user-1").unwrap(), agent, conversation);

        let invalid_control = control.clone();
        let invalid_target = target.clone();
        let invalid = tokio::spawn(async move { invalid_control.start(&invalid_target).await });
        let ConnectionControl::Command(command) = receive.recv().await.unwrap() else {
            panic!("invalid runtime_start must enter the production FIFO")
        };
        command.response.send(Ok(json!({"started":true}))).unwrap();
        assert!(invalid.await.unwrap().is_err());
        assert_eq!(
            focus
                .agent_slot_presentation_focus(expected_principal.clone())
                .await
                .unwrap(),
            None
        );

        let cooldown_control = control.clone();
        let cooldown_target = target.clone();
        let cooldown = tokio::spawn(async move { cooldown_control.start(&cooldown_target).await });
        let ConnectionControl::Command(command) = receive.recv().await.unwrap() else {
            panic!("cooldown runtime_start must enter the production FIFO")
        };
        command
            .response
            .send(Ok(json!({
                "started":false,
                "reason":"init_cooldown",
                "cooldown_until":7
            })))
            .unwrap();
        assert!(cooldown.await.unwrap().unwrap().is_ok());
        assert_eq!(
            focus
                .agent_slot_presentation_focus(expected_principal.clone())
                .await
                .unwrap(),
            None
        );

        let call = tokio::spawn(async move { control.start(&target).await });
        let ConnectionControl::Command(command) = receive.recv().await.unwrap() else {
            panic!("runtime_start must enter the production FIFO")
        };
        assert_eq!(command.kind, IssuedDaemonCommandKind::RuntimeStart);
        assert_eq!(command.params["conversation_id"], "conversation-a");
        assert_eq!(command.params["agent_id"], "agent-a");
        assert_eq!(command.params["runtime_generation"], 1);
        assert_eq!(
            command.params["options"]["runtime_scope"],
            json!({"kind":"agent","agent_id":"agent-a"})
        );
        command
            .response
            .send(Ok(json!({"started":true,"pid":42,"started_at":7})))
            .unwrap();
        assert!(call.await.unwrap().unwrap().is_ok());
        assert_eq!(
            focus
                .agent_slot_presentation_focus(expected_principal)
                .await
                .unwrap(),
            Some(ConversationId::parse("conversation-a").unwrap())
        );
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
    fn rust_consumes_the_ts_first_exact_daemon_event_fixture() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../../packages/host/tests/fixtures/outbound-daemon-events.json"
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
                daemon_ingress_is_valid(&frame.to_string()),
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
            crate::host_runtime::runtime_event_settlement::ParsedEventWire::IMPLEMENTED_KINDS
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
            let DaemonFrame::Runtime { kind, value } = parsed_frame else {
                panic!("parsed fixture reached the wrong owner: {}", parsed["kind"]);
            };
            let crate::host_runtime::runtime_event_settlement::RuntimeProductEvent::Parsed(event) =
                crate::host_runtime::runtime_event_settlement::decode_product_event(&kind, &value)
                    .unwrap()
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
            let state = serde_json::from_value::<
                crate::host_runtime::runtime_event_settlement::AgentRunStateWire,
            >(test_case["state"].clone())
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
                serde_json::from_value::<
                    crate::host_runtime::runtime_event_settlement::AgentRunStateWire,
                >(test_case["state"].clone(),)
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
                !daemon_ingress_is_valid(&frame.to_string()),
                "invalid ingress run state accepted: {}",
                test_case["name"]
            );
        }
        for test_case in fixture["invalid"].as_array().unwrap() {
            assert!(
                !daemon_ingress_is_valid(&test_case["frame"].to_string()),
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
        assert_eq!(
            runtime_start_codec::decode_result(
                &json!({ "started": true, "pid": 1, "started_at": 2 })
            ),
            Some(runtime_start_codec::RuntimeStartResult::Started)
        );
        assert_eq!(
            runtime_start_codec::decode_result(&json!({
                "started": true,
                "pid": 1,
                "started_at": 2,
                "extra": true,
            })),
            None
        );
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

    async fn start_archive_fixture(path: &std::path::Path) -> sqlx::SqliteConnection {
        let mut db = current_schema::create_current_schema(path).await;
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
        db
    }

    #[tokio::test]
    async fn automatic_start_rechecks_archive_before_entering_production_fifo() {
        use crate::host_runtime::daemon_runtime_transport::StartTransport;

        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("start-archive.sqlite");
        let mut db = start_archive_fixture(&path).await;
        let store = SqliteRuntimeDeliveryStore::open(&path).await.unwrap();
        let conversation = ConversationId::parse("conversation0001").unwrap();
        let agent = AgentId::parse("agent-lease").unwrap();
        let target = store
            .resolve_dispatch_target(conversation.clone(), agent)
            .await
            .unwrap()
            .expect("active target is projected before archive");

        let registry = DaemonRegistry::with_process_epoch("start-archive".into());
        let host = HostId::parse("host-b").unwrap();
        let instance = DaemonInstanceId::parse("daemon-start-archive").unwrap();
        let (_connection, mut receive) =
            attach_for_command_test(&registry, &host, instance.clone());
        let plane = OwningHostDataPlane { registry };
        let attached = plane.capture_attached(host.as_str()).unwrap().unwrap();
        let transport =
            StartTransport::new(attached, target.clone(), Duration::from_secs(1), store);
        let credentials = RuntimeCredentialAuthority::production(StartCustody);

        // Archive commits after projection but before start dispatch admission.
        // No inbox batch is involved in this path.
        sqlx::query("UPDATE conversations SET archived_at = 2 WHERE id = ?")
            .bind(conversation.as_str())
            .execute(&mut db)
            .await
            .unwrap();
        let result = credentials
            .dispatch_start(
                target.plan.scope.clone(),
                instance.clone(),
                conversation.clone(),
                &transport,
            )
            .await;
        assert!(matches!(
            result,
            Err(crate::host_runtime::runtime_credential::RuntimeStartFailure::ProvenNotDispatched(
                crate::host_runtime::daemon_runtime_transport::StartTransportError::TargetUnavailable
            ))
        ));
        assert!(matches!(
            receive.try_recv(),
            Err(mpsc::error::TryRecvError::Empty)
        ));

        // The same production transport still dispatches for an active channel.
        sqlx::query("UPDATE conversations SET archived_at = NULL WHERE id = ?")
            .bind(conversation.as_str())
            .execute(&mut db)
            .await
            .unwrap();
        let call = tokio::spawn(async move {
            credentials
                .dispatch_start(target.plan.scope, instance, conversation, &transport)
                .await
        });
        let ConnectionControl::Command(command) = receive.recv().await.unwrap() else {
            panic!("active automatic start must enter FIFO")
        };
        command
            .response
            .send(Ok(json!({"started":true,"pid":123,"started_at":100})))
            .unwrap();
        assert!(call.await.unwrap().is_ok());
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
            "../../../../../packages/shared/tests/fixtures/runtime-delivery-presentation.json"
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
                silverhand_backend_core::conversation_messaging::runtime_delivery::ClaimedInboxDelivery::decoded(
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
            silverhand_backend_core::host_runtime::runtime_credential::RuntimeCustody::new(
                silverhand_backend_core::host_runtime::runtime_credential::RuntimeGeneration::new(
                    1,
                )
                .unwrap(),
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

    fn purge_test_registry() -> DaemonRegistry {
        DaemonRegistry::with_process_epoch("purge-epoch".to_owned())
    }

    /// Reserve and attach a fresh generation for `host`, returning its captured
    /// (connection id, instance). The command channel is retained by the slot but no
    /// consumer drains it: every generation-mismatch test must refuse BEFORE any send.
    fn attach_generation(
        registry: &DaemonRegistry,
        host: &str,
        instance: &str,
    ) -> (String, DaemonInstanceId) {
        let (commands, _commands_rx) = mpsc::channel(4);
        let (close, _close_rx) = watch::channel(None);
        let connection_id = registry.reserve(host, commands, close).expect("reserve");
        let instance = DaemonInstanceId::parse(instance).expect("instance");
        registry
            .attach(
                host,
                &connection_id,
                AttachedDaemon {
                    daemon_instance: instance.clone(),
                    host_name: host.to_owned(),
                },
            )
            .expect("attach");
        (connection_id, instance)
    }

    #[tokio::test]
    async fn a_generation_pinned_purge_refuses_a_replaced_connection() {
        let registry = purge_test_registry();
        let host = HostId::parse("host-1").expect("host");
        let agent = AgentId::parse("agent-1").expect("agent");
        let (captured_connection, _captured_instance) =
            attach_generation(&registry, "host-1", "instance-1");
        let data_plane = OwningHostDataPlane {
            registry: registry.clone(),
        };
        let custody = data_plane.resolve(&host).unwrap().unwrap();

        // The daemon reconnects on a fresh generation before the captured purge is sent.
        registry.remove("host-1", &captured_connection);
        let (live_connection, _live_instance) =
            attach_generation(&registry, "host-1", "instance-1");
        assert_ne!(live_connection, captured_connection);

        let effects = DaemonCascadeEffects::new(data_plane);
        let failure = effects
            .purge_host_local_files_on_generation(custody, &agent)
            .await
            .expect_err("a superseded connection generation must not purge");
        assert!(
            error::describe(&failure).contains("connection generation"),
            "unexpected failure chain: {}",
            error::describe(&failure)
        );
    }

    #[tokio::test]
    async fn a_generation_pinned_purge_refuses_a_reused_connection_with_a_new_instance() {
        let registry = purge_test_registry();
        let host = HostId::parse("host-1").expect("host");
        let agent = AgentId::parse("agent-1").expect("agent");
        let (connection, _captured_instance) = attach_generation(&registry, "host-1", "instance-1");
        let data_plane = OwningHostDataPlane {
            registry: registry.clone(),
        };
        let custody = data_plane.resolve(&host).unwrap().unwrap();

        // The same connection slot re-hydrates under a different daemon instance.
        registry
            .attach(
                "host-1",
                &connection,
                AttachedDaemon {
                    daemon_instance: DaemonInstanceId::parse("instance-2").expect("instance"),
                    host_name: "host-1".to_owned(),
                },
            )
            .expect("re-attach");

        let effects = DaemonCascadeEffects::new(data_plane);
        let failure = effects
            .purge_host_local_files_on_generation(custody, &agent)
            .await
            .expect_err("a reused connection under a new instance must not purge");
        assert!(
            error::describe(&failure).contains("daemon custody changed"),
            "unexpected failure chain: {}",
            error::describe(&failure)
        );
    }

    #[tokio::test]
    async fn a_fence_binder_declines_a_stale_generation_and_binds_a_live_one() {
        let registry = purge_test_registry();
        let host = HostId::parse("host-1").expect("host");
        let (connection, _instance) = attach_generation(&registry, "host-1", "instance-1");

        let binder = DaemonHostConnections::new(OwningHostDataPlane {
            registry: registry.clone(),
        });
        assert!(
            binder.bind(&host, &connection).is_some(),
            "the live generation must bind a fence"
        );
        assert!(
            binder
                .bind(&host, "daemon-connection-purge-epoch-999")
                .is_none(),
            "a stale generation must not bind"
        );
        assert_eq!(
            binder.current_generation(&host).as_deref(),
            Some(connection.as_str())
        );
    }
}

#[cfg(test)]
#[path = "daemon_activation_close_tests.rs"]
mod activation_close_tests;
