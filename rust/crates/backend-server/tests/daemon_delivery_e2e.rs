#[path = "../../backend-sqlite/tests/support/current_schema_snapshot.rs"]
mod current_schema;

use axum::http::StatusCode;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use silverhand_backend_core::{
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
};
use silverhand_backend_server::{
    daemon_delivery::{
        DaemonDeliveryController, DaemonDeliveryEffects, DaemonDeliveryRuntime,
        HOST_PROTOCOL_VERSION, HOST_WEBSOCKET_PATH, OUTBOUND_PROTOCOL_VERSION,
        UPDATE_REQUIRED_CLOSE_REASON,
    },
    runtime_credential::RuntimeCredentialAuthority,
};
use silverhand_backend_sqlite::{
    host_runtime::SqliteHostRuntimeStore, runtime_credential::SqliteRuntimeCustodyStore,
    runtime_delivery::SqliteRuntimeDeliveryStore,
};
use sqlx::{Connection, Row, SqliteConnection, sqlite::SqliteConnectOptions};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async,
    tungstenite::{
        Message, client::IntoClientRequest, http::header::AUTHORIZATION,
        protocol::frame::coding::CloseCode,
    },
};

const TOKEN: &str = "host-token";
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
    server: tokio::task::JoinHandle<()>,
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
    let runtime =
        Runtime::production(RuntimeCredentialAuthority::production(custody), data, hosts).unwrap();
    let effects = runtime.effects();
    let (router, controller) = runtime.router();
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

async fn seed(db: &mut SqliteConnection) {
    sqlx::query(
        "INSERT INTO users (id, name, display_name, created_at, updated_at)
         VALUES ('user-1', 'user-1', 'User One', 1, 1)",
    )
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
    socket
        .send(Message::Text(
            json!({
                "direction": "daemon_to_server",
                "type": "event",
                "kind": "ready",
                "protocol_version": protocol_version,
                "daemon_version": "test",
                "daemon_id": "daemon-test",
                "instance_id": "instance-test",
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
    loop {
        match socket.next().await.unwrap().unwrap() {
            Message::Text(text) => return serde_json::from_str(&text).unwrap(),
            Message::Ping(payload) => socket.send(Message::Pong(payload)).await.unwrap(),
            other => panic!("unexpected daemon frame: {other:?}"),
        }
    }
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
            DaemonInstanceId::parse("42:100").unwrap(),
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
    assert_eq!(daemon.as_deref(), Some("42:100"));
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
        Some("42:100")
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

    send_runtime_exit(&mut socket, 1, false, 111).await;
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
        Some("42:100")
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
