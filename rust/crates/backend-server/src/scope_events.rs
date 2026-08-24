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
use serde_json::{Value, json};
use silverhand_backend_core::{
    auth::{AuthenticateHumanSession, SessionBearer},
    identity::{AgentId, ConversationId, UserId, WorkspaceId},
    messaging::{
        CommittedMessageView, DirectPairOpenedFact, DirectPairOpenedPort, PrincipalIdentity,
        mention_cc::CommittedMentionCopy,
        post_commit::{
            CommittedMentionRow, CommittedMessagePublication, CopyNotification,
            DirectLineInvalidation, EffectFailure, MessagePublication, UnreadPublication,
            ViewerNotification,
        },
        unread::{LatestUnread as CoreLatestUnread, UnreadAudience, UnreadReadModel, ViewerUnread},
    },
    scope_event::{AuthorizeEventScope, EventScope},
};

use crate::messaging::message_wire::{copy_dto, message_event_payload};
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

/// A product event, tagged so a client discriminates on `kind` and reads `payload`.
///
/// `Eq` is deliberately absent where `DirectPairsChanged` alone could derive it: a
/// [`Message`](ProductEvent::Message) carries an already-projected `serde_json::Value`,
/// and `Value` is only `PartialEq` (a JSON number may be a float). The transport never
/// needs total equality — it clones frames into the replay ring and the live channel —
/// so `PartialEq` is the honest bound and tests compare with it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", content = "payload", rename_all = "snake_case")]
enum ProductEvent {
    DirectPairsChanged {
        conversation_id: String,
    },
    AgentActivity(Value),
    AgentStatus(Value),
    AgentInitTimeout(Value),
    CompactionStale(Value),
    AgentEvent(Value),
    ConversationActivity(Value),
    AgentPresenceChanged {
        agent_id: String,
    },
    /// The one committed-message frame every reader of a conversation receives, the
    /// SAME `{message, projections?}` value the sender's ACK projects — built by the
    /// single projector authority in [`crate::messaging::message_wire`]. Carried as an
    /// opaque `Value` because this transport does not re-decide the row's shape; it
    /// only routes what that projector produced.
    Message(Value),
    /// A directed notification: the row that a person was named exists. THIN by
    /// contract — only the coordinates a client needs to fetch the rich record over
    /// REST — never the excerpt or the author, which live in the durable row alone.
    Notification(NotificationEvent),
    /// A viewer's unread state after this message, co-emitted with the badge below on
    /// the same placement. Never sent alone: the pair is what
    /// [`ScopeEventHub::publish_unread_updated_to_viewer`] guarantees.
    UnreadUpdated(UnreadUpdated),
    /// The viewer's tiered attention badge — positional unread plus directed mentions
    /// — as ONE integer. Its own frame kind, but never its own event: a badge that
    /// moved without the unread that moved it would be a value the client cannot
    /// reconcile.
    AttentionBadgeUpdated(AttentionBadge),
    #[cfg(test)]
    Test {
        value: String,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum DaemonSideEvent {
    AgentActivity(Value),
    AgentStatus(Value),
    AgentInitTimeout(Value),
    CompactionStale(Value),
    AgentEvent(Value),
    ConversationActivity(Value),
}

/// The two directed-notification subjects, as the inner `kind` discriminant a client
/// switches on. `mention_self` says the reader was named; `mention_external` tells an
/// author their mention was copied out of the room. Both carry only coordinates.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum NotificationKind {
    MentionSelf,
    MentionExternal,
}

/// The thin directed-notification payload: which subject, and where to fetch the rest.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
struct NotificationEvent {
    kind: NotificationKind,
    conversation_id: String,
    message_id: String,
}

/// A viewer's unread state for one conversation, and the single latest unread anchor.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
struct UnreadUpdated {
    conversation_id: String,
    workspace_id: String,
    conversation_unread_count: i64,
    workspace_unread_count: i64,
    /// The most recent unread message for this viewer, or `null` when none remains —
    /// never a stale anchor and never omitted.
    latest_unread: Option<LatestUnread>,
}

/// The single most-recent unread message: enough to jump to it, no message body.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
struct LatestUnread {
    conversation_id: String,
    message_id: String,
    seq: i64,
    thread_root_id: Option<String>,
}

/// The tiered attention badge for a workspace: one non-negative count.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
struct AttentionBadge {
    workspace_id: String,
    badge_count: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
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

    pub(crate) fn publish_agent_presence_changed(
        &self,
        viewer: &UserId,
        agent: &AgentId,
    ) -> Result<(), ScopeEventHubError> {
        self.publish(
            EventScope::Viewer(viewer.clone()),
            ProductEvent::AgentPresenceChanged {
                agent_id: agent.as_str().to_owned(),
            },
        )
    }

    pub(crate) fn publish_daemon_side(
        &self,
        conversation: &ConversationId,
        event: DaemonSideEvent,
    ) -> Result<(), ScopeEventHubError> {
        let event = match event {
            DaemonSideEvent::AgentActivity(payload) => ProductEvent::AgentActivity(payload),
            DaemonSideEvent::AgentStatus(payload) => ProductEvent::AgentStatus(payload),
            DaemonSideEvent::AgentInitTimeout(payload) => ProductEvent::AgentInitTimeout(payload),
            DaemonSideEvent::CompactionStale(payload) => ProductEvent::CompactionStale(payload),
            DaemonSideEvent::AgentEvent(payload) => ProductEvent::AgentEvent(payload),
            DaemonSideEvent::ConversationActivity(payload) => {
                ProductEvent::ConversationActivity(payload)
            }
        };
        self.publish(EventScope::ConversationSide(conversation.clone()), event)
    }

    /// The ONE door that emits an unread frame or an attention badge, and it emits
    /// BOTH — the unread first, then the badge, to the same viewer scope. Neither
    /// frame has any other producer, which is what makes the co-emit a structural
    /// guarantee rather than a convention: a client can never receive a badge whose
    /// unread never moved, nor an unread whose badge stayed behind — two values it
    /// would have no way to reconcile.
    ///
    /// The two ride ONE [`Self::publish_batch`] call, not two [`Self::publish`] calls:
    /// atomicity is what makes the guarantee true even at the sequence ceiling. Two
    /// separate publishes would land the unread, then fail the badge's `checked_next`
    /// one increment before the ceiling, and leave a persisted half-pair — precisely
    /// the state this door claims a client can never observe.
    fn publish_unread_updated_to_viewer(
        &self,
        workspace: &WorkspaceId,
        conversation: &ConversationId,
        viewer: &ViewerUnread,
    ) -> Result<(), ScopeEventHubError> {
        let scope = EventScope::Viewer(viewer.viewer.clone());
        self.publish_batch(
            scope,
            vec![
                ProductEvent::UnreadUpdated(UnreadUpdated {
                    conversation_id: conversation.as_str().to_owned(),
                    workspace_id: workspace.as_str().to_owned(),
                    conversation_unread_count: viewer.conversation_unread_count,
                    workspace_unread_count: viewer.workspace_unread_count,
                    latest_unread: viewer.latest_unread.as_ref().map(latest_unread_wire),
                }),
                ProductEvent::AttentionBadgeUpdated(AttentionBadge {
                    workspace_id: workspace.as_str().to_owned(),
                    badge_count: viewer.badge_count,
                }),
            ],
        )
    }

