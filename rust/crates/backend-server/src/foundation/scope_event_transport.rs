//! Authenticated, resumable product-event transport.

use std::{
    collections::{HashMap, HashSet, VecDeque},
    error::Error,
    fmt,
    pin::Pin,
    sync::{Arc, Mutex},
    time::Duration,
};

use axum::{
    Json, Router,
    extract::{
        State,
        ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade},
    },
    http::{
        HeaderMap, StatusCode, Uri,
        header::{COOKIE, ORIGIN},
    },
    response::{IntoResponse, Response},
    routing::get,
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Deserializer, Serialize};
use silverhand_backend_core::{
    foundation::identity::{AgentId, ConversationId, UserId, WorkspaceId},
    foundation::scope_event::{AuthorizeEventScope, EventScope},
    identity_access::auth::{AuthenticateHumanSession, SessionBearer},
};

use tokio::{
    sync::{Notify, broadcast, mpsc, oneshot, watch},
    task::{AbortHandle, JoinHandle},
    time::{Instant, Sleep},
};

use super::{
    clock::{ProcessClock, SystemProcessClock},
    scope_event_wire::ProductEvent,
};

include!(concat!(env!("OUT_DIR"), "/backend_admission.rs"));

const MAX_INBOUND_BYTES: usize = 64 * 1024;
const REPLAY_CAPACITY: usize = 200;
const LIVE_CAPACITY: usize = 200;
const CONNECTION_QUEUE_CAPACITY: usize = 256;
const DEFAULT_PING_INTERVAL: Duration = Duration::from_secs(30);
const DEFAULT_PONG_TIMEOUT: Duration = Duration::from_secs(5);
const DEFAULT_SHUTDOWN_GRACE: Duration = Duration::from_millis(1_500);
const MAX_TRANSPORT_SEQ: u64 = 9_007_199_254_740_991;

#[derive(Clone, Copy, Debug, Default, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub(crate) struct TransportSeq(pub(crate) u64);

#[derive(Clone, Debug, PartialEq, Serialize)]
pub(crate) struct ScopedEvent {
    #[serde(skip)]
    pub(crate) published_at: i64,
    #[serde(rename = "type")]
    pub(crate) frame_type: &'static str,
    pub(crate) scope: String,
    pub(crate) seq: TransportSeq,
    pub(crate) epoch: String,
    #[serde(flatten)]
    pub(crate) event: ProductEvent,
}

impl TransportSeq {
    const ZERO: Self = Self(0);

    fn checked_next(self) -> Result<Self, ScopeEventHubError> {
        let next = self
            .0
            .checked_add(1)
            .ok_or(ScopeEventHubError::SequenceExhausted)?;
        (next <= MAX_TRANSPORT_SEQ)
            .then_some(Self(next))
            .ok_or(ScopeEventHubError::SequenceExhausted)
    }
}

impl<'de> Deserialize<'de> for TransportSeq {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = u64::deserialize(deserializer)?;
        if value > MAX_TRANSPORT_SEQ {
            return Err(serde::de::Error::custom(
                "transport sequence exceeds JavaScript's exact integer range",
            ));
        }
        Ok(Self(value))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct TransportEpoch(Arc<str>);

impl TransportEpoch {
    fn parse(raw: impl Into<Arc<str>>) -> Result<Self, InvalidTransportEpoch> {
        let raw = raw.into();
        if raw.is_empty() {
            return Err(InvalidTransportEpoch);
        }
        Ok(Self(raw))
    }

    fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug)]
struct InvalidTransportEpoch;

impl fmt::Display for InvalidTransportEpoch {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("transport epoch must not be empty")
    }
}

impl Error for InvalidTransportEpoch {}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct AllowedOrigin(Arc<str>);

impl AllowedOrigin {
    pub fn parse(raw: impl Into<String>) -> Result<Self, InvalidAllowedOrigin> {
        let mut raw = raw.into();
        if raw.ends_with('/') {
            raw.pop();
        }
        let uri: Uri = raw.parse().map_err(|_| InvalidAllowedOrigin)?;
        let scheme = uri.scheme_str().ok_or(InvalidAllowedOrigin)?;
        if !matches!(scheme, "http" | "https")
            || uri.authority().is_none()
            || uri
                .authority()
                .is_some_and(|authority| authority.as_str().contains('@'))
            || uri.path() != "/"
            || uri.query().is_some()
            || raw.contains('#')
        {
            return Err(InvalidAllowedOrigin);
        }
        Ok(Self(raw.into()))
    }
}

#[derive(Debug)]
pub struct InvalidAllowedOrigin;

impl fmt::Display for InvalidAllowedOrigin {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("event websocket origin must be an http(s) origin")
    }
}

impl Error for InvalidAllowedOrigin {}

#[derive(Clone)]
pub struct EventWebSocketConfig {
    allowed_origins: Arc<HashSet<AllowedOrigin>>,
    minimum_client_epoch: u32,
    ping_interval: Duration,
    pong_timeout: Duration,
    shutdown_grace: Duration,
}

