#[path = "../../backend-sqlite/tests/support/current_schema_snapshot.rs"]
mod current_schema;
#[path = "support/log_capture.rs"]
mod log_capture;

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use futures_util::{SinkExt, StreamExt};
use log_capture::LogBuffer;
use sha2::{Digest, Sha256};
use silverhand_backend_core::auth::{HumanSessionAuthenticator, SessionClock, SessionTtl};
use silverhand_backend_core::identity::UserId;
use silverhand_backend_server::scope_events::{
    AllowedOrigin, ConnectionLifecycle, DESKTOP_API_EPOCH_HEADER, EVENT_WEBSOCKET_PATH,
    EVENT_WS_SESSION_COOKIE, EventWebSocketConfig, ScopeEventHub, router,
};
use silverhand_backend_sqlite::{auth::SqliteSessionStore, scope_event::SqliteEventScopeAuthority};
use sqlx::{Connection, SqliteConnection};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{
        Error as WebSocketError,
        client::IntoClientRequest,
        http::{
            HeaderValue, StatusCode,
            header::{AUTHORIZATION, COOKIE, ORIGIN},
        },
    },
};

const ORIGIN_VALUE: &str = "http://desktop.test";
const VALID: &str = "valid-token";
const REVOKED: &str = "revoked-token";
const EXPIRED: &str = "expired-token";

#[derive(Clone)]
struct FixedClock;

impl SessionClock for FixedClock {
    fn now_unix_millis(&self) -> i64 {
        10_000
    }
}

/// A do-nothing lifecycle for tests that exercise the WS transport alone and do
/// not assert on presence. Production wiring lives in `backend-app`; the crate's
/// only null implementation is test-scoped by design.
struct NullLifecycle;

impl ConnectionLifecycle for NullLifecycle {
    fn on_connect(&self, _viewer: &UserId, _connection_id: &str) {}
    fn on_disconnect(&self, _viewer: &UserId, _connection_id: &str) {}
}

async fn fixture() -> (tempfile::TempDir, std::path::PathBuf) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("scope-event-e2e.sqlite");
    let mut db = current_schema::create_current_schema(&path).await;
    sqlx::query(
        "INSERT INTO users (id, name, display_name, created_at, updated_at) VALUES ('user-1', 'user', 'User', 1, 1)",
    )
    .execute(&mut db)
    .await
    .unwrap();
    for (id, token, last_used, revoked_at) in [
        ("session-valid", VALID, 9_500, None),
        ("session-revoked", REVOKED, 9_500, Some(9_800)),
        ("session-expired", EXPIRED, 1, None),
    ] {
        sqlx::query(
            "INSERT INTO auth_sessions (id, user_id, token_hash, created_at, last_used_at, revoked_at, user_agent, ip_first_seen) VALUES (?, 'user-1', ?, 1, ?, ?, NULL, NULL)",
        )
        .bind(id)
        .bind(token_hash(token))
        .bind(last_used)
        .bind(revoked_at)
        .execute(&mut db)
        .await
        .unwrap();
    }
    sqlx::query(
        "INSERT INTO workspaces (id, name, name_key, owner_user_id, created_at, updated_at) VALUES ('workspace-1', 'Space', 'space', 'user-1', 1, 1)",
    )
    .execute(&mut db)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO workspace_users (workspace_id, user_id, joined_at, role) VALUES ('workspace-1', 'user-1', 1, 'owner')",
    )
    .execute(&mut db)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO conversations (id, workspace_id, placement_kind, roster_policy, title, title_key, status, visibility, created_at, updated_at) VALUES ('conversation-1', 'workspace-1', 'workspace', 'open', 'Channel', 'channel', 'open', 'private', 1, 1)",
    )
    .execute(&mut db)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO conversation_users (conversation_id, user_id, joined_at) VALUES ('conversation-1', 'user-1', 1)",
    )
    .execute(&mut db)
    .await
    .unwrap();
    db.close().await.unwrap();
    (directory, path)
}