    fn publish(&self, scope: EventScope, event: ProductEvent) -> Result<(), ScopeEventHubError> {
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
    fn publish_batch(
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

impl DirectPairOpenedPort for ScopeEventHub {
    type Error = ScopeEventHubError;

    async fn direct_pair_opened(&self, fact: &DirectPairOpenedFact) -> Result<(), Self::Error> {
        for participant in fact.participants().both() {
            let PrincipalIdentity::Human(viewer) = participant else {
                continue;
            };
            self.publish_direct_pairs_changed(viewer, fact.conversation())?;
        }
        Ok(())
    }
}

impl DirectLineInvalidation for ScopeEventHub {
    async fn direct_lines_changed(
        &self,
        viewer: &UserId,
        line: &ConversationId,
    ) -> Result<(), EffectFailure> {
        self.publish_direct_pairs_changed(viewer, line)
            .map_err(EffectFailure::from_source)
    }
}

impl MessagePublication for ScopeEventHub {
    async fn publish_copy(&self, copy: &CommittedMentionCopy) -> Result<(), EffectFailure> {
        // A mention-CC copy IS a message on the direct line it landed on: it rides the
        // same `message` frame every reader of that conversation receives, projected by
        // the one committed-message authority. A copy is never a thread reply, so the
        // payload is `{message}` alone — no `projections` sidecar.
        self.publish(
            EventScope::Conversation(copy.conversation_id.clone()),
            ProductEvent::Message(json!({ "message": copy_dto(copy) })),
        )
        .map_err(EffectFailure::from_source)
    }
}

impl CommittedMessagePublication for ScopeEventHub {
    async fn publish_message(
        &self,
        committed: CommittedMessageView<'_>,
    ) -> Result<(), EffectFailure> {
        // The one published frame, to the conversation the message landed in — the SAME
        // `{message, projections?}` value the sender's ACK returns. One projector
        // authority, two audiences; `projections` rides only when this is a reply.
        self.publish(
            EventScope::Conversation(committed.message().conversation_id.clone()),
            ProductEvent::Message(message_event_payload(
                committed.message(),
                committed.reply_projection(),
            )),
        )
        .map_err(EffectFailure::from_source)
    }
}

impl CopyNotification for ScopeEventHub {
    async fn notify_author(
        &self,
        author: &UserId,
        _agent: &AgentId,
        copy: &CommittedMentionCopy,
    ) -> Result<(), EffectFailure> {
        // The author's own notice that their mention left the room, addressed to the
        // AUTHOR's viewer scope. Its coordinates are the SOURCE message the author wrote
        // — the room they can still open — not the copy on a line they may not watch.
        let meta = &copy.metadata;
        self.publish(
            EventScope::Viewer(author.clone()),
            ProductEvent::Notification(NotificationEvent {
                kind: NotificationKind::MentionExternal,
                conversation_id: meta.source_conversation_id.as_str().to_owned(),
                message_id: meta.source_message_id.as_str().to_owned(),
            }),
        )
        .map_err(EffectFailure::from_source)
    }
}

impl ViewerNotification for ScopeEventHub {
    async fn notify_viewer(&self, mention: &CommittedMentionRow) -> Result<(), EffectFailure> {
        // The named reader's own notice, addressed to THEIR viewer scope. Its
        // coordinates are the mentioning message itself, so the client jumps to where it
        // was named. Thin by contract: the excerpt and author stay in the durable row.
        let intent = mention.intent();
        self.publish(
            EventScope::Viewer(mention.viewer().clone()),
            ProductEvent::Notification(NotificationEvent {
                kind: NotificationKind::MentionSelf,
                conversation_id: intent.source_conversation().as_str().to_owned(),
                message_id: intent.source_message().as_str().to_owned(),
            }),
        )
        .map_err(EffectFailure::from_source)
    }
}

/// The wire projection of one unread anchor. `None` upstream stays `None`; a present
/// anchor is spelled out coordinate by coordinate, never a stale carry-over.
fn latest_unread_wire(latest: &CoreLatestUnread) -> LatestUnread {
    LatestUnread {
        conversation_id: latest.conversation.as_str().to_owned(),
        message_id: latest.message.as_str().to_owned(),
        seq: latest.seq,
        thread_root_id: latest
            .thread_root
            .as_ref()
            .map(|root| root.as_str().to_owned()),
    }
}

/// Composes the hub with a read model into the production [`UnreadPublication`] effect.
///
/// The read model is a TYPE PARAMETER, not a concrete adapter: backend-server depends on
/// the SQLite crate only in dev, so the product read model is injected at the composition
/// root and no engine type appears here. This publisher owns only the routing — the read
/// model decides placement, audience, and every count — so the placement fork below is a
/// total match over [`UnreadAudience`]'s two arms and cannot silently drop one.
pub struct HubUnreadPublisher<R> {
    hub: ScopeEventHub,
    read_model: R,
}

impl<R> HubUnreadPublisher<R> {
    pub fn new(hub: ScopeEventHub, read_model: R) -> Self {
        Self { hub, read_model }
    }
}

impl<R: UnreadReadModel + Send + Sync> UnreadPublication for HubUnreadPublisher<R> {
    async fn publish_unread(&self, conversation: &ConversationId) -> Result<(), EffectFailure> {
        // Who is owed an update, and their state, is decided against the committed
        // database by the read model; this ROUTES the answer and re-decides nothing.
        // `None` is the conversation gone — nothing to publish.
        let Some(audience) = self
            .read_model
            .unread_audience(conversation)
            .await
            .map_err(EffectFailure::from_source)?
        else {
            return Ok(());
        };

        match audience {
            // Workspace placement: each seated viewer receives the unread+badge co-emit,
            // through the one door that emits both.
            UnreadAudience::Workspace { workspace, viewers } => {
                for viewer in &viewers {
                    self.hub
                        .publish_unread_updated_to_viewer(&workspace, conversation, viewer)
                        .map_err(EffectFailure::from_source)?;
                }
            }
            // A direct line has no workspace unread surface: each human endpoint's
            // direct-line LIST is invalidated instead — the distinct DM axis, the same
            // frame arrival and clearing both ride.
            UnreadAudience::DirectPair { viewers } => {
                for viewer in &viewers {
                    self.hub
                        .publish_direct_pairs_changed(viewer, conversation)
                        .map_err(EffectFailure::from_source)?;
                }
            }
        }
        Ok(())
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
    use std::{
        convert::Infallible,
        future::Future,
        sync::{
            Arc, Mutex,
            atomic::{AtomicUsize, Ordering},
        },
        task::{Context, Poll, Waker},
    };

    use futures_util::{SinkExt, StreamExt};
    use silverhand_backend_core::{
        auth::{AuthenticateHumanSession, SessionBearer},
        identity::{AgentId, DaemonInstanceId},
        messaging::{
            AddressedPrincipals, CapabilityDenied, CreatedMessage, DirectLineAuthority,
            DirectPairOpenedPort, DirectPairParticipants, EnvironmentUnavailable, MessageContent,
            MessageId, NotificationId, OpenDirectPairError, ParticipantHandle, PrincipalKind,
            ReferencePositions, SendActor, SendCapability, SendDestination, SendEntropy,
            SendMessage, SendMessageDraft, SendMessageError, SendMessageOutcome,
            SendMessageUnitOfWork,
            mention_cc::{CommittedMentionCopy, MentionCopyOutcome},
            post_commit::{
                CopyNotification, EffectStep, IdleStart, MainDelivery, MainEffects, MentionIntent,
                MentionSkipRecord, MessagePublication, RuntimeDelivery, RuntimeStart, SendEffects,
                SkippedMention, announce_main_send, announce_send,
            },
        },
        persistence::PersistenceFailure,
        runtime_credential::{RuntimeCustody, RuntimeGeneration, RuntimePrincipal},
        scope_event::AuthorizeEventScope,
    };
    use silverhand_backend_sqlite::{
        messaging::MessagingStore,
        runtime_delivery::SqliteRuntimeDeliveryStore,
        unread_read::{SqliteUnreadReadModel, UnreadReadModelError},
    };
    use sqlx::{Connection, SqliteConnection};
    use tokio::sync::Barrier;
    use tokio_tungstenite::{
        connect_async,
        tungstenite::{Message as ClientMessage, client::IntoClientRequest},
    };
    use tower::ServiceExt;

    use crate::current_schema;
    use crate::daemon_events::{
        DaemonRuntimeEventOwner, ParsedEventWire, RuntimeCoordinate, RuntimeEventDirective,
        RuntimeParsedEvent, RuntimeProductEvent, RuntimeScopeWire,
    };

    use super::*;

    fn user() -> UserId {
        UserId::parse("user-1").unwrap()
    }

    fn agent() -> AgentId {
        AgentId::parse("agent-1").unwrap()
    }

    fn pair_participants() -> DirectPairParticipants {
        DirectPairParticipants::between(
            PrincipalIdentity::Human(user()),
            PrincipalIdentity::Agent(agent()),
        )
        .unwrap()
    }

    struct FixedEntropy(u8);

    impl SendEntropy for FixedEntropy {
        fn fill(&self, buffer: &mut [u8]) -> Result<(), EnvironmentUnavailable> {
            buffer.fill(self.0);
            Ok(())
        }
    }

    struct OneReference;

    fn ready<F: Future>(future: F) -> F::Output {
        let mut future = std::pin::pin!(future);
        let mut context = Context::from_waker(Waker::noop());
        match future.as_mut().poll(&mut context) {
            Poll::Ready(output) => output,
            Poll::Pending => panic!("the driver-free authority unexpectedly suspended"),
        }
    }

    impl ReferencePositions for OneReference {
        fn autolink_spans(&self, content: &MessageContent) -> Vec<std::ops::Range<usize>> {
            let start = content.as_str().find('<').unwrap();
            let end = content.as_str()[start..].find('>').unwrap() + start + 1;
            std::iter::once(start..end).collect()
        }
    }

    struct GrantsAgent;

    impl DirectLineAuthority for GrantsAgent {
        async fn direct_lines(
            &self,
            _author: &UserId,
            addressed: &AddressedPrincipals,
        ) -> Result<Vec<AgentId>, PersistenceFailure> {
            assert!(addressed.iter().any(|reference| {
                reference.kind() == PrincipalKind::Agent && reference.handle().as_str() == "agent"
            }));
            Ok(vec![agent()])
        }
    }

    fn mention_command() -> SendMessage {
        ready(SendMessage::prepare(
            SendMessageDraft {
                source_conversation: ConversationId::parse("conversation-1").unwrap(),
                target_conversation: ConversationId::parse("conversation-1").unwrap(),
                actor: SendActor::User(user()),
                content: MessageContent::parse("<silverhand://agent/agent> ping").unwrap(),
                destination: SendDestination::MainLine,
                attachment_refs: Vec::new(),
                freshness_bypass: false,
            },
            &OneReference,
            &GrantsAgent,
        ))
        .unwrap()
    }

    #[derive(Default)]
    struct OtherEffects(Mutex<Vec<EffectStep>>);

    impl OtherEffects {
        fn record(&self, step: EffectStep) {
            self.0.lock().unwrap().push(step);
        }

        fn calls(&self) -> Vec<EffectStep> {
            self.0.lock().unwrap().clone()
        }
    }

    impl MessagePublication for OtherEffects {
        async fn publish_copy(&self, _copy: &CommittedMentionCopy) -> Result<(), EffectFailure> {
            self.record(EffectStep::CopyPublished);
            Ok(())
        }
    }

    impl CopyNotification for OtherEffects {
        async fn notify_author(
            &self,
            _author: &UserId,
            _agent: &AgentId,
            _copy: &CommittedMentionCopy,
        ) -> Result<(), EffectFailure> {
            self.record(EffectStep::AuthorNotified);
            Ok(())
        }
    }

    impl RuntimeStart for OtherEffects {
        async fn start(
            &self,
            _conversation: &ConversationId,
            _agent: &AgentId,
        ) -> Result<(), EffectFailure> {
            self.record(EffectStep::RuntimeStarted);
            Ok(())
        }
    }

    impl RuntimeDelivery for OtherEffects {
        async fn deliver(
            &self,
            _agent: &AgentId,
            _copy: &CommittedMentionCopy,
        ) -> Result<(), EffectFailure> {
            self.record(EffectStep::CopyDelivered);
            Ok(())
        }
    }

    impl MentionSkipRecord for OtherEffects {
        async fn record_skip(&self, _skipped: &SkippedMention<'_>) -> Result<(), EffectFailure> {
            self.record(EffectStep::SkipRecorded);
            Ok(())
        }
    }

    #[derive(Debug, thiserror::Error)]
    #[error("announcement unavailable")]
    struct AnnouncementUnavailable;

    struct FailingOpened;

    impl DirectPairOpenedPort for FailingOpened {
        type Error = AnnouncementUnavailable;

        async fn direct_pair_opened(
            &self,
            _fact: &DirectPairOpenedFact,
        ) -> Result<(), Self::Error> {
            Err(AnnouncementUnavailable)
        }
    }

    #[derive(Debug, thiserror::Error)]
    #[error("capability denied")]
    struct LaterCapabilityDenied;

    fn reject_later_product_action(_pair: &ConversationId) -> Result<(), LaterCapabilityDenied> {
        Err(LaterCapabilityDenied)
    }

    async fn direct_pair_database() -> (tempfile::TempDir, std::path::PathBuf) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("direct-pair.sqlite");
        let mut db = current_schema::create_current_schema(&path).await;
        sqlx::query(
            "INSERT INTO users (id, name, display_name, created_at, updated_at) \
             VALUES ('user-1', 'user', 'User', 1, 1)",
        )
        .execute(&mut db)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO hosts (id, name, kind, created_at) \
             VALUES ('host-1', 'host', 'local', 1)",
        )
        .execute(&mut db)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO agents (id, name, runtime, host_id, created_at, updated_at, \
             display_name, created_by_user_id) VALUES \
             ('agent-1', 'agent', 'claude', 'host-1', 1, 1, 'Agent', 'user-1')",
        )
        .execute(&mut db)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO workspaces (id, name, name_key, owner_user_id, created_at, updated_at) \
             VALUES ('workspace-1', 'Space', 'space', 'user-1', 1, 1)",
        )
        .execute(&mut db)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO workspace_users (workspace_id, user_id, joined_at, role) \
             VALUES ('workspace-1', 'user-1', 1, 'owner')",
        )
        .execute(&mut db)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO conversations (id, workspace_id, placement_kind, roster_policy, title, \
             title_key, status, visibility, created_at, updated_at) VALUES \
             ('conversation-1', 'workspace-1', 'workspace', 'open', 'Channel', 'channel', 'open', \
             'private', 1, 1)",
        )
        .execute(&mut db)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO conversation_users (conversation_id, user_id, joined_at) \
             VALUES ('conversation-1', 'user-1', 1)",
        )
        .execute(&mut db)
        .await
        .unwrap();
        db.close().await.unwrap();
        (directory, path)
    }

    async fn runtime_event_database() -> (tempfile::TempDir, std::path::PathBuf) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("runtime-events.sqlite");
        let mut db = current_schema::create_current_schema(&path).await;
        sqlx::raw_sql(
            "INSERT INTO users (id, name, display_name, created_at, updated_at)
             VALUES ('user-1', 'user', 'User', 1, 1);
             INSERT INTO hosts (id, name, kind, created_at)
             VALUES ('host-1', 'host', 'local', 1);
             INSERT INTO workspaces (id, name, name_key, owner_user_id, created_at, updated_at)
             VALUES ('workspace-1', 'Space', 'space', 'user-1', 1, 1);
             INSERT INTO workspace_users (workspace_id, user_id, joined_at, role)
             VALUES ('workspace-1', 'user-1', 1, 'owner');
             INSERT INTO agents (
               id, name, runtime, host_id, created_at, updated_at, display_name,
               created_by_user_id, session_scope
             ) VALUES (
               'agent-1', 'agent', 'claude', 'host-1', 1, 1, 'Agent', 'user-1', 'agent'
             );
             INSERT INTO workspace_members (workspace_id, agent_id, joined_at)
             VALUES ('workspace-1', 'agent-1', 1);
             INSERT INTO conversations (
               id, workspace_id, placement_kind, roster_policy, title, title_key,
               status, visibility, created_at, updated_at
             ) VALUES
               ('conversation-1', 'workspace-1', 'workspace', 'fixed', 'First', 'first',
                'active', 'private', 1, 1),
               ('conversation-2', 'workspace-1', 'workspace', 'fixed', 'Second', 'second',
                'active', 'private', 1, 1);
             INSERT INTO conversation_users (conversation_id, user_id, joined_at)
             VALUES ('conversation-1', 'user-1', 1), ('conversation-2', 'user-1', 1);
             INSERT INTO conversation_agents (conversation_id, agent_id, joined_at)
             VALUES ('conversation-1', 'agent-1', 1), ('conversation-2', 'agent-1', 1);
             UPDATE agent_runtime_slots
                SET generation = 1, claimed_by_daemon_instance_id = 'daemon-1'
              WHERE agent_id = 'agent-1' AND conversation_id IS NULL;",
        )
        .execute(&mut db)
        .await
        .unwrap();
        db.close().await.unwrap();
        (directory, path)
    }

    #[tokio::test]
    async fn session_init_attempts_every_live_audience_and_still_requests_one_drain() {
        let (_directory, path) = runtime_event_database().await;
        let durable = SqliteRuntimeDeliveryStore::open(&path).await.unwrap();
        let hub = ScopeEventHub::test("epoch-1");
        let first = ConversationId::parse("conversation-1").unwrap();
        let second = ConversationId::parse("conversation-2").unwrap();
        let first_scope = EventScope::ConversationSide(first.clone());
        hub.scopes
            .lock()
            .unwrap()
            .entry(first_scope.clone())
            .or_insert_with(ScopeState::new)
            .seq = TransportSeq(MAX_TRANSPORT_SEQ);
        let owner = DaemonRuntimeEventOwner::new(durable, hub.clone());
        let daemon = DaemonInstanceId::parse("daemon-1").unwrap();
        let directive = owner
            .handle(
                "host-1",
                &daemon,
                RuntimeProductEvent::Parsed(RuntimeParsedEvent {
                    coordinate: RuntimeCoordinate {
                        runtime_scope: RuntimeScopeWire::Agent {
                            agent_id: "agent-1".to_owned(),
                        },
                        conversation_id: first.as_str().to_owned(),
                        agent_id: "agent-1".to_owned(),
                    },
                    runtime_generation: 1,
                    parsed: ParsedEventWire::SessionInit {
                        session_id: "session-1".to_owned(),
                    },
                    ts: 10,
                }),
            )
            .await
            .unwrap();

        let RuntimeEventDirective::Drain {
            conversation,
            agent: drained_agent,
            post_commit_failure,
        } = directive
        else {
            panic!("a committed session init must request one drain")
        };
        assert_eq!(conversation, first);
        assert_eq!(drained_agent, agent());
        assert!(matches!(
            post_commit_failure,
            Some(crate::daemon_events::DaemonRuntimeEventError::Hub(
                ScopeEventHubError::SequenceExhausted
            ))
        ));
        assert_eq!(
            hub.scopes.lock().unwrap()[&first_scope].seq,
            TransportSeq(MAX_TRANSPORT_SEQ)
        );
        let second_events = hub
            .resume(
                &EventScope::ConversationSide(second),
                &TransportEpoch::parse("epoch-1").unwrap(),
                TransportSeq::ZERO,
            )
            .unwrap();
        let Replay::Events(second_events) = second_events.replay else {
            panic!("the second status audience must receive a live projection")
        };
        assert_eq!(second_events.len(), 1);
        assert!(matches!(
            second_events[0].event,
            ProductEvent::AgentStatus(_)
        ));
        let viewer_events = hub
            .resume(
                &EventScope::Viewer(user()),
                &TransportEpoch::parse("epoch-1").unwrap(),
                TransportSeq::ZERO,
            )
            .unwrap();
        let Replay::Events(viewer_events) = viewer_events.replay else {
            panic!("the independent presence audience must still be attempted")
        };
        assert_eq!(viewer_events.len(), 1);
        assert!(matches!(
            viewer_events[0].event,
            ProductEvent::AgentPresenceChanged { .. }
        ));

        let mut db = SqliteConnection::connect(&format!("sqlite://{}", path.display()))
            .await
            .unwrap();
        let status: String = sqlx::query_scalar(
            "SELECT observed_status FROM agent_runtime_slots
              WHERE agent_id = 'agent-1' AND conversation_id IS NULL",
        )
        .fetch_one(&mut db)
        .await
        .unwrap();
        let activities: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM conversation_events
              WHERE conversation_id = 'conversation-1' AND kind = 'session_init'",
        )
        .fetch_one(&mut db)
        .await
        .unwrap();
        assert_eq!(status, "active");
        assert_eq!(activities, 1);
    }

    async fn direct_pair_count(path: &std::path::Path) -> i64 {
        let mut db = SqliteConnection::connect(&format!("sqlite://{}", path.display()))
            .await
            .unwrap();
        sqlx::query_scalar(
            "SELECT COUNT(*) FROM conversations WHERE placement_kind = 'direct_pair'",
        )
        .fetch_one(&mut db)
        .await
        .unwrap()
    }

    struct DenySend;

    impl SendCapability for DenySend {
        type Error = Infallible;

        async fn may_send_messages(
            &self,
            _agent: &AgentId,
            _conversation: &ConversationId,
        ) -> Result<Result<(), CapabilityDenied>, Self::Error> {
            Ok(Err(CapabilityDenied))
        }
    }

    struct CountedStore {
        inner: MessagingStore,
        calls: Arc<AtomicUsize>,
    }

    impl SendMessageUnitOfWork for CountedStore {
        async fn send_message(
            &self,
            command: SendMessage,
        ) -> Result<SendMessageOutcome, SendMessageError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.inner.send_message(command).await
        }
    }

    fn direct_pair_router(
        store: MessagingStore,
        hub: ScopeEventHub,
        calls: Arc<AtomicUsize>,
    ) -> axum::Router {
        crate::messaging::router::send_router(crate::messaging::router::SendState {
            channel_access: store.clone(),
            target_address: store.target_address(hub, crate::messaging::TargetAddressRefusalLog),
            capability: DenySend,
            authority: store.clone(),
            unit_of_work: CountedStore {
                inner: store,
                calls,
            },
        })
        .layer(axum::Extension(RuntimePrincipal::AgentSlot {
            agent: agent(),
            custody: RuntimeCustody::new(
                RuntimeGeneration::new(1).unwrap(),
                silverhand_backend_core::identity::DaemonInstanceId::parse("daemon-1").unwrap(),
            ),
        }))
    }

    fn agent_target_request(target: &str) -> axum::http::Request<axum::body::Body> {
        axum::http::Request::post("/internal/agents/agent-1/send-message")
            .header(axum::http::header::CONTENT_TYPE, "application/json")
            .body(axum::body::Body::from(
                serde_json::json!({"content":"hello", "target":target}).to_string(),
            ))
            .unwrap()
    }

    fn viewer_replay_len(hub: &ScopeEventHub) -> usize {
        let resumed = hub
            .resume(
                &EventScope::Viewer(user()),
                &TransportEpoch::parse("epoch-1").unwrap(),
                TransportSeq::ZERO,
            )
            .unwrap();
        let Replay::Events(events) = resumed.replay else {
            panic!("the viewer replay must fit in the retained window")
        };
        events.len()
    }

    #[tokio::test]
    async fn real_resolver_announces_before_capability_refusal_and_never_enters_the_uow() {
        let (_directory, path) = direct_pair_database().await;
        let store = MessagingStore::open(&path).await.unwrap();
        let hub = ScopeEventHub::test("epoch-1");
        let calls = Arc::new(AtomicUsize::new(0));
        let app = direct_pair_router(store, hub.clone(), calls.clone());

        let response = app.oneshot(agent_target_request("dm:@user")).await.unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::FORBIDDEN);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert_eq!(direct_pair_count(&path).await, 1);

        assert_eq!(viewer_replay_len(&hub), 1);
    }

    #[tokio::test]
    async fn a_thread_suffix_never_creates_a_missing_pair_but_checks_an_existing_pair() {
        let (_directory, path) = direct_pair_database().await;
        let store = MessagingStore::open(&path).await.unwrap();
        let hub = ScopeEventHub::test("epoch-1");
        let calls = Arc::new(AtomicUsize::new(0));
        let app = direct_pair_router(store, hub.clone(), calls.clone());
        let missing_root = "root000000000099";

        let missing_pair = app
            .clone()
            .oneshot(agent_target_request(&format!(
                "dm:@user/thread:{missing_root}"
            )))
            .await
            .unwrap();
        assert_eq!(missing_pair.status(), axum::http::StatusCode::NOT_FOUND);
        let body = axum::body::to_bytes(missing_pair.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
            serde_json::json!({
                "error": "target names no stream you can use",
                "code": "target_unresolved",
            })
        );
        assert_eq!(direct_pair_count(&path).await, 0);
        assert_eq!(viewer_replay_len(&hub), 0);
        assert_eq!(calls.load(Ordering::SeqCst), 0);

        let created = app
            .clone()
            .oneshot(agent_target_request("dm:@user"))
            .await
            .unwrap();
        assert_eq!(created.status(), axum::http::StatusCode::FORBIDDEN);
        assert_eq!(direct_pair_count(&path).await, 1);
        assert_eq!(viewer_replay_len(&hub), 1);

        let existing_pair = app
            .oneshot(agent_target_request(&format!(
                "dm:@user/thread:{missing_root}"
            )))
            .await
            .unwrap();
        assert_eq!(existing_pair.status(), axum::http::StatusCode::NOT_FOUND);
        let body = axum::body::to_bytes(existing_pair.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
            serde_json::json!({
                "error": "target names no reply cluster of that conversation",
                "code": "thread_not_in_target",
            })
        );
        assert_eq!(direct_pair_count(&path).await, 1);
        assert_eq!(viewer_replay_len(&hub), 1);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
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
    async fn concurrent_pair_mints_publish_only_the_insert_winner() {
        let (_directory, path) = direct_pair_database().await;
        let first = MessagingStore::open_with(&path, FixedEntropy(1))
            .await
            .unwrap();
        let second = MessagingStore::open_with(&path, FixedEntropy(2))
            .await
            .unwrap();
        let hub = ScopeEventHub::test("epoch-1");
        let barrier = Arc::new(Barrier::new(3));

        let first_task = tokio::spawn({
            let barrier = Arc::clone(&barrier);
            let hub = hub.clone();
            async move {
                barrier.wait().await;
                first
                    .open_direct_pair(&hub, pair_participants(), 10)
                    .await
                    .unwrap()
            }
        });
        let second_task = tokio::spawn({
            let barrier = Arc::clone(&barrier);
            let hub = hub.clone();
            async move {
                barrier.wait().await;
                second
                    .open_direct_pair(&hub, pair_participants(), 11)
                    .await
                    .unwrap()
            }
        });
        barrier.wait().await;

        let first_pair = first_task.await.unwrap();
        let second_pair = second_task.await.unwrap();
        assert_eq!(first_pair, second_pair);
        assert_eq!(direct_pair_count(&path).await, 1);

        let resumed = hub
            .resume(
                &EventScope::Viewer(user()),
                &TransportEpoch::parse("epoch-1").unwrap(),
                TransportSeq::ZERO,
            )
            .unwrap();
        let Replay::Events(events) = resumed.replay else {
            panic!("the insert winner must be replayable")
        };
        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0].event,
            ProductEvent::DirectPairsChanged {
                conversation_id: first_pair.as_str().to_owned(),
            }
        );
    }

    #[tokio::test]
    async fn a_committed_mention_copy_publishes_once_through_the_production_viewer_sink() {
        let (_directory, path) = direct_pair_database().await;
        let store = MessagingStore::open(&path).await.unwrap();
        let outcome = store.send_message(mention_command()).await.unwrap();
        assert!(matches!(
            outcome.committed().mention_copies(),
            [silverhand_backend_core::messaging::mention_cc::MentionCopyOutcome::Copied { .. }]
        ));
        let hub = ScopeEventHub::test("epoch-1");
        let effects = OtherEffects::default();

        let report = announce_send(
            outcome.committed(),
            SendEffects {
                direct_lines: &hub,
                publication: &effects,
                notification: &effects,
                start: &effects,
                delivery: &effects,
                skips: &effects,
            },
        )
        .await;

        assert!(report.failed.is_empty());
        assert_eq!(direct_pair_count(&path).await, 1);
        let resumed = hub
            .resume(
                &EventScope::Viewer(user()),
                &TransportEpoch::parse("epoch-1").unwrap(),
                TransportSeq::ZERO,
            )
            .unwrap();
        let Replay::Events(events) = resumed.replay else {
            panic!("the committed mention copy must reach viewer replay")
        };
        // This outcome contains both the committed copy and the transaction's
        // opened-line coverage. Without announce_send's conversation dedupe the
        // same viewer projector would append two events here. The independent
        // no-copy fallback is an orchestration invariant tested in backend-core.
        assert_eq!(events.len(), 1);
        assert!(matches!(
            events[0].event,
            ProductEvent::DirectPairsChanged { .. }
        ));
    }

    #[tokio::test]
    async fn mention_copy_sink_failure_keeps_its_chain_and_does_not_stop_later_effects() {
        let (_directory, path) = direct_pair_database().await;
        let store = MessagingStore::open(&path).await.unwrap();
        let outcome = store.send_message(mention_command()).await.unwrap();
        let hub = ScopeEventHub::test("epoch-1");
        let registry = Arc::clone(&hub.scopes);
        let _ = std::thread::spawn(move || {
            let _guard = registry.lock().unwrap();
            panic!("poison the test registry");
        })
        .join();
        let effects = OtherEffects::default();

        let report = announce_send(
            outcome.committed(),
            SendEffects {
                direct_lines: &hub,
                publication: &effects,
                notification: &effects,
                start: &effects,
                delivery: &effects,
                skips: &effects,
            },
        )
        .await;

        assert_eq!(report.failed.len(), 1);
        assert_eq!(
            report.failed_steps(),
            vec![EffectStep::DirectLineInvalidation]
        );
        assert_eq!(
            report.failed[0].2.source().unwrap().to_string(),
            "scope event registry lock was poisoned"
        );
        assert_eq!(
            effects.calls(),
            vec![
                EffectStep::CopyPublished,
                EffectStep::AuthorNotified,
                EffectStep::RuntimeStarted,
                EffectStep::CopyDelivered,
            ]
        );
        assert_eq!(direct_pair_count(&path).await, 1);
    }

    #[tokio::test]
    async fn announcement_failure_does_not_rollback_the_autocommitted_pair() {
        let (_directory, path) = direct_pair_database().await;
        let store = MessagingStore::open_with(&path, FixedEntropy(3))
            .await
            .unwrap();

        let error = store
            .open_direct_pair(&FailingOpened, pair_participants(), 10)
            .await
            .unwrap_err();
        assert!(matches!(error, OpenDirectPairError::Announcement(_)));
        assert_eq!(
            error.source().unwrap().to_string(),
            "announcement unavailable"
        );
        assert_eq!(direct_pair_count(&path).await, 1);
    }

    #[tokio::test]
    async fn later_product_refusal_neither_compensates_nor_reannounces_the_pair() {
        let (_directory, path) = direct_pair_database().await;
        let store = MessagingStore::open_with(&path, FixedEntropy(4))
            .await
            .unwrap();
        let hub = ScopeEventHub::test("epoch-1");

        let pair = store
            .open_direct_pair(&hub, pair_participants(), 10)
            .await
            .unwrap();
        assert_eq!(
            reject_later_product_action(&pair).unwrap_err().to_string(),
            "capability denied"
        );

        let existing = store
            .open_direct_pair(&hub, pair_participants(), 11)
            .await
            .unwrap();
        assert_eq!(existing, pair);
        assert_eq!(direct_pair_count(&path).await, 1);
        let resumed = hub
            .resume(
                &EventScope::Viewer(user()),
                &TransportEpoch::parse("epoch-1").unwrap(),
                TransportSeq::ZERO,
            )
            .unwrap();
        let Replay::Events(events) = resumed.replay else {
            panic!("the original announcement must remain replayable")
        };
        assert_eq!(events.len(), 1);
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

    // ------------------------------------------------------------------
    // Terminal multi-port consistency gate.
    //
    // The five product-event effect ports are NOT five independent audience
    // decisions. One committed send drives several of them at once through the
    // shared placement/audience projection (the read model's participant query and
    // the one committed-message authority). These cells prove that sharing causes no
    // duplicate message frame, no duplicate or missing unread/badge co-emit, and no
    // widening of a copy-only viewer into the conversation's audience — driven by the
    // real `announce_*` orchestration over the real SQLite read model, never a
    // hand-rolled audience. Delivery/idle are the only doubles: those effects belong
    // to #2185's daemon lane, not to this projection.
    // ------------------------------------------------------------------

    /// Every autolink span in the body, so one send can name a human and an agent at once.
    struct AllReferences;

    impl ReferencePositions for AllReferences {
        fn autolink_spans(&self, content: &MessageContent) -> Vec<std::ops::Range<usize>> {
            let text = content.as_str();
            let mut spans = Vec::new();
            let mut cursor = 0;
            while let Some(relative) = text[cursor..].find('<') {
                let start = cursor + relative;
                let end = start + text[start..].find('>').expect("a closing bracket") + 1;
                spans.push(start..end);
                cursor = end;
            }
            spans
        }
    }

    /// The one agent handle this world can reach privately maps to the seeded agent —
    /// a name resolved to an id, never a handle parsed as one.
    struct DirectLinesToExternal;

    impl DirectLineAuthority for DirectLinesToExternal {
        async fn direct_lines(
            &self,
            _author: &UserId,
            addressed: &AddressedPrincipals,
        ) -> Result<Vec<AgentId>, PersistenceFailure> {
            Ok(addressed
                .iter()
                .filter(|reference| reference.kind() == PrincipalKind::Agent)
                .filter(|reference| reference.handle().as_str() == "external")
                .map(|_| AgentId::parse("agent-1").unwrap())
                .collect())
        }
    }

    /// Delivery and idle-start are #2185's lane; here they are inert, so a call that
    /// should never reach them is caught by the frame assertions rather than a panic.
    struct Discarded;

    impl MainDelivery for Discarded {
        async fn deliver_to(
            &self,
            _recipient: &AgentId,
            _message: &CreatedMessage,
        ) -> Result<(), EffectFailure> {
            Ok(())
        }
    }

    impl IdleStart for Discarded {
        async fn start_if_idle(
            &self,
            _recipient: &AgentId,
            _conversation: &ConversationId,
        ) -> Result<(), EffectFailure> {
            Ok(())
        }
    }

    fn mentioned() -> UserId {
        UserId::parse("user-2").unwrap()
    }

    fn channel() -> ConversationId {
        ConversationId::parse("conversation-1").unwrap()
    }

    /// A workspace channel with two seated humans — the author and a reader who will be
    /// named — plus a workspace member who is NOT seated (the no-widening witness) and an
    /// agent reachable only over a direct line (the copy-only viewer).
    async fn seed_fanout(path: &std::path::Path) {
        let mut db = current_schema::create_current_schema(path).await;
        for statement in [
            "INSERT INTO users (id, name, display_name, created_at, updated_at) \
             VALUES ('user-1', 'sender', 'Sender', 1, 1)",
            "INSERT INTO users (id, name, display_name, created_at, updated_at) \
             VALUES ('user-2', 'mentioned', 'Mentioned', 2, 2)",
            "INSERT INTO users (id, name, display_name, created_at, updated_at) \
             VALUES ('user-3', 'bystander', 'Bystander', 3, 3)",
            "INSERT INTO hosts (id, name, kind, created_at) VALUES ('host-1', 'host', 'local', 1)",
            "INSERT INTO agents (id, name, runtime, host_id, created_at, updated_at, \
             display_name, created_by_user_id) VALUES \
             ('agent-1', 'external', 'claude', 'host-1', 1, 1, 'External', 'user-1')",
            "INSERT INTO workspaces (id, name, name_key, owner_user_id, created_at, updated_at) \
             VALUES ('workspace-1', 'Space', 'space', 'user-1', 1, 1)",
            "INSERT INTO workspace_users (workspace_id, user_id, joined_at, role) \
             VALUES ('workspace-1', 'user-1', 1, 'owner')",
            "INSERT INTO workspace_users (workspace_id, user_id, joined_at, role) \
             VALUES ('workspace-1', 'user-2', 1, 'member')",
            "INSERT INTO workspace_users (workspace_id, user_id, joined_at, role) \
             VALUES ('workspace-1', 'user-3', 1, 'member')",
            "INSERT INTO conversations (id, workspace_id, placement_kind, roster_policy, title, \
             title_key, status, visibility, created_at, updated_at) VALUES \
             ('conversation-1', 'workspace-1', 'workspace', 'open', 'Channel', 'channel', 'open', \
             'private', 1, 1)",
            "INSERT INTO conversation_users (conversation_id, user_id, joined_at) \
             VALUES ('conversation-1', 'user-1', 1)",
            "INSERT INTO conversation_users (conversation_id, user_id, joined_at) \
             VALUES ('conversation-1', 'user-2', 1)",
        ] {
            sqlx::query(statement).execute(&mut db).await.unwrap();
        }
        db.close().await.unwrap();
    }

    /// A direct line between two humans, its own placement with no workspace tier.
    async fn seed_direct_pair(path: &std::path::Path) {
        let mut db = current_schema::create_current_schema(path).await;
        for statement in [
            "INSERT INTO users (id, name, display_name, created_at, updated_at) \
             VALUES ('user-1', 'sender', 'Sender', 1, 1)",
            "INSERT INTO users (id, name, display_name, created_at, updated_at) \
             VALUES ('user-2', 'mentioned', 'Mentioned', 2, 2)",
            "INSERT INTO conversations (id, endpoint_a_kind, endpoint_a_id, endpoint_b_kind, \
             endpoint_b_id, placement_kind, roster_policy, title, status, visibility, \
             created_at, updated_at) VALUES \
             ('conversation-2', 'human', 'user-1', 'human', 'user-2', 'direct_pair', 'fixed', \
             'Direct', 'open', 'private', 1, 1)",
            "INSERT INTO conversation_users (conversation_id, user_id, joined_at) \
             VALUES ('conversation-2', 'user-1', 1)",
            "INSERT INTO conversation_users (conversation_id, user_id, joined_at) \
             VALUES ('conversation-2', 'user-2', 1)",
        ] {
            sqlx::query(statement).execute(&mut db).await.unwrap();
        }
        db.close().await.unwrap();
    }

    /// A person's send that names a seated reader (a `mention_self`) and an agent that is
    /// only reachable off-channel (a mention-CC copy) — one committed send, several ports.
    fn fanout_command() -> SendMessage {
        ready(SendMessage::prepare(
            SendMessageDraft {
                source_conversation: channel(),
                target_conversation: channel(),
                actor: SendActor::User(user()),
                content: MessageContent::parse(
                    "<silverhand://human/mentioned> <silverhand://agent/external> ping",
                )
                .unwrap(),
                destination: SendDestination::MainLine,
                attachment_refs: Vec::new(),
                freshness_bypass: false,
            },
            &AllReferences,
            &DirectLinesToExternal,
        ))
        .unwrap()
    }

    /// A person's send that names no one — enough to make a reader's unread move.
    fn plain_command() -> SendMessage {
        ready(SendMessage::prepare(
            SendMessageDraft {
                source_conversation: channel(),
                target_conversation: channel(),
                actor: SendActor::User(user()),
                content: MessageContent::parse("hello").unwrap(),
                destination: SendDestination::MainLine,
                attachment_refs: Vec::new(),
                freshness_bypass: false,
            },
            &AllReferences,
            &DirectLinesToExternal,
        ))
        .unwrap()
    }

    /// A person's send that names a workspace member who is NOT seated in the target
    /// channel — the bystander. The name resolves to a real user but reaches nobody in
    /// this conversation, so the outcome carries a sender-only `unresolved_references`
    /// that the broadcast frame must never mirror.
    fn names_a_bystander_command() -> SendMessage {
        ready(SendMessage::prepare(
            SendMessageDraft {
                source_conversation: channel(),
                target_conversation: channel(),
                actor: SendActor::User(user()),
                content: MessageContent::parse("<silverhand://human/bystander> ping").unwrap(),
                destination: SendDestination::MainLine,
                attachment_refs: Vec::new(),
                freshness_bypass: false,
            },
            &AllReferences,
            &DirectLinesToExternal,
        ))
        .unwrap()
    }

    /// A reply to one message — the arm whose frame carries a `projections` sidecar.
    fn reply_command(target: &MessageId) -> SendMessage {
        ready(SendMessage::prepare(
            SendMessageDraft {
                source_conversation: channel(),
                target_conversation: channel(),
                actor: SendActor::User(user()),
                content: MessageContent::parse("a reply").unwrap(),
                destination: SendDestination::Reply(target.clone()),
                attachment_refs: Vec::new(),
                freshness_bypass: false,
            },
            &AllReferences,
            &DirectLinesToExternal,
        ))
        .unwrap()
    }

    /// The ONE `message` frame the production door emits to the channel for a committed
    /// send — captured off the real hub, not re-derived. `Message` is the only frame this
    /// helper asks for; a caller that seeds mentions/unread would see those on other scopes.
    async fn emitted_channel_message(view: CommittedMessageView<'_>) -> Value {
        let hub = ScopeEventHub::test("epoch-1");
        <ScopeEventHub as CommittedMessagePublication>::publish_message(&hub, view)
            .await
            .unwrap();
        match scope_events(&hub, EventScope::Conversation(channel())).as_slice() {
            [ProductEvent::Message(payload)] => payload.clone(),
            other => panic!("the door must publish exactly one message frame, got {other:?}"),
        }
    }

    /// The ACK is the conversation frame PLUS a sender-only diagnostic — never a second
    /// shape, and the frame never carries the diagnostic.
    ///
    /// `send_ack` and the broadcast door both project the shared `{message, projections?}`
    /// from the SAME committed outcome; the only difference the ACK may carry is
    /// `unresolved_references`, whose audience is one. This asserts the whole JSON: strip
    /// that one member from the ACK and it must equal the frame byte for byte, and the frame
    /// must never have carried it.
    fn assert_ack_is_frame_plus_unresolved(
        frame: &Value,
        outcome: &SendMessageOutcome,
        expects_unresolved: bool,
    ) {
        assert!(
            frame.get("unresolved_references").is_none(),
            "the broadcast frame must never carry the sender-only diagnostic: {frame}"
        );
        let mut ack = crate::messaging::ack::send_ack(outcome);
        let removed = ack
            .as_object_mut()
            .expect("the ACK is an object")
            .remove("unresolved_references");
        assert_eq!(
            removed.is_some(),
            expects_unresolved,
            "unresolved_references presence disagreed with the outcome"
        );
        assert_eq!(
            &ack, frame,
            "the ACK's shared half must equal the conversation frame whole"
        );
    }

    /// The sender's ACK and everyone's `message` frame are ONE projection from ONE
    /// committed send, on BOTH arms. The main-line arm names an unseated bystander, so its
    /// ACK carries `unresolved_references` the frame must not; the reply arm carries the
    /// `projections` sidecar on both. If `send_ack` and the broadcast door ever read
    /// different reply sources, or the sender-only member leaks onto the wire, the whole-JSON
    /// equality breaks.
    #[tokio::test]
    async fn the_ack_is_the_conversation_frame_plus_a_sender_only_diagnostic() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("ack-parity.sqlite");
        seed_fanout(&path).await;
        let store = MessagingStore::open(&path).await.unwrap();

        // MAIN-LINE arm: no projections, and a bystander reference that reaches nobody.
        let main = store
            .send_message(names_a_bystander_command())
            .await
            .unwrap();
        let main_view = main
            .committed()
            .main_line()
            .expect("a main-line send")
            .published();
        assert!(
            main_view.reply_projection().is_none(),
            "a main-line frame carries no projections sidecar"
        );
        let main_frame = emitted_channel_message(main_view).await;
        assert_ack_is_frame_plus_unresolved(&main_frame, &main, true);

        // REPLY arm: the root, then a reply to it — the frame gains a projections sidecar
        // and the equality must still hold arm-for-arm.
        let root = store.send_message(plain_command()).await.unwrap();
        let root_id = root.committed().message().id.clone();
        let reply = store.send_message(reply_command(&root_id)).await.unwrap();
        let reply_view = reply
            .committed()
            .reply_cluster()
            .expect("a reply send")
            .published();
        assert!(
            reply_view.reply_projection().is_some(),
            "a reply frame carries the projections sidecar"
        );
        let reply_frame = emitted_channel_message(reply_view).await;
        assert!(
            reply_frame.get("projections").is_some(),
            "the reply frame must carry projections: {reply_frame}"
        );
        assert_ack_is_frame_plus_unresolved(&reply_frame, &reply, false);
    }

    /// One viewer's replay, as the product events alone — the retained transport window,
    /// used as an ordering witness (NOT a cold read of committed state).
    fn scope_events(hub: &ScopeEventHub, scope: EventScope) -> Vec<ProductEvent> {
        let resumed = hub
            .resume(
                &scope,
                &TransportEpoch::parse("epoch-1").unwrap(),
                TransportSeq::ZERO,
            )
            .unwrap();
        let Replay::Events(events) = resumed.replay else {
            panic!("the retained window must hold this scope's whole replay")
        };
        events.into_iter().map(|event| event.event).collect()
    }

    /// One viewer's unread state as a FRESH read-model computation over the committed
    /// database — the cold authority a page load would run, independent of any frame the
    /// transport happens to be holding. The live co-emit must equal this field for field.
    async fn workspace_cold_viewer(
        path: &std::path::Path,
        conversation: &ConversationId,
        viewer: &UserId,
    ) -> ViewerUnread {
        let model = SqliteUnreadReadModel::open(path).await.unwrap();
        let UnreadAudience::Workspace { viewers, .. } = model
            .unread_audience(conversation)
            .await
            .unwrap()
            .expect("the conversation is present")
        else {
            panic!("a workspace conversation must yield a workspace audience");
        };
        viewers
            .into_iter()
            .find(|candidate| &candidate.viewer == viewer)
            .expect("the viewer is owed an unread update")
    }

    /// Asserts a live co-emit carries exactly the cold read-model's unread state for a
    /// viewer — the projection is a faithful carrier of committed state, not a second
    /// opinion computed on the effect path.
    fn assert_co_emit_matches_cold(
        unread: &ProductEvent,
        badge: &ProductEvent,
        cold: &ViewerUnread,
    ) {
        let (ProductEvent::UnreadUpdated(unread), ProductEvent::AttentionBadgeUpdated(badge)) =
            (unread, badge)
        else {
            panic!("expected an unread+badge co-emit, got {unread:?} then {badge:?}");
        };
        assert_eq!(
            unread.conversation_unread_count, cold.conversation_unread_count,
            "conversation unread diverged from the cold read model"
        );
        assert_eq!(
            unread.workspace_unread_count, cold.workspace_unread_count,
            "workspace unread diverged from the cold read model"
        );
        // WHOLE-VALUE, not just presence: a mis-projected anchor coordinate
        // (conversation_id/message_id/seq/thread_root_id) must fail here, so the live
        // anchor is compared field for field to the cold read-model row projected through
        // the SAME `latest_unread_wire` the production port uses.
        assert_eq!(
            unread.latest_unread,
            cold.latest_unread.as_ref().map(latest_unread_wire),
            "the latest-unread anchor diverged from the cold read model"
        );
        assert_eq!(
            badge.badge_count, cold.badge_count,
            "the attention badge diverged from the cold read model"
        );
    }

    /// Advances a reader's main-line cursor past everything in a conversation.
    async fn mark_all_read(path: &std::path::Path, viewer: &str, conversation: &str) {
        let mut db = SqliteConnection::connect(&format!("sqlite://{}", path.display()))
            .await
            .unwrap();
        let latest: i64 = sqlx::query_scalar(
            "SELECT COALESCE(MAX(seq), 0) FROM messages WHERE conversation_id = ?",
        )
        .bind(conversation)
        .fetch_one(&mut db)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO conversation_reads (user_id, conversation_id, thread_root_id, \
             last_read_seq, read_at) VALUES (?, ?, NULL, ?, 2)",
        )
        .bind(viewer)
        .bind(conversation)
        .bind(latest)
        .execute(&mut db)
        .await
        .unwrap();
        db.close().await.unwrap();
    }

    /// Enrolls a human as a follower of one thread, so its replies count toward their
    /// unread — the precondition for a THREADED latest-unread anchor.
    async fn follow_thread(path: &std::path::Path, viewer: &str, conversation: &str, root: &str) {
        let mut db = SqliteConnection::connect(&format!("sqlite://{}", path.display()))
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO thread_followers (thread_root_id, conversation_id, principal_kind, \
             principal_id, followed_at, source) VALUES (?, ?, 'human', ?, 2, 'manual')",
        )
        .bind(root)
        .bind(conversation)
        .bind(viewer)
        .execute(&mut db)
        .await
        .unwrap();
        db.close().await.unwrap();
    }

    /// Advances a reader's PER-THREAD cursor past everything in a conversation — the
    /// clearing a main-line `mark_all_read` cannot express, since the two cursors are
    /// independent rows.
    async fn mark_thread_read(
        path: &std::path::Path,
        viewer: &str,
        conversation: &str,
        root: &str,
    ) {
        let mut db = SqliteConnection::connect(&format!("sqlite://{}", path.display()))
            .await
            .unwrap();
        let latest: i64 = sqlx::query_scalar(
            "SELECT COALESCE(MAX(seq), 0) FROM messages WHERE conversation_id = ?",
        )
        .bind(conversation)
        .fetch_one(&mut db)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO conversation_reads (user_id, conversation_id, thread_root_id, \
             last_read_seq, read_at) VALUES (?, ?, ?, ?, 2)",
        )
        .bind(viewer)
        .bind(conversation)
        .bind(root)
        .bind(latest)
        .execute(&mut db)
        .await
        .unwrap();
        db.close().await.unwrap();
    }

    #[tokio::test]
    async fn a_workspace_send_fans_out_across_ports_without_duplicate_or_widening() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("fanout.sqlite");
        seed_fanout(&path).await;
        let store = MessagingStore::open(&path).await.unwrap();
        let outcome = store.send_message(fanout_command()).await.unwrap();

        // One committed send, one mention-CC copy, on a line that is NOT the channel.
        let copy_line = match outcome.committed().mention_copies() {
            [MentionCopyOutcome::Copied { copy, .. }] => copy.conversation_id.clone(),
            other => panic!("expected exactly one copied mention, got {other:?}"),
        };
        assert_ne!(copy_line.as_str(), "conversation-1");

        let hub = ScopeEventHub::test("epoch-1");
        let unread = HubUnreadPublisher::new(
            hub.clone(),
            SqliteUnreadReadModel::open(&path).await.unwrap(),
        );
        let doubles = OtherEffects::default();
        let discarded = Discarded;

        // The copy layer: the copy's own line invalidation, publication, and the author's
        // notice. Delivery/start/skip are #2185's inert doubles.
        let copy_report = announce_send(
            outcome.committed(),
            SendEffects {
                direct_lines: &hub,
                publication: &hub,
                notification: &hub,
                start: &doubles,
                delivery: &doubles,
                skips: &doubles,
            },
        )
        .await;
        assert!(copy_report.failed.is_empty());

        // The main-line layer: the one conversation frame, the durable mention rows and
        // their notices, and the unread/badge co-emit through the real read model.
        let main_report = announce_main_send(
            outcome.committed().main_line().expect("a main-line send"),
            MainEffects {
                publication: &hub,
                mentions: &store,
                viewers: &hub,
                unread: &unread,
                delivery: &discarded,
                idle: &discarded,
            },
        )
        .await;
        assert!(main_report.failed.is_empty());

        // The channel carries EXACTLY ONE message frame: the copy did not widen onto it,
        // and no path published the message twice.
        let channel_frames = scope_events(&hub, EventScope::Conversation(channel()));
        assert_eq!(channel_frames.len(), 1);
        assert!(matches!(channel_frames[0], ProductEvent::Message(_)));

        // The copy rides its OWN line's conversation scope — the distinct audience a
        // copy-only viewer watches, never the channel's.
        let copy_frames = scope_events(&hub, EventScope::Conversation(copy_line));
        assert_eq!(copy_frames.len(), 1);
        assert!(matches!(copy_frames[0], ProductEvent::Message(_)));

        // The seated reader who was named: one mention_self notice, then one unread+badge
        // co-emit — never the notice twice, never a badge without its unread.
        let reader = scope_events(&hub, EventScope::Viewer(mentioned()));
        assert!(
            matches!(
                reader.as_slice(),
                [
                    ProductEvent::Notification(notice),
                    ProductEvent::UnreadUpdated(unread),
                    ProductEvent::AttentionBadgeUpdated(badge),
                ] if notice.kind == NotificationKind::MentionSelf
                    && unread.conversation_unread_count == 1
                    && unread.workspace_unread_count == 1
                    && unread.latest_unread.is_some()
                    && badge.badge_count == 1
            ),
            "the named reader's scope was {reader:?}"
        );

        // The author's own scope: their line invalidation, their mention-left-the-room
        // notice, and their own co-emit — their own message is never their unread (zero),
        // yet the badge still rides beside it.
        let author = scope_events(&hub, EventScope::Viewer(user()));
        assert_eq!(
            author
                .iter()
                .filter(|event| matches!(event, ProductEvent::DirectPairsChanged { .. }))
                .count(),
            1
        );
        assert_eq!(
            author
                .iter()
                .filter(|event| matches!(
                    event,
                    ProductEvent::Notification(notice)
                        if notice.kind == NotificationKind::MentionExternal
                ))
                .count(),
            1
        );
        assert!(
            author.windows(2).any(|pair| matches!(
                pair,
                [ProductEvent::UnreadUpdated(unread), ProductEvent::AttentionBadgeUpdated(badge)]
                    if unread.conversation_unread_count == 0 && badge.badge_count == 0
            )),
            "the author's unread+badge co-emit was not adjacent: {author:?}"
        );

        // No widening: a workspace member NOT seated in the channel is owed nothing. The
        // unread audience is the conversation's participants, not the workspace's roster.
        let bystander = scope_events(&hub, EventScope::Viewer(UserId::parse("user-3").unwrap()));
        assert!(
            bystander.is_empty(),
            "an unseated member received {bystander:?}"
        );
    }

    #[tokio::test]
    async fn workspace_unread_arrival_and_clearing_ride_one_co_emit_live_and_cold() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("workspace-unread.sqlite");
        seed_fanout(&path).await;
        let store = MessagingStore::open(&path).await.unwrap();
        // A main-line root the reader catches up on, then a reply they follow: the arrival
        // anchor is a THREADED row, so the co-emit must carry its `thread_root`, not merely
        // prove some anchor exists.
        let root = store.send_message(plain_command()).await.unwrap();
        let root_id = root.committed().message().id.clone();
        mark_all_read(&path, "user-2", "conversation-1").await;
        follow_thread(&path, "user-2", "conversation-1", root_id.as_str()).await;
        store.send_message(reply_command(&root_id)).await.unwrap();

        let hub = ScopeEventHub::test("epoch-1");
        let unread = HubUnreadPublisher::new(
            hub.clone(),
            SqliteUnreadReadModel::open(&path).await.unwrap(),
        );

        // Live BEFORE the publish: the arrival must be observed on the wire, not only in
        // replay.
        let mut live = hub
            .subscribe(EventScope::Viewer(mentioned()))
            .unwrap()
            .receiver;
        unread.publish_unread(&channel()).await.unwrap();

        let arrival_unread = live.recv().await.unwrap().event;
        let arrival_badge = live.recv().await.unwrap().event;
        assert!(
            matches!(
                arrival_unread,
                ProductEvent::UnreadUpdated(ref unread)
                    if unread.conversation_unread_count == 1
                        && matches!(
                            unread.latest_unread,
                            Some(ref anchor) if anchor.thread_root_id.as_deref() == Some(root_id.as_str())
                        )
            ),
            "the arrival anchor must be the THREADED reply, carrying its thread_root: {arrival_unread:?}"
        );
        assert!(matches!(
            arrival_badge,
            ProductEvent::AttentionBadgeUpdated(ref badge) if badge.badge_count == 1
        ));
        // COLD authority: the live co-emit equals a fresh read-model computation over the
        // committed database, field for field — not the transport's own replay buffer.
        let cold_arrival = workspace_cold_viewer(&path, &channel(), &mentioned()).await;
        assert_eq!(cold_arrival.conversation_unread_count, 1);
        assert_co_emit_matches_cold(&arrival_unread, &arrival_badge, &cold_arrival);

        // The reader catches up on the FOLLOWED THREAD (a per-thread cursor, independent of
        // the main-line one), and the same conversation is republished.
        mark_thread_read(&path, "user-2", "conversation-1", root_id.as_str()).await;
        unread.publish_unread(&channel()).await.unwrap();

        let clearing_unread = live.recv().await.unwrap().event;
        let clearing_badge = live.recv().await.unwrap().event;
        // The SAME two frame kinds carry the clearing — a settled unread, not a withheld
        // one — and the anchor is dropped, never left stale.
        assert!(matches!(
            clearing_unread,
            ProductEvent::UnreadUpdated(ref unread)
                if unread.conversation_unread_count == 0 && unread.latest_unread.is_none()
        ));
        assert!(matches!(
            clearing_badge,
            ProductEvent::AttentionBadgeUpdated(ref badge) if badge.badge_count == 0
        ));
        // COLD authority again after the cursor moved: the cleared co-emit still equals a
        // fresh read-model computation, so clearing is settled state, not a lucky frame.
        let cold_cleared = workspace_cold_viewer(&path, &channel(), &mentioned()).await;
        assert_eq!(cold_cleared.conversation_unread_count, 0);
        assert_co_emit_matches_cold(&clearing_unread, &clearing_badge, &cold_cleared);

        // The retained transport window (replay, NOT a cold read) holds all four in order —
        // arrival then clearing, each a co-emit — so a resuming client catches up on the
        // whole ordered pair, never a lone half.
        let replay = scope_events(&hub, EventScope::Viewer(mentioned()));
        assert!(matches!(
            replay.as_slice(),
            [
                ProductEvent::UnreadUpdated(_),
                ProductEvent::AttentionBadgeUpdated(_),
                ProductEvent::UnreadUpdated(_),
                ProductEvent::AttentionBadgeUpdated(_),
            ]
        ));
    }

    /// A viewer's unread+badge, with a moved count, so a half-emit would be observable.
    fn viewer_unread_of(viewer: &str, badge: i64) -> ViewerUnread {
        ViewerUnread {
            viewer: UserId::parse(viewer).unwrap(),
            conversation_unread_count: 1,
            workspace_unread_count: 1,
            latest_unread: None,
            badge_count: badge,
        }
    }

    /// The co-emit is BOTH-OR-NEITHER at the sequence ceiling, not first-wins.
    ///
    /// This is the discriminating case the two-publish shape got wrong: seeded one below
    /// the ceiling, a lone `publish` would land the unread at `MAX` and only the badge's
    /// `checked_next` would fail — a persisted half-pair, exactly what the door swears a
    /// client can never see. The batch reserves both sequence numbers before touching the
    /// ring, so the second reservation overflowing leaves ZERO frames, and the door either
    /// moves the unread and the badge together or moves neither.
    #[test]
    fn an_unread_co_emit_is_both_or_neither_at_the_sequence_ceiling() {
        let hub = ScopeEventHub::test("epoch-1");
        let workspace = WorkspaceId::parse("workspace-1").unwrap();
        let conversation = channel();
        let scope = EventScope::Viewer(mentioned());

        // One below the ceiling: a 2-event co-emit needs seq MAX and MAX+1; the second
        // overflows, so the whole co-emit must fail with no frame persisted.
        hub.scopes
            .lock()
            .unwrap()
            .entry(scope.clone())
            .or_insert_with(ScopeState::new)
            .seq = TransportSeq(MAX_TRANSPORT_SEQ - 1);
        assert!(matches!(
            hub.publish_unread_updated_to_viewer(
                &workspace,
                &conversation,
                &viewer_unread_of("user-2", 1),
            ),
            Err(ScopeEventHubError::SequenceExhausted)
        ));
        // Read the replay ring directly: a resume cannot describe zero frames (an empty ring
        // behind a non-zero seq is a SnapshotRequired gap), and zero frames is exactly the
        // claim — the exhausted co-emit persisted no lone unread.
        assert!(
            hub.scopes
                .lock()
                .unwrap()
                .get(&scope)
                .unwrap()
                .replay
                .is_empty(),
            "an exhausted co-emit must leave zero frames, never a lone unread"
        );

        // Two below the ceiling: MAX-1 and MAX both fit, so the co-emit lands whole.
        hub.scopes.lock().unwrap().get_mut(&scope).unwrap().seq =
            TransportSeq(MAX_TRANSPORT_SEQ - 2);
        hub.publish_unread_updated_to_viewer(
            &workspace,
            &conversation,
            &viewer_unread_of("user-2", 1),
        )
        .unwrap();
        let landed: Vec<ProductEvent> = hub
            .scopes
            .lock()
            .unwrap()
            .get(&scope)
            .unwrap()
            .replay
            .iter()
            .map(|frame| frame.event.clone())
            .collect();
        assert!(matches!(
            landed.as_slice(),
            [
                ProductEvent::UnreadUpdated(_),
                ProductEvent::AttentionBadgeUpdated(_),
            ]
        ));
    }

    #[tokio::test]
    async fn a_direct_pair_unread_takes_the_distinct_axis_for_both_endpoints() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("direct-unread.sqlite");
        seed_direct_pair(&path).await;

        let hub = ScopeEventHub::test("epoch-1");
        let unread = HubUnreadPublisher::new(
            hub.clone(),
            SqliteUnreadReadModel::open(&path).await.unwrap(),
        );
        let line = ConversationId::parse("conversation-2").unwrap();

        let mut live_a = hub.subscribe(EventScope::Viewer(user())).unwrap().receiver;
        let mut live_b = hub
            .subscribe(EventScope::Viewer(mentioned()))
            .unwrap()
            .receiver;

        // A direct line has no workspace unread surface: each human endpoint's list is
        // invalidated instead — never an UnreadUpdated/AttentionBadge co-emit.
        unread.publish_unread(&line).await.unwrap();
        assert!(matches!(
            live_a.recv().await.unwrap().event,
            ProductEvent::DirectPairsChanged { .. }
        ));
        assert!(matches!(
            live_b.recv().await.unwrap().event,
            ProductEvent::DirectPairsChanged { .. }
        ));

        // The same carrier rides the other direction, so arrival and clearing are symmetric
        // on this axis too.
        unread.publish_unread(&line).await.unwrap();
        assert!(matches!(
            live_a.recv().await.unwrap().event,
            ProductEvent::DirectPairsChanged { .. }
        ));
        assert!(matches!(
            live_b.recv().await.unwrap().event,
            ProductEvent::DirectPairsChanged { .. }
        ));

        // This gate proves ONLY the LIVE INVALIDATION CARRIER for a direct pair: both
        // endpoints are told their list is stale, and no workspace unread/badge frame ever
        // rides this placement. It is NOT a cold read — the retained window below is the
        // transport's own buffer, not a fresh direct-pair list computed off the committed
        // database. There is no Rust direct-pair cold face in this tree (no list read model,
        // no `GET /api/direct-pairs`), so cold/live PARITY for the DM surface is out of scope
        // here and is delivered by #task:2187, which consumes this ticket's reviewed hash.
        for scope in [EventScope::Viewer(user()), EventScope::Viewer(mentioned())] {
            let events = scope_events(&hub, scope);
            assert_eq!(events.len(), 2);
            assert!(
                events
                    .iter()
                    .all(|event| matches!(event, ProductEvent::DirectPairsChanged { .. }))
            );
        }
    }

    /// A person's plain send into an arbitrary conversation — enough to move a seated
    /// reader's unread, whichever placement the channel has.
    fn plain_send(conversation: ConversationId) -> SendMessage {
        ready(SendMessage::prepare(
            SendMessageDraft {
                source_conversation: conversation.clone(),
                target_conversation: conversation,
                actor: SendActor::User(user()),
                content: MessageContent::parse("hello").unwrap(),
                destination: SendDestination::MainLine,
                attachment_refs: Vec::new(),
                freshness_bypass: false,
            },
            &AllReferences,
            &DirectLinesToExternal,
        ))
        .unwrap()
    }

    /// One workspace holding a FIXED-roster and an OPEN-roster channel, each with its own
    /// seated reader, and the workspace muted for BOTH readers. The mute is what makes the
    /// two `loud_positional` arms discriminating: a fixed channel enters the badge on its
    /// roster policy alone, an open one only by ambiently entering — which the mute blocks.
    async fn seed_placement_matrix(path: &std::path::Path) {
        let mut db = current_schema::create_current_schema(path).await;
        for statement in [
            "INSERT INTO users (id, name, display_name, created_at, updated_at) \
             VALUES ('user-1', 'sender', 'Sender', 1, 1)",
            "INSERT INTO users (id, name, display_name, created_at, updated_at) \
             VALUES ('user-2', 'on-fixed', 'OnFixed', 2, 2)",
            "INSERT INTO users (id, name, display_name, created_at, updated_at) \
             VALUES ('user-3', 'on-open', 'OnOpen', 3, 3)",
            "INSERT INTO users (id, name, display_name, created_at, updated_at) \
             VALUES ('user-4', 'sees-public', 'SeesPublic', 4, 4)",
            "INSERT INTO workspaces (id, name, name_key, owner_user_id, created_at, updated_at) \
             VALUES ('workspace-1', 'Space', 'space', 'user-1', 1, 1)",
            "INSERT INTO workspace_users (workspace_id, user_id, joined_at, role) \
             VALUES ('workspace-1', 'user-1', 1, 'owner')",
            "INSERT INTO workspace_users (workspace_id, user_id, joined_at, role) \
             VALUES ('workspace-1', 'user-2', 1, 'member')",
            "INSERT INTO workspace_users (workspace_id, user_id, joined_at, role) \
             VALUES ('workspace-1', 'user-3', 1, 'member')",
            "INSERT INTO workspace_users (workspace_id, user_id, joined_at, role) \
             VALUES ('workspace-1', 'user-4', 1, 'member')",
            "INSERT INTO conversations (id, workspace_id, placement_kind, roster_policy, title, \
             title_key, status, visibility, created_at, updated_at) VALUES \
             ('conversation-fixed', 'workspace-1', 'workspace', 'fixed', 'Fixed', 'fixed', \
             'open', 'private', 1, 1)",
            "INSERT INTO conversations (id, workspace_id, placement_kind, roster_policy, title, \
             title_key, status, visibility, created_at, updated_at) VALUES \
             ('conversation-open', 'workspace-1', 'workspace', 'open', 'Open', 'open', \
             'open', 'private', 1, 1)",
            // A PUBLIC channel: visibility 'public' (open roster, as the schema requires).
            // user-4 is a workspace member who could read/subscribe by visibility, but is NOT
            // seated — the unread push audience must still exclude them.
            "INSERT INTO conversations (id, workspace_id, placement_kind, roster_policy, title, \
             title_key, status, visibility, created_at, updated_at) VALUES \
             ('conversation-public', 'workspace-1', 'workspace', 'open', 'Public', 'public', \
             'open', 'public', 1, 1)",
            "INSERT INTO conversation_users (conversation_id, user_id, joined_at) \
             VALUES ('conversation-fixed', 'user-1', 1)",
            "INSERT INTO conversation_users (conversation_id, user_id, joined_at) \
             VALUES ('conversation-fixed', 'user-2', 1)",
            "INSERT INTO conversation_users (conversation_id, user_id, joined_at) \
             VALUES ('conversation-open', 'user-1', 1)",
            "INSERT INTO conversation_users (conversation_id, user_id, joined_at) \
             VALUES ('conversation-open', 'user-3', 1)",
            "INSERT INTO conversation_users (conversation_id, user_id, joined_at) \
             VALUES ('conversation-public', 'user-1', 1)",
            "INSERT INTO workspace_attention_preferences (user_id, workspace_id, muted, updated_at) \
             VALUES ('user-2', 'workspace-1', 1, 1)",
            "INSERT INTO workspace_attention_preferences (user_id, workspace_id, muted, updated_at) \
             VALUES ('user-3', 'workspace-1', 1, 1)",
        ] {
            sqlx::query(statement).execute(&mut db).await.unwrap();
        }
        db.close().await.unwrap();
    }

    /// Seats or unseats a user in a conversation, so the participant set the audience is
    /// computed from moves under a fresh read.
    async fn set_conversation_membership(
        path: &std::path::Path,
        conversation: &str,
        user: &str,
        seated: bool,
    ) {
        let mut db = SqliteConnection::connect(&format!("sqlite://{}", path.display()))
            .await
            .unwrap();
        let statement = if seated {
            "INSERT INTO conversation_users (conversation_id, user_id, joined_at) VALUES (?, ?, 1)"
        } else {
            "DELETE FROM conversation_users WHERE conversation_id = ? AND user_id = ?"
        };
        sqlx::query(statement)
            .bind(conversation)
            .bind(user)
            .execute(&mut db)
            .await
            .unwrap();
        db.close().await.unwrap();
    }

    /// The sorted viewer ids of a workspace audience — the set that decides who is owed an
    /// unread update.
    fn workspace_audience_ids(audience: &UnreadAudience) -> Vec<String> {
        let UnreadAudience::Workspace { viewers, .. } = audience else {
            panic!("a workspace conversation must yield a workspace audience: {audience:?}");
        };
        let mut ids: Vec<String> = viewers
            .iter()
            .map(|viewer| viewer.viewer.as_str().to_owned())
            .collect();
        ids.sort();
        ids
    }

    /// The unread count is placement-independent, but the BADGE enters on the arm the
    /// roster policy names: a fixed channel positionally regardless of a workspace mute, an
    /// open one only when it ambiently enters — which the mute forecloses.
    ///
    /// Same committed unread, opposite badge: the discriminating case that proves the two
    /// arms of `loud_positional` are genuinely distinct rather than one arm doing all the
    /// work. Read cold off the committed database — the read model is the badge authority.
    #[tokio::test]
    async fn the_unread_badge_enters_on_the_arm_the_roster_policy_names() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("placement-matrix.sqlite");
        seed_placement_matrix(&path).await;
        let store = MessagingStore::open(&path).await.unwrap();
        let fixed = ConversationId::parse("conversation-fixed").unwrap();
        let open = ConversationId::parse("conversation-open").unwrap();
        store.send_message(plain_send(fixed.clone())).await.unwrap();
        store.send_message(plain_send(open.clone())).await.unwrap();

        // Each reader has exactly one unread message — unread itself does not care about the
        // roster policy.
        let on_fixed = workspace_cold_viewer(&path, &fixed, &mentioned()).await;
        let on_open = workspace_cold_viewer(&path, &open, &UserId::parse("user-3").unwrap()).await;
        assert_eq!(on_fixed.conversation_unread_count, 1);
        assert_eq!(on_open.conversation_unread_count, 1);

        // The badge does. The muted fixed channel still enters; the muted open channel does
        // not — the whole point of the two arms.
        assert_eq!(
            on_fixed.badge_count, 1,
            "a fixed-roster channel must enter the badge despite the workspace mute"
        );
        assert_eq!(
            on_open.badge_count, 0,
            "a muted open channel must not enter the badge positionally"
        );
    }

    /// The unread audience is exactly the conversation's seated participants, and it tracks
    /// membership: seat a workspace member and they join the audience, unseat a reader and
    /// they leave it. A fresh read each time, because the audience is a read off the
    /// committed roster, not a cached set.
    #[tokio::test]
    async fn the_unread_audience_expands_and_contracts_with_conversation_membership() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("membership.sqlite");
        // seed_fanout seats user-1 and user-2; user-3 is a workspace member but NOT seated.
        seed_fanout(&path).await;
        let store = MessagingStore::open(&path).await.unwrap();
        store.send_message(plain_command()).await.unwrap();

        let audience = |path: std::path::PathBuf| async move {
            SqliteUnreadReadModel::open(&path)
                .await
                .unwrap()
                .unread_audience(&channel())
                .await
                .unwrap()
                .expect("the conversation is present")
        };

        // Only the seated participants — the unseated workspace member is owed nothing.
        assert_eq!(
            workspace_audience_ids(&audience(path.clone()).await),
            ["user-1", "user-2"]
        );

        // Seat the bystander: the audience expands to include them.
        set_conversation_membership(&path, "conversation-1", "user-3", true).await;
        assert_eq!(
            workspace_audience_ids(&audience(path.clone()).await),
            ["user-1", "user-2", "user-3"]
        );

        // Unseat a reader: the audience contracts to drop them.
        set_conversation_membership(&path, "conversation-1", "user-2", false).await;
        assert_eq!(
            workspace_audience_ids(&audience(path.clone()).await),
            ["user-1", "user-3"]
        );
    }

    /// A PUBLIC conversation pushes unread only to its SEATS, never to everyone its
    /// visibility lets read it.
    ///
    /// This closes the `workspace/public/fixed/direct-pair` matrix the task requires:
    /// user-4 is a workspace member of a PUBLIC channel, so visibility would authorize them
    /// to cold-read or subscribe — a different axis, decided by the scope authority, not this
    /// port. The unread PUSH audience is the seated roster alone: user-4 is owed nothing until
    /// a real seat enters, and is dropped again when it leaves. Being able to see a channel is
    /// not being owed an unread update for it.
    #[tokio::test]
    async fn a_public_conversation_pushes_unread_only_to_its_seats() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("public-audience.sqlite");
        seed_placement_matrix(&path).await;

        let public = ConversationId::parse("conversation-public").unwrap();
        let audience = |path: std::path::PathBuf, conversation: ConversationId| async move {
            SqliteUnreadReadModel::open(&path)
                .await
                .unwrap()
                .unread_audience(&conversation)
                .await
                .unwrap()
                .expect("the conversation is present")
        };

        // user-4 can SEE the public channel (workspace member + public visibility) yet is not
        // seated — the push audience is the seat, user-1, alone.
        assert_eq!(
            workspace_audience_ids(&audience(path.clone(), public.clone()).await),
            ["user-1"]
        );

        // A real seat enters: now user-4 is owed the update.
        set_conversation_membership(&path, "conversation-public", "user-4", true).await;
        assert_eq!(
            workspace_audience_ids(&audience(path.clone(), public.clone()).await),
            ["user-1", "user-4"]
        );

        // The seat leaves: back to the seated roster, though visibility never changed.
        set_conversation_membership(&path, "conversation-public", "user-4", false).await;
        assert_eq!(
            workspace_audience_ids(&audience(path.clone(), public.clone()).await),
            ["user-1"]
        );
    }

    /// Poisons a hub's registry, so every subsequent publish path fails with
    /// [`ScopeEventHubError::RegistryPoisoned`] — a deterministic driver-level failure with
    /// no DB or timing dependency.
    fn poison_registry(hub: &ScopeEventHub) {
        let registry = Arc::clone(&hub.scopes);
        let _ = std::thread::spawn(move || {
            let _guard = registry.lock().unwrap();
            panic!("poison the test registry");
        })
        .join();
    }

    /// A committed mention row, hand-built: the failure gate below cares only that the port
    /// maps a hub failure to a source-preserving [`EffectFailure`], and that mapping does
    /// not read the row's contents.
    fn a_committed_mention_row() -> CommittedMentionRow {
        CommittedMentionRow::committed(
            NotificationId::parse("row-1").unwrap(),
            11,
            mentioned(),
            ParticipantHandle::parse("mentioned").unwrap(),
            MentionIntent::committed(
                vec![ParticipantHandle::parse("mentioned").unwrap()],
                Some(user()),
                "Sender".to_owned(),
                WorkspaceId::parse("workspace-1").unwrap(),
                channel(),
                "Channel".to_owned(),
                MessageId::parse("source-message").unwrap(),
                "ping".to_owned(),
            ),
        )
    }

    /// A read model that hands back a fixed audience without touching a database — lets the
    /// batch co-emit be driven against a poisoned hub with a real workspace audience.
    struct StubWorkspaceAudience(UnreadAudience);

    impl UnreadReadModel for StubWorkspaceAudience {
        async fn unread_audience(
            &self,
            _conversation: &ConversationId,
        ) -> Result<Option<UnreadAudience>, PersistenceFailure> {
            Ok(Some(self.0.clone()))
        }
    }

    /// A read model that fails, carrying a distinctive driver cause the port must preserve.
    struct FailingReadModel;

    #[derive(Debug)]
    struct ReadModelBoom;

    impl fmt::Display for ReadModelBoom {
        fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str("read model boom")
        }
    }

    impl Error for ReadModelBoom {}

    impl UnreadReadModel for FailingReadModel {
        async fn unread_audience(
            &self,
            _conversation: &ConversationId,
        ) -> Result<Option<UnreadAudience>, PersistenceFailure> {
            Err(PersistenceFailure::from_source(ReadModelBoom))
        }
    }

    /// Every direct-publish port surfaces a hub failure as an [`EffectFailure`] whose source
    /// is the ORIGINAL [`ScopeEventHubError`] — never a new opaque error that has discarded
    /// the cause a retry or telemetry seam needs.
    ///
    /// Table-driven over all four ports off ONE real committed send, against ONE poisoned
    /// hub: a `map_err` that flattened the source, or a port that swallowed the failure,
    /// fails here for that port specifically.
    #[tokio::test]
    async fn a_hub_failure_reaches_every_direct_port_as_a_source_preserving_effect_failure() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("port-failures.sqlite");
        seed_fanout(&path).await;
        let store = MessagingStore::open(&path).await.unwrap();
        let outcome = store.send_message(fanout_command()).await.unwrap();
        let committed = outcome.committed();
        let copy = match committed.mention_copies() {
            [MentionCopyOutcome::Copied { copy, .. }] => copy,
            other => panic!("expected exactly one copied mention, got {other:?}"),
        };
        let view = committed.main_line().expect("a main-line send").published();
        let mention = a_committed_mention_row();

        let hub = ScopeEventHub::test("epoch-1");
        poison_registry(&hub);

        let failures: Vec<(&str, EffectFailure)> = vec![
            (
                "publish_copy",
                <ScopeEventHub as MessagePublication>::publish_copy(&hub, copy)
                    .await
                    .expect_err("a poisoned hub must fail the copy publication"),
            ),
            (
                "publish_message",
                <ScopeEventHub as CommittedMessagePublication>::publish_message(&hub, view)
                    .await
                    .expect_err("a poisoned hub must fail the message publication"),
            ),
            (
                "notify_author",
                <ScopeEventHub as CopyNotification>::notify_author(&hub, &user(), &agent(), copy)
                    .await
                    .expect_err("a poisoned hub must fail the author notice"),
            ),
            (
                "notify_viewer",
                <ScopeEventHub as ViewerNotification>::notify_viewer(&hub, &mention)
                    .await
                    .expect_err("a poisoned hub must fail the viewer notice"),
            ),
        ];

        for (port, failure) in &failures {
            let source = Error::source(failure)
                .unwrap_or_else(|| panic!("{port} dropped the failure source entirely"));
            assert!(
                matches!(
                    source.downcast_ref::<ScopeEventHubError>(),
                    Some(ScopeEventHubError::RegistryPoisoned)
                ),
                "{port} did not preserve the ScopeEventHubError source: {source}"
            );
        }
    }

    /// The unread port has TWO distinct failure origins, and both reach the effect chain as
    /// a source-preserving [`EffectFailure`]: the read model itself failing, and the batch
    /// co-emit hitting a hub failure after the read model succeeded.
    ///
    /// A NARROW MAPPING UNIT over stubs: it pins that `HubUnreadPublisher`'s own `map_err`
    /// preserves whichever source failed, holding the read model and the hub each still in
    /// turn. It does NOT stand in for the real adapter's failure modes — those are proven end
    /// to end against `SqliteUnreadReadModel` in
    /// `the_real_read_model_carries_its_driver_and_decode_failures_through_the_unread_port`.
    #[tokio::test]
    async fn the_unread_port_surfaces_both_its_failure_origins_with_the_source_intact() {
        // (a) The read model fails: its PersistenceFailure is the preserved source, and its
        // own driver cause survives one level deeper.
        let publisher = HubUnreadPublisher::new(ScopeEventHub::test("epoch-1"), FailingReadModel);
        let failure = publisher
            .publish_unread(&channel())
            .await
            .expect_err("the read-model failure must surface");
        let source = Error::source(&failure).expect("the read-model failure kept its source");
        assert!(
            source.downcast_ref::<PersistenceFailure>().is_some(),
            "the read-model source was not a PersistenceFailure: {source}"
        );
        let inner = Error::source(source).expect("the PersistenceFailure kept its driver cause");
        assert!(
            inner.downcast_ref::<ReadModelBoom>().is_some(),
            "the read-model driver cause was flattened away: {inner}"
        );

        // (b) The read model SUCCEEDS with a real workspace audience, but the batch co-emit
        // hits a poisoned hub: the SAME EffectFailure seam now carries the hub's cause.
        let hub = ScopeEventHub::test("epoch-1");
        poison_registry(&hub);
        let audience = UnreadAudience::Workspace {
            workspace: WorkspaceId::parse("workspace-1").unwrap(),
            viewers: vec![viewer_unread_of("user-2", 1)],
        };
        let publisher = HubUnreadPublisher::new(hub, StubWorkspaceAudience(audience));
        let failure = publisher
            .publish_unread(&channel())
            .await
            .expect_err("the poisoned batch must surface");
        let source = Error::source(&failure).expect("the hub failure kept its source");
        assert!(
            matches!(
                source.downcast_ref::<ScopeEventHubError>(),
                Some(ScopeEventHubError::RegistryPoisoned)
            ),
            "the hub cause was not preserved: {source}"
        );
    }

    /// The REAL SQLite read model carries both of its failure classes — a driver fault and a
    /// decode fault — through `HubUnreadPublisher<SqliteUnreadReadModel>` to a
    /// source-preserving [`EffectFailure`], and emits ZERO frames when it does.
    ///
    /// The stub test above proves only the publisher's mapping; a fake can never fail the way
    /// the driver does. Here the two classes the read model can actually hit are forced
    /// against a fresh committed schema: (a) a dropped `messages` table — the driver cause,
    /// surfacing as `UnreadReadModelError::Sql` with the underlying `sqlx::Error` one level
    /// deeper; (b) a workspace-placed conversation whose stored `workspace_id` is present but
    /// unusable (the empty string) — the decode cause, surfacing as
    /// `UnreadReadModelError::MalformedIdentity`. Both
    /// fail during audience resolution, before any sequence is reserved, so no viewer scope
    /// receives a frame.
    #[tokio::test]
    async fn the_real_read_model_carries_its_driver_and_decode_failures_through_the_unread_port() {
        // (a) DRIVER cause: the read model's count query hits a table that is gone.
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("driver-failure.sqlite");
        seed_fanout(&path).await;
        let model = SqliteUnreadReadModel::open(&path).await.unwrap();
        drop_messages_table(&path).await;

        let hub = ScopeEventHub::test("epoch-1");
        // Subscribe the audience's scopes up front, so "zero frames" is a positive read of an
        // existing, empty scope rather than the absence of one.
        let _seated = hub.subscribe(EventScope::Viewer(user())).unwrap();
        let _named = hub.subscribe(EventScope::Viewer(mentioned())).unwrap();
        let publisher = HubUnreadPublisher::new(hub.clone(), model);

        let failure = publisher
            .publish_unread(&channel())
            .await
            .expect_err("a dropped table must fail audience resolution");
        let persistence =
            Error::source(&failure).expect("the driver failure kept its PersistenceFailure source");
        let read_error = Error::source(persistence)
            .expect("the PersistenceFailure kept the read-model error")
            .downcast_ref::<UnreadReadModelError>()
            .expect("the read-model error survived as its own type");
        assert!(
            matches!(read_error, UnreadReadModelError::Sql(_)),
            "the driver failure was not the read model's Sql variant: {read_error}"
        );
        assert!(
            Error::source(read_error).is_some(),
            "the underlying sqlx driver cause was flattened away"
        );
        assert!(
            scope_events(&hub, EventScope::Viewer(user())).is_empty()
                && scope_events(&hub, EventScope::Viewer(mentioned())).is_empty(),
            "a failed read model must publish no frame"
        );

        // (b) DECODE/placement cause: a workspace-placed conversation whose stored workspace
        // id is present-but-unusable (the empty string), which no identity parse accepts.
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("decode-failure.sqlite");
        seed_workspace_conversation_with_malformed_workspace(&path).await;
        let model = SqliteUnreadReadModel::open(&path).await.unwrap();

        let hub = ScopeEventHub::test("epoch-1");
        let _seated = hub.subscribe(EventScope::Viewer(user())).unwrap();
        let _named = hub.subscribe(EventScope::Viewer(mentioned())).unwrap();
        let publisher = HubUnreadPublisher::new(hub.clone(), model);

        let failure = publisher
            .publish_unread(&channel())
            .await
            .expect_err("a workspace-placed row with an unusable workspace id must fail");
        let persistence =
            Error::source(&failure).expect("the decode failure kept its PersistenceFailure source");
        let read_error = Error::source(persistence)
            .expect("the PersistenceFailure kept the read-model error")
            .downcast_ref::<UnreadReadModelError>()
            .expect("the read-model error survived as its own type");
        assert!(
            matches!(read_error, UnreadReadModelError::MalformedIdentity(_)),
            "the decode failure was not MalformedIdentity: {read_error}"
        );
        assert!(
            scope_events(&hub, EventScope::Viewer(user())).is_empty()
                && scope_events(&hub, EventScope::Viewer(mentioned())).is_empty(),
            "a malformed placement must publish no frame"
        );
    }

    /// Drops the `messages` table, so the read model's count query against it fails with a
    /// driver error.
    async fn drop_messages_table(path: &std::path::Path) {
        let mut db = SqliteConnection::connect(&format!("sqlite://{}", path.display()))
            .await
            .unwrap();
        sqlx::query("DROP TABLE messages")
            .execute(&mut db)
            .await
            .unwrap();
        db.close().await.unwrap();
    }

    /// Seeds a workspace-placed conversation whose stored `workspace_id` is the empty
    /// string — schema-legal (the placement CHECK demands only `NOT NULL`, and the empty
    /// string is not null), but no usable identity: `WorkspaceId::parse` rejects it, so the
    /// read model must fail with `MalformedIdentity` rather than trust the row.
    async fn seed_workspace_conversation_with_malformed_workspace(path: &std::path::Path) {
        let mut db = current_schema::create_current_schema(path).await;
        for statement in [
            "INSERT INTO users (id, name, display_name, created_at, updated_at) \
             VALUES ('user-1', 'sender', 'Sender', 1, 1)",
            "INSERT INTO workspaces (id, name, name_key, owner_user_id, created_at, updated_at) \
             VALUES ('', 'Orphan', 'orphan', 'user-1', 1, 1)",
            "INSERT INTO conversations (id, workspace_id, placement_kind, roster_policy, title, \
             title_key, status, visibility, created_at, updated_at) VALUES \
             ('conversation-1', '', 'workspace', 'fixed', 'Orphan', 'orphan', 'open', \
             'private', 1, 1)",
        ] {
            sqlx::query(statement).execute(&mut db).await.unwrap();
        }
        db.close().await.unwrap();
    }

    /// The closed set of product-event wire `kind`s this transport is allowed to emit.
    /// A `&str` set precisely because `kind` is a string at the wire boundary: nothing but
    /// an explicit enumeration can tell a renamed or newly-added kind from a supported one.
    const SUPPORTED_EVENT_KINDS: &[&str] = &[
        "direct_pairs_changed",
        "agent_activity",
        "agent_status",
        "agent_init_timeout",
        "compaction_stale",
        "agent_event",
        "conversation_activity",
        "agent_presence_changed",
        "message",
        "notification",
        "unread_updated",
        "attention_badge_updated",
    ];

    /// The wire `kind` a product event MUST serialize as. Exhaustive by construction: a new
    /// [`ProductEvent`] variant fails to COMPILE here rather than reaching the wire
    /// undocumented — the enforcement an open `_ =>` arm or a field probe cannot give.
    fn wire_kind(event: &ProductEvent) -> &'static str {
        match event {
            ProductEvent::DirectPairsChanged { .. } => "direct_pairs_changed",
            ProductEvent::AgentActivity(_) => "agent_activity",
            ProductEvent::AgentStatus(_) => "agent_status",
            ProductEvent::AgentInitTimeout(_) => "agent_init_timeout",
            ProductEvent::CompactionStale(_) => "compaction_stale",
            ProductEvent::AgentEvent(_) => "agent_event",
            ProductEvent::ConversationActivity(_) => "conversation_activity",
            ProductEvent::AgentPresenceChanged { .. } => "agent_presence_changed",
            ProductEvent::Message(_) => "message",
            ProductEvent::Notification(_) => "notification",
            ProductEvent::UnreadUpdated(_) => "unread_updated",
            ProductEvent::AttentionBadgeUpdated(_) => "attention_badge_updated",
            ProductEvent::Test { .. } => "test",
        }
    }

    /// The supported `kind` set is CLOSED and NAMED, and every member has a real producer.
    ///
    /// Breaks three ways on drift, which is the whole point of naming the set rather than
    /// probing a field: a renamed `#[serde(rename_all)]` tag fails the serialize assertion;
    /// a NEW `ProductEvent` variant fails the exhaustive [`wire_kind`] match at compile time;
    /// a kind dropped from [`SUPPORTED_EVENT_KINDS`] fails membership or the coverage count.
    #[test]
    fn the_supported_wire_kinds_are_a_closed_named_set() {
        let samples = [
            ProductEvent::DirectPairsChanged {
                conversation_id: "c-1".to_owned(),
            },
            ProductEvent::AgentActivity(json!({ "message_id": "m-1" })),
            ProductEvent::AgentStatus(json!({ "status": "active" })),
            ProductEvent::AgentInitTimeout(json!({ "session_id": "s-1" })),
            ProductEvent::CompactionStale(json!({ "message_id": "m-1" })),
            ProductEvent::AgentEvent(json!({ "event": "tool_use" })),
            ProductEvent::ConversationActivity(json!({ "message_id": "m-1" })),
            ProductEvent::AgentPresenceChanged {
                agent_id: "agent-1".to_owned(),
            },
            ProductEvent::Message(json!({ "message": { "id": "m-1" } })),
            ProductEvent::Notification(NotificationEvent {
                kind: NotificationKind::MentionSelf,
                conversation_id: "c-1".to_owned(),
                message_id: "m-1".to_owned(),
            }),
            ProductEvent::UnreadUpdated(UnreadUpdated {
                conversation_id: "c-1".to_owned(),
                workspace_id: "w-1".to_owned(),
                conversation_unread_count: 1,
                workspace_unread_count: 1,
                latest_unread: None,
            }),
            ProductEvent::AttentionBadgeUpdated(AttentionBadge {
                workspace_id: "w-1".to_owned(),
                badge_count: 1,
            }),
        ];
        let mut produced = std::collections::BTreeSet::new();
        for event in &samples {
            let kind = wire_kind(event);
            assert!(
                SUPPORTED_EVENT_KINDS.contains(&kind),
                "{kind} is not in the closed supported set"
            );
            // The serialized tag must equal wire_kind — a serde rename drift is caught here.
            assert_eq!(
                serde_json::to_value(event).unwrap()["kind"].as_str(),
                Some(kind),
                "the serde tag drifted from wire_kind for {kind}"
            );
            produced.insert(kind);
        }
        // Every supported kind was produced by a sampled variant: the set carries no member
        // without a real producer.
        assert_eq!(produced.len(), SUPPORTED_EVENT_KINDS.len());
        for kind in SUPPORTED_EVENT_KINDS {
            assert!(produced.contains(kind), "{kind} has no producing variant");
        }
    }

    /// Every one of the four product frames crosses a REAL authenticated subscription as
    /// exact JSON, and confinement is proven by SEPARATION, not by reading a self-declared
    /// `scope` field.
    ///
    /// Two independent authenticated sockets: one subscribes ONLY `viewer:self`, the other
    /// ONLY `conversation:pair-1`. Frames are published interleaved across the two axes, and
    /// each socket is read in order — the viewer socket must see exactly its three viewer
    /// frames (notification, unread, badge) and the conversation socket exactly its two
    /// message frames, each as a whole envelope. A single earlier test that subscribed BOTH
    /// scopes on one socket could not tell a confined stream from a crossed one: that socket
    /// was entitled to every frame regardless of routing, so checking the producer-written
    /// `scope` field proved nothing. Here a leak reorders a socket's stream and the very next
    /// whole-JSON equality fails — a positive observation, never a timeout.
    #[tokio::test]
    async fn each_authenticated_scope_receives_only_its_own_frames_as_exact_json() {
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

        // TWO sockets, each subscribing exactly ONE scope — the separation that makes a
        // cross-stream leak observable rather than merely mislabelled.
        let mut viewer_socket = connect(address, origin).await;
        assert_eq!(next_json(&mut viewer_socket).await["type"], "authenticated");
        subscribe_scope(&mut viewer_socket, "viewer:self").await;

        let mut conversation_socket = connect(address, origin).await;
        assert_eq!(
            next_json(&mut conversation_socket).await["type"],
            "authenticated"
        );
        subscribe_scope(&mut conversation_socket, "conversation:pair-1").await;

        // Published through the real hub — the only producer — INTERLEAVED across the axes,
        // so a router that crossed streams would land a frame on the wrong socket.
        hub.publish(
            EventScope::Viewer(user()),
            ProductEvent::Notification(NotificationEvent {
                kind: NotificationKind::MentionSelf,
                conversation_id: "pair-1".to_owned(),
                message_id: "m-1".to_owned(),
            }),
        )
        .unwrap();
        hub.publish(
            EventScope::Conversation(conversation()),
            ProductEvent::Message(json!({ "message": { "id": "m-1" } })),
        )
        .unwrap();
        hub.publish(
            EventScope::Viewer(user()),
            ProductEvent::UnreadUpdated(UnreadUpdated {
                conversation_id: "pair-1".to_owned(),
                workspace_id: "workspace-1".to_owned(),
                conversation_unread_count: 2,
                workspace_unread_count: 5,
                latest_unread: Some(LatestUnread {
                    conversation_id: "pair-1".to_owned(),
                    message_id: "m-1".to_owned(),
                    seq: 9,
                    thread_root_id: None,
                }),
            }),
        )
        .unwrap();
        hub.publish(
            EventScope::Conversation(conversation()),
            ProductEvent::Message(json!({ "message": { "id": "m-2" } })),
        )
        .unwrap();
        hub.publish(
            EventScope::Viewer(user()),
            ProductEvent::AttentionBadgeUpdated(AttentionBadge {
                workspace_id: "workspace-1".to_owned(),
                badge_count: 7,
            }),
        )
        .unwrap();

        // The viewer socket sees ONLY its three viewer frames, in publish order. A leaked
        // conversation frame would appear here and fail the next equality.
        assert_eq!(
            next_json(&mut viewer_socket).await,
            json!({
                "type": "event", "scope": "viewer:user-1", "seq": 1, "epoch": "epoch-1",
                "kind": "notification",
                "payload": { "kind": "mention_self", "conversation_id": "pair-1", "message_id": "m-1" },
            })
        );
        assert_eq!(
            next_json(&mut viewer_socket).await,
            json!({
                "type": "event", "scope": "viewer:user-1", "seq": 2, "epoch": "epoch-1",
                "kind": "unread_updated",
                "payload": {
                    "conversation_id": "pair-1", "workspace_id": "workspace-1",
                    "conversation_unread_count": 2, "workspace_unread_count": 5,
                    "latest_unread": {
                        "conversation_id": "pair-1", "message_id": "m-1", "seq": 9,
                        "thread_root_id": null,
                    },
                },
            })
        );
        assert_eq!(
            next_json(&mut viewer_socket).await,
            json!({
                "type": "event", "scope": "viewer:user-1", "seq": 3, "epoch": "epoch-1",
                "kind": "attention_badge_updated",
                "payload": { "workspace_id": "workspace-1", "badge_count": 7 },
            })
        );

        // The conversation socket sees ONLY its two message frames, in publish order.
        assert_eq!(
            next_json(&mut conversation_socket).await,
            json!({
                "type": "event", "scope": "conversation:pair-1", "seq": 1, "epoch": "epoch-1",
                "kind": "message", "payload": { "message": { "id": "m-1" } },
            })
        );
        assert_eq!(
            next_json(&mut conversation_socket).await,
            json!({
                "type": "event", "scope": "conversation:pair-1", "seq": 2, "epoch": "epoch-1",
                "kind": "message", "payload": { "message": { "id": "m-2" } },
            })
        );

        controller.close().await;
        server.abort();
    }

    /// Subscribes one scope and consumes the `subscribed` acknowledgement.
    async fn subscribe_scope<S>(socket: &mut tokio_tungstenite::WebSocketStream<S>, scope: &str)
    where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
    {
        socket
            .send(ClientMessage::Text(
                serde_json::json!({ "type": "subscribe", "scope": scope })
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        assert_eq!(next_json(socket).await["type"], "subscribed");
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
