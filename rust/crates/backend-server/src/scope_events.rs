//! Authenticated product event transport, keyed by the scope whose readers may
//! receive a frame.
//!
//! Publishers name a typed scope and a wire event. Connections never infer a
//! viewer from that payload: a parent authentication boundary supplies the sole
//! [`UserId`] fact, and this module admits only that viewer's private scope. The
//! hub owns per-scope sequence and replay state so later conversation/workspace
//! projectors can share this transport without sharing their product payloads.

use std::{
    collections::{HashMap, VecDeque},
    error::Error,
    fmt,
    sync::{Arc, Mutex},
};

use axum::{
    Router,
    extract::{Extension, State, ws::WebSocketUpgrade},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use silverhand_backend_core::identity::{ConversationId, UserId, WorkspaceId};
use tokio::sync::broadcast;

pub const EVENT_WEBSOCKET_PATH: &str = "/api/ws/events";
const REPLAY_CAPACITY: usize = 200;
const LIVE_CAPACITY: usize = 200;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub enum Scope {
    App,
    Workspace(WorkspaceId),
    Conversation(ConversationId),
    ConversationSide(ConversationId),
    Viewer(UserId),
}

impl Scope {
    pub fn viewer(viewer: UserId) -> Self {
        Self::Viewer(viewer)
    }

    pub fn as_wire(&self) -> String {
        match self {
            Self::App => "app".to_owned(),
            Self::Workspace(workspace) => format!("workspace:{}", workspace.as_str()),
            Self::Conversation(conversation) => {
                format!("conversation:{}", conversation.as_str())
            }
            Self::ConversationSide(conversation) => {
                format!("conversation-side:{}", conversation.as_str())
            }
            Self::Viewer(viewer) => format!("viewer:{}", viewer.as_str()),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", content = "payload", rename_all = "snake_case")]
enum ProductEvent {
    DirectPairsChanged { conversation_id: String },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
struct ScopedEvent {
    #[serde(rename = "type")]
    frame_type: &'static str,
    scope: String,
    seq: u64,
    epoch: String,
    #[serde(flatten)]
    event: ProductEvent,
}

#[derive(Debug)]
pub enum ScopeEventHubError {
    Entropy(getrandom::Error),
    SequenceExhausted,
    RegistryPoisoned,
}

impl fmt::Display for ScopeEventHubError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Entropy(_) => formatter
                .write_str("secure random source failed while creating the event transport epoch"),
            Self::SequenceExhausted => formatter.write_str("scope event sequence exhausted"),
            Self::RegistryPoisoned => formatter.write_str("scope event registry lock was poisoned"),
        }
    }
}

impl Error for ScopeEventHubError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Entropy(source) => Some(source),
            Self::SequenceExhausted | Self::RegistryPoisoned => None,
        }
    }
}

#[derive(Clone)]
pub struct ScopeEventHub {
    epoch: Arc<str>,
    scopes: Arc<Mutex<HashMap<Scope, ScopeState>>>,
}

struct ScopeState {
    seq: u64,
    replay: VecDeque<ScopedEvent>,
    live: broadcast::Sender<ScopedEvent>,
}

impl ScopeState {
    fn new() -> Self {
        let (live, _) = broadcast::channel(LIVE_CAPACITY);
        Self {
            seq: 0,
            replay: VecDeque::with_capacity(REPLAY_CAPACITY),
            live,
        }
    }
}

impl ScopeEventHub {
    pub fn production() -> Result<Self, ScopeEventHubError> {
        let mut entropy = [0_u8; 16];
        getrandom::fill(&mut entropy).map_err(ScopeEventHubError::Entropy)?;
        Ok(Self::with_epoch(URL_SAFE_NO_PAD.encode(entropy)))
    }