async fn running(
    path: &std::path::Path,
) -> (
    std::net::SocketAddr,
    silverhand_backend_server::scope_events::EventWebSocketController,
    tokio::task::JoinHandle<()>,
) {
    let sessions = HumanSessionAuthenticator::new(
        SqliteSessionStore::open(path).await.unwrap(),
        FixedClock,
        SessionTtl::from_millis(1_000).unwrap(),
    );
    let scopes = SqliteEventScopeAuthority::open(path).await.unwrap();
    let config =
        EventWebSocketConfig::production([AllowedOrigin::parse(ORIGIN_VALUE).unwrap()]).unwrap();
    let (app, controller) = router(
        ScopeEventHub::production().unwrap(),
        sessions,
        scopes,
        std::sync::Arc::new(NullLifecycle),
        config,
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (address, controller, server)
}

#[tokio::test]
async fn cookie_origin_session_and_epoch_are_all_required_in_order() {
    for (name, token, origin, epoch, authorization, expected) in [
        (
            "valid",
            Some(VALID),
            Some(ORIGIN_VALUE),
            Some("3"),
            None,
            StatusCode::SWITCHING_PROTOCOLS,
        ),
        (
            "unknown",
            Some("unknown"),
            Some(ORIGIN_VALUE),
            Some("3"),
            None,
            StatusCode::UNAUTHORIZED,
        ),
        (
            "revoked",
            Some(REVOKED),
            Some(ORIGIN_VALUE),
            Some("3"),
            None,
            StatusCode::UNAUTHORIZED,
        ),
        (
            "expired",
            Some(EXPIRED),
            Some(ORIGIN_VALUE),
            Some("3"),
            None,
            StatusCode::UNAUTHORIZED,
        ),
        (
            "missing-origin",
            Some(VALID),
            None,
            Some("3"),
            None,
            StatusCode::FORBIDDEN,
        ),
        (
            "foreign-origin",
            Some(VALID),
            Some("http://evil.test"),
            Some("3"),
            None,
            StatusCode::FORBIDDEN,
        ),
        (
            "authorization-only",
            None,
            Some(ORIGIN_VALUE),
            Some("3"),
            Some("Bearer valid-token"),
            StatusCode::UNAUTHORIZED,
        ),
        (
            "old-epoch",
            Some(VALID),
            Some(ORIGIN_VALUE),
            None,
            None,
            StatusCode::UPGRADE_REQUIRED,
        ),
    ] {
        let (_directory, path) = fixture().await;
        let (address, controller, server) = running(&path).await;
        let result = connect(address, token, origin, epoch, authorization).await;
        if expected == StatusCode::SWITCHING_PROTOCOLS {
            let (mut socket, response) = result.unwrap();
            assert_eq!(response.status(), expected, "{name}");
            assert_eq!(next_json(&mut socket).await["type"], "authenticated");
            for scope in ["viewer:self", "conversation:conversation-1"] {
                socket
                    .send(tokio_tungstenite::tungstenite::Message::Text(
                        serde_json::json!({ "type": "subscribe", "scope": scope })
                            .to_string()
                            .into(),
                    ))
                    .await
                    .unwrap();
                assert_eq!(next_json(&mut socket).await["type"], "subscribed");
            }
            socket.close(None).await.unwrap();
        } else {
            assert_eq!(http_status(result.unwrap_err()), expected, "{name}");
        }
        controller.close().await;
        assert_eq!(controller.active_connection_count(), 0, "{name}");
        server.abort();
    }

    let (_directory, path) = fixture().await;
    let (address, controller, server) = running(&path).await;
    let result = connect(address, Some("unknown"), Some(ORIGIN_VALUE), None, None).await;
    assert_eq!(http_status(result.unwrap_err()), StatusCode::UNAUTHORIZED);
    assert_eq!(last_used(&path, "session-valid").await, 9_500);
    controller.close().await;
    server.abort();

    let (_directory, path) = fixture().await;
    let (address, controller, server) = running(&path).await;
    let result = connect(address, Some(VALID), Some(ORIGIN_VALUE), None, None).await;
    assert_eq!(
        http_status(result.unwrap_err()),
        StatusCode::UPGRADE_REQUIRED
    );
    assert_eq!(last_used(&path, "session-valid").await, 10_000);
    controller.close().await;
    server.abort();
}

#[tokio::test(flavor = "current_thread")]
async fn auth_store_failure_is_one_safe_preupgrade_error() {
    let (_directory, path) = fixture().await;
    let (address, controller, server) = running(&path).await;
    let mut db = SqliteConnection::connect(&format!("sqlite://{}", path.display()))
        .await
        .unwrap();
    sqlx::query("DROP TABLE auth_sessions")
        .execute(&mut db)
        .await
        .unwrap();
    db.close().await.unwrap();

    let logs = LogBuffer::default();
    let subscriber = tracing_subscriber::fmt()
        .json()
        .without_time()
        .with_target(false)
        .with_writer(logs.clone())
        .finish();
    let _guard = tracing::subscriber::set_default(subscriber);
    let error = connect(address, Some(VALID), Some(ORIGIN_VALUE), Some("3"), None)
        .await
        .unwrap_err();
    assert_eq!(http_status(error), StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(controller.active_connection_count(), 0);

    let errors = logs
        .events()
        .into_iter()
        .filter(|event| event["level"] == "ERROR")
        .collect::<Vec<_>>();
    assert_eq!(errors.len(), 1);
    assert_eq!(
        errors[0]["fields"]["message"],
        "event websocket session authentication failed"
    );
    let chain = errors[0]["fields"]["error_chain"].as_str().unwrap();
    assert!(chain.contains("no such table: auth_sessions"));
    assert!(!chain.contains(VALID));
    assert!(!chain.contains(&token_hash(VALID)));
    controller.close().await;
    server.abort();
}

fn token_hash(token: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(token.as_bytes()))
}

async fn connect(
    address: std::net::SocketAddr,
    token: Option<&str>,
    origin: Option<&str>,
    epoch: Option<&str>,
    authorization: Option<&str>,
) -> Result<
    (
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
        tokio_tungstenite::tungstenite::handshake::client::Response,
    ),
    WebSocketError,
> {
    let mut request = format!("ws://{address}{EVENT_WEBSOCKET_PATH}")
        .into_client_request()
        .unwrap();
    if let Some(token) = token {
        request.headers_mut().insert(
            COOKIE,
            HeaderValue::from_str(&format!("{EVENT_WS_SESSION_COOKIE}={token}")).unwrap(),
        );
    }
    if let Some(origin) = origin {
        request
            .headers_mut()
            .insert(ORIGIN, origin.parse().unwrap());
    }
    if let Some(epoch) = epoch {
        request
            .headers_mut()
            .insert(DESKTOP_API_EPOCH_HEADER, epoch.parse().unwrap());
    }
    if let Some(authorization) = authorization {
        request
            .headers_mut()
            .insert(AUTHORIZATION, authorization.parse().unwrap());
    }
    connect_async(request).await
}

fn http_status(error: WebSocketError) -> StatusCode {
    let WebSocketError::Http(response) = error else {
        panic!("expected HTTP refusal: {error}")
    };
    response.status()
}

async fn last_used(path: &std::path::Path, id: &str) -> i64 {
    let mut db = SqliteConnection::connect(&format!("sqlite://{}", path.display()))
        .await
        .unwrap();
    let value = sqlx::query_scalar("SELECT last_used_at FROM auth_sessions WHERE id = ?")
        .bind(id)
        .fetch_one(&mut db)
        .await
        .unwrap();
    db.close().await.unwrap();
    value
}

async fn next_json<S>(socket: &mut tokio_tungstenite::WebSocketStream<S>) -> serde_json::Value
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let tokio_tungstenite::tungstenite::Message::Text(frame) =
        socket.next().await.unwrap().unwrap()
    else {
        panic!("expected text frame")
    };
    serde_json::from_str(&frame).unwrap()
}
