#[path = "../../backend-sqlite/tests/support/current_schema_snapshot.rs"]
mod current_schema;
#[path = "support/log_capture.rs"]
mod log_capture;

use axum::http::StatusCode;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use futures_util::{SinkExt, StreamExt};
use log_capture::LogBuffer;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use silverhand_backend_core::{
    auth::{HumanSessionAuthenticator, SessionClock, SessionTtl},
    identity::{AgentId, ConversationId, DaemonInstanceId, UserId},
    messaging::{
        CreatedMessage, FromKind, MessageContent, MessageId, MessageSeq, ReferencePositions,
        post_commit::{IdleStart, MainDelivery},
    },
    persistence::PersistenceFailure,
    runtime_credential::{
        ClaimRuntimeCustody, RuntimeCustodyPort, RuntimeEventTime, RuntimePrincipal, RuntimeScope,
    },
    runtime_delivery::{
        ClaimPendingInbox, DeliveryLeaseOwner, InboxDeliveryId, InboxSettlementDisposition,
        RuntimeDeliveryFailureReason, RuntimeDispatchReadPort, RuntimeDispatchTarget,
        RuntimeInboxCustodyPort,
    },
    runtime_event::{
        CommitRuntimeConsumed, CommitRuntimeExit, CommitRuntimeSessionInit, DaemonEventDurablePort,
        ProjectRuntimeStatus, RefineRuntimeToolCallInput, RuntimeActivityCommitResult,
        RuntimeActivityFact, RuntimeConsumedCommitResult, RuntimeEventAdmission,
        RuntimeExitCommitResult, RuntimeSessionInitCommitResult, RuntimeStatusCommitResult,
        RuntimeToolCallInputCommitResult, StampRuntimePresence, UpsertRuntimeTextActivity,
    },
};
use silverhand_backend_server::{
    daemon_delivery::{
        DaemonDeliveryController, DaemonDeliveryEffects, DaemonDeliveryRuntime,
        HOST_PROTOCOL_VERSION, HOST_WEBSOCKET_PATH, OUTBOUND_PROTOCOL_VERSION,
        UPDATE_REQUIRED_CLOSE_REASON,
    },
    runtime_credential::RuntimeCredentialAuthority,
    scope_events::{
        AllowedOrigin, DESKTOP_API_EPOCH_HEADER, EVENT_WEBSOCKET_PATH, EVENT_WS_SESSION_COOKIE,
        EventWebSocketConfig, EventWebSocketController, ScopeEventHub,
        router as scope_event_router,
    },
};
use silverhand_backend_sqlite::{
    auth::SqliteSessionStore, host_runtime::SqliteHostRuntimeStore,
    runtime_credential::SqliteRuntimeCustodyStore, runtime_delivery::SqliteRuntimeDeliveryStore,
    scope_event::SqliteEventScopeAuthority,
};
use sqlx::{Connection, Row, SqliteConnection, sqlite::SqliteConnectOptions};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async,
    tungstenite::{
        Message,
        client::IntoClientRequest,
        http::header::{AUTHORIZATION, COOKIE, ORIGIN},
        protocol::frame::coding::CloseCode,
    },
};

const TOKEN: &str = "host-token";
const TOKEN_2: &str = "host-token-2";
const SESSION_TOKEN: &str = "session-token";
const EVENT_ORIGIN: &str = "http://desktop.test";
const AGENT: &str = "agent-delivery";
const CONVERSATION: &str = "conversation0001";

type Runtime = DaemonDeliveryRuntime<
    SqliteRuntimeCustodyStore,
    CountingRuntimeDeliveryStore,
    SqliteHostRuntimeStore,
>;
type Effects = DaemonDeliveryEffects<
    SqliteRuntimeCustodyStore,
    CountingRuntimeDeliveryStore,
    SqliteHostRuntimeStore,
>;
type Socket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

struct Fixture {
    _directory: tempfile::TempDir,
    path: std::path::PathBuf,
    address: std::net::SocketAddr,
    effects: Effects,
    settlement_calls: Arc<AtomicUsize>,
    controller: DaemonDeliveryController,
    event_controller: EventWebSocketController,
    server: tokio::task::JoinHandle<()>,
}

#[derive(Clone)]
struct FixedSessionClock;

impl SessionClock for FixedSessionClock {
    fn now_unix_millis(&self) -> i64 {
        10_000
    }
}

async fn fixture(name: &str) -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join(name);
    let mut db = current_schema::create_current_schema(&path).await;
    seed(&mut db).await;
    db.close().await.unwrap();
    let custody = SqliteRuntimeCustodyStore::open(&path).await.unwrap();
    let settlement_calls = Arc::new(AtomicUsize::new(0));
    let data = CountingRuntimeDeliveryStore {
        inner: SqliteRuntimeDeliveryStore::open(&path).await.unwrap(),
        settlement_calls: settlement_calls.clone(),
    };
    let hosts = SqliteHostRuntimeStore::open(&path).await.unwrap();
    let event_hub = ScopeEventHub::production().unwrap();
    let runtime = Runtime::production(
        RuntimeCredentialAuthority::production(custody),
        data,
        hosts,
        event_hub.clone(),
    )
    .unwrap();
    let effects = runtime.effects();
    let (daemon_router, controller) = runtime.router();
    let sessions = HumanSessionAuthenticator::new(
        SqliteSessionStore::open(&path).await.unwrap(),
        FixedSessionClock,
        SessionTtl::from_millis(60_000).unwrap(),
    );
    let scope_authority = SqliteEventScopeAuthority::open(&path).await.unwrap();
    let event_config =
        EventWebSocketConfig::production([AllowedOrigin::parse(EVENT_ORIGIN).unwrap()]).unwrap();
    let (event_router, event_controller) =
        scope_event_router(event_hub, sessions, scope_authority, event_config);
    let router = daemon_router.merge(event_router);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    Fixture {
        _directory: directory,
        path,
        address,
        effects,
        settlement_calls,
        controller,
        event_controller,
        server,
    }
}

#[derive(Clone)]
struct CountingRuntimeDeliveryStore {
    inner: SqliteRuntimeDeliveryStore,
    settlement_calls: Arc<AtomicUsize>,
}

impl RuntimeDispatchReadPort for CountingRuntimeDeliveryStore {
    async fn resolve_dispatch_target(
        &self,
        conversation: ConversationId,
        agent: AgentId,
    ) -> Result<Option<RuntimeDispatchTarget>, PersistenceFailure> {
        self.inner
            .resolve_dispatch_target(conversation, agent)
            .await
    }

    async fn current_custodies_for_host(
        &self,
        host_id: String,
    ) -> Result<Vec<RuntimePrincipal>, PersistenceFailure> {
        self.inner.current_custodies_for_host(host_id).await
    }
}

impl RuntimeInboxCustodyPort for CountingRuntimeDeliveryStore {
    async fn claim_pending<P: ReferencePositions + Sync>(
        &self,
        host_id: String,
        principal: RuntimePrincipal,
        conversation: ConversationId,
        owner: DeliveryLeaseOwner,
        now_ms: i64,
        lease_ttl_ms: i64,
        reference_positions: &P,
    ) -> Result<ClaimPendingInbox, PersistenceFailure> {
        self.inner
            .claim_pending(
                host_id,
                principal,
                conversation,
                owner,
                now_ms,
                lease_ttl_ms,
                reference_positions,
            )
            .await
    }

    async fn settle_consumed(
        &self,
        host_id: String,
        principal: RuntimePrincipal,
        conversation: ConversationId,
        owner: DeliveryLeaseOwner,
        delivery_ids: Vec<InboxDeliveryId>,
        observed_at_ms: i64,
    ) -> Result<InboxSettlementDisposition, PersistenceFailure> {
        self.settlement_calls.fetch_add(1, Ordering::SeqCst);
        self.inner
            .settle_consumed(
                host_id,
                principal,
                conversation,
                owner,
                delivery_ids,
                observed_at_ms,
            )
            .await
    }

    async fn settle_failed(
        &self,
        host_id: String,
        principal: RuntimePrincipal,
        conversation: ConversationId,
        owner: DeliveryLeaseOwner,
        delivery_ids: Vec<InboxDeliveryId>,
        reason: RuntimeDeliveryFailureReason,
        observed_at_ms: i64,
    ) -> Result<InboxSettlementDisposition, PersistenceFailure> {
        self.settlement_calls.fetch_add(1, Ordering::SeqCst);
        self.inner
            .settle_failed(
                host_id,
                principal,
                conversation,
                owner,
                delivery_ids,
                reason,
                observed_at_ms,
            )
            .await
    }

    async fn release_owner(&self, owner: DeliveryLeaseOwner) -> Result<u64, PersistenceFailure> {
        self.inner.release_owner(owner).await
    }
}

impl DaemonEventDurablePort for CountingRuntimeDeliveryStore {
    async fn current_admission(
        &self,
        host_id: String,
        scope: RuntimeScope,
    ) -> Result<Option<RuntimeEventAdmission>, PersistenceFailure> {
        self.inner.current_admission(host_id, scope).await
    }

    async fn commit_exit(
        &self,
        event: CommitRuntimeExit,
    ) -> Result<RuntimeExitCommitResult, PersistenceFailure> {
        self.inner.commit_exit(event).await
    }

    async fn commit_consumed(
        &self,
        event: CommitRuntimeConsumed,
    ) -> Result<RuntimeConsumedCommitResult, PersistenceFailure> {
        self.settlement_calls.fetch_add(1, Ordering::SeqCst);
        self.inner.commit_consumed(event).await
    }

    async fn commit_session_init(
        &self,
        event: CommitRuntimeSessionInit,
    ) -> Result<Option<RuntimeSessionInitCommitResult>, PersistenceFailure> {
        self.inner.commit_session_init(event).await
    }

    async fn project_status(
        &self,
        event: ProjectRuntimeStatus,
    ) -> Result<Option<RuntimeStatusCommitResult>, PersistenceFailure> {
        self.inner.project_status(event).await
    }

    async fn record_activity(
        &self,
        admission: RuntimeEventAdmission,
        event: RuntimeActivityFact,
        presence_at: RuntimeEventTime,
    ) -> Result<Option<RuntimeActivityCommitResult>, PersistenceFailure> {
        self.inner
            .record_activity(admission, event, presence_at)
            .await
    }

    async fn upsert_text_activity(
        &self,
        event: UpsertRuntimeTextActivity,
    ) -> Result<Option<RuntimeActivityCommitResult>, PersistenceFailure> {
        self.inner.upsert_text_activity(event).await
    }

    async fn refine_tool_call_input(
        &self,
        event: RefineRuntimeToolCallInput,
    ) -> Result<Option<RuntimeToolCallInputCommitResult>, PersistenceFailure> {
        self.inner.refine_tool_call_input(event).await
    }

    async fn stamp_presence(
        &self,
        event: StampRuntimePresence,
    ) -> Result<Option<Vec<UserId>>, PersistenceFailure> {
        self.inner.stamp_presence(event).await
    }
}