impl EventWebSocketConfig {
    pub fn production(
        allowed_origins: impl IntoIterator<Item = AllowedOrigin>,
    ) -> Result<Self, EmptyOriginAllowlist> {
        let allowed_origins = allowed_origins.into_iter().collect::<HashSet<_>>();
        if allowed_origins.is_empty() {
            return Err(EmptyOriginAllowlist);
        }
        Ok(Self {
            allowed_origins: Arc::new(allowed_origins),
            minimum_client_epoch: MINIMUM_CLIENT_API_EPOCH,
            ping_interval: DEFAULT_PING_INTERVAL,
            pong_timeout: DEFAULT_PONG_TIMEOUT,
            shutdown_grace: DEFAULT_SHUTDOWN_GRACE,
        })
    }

    #[cfg(test)]
    fn test(origin: &str) -> Self {
        Self {
            allowed_origins: Arc::new(HashSet::from([AllowedOrigin::parse(origin).unwrap()])),
            minimum_client_epoch: MINIMUM_CLIENT_API_EPOCH,
            ping_interval: Duration::from_secs(60),
            pong_timeout: Duration::from_secs(5),
            shutdown_grace: Duration::from_secs(5),
        }
    }
}

#[derive(Debug)]
pub struct EmptyOriginAllowlist;

impl fmt::Display for EmptyOriginAllowlist {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("event websocket origin allowlist must not be empty")
    }
}

impl Error for EmptyOriginAllowlist {}

#[derive(Debug)]
pub enum ScopeEventHubError {
    Entropy(getrandom::Error),
    InvalidEpoch,
    SequenceExhausted,
    RegistryPoisoned,
}

impl fmt::Display for ScopeEventHubError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Entropy(_) => formatter
                .write_str("secure random source failed while creating the event transport epoch"),
            Self::InvalidEpoch => formatter.write_str("event transport epoch is invalid"),
            Self::SequenceExhausted => formatter.write_str("scope event sequence exhausted"),
            Self::RegistryPoisoned => formatter.write_str("scope event registry lock was poisoned"),
        }
    }
}

impl Error for ScopeEventHubError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Entropy(source) => Some(source),
            Self::InvalidEpoch | Self::SequenceExhausted | Self::RegistryPoisoned => None,
        }
    }
}

#[derive(Clone)]
pub struct ScopeEventHub {
    epoch: TransportEpoch,
    scopes: Arc<Mutex<HashMap<EventScope, ScopeState>>>,
}

struct ScopeState {
    seq: TransportSeq,
    replay: VecDeque<ScopedEvent>,
    live: broadcast::Sender<ScopedEvent>,
}

impl ScopeState {
    fn new() -> Self {
        let (live, _) = broadcast::channel(LIVE_CAPACITY);
        Self {
            seq: TransportSeq::ZERO,
            replay: VecDeque::with_capacity(REPLAY_CAPACITY),
            live,
        }
    }
}

impl ScopeEventHub {
    pub fn production() -> Result<Self, ScopeEventHubError> {
        let mut entropy = [0_u8; 16];
        getrandom::fill(&mut entropy).map_err(ScopeEventHubError::Entropy)?;
        Self::from_epoch(URL_SAFE_NO_PAD.encode(entropy))
    }

