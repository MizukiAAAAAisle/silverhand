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
    auth::{AuthenticateHumanSession, SessionBearer},
    identity::{ConversationId, UserId, WorkspaceId},
    scope_event::{AuthorizeEventScope, EventScope},
};
use tokio::{
    sync::{Notify, broadcast, mpsc, oneshot, watch},
    task::{AbortHandle, JoinHandle},
    time::{Instant, Sleep},
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
struct TransportSeq(u64);

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

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", content = "payload", rename_all = "snake_case")]
enum ProductEvent {
    DirectPairsChanged {
        conversation_id: String,
    },
    #[cfg(test)]
    Test {
        value: String,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
struct ScopedEvent {
    #[serde(rename = "type")]
    frame_type: &'static str,
    scope: String,
    seq: TransportSeq,
    epoch: String,
    #[serde(flatten)]
    event: ProductEvent,
}

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

    pub fn publish_direct_pairs_changed(
        &self,
        viewer: &UserId,
        conversation: &ConversationId,
    ) -> Result<(), ScopeEventHubError> {
        self.publish(
            EventScope::Viewer(viewer.clone()),
            ProductEvent::DirectPairsChanged {
                conversation_id: conversation.as_str().to_owned(),
            },
        )
    }

    fn publish(&self, scope: EventScope, event: ProductEvent) -> Result<(), ScopeEventHubError> {
        let mut scopes = self
            .scopes
            .lock()
            .map_err(|_| ScopeEventHubError::RegistryPoisoned)?;
        let state = scopes.entry(scope.clone()).or_insert_with(ScopeState::new);
        state.seq = state.seq.checked_next()?;
        let frame = ScopedEvent {
            frame_type: "event",
            scope: scope_wire(&scope),
            seq: state.seq,
            epoch: self.epoch().to_owned(),
            event,
        };
        if state.replay.len() == REPLAY_CAPACITY {
            state.replay.pop_front();
        }
        state.replay.push_back(frame.clone());
        let _ = state.live.send(frame);
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
        let earliest = state.replay.front().map_or(state.seq, |event| event.seq);
        if last_seq.0.saturating_add(1) < earliest.0 {
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
                error_chain = %crate::error::describe(&cause),
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
            connection(socket, worker_state, viewer, shutdown_rx).await;
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
    },
}

enum ConnectionEvent {
    Event(ScopedEvent),
    Snapshot {
        scope: EventScope,
        current_seq: TransportSeq,
    },
    Failure(Box<dyn Error + Send + Sync>),
}

struct ActiveSubscription {
    task: JoinHandle<()>,
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
                match event {
                    Some(ConnectionEvent::Event(event)) => {
                        if send_json(&mut socket, &event).await.is_err() { break; }
                    }
                    Some(ConnectionEvent::Snapshot { scope, current_seq }) => {
                        if send_server(&mut socket, &ServerFrame::SnapshotRequired {
                            scope: scope_wire(&scope),
                            reason: "gap_too_large",
                            epoch: state.hub.epoch(),
                            current_seq,
                        }).await.is_err() { break; }
                        if let Some(active) = subscriptions.remove(&scope) { active.task.abort(); }
                    }
                    Some(ConnectionEvent::Failure(cause)) => {
                        tracing::error!(
                            error_chain = %crate::error::describe(cause.as_ref()),
                            "scope event delivery failed"
                        );
                        let _ = close(&mut socket, 1011, "internal_error").await;
                        break;
                    }
                    None => break,
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
                    state.scope_authority.clone(),
                    viewer.clone(),
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
            for (raw, position) in scopes {
                let Some(scope) =
                    parsed_scope_or_error(socket, serde_json::Value::String(raw), viewer).await?
                else {
                    continue;
                };
                if !authorize_or_error(socket, &state.scope_authority, viewer, &scope).await? {
                    continue;
                }
                let Ok(epoch) = TransportEpoch::parse(position.epoch) else {
                    send_server(
                        socket,
                        &ServerFrame::Error {
                            code: "invalid_frame",
                            message: "invalid resume position".to_owned(),
                        },
                    )
                    .await?;
                    continue;
                };
                let resumed =
                    hub_or_close(socket, state.hub.resume(&scope, &epoch, position.last_seq))
                        .await?;
                match resumed.replay {
                    Replay::Events(events) => {
                        for event in events {
                            match state
                                .scope_authority
                                .authorize_event_scope(viewer, &scope)
                                .await
                            {
                                Ok(true) => send_json(socket, &event).await?,
                                Ok(false) => break,
                                Err(cause) => {
                                    tracing::error!(
                                        error_chain = %crate::error::describe(&cause),
                                        "scope replay authorization failed"
                                    );
                                    close(socket, 1011, "internal_error").await?;
                                    return Err(());
                                }
                            }
                        }
                        if let Some(subscription) = resumed.subscription {
                            replace_subscription(
                                subscriptions,
                                scope.clone(),
                                relay(
                                    subscription,
                                    state.hub.clone(),
                                    state.scope_authority.clone(),
                                    viewer.clone(),
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
    task: JoinHandle<()>,
) {
    if let Some(previous) = subscriptions.insert(scope, ActiveSubscription { task }) {
        previous.task.abort();
    }
}

fn relay<S>(
    mut subscription: Subscription,
    hub: ScopeEventHub,
    authority: S,
    viewer: UserId,
    scope: EventScope,
    output: mpsc::Sender<ConnectionEvent>,
) -> JoinHandle<()>
where
    S: AuthorizeEventScope,
{
    tokio::spawn(async move {
        loop {
            match subscription.receiver.recv().await {
                Ok(event) => match authority.authorize_event_scope(&viewer, &scope).await {
                    Ok(true) => {
                        if output.send(ConnectionEvent::Event(event)).await.is_err() {
                            return;
                        }
                    }
                    Ok(false) => {}
                    Err(cause) => {
                        let _ = output.send(ConnectionEvent::Failure(Box::new(cause))).await;
                        return;
                    }
                },
                Err(broadcast::error::RecvError::Lagged(_)) => match hub.current_seq(&scope) {
                    Ok(current_seq) => {
                        let _ = output
                            .send(ConnectionEvent::Snapshot { scope, current_seq })
                            .await;
                        return;
                    }
                    Err(cause) => {
                        let _ = output.send(ConnectionEvent::Failure(Box::new(cause))).await;
                        return;
                    }
                },
                Err(broadcast::error::RecvError::Closed) => return,
            }
        }
    })
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
                    code: "forbidden",
                    message: format!("not allowed to subscribe to {}", scope_wire(scope)),
                },
            )
            .await?;
            Ok(false)
        }
        Err(cause) => {
            tracing::error!(
                error_chain = %crate::error::describe(&cause),
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
                error_chain = %crate::error::describe(&cause),
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
            error_chain = %crate::error::describe(&cause),
            "scope frame serialization failed"
        );
    })?;
    socket
        .send(Message::Text(json.into()))
        .await
        .map_err(|_| ())
}

#[cfg(test)]
mod tests {
    use futures_util::{SinkExt, StreamExt};
    use silverhand_backend_core::{
        auth::{AuthenticateHumanSession, SessionBearer},
        persistence::PersistenceFailure,
        scope_event::AuthorizeEventScope,
    };
    use tokio_tungstenite::{
        connect_async,
        tungstenite::{Message as ClientMessage, client::IntoClientRequest},
    };

    use super::*;

    fn user() -> UserId {
        UserId::parse("user-1").unwrap()
    }

    fn conversation() -> ConversationId {
        ConversationId::parse("pair-1").unwrap()
    }

    #[test]
    fn transport_coordinates_reject_invalid_values() {
        assert!(TransportEpoch::parse("").is_err());
        assert!(AllowedOrigin::parse("https://example.test/path").is_err());
        assert!(AllowedOrigin::parse("ws://example.test").is_err());
        assert!(EventWebSocketConfig::production([]).is_err());
        assert!(serde_json::from_str::<TransportSeq>("9007199254740992").is_err());
        assert_eq!(
            serde_json::from_str::<TransportSeq>("9007199254740991")
                .unwrap()
                .0,
            MAX_TRANSPORT_SEQ
        );
    }

    #[test]
    fn direct_pair_projection_is_replayable_and_sequence_is_exact_for_javascript() {
        let hub = ScopeEventHub::test("epoch-1");
        hub.publish_direct_pairs_changed(&user(), &conversation())
            .unwrap();
        hub.publish_direct_pairs_changed(&user(), &conversation())
            .unwrap();
        let resumed = hub
            .resume(
                &EventScope::Viewer(user()),
                &TransportEpoch::parse("epoch-1").unwrap(),
                TransportSeq::ZERO,
            )
            .unwrap();
        let Replay::Events(events) = resumed.replay else {
            panic!("same epoch must replay")
        };
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].seq, TransportSeq(1));
        assert_eq!(
            serde_json::to_value(&events[0]).unwrap(),
            serde_json::json!({
                "type": "event", "scope": "viewer:user-1", "seq": 1,
                "epoch": "epoch-1", "kind": "direct_pairs_changed",
                "payload": { "conversation_id": "pair-1" }
            })
        );

        let mut scopes = hub.scopes.lock().unwrap();
        scopes.get_mut(&EventScope::Viewer(user())).unwrap().seq = TransportSeq(MAX_TRANSPORT_SEQ);
        drop(scopes);
        assert!(matches!(
            hub.publish_direct_pairs_changed(&user(), &conversation()),
            Err(ScopeEventHubError::SequenceExhausted)
        ));
    }

    #[tokio::test]
    async fn resume_registers_live_before_releasing_snapshot() {
        let hub = ScopeEventHub::test("epoch-1");
        hub.publish_direct_pairs_changed(&user(), &conversation())
            .unwrap();
        let resumed = hub
            .resume(
                &EventScope::Viewer(user()),
                &TransportEpoch::parse("epoch-1").unwrap(),
                TransportSeq::ZERO,
            )
            .unwrap();
        let mut live = resumed.subscription.unwrap().receiver;
        hub.publish_direct_pairs_changed(&user(), &conversation())
            .unwrap();
        assert_eq!(live.recv().await.unwrap().seq, TransportSeq(2));
    }

    #[test]
    fn heartbeat_requires_a_pong_before_the_deadline() {
        let mut heartbeat = Heartbeat::default();
        assert!(matches!(heartbeat.on_ping_due(), HeartbeatAction::Ping));
        assert!(matches!(heartbeat.on_ping_due(), HeartbeatAction::Close));
        heartbeat.on_pong();
        assert!(matches!(heartbeat.on_ping_due(), HeartbeatAction::Ping));
    }

    #[derive(Clone)]
    struct Allows;

    impl AuthorizeEventScope for Allows {
        async fn authorize_event_scope(
            &self,
            _viewer: &UserId,
            _scope: &EventScope,
        ) -> Result<bool, PersistenceFailure> {
            Ok(true)
        }
    }

    #[derive(Clone)]
    struct Sessions;

    impl AuthenticateHumanSession for Sessions {
        async fn authenticate_session(
            &self,
            _bearer: SessionBearer,
        ) -> Result<Option<UserId>, PersistenceFailure> {
            Ok(Some(user()))
        }
    }

    #[tokio::test]
    async fn subscriptions_are_independent_for_the_complete_scope_key() {
        let hub = ScopeEventHub::test("epoch-1");
        let (output, mut received) = mpsc::channel(8);
        let viewer_scope = EventScope::Viewer(user());
        let conversation_scope = EventScope::Conversation(conversation());
        let viewer = relay(
            hub.subscribe(viewer_scope.clone()).unwrap(),
            hub.clone(),
            Allows,
            user(),
            viewer_scope,
            output.clone(),
        );
        let conversation = relay(
            hub.subscribe(conversation_scope.clone()).unwrap(),
            hub.clone(),
            Allows,
            user(),
            conversation_scope.clone(),
            output,
        );

        viewer.abort();
        hub.publish(
            conversation_scope,
            ProductEvent::Test {
                value: "still-live".to_owned(),
            },
        )
        .unwrap();
        let ConnectionEvent::Event(event) = received.recv().await.unwrap() else {
            panic!("expected event")
        };
        assert_eq!(event.scope, "conversation:pair-1");
        conversation.abort();
    }

    #[tokio::test]
    async fn a_poisoned_registry_never_becomes_a_zero_snapshot_baseline() {
        let hub = ScopeEventHub::test("epoch-1");
        let scope = EventScope::Viewer(user());
        let subscription = hub.subscribe(scope.clone()).unwrap();
        let sender = hub.scopes.lock().unwrap().get(&scope).unwrap().live.clone();
        for seq in 1..=(LIVE_CAPACITY * 2) {
            sender
                .send(ScopedEvent {
                    frame_type: "event",
                    scope: scope_wire(&scope),
                    seq: TransportSeq(seq as u64),
                    epoch: "epoch-1".to_owned(),
                    event: ProductEvent::Test {
                        value: "lag".to_owned(),
                    },
                })
                .unwrap();
        }
        let registry = Arc::clone(&hub.scopes);
        let _ = std::thread::spawn(move || {
            let _guard = registry.lock().unwrap();
            panic!("poison the test registry");
        })
        .join();

        let (output, mut received) = mpsc::channel(1);
        let task = relay(subscription, hub, Allows, user(), scope, output);
        let ConnectionEvent::Failure(cause) = received.recv().await.unwrap() else {
            panic!("registry failure must close, never emit a seq-zero snapshot")
        };
        assert_eq!(cause.to_string(), "scope event registry lock was poisoned");
        task.await.unwrap();
    }

    #[tokio::test]
    async fn one_socket_keeps_multiple_scopes_and_controller_closes_it() {
        let hub = ScopeEventHub::test("epoch-1");
        let origin = "http://127.0.0.1";
        let (app, controller) = router(
            hub.clone(),
            Sessions,
            Allows,
            EventWebSocketConfig::test(origin),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let mut socket = connect(address, origin).await;
        assert_eq!(next_json(&mut socket).await["type"], "authenticated");

        for scope in ["viewer:self", "conversation:pair-1"] {
            socket
                .send(ClientMessage::Text(
                    serde_json::json!({ "type": "subscribe", "scope": scope })
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
            assert_eq!(next_json(&mut socket).await["type"], "subscribed");
        }
        assert_eq!(controller.active_connection_count(), 1);

        hub.publish(
            EventScope::Viewer(user()),
            ProductEvent::Test {
                value: "viewer".to_owned(),
            },
        )
        .unwrap();
        hub.publish(
            EventScope::Conversation(conversation()),
            ProductEvent::Test {
                value: "conversation".to_owned(),
            },
        )
        .unwrap();
        let mut scopes = [
            next_json(&mut socket).await["scope"]
                .as_str()
                .unwrap()
                .to_owned(),
            next_json(&mut socket).await["scope"]
                .as_str()
                .unwrap()
                .to_owned(),
        ];
        scopes.sort();
        assert_eq!(scopes, ["conversation:pair-1", "viewer:user-1"]);

        socket
            .send(ClientMessage::Text(
                serde_json::json!({ "type": "unsubscribe", "scope": "viewer:self" })
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        socket
            .send(ClientMessage::Text(
                serde_json::json!({ "type": "subscribe", "scope": "app" })
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        assert_eq!(next_json(&mut socket).await["scope"], "app");
        hub.publish(
            EventScope::Viewer(user()),
            ProductEvent::Test {
                value: "must-not-arrive".to_owned(),
            },
        )
        .unwrap();
        hub.publish(
            EventScope::Conversation(conversation()),
            ProductEvent::Test {
                value: "still-live".to_owned(),
            },
        )
        .unwrap();
        let frame = next_json(&mut socket).await;
        assert_eq!(frame["scope"], "conversation:pair-1");
        assert_eq!(frame["payload"]["value"], "still-live");

        controller.close().await;
        let close = socket.next().await.unwrap().unwrap();
        let ClientMessage::Close(Some(close)) = close else {
            panic!("controller must close the socket")
        };
        assert_eq!(u16::from(close.code), 1001);
        assert_eq!(close.reason, "server_shutdown");
        assert_eq!(controller.active_connection_count(), 0);
        server.abort();
    }

    #[tokio::test]
    async fn missing_json_pong_closes_on_the_heartbeat_deadline() {
        let hub = ScopeEventHub::test("epoch-1");
        let origin = "http://127.0.0.1";
        let mut config = EventWebSocketConfig::test(origin);
        config.ping_interval = Duration::from_millis(20);
        config.pong_timeout = Duration::from_millis(20);
        let (app, controller) = router(hub, Sessions, Allows, config);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let mut socket = connect(address, origin).await;
        assert_eq!(next_json(&mut socket).await["type"], "authenticated");
        assert_eq!(next_json(&mut socket).await["type"], "ping");
        let close = tokio::time::timeout(Duration::from_secs(5), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let ClientMessage::Close(Some(close)) = close else {
            panic!("missing pong must close the socket")
        };
        assert_eq!(u16::from(close.code), 1008);
        assert_eq!(close.reason, "pong_timeout");
        controller.close().await;
        server.abort();
    }

    #[tokio::test]
    async fn control_pong_does_not_satisfy_the_json_heartbeat() {
        let hub = ScopeEventHub::test("epoch-1");
        let origin = "http://127.0.0.1";
        let mut config = EventWebSocketConfig::test(origin);
        config.ping_interval = Duration::from_millis(20);
        config.pong_timeout = Duration::from_millis(20);
        let (app, controller) = router(hub, Sessions, Allows, config);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let mut socket = connect(address, origin).await;
        assert_eq!(next_json(&mut socket).await["type"], "authenticated");
        assert_eq!(next_json(&mut socket).await["type"], "ping");
        socket
            .send(ClientMessage::Pong(Vec::new().into()))
            .await
            .unwrap();
        let close = tokio::time::timeout(Duration::from_secs(5), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let ClientMessage::Close(Some(close)) = close else {
            panic!("control pong must not clear the application heartbeat")
        };
        assert_eq!(u16::from(close.code), 1008);
        assert_eq!(close.reason, "pong_timeout");
        controller.close().await;
        server.abort();
    }

    #[tokio::test]
    async fn json_pong_clears_the_application_heartbeat() {
        let hub = ScopeEventHub::test("epoch-1");
        let origin = "http://127.0.0.1";
        let mut config = EventWebSocketConfig::test(origin);
        config.ping_interval = Duration::from_millis(20);
        config.pong_timeout = Duration::from_millis(20);
        let (app, controller) = router(hub, Sessions, Allows, config);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let mut socket = connect(address, origin).await;
        assert_eq!(next_json(&mut socket).await["type"], "authenticated");
        assert_eq!(next_json(&mut socket).await["type"], "ping");
        socket
            .send(ClientMessage::Text(
                serde_json::json!({ "type": "pong" }).to_string().into(),
            ))
            .await
            .unwrap();
        assert_eq!(next_json(&mut socket).await["type"], "ping");
        socket
            .send(ClientMessage::Text(
                serde_json::json!({ "type": "pong" }).to_string().into(),
            ))
            .await
            .unwrap();
        controller.close().await;
        let close = tokio::time::timeout(Duration::from_secs(5), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let ClientMessage::Close(Some(close)) = close else {
            panic!("controller must close a healthy socket")
        };
        assert_eq!(u16::from(close.code), 1001);
        assert_eq!(close.reason, "server_shutdown");
        server.abort();
    }

    #[tokio::test]
    async fn payload_over_sixty_four_kib_is_closed_before_json_dispatch() {
        let hub = ScopeEventHub::test("epoch-1");
        let origin = "http://127.0.0.1";
        let (app, controller) = router(hub, Sessions, Allows, EventWebSocketConfig::test(origin));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let mut socket = connect(address, origin).await;
        assert_eq!(next_json(&mut socket).await["type"], "authenticated");
        socket
            .send(ClientMessage::Text(
                format!("\"{}\"", "x".repeat(MAX_INBOUND_BYTES)).into(),
            ))
            .await
            .unwrap();
        let result = tokio::time::timeout(Duration::from_secs(5), socket.next())
            .await
            .unwrap();
        match result {
            Some(Ok(ClientMessage::Close(Some(close)))) => {
                assert_eq!(u16::from(close.code), 1009);
            }
            Some(Err(tokio_tungstenite::tungstenite::Error::Protocol(_)))
            | Some(Err(tokio_tungstenite::tungstenite::Error::Io(_)))
            | None => {}
            other => panic!("oversized payload must close before dispatch: {other:?}"),
        }
        controller.close().await;
        server.abort();
    }

    async fn connect(
        address: std::net::SocketAddr,
        origin: &str,
    ) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>
    {
        let mut request = format!("ws://{address}{EVENT_WEBSOCKET_PATH}")
            .into_client_request()
            .unwrap();
        request
            .headers_mut()
            .insert(ORIGIN, origin.parse().unwrap());
        request.headers_mut().insert(
            COOKIE,
            format!("{EVENT_WS_SESSION_COOKIE}=token").parse().unwrap(),
        );
        request
            .headers_mut()
            .insert(DESKTOP_API_EPOCH_HEADER, MINIMUM_CLIENT_API_EPOCH.into());
        connect_async(request).await.unwrap().0
    }

    async fn next_json<S>(socket: &mut tokio_tungstenite::WebSocketStream<S>) -> serde_json::Value
    where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
    {
        let ClientMessage::Text(frame) = socket.next().await.unwrap().unwrap() else {
            panic!("expected a text frame")
        };
        serde_json::from_str(&frame).unwrap()
    }
}