    pub fn with_epoch(epoch: impl Into<Arc<str>>) -> Self {
        Self {
            epoch: epoch.into(),
            scopes: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn epoch(&self) -> &str {
        &self.epoch
    }

    pub fn publish_direct_pairs_changed(
        &self,
        viewer: &UserId,
        conversation: &ConversationId,
    ) -> Result<(), ScopeEventHubError> {
        self.publish(
            Scope::viewer(viewer.clone()),
            ProductEvent::DirectPairsChanged {
                conversation_id: conversation.as_str().to_owned(),
            },
        )
    }

    fn publish(&self, scope: Scope, event: ProductEvent) -> Result<(), ScopeEventHubError> {
        let mut scopes = self
            .scopes
            .lock()
            .map_err(|_| ScopeEventHubError::RegistryPoisoned)?;
        let state = scopes.entry(scope.clone()).or_insert_with(ScopeState::new);
        state.seq = state
            .seq
            .checked_add(1)
            .ok_or(ScopeEventHubError::SequenceExhausted)?;
        let frame = ScopedEvent {
            frame_type: "event",
            scope: scope.as_wire(),
            seq: state.seq,
            epoch: self.epoch.to_string(),
            event,
        };
        if state.replay.len() == REPLAY_CAPACITY {
            state.replay.pop_front();
        }
        state.replay.push_back(frame.clone());
        let _ = state.live.send(frame);
        Ok(())
    }

    fn subscribe(&self, scope: Scope) -> Result<Subscription, ScopeEventHubError> {
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
        scope: &Scope,
        epoch: &str,
        last_seq: u64,
    ) -> Result<Resume, ScopeEventHubError> {
        let mut scopes = self
            .scopes
            .lock()
            .map_err(|_| ScopeEventHubError::RegistryPoisoned)?;
        let state = scopes.entry(scope.clone()).or_insert_with(ScopeState::new);
        if epoch != self.epoch() {
            return Ok(Resume {
                replay: Replay::SnapshotRequired {
                    reason: "epoch_mismatch",
                    current_seq: state.seq,
                },
                subscription: None,
            });
        }
        let earliest = state.replay.front().map_or(state.seq, |event| event.seq);
        if last_seq.saturating_add(1) < earliest {
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

    fn current_seq(&self, scope: &Scope) -> Result<u64, ScopeEventHubError> {
        let scopes = self
            .scopes
            .lock()
            .map_err(|_| ScopeEventHubError::RegistryPoisoned)?;
        Ok(scopes.get(scope).map_or(0, |state| state.seq))
    }
}

struct Subscription {
    current_seq: u64,
    receiver: broadcast::Receiver<ScopedEvent>,
}

enum Replay {
    Events(Vec<ScopedEvent>),
    SnapshotRequired {
        reason: &'static str,
        current_seq: u64,
    },
}

struct Resume {
    replay: Replay,
    subscription: Option<Subscription>,
}

pub fn router(hub: ScopeEventHub) -> Router {
    Router::new()
        .route(EVENT_WEBSOCKET_PATH, get(event_websocket))
        .with_state(hub)
}

async fn event_websocket(
    State(hub): State<ScopeEventHub>,
    principal: Option<Extension<UserId>>,
    websocket: WebSocketUpgrade,
) -> Response {
    let Some(Extension(viewer)) = principal else {
        tracing::error!("event websocket reached without its human principal fact");
        return (StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error").into_response();
    };
    websocket.on_upgrade(move |socket| connection(socket, hub, viewer))
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
    last_seq: u64,
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
        seq: u64,
    },
    SnapshotRequired {
        scope: String,
        reason: &'static str,
        epoch: &'a str,
        #[serde(rename = "currentSeq")]
        current_seq: u64,
    },
    Error {
        code: &'static str,
        message: String,
    },
}

async fn connection(mut socket: axum::extract::ws::WebSocket, hub: ScopeEventHub, viewer: UserId) {
    if send_server(
        &mut socket,
        &ServerFrame::Authenticated {
            viewer_id: viewer.as_str(),
            epoch: hub.epoch(),
        },
    )
    .await
    .is_err()
    {
        return;
    }

    let viewer_scope = Scope::viewer(viewer.clone());
    let mut subscription: Option<Subscription> = None;
    loop {
        tokio::select! {
            inbound = socket.recv() => {
                let Some(Ok(message)) = inbound else { return };
                let axum::extract::ws::Message::Text(text) = message else { continue };
                let frame = serde_json::from_str::<ClientFrame>(&text);
                match frame {
                    Ok(ClientFrame::Subscribe { scope }) => {
                        let Some(scope) = allowed_viewer_scope(&scope, &viewer) else {
                            let _ = send_server(&mut socket, &ServerFrame::Error {
                                code: if scope.is_string() { "forbidden" } else { "invalid_frame" },
                                message: "only the authenticated viewer scope may be subscribed".to_owned(),
                            }).await;
                            continue;
                        };
                        match hub.subscribe(viewer_scope.clone()) {
                            Ok(active) => {
                                let seq = active.current_seq;
                                subscription = Some(active);
                                if send_server(&mut socket, &ServerFrame::Subscribed {
                                    scope,
                                    epoch: hub.epoch(),
                                    seq,
                                }).await.is_err() { return; }
                            }
                            Err(error) => {
                                tracing::error!(error_chain = %crate::error::describe(&error), "scope subscription failed");
                                return;
                            }
                        }
                    }
                    Ok(ClientFrame::Unsubscribe { scope }) => {
                        if allowed_viewer_scope(&scope, &viewer).is_some() {
                            subscription = None;
                        }
                    }
                    Ok(ClientFrame::Resume { scopes }) => {
                        for (raw_scope, position) in scopes {
                            let scope_value = serde_json::Value::String(raw_scope.clone());
                            let Some(scope) = allowed_viewer_scope(&scope_value, &viewer) else {
                                let _ = send_server(&mut socket, &ServerFrame::Error {
                                    code: "forbidden",
                                    message: "only the authenticated viewer scope may be resumed".to_owned(),
                                }).await;
                                continue;
                            };
                            match hub.resume(&viewer_scope, &position.epoch, position.last_seq) {
                                Ok(Resume { replay: Replay::Events(events), subscription: resumed }) => {
                                    for event in events {
                                        if send_json(&mut socket, &event).await.is_err() { return; }
                                    }
                                    subscription = resumed;
                                }
                                Ok(Resume { replay: Replay::SnapshotRequired { reason, current_seq }, .. }) => {
                                    if send_server(&mut socket, &ServerFrame::SnapshotRequired {
                                        scope,
                                        reason,
                                        epoch: hub.epoch(),
                                        current_seq,
                                    }).await.is_err() { return; }
                                }
                                Err(error) => {
                                    tracing::error!(error_chain = %crate::error::describe(&error), "scope replay failed");
                                    return;
                                }
                            }
                        }
                    }
                    Ok(ClientFrame::Pong) => {}
                    Ok(ClientFrame::Auth) => {
                        let _ = send_server(&mut socket, &ServerFrame::Error {
                            code: "invalid_frame",
                            message: "already authenticated".to_owned(),
                        }).await;
                    }
                    Err(_) => {
                        let _ = send_server(&mut socket, &ServerFrame::Error {
                            code: "invalid_frame",
                            message: "frame must match the event websocket contract".to_owned(),
                        }).await;
                    }
                }
            }
            outbound = async {
                match subscription.as_mut() {
                    Some(active) => Some(active.receiver.recv().await),
                    None => std::future::pending().await,
                }
            } => {
                match outbound {
                    Some(Ok(event)) => {
                        if send_json(&mut socket, &event).await.is_err() { return; }
                    }
                    Some(Err(broadcast::error::RecvError::Lagged(_))) => {
                        let current_seq = hub.current_seq(&viewer_scope).unwrap_or(0);
                        let _ = send_server(&mut socket, &ServerFrame::SnapshotRequired {
                            scope: viewer_scope.as_wire(),
                            reason: "gap_too_large",
                            epoch: hub.epoch(),
                            current_seq,
                        }).await;
                        subscription = None;
                    }
                    Some(Err(broadcast::error::RecvError::Closed)) | None => return,
                }
            }
        }
    }
}

fn allowed_viewer_scope(raw: &serde_json::Value, viewer: &UserId) -> Option<String> {
    let raw = raw.as_str()?;
    let resolved = if raw == "viewer:self" {
        format!("viewer:{}", viewer.as_str())
    } else {
        raw.to_owned()
    };
    (resolved == format!("viewer:{}", viewer.as_str())).then_some(resolved)
}

async fn send_server(
    socket: &mut axum::extract::ws::WebSocket,
    frame: &ServerFrame<'_>,
) -> Result<(), ()> {
    send_json(socket, frame).await
}

async fn send_json(
    socket: &mut axum::extract::ws::WebSocket,
    frame: &impl Serialize,
) -> Result<(), ()> {
    let json = serde_json::to_string(frame).map_err(|error| {
        tracing::error!(error_chain = %crate::error::describe(&error), "scope frame serialization failed");
    })?;
    socket
        .send(axum::extract::ws::Message::Text(json.into()))
        .await
        .map_err(|_| ())
}

#[cfg(test)]
mod tests {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::{connect_async, tungstenite::Message};

    use super::*;

    fn user() -> UserId {
        UserId::parse("user-1").unwrap()
    }

    fn conversation() -> ConversationId {
        ConversationId::parse("pair-1").unwrap()
    }

    #[test]
    fn direct_pair_projection_is_viewer_scoped_replayable_and_monotonic() {
        let hub = ScopeEventHub::with_epoch("epoch-1");
        hub.publish_direct_pairs_changed(&user(), &conversation())
            .unwrap();
        hub.publish_direct_pairs_changed(&user(), &conversation())
            .unwrap();

        let resumed = hub.resume(&Scope::viewer(user()), "epoch-1", 0).unwrap();
        let Replay::Events(events) = resumed.replay else {
            panic!("same-epoch replay must return events");
        };
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].seq, 1);
        assert_eq!(events[1].seq, 2);
        assert_eq!(
            serde_json::to_value(&events[0]).unwrap(),
            serde_json::json!({
                "type": "event",
                "scope": "viewer:user-1",
                "seq": 1,
                "epoch": "epoch-1",
                "kind": "direct_pairs_changed",
                "payload": { "conversation_id": "pair-1" }
            })
        );
    }

    #[tokio::test]
    async fn resume_registers_live_delivery_before_releasing_the_replay_snapshot() {
        let hub = ScopeEventHub::with_epoch("epoch-1");
        hub.publish_direct_pairs_changed(&user(), &conversation())
            .unwrap();

        let resumed = hub.resume(&Scope::viewer(user()), "epoch-1", 0).unwrap();
        let Replay::Events(replayed) = resumed.replay else {
            panic!("same epoch must replay");
        };
        assert_eq!(
            replayed.iter().map(|event| event.seq).collect::<Vec<_>>(),
            [1]
        );
        let mut live = resumed.subscription.unwrap().receiver;

        hub.publish_direct_pairs_changed(&user(), &conversation())
            .unwrap();
        assert_eq!(live.recv().await.unwrap().seq, 2);
    }

    #[test]
    fn an_expired_replay_window_and_a_new_epoch_require_a_snapshot() {
        let hub = ScopeEventHub::with_epoch("epoch-1");
        for _ in 0..=REPLAY_CAPACITY {
            hub.publish_direct_pairs_changed(&user(), &conversation())
                .unwrap();
        }

        assert!(matches!(
            hub.resume(&Scope::viewer(user()), "epoch-1", 0)
                .unwrap()
                .replay,
            Replay::SnapshotRequired {
                reason: "gap_too_large",
                current_seq: 201
            }
        ));
        assert!(matches!(
            hub.resume(&Scope::viewer(user()), "old-epoch", 201)
                .unwrap()
                .replay,
            Replay::SnapshotRequired {
                reason: "epoch_mismatch",
                current_seq: 201
            }
        ));
    }

    #[test]
    fn a_viewer_scope_never_resolves_to_another_authenticated_user() {
        assert_eq!(
            allowed_viewer_scope(&serde_json::json!("viewer:self"), &user()).as_deref(),
            Some("viewer:user-1")
        );
        assert_eq!(
            allowed_viewer_scope(&serde_json::json!("viewer:user-1"), &user()).as_deref(),
            Some("viewer:user-1")
        );
        assert_eq!(
            allowed_viewer_scope(&serde_json::json!("viewer:user-2"), &user()),
            None
        );
    }

    #[tokio::test]
    async fn a_typed_viewer_connection_receives_the_exact_scoped_wire_event() {
        let hub = ScopeEventHub::with_epoch("epoch-1");
        let app = router(hub.clone()).layer(Extension(user()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let (mut socket, _) = connect_async(format!("ws://{address}{EVENT_WEBSOCKET_PATH}"))
            .await
            .unwrap();
        assert_eq!(
            next_json(&mut socket).await,
            serde_json::json!({
                "type": "authenticated",
                "viewerId": "user-1",
                "epoch": "epoch-1"
            })
        );

        socket
            .send(Message::Text(
                serde_json::json!({ "type": "subscribe", "scope": "viewer:self" })
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        assert_eq!(
            next_json(&mut socket).await,
            serde_json::json!({
                "type": "subscribed",
                "scope": "viewer:user-1",
                "epoch": "epoch-1",
                "seq": 0
            })
        );

        hub.publish_direct_pairs_changed(&user(), &conversation())
            .unwrap();
        assert_eq!(
            next_json(&mut socket).await,
            serde_json::json!({
                "type": "event",
                "scope": "viewer:user-1",
                "seq": 1,
                "epoch": "epoch-1",
                "kind": "direct_pairs_changed",
                "payload": { "conversation_id": "pair-1" }
            })
        );

        server.abort();
    }

    async fn next_json<S>(socket: &mut tokio_tungstenite::WebSocketStream<S>) -> serde_json::Value
    where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
    {
        let Message::Text(frame) = socket.next().await.unwrap().unwrap() else {
            panic!("expected a text frame");
        };
        serde_json::from_str(&frame).unwrap()
    }
}