    fn from_epoch(epoch: impl Into<Arc<str>>) -> Result<Self, ScopeEventHubError> {
        Ok(Self {
            epoch: TransportEpoch::parse(epoch).map_err(|_| ScopeEventHubError::InvalidEpoch)?,
            scopes: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    #[cfg(test)]
    fn test(epoch: &str) -> Self {
        Self::from_epoch(epoch).unwrap()
    }

    pub fn epoch(&self) -> &str {
        self.epoch.as_str()
    }

    pub(crate) fn publish(
        &self,
        scope: EventScope,
        event: ProductEvent,
    ) -> Result<(), ScopeEventHubError> {
        self.publish_batch(scope, vec![event])
    }

    /// Publishes a co-emit to one scope as an ATOMIC unit: either every event in the
    /// batch lands with a contiguous run of sequence numbers, or none does and the
    /// scope's state is untouched.
    ///
    /// The whole batch shares ONE lock acquisition, so no other publisher can interleave
    /// a frame between two members of the same co-emit. Every sequence number is reserved
    /// by walking `checked_next` on a LOCAL cursor first: if the ceiling falls inside the
    /// batch, the `?` returns before `state` is mutated, so a client never receives a
    /// prefix of a co-emit whose tail was lost to exhaustion. Only once every seq is
    /// reserved does the batch touch the replay ring and the live channel.
    pub(crate) fn publish_batch(
        &self,
        scope: EventScope,
        events: Vec<ProductEvent>,
    ) -> Result<(), ScopeEventHubError> {
        let mut scopes = self
            .scopes
            .lock()
            .map_err(|_| ScopeEventHubError::RegistryPoisoned)?;
        let state = scopes.entry(scope.clone()).or_insert_with(ScopeState::new);

        // Reserve every sequence number BEFORE mutating anything. An exhaustion partway
        // through returns here, leaving `state.seq`, the replay ring, and the live channel
        // exactly as they were — zero frames, never a partial co-emit.
        let mut cursor = state.seq;
        let mut reserved = Vec::with_capacity(events.len());
        for _ in &events {
            cursor = cursor.checked_next()?;
            reserved.push(cursor);
        }

        let wire_scope = scope_wire(&scope);
        state.seq = cursor;
        for (event, seq) in events.into_iter().zip(reserved) {
            let frame = ScopedEvent {
                published_at: SystemProcessClock.now_unix_millis(),
                frame_type: "event",
                scope: wire_scope.clone(),
                seq,
                epoch: self.epoch().to_owned(),
                event,
            };
            if state.replay.len() == REPLAY_CAPACITY {
                state.replay.pop_front();
            }
            state.replay.push_back(frame.clone());
            let _ = state.live.send(frame);
        }
        Ok(())
    }

    /// Retention also removes replay copies; a resumed cursor spanning a hole
    /// must cold-read instead of resurrecting an expired activity payload.
    pub fn prune_activity_before(&self, cutoff: i64) -> Result<(), ScopeEventHubError> {
        let mut scopes = self
            .scopes
            .lock()
            .map_err(|_| ScopeEventHubError::RegistryPoisoned)?;
        for state in scopes.values_mut() {
            state.replay.retain(|frame| match &frame.event {
                ProductEvent::ConversationActivity(value)
                | ProductEvent::AgentStreamActivity(value) => !value
                    .get("created_at")
                    .and_then(serde_json::Value::as_i64)
                    .is_some_and(|at| at < cutoff),
                ProductEvent::AgentEvent(_) => frame.published_at >= cutoff,
                _ => true,
            });
        }
        Ok(())
    }

    fn subscribe(&self, scope: EventScope) -> Result<Subscription, ScopeEventHubError> {
        let mut scopes = self
            .scopes
            .lock()
            .map_err(|_| ScopeEventHubError::RegistryPoisoned)?;
        let state = scopes.entry(scope).or_insert_with(ScopeState::new);
        Ok(Subscription {
            current_seq: state.seq,
            receiver: state.live.subscribe(),
        })
    }

    fn resume(
        &self,
        scope: &EventScope,
        epoch: &TransportEpoch,
        last_seq: TransportSeq,
    ) -> Result<Resume, ScopeEventHubError> {
        let mut scopes = self
            .scopes
            .lock()
            .map_err(|_| ScopeEventHubError::RegistryPoisoned)?;
        let state = scopes.entry(scope.clone()).or_insert_with(ScopeState::new);
        if epoch != &self.epoch {
            return Ok(Resume {
                replay: Replay::SnapshotRequired {
                    reason: "epoch_mismatch",
                    current_seq: state.seq,
                },
                subscription: None,
            });
        }
        // Count the contiguous tail after this cursor. Retention may leave
        // interior holes, unlike capacity eviction which only drops a prefix.
        let available = state
            .replay
            .iter()
            .filter(|event| event.seq > last_seq)
            .count() as u64;
        if last_seq.0 < state.seq.0 && available != state.seq.0 - last_seq.0 {
            return Ok(Resume {
                replay: Replay::SnapshotRequired {
                    reason: "gap_too_large",
                    current_seq: state.seq,
                },
                subscription: None,
            });
        }
        let receiver = state.live.subscribe();
        let events = state
            .replay
            .iter()
            .filter(|event| event.seq > last_seq)
            .cloned()
            .collect();
        Ok(Resume {
            replay: Replay::Events(events),
            subscription: Some(Subscription {
                current_seq: state.seq,
                receiver,
            }),
        })
    }

    fn current_seq(&self, scope: &EventScope) -> Result<TransportSeq, ScopeEventHubError> {
        let scopes = self
            .scopes
            .lock()
            .map_err(|_| ScopeEventHubError::RegistryPoisoned)?;
        Ok(scopes
            .get(scope)
            .map_or(TransportSeq::ZERO, |state| state.seq))
    }
}

struct Subscription {
    current_seq: TransportSeq,
    receiver: broadcast::Receiver<ScopedEvent>,
}

enum Replay {
    Events(Vec<ScopedEvent>),
    SnapshotRequired {
        reason: &'static str,
        current_seq: TransportSeq,
    },
}

struct Resume {
    replay: Replay,
    subscription: Option<Subscription>,
}

#[derive(Clone)]
struct EventServerState<A, S> {
    hub: ScopeEventHub,
    sessions: A,
    scope_authority: S,
    config: EventWebSocketConfig,
    registry: ConnectionRegistry,
    lifecycle: Arc<dyn ConnectionLifecycle>,
}

#[derive(Clone, Default)]
struct ConnectionRegistry {
    inner: Arc<Mutex<ConnectionRegistryState>>,
    changed: Arc<Notify>,
}

#[derive(Default)]
struct ConnectionRegistryState {
    closing: bool,
    next_id: u64,
    connections: HashMap<u64, ConnectionHandle>,
}

struct ConnectionHandle {
    shutdown: watch::Sender<bool>,
    abort: AbortHandle,
}

impl ConnectionRegistry {
    fn allocate_id(&self) -> Option<u64> {
        let mut inner = self.inner.lock().ok()?;
        if inner.closing {
            return None;
        }
        inner.next_id = inner.next_id.checked_add(1)?;
        Some(inner.next_id)
    }

    fn register(&self, id: u64, handle: ConnectionHandle) -> bool {
        let Ok(mut inner) = self.inner.lock() else {
            return false;
        };
        if inner.closing {
            return false;
        }
        inner.connections.insert(id, handle);
        self.changed.notify_waiters();
        true
    }

    fn unregister(&self, id: u64) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.connections.remove(&id);
        }
        self.changed.notify_waiters();
    }

    fn active_count(&self) -> usize {
        self.inner.lock().map_or(0, |inner| inner.connections.len())
    }
}

/// The transport's required hook into a viewer's connection lifetime — the
/// anti-corruption boundary between this event transport and presence. The
/// transport reports admission (`on_connect`) and termination (`on_disconnect`)
/// and nothing else: it never learns how, or whether, those become presence
/// facts, and it carries no clock or timestamp of its own. A presence adapter
/// behind this port samples the disconnect clock and seals the last-seen instant;
/// the transport stays oblivious.
pub trait ConnectionLifecycle: Send + Sync {
    fn on_connect(&self, viewer: &UserId, connection_id: &str);
    fn on_disconnect(&self, viewer: &UserId, connection_id: &str);
}

/// Null lifecycle for transports composed without presence — in-crate tests, and
/// (as a locally-defined twin) the integration test crates. It is an explicit,
/// named "observe nothing", not a silent default; it is `#[cfg(test)]` so no
/// production composition can name it, and the compiler — not a lint — is what
/// forbids shipping a transport that silently observes no presence. Production
/// composes [`crate::viewer_read_model::presence::PresenceConnectionFeed`] instead.
#[cfg(test)]
pub(crate) struct NoopConnectionLifecycle;

#[cfg(test)]
impl ConnectionLifecycle for NoopConnectionLifecycle {
    fn on_connect(&self, _viewer: &UserId, _connection_id: &str) {}
    fn on_disconnect(&self, _viewer: &UserId, _connection_id: &str) {}
}

/// RAII bracket guaranteeing `on_disconnect` fires exactly once for a connection
/// that was admitted with `on_connect`. It is constructed only after the
/// `Authenticated` frame is sent, so a socket that never authenticated is never
/// counted online; and its `Drop` runs on every way [`connection`] can end —
/// normal close, server shutdown, protocol error, or task abort — so the pairing
/// holds without enumerating the loop's exit points.
struct ConnectionLifetime {
    lifecycle: Arc<dyn ConnectionLifecycle>,
    viewer: UserId,
    connection_id: String,
}

impl ConnectionLifetime {
    fn begin(
        lifecycle: Arc<dyn ConnectionLifecycle>,
        viewer: UserId,
        connection_id: String,
    ) -> Self {
        lifecycle.on_connect(&viewer, &connection_id);
        Self {
            lifecycle,
            viewer,
            connection_id,
        }
    }
}

impl Drop for ConnectionLifetime {
    fn drop(&mut self) {
        self.lifecycle
            .on_disconnect(&self.viewer, &self.connection_id);
    }
}

#[derive(Clone)]
pub struct EventWebSocketController {
    registry: ConnectionRegistry,
    shutdown_grace: Duration,
}

impl EventWebSocketController {
    pub fn active_connection_count(&self) -> usize {
        self.registry.active_count()
    }