async fn seed(db: &mut SqliteConnection) {
    sqlx::query(
        "INSERT INTO users (id, name, display_name, created_at, updated_at)
         VALUES ('user-1', 'user-1', 'User One', 1, 1)",
    )
    .execute(&mut *db)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO auth_sessions (
            id, user_id, token_hash, created_at, last_used_at, revoked_at,
            user_agent, ip_first_seen
         ) VALUES ('session-1', 'user-1', ?, 1, 9_500, NULL, NULL, NULL)",
    )
    .bind(token_hash(SESSION_TOKEN))
    .execute(&mut *db)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO hosts (id, name, kind, created_at, user_id)
         VALUES ('host-1', 'host-1', 'remote', 1, 'user-1')",
    )
    .execute(&mut *db)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO host_credentials (
            id, host_id, token_hash, kind, expires_at, consumed_at, revoked_at
         ) VALUES ('credential-1', 'host-1', ?, 'long_lived', NULL, NULL, NULL)",
    )
    .bind(token_hash(TOKEN))
    .execute(&mut *db)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO agents (
            id, name, runtime, host_id, created_at, updated_at,
            display_name, created_by_user_id, session_scope
         ) VALUES (?, 'agent-delivery', 'codex', 'host-1', 1, 1,
             'Delivery Agent', 'user-1', 'conversation')",
    )
    .bind(AGENT)
    .execute(&mut *db)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO workspaces (
            id, name, name_key, created_at, updated_at, owner_user_id
         ) VALUES ('workspace-1', 'Workspace One', 'workspace one', 1, 1, 'user-1')",
    )
    .execute(&mut *db)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO workspace_members (workspace_id, agent_id, joined_at)
         VALUES ('workspace-1', ?, 1)",
    )
    .bind(AGENT)
    .execute(&mut *db)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO workspace_users (workspace_id, user_id, joined_at, role)
         VALUES ('workspace-1', 'user-1', 1, 'owner')",
    )
    .execute(&mut *db)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO conversations (
            id, workspace_id, placement_kind, roster_policy, title, title_key,
            status, created_at, updated_at
         ) VALUES (?, 'workspace-1', 'workspace', 'open', 'Conversation One',
             'conversation one', 'active', 1, 1)",
    )
    .bind(CONVERSATION)
    .execute(&mut *db)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO conversation_agents (conversation_id, agent_id, joined_at)
         VALUES (?, ?, 1)",
    )
    .bind(CONVERSATION)
    .bind(AGENT)
    .execute(&mut *db)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO conversation_users (conversation_id, user_id, joined_at)
         VALUES (?, 'user-1', 1)",
    )
    .bind(CONVERSATION)
    .execute(&mut *db)
    .await
    .unwrap();
    add_inbox(db, "message-1", 1).await;
}

async fn add_inbox(db: &mut SqliteConnection, message_id: &str, seq: i64) {
    sqlx::query(
        "INSERT INTO messages (
            id, conversation_id, from_kind, from_user_id, content, metadata, seq, created_at
         ) VALUES (?, ?, 'user', 'user-1', 'hello runtime', ?, ?, ?)",
    )
    .bind(message_id)
    .bind(CONVERSATION)
    .bind(
        serde_json::json!({
            "subtype": "task_status",
            "task_number": 2185,
            "task_status": "in_progress",
            "attachments": [{
                "id": "file-1",
                "filename": "runtime notes.txt",
                "size": 7,
                "content_type": "text/plain"
            }]
        })
        .to_string(),
    )
    .bind(seq)
    .bind(seq)
    .execute(&mut *db)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO conversation_inboxes (
            conversation_id, agent_id, message_id, created_at, delivery_kind
         ) VALUES (?, ?, ?, ?, 'turn')",
    )
    .bind(CONVERSATION)
    .bind(AGENT)
    .bind(message_id)
    .bind(seq)
    .execute(&mut *db)
    .await
    .unwrap();
}

fn token_hash(raw: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(raw.as_bytes()))
}

async fn connect(address: std::net::SocketAddr) -> Socket {
    connect_with_token(address, TOKEN).await.unwrap()
}

async fn connect_conversation_side(address: std::net::SocketAddr) -> Socket {
    connect_event_scope(address, &format!("conversation-side:{CONVERSATION}")).await
}

async fn connect_event_scope(address: std::net::SocketAddr, scope: &str) -> Socket {
    connect_event_scope_with_ack(address, scope).await.0
}