    pub async fn close(&self) {
        let aborts = {
            let Ok(mut inner) = self.registry.inner.lock() else {
                return;
            };
            inner.closing = true;
            inner
                .connections
                .values()
                .map(|handle| {
                    let _ = handle.shutdown.send(true);
                    handle.abort.clone()
                })
                .collect::<Vec<_>>()
        };
        let deadline = Instant::now() + self.shutdown_grace;
        loop {
            if self.active_connection_count() == 0 {
                return;
            }
            if tokio::time::timeout_at(deadline, self.registry.changed.notified())
                .await
                .is_err()
            {
                break;
            }
        }
        for abort in aborts {
            abort.abort();
        }
        while self.active_connection_count() != 0 {
            self.registry.changed.notified().await;
        }
    }
}

pub fn router<A, S>(
    hub: ScopeEventHub,
    sessions: A,
    scope_authority: S,
    lifecycle: Arc<dyn ConnectionLifecycle>,
    config: EventWebSocketConfig,
) -> (Router, EventWebSocketController)
where
    A: AuthenticateHumanSession,
    S: AuthorizeEventScope,
{
    let registry = ConnectionRegistry::default();
    let controller = EventWebSocketController {
        registry: registry.clone(),
        shutdown_grace: config.shutdown_grace,
    };
    let state = EventServerState {
        hub,
        sessions,
        scope_authority,
        config,
        registry,
        lifecycle,
    };
    let router = Router::new()
        .route(EVENT_WEBSOCKET_PATH, get(event_websocket::<A, S>))
        .with_state(state);
    (router, controller)
}

async fn event_websocket<A, S>(
    State(state): State<EventServerState<A, S>>,
    websocket: WebSocketUpgrade,
    headers: HeaderMap,
) -> Response
where
    A: AuthenticateHumanSession,
    S: AuthorizeEventScope,
{
    if !origin_allowed(&headers, &state.config) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Some(bearer) = cookie_bearer(&headers) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let viewer = match state.sessions.authenticate_session(bearer).await {
        Ok(Some(viewer)) => viewer,
        Ok(None) => return StatusCode::UNAUTHORIZED.into_response(),
        Err(cause) => {
            tracing::error!(
                error_chain = crate::foundation::safe_log_field::safe_display(
                    &(crate::foundation::error::describe(&cause))
                ),
                "event websocket session authentication failed"
            );
            return (StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error").into_response();
        }
    };
    let client_epoch = desktop_epoch(&headers);
    if client_epoch < state.config.minimum_client_epoch {
        return (
            StatusCode::UPGRADE_REQUIRED,
            Json(serde_json::json!({
                "error": "upgrade_required",
                "reason": "client_too_old",
                "server_api_epoch": DESKTOP_SERVER_API_EPOCH,
                "minimum_client_epoch": state.config.minimum_client_epoch,
            })),
        )
            .into_response();
    }
    if state.registry.is_closing() {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    websocket
        .max_message_size(MAX_INBOUND_BYTES)
        .max_frame_size(MAX_INBOUND_BYTES)
        .on_upgrade(move |socket| accept_connection(socket, state, viewer))
}

impl ConnectionRegistry {
    fn is_closing(&self) -> bool {
        self.inner.lock().map_or(true, |inner| inner.closing)
    }
}

async fn accept_connection<A, S>(socket: WebSocket, state: EventServerState<A, S>, viewer: UserId)
where
    A: AuthenticateHumanSession,
    S: AuthorizeEventScope,
{
    let Some(id) = state.registry.allocate_id() else {
        return;
    };
    let (shutdown, shutdown_rx) = watch::channel(false);
    let (start, started) = oneshot::channel();
    let worker_state = state.clone();
    let worker = tokio::spawn(async move {
        if started.await.is_ok() {
            connection(socket, worker_state, viewer, id, shutdown_rx).await;
        }
    });
    let abort = worker.abort_handle();
    if !state
        .registry
        .register(id, ConnectionHandle { shutdown, abort })
    {
        worker.abort();
        return;
    }
    let _ = start.send(());
    let _ = worker.await;
    state.registry.unregister(id);
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientFrame {
    Subscribe {
        scope: serde_json::Value,
    },
    Unsubscribe {
        scope: serde_json::Value,
    },
    Resume {
        scopes: HashMap<String, ResumePosition>,
    },
    Pong,
    Auth,
}

#[derive(Deserialize)]
struct ResumePosition {
    epoch: String,
    #[serde(rename = "lastSeq")]
    last_seq: TransportSeq,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ServerFrame<'a> {
    Authenticated {
        #[serde(rename = "viewerId")]
        viewer_id: &'a str,
        epoch: &'a str,
    },
    Subscribed {
        scope: String,
        epoch: &'a str,
        seq: TransportSeq,
    },
    Ping,
    SnapshotRequired {
        scope: String,
        reason: &'static str,
        epoch: &'a str,
        #[serde(rename = "currentSeq")]
        current_seq: TransportSeq,
    },
    Error {
        code: &'static str,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        scope: Option<String>,
    },
}

struct ConnectionEvent {
    scope: EventScope,
    token: Arc<()>,
    event: QueuedScopeEvent,
}

enum QueuedScopeEvent {
    Event(ScopedEvent),
    Snapshot { current_seq: TransportSeq },
    Failure(Box<dyn Error + Send + Sync>),
}

struct ActiveSubscription {
    task: JoinHandle<()>,
    token: Arc<()>,
}

fn cancel_subscription(
    subscriptions: &mut HashMap<EventScope, ActiveSubscription>,
    scope: &EventScope,
) {
    if let Some(active) = subscriptions.remove(scope) {
        active.task.abort();
    }
}

#[derive(Default)]
struct Heartbeat {
    awaiting_pong: bool,
}

impl Heartbeat {
    fn on_ping_due(&mut self) -> HeartbeatAction {
        if self.awaiting_pong {
            HeartbeatAction::Close
        } else {
            self.awaiting_pong = true;
            HeartbeatAction::Ping
        }
    }

    fn on_pong(&mut self) {
        self.awaiting_pong = false;
    }
}

enum HeartbeatAction {
    Ping,
    Close,
}

async fn connection<A, S>(
    mut socket: WebSocket,
    state: EventServerState<A, S>,
    viewer: UserId,
    connection_id: u64,
    mut shutdown: watch::Receiver<bool>,
) where
    A: AuthenticateHumanSession,
    S: AuthorizeEventScope,
{
    if send_server(
        &mut socket,
        &ServerFrame::Authenticated {
            viewer_id: viewer.as_str(),
            epoch: state.hub.epoch(),
        },
    )
    .await
    .is_err()
    {
        return;
    }
    // Admission succeeded: from here the connection counts as online, and the
    // bracket's Drop guarantees the matching disconnect on every exit below.
    let _lifetime = ConnectionLifetime::begin(
        state.lifecycle.clone(),
        viewer.clone(),
        connection_id.to_string(),
    );
    let (events_tx, mut events_rx) = mpsc::channel(CONNECTION_QUEUE_CAPACITY);
    let mut subscriptions: HashMap<EventScope, ActiveSubscription> = HashMap::new();
    let mut heartbeat = Heartbeat::default();
    let mut ping = tokio::time::interval_at(
        Instant::now() + state.config.ping_interval,
        state.config.ping_interval,
    );
    let mut pong_deadline: Option<Pin<Box<Sleep>>> = None;

    loop {
        tokio::select! {
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    let _ = close(&mut socket, 1001, "server_shutdown").await;
                    break;
                }
            }
            _ = ping.tick() => {
                match heartbeat.on_ping_due() {
                    HeartbeatAction::Ping => {
                        if send_server(&mut socket, &ServerFrame::Ping).await.is_err() { break; }
                        pong_deadline = Some(Box::pin(tokio::time::sleep(state.config.pong_timeout)));
                    }
                    HeartbeatAction::Close => {
                        let _ = close(&mut socket, 1008, "pong_timeout").await;
                        break;
                    }
                }
            }
            _ = wait_deadline(&mut pong_deadline) => {
                if heartbeat.awaiting_pong {
                    let _ = close(&mut socket, 1008, "pong_timeout").await;
                    break;
                }
            }
            inbound = socket.recv() => {
                let Some(inbound) = inbound else { break };
                let Ok(message) = inbound else { break };
                match message {
                    Message::Text(text) => {
                        let Ok(frame) = serde_json::from_str::<ClientFrame>(&text) else {
                            let _ = protocol_close(&mut socket).await;
                            break;
                        };
                        if matches!(frame, ClientFrame::Pong) {
                            heartbeat.on_pong();
                            pong_deadline = None;
                            continue;
                        }
                        if handle_client_frame(
                            &mut socket,
                            &state,
                            &viewer,
                            frame,
                            &events_tx,
                            &mut subscriptions,
                        ).await.is_err() { break; }
                    }
                    Message::Pong(_) => {}
                    Message::Close(_) => break,
                    Message::Ping(payload) => {
                        if socket.send(Message::Pong(payload)).await.is_err() { break; }
                    }
                    Message::Binary(_) => { let _ = protocol_close(&mut socket).await; break; }
                }
            }
            event = events_rx.recv() => {
                let Some(queued) = event else { break };
                // A canceled/replaced subscription cannot leak already queued work,
                // including a stale lag/failure notification into its successor.
                if !subscriptions.get(&queued.scope).is_some_and(|active| Arc::ptr_eq(&active.token, &queued.token)) {
                    continue;
                }
                match authorize_or_error(&mut socket, &state.scope_authority, &viewer, &queued.scope).await {
                    Ok(true) => {},
                    Ok(false) => {
                        cancel_subscription(&mut subscriptions, &queued.scope);
                        continue;
                    }
                    Err(()) => break,
                }
                match queued.event {
                    QueuedScopeEvent::Event(event) => {
                        if send_json(&mut socket, &event).await.is_err() { break; }
                    }
                    QueuedScopeEvent::Snapshot { current_seq } => {
                        cancel_subscription(&mut subscriptions, &queued.scope);
                        if send_server(&mut socket, &ServerFrame::SnapshotRequired {
                            scope: scope_wire(&queued.scope),
                            reason: "gap_too_large",
                            epoch: state.hub.epoch(),
                            current_seq,
                        }).await.is_err() { break; }
                    }
                    QueuedScopeEvent::Failure(cause) => {
                        tracing::error!(
                            error_chain = crate::foundation::safe_log_field::safe_display(&(crate::foundation::error::describe(cause.as_ref()))),
                            "scope event delivery failed"
                        );
                        let _ = close(&mut socket, 1011, "internal_error").await;
                        break;
                    }
                }
            }
        }
    }
    for active in subscriptions.into_values() {
        active.task.abort();
    }
}

async fn handle_client_frame<A, S>(
    socket: &mut WebSocket,
    state: &EventServerState<A, S>,
    viewer: &UserId,
    frame: ClientFrame,
    events_tx: &mpsc::Sender<ConnectionEvent>,
    subscriptions: &mut HashMap<EventScope, ActiveSubscription>,
) -> Result<(), ()>
where
    A: AuthenticateHumanSession,
    S: AuthorizeEventScope,
{
    match frame {
        ClientFrame::Subscribe { scope } => {
            let Some(scope) = parsed_scope_or_error(socket, scope, viewer).await? else {
                return Ok(());
            };
            cancel_subscription(subscriptions, &scope);
            if !authorize_or_error(socket, &state.scope_authority, viewer, &scope).await? {
                return Ok(());
            }
            let subscription = hub_or_close(socket, state.hub.subscribe(scope.clone())).await?;
            let seq = subscription.current_seq;
            replace_subscription(
                subscriptions,
                scope.clone(),
                relay(
                    subscription,
                    state.hub.clone(),
                    scope.clone(),
                    events_tx.clone(),
                ),
            );
            send_server(
                socket,
                &ServerFrame::Subscribed {
                    scope: scope_wire(&scope),
                    epoch: state.hub.epoch(),
                    seq,
                },
            )
            .await
        }
        ClientFrame::Unsubscribe { scope } => {
            let Some(scope) = parsed_scope_or_error(socket, scope, viewer).await? else {
                return Ok(());
            };
            if let Some(active) = subscriptions.remove(&scope) {
                active.task.abort();
            }
            Ok(())
        }
        ClientFrame::Resume { scopes } => {
            'scopes: for (raw, position) in scopes {
                let Some(scope) =
                    parsed_scope_or_error(socket, serde_json::Value::String(raw), viewer).await?
                else {
                    continue;
                };
                if !authorize_or_error(socket, &state.scope_authority, viewer, &scope).await? {
                    cancel_subscription(subscriptions, &scope);
                    continue;
                }
                let Ok(epoch) = TransportEpoch::parse(position.epoch) else {
                    send_server(
                        socket,
                        &ServerFrame::Error {
                            scope: None,
                            code: "invalid_frame",
                            message: "invalid resume position".to_owned(),
                        },
                    )
                    .await?;
                    continue;
                };
                cancel_subscription(subscriptions, &scope);
                let resumed =
                    hub_or_close(socket, state.hub.resume(&scope, &epoch, position.last_seq))
                        .await?;
                match resumed.replay {
                    Replay::Events(events) => {
                        for event in events {
                            if !authorize_or_error(socket, &state.scope_authority, viewer, &scope)
                                .await?
                            {
                                // Do not install the resumed relay after mid-replay denial.
                                continue 'scopes;
                            }
                            send_json(socket, &event).await?;
                        }
                        if let Some(subscription) = resumed.subscription {
                            replace_subscription(
                                subscriptions,
                                scope.clone(),
                                relay(
                                    subscription,
                                    state.hub.clone(),
                                    scope.clone(),
                                    events_tx.clone(),
                                ),
                            );
                        }
                    }
                    Replay::SnapshotRequired {
                        reason,
                        current_seq,
                    } => {
                        send_server(
                            socket,
                            &ServerFrame::SnapshotRequired {
                                scope: scope_wire(&scope),
                                reason,
                                epoch: state.hub.epoch(),
                                current_seq,
                            },
                        )
                        .await?;
                    }
                }
            }
            Ok(())
        }
        ClientFrame::Pong => Ok(()),
        ClientFrame::Auth => {
            send_server(
                socket,
                &ServerFrame::Error {
                    scope: None,
                    code: "invalid_frame",
                    message: "already authenticated".to_owned(),
                },
            )
            .await
        }
    }
}

fn replace_subscription(
    subscriptions: &mut HashMap<EventScope, ActiveSubscription>,
    scope: EventScope,
    active: ActiveSubscription,
) {
    if let Some(previous) = subscriptions.insert(scope, active) {
        previous.task.abort();
    }
}

fn relay(
    mut subscription: Subscription,
    hub: ScopeEventHub,
    scope: EventScope,
    output: mpsc::Sender<ConnectionEvent>,
) -> ActiveSubscription {
    let token = Arc::new(());
    let queued_token = token.clone();
    let task = tokio::spawn(async move {
        loop {
            let (event, terminal) = match subscription.receiver.recv().await {
                Ok(event) => (QueuedScopeEvent::Event(event), false),
                Err(broadcast::error::RecvError::Lagged(_)) => (
                    match hub.current_seq(&scope) {
                        Ok(current_seq) => QueuedScopeEvent::Snapshot { current_seq },
                        Err(cause) => QueuedScopeEvent::Failure(Box::new(cause)),
                    },
                    true,
                ),
                Err(broadcast::error::RecvError::Closed) => return,
            };
            if output
                .send(ConnectionEvent {
                    scope: scope.clone(),
                    token: queued_token.clone(),
                    event,
                })
                .await
                .is_err()
                || terminal
            {
                return;
            }
        }
    });
    ActiveSubscription { task, token }
}

async fn authorize_or_error<S>(
    socket: &mut WebSocket,
    authority: &S,
    viewer: &UserId,
    scope: &EventScope,
) -> Result<bool, ()>
where
    S: AuthorizeEventScope,
{
    match authority.authorize_event_scope(viewer, scope).await {
        Ok(true) => Ok(true),
        Ok(false) => {
            send_server(
                socket,
                &ServerFrame::Error {
                    scope: Some(scope_wire(scope)),
                    code: "forbidden",
                    message: format!("not allowed to subscribe to {}", scope_wire(scope)),
                },
            )
            .await?;
            Ok(false)
        }
        Err(cause) => {
            tracing::error!(
                error_chain = crate::foundation::safe_log_field::safe_display(
                    &(crate::foundation::error::describe(&cause))
                ),
                "scope subscription authorization failed"
            );
            close(socket, 1011, "internal_error").await?;
            Err(())
        }
    }
}

async fn hub_or_close<T>(
    socket: &mut WebSocket,
    result: Result<T, ScopeEventHubError>,
) -> Result<T, ()> {
    match result {
        Ok(value) => Ok(value),
        Err(cause) => {
            tracing::error!(
                error_chain = crate::foundation::safe_log_field::safe_display(
                    &(crate::foundation::error::describe(&cause))
                ),
                "scope event registry failed"
            );
            close(socket, 1011, "internal_error").await?;
            Err(())
        }
    }
}

async fn parsed_scope_or_error(
    socket: &mut WebSocket,
    raw: serde_json::Value,
    viewer: &UserId,
) -> Result<Option<EventScope>, ()> {
    let Some(raw) = raw.as_str() else {
        send_server(
            socket,
            &ServerFrame::Error {
                scope: None,
                code: "invalid_frame",
                message: "scope must be a string".to_owned(),
            },
        )
        .await?;
        return Ok(None);
    };
    match parse_scope(raw, viewer) {
        Ok(scope) => Ok(Some(scope)),
        Err(()) => {
            send_server(
                socket,
                &ServerFrame::Error {
                    scope: None,
                    code: "unknown_scope",
                    message: format!("unknown scope: {raw}"),
                },
            )
            .await?;
            Ok(None)
        }
    }
}

fn parse_scope(raw: &str, viewer: &UserId) -> Result<EventScope, ()> {
    if raw == "app" {
        return Ok(EventScope::App);
    }
    let (prefix, id) = raw.split_once(':').ok_or(())?;
    if id.is_empty() {
        return Err(());
    }
    match prefix {
        "agent" => AgentId::parse(id.to_owned())
            .map(EventScope::Agent)
            .map_err(|_| ()),
        "workspace" => WorkspaceId::parse(id.to_owned())
            .map(EventScope::Workspace)
            .map_err(|_| ()),
        "conversation" => ConversationId::parse(id.to_owned())
            .map(EventScope::Conversation)
            .map_err(|_| ()),
        "conversation-side" => ConversationId::parse(id.to_owned())
            .map(EventScope::ConversationSide)
            .map_err(|_| ()),
        "viewer" if id == "self" => Ok(EventScope::Viewer(viewer.clone())),
        "viewer" => UserId::parse(id.to_owned())
            .map(EventScope::Viewer)
            .map_err(|_| ()),
        _ => Err(()),
    }
}

fn scope_wire(scope: &EventScope) -> String {
    match scope {
        EventScope::App => "app".to_owned(),
        EventScope::Agent(id) => format!("agent:{}", id.as_str()),
        EventScope::Workspace(id) => format!("workspace:{}", id.as_str()),
        EventScope::Conversation(id) => format!("conversation:{}", id.as_str()),
        EventScope::ConversationSide(id) => {
            format!("conversation-side:{}", id.as_str())
        }
        EventScope::Viewer(id) => format!("viewer:{}", id.as_str()),
    }
}

fn origin_allowed(headers: &HeaderMap, config: &EventWebSocketConfig) -> bool {
    let Some(origin) = headers.get(ORIGIN).and_then(|value| value.to_str().ok()) else {
        return false;
    };
    config
        .allowed_origins
        .contains(&AllowedOrigin(Arc::from(origin)))
}

fn cookie_bearer(headers: &HeaderMap) -> Option<SessionBearer> {
    let cookies = headers.get(COOKIE)?.to_str().ok()?;
    let mut selected = None;
    for part in cookies.split(';') {
        let Some((name, value)) = part.split_once('=') else {
            continue;
        };
        if name.trim() == EVENT_WS_SESSION_COOKIE {
            let raw = value.trim();
            selected = Some(percent_decode(raw).unwrap_or_else(|| raw.to_owned()));
        }
    }
    selected.and_then(SessionBearer::parse)
}

fn percent_decode(raw: &str) -> Option<String> {
    let bytes = raw.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let pair = bytes.get(index + 1..index + 3)?;
            let text = std::str::from_utf8(pair).ok()?;
            output.push(u8::from_str_radix(text, 16).ok()?);
            index += 3;
        } else {
            output.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(output).ok()
}

fn desktop_epoch(headers: &HeaderMap) -> u32 {
    let Some(raw) = headers
        .get(DESKTOP_API_EPOCH_HEADER)
        .and_then(|value| value.to_str().ok())
    else {
        return 0;
    };
    let raw = raw.trim();
    if raw.is_empty() || raw.len() > 9 || !raw.bytes().all(|byte| byte.is_ascii_digit()) {
        return 0;
    }
    raw.parse().unwrap_or(0)
}

async fn wait_deadline(deadline: &mut Option<Pin<Box<Sleep>>>) {
    match deadline {
        Some(deadline) => deadline.await,
        None => std::future::pending().await,
    }
}

async fn protocol_close(socket: &mut WebSocket) -> Result<(), ()> {
    let _ = send_server(
        socket,
        &ServerFrame::Error {
            scope: None,
            code: "invalid_frame",
            message: "frame must match the event websocket contract".to_owned(),
        },
    )
    .await;
    close(socket, 1002, "invalid_frame").await
}

async fn close(socket: &mut WebSocket, code: u16, reason: &'static str) -> Result<(), ()> {
    socket
        .send(Message::Close(Some(CloseFrame {
            code,
            reason: reason.into(),
        })))
        .await
        .map_err(|_| ())
}

async fn send_server(socket: &mut WebSocket, frame: &ServerFrame<'_>) -> Result<(), ()> {
    send_json(socket, frame).await
}

async fn send_json(socket: &mut WebSocket, frame: &impl Serialize) -> Result<(), ()> {
    let json = serde_json::to_string(frame).map_err(|cause| {
        tracing::error!(
            error_chain = crate::foundation::safe_log_field::safe_display(
                &(crate::foundation::error::describe(&cause))
            ),
            "scope frame serialization failed"
        );
    })?;
    socket
        .send(Message::Text(json.into()))
        .await
        .map_err(|_| ())
}

#[cfg(test)]
#[path = "scope_event_contract_tests.rs"]
mod tests;