async fn connect_event_scope_with_ack(
    address: std::net::SocketAddr,
    scope: &str,
) -> (Socket, Value) {
    let mut request = format!("ws://{address}{EVENT_WEBSOCKET_PATH}")
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert(ORIGIN, EVENT_ORIGIN.parse().unwrap());
    request.headers_mut().insert(
        COOKIE,
        format!("{EVENT_WS_SESSION_COOKIE}={SESSION_TOKEN}")
            .parse()
            .unwrap(),
    );
    request
        .headers_mut()
        .insert(DESKTOP_API_EPOCH_HEADER, "3".parse().unwrap());
    let (mut socket, _) = connect_async(request).await.unwrap();
    assert_eq!(next_json(&mut socket).await["type"], "authenticated");
    socket
        .send(Message::Text(
            json!({
                "type": "subscribe",
                "scope": scope,
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();
    let subscribed = next_json(&mut socket).await;
    assert_eq!(subscribed["type"], "subscribed");
    (socket, subscribed)
}

async fn connect_with_token(
    address: std::net::SocketAddr,
    token: &str,
) -> Result<Socket, tokio_tungstenite::tungstenite::Error> {
    let mut request = format!("ws://{address}{HOST_WEBSOCKET_PATH}")
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert(AUTHORIZATION, format!("Bearer {token}").parse().unwrap());
    connect_async(request).await.map(|(socket, _)| socket)
}

async fn send_ready(socket: &mut Socket, protocol_version: u32) {
    send_ready_with_instance(socket, protocol_version, "instance-test").await;
}

async fn send_ready_with_instance(socket: &mut Socket, protocol_version: u32, instance_id: &str) {
    socket
        .send(Message::Text(
            json!({
                "direction": "daemon_to_server",
                "type": "event",
                "kind": "ready",
                "protocol_version": protocol_version,
                "daemon_version": "test",
                "daemon_id": "daemon-test",
                "instance_id": instance_id,
                "host_descriptor": { "name": "Test host", "kind": "remote" },
                "capabilities": [],
                "daemon_pid": 42,
                "started_at": 100,
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();
}

async fn complete_attachment(socket: &mut Socket, controller: &DaemonDeliveryController) {
    send_ready(socket, OUTBOUND_PROTOCOL_VERSION).await;
    let status = next_json(socket).await;
    assert_eq!(status["kind"], "runtime_status");
    respond(socket, &status, json!({ "runtimes": [] })).await;
    wait_for_attachment(controller).await;
}

async fn wait_for_attachment(controller: &DaemonDeliveryController) {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while controller.attached_connection_count() != 1 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

fn runtime_scope() -> RuntimeScope {
    RuntimeScope::ConversationSlot {
        agent: AgentId::parse(AGENT).unwrap(),
        source: ConversationId::parse(CONVERSATION).unwrap(),
    }
}

async fn next_json(socket: &mut Socket) -> Value {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            match socket.next().await.unwrap().unwrap() {
                Message::Text(text) => return serde_json::from_str(&text).unwrap(),
                Message::Ping(payload) => socket.send(Message::Pong(payload)).await.unwrap(),
                other => panic!("unexpected daemon frame: {other:?}"),
            }
        }
    })
    .await
    .expect("expected websocket JSON frame")
}

async fn respond(socket: &mut Socket, command: &Value, result: Value) {
    socket
        .send(Message::Text(
            json!({
                "direction": "daemon_to_server",
                "type": "command_response",
                "id": command["id"],
                "kind": command["kind"],
                "result": result,
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();
}

fn created_message() -> CreatedMessage {
    CreatedMessage {
        id: MessageId::parse("message-1").unwrap(),
        conversation_id: ConversationId::parse(CONVERSATION).unwrap(),
        from_kind: FromKind::User,
        from_agent_id: None,
        from_user_id: Some(UserId::parse("user-1").unwrap()),
        author: None,
        content: MessageContent::parse("hello runtime").unwrap(),
        attachments: Vec::new(),
        seq: MessageSeq::try_from(1).unwrap(),
        created_at_ms: 1,
        thread_root_id: None,
    }
}

async fn open(path: &std::path::Path) -> SqliteConnection {
    SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(path)
            .foreign_keys(true),
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn compatible_attachment_claims_then_async_consumed_settles_the_inbox() {
    let fixture = fixture("delivery.sqlite").await;
    let mut socket = connect(fixture.address).await;

    let before_ready = IdleStart::start_if_idle(
        &fixture.effects,
        &AgentId::parse(AGENT).unwrap(),
        &ConversationId::parse(CONVERSATION).unwrap(),
    )
    .await;
    assert!(before_ready.is_err());
    let mut db = open(&fixture.path).await;
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT generation FROM agent_runtime_slots WHERE agent_id = ? AND conversation_id = ?",
        )
        .bind(AGENT)
        .bind(CONVERSATION)
        .fetch_one(&mut db)
        .await
        .unwrap(),
        0
    );

    complete_attachment(&mut socket, &fixture.controller).await;
    let effects = fixture.effects.clone();
    let start = tokio::spawn(async move {
        IdleStart::start_if_idle(
            &effects,
            &AgentId::parse(AGENT).unwrap(),
            &ConversationId::parse(CONVERSATION).unwrap(),
        )
        .await
    });
    let start_command = next_json(&mut socket).await;
    assert_eq!(start_command["kind"], "runtime_start");
    assert_eq!(
        start_command["params"]["options"]["runtime_scope"]["kind"],
        "conversation"
    );
    assert!(
        start_command["params"]["options"]["env_policy"]["silverhand"]["auth_token"]
            .as_str()
            .is_some_and(|token| !token.is_empty() && token != TOKEN)
    );
    respond(
        &mut socket,
        &start_command,
        json!({ "started": true, "pid": 7, "started_at": 100 }),
    )
    .await;
    start.await.unwrap().unwrap();

    let effects = fixture.effects.clone();
    let deliver = tokio::spawn(async move {
        MainDelivery::deliver_to(
            &effects,
            &AgentId::parse(AGENT).unwrap(),
            &created_message(),
        )
        .await
    });
    let delivery_command = next_json(&mut socket).await;
    assert_eq!(delivery_command["kind"], "runtime_deliver");
    assert_eq!(delivery_command["params"]["delivery_ids"], json!([1]));
    assert_eq!(delivery_command["params"]["deliveries"][0]["seq"], 1);
    assert!(
        delivery_command["params"]["text"]
            .as_str()
            .unwrap()
            .contains("hello runtime")
    );
    let text = delivery_command["params"]["text"].as_str().unwrap();
    assert!(text.contains(
        "[msg_id=message-1 sender=@user-1 type=human target=#Workspace%20One/Conversation%20One time="
    ));
    assert!(text.contains(" task=#2185 status=in_progress]\nhello runtime"));
    assert!(text.contains(
        "File #1 — id=file-1 filename=\"runtime notes.txt\" content_type=text/plain size=7"
    ));
    respond(
        &mut socket,
        &delivery_command,
        json!({ "disposition": "admitted", "pid": 7, "started_at": 100 }),
    )
    .await;
    deliver.await.unwrap().unwrap();

    let leased =
        sqlx::query("SELECT delivered_at, in_flight_owner FROM conversation_inboxes WHERE id = 1")
            .fetch_one(&mut db)
            .await
            .unwrap();
    assert!(leased.get::<Option<i64>, _>("delivered_at").is_none());
    assert!(leased.get::<Option<String>, _>("in_flight_owner").is_some());
    let generation: i64 = sqlx::query_scalar(
        "SELECT generation FROM agent_runtime_slots WHERE agent_id = ? AND conversation_id = ?",
    )
    .bind(AGENT)
    .bind(CONVERSATION)
    .fetch_one(&mut db)
    .await
    .unwrap();
    socket
        .send(Message::Text(
            json!({
                "direction": "daemon_to_server",
                "type": "event",
                "kind": "runtime_delivery_consumed",
                "runtime_scope": {
                    "kind": "conversation",
                    "conversation_id": CONVERSATION,
                    "agent_id": AGENT,
                },
                "conversation_id": CONVERSATION,
                "agent_id": AGENT,
                "runtime_generation": generation,
                "delivery_ids": [1],
                "ts": 200,
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let delivered: Option<i64> =
                sqlx::query_scalar("SELECT delivered_at FROM conversation_inboxes WHERE id = 1")
                    .fetch_one(&mut db)
                    .await
                    .unwrap();
            if delivered == Some(200) {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();

    socket.close(None).await.unwrap();
    fixture.controller.close().await;
    fixture.server.abort();
}

#[tokio::test]
async fn host_axis_is_rejected_by_the_outbound_axis_before_attachment_or_claim() {
    assert_ne!(HOST_PROTOCOL_VERSION, OUTBOUND_PROTOCOL_VERSION);
    let fixture = fixture("wrong-axis.sqlite").await;
    let mut socket = connect(fixture.address).await;
    send_ready(&mut socket, HOST_PROTOCOL_VERSION).await;
    let close = socket.next().await.unwrap().unwrap();
    let Message::Close(Some(close)) = close else {
        panic!("wrong outbound version must close the transport")
    };
    assert_eq!(close.code, CloseCode::Protocol);
    assert_eq!(close.reason, UPDATE_REQUIRED_CLOSE_REASON);
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while fixture.controller.active_connection_count() != 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let mut db = open(&fixture.path).await;
    let generation: i64 = sqlx::query_scalar(
        "SELECT generation FROM agent_runtime_slots WHERE agent_id = ? AND conversation_id = ?",
    )
    .bind(AGENT)
    .bind(CONVERSATION)
    .fetch_one(&mut db)
    .await
    .unwrap();
    assert_eq!(generation, 0);
    fixture.controller.close().await;
    fixture.server.abort();
}

#[tokio::test]
async fn authenticated_transport_is_not_attached_and_cannot_claim_before_ready() {
    let fixture = fixture("not-attached.sqlite").await;
    let mut socket = connect(fixture.address).await;
    assert_eq!(fixture.controller.active_connection_count(), 1);
    assert_eq!(fixture.controller.attached_connection_count(), 0);

    let result = MainDelivery::deliver_to(
        &fixture.effects,
        &AgentId::parse(AGENT).unwrap(),
        &created_message(),
    )
    .await;
    assert!(result.is_err());

    let mut db = open(&fixture.path).await;
    let slot = sqlx::query(
        "SELECT generation, claimed_by_daemon_instance_id
           FROM agent_runtime_slots
          WHERE agent_id = ? AND conversation_id = ?",
    )
    .bind(AGENT)
    .bind(CONVERSATION)
    .fetch_one(&mut db)
    .await
    .unwrap();
    assert_eq!(slot.get::<i64, _>("generation"), 0);
    assert!(
        slot.get::<Option<String>, _>("claimed_by_daemon_instance_id")
            .is_none()
    );
    let owner: Option<String> =
        sqlx::query_scalar("SELECT in_flight_owner FROM conversation_inboxes WHERE id = 1")
            .fetch_one(&mut db)
            .await
            .unwrap();
    assert!(owner.is_none());

    socket.close(None).await.unwrap();
    fixture.controller.close().await;
    fixture.server.abort();
}

#[tokio::test]
async fn compatible_ready_cannot_finalize_or_settle_before_hydration_attaches() {
    let exit_fixture = fixture("pre-hydration-exit.sqlite").await;
    let custody = SqliteRuntimeCustodyStore::open(&exit_fixture.path)
        .await
        .unwrap();
    custody
        .claim_or_current(ClaimRuntimeCustody::new(
            runtime_scope(),
            DaemonInstanceId::parse("instance-test").unwrap(),
            RuntimeEventTime::from_unix_millis(10),
        ))
        .await
        .unwrap()
        .unwrap();
    let mut exit_socket = connect(exit_fixture.address).await;
    send_ready(&mut exit_socket, OUTBOUND_PROTOCOL_VERSION).await;
    let status = next_json(&mut exit_socket).await;
    assert_eq!(status["kind"], "runtime_status");
    send_runtime_exit(&mut exit_socket, 1, false, 111).await;
    let close = exit_socket.next().await.unwrap().unwrap();
    let Message::Close(Some(close)) = close else {
        panic!("pre-hydration runtime exit must close the connection")
    };
    assert_eq!(close.code, CloseCode::Policy);
    assert_eq!(close.reason, "attachment_not_hydrated");
    let mut exit_db = open(&exit_fixture.path).await;
    let daemon: Option<String> = sqlx::query_scalar(
        "SELECT claimed_by_daemon_instance_id FROM agent_runtime_slots
          WHERE agent_id = ? AND conversation_id = ?",
    )
    .bind(AGENT)
    .bind(CONVERSATION)
    .fetch_one(&mut exit_db)
    .await
    .unwrap();
    assert_eq!(daemon.as_deref(), Some("instance-test"));
    exit_fixture.controller.close().await;
    exit_fixture.server.abort();

    let settle_fixture = fixture("pre-hydration-settle.sqlite").await;
    let mut settle_socket = connect(settle_fixture.address).await;
    send_ready(&mut settle_socket, OUTBOUND_PROTOCOL_VERSION).await;
    let status = next_json(&mut settle_socket).await;
    assert_eq!(status["kind"], "runtime_status");
    send_delivery_failed(&mut settle_socket, 1, "driver_refused", 120).await;
    let close = settle_socket.next().await.unwrap().unwrap();
    let Message::Close(Some(close)) = close else {
        panic!("pre-hydration settlement must close the connection")
    };
    assert_eq!(close.code, CloseCode::Policy);
    assert_eq!(close.reason, "attachment_not_hydrated");
    assert_eq!(settle_fixture.settlement_calls.load(Ordering::SeqCst), 0);
    let mut settle_db = open(&settle_fixture.path).await;
    let inbox = sqlx::query(
        "SELECT delivered_at, failed_at, failed_reason, in_flight_owner
           FROM conversation_inboxes WHERE id = 1",
    )
    .fetch_one(&mut settle_db)
    .await
    .unwrap();
    assert!(inbox.get::<Option<i64>, _>("delivered_at").is_none());
    assert!(inbox.get::<Option<i64>, _>("failed_at").is_none());
    assert!(inbox.get::<Option<String>, _>("failed_reason").is_none());
    assert!(inbox.get::<Option<String>, _>("in_flight_owner").is_none());
    settle_fixture.controller.close().await;
    settle_fixture.server.abort();

    let consumed_fixture = fixture("pre-hydration-consumed.sqlite").await;
    let mut consumed_socket = connect(consumed_fixture.address).await;
    send_ready(&mut consumed_socket, OUTBOUND_PROTOCOL_VERSION).await;
    let status = next_json(&mut consumed_socket).await;
    assert_eq!(status["kind"], "runtime_status");
    send_delivery_consumed(&mut consumed_socket, 1, 121).await;
    let close = consumed_socket.next().await.unwrap().unwrap();
    let Message::Close(Some(close)) = close else {
        panic!("pre-hydration consumed settlement must close the connection")
    };
    assert_eq!(close.code, CloseCode::Policy);
    assert_eq!(close.reason, "attachment_not_hydrated");
    assert_eq!(consumed_fixture.settlement_calls.load(Ordering::SeqCst), 0);
    let mut consumed_db = open(&consumed_fixture.path).await;
    let delivered: Option<i64> =
        sqlx::query_scalar("SELECT delivered_at FROM conversation_inboxes WHERE id = 1")
            .fetch_one(&mut consumed_db)
            .await
            .unwrap();
    assert!(delivered.is_none());
    consumed_fixture.controller.close().await;
    consumed_fixture.server.abort();
}

#[tokio::test]
async fn synchronous_refusal_releases_the_lease_and_a_retry_can_be_admitted() {
    let fixture = fixture("refusal-retry.sqlite").await;
    let mut socket = connect(fixture.address).await;
    complete_attachment(&mut socket, &fixture.controller).await;

    let effects = fixture.effects.clone();
    let first = tokio::spawn(async move {
        MainDelivery::deliver_to(
            &effects,
            &AgentId::parse(AGENT).unwrap(),
            &created_message(),
        )
        .await
    });
    let first_command = next_json(&mut socket).await;
    assert_eq!(first_command["kind"], "runtime_deliver");
    respond(
        &mut socket,
        &first_command,
        json!({ "disposition": "refused", "reason": "startup_pending" }),
    )
    .await;
    assert!(first.await.unwrap().is_err());

    let mut db = open(&fixture.path).await;
    let first_state = sqlx::query(
        "SELECT delivered_at, failed_at, in_flight_owner
           FROM conversation_inboxes WHERE id = 1",
    )
    .fetch_one(&mut db)
    .await
    .unwrap();
    assert!(first_state.get::<Option<i64>, _>("delivered_at").is_none());
    assert!(first_state.get::<Option<i64>, _>("failed_at").is_none());
    assert!(
        first_state
            .get::<Option<String>, _>("in_flight_owner")
            .is_none()
    );

    let effects = fixture.effects.clone();
    let retry = tokio::spawn(async move {
        MainDelivery::deliver_to(
            &effects,
            &AgentId::parse(AGENT).unwrap(),
            &created_message(),
        )
        .await
    });
    let retry_command = next_json(&mut socket).await;
    assert_eq!(retry_command["kind"], "runtime_deliver");
    assert_eq!(retry_command["params"]["delivery_ids"], json!([1]));
    respond(
        &mut socket,
        &retry_command,
        json!({ "disposition": "admitted", "pid": 7, "started_at": 100 }),
    )
    .await;
    retry.await.unwrap().unwrap();

    let owner: Option<String> =
        sqlx::query_scalar("SELECT in_flight_owner FROM conversation_inboxes WHERE id = 1")
            .fetch_one(&mut db)
            .await
            .unwrap();
    assert!(owner.is_some());

    socket.close(None).await.unwrap();
    fixture.controller.close().await;
    fixture.server.abort();
}

#[tokio::test]
async fn ambiguous_disconnect_releases_the_lease_but_preserves_custody_for_hydration() {
    let fixture = fixture("ambiguous.sqlite").await;
    let mut socket = connect(fixture.address).await;
    complete_attachment(&mut socket, &fixture.controller).await;

    let effects = fixture.effects.clone();
    let delivery = tokio::spawn(async move {
        MainDelivery::deliver_to(
            &effects,
            &AgentId::parse(AGENT).unwrap(),
            &created_message(),
        )
        .await
    });
    let command = next_json(&mut socket).await;
    assert_eq!(command["kind"], "runtime_deliver");
    socket.close(None).await.unwrap();
    assert!(delivery.await.unwrap().is_err());

    let mut db = open(&fixture.path).await;
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let owner: Option<String> =
                sqlx::query_scalar("SELECT in_flight_owner FROM conversation_inboxes WHERE id = 1")
                    .fetch_one(&mut db)
                    .await
                    .unwrap();
            if owner.is_none() {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let slot = sqlx::query(
        "SELECT generation, claimed_by_daemon_instance_id
           FROM agent_runtime_slots
          WHERE agent_id = ? AND conversation_id = ?",
    )
    .bind(AGENT)
    .bind(CONVERSATION)
    .fetch_one(&mut db)
    .await
    .unwrap();
    assert_eq!(slot.get::<i64, _>("generation"), 1);
    assert_eq!(
        slot.get::<Option<String>, _>("claimed_by_daemon_instance_id")
            .as_deref(),
        Some("instance-test")
    );

    fixture.controller.close().await;
    fixture.server.abort();
}

#[tokio::test]
async fn restart_hydration_stops_the_new_process_and_finalizes_old_daemon_custody() {
    let fixture = fixture("hydrate.sqlite").await;
    let custody = SqliteRuntimeCustodyStore::open(&fixture.path)
        .await
        .unwrap();
    let principal = custody
        .claim_or_current(ClaimRuntimeCustody::new(
            runtime_scope(),
            DaemonInstanceId::parse("previous-daemon").unwrap(),
            RuntimeEventTime::from_unix_millis(10),
        ))
        .await
        .unwrap()
        .unwrap()
        .into_principal();
    assert_eq!(principal.custody().generation().as_i64(), 1);

    let mut socket = connect(fixture.address).await;
    send_ready(&mut socket, OUTBOUND_PROTOCOL_VERSION).await;
    let status = next_json(&mut socket).await;
    assert_eq!(status["kind"], "runtime_status");
    respond(
        &mut socket,
        &status,
        json!({
            "runtimes": [{
                "runtime_scope": {
                    "kind": "conversation",
                    "conversation_id": CONVERSATION,
                    "agent_id": AGENT,
                },
                "conversation_id": CONVERSATION,
                "agent_id": AGENT,
                "runtime_generation": 1,
                "pid": 7,
                "phase": "ready",
                "run_state": null,
                "started_at": 100,
            }]
        }),
    )
    .await;
    let stop = next_json(&mut socket).await;
    assert_eq!(stop["kind"], "runtime_stop");
    assert_eq!(stop["params"]["runtime_generation"], 1);
    respond(
        &mut socket,
        &stop,
        json!({ "mode": "hard", "stopped": true, "exit_code": 0 }),
    )
    .await;
    wait_for_attachment(&fixture.controller).await;

    let mut db = open(&fixture.path).await;
    let slot = sqlx::query(
        "SELECT generation, claimed_by_daemon_instance_id
           FROM agent_runtime_slots
          WHERE agent_id = ? AND conversation_id = ?",
    )
    .bind(AGENT)
    .bind(CONVERSATION)
    .fetch_one(&mut db)
    .await
    .unwrap();
    assert_eq!(slot.get::<i64, _>("generation"), 1);
    assert!(
        slot.get::<Option<String>, _>("claimed_by_daemon_instance_id")
            .is_none()
    );

    socket.close(None).await.unwrap();
    fixture.controller.close().await;
    fixture.server.abort();
}

#[tokio::test]
async fn authenticated_host_fences_colliding_daemon_instances_from_foreign_custody_and_cache() {
    let fixture = fixture("host-bound-daemon-events.sqlite").await;
    let mut db = open(&fixture.path).await;
    sqlx::query(
        "INSERT INTO hosts (id, name, kind, created_at, user_id)
         VALUES ('host-2', 'host-2', 'remote', 1, 'user-1')",
    )
    .execute(&mut db)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO host_credentials (
            id, host_id, token_hash, kind, expires_at, consumed_at, revoked_at
         ) VALUES ('credential-2', 'host-2', ?, 'long_lived', NULL, NULL, NULL)",
    )
    .bind(token_hash(TOKEN_2))
    .execute(&mut db)
    .await
    .unwrap();

    let mut live = connect_conversation_side(fixture.address).await;
    let mut owner = connect(fixture.address).await;
    complete_attachment(&mut owner, &fixture.controller).await;
    let effects = fixture.effects.clone();
    let start = tokio::spawn(async move {
        IdleStart::start_if_idle(
            &effects,
            &AgentId::parse(AGENT).unwrap(),
            &ConversationId::parse(CONVERSATION).unwrap(),
        )
        .await
    });
    let start_command = next_json(&mut owner).await;
    let generation = start_command["params"]["runtime_generation"]
        .as_i64()
        .unwrap();
    respond(
        &mut owner,
        &start_command,
        json!({ "started": true, "pid": 7, "started_at": 100 }),
    )
    .await;
    start.await.unwrap().unwrap();
    send_product(
        &mut owner,
        product_frame(
            "runtime_state",
            Some(generation),
            json!({
                "state": {
                    "runId": "owner-run",
                    "agentId": AGENT,
                    "conversationId": CONVERSATION,
                    "status": "thinking",
                    "startedAt": 10,
                    "updatedAt": 11,
                    "lastActivityAt": 11,
                },
                "ts": 11,
            }),
        ),
    )
    .await;
    assert_eq!(next_json(&mut live).await["payload"]["runId"], "owner-run");

    let mut foreign = connect_with_token(fixture.address, TOKEN_2).await.unwrap();
    send_ready_with_instance(&mut foreign, OUTBOUND_PROTOCOL_VERSION, "instance-test").await;
    let status = next_json(&mut foreign).await;
    respond(
        &mut foreign,
        &status,
        json!({
            "runtimes": [{
                "runtime_scope": {
                    "kind": "conversation",
                    "conversation_id": CONVERSATION,
                    "agent_id": AGENT,
                },
                "conversation_id": CONVERSATION,
                "agent_id": AGENT,
                "runtime_generation": generation,
                "pid": 9,
                "phase": "ready",
                "run_state": {
                    "runId": "forged-run",
                    "agentId": AGENT,
                    "conversationId": CONVERSATION,
                    "status": "waiting",
                    "startedAt": 20,
                    "updatedAt": 21,
                    "lastActivityAt": 21,
                },
                "started_at": 200,
            }]
        }),
    )
    .await;
    let stop = next_json(&mut foreign).await;
    assert_eq!(stop["kind"], "runtime_stop");
    respond(
        &mut foreign,
        &stop,
        json!({ "mode": "hard", "stopped": true, "exit_code": 0 }),
    )
    .await;
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while fixture.controller.attached_connection_count() != 2 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();

    // The foreign host may describe the colliding daemon/scope, but its exit
    // CAS is stale. A following heartbeat is a deterministic processing
    // barrier before the persisted custody assertion.
    send_runtime_exit(&mut foreign, generation, false, 30).await;
    send_product(
        &mut foreign,
        json!({
            "direction": "daemon_to_server",
            "type": "heartbeat",
            "kind": "ping",
            "ts": 31,
        }),
    )
    .await;
    let pong = next_json(&mut foreign).await;
    assert_eq!(pong["kind"], "pong");
    assert_eq!(pong["echo_ts"], 31);
    let claimed: Option<String> = sqlx::query_scalar(
        "SELECT claimed_by_daemon_instance_id
           FROM agent_runtime_slots
          WHERE agent_id = ? AND conversation_id = ?",
    )
    .bind(AGENT)
    .bind(CONVERSATION)
    .fetch_one(&mut db)
    .await
    .unwrap();
    assert_eq!(claimed.as_deref(), Some("instance-test"));

    send_product(
        &mut foreign,
        product_frame(
            "runtime_state",
            Some(generation),
            json!({
                "state": {
                    "runId": "foreign-write",
                    "agentId": AGENT,
                    "conversationId": CONVERSATION,
                    "status": "thinking",
                    "startedAt": 30,
                    "updatedAt": 31,
                    "lastActivityAt": 31,
                },
                "ts": 31,
            }),
        ),
    )
    .await;
    send_product(
        &mut foreign,
        json!({
            "direction": "daemon_to_server",
            "type": "heartbeat",
            "kind": "ping",
            "ts": 32,
        }),
    )
    .await;
    assert_eq!(next_json(&mut foreign).await["echo_ts"], 32);
    foreign.close(None).await.unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while fixture.controller.attached_connection_count() != 1 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();

    // Detaching the foreign host's colliding instance cannot clear the real
    // host's process cache. Exact owner exit still carries owner-run.
    send_runtime_exit(&mut owner, generation, true, 40).await;
    let exit = next_json(&mut live).await;
    assert_eq!(exit["kind"], "agent_status");
    assert_eq!(exit["payload"]["run_state"]["runId"], "owner-run");
    let claimed: Option<String> = sqlx::query_scalar(
        "SELECT claimed_by_daemon_instance_id
           FROM agent_runtime_slots
          WHERE agent_id = ? AND conversation_id = ?",
    )
    .bind(AGENT)
    .bind(CONVERSATION)
    .fetch_one(&mut db)
    .await
    .unwrap();
    assert!(claimed.is_none());

    live.close(None).await.unwrap();
    owner.close(None).await.unwrap();
    fixture.event_controller.close().await;
    fixture.controller.close().await;
    fixture.server.abort();
}

#[tokio::test]
async fn unknown_host_bearer_is_rejected_before_connection_reservation() {
    let fixture = fixture("unknown-host.sqlite").await;
    let error = connect_with_token(fixture.address, "unknown-host-token")
        .await
        .unwrap_err();
    let tokio_tungstenite::tungstenite::Error::Http(response) = error else {
        panic!("unknown bearer must fail during the HTTP upgrade")
    };
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(fixture.controller.active_connection_count(), 0);
    assert_eq!(fixture.controller.attached_connection_count(), 0);

    fixture.controller.close().await;
    fixture.server.abort();
}

#[tokio::test]
async fn runtime_exit_finalizes_only_the_exact_generation_and_never_its_successor() {
    let fixture = fixture("runtime-exit.sqlite").await;
    let mut socket = connect(fixture.address).await;
    complete_attachment(&mut socket, &fixture.controller).await;

    let effects = fixture.effects.clone();
    let first = tokio::spawn(async move {
        IdleStart::start_if_idle(
            &effects,
            &AgentId::parse(AGENT).unwrap(),
            &ConversationId::parse(CONVERSATION).unwrap(),
        )
        .await
    });
    let first_start = next_json(&mut socket).await;
    assert_eq!(first_start["kind"], "runtime_start");
    assert_eq!(first_start["params"]["runtime_generation"], 1);
    respond(
        &mut socket,
        &first_start,
        json!({ "started": true, "pid": 7, "started_at": 100 }),
    )
    .await;
    first.await.unwrap().unwrap();

    // Keep this fixture focused on exact-generation finalization. A crash exit
    // now owns an automatic pending-inbox respawn effect, so use an intentional
    // exit here before explicitly claiming the successor below.
    send_runtime_exit(&mut socket, 1, true, 111).await;
    let mut db = open(&fixture.path).await;
    wait_for_slot_daemon(&mut db, None).await;

    let effects = fixture.effects.clone();
    let successor = tokio::spawn(async move {
        IdleStart::start_if_idle(
            &effects,
            &AgentId::parse(AGENT).unwrap(),
            &ConversationId::parse(CONVERSATION).unwrap(),
        )
        .await
    });
    let second_start = next_json(&mut socket).await;
    assert_eq!(second_start["kind"], "runtime_start");
    assert_eq!(second_start["params"]["runtime_generation"], 2);
    respond(
        &mut socket,
        &second_start,
        json!({ "started": true, "pid": 8, "started_at": 200 }),
    )
    .await;
    successor.await.unwrap().unwrap();

    send_runtime_exit(&mut socket, 1, true, 222).await;
    tokio::task::yield_now().await;
    let slot = sqlx::query(
        "SELECT generation, claimed_by_daemon_instance_id
           FROM agent_runtime_slots
          WHERE agent_id = ? AND conversation_id = ?",
    )
    .bind(AGENT)
    .bind(CONVERSATION)
    .fetch_one(&mut db)
    .await
    .unwrap();
    assert_eq!(slot.get::<i64, _>("generation"), 2);
    assert_eq!(
        slot.get::<Option<String>, _>("claimed_by_daemon_instance_id")
            .as_deref(),
        Some("instance-test")
    );

    socket.close(None).await.unwrap();
    fixture.controller.close().await;
    fixture.server.abort();
}

#[tokio::test]
async fn async_failed_events_distinguish_retryable_and_terminal_settlement() {
    let fixture = fixture("async-failed.sqlite").await;
    let mut socket = connect(fixture.address).await;
    complete_attachment(&mut socket, &fixture.controller).await;

    let effects = fixture.effects.clone();
    let first = tokio::spawn(async move {
        MainDelivery::deliver_to(
            &effects,
            &AgentId::parse(AGENT).unwrap(),
            &created_message(),
        )
        .await
    });
    let first_command = next_json(&mut socket).await;
    respond(
        &mut socket,
        &first_command,
        json!({ "disposition": "admitted", "pid": 7, "started_at": 100 }),
    )
    .await;
    first.await.unwrap().unwrap();
    let generation = first_command["params"]["runtime_generation"]
        .as_i64()
        .unwrap();
    send_delivery_failed(&mut socket, generation, "child_exit", 120).await;

    let mut db = open(&fixture.path).await;
    wait_for_inbox_state(&mut db, None, None).await;
    let effects = fixture.effects.clone();
    let retry = tokio::spawn(async move {
        MainDelivery::deliver_to(
            &effects,
            &AgentId::parse(AGENT).unwrap(),
            &created_message(),
        )
        .await
    });
    let retry_command = next_json(&mut socket).await;
    assert_eq!(retry_command["params"]["delivery_ids"], json!([1]));
    respond(
        &mut socket,
        &retry_command,
        json!({ "disposition": "admitted", "pid": 7, "started_at": 100 }),
    )
    .await;
    retry.await.unwrap().unwrap();
    send_delivery_failed(&mut socket, generation, "driver_refused", 130).await;
    wait_for_inbox_state(&mut db, Some(130), Some("driver_refused")).await;

    socket.close(None).await.unwrap();
    fixture.controller.close().await;
    fixture.server.abort();
}

async fn send_runtime_exit(socket: &mut Socket, generation: i64, intentional: bool, ts: i64) {
    socket
        .send(Message::Text(
            json!({
                "direction": "daemon_to_server",
                "type": "event",
                "kind": "runtime_exit",
                "runtime_scope": {
                    "kind": "conversation",
                    "conversation_id": CONVERSATION,
                    "agent_id": AGENT,
                },
                "conversation_id": CONVERSATION,
                "agent_id": AGENT,
                "runtime_generation": generation,
                "code": if intentional { Some(0) } else { Some(1) },
                "intentional": intentional,
                "ts": ts,
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();
}

async fn send_delivery_consumed(socket: &mut Socket, generation: i64, ts: i64) {
    socket
        .send(Message::Text(
            json!({
                "direction": "daemon_to_server",
                "type": "event",
                "kind": "runtime_delivery_consumed",
                "runtime_scope": {
                    "kind": "conversation",
                    "conversation_id": CONVERSATION,
                    "agent_id": AGENT,
                },
                "conversation_id": CONVERSATION,
                "agent_id": AGENT,
                "runtime_generation": generation,
                "delivery_ids": [1],
                "ts": ts,
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();
}

async fn send_delivery_failed(socket: &mut Socket, generation: i64, reason: &str, ts: i64) {
    socket
        .send(Message::Text(
            json!({
                "direction": "daemon_to_server",
                "type": "event",
                "kind": "runtime_delivery_failed",
                "runtime_scope": {
                    "kind": "conversation",
                    "conversation_id": CONVERSATION,
                    "agent_id": AGENT,
                },
                "conversation_id": CONVERSATION,
                "agent_id": AGENT,
                "runtime_generation": generation,
                "delivery_ids": [1],
                "reason": reason,
                "ts": ts,
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();
}

async fn wait_for_slot_daemon(db: &mut SqliteConnection, expected: Option<&str>) {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let daemon: Option<String> = sqlx::query_scalar(
                "SELECT claimed_by_daemon_instance_id
                   FROM agent_runtime_slots
                  WHERE agent_id = ? AND conversation_id = ?",
            )
            .bind(AGENT)
            .bind(CONVERSATION)
            .fetch_one(&mut *db)
            .await
            .unwrap();
            if daemon.as_deref() == expected {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

async fn wait_for_inbox_state(
    db: &mut SqliteConnection,
    failed_at: Option<i64>,
    failed_reason: Option<&str>,
) {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let row = sqlx::query(
                "SELECT failed_at, failed_reason, in_flight_owner
                   FROM conversation_inboxes WHERE id = 1",
            )
            .fetch_one(&mut *db)
            .await
            .unwrap();
            if row.get::<Option<i64>, _>("failed_at") == failed_at
                && row.get::<Option<String>, _>("failed_reason").as_deref() == failed_reason
                && row.get::<Option<String>, _>("in_flight_owner").is_none()
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

fn product_frame(kind: &str, generation: Option<i64>, fields: Value) -> Value {
    product_frame_for(
        kind,
        generation,
        fields,
        AGENT,
        CONVERSATION,
        "conversation",
    )
}

fn product_frame_for(
    kind: &str,
    generation: Option<i64>,
    fields: Value,
    agent: &str,
    conversation: &str,
    scope_kind: &str,
) -> Value {
    let runtime_scope = if scope_kind == "agent" {
        json!({ "kind": "agent", "agent_id": agent })
    } else {
        json!({ "kind": "conversation", "conversation_id": conversation, "agent_id": agent })
    };
    let mut frame = serde_json::Map::from_iter([
        ("direction".to_owned(), json!("daemon_to_server")),
        ("type".to_owned(), json!("event")),
        ("kind".to_owned(), json!(kind)),
        ("runtime_scope".to_owned(), runtime_scope),
        ("conversation_id".to_owned(), json!(conversation)),
        ("agent_id".to_owned(), json!(agent)),
    ]);
    if let Some(generation) = generation {
        frame.insert("runtime_generation".to_owned(), json!(generation));
    }
    frame.extend(fields.as_object().unwrap().clone());
    Value::Object(frame)
}

async fn send_product(socket: &mut Socket, frame: Value) {
    socket
        .send(Message::Text(frame.to_string().into()))
        .await
        .unwrap();
}

#[tokio::test]
async fn hydrated_product_frames_reach_durable_live_and_coordinator_owners_once() {
    let fixture = fixture("daemon-product-events.sqlite").await;
    let mut live = connect_conversation_side(fixture.address).await;
    let mut presence = connect_event_scope(fixture.address, "viewer:user-1").await;
    let mut daemon = connect(fixture.address).await;
    complete_attachment(&mut daemon, &fixture.controller).await;

    let effects = fixture.effects.clone();
    let start = tokio::spawn(async move {
        IdleStart::start_if_idle(
            &effects,
            &AgentId::parse(AGENT).unwrap(),
            &ConversationId::parse(CONVERSATION).unwrap(),
        )
        .await
    });
    let start_command = next_json(&mut daemon).await;
    let generation = start_command["params"]["runtime_generation"]
        .as_i64()
        .unwrap();
    respond(
        &mut daemon,
        &start_command,
        json!({ "started": true, "pid": 7, "started_at": 100 }),
    )
    .await;
    start.await.unwrap().unwrap();

    let run_state = json!({
        "runId": "run-1",
        "agentId": AGENT,
        "conversationId": CONVERSATION,
        "status": "thinking",
        "startedAt": 10,
        "updatedAt": 11,
        "lastActivityAt": 11,
    });
    send_product(
        &mut daemon,
        product_frame(
            "runtime_state",
            Some(generation),
            json!({ "state": run_state, "ts": 11 }),
        ),
    )
    .await;
    let state_live = next_json(&mut live).await;
    assert_eq!(state_live["kind"], "agent_activity");
    assert_eq!(state_live["payload"]["runId"], "run-1");

    send_product(
        &mut daemon,
        product_frame(
            "runtime_init_timeout",
            Some(generation),
            json!({
                "timeout_reason": "silence",
                "elapsed_ms": 10,
                "timeout_ms": 20,
                "retrying": true,
                "retry_attempt": 0,
                "max_retries": 2,
                "cooldown_until": 30,
                "ts": 12,
            }),
        ),
    )
    .await;
    assert_eq!(next_json(&mut live).await["kind"], "agent_init_timeout");
    send_product(
        &mut daemon,
        product_frame(
            "runtime_init_retrying",
            Some(generation),
            json!({
                "retry_attempt": 1,
                "max_retries": 2,
                "delay_ms": 5,
                "ts": 13,
            }),
        ),
    )
    .await;
    let retry_live = next_json(&mut live).await;
    assert_eq!(retry_live["kind"], "agent_status");
    assert_eq!(retry_live["payload"]["status"], "starting");
    send_product(
        &mut daemon,
        product_frame(
            "runtime_init_cooldown",
            Some(generation),
            json!({
                "cooldown_until": 30,
                "attempts_exhausted": 2,
                "ts": 13,
            }),
        ),
    )
    .await;
    let cooldown_live = next_json(&mut live).await;
    assert_eq!(cooldown_live["kind"], "agent_status");
    assert_eq!(cooldown_live["payload"]["status"], "crashed");
    assert_eq!(cooldown_live["payload"]["reason"], "init_cooldown");

    // A later daemon run-state snapshot is the positive recovery gate: it
    // clears the exhausted-init marker, so the final unintentional exit below
    // is again eligible for the pending-inbox respawn.
    send_product(
        &mut daemon,
        product_frame(
            "runtime_state",
            Some(generation),
            json!({ "state": run_state, "ts": 13 }),
        ),
    )
    .await;
    assert_eq!(next_json(&mut live).await["kind"], "agent_activity");

    for (kind, parsed, ts) in [
        (
            "runtime_parsed_event",
            json!({ "kind": "thinking", "text": "first " }),
            14,
        ),
        (
            "runtime_parsed_event",
            json!({ "kind": "thinking", "text": "second" }),
            15,
        ),
    ] {
        send_product(
            &mut daemon,
            product_frame(
                kind,
                Some(generation),
                json!({ "parsed": parsed, "ts": ts }),
            ),
        )
        .await;
        if ts == 14 {
            let presence_frame = next_json(&mut presence).await;
            assert_eq!(presence_frame["kind"], "agent_presence_changed");
            assert_eq!(presence_frame["payload"], json!({ "agent_id": AGENT }));
            assert_eq!(presence_frame["scope"], "viewer:user-1");
        }
        assert_eq!(next_json(&mut live).await["kind"], "agent_event");
        assert_eq!(next_json(&mut live).await["kind"], "conversation_activity");
    }
    let mut db = open(&fixture.path).await;
    let thinking = sqlx::query(
        "SELECT id, payload FROM conversation_events
          WHERE conversation_id = ? AND agent_id = ? AND kind = 'thinking'",
    )
    .bind(CONVERSATION)
    .bind(AGENT)
    .fetch_all(&mut db)
    .await
    .unwrap();
    assert_eq!(thinking.len(), 1);
    assert_eq!(
        serde_json::from_str::<Value>(thinking[0].get("payload")).unwrap()["text"],
        "first second"
    );

    let oversized = "x".repeat(700);
    send_product(
        &mut daemon,
        product_frame(
            "runtime_parsed_event",
            Some(generation),
            json!({
                "parsed": {
                    "kind": "tool_call",
                    "name": "Bash",
                    "input": { "command": oversized },
                    "toolCallId": "tool-1",
                },
                "ts": 16,
            }),
        ),
    )
    .await;
    let tool_live = next_json(&mut live).await;
    assert_eq!(tool_live["kind"], "agent_event");
    assert!(
        tool_live["payload"]["event"]["input"]["command"]
            .as_str()
            .unwrap()
            .contains("<truncated 200 chars>")
    );
    let tool_activity = next_json(&mut live).await;
    assert_eq!(tool_activity["kind"], "conversation_activity");
    let tool_id = tool_activity["payload"]["id"].as_i64().unwrap();
    sqlx::query("UPDATE agents SET last_activity_at = NULL WHERE id = ?")
        .bind(AGENT)
        .execute(&mut db)
        .await
        .unwrap();
    send_product(
        &mut daemon,
        product_frame(
            "runtime_parsed_event",
            Some(generation),
            json!({
                "parsed": {
                    "kind": "tool_call_input",
                    "toolCallId": "tool-1",
                    "input": { "command": "refined" },
                },
                "ts": 17,
            }),
        ),
    )
    .await;
    assert_eq!(
        next_json(&mut presence).await["kind"],
        "agent_presence_changed"
    );
    assert_eq!(next_json(&mut live).await["kind"], "agent_event");
    let refined = next_json(&mut live).await;
    assert_eq!(refined["kind"], "conversation_activity");
    assert_eq!(refined["payload"]["id"], tool_id);
    assert_eq!(refined["payload"]["payload"]["input"]["command"], "refined");

    send_product(
        &mut daemon,
        product_frame(
            "runtime_parsed_event",
            Some(generation),
            json!({
                "parsed": {
                    "kind": "input_lifecycle",
                    "commandUuid": "command-1",
                    "state": "started",
                },
                "ts": 18,
            }),
        ),
    )
    .await;
    sqlx::query("UPDATE agents SET last_activity_at = NULL WHERE id = ?")
        .bind(AGENT)
        .execute(&mut db)
        .await
        .unwrap();
    send_product(
        &mut daemon,
        product_frame(
            "runtime_parsed_event",
            Some(generation),
            json!({
                "parsed": { "kind": "unknown", "raw": "future event" },
                "ts": 19,
            }),
        ),
    )
    .await;
    assert_eq!(
        next_json(&mut presence).await["kind"],
        "agent_presence_changed"
    );
    assert_eq!(next_json(&mut live).await["kind"], "agent_event");
    send_product(
        &mut daemon,
        product_frame(
            "runtime_message_stale",
            Some(generation),
            json!({ "ts": 20 }),
        ),
    )
    .await;
    let after_diagnostic = next_json(&mut live).await;
    assert_eq!(after_diagnostic["kind"], "conversation_activity");
    assert_eq!(after_diagnostic["payload"]["kind"], "message_stale");

    send_product(
        &mut daemon,
        product_frame(
            "runtime_ready_for_drain",
            Some(generation),
            json!({ "ts": 21 }),
        ),
    )
    .await;
    let ready_live = next_json(&mut live).await;
    assert_eq!(ready_live["kind"], "agent_status");
    assert_eq!(ready_live["payload"]["status"], "active");
    let drain = next_json(&mut daemon).await;
    assert_eq!(drain["kind"], "runtime_deliver");
    respond(
        &mut daemon,
        &drain,
        json!({ "disposition": "admitted", "pid": 7, "started_at": 100 }),
    )
    .await;

    send_runtime_exit(&mut daemon, generation, false, 22).await;
    let exit_live = next_json(&mut live).await;
    assert_eq!(exit_live["kind"], "agent_status");
    assert_eq!(exit_live["payload"]["status"], "crashed");
    assert_eq!(exit_live["payload"]["run_state"]["runId"], "run-1");
    let respawn = next_json(&mut daemon).await;
    assert_eq!(respawn["kind"], "runtime_deliver");
    assert_eq!(respawn["params"]["runtime_generation"], generation + 1);
    respond(
        &mut daemon,
        &respawn,
        json!({ "disposition": "admitted", "pid": 8, "started_at": 200 }),
    )
    .await;

    let statuses =
        sqlx::query_scalar::<_, String>("SELECT event_kind FROM agent_runtime_events ORDER BY id")
            .fetch_all(&mut db)
            .await
            .unwrap();
    assert!(statuses.iter().any(|kind| kind == "projection_updated"));
    assert!(statuses.iter().any(|kind| kind == "generation_finalized"));

    live.close(None).await.unwrap();
    presence.close(None).await.unwrap();
    daemon.close(None).await.unwrap();
    fixture.event_controller.close().await;
    fixture.controller.close().await;
    fixture.server.abort();
}

#[tokio::test]
async fn hydrated_run_state_is_the_cold_authority_and_session_init_drains_once() {
    let fixture = fixture("daemon-hydrated-run-state.sqlite").await;
    let mut first_daemon = connect(fixture.address).await;
    complete_attachment(&mut first_daemon, &fixture.controller).await;
    let effects = fixture.effects.clone();
    let start = tokio::spawn(async move {
        IdleStart::start_if_idle(
            &effects,
            &AgentId::parse(AGENT).unwrap(),
            &ConversationId::parse(CONVERSATION).unwrap(),
        )
        .await
    });
    let start_command = next_json(&mut first_daemon).await;
    let generation = start_command["params"]["runtime_generation"]
        .as_i64()
        .unwrap();
    respond(
        &mut first_daemon,
        &start_command,
        json!({ "started": true, "pid": 7, "started_at": 100 }),
    )
    .await;
    start.await.unwrap().unwrap();
    first_daemon.close(None).await.unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while fixture.controller.active_connection_count() != 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();

    let wire_fixture: Value = serde_json::from_str(include_str!(
        "../../../../packages/host/tests/fixtures/outbound-daemon-events.json"
    ))
    .unwrap();
    let run_state_case = wire_fixture["runState"]["valid"]
        .as_array()
        .unwrap()
        .iter()
        .find(|test_case| test_case["name"] == "authenticated_hydrate_and_egress")
        .unwrap();
    let hydrated_run_state = run_state_case["state"].clone();
    let expected_live_run_state = run_state_case["canonical"].clone();
    let mut live = connect_conversation_side(fixture.address).await;
    let mut daemon = connect(fixture.address).await;
    send_ready(&mut daemon, OUTBOUND_PROTOCOL_VERSION).await;
    let status = next_json(&mut daemon).await;
    assert_eq!(status["kind"], "runtime_status");
    respond(
        &mut daemon,
        &status,
        json!({
            "runtimes": [{
                "runtime_scope": {
                    "kind": "conversation",
                    "conversation_id": CONVERSATION,
                    "agent_id": AGENT,
                },
                "conversation_id": CONVERSATION,
                "agent_id": AGENT,
                "runtime_generation": generation,
                "pid": 7,
                "phase": "ready",
                "run_state": hydrated_run_state,
                "started_at": 100,
            }]
        }),
    )
    .await;
    wait_for_attachment(&fixture.controller).await;

    send_product(
        &mut daemon,
        product_frame(
            "runtime_parsed_event",
            Some(generation),
            json!({
                "parsed": { "kind": "session_init", "sessionId": "cli-session-1" },
                "ts": 20,
            }),
        ),
    )
    .await;
    assert_eq!(next_json(&mut live).await["kind"], "agent_event");
    let activity = next_json(&mut live).await;
    assert_eq!(activity["kind"], "conversation_activity");
    assert_eq!(activity["payload"]["kind"], "session_init");
    let projected = next_json(&mut live).await;
    assert_eq!(projected["kind"], "agent_status");
    assert_eq!(projected["payload"]["status"], "active");
    assert_eq!(projected["payload"]["cli_session_id"], "cli-session-1");

    let drain = next_json(&mut daemon).await;
    assert_eq!(drain["kind"], "runtime_deliver");
    assert_eq!(drain["params"]["runtime_generation"], generation);
    respond(
        &mut daemon,
        &drain,
        json!({ "disposition": "admitted", "pid": 7, "started_at": 100 }),
    )
    .await;

    send_runtime_exit(&mut daemon, generation, true, 30).await;
    let exit = next_json(&mut live).await;
    assert_eq!(exit["kind"], "agent_status");
    assert_eq!(exit["payload"]["status"], "idle");
    assert_eq!(exit["payload"]["run_state"], expected_live_run_state);

    let mut db = open(&fixture.path).await;
    let projections = sqlx::query(
        "SELECT event_kind, cli_session_id
           FROM agent_runtime_events
          ORDER BY id",
    )
    .fetch_all(&mut db)
    .await
    .unwrap();
    assert!(projections.iter().any(|row| {
        row.get::<String, _>("event_kind") == "projection_updated"
            && row.get::<Option<String>, _>("cli_session_id").as_deref() == Some("cli-session-1")
    }));
    assert!(
        projections
            .iter()
            .any(|row| row.get::<String, _>("event_kind") == "generation_finalized")
    );

    live.close(None).await.unwrap();
    daemon.close(None).await.unwrap();
    fixture.event_controller.close().await;
    fixture.controller.close().await;
    fixture.server.abort();
}

#[tokio::test]
async fn session_init_activity_failure_rolls_back_status_presence_and_live_drain() {
    let fixture = fixture("daemon-session-init-root-uow.sqlite").await;
    let mut daemon = connect(fixture.address).await;
    complete_attachment(&mut daemon, &fixture.controller).await;
    let effects = fixture.effects.clone();
    let start = tokio::spawn(async move {
        IdleStart::start_if_idle(
            &effects,
            &AgentId::parse(AGENT).unwrap(),
            &ConversationId::parse(CONVERSATION).unwrap(),
        )
        .await
    });
    let start_command = next_json(&mut daemon).await;
    let generation = start_command["params"]["runtime_generation"]
        .as_i64()
        .unwrap();
    respond(
        &mut daemon,
        &start_command,
        json!({ "started": true, "pid": 7, "started_at": 100 }),
    )
    .await;
    start.await.unwrap().unwrap();

    let (mut before, before_snapshot) = connect_event_scope_with_ack(
        fixture.address,
        &format!("conversation-side:{CONVERSATION}"),
    )
    .await;
    let mut db = open(&fixture.path).await;
    sqlx::raw_sql(
        "CREATE TRIGGER fail_session_init_activity
         BEFORE INSERT ON conversation_events
         WHEN NEW.kind = 'session_init'
         BEGIN SELECT RAISE(ABORT, 'session-init-activity-failure'); END;",
    )
    .execute(&mut db)
    .await
    .unwrap();
    send_product(
        &mut daemon,
        product_frame(
            "runtime_parsed_event",
            Some(generation),
            json!({
                "parsed": { "kind": "session_init", "sessionId": "must-rollback" },
                "ts": 20,
            }),
        ),
    )
    .await;
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while fixture.controller.active_connection_count() != 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let row = sqlx::query(
        "SELECT s.observed_status, s.cli_session_id, a.last_activity_at,
                (SELECT COUNT(*) FROM conversation_events WHERE kind = 'session_init') AS activities
           FROM agent_runtime_slots s JOIN agents a ON a.id = s.agent_id
          WHERE s.conversation_id = ? AND s.agent_id = ?",
    )
    .bind(CONVERSATION)
    .bind(AGENT)
    .fetch_one(&mut db)
    .await
    .unwrap();
    assert_eq!(row.get::<String, _>("observed_status"), "starting");
    assert!(row.get::<Option<String>, _>("cli_session_id").is_none());
    assert!(row.get::<Option<i64>, _>("last_activity_at").is_none());
    assert_eq!(row.get::<i64, _>("activities"), 0);
    let (mut after, after_snapshot) = connect_event_scope_with_ack(
        fixture.address,
        &format!("conversation-side:{CONVERSATION}"),
    )
    .await;
    assert_eq!(after_snapshot["seq"], before_snapshot["seq"]);

    before.close(None).await.unwrap();
    after.close(None).await.unwrap();
    fixture.event_controller.close().await;
    fixture.controller.close().await;
    fixture.server.abort();
}

#[tokio::test]
async fn stale_resume_fatal_clears_cli_session_before_successor_start() {
    let fixture = fixture("daemon-stale-resume-clear.sqlite").await;
    let mut live = connect_conversation_side(fixture.address).await;
    let mut daemon = connect(fixture.address).await;
    complete_attachment(&mut daemon, &fixture.controller).await;
    let effects = fixture.effects.clone();
    let start = tokio::spawn(async move {
        IdleStart::start_if_idle(
            &effects,
            &AgentId::parse(AGENT).unwrap(),
            &ConversationId::parse(CONVERSATION).unwrap(),
        )
        .await
    });
    let start_command = next_json(&mut daemon).await;
    let generation = start_command["params"]["runtime_generation"]
        .as_i64()
        .unwrap();
    respond(
        &mut daemon,
        &start_command,
        json!({ "started": true, "pid": 7, "started_at": 100 }),
    )
    .await;
    start.await.unwrap().unwrap();
    send_product(
        &mut daemon,
        product_frame(
            "runtime_parsed_event",
            Some(generation),
            json!({
                "parsed": { "kind": "session_init", "sessionId": "stale-cli-session" },
                "ts": 20,
            }),
        ),
    )
    .await;
    for expected in ["agent_event", "conversation_activity", "agent_status"] {
        assert_eq!(next_json(&mut live).await["kind"], expected);
    }
    let drain = next_json(&mut daemon).await;
    respond(
        &mut daemon,
        &drain,
        json!({ "disposition": "admitted", "pid": 7, "started_at": 100 }),
    )
    .await;
    send_product(
        &mut daemon,
        product_frame(
            "runtime_parsed_event",
            Some(generation),
            json!({
                "parsed": {
                    "kind": "error",
                    "message": "resume target vanished",
                    "code": "thread_not_found",
                    "fatal": true
                },
                "ts": 21,
            }),
        ),
    )
    .await;
    assert_eq!(next_json(&mut live).await["kind"], "agent_event");
    assert_eq!(next_json(&mut live).await["kind"], "conversation_activity");
    send_runtime_exit(&mut daemon, generation, false, 22).await;
    let exited = next_json(&mut live).await;
    assert_eq!(exited["kind"], "agent_status");
    assert_eq!(exited["payload"]["status"], "crashed");
    assert!(exited["payload"]["cli_session_id"].is_null());
    let mut db = open(&fixture.path).await;
    assert!(
        sqlx::query_scalar::<_, Option<String>>(
            "SELECT cli_session_id FROM agent_runtime_slots WHERE conversation_id = ? AND agent_id = ?",
        )
        .bind(CONVERSATION)
        .bind(AGENT)
        .fetch_one(&mut db)
        .await
        .unwrap()
        .is_none()
    );
    add_inbox(&mut db, "message-successor", 50).await;
    let effects = fixture.effects.clone();
    let successor = tokio::spawn(async move {
        IdleStart::start_if_idle(
            &effects,
            &AgentId::parse(AGENT).unwrap(),
            &ConversationId::parse(CONVERSATION).unwrap(),
        )
        .await
    });
    let successor_command = next_json(&mut daemon).await;
    assert_eq!(successor_command["kind"], "runtime_start");
    assert!(successor_command["params"]["spawn_options"]["driver"]["cli_session_id"].is_null());
    respond(
        &mut daemon,
        &successor_command,
        json!({ "started": true, "pid": 8, "started_at": 200 }),
    )
    .await;
    successor.await.unwrap().unwrap();

    live.close(None).await.unwrap();
    daemon.close(None).await.unwrap();
    fixture.event_controller.close().await;
    fixture.controller.close().await;
    fixture.server.abort();
}

#[tokio::test]
async fn agent_slot_status_reaches_all_projection_conversations_but_detail_only_the_origin() {
    const AGGREGATE_AGENT: &str = "agent-aggregate";
    const SECOND: &str = "conversation0002";
    let fixture = fixture("daemon-agent-slot-status.sqlite").await;
    let mut db = open(&fixture.path).await;
    sqlx::raw_sql(
        "INSERT INTO agents (id, name, runtime, host_id, created_at, updated_at, display_name, created_by_user_id, session_scope)
         VALUES ('agent-aggregate', 'agent-aggregate', 'codex', 'host-1', 1, 1, 'Aggregate Agent', 'user-1', 'agent');
         INSERT INTO workspace_members (workspace_id, agent_id, joined_at) VALUES ('workspace-1', 'agent-aggregate', 1);
         INSERT INTO conversation_agents (conversation_id, agent_id, joined_at) VALUES ('conversation0001', 'agent-aggregate', 1);
         INSERT INTO conversations (id, workspace_id, placement_kind, roster_policy, title, title_key, status, created_at, updated_at)
         VALUES ('conversation0002', 'workspace-1', 'workspace', 'fixed', 'Second', 'second', 'active', 1, 1);
         INSERT INTO conversation_agents (conversation_id, agent_id, joined_at) VALUES ('conversation0002', 'agent-aggregate', 1);
         INSERT INTO conversation_users (conversation_id, user_id, joined_at) VALUES ('conversation0002', 'user-1', 1);
         INSERT INTO messages (id, conversation_id, from_kind, from_user_id, content, seq, created_at)
         VALUES ('aggregate-message', 'conversation0001', 'user', 'user-1', 'wake aggregate', 2, 2);
         INSERT INTO conversation_inboxes (conversation_id, agent_id, message_id, created_at, delivery_kind)
         VALUES ('conversation0001', 'agent-aggregate', 'aggregate-message', 2, 'turn');",
    )
    .execute(&mut db)
    .await
    .unwrap();
    let mut origin = connect_event_scope(
        fixture.address,
        &format!("conversation-side:{CONVERSATION}"),
    )
    .await;
    let mut second =
        connect_event_scope(fixture.address, &format!("conversation-side:{SECOND}")).await;
    let mut daemon = connect(fixture.address).await;
    complete_attachment(&mut daemon, &fixture.controller).await;
    let effects = fixture.effects.clone();
    let start = tokio::spawn(async move {
        IdleStart::start_if_idle(
            &effects,
            &AgentId::parse(AGGREGATE_AGENT).unwrap(),
            &ConversationId::parse(CONVERSATION).unwrap(),
        )
        .await
    });
    let start_command = next_json(&mut daemon).await;
    let generation = start_command["params"]["runtime_generation"]
        .as_i64()
        .unwrap();
    respond(
        &mut daemon,
        &start_command,
        json!({ "started": true, "pid": 8, "started_at": 100 }),
    )
    .await;
    start.await.unwrap().unwrap();
    send_product(
        &mut daemon,
        product_frame_for(
            "runtime_state",
            Some(generation),
            json!({
                "state": {
                    "runId": "aggregate-run",
                    "agentId": AGGREGATE_AGENT,
                    "conversationId": CONVERSATION,
                    "status": "thinking",
                    "startedAt": 10,
                    "updatedAt": 11,
                    "lastActivityAt": 11
                },
                "ts": 11
            }),
            AGGREGATE_AGENT,
            CONVERSATION,
            "agent",
        ),
    )
    .await;
    assert_eq!(next_json(&mut origin).await["kind"], "agent_activity");
    send_product(
        &mut daemon,
        product_frame_for(
            "runtime_exit",
            Some(generation),
            json!({ "code": 0, "intentional": true, "ts": 12 }),
            AGGREGATE_AGENT,
            CONVERSATION,
            "agent",
        ),
    )
    .await;
    let origin_status = next_json(&mut origin).await;
    let second_status = next_json(&mut second).await;
    assert_eq!(origin_status["kind"], "agent_status");
    assert_eq!(second_status["kind"], "agent_status");
    assert_eq!(
        origin_status["payload"]["run_state"]["runId"],
        "aggregate-run"
    );
    assert!(second_status["payload"].get("run_state").is_none());

    origin.close(None).await.unwrap();
    second.close(None).await.unwrap();
    daemon.close(None).await.unwrap();
    fixture.event_controller.close().await;
    fixture.controller.close().await;
    fixture.server.abort();
}

#[tokio::test(flavor = "current_thread")]
async fn output_arms_are_typed_diagnostics_and_never_business_projection() {
    let fixture = fixture("daemon-output-diagnostics.sqlite").await;
    let mut daemon = connect(fixture.address).await;
    complete_attachment(&mut daemon, &fixture.controller).await;
    let effects = fixture.effects.clone();
    let start = tokio::spawn(async move {
        IdleStart::start_if_idle(
            &effects,
            &AgentId::parse(AGENT).unwrap(),
            &ConversationId::parse(CONVERSATION).unwrap(),
        )
        .await
    });
    let start_command = next_json(&mut daemon).await;
    respond(
        &mut daemon,
        &start_command,
        json!({ "started": true, "pid": 7, "started_at": 100 }),
    )
    .await;
    start.await.unwrap().unwrap();

    let logs = LogBuffer::default();
    let subscriber = tracing_subscriber::fmt()
        .json()
        .without_time()
        .with_target(false)
        .with_writer(logs.clone())
        .finish();
    let _guard = tracing::subscriber::set_default(subscriber);
    for frame in [
        product_frame(
            "runtime_output",
            None,
            json!({ "stream": "stdout", "chunk": "hello", "ts": 30 }),
        ),
        product_frame(
            "runtime_output_dropped",
            None,
            json!({ "dropped_count": 2, "bytes_dropped": 100, "since_ts": 30 }),
        ),
        product_frame("runtime_output_paused", None, json!({})),
        product_frame("runtime_output_resumed", None, json!({})),
    ] {
        send_product(&mut daemon, frame).await;
    }
    daemon
        .send(Message::Text(
            json!({
                "direction": "daemon_to_server",
                "type": "heartbeat",
                "kind": "ping",
                "ts": 31,
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();
    assert_eq!(next_json(&mut daemon).await["kind"], "pong");

    let diagnostics = logs
        .events()
        .into_iter()
        .filter_map(|event| event["fields"]["runtime_event"].as_str().map(str::to_owned))
        .collect::<std::collections::HashSet<_>>();
    assert_eq!(
        diagnostics,
        std::collections::HashSet::from([
            "runtime_output".to_owned(),
            "runtime_output_dropped".to_owned(),
            "runtime_output_paused".to_owned(),
            "runtime_output_resumed".to_owned(),
        ])
    );
    let mut db = open(&fixture.path).await;
    let activity_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM conversation_events")
        .fetch_one(&mut db)
        .await
        .unwrap();
    assert_eq!(activity_count, 0);
    let status: String = sqlx::query_scalar(
        "SELECT observed_status FROM agent_runtime_slots
          WHERE conversation_id = ? AND agent_id = ?",
    )
    .bind(CONVERSATION)
    .bind(AGENT)
    .fetch_one(&mut db)
    .await
    .unwrap();
    assert_eq!(status, "starting");

    daemon.close(None).await.unwrap();
    fixture.event_controller.close().await;
    fixture.controller.close().await;
    fixture.server.abort();
}

#[tokio::test]
async fn stale_generation_events_cannot_change_or_publish_successor_state() {
    let fixture = fixture("daemon-stale-successor.sqlite").await;
    let mut live = connect_conversation_side(fixture.address).await;
    let mut daemon = connect(fixture.address).await;
    complete_attachment(&mut daemon, &fixture.controller).await;

    let effects = fixture.effects.clone();
    let first = tokio::spawn(async move {
        IdleStart::start_if_idle(
            &effects,
            &AgentId::parse(AGENT).unwrap(),
            &ConversationId::parse(CONVERSATION).unwrap(),
        )
        .await
    });
    let first_command = next_json(&mut daemon).await;
    respond(
        &mut daemon,
        &first_command,
        json!({ "started": true, "pid": 7, "started_at": 100 }),
    )
    .await;
    first.await.unwrap().unwrap();
    send_runtime_exit(&mut daemon, 1, true, 40).await;
    assert_eq!(next_json(&mut live).await["kind"], "agent_status");
    let mut db = open(&fixture.path).await;
    wait_for_slot_daemon(&mut db, None).await;

    let effects = fixture.effects.clone();
    let successor = tokio::spawn(async move {
        IdleStart::start_if_idle(
            &effects,
            &AgentId::parse(AGENT).unwrap(),
            &ConversationId::parse(CONVERSATION).unwrap(),
        )
        .await
    });
    let successor_command = next_json(&mut daemon).await;
    assert_eq!(successor_command["params"]["runtime_generation"], 2);
    respond(
        &mut daemon,
        &successor_command,
        json!({ "started": true, "pid": 8, "started_at": 200 }),
    )
    .await;
    successor.await.unwrap().unwrap();

    for (generation, run_id, ts) in [(1, "stale-run", 41), (2, "successor-run", 42)] {
        send_product(
            &mut daemon,
            product_frame(
                "runtime_state",
                Some(generation),
                json!({
                    "state": {
                        "runId": run_id,
                        "agentId": AGENT,
                        "conversationId": CONVERSATION,
                        "status": "thinking",
                        "startedAt": ts,
                        "updatedAt": ts,
                        "lastActivityAt": ts,
                    },
                    "ts": ts,
                }),
            ),
        )
        .await;
    }
    let only_state = next_json(&mut live).await;
    assert_eq!(only_state["kind"], "agent_activity");
    assert_eq!(only_state["payload"]["runId"], "successor-run");

    for (generation, retry_attempt, ts) in [(1, 1, 43), (2, 2, 44)] {
        send_product(
            &mut daemon,
            product_frame(
                "runtime_init_retrying",
                Some(generation),
                json!({
                    "retry_attempt": retry_attempt,
                    "max_retries": 3,
                    "delay_ms": 5,
                    "ts": ts,
                }),
            ),
        )
        .await;
    }
    let only_status = next_json(&mut live).await;
    assert_eq!(only_status["kind"], "agent_status");
    assert_eq!(only_status["payload"]["retry_attempt"], 2);
    let projected_generation: i64 = sqlx::query_scalar(
        "SELECT generation FROM agent_runtime_slots
          WHERE conversation_id = ? AND agent_id = ?",
    )
    .bind(CONVERSATION)
    .bind(AGENT)
    .fetch_one(&mut db)
    .await
    .unwrap();
    assert_eq!(projected_generation, 2);

    live.close(None).await.unwrap();
    daemon.close(None).await.unwrap();
    fixture.event_controller.close().await;
    fixture.controller.close().await;
    fixture.server.abort();
}

#[tokio::test(flavor = "current_thread")]
async fn durable_owner_failure_closes_once_with_a_safe_wire_and_full_operator_chain() {
    let fixture = fixture("daemon-owner-failure.sqlite").await;
    let mut daemon = connect(fixture.address).await;
    complete_attachment(&mut daemon, &fixture.controller).await;
    let effects = fixture.effects.clone();
    let start = tokio::spawn(async move {
        IdleStart::start_if_idle(
            &effects,
            &AgentId::parse(AGENT).unwrap(),
            &ConversationId::parse(CONVERSATION).unwrap(),
        )
        .await
    });
    let command = next_json(&mut daemon).await;
    let generation = command["params"]["runtime_generation"].as_i64().unwrap();
    respond(
        &mut daemon,
        &command,
        json!({ "started": true, "pid": 7, "started_at": 100 }),
    )
    .await;
    start.await.unwrap().unwrap();

    let mut db = open(&fixture.path).await;
    sqlx::raw_sql("DROP TABLE agent_runtime_events")
        .execute(&mut db)
        .await
        .unwrap();
    let logs = LogBuffer::default();
    let subscriber = tracing_subscriber::fmt()
        .json()
        .without_time()
        .with_target(false)
        .with_writer(logs.clone())
        .finish();
    let _guard = tracing::subscriber::set_default(subscriber);

    send_product(
        &mut daemon,
        product_frame(
            "runtime_init_retrying",
            Some(generation),
            json!({
                "retry_attempt": 1,
                "max_retries": 2,
                "delay_ms": 5,
                "ts": 300,
            }),
        ),
    )
    .await;
    let close = daemon.next().await.unwrap().unwrap();
    let Message::Close(Some(close)) = close else {
        panic!("durable owner failure must close the daemon connection")
    };
    assert_eq!(close.code, CloseCode::Error);
    assert_eq!(close.reason, "runtime_event_owner_failed");

    let owner_failures = logs
        .events()
        .into_iter()
        .filter(|event| event["fields"]["message"] == "daemon runtime event owner failed")
        .collect::<Vec<_>>();
    assert_eq!(owner_failures.len(), 1);
    let chain = owner_failures[0]["fields"]["error_chain"].as_str().unwrap();
    assert!(chain.contains("daemon runtime event persistence failed"));
    assert!(chain.contains("no such table: agent_runtime_events"));
    assert!(!chain.contains(TOKEN));

    fixture.event_controller.close().await;
    fixture.controller.close().await;
    fixture.server.abort();
}

#[tokio::test]
async fn daemon_shutdown_clears_only_its_process_projection_before_reattach() {
    let fixture = fixture("daemon-shutdown-projection.sqlite").await;
    let mut live = connect_conversation_side(fixture.address).await;
    let mut first_daemon = connect(fixture.address).await;
    complete_attachment(&mut first_daemon, &fixture.controller).await;
    let effects = fixture.effects.clone();
    let start = tokio::spawn(async move {
        IdleStart::start_if_idle(
            &effects,
            &AgentId::parse(AGENT).unwrap(),
            &ConversationId::parse(CONVERSATION).unwrap(),
        )
        .await
    });
    let command = next_json(&mut first_daemon).await;
    respond(
        &mut first_daemon,
        &command,
        json!({ "started": true, "pid": 7, "started_at": 100 }),
    )
    .await;
    start.await.unwrap().unwrap();
    send_product(
        &mut first_daemon,
        product_frame(
            "runtime_state",
            Some(1),
            json!({
                "state": {
                    "runId": "old-run",
                    "agentId": AGENT,
                    "conversationId": CONVERSATION,
                    "status": "thinking",
                    "startedAt": 50,
                    "updatedAt": 50,
                    "lastActivityAt": 50,
                },
                "ts": 50,
            }),
        ),
    )
    .await;
    assert_eq!(next_json(&mut live).await["payload"]["runId"], "old-run");
    first_daemon
        .send(Message::Text(
            json!({
                "direction": "daemon_to_server",
                "type": "event",
                "kind": "shutting_down",
                "reason": "requested",
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();
    assert!(matches!(
        first_daemon.next().await.unwrap().unwrap(),
        Message::Close(_)
    ));
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while fixture.controller.active_connection_count() != 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();

    let mut second_daemon = connect(fixture.address).await;
    complete_attachment(&mut second_daemon, &fixture.controller).await;
    let mut db = open(&fixture.path).await;
    wait_for_slot_daemon(&mut db, None).await;
    let effects = fixture.effects.clone();
    let successor = tokio::spawn(async move {
        IdleStart::start_if_idle(
            &effects,
            &AgentId::parse(AGENT).unwrap(),
            &ConversationId::parse(CONVERSATION).unwrap(),
        )
        .await
    });
    let successor_command = next_json(&mut second_daemon).await;
    assert_eq!(successor_command["params"]["runtime_generation"], 2);
    respond(
        &mut second_daemon,
        &successor_command,
        json!({ "started": true, "pid": 8, "started_at": 200 }),
    )
    .await;
    successor.await.unwrap().unwrap();
    send_runtime_exit(&mut second_daemon, 2, true, 60).await;
    let exit = next_json(&mut live).await;
    assert_eq!(exit["kind"], "agent_status");
    assert!(exit["payload"]["run_state"].is_null());

    live.close(None).await.unwrap();
    second_daemon.close(None).await.unwrap();
    fixture.event_controller.close().await;
    fixture.controller.close().await;
    fixture.server.abort();
}
