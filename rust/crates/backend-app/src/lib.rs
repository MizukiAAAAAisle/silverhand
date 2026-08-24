#![forbid(unsafe_code)]
//! The sole executable composition root for the Rust backend.

use std::{
    env,
    error::Error,
    future::{Future, IntoFuture},
    net::SocketAddr,
    path::{Path, PathBuf},
};

use axum::Router;
use silverhand_backend_core::{
    auth::{HumanSessionAuthenticator, SessionTtl, SystemSessionClock},
    host_runtime::{CreateHostInvite, OsEntropy, SystemClock},
};
use silverhand_backend_server::{
    auth::{PublicJsonUnauthorized, require_human_session},
    daemon_delivery::{DaemonDeliveryController, DaemonDeliveryRuntime},
    direct_pairs, host_runtime,
    messaging::{
        TargetAddressRefusalLog,
        aftermath::MessagingAftermath,
        router::{SendState, send_routers},
    },
    runtime_credential::{RuntimeCredentialAuthority, require_runtime_credential},
    scope_events::{
        AllowedOrigin, EventWebSocketConfig, EventWebSocketController, HubUnreadPublisher,
        ScopeEventHub,
    },
};
use silverhand_backend_sqlite::{
    auth::SqliteSessionStore, direct_pair_read::SqliteDirectPairReadModel,
    host_runtime::SqliteHostRuntimeStore, messaging::MessagingStore,
    runtime_credential::SqliteRuntimeCustodyStore, runtime_delivery::SqliteRuntimeDeliveryStore,
    scope_event::SqliteEventScopeAuthority, unread_read::SqliteUnreadReadModel,
};
use sqlx::{Row, sqlite::SqlitePoolOptions};
use thiserror::Error;
use tokio::{net::TcpListener, sync::oneshot};

const DATABASE_PATH_ENV: &str = "SILVERHAND_DATABASE_PATH";
const LISTEN_ADDR_ENV: &str = "SILVERHAND_LISTEN_ADDR";
const ALLOWED_ORIGINS_ENV: &str = "SILVERHAND_ALLOWED_ORIGINS";
const DAEMON_NPM_SPEC_ENV: &str = "SILVERHAND_DAEMON_NPM_SPEC";
const BASELINE_MIGRATION_STEP: i64 = const_parse_i64(env!("SILVERHAND_BASELINE_MIGRATION_STEP"));
const CURRENT_MIGRATION_STEP: i64 = const_parse_i64(env!("SILVERHAND_CURRENT_MIGRATION_STEP"));
const MIGRATION_STEPS: &str = env!("SILVERHAND_MIGRATION_STEPS");

const fn const_parse_i64(value: &str) -> i64 {
    let bytes = value.as_bytes();
    let mut index = 0;
    let mut parsed = 0_i64;
    while index < bytes.len() {
        let digit = bytes[index] - b'0';
        parsed = parsed * 10 + digit as i64;
        index += 1;
    }
    parsed
}

#[derive(Clone, Debug)]
pub struct AppConfig {
    database_path: PathBuf,
    listen_addr: SocketAddr,
    allowed_origins: Vec<AllowedOrigin>,
    daemon_npm_spec: Option<String>,
}

impl AppConfig {
    pub fn new(
        database_path: PathBuf,
        listen_addr: SocketAddr,
        allowed_origins: Vec<AllowedOrigin>,
        daemon_npm_spec: Option<String>,
    ) -> Result<Self, ConfigError> {
        if database_path.as_os_str().is_empty() {
            return Err(ConfigError::EmptyDatabasePath);
        }
        if allowed_origins.is_empty() {
            return Err(ConfigError::EmptyAllowedOrigins);
        }
        let daemon_npm_spec = daemon_npm_spec
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty());
        Ok(Self {
            database_path,
            listen_addr,
            allowed_origins,
            daemon_npm_spec,
        })
    }

    pub fn from_env() -> Result<Self, ConfigError> {
        let database_path = required_env(DATABASE_PATH_ENV)?.into();
        let listen_addr = required_env(LISTEN_ADDR_ENV)?
            .parse()
            .map_err(ConfigError::InvalidListenAddress)?;
        let allowed_origins = required_env(ALLOWED_ORIGINS_ENV)?
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| AllowedOrigin::parse(value.to_owned()).map_err(ConfigError::InvalidOrigin))
            .collect::<Result<Vec<_>, _>>()?;
        let daemon_npm_spec = env::var(DAEMON_NPM_SPEC_ENV).ok();
        Self::new(database_path, listen_addr, allowed_origins, daemon_npm_spec)
    }

    pub fn listen_addr(&self) -> SocketAddr {
        self.listen_addr
    }
}

fn required_env(name: &'static str) -> Result<String, ConfigError> {
    env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .ok_or(ConfigError::MissingEnvironment(name))
}

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("required environment variable {0} is missing or empty")]
    MissingEnvironment(&'static str),
    #[error("database path must not be empty")]
    EmptyDatabasePath,
    #[error("event websocket origin allowlist must not be empty")]
    EmptyAllowedOrigins,
    #[error("listen address is invalid")]
    InvalidListenAddress(#[source] std::net::AddrParseError),
    #[error("event websocket origin is invalid")]
    InvalidOrigin(#[source] silverhand_backend_server::scope_events::InvalidAllowedOrigin),
}

#[derive(Debug, Error)]
pub enum StartupError {
    #[error(transparent)]
    Config(#[from] ConfigError),
    #[error("database schema admission failed")]
    Schema(#[source] SchemaAdmissionError),
    #[error("failed to open production adapter {name}")]
    Adapter {
        name: &'static str,
        #[source]
        source: Box<dyn Error + Send + Sync>,
    },
    #[error("failed to construct {name}")]
    Composition {
        name: &'static str,
        #[source]
        source: Box<dyn Error + Send + Sync>,
    },
    #[error("failed to bind the configured listener")]
    Bind(#[source] std::io::Error),
    #[error("served backend failed")]
    Serve(#[source] std::io::Error),
    #[error("shutdown signal authority failed")]
    ShutdownSignal(#[source] Box<dyn Error + Send + Sync>),
}

#[derive(Debug, Error)]
pub enum SchemaAdmissionError {
    #[error("database operation failed while checking the migration ledger")]
    Sql(#[source] sqlx::Error),
    #[error("database migration ledger is not the exact prefix owned by this binary")]
    LedgerMismatch,
}

pub struct PreparedApp {
    pub router: Router,
    event_controller: EventWebSocketController,
    daemon_controller: DaemonDeliveryController,
}

impl PreparedApp {
    pub async fn close_connections(&self) {
        tokio::join!(
            self.event_controller.close(),
            self.daemon_controller.close()
        );
    }
}

pub async fn prepare(config: &AppConfig) -> Result<PreparedApp, StartupError> {
    verify_schema(&config.database_path)
        .await
        .map_err(StartupError::Schema)?;

    let host_store = open(
        "host runtime",
        SqliteHostRuntimeStore::open(&config.database_path),
    )
    .await?;
    let session_store = open(
        "human session",
        SqliteSessionStore::open(&config.database_path),
    )
    .await?;
    let messaging_store = open("messaging", MessagingStore::open(&config.database_path)).await?;
    let custody_store = open(
        "runtime custody",
        SqliteRuntimeCustodyStore::open(&config.database_path),
    )
    .await?;
    let delivery_store = open(
        "runtime delivery",
        SqliteRuntimeDeliveryStore::open(&config.database_path),
    )
    .await?;
    let scope_authority = open(
        "event scope",
        SqliteEventScopeAuthority::open(&config.database_path),
    )
    .await?;
    let unread_read_model = open(
        "unread read model",
        SqliteUnreadReadModel::open(&config.database_path),
    )
    .await?;
    let direct_pair_read_model = open(
        "direct-pair read model",
        SqliteDirectPairReadModel::open(&config.database_path),
    )
    .await?;

    let hub = ScopeEventHub::production().map_err(|source| StartupError::Composition {
        name: "scope event hub",
        source: Box::new(source),
    })?;
    let sessions =
        HumanSessionAuthenticator::new(session_store, SystemSessionClock, SessionTtl::default());
    let runtime_credentials = RuntimeCredentialAuthority::production(custody_store);
    let daemon_runtime = DaemonDeliveryRuntime::production(
        runtime_credentials.clone(),
        delivery_store,
        host_store.clone(),
        hub.clone(),
    )
    .map_err(|source| StartupError::Composition {
        name: "daemon delivery runtime",
        source: Box::new(source),
    })?;
    let (daemon_router, daemon_controller) = daemon_runtime.router();

    let target_address = messaging_store.target_address(hub.clone(), TargetAddressRefusalLog);
    let aftermath = MessagingAftermath::new(
        hub.clone(),
        daemon_runtime.effects(),
        messaging_store.clone(),
        HubUnreadPublisher::new(hub.clone(), unread_read_model),
    );
    let (human_send, agent_send) = send_routers(SendState {
        channel_access: messaging_store.clone(),
        target_address,
        capability: messaging_store.clone(),
        authority: messaging_store.clone(),
        unit_of_work: messaging_store,
        aftermath,
    });

    let host = host_runtime::router(
        CreateHostInvite::new(host_store, OsEntropy, SystemClock),
        config.daemon_npm_spec.clone(),
    );
    let human_products = require_human_session(
        host.merge(human_send)
            .merge(direct_pairs::router(direct_pair_read_model)),
        sessions.clone(),
        PublicJsonUnauthorized,
    );
    let agent_products = require_runtime_credential(agent_send, runtime_credentials);

    let event_config =
        EventWebSocketConfig::production(config.allowed_origins.clone()).map_err(|source| {
            StartupError::Composition {
                name: "event websocket configuration",
                source: Box::new(source),
            }
        })?;
    let (event_router, event_controller) = silverhand_backend_server::scope_events::router(
        hub,
        sessions,
        scope_authority,
        event_config,
    );

    Ok(PreparedApp {
        router: Router::new()
            .merge(human_products)
            .merge(agent_products)
            .merge(event_router)
            .merge(daemon_router),
        event_controller,
        daemon_controller,
    })
}

async fn open<T, E>(
    name: &'static str,
    operation: impl Future<Output = Result<T, E>>,
) -> Result<T, StartupError>
where
    E: Error + Send + Sync + 'static,
{
    operation.await.map_err(|source| StartupError::Adapter {
        name,
        source: Box::new(source),
    })
}

async fn verify_schema(path: &Path) -> Result<(), SchemaAdmissionError> {
    let options = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(false);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .map_err(SchemaAdmissionError::Sql)?;
    let rows = sqlx::query("SELECT version FROM _migrations ORDER BY version")
        .fetch_all(&pool)
        .await
        .map_err(SchemaAdmissionError::Sql)?;
    let actual = rows
        .iter()
        .map(|row| row.try_get::<i64, _>("version"))
        .collect::<Result<Vec<_>, _>>()
        .map_err(SchemaAdmissionError::Sql)?;
    pool.close().await;
    let expected = MIGRATION_STEPS
        .split(',')
        .map(|step| {
            step.parse::<i64>()
                .expect("build script emitted numeric migration step")
        })
        .collect::<Vec<_>>();
    if actual.iter().any(|step| *step > CURRENT_MIGRATION_STEP) {
        return Err(SchemaAdmissionError::LedgerMismatch);
    }
    let active = actual
        .into_iter()
        .filter(|step| *step >= BASELINE_MIGRATION_STEP)
        .collect::<Vec<_>>();
    if active != expected || active.last() != Some(&CURRENT_MIGRATION_STEP) {
        return Err(SchemaAdmissionError::LedgerMismatch);
    }
    Ok(())
}

pub async fn run(config: AppConfig) -> Result<(), StartupError> {
    let app = prepare(&config).await?;
    let listener = TcpListener::bind(config.listen_addr)
        .await
        .map_err(StartupError::Bind)?;
    serve(listener, app, shutdown_signal()).await
}

pub async fn serve<F, E>(
    listener: TcpListener,
    app: PreparedApp,
    shutdown: F,
) -> Result<(), StartupError>
where
    F: Future<Output = Result<(), E>> + Send,
    E: Error + Send + Sync + 'static,
{
    let PreparedApp {
        router,
        event_controller,
        daemon_controller,
    } = app;
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    let server = axum::serve(listener, router)
        .with_graceful_shutdown(async move {
            let _ = shutdown_rx.await;
        })
        .into_future();
    tokio::pin!(server);
    tokio::pin!(shutdown);
    tokio::select! {
        result = &mut server => result.map_err(StartupError::Serve),
        signal = &mut shutdown => {
            let _ = shutdown_tx.send(());
            tokio::join!(event_controller.close(), daemon_controller.close());
            server.await.map_err(StartupError::Serve)?;
            signal.map_err(|source| StartupError::ShutdownSignal(Box::new(source)))
        }
    }
}

async fn shutdown_signal() -> Result<(), std::io::Error> {
    tokio::signal::ctrl_c().await
}

pub fn describe(error: &(dyn Error + 'static)) -> String {
    let mut rendered = error.to_string();
    let mut current = error.source();
    while let Some(source) = current {
        rendered.push_str(": ");
        rendered.push_str(&source.to_string());
        current = source.source();
    }
    rendered
}

#[cfg(test)]
#[path = "../../backend-sqlite/tests/support/current_schema_snapshot.rs"]
mod current_schema;

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use axum::{
        body::{Body, to_bytes},
        http::{Request, StatusCode},
    };
    use futures_util::{SinkExt, StreamExt};
    use silverhand_backend_server::{
        messaging::MESSAGE_SEND_MAX_BODY_BYTES,
        scope_events::{
            DESKTOP_API_EPOCH_HEADER, EVENT_WEBSOCKET_PATH, EVENT_WS_SESSION_COOKIE,
            MINIMUM_CLIENT_API_EPOCH,
        },
    };
    use sqlx::{Connection, Executor};
    use tempfile::TempDir;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio_tungstenite::{
        connect_async,
        tungstenite::{
            Message as ClientMessage,
            client::IntoClientRequest,
            http::header::{COOKIE, ORIGIN},
        },
    };
    use tower::ServiceExt;

    use super::*;

    const TOKEN: &str = "valid-token";
    const TOKEN_HASH: &str = "OXoqnFv14szsOMJZa2grsb0F_m5OzqbBDPQnVf8iVAM";
    const CONVERSATION_ID: &str = "conv000000000001";
    const WORKSPACE_ID: &str = "workspace0000001";

    struct Fixture {
        _directory: TempDir,
        path: PathBuf,
    }

    async fn fixture(with_ledger: bool) -> Fixture {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("backend-app.sqlite");
        let mut database = current_schema::create_current_schema(&path).await;
        if with_ledger {
            database
                .execute(
                    "CREATE TABLE _migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)",
                )
                .await
                .unwrap();
            for step in MIGRATION_STEPS.split(',') {
                sqlx::query(
                    "INSERT INTO _migrations (version, name, applied_at) VALUES (?, 'applied', 1)",
                )
                .bind(step.parse::<i64>().unwrap())
                .execute(&mut database)
                .await
                .unwrap();
            }
        }
        database.close().await.unwrap();
        Fixture {
            _directory: directory,
            path,
        }
    }

    fn config(path: PathBuf) -> AppConfig {
        AppConfig::new(
            path,
            "127.0.0.1:0".parse().unwrap(),
            vec![AllowedOrigin::parse("http://localhost:5173".to_owned()).unwrap()],
            Some("@silverhand-ai/daemon@test".to_owned()),
        )
        .unwrap()
    }

    async fn seed_human(path: &Path) {
        let now = i64::try_from(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis(),
        )
        .unwrap();
        let pool = SqlitePoolOptions::new()
            .connect(path.to_str().unwrap())
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO users (id, name, display_name, created_at, updated_at) VALUES ('user-1', 'viewer', 'Viewer', 1, 1)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO auth_sessions (id, user_id, token_hash, created_at, last_used_at, revoked_at, user_agent, ip_first_seen) VALUES ('session-1', 'user-1', ?, ?, ?, NULL, NULL, NULL)",
        )
        .bind(TOKEN_HASH)
        .bind(now)
        .bind(now)
        .execute(&pool)
        .await
        .unwrap();
        pool.close().await;
    }

    async fn seed_workspace_conversation(path: &Path) {
        let pool = SqlitePoolOptions::new()
            .connect(path.to_str().unwrap())
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO workspaces (id, name, name_key, owner_user_id, created_at, updated_at) VALUES (?, 'Space', 'space', 'user-1', 1, 1)",
        )
        .bind(WORKSPACE_ID)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO workspace_users (workspace_id, user_id, joined_at, role) VALUES (?, 'user-1', 1, 'owner')",
        )
        .bind(WORKSPACE_ID)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO conversations (id, workspace_id, placement_kind, roster_policy, title, title_key, status, visibility, created_at, updated_at) VALUES (?, ?, 'workspace', 'open', 'General', 'general', 'open', 'private', 1, 1)",
        )
        .bind(CONVERSATION_ID)
        .bind(WORKSPACE_ID)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO conversation_users (conversation_id, user_id, joined_at) VALUES (?, 'user-1', 1)",
        )
        .bind(CONVERSATION_ID)
        .execute(&pool)
        .await
        .unwrap();
        pool.close().await;
    }

    async fn request(
        router: &Router,
        method: &str,
        uri: &str,
        bearer: Option<&str>,
    ) -> (StatusCode, String) {
        request_with_body(router, method, uri, bearer, Body::from("{}")).await
    }

    async fn request_with_body(
        router: &Router,
        method: &str,
        uri: &str,
        bearer: Option<&str>,
        body: Body,
    ) -> (StatusCode, String) {
        let mut builder = Request::builder().method(method).uri(uri);
        if let Some(bearer) = bearer {
            builder = builder.header("authorization", bearer);
        }
        let response = router
            .clone()
            .oneshot(builder.body(body).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (status, String::from_utf8(body.to_vec()).unwrap())
    }

    async fn http_over_tcp(
        address: SocketAddr,
        method: &str,
        path: &str,
        bearer: Option<&str>,
        body: &str,
    ) -> String {
        let mut client = tokio::net::TcpStream::connect(address).await.unwrap();
        let authorization = bearer
            .map(|value| format!("Authorization: {value}\r\n"))
            .unwrap_or_default();
        let request = format!(
            "{method} {path} HTTP/1.1\r\nHost: localhost\r\n{authorization}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        client.write_all(request.as_bytes()).await.unwrap();
        let mut response = Vec::new();
        client.read_to_end(&mut response).await.unwrap();
        String::from_utf8(response).unwrap()
    }

    #[test]
    fn config_has_no_implicit_database_listener_or_origin_defaults() {
        assert!(matches!(
            AppConfig::new(
                PathBuf::new(),
                "127.0.0.1:0".parse().unwrap(),
                vec![AllowedOrigin::parse("http://localhost:5173".to_owned()).unwrap()],
                None,
            ),
            Err(ConfigError::EmptyDatabasePath)
        ));
        assert!(matches!(
            AppConfig::new(
                "database.sqlite".into(),
                "127.0.0.1:0".parse().unwrap(),
                Vec::new(),
                None,
            ),
            Err(ConfigError::EmptyAllowedOrigins)
        ));
    }

    #[tokio::test]
    async fn startup_refuses_missing_or_unowned_schema_before_a_listener_exists() {
        let directory = tempfile::tempdir().unwrap();
        let missing = directory.path().join("missing.sqlite");
        let Err(error) = prepare(&config(missing.clone())).await else {
            panic!("missing database must fail closed");
        };
        assert!(matches!(error, StartupError::Schema(_)));
        assert!(!missing.exists());

        let unowned = fixture(false).await;
        let Err(error) = prepare(&config(unowned.path)).await else {
            panic!("schema without migration ownership must fail closed");
        };
        assert!(describe(&error).contains("no such table: _migrations"));

        let fixture = fixture(true).await;
        verify_schema(&fixture.path).await.unwrap();
        let pool = SqlitePoolOptions::new()
            .connect(fixture.path.to_str().unwrap())
            .await
            .unwrap();
        for historical in 1..BASELINE_MIGRATION_STEP {
            sqlx::query(
                "INSERT INTO _migrations (version, name, applied_at) VALUES (?, 'history', 1)",
            )
            .bind(historical)
            .execute(&pool)
            .await
            .unwrap();
        }
        verify_schema(&fixture.path).await.unwrap();

        sqlx::query("DELETE FROM _migrations WHERE version = ?")
            .bind(CURRENT_MIGRATION_STEP - 1)
            .execute(&pool)
            .await
            .unwrap();
        assert!(matches!(
            verify_schema(&fixture.path).await,
            Err(SchemaAdmissionError::LedgerMismatch)
        ));
        sqlx::query(
            "INSERT INTO _migrations (version, name, applied_at) VALUES (?, 'restored', 1)",
        )
        .bind(CURRENT_MIGRATION_STEP - 1)
        .execute(&pool)
        .await
        .unwrap();

        sqlx::query("DELETE FROM _migrations WHERE version = ?")
            .bind(CURRENT_MIGRATION_STEP)
            .execute(&pool)
            .await
            .unwrap();
        assert!(matches!(
            verify_schema(&fixture.path).await,
            Err(SchemaAdmissionError::LedgerMismatch)
        ));
        sqlx::query(
            "INSERT INTO _migrations (version, name, applied_at) VALUES (?, 'restored', 1)",
        )
        .bind(CURRENT_MIGRATION_STEP)
        .execute(&pool)
        .await
        .unwrap();

        sqlx::query("INSERT INTO _migrations (version, name, applied_at) VALUES (?, 'future', 1)")
            .bind(CURRENT_MIGRATION_STEP + 1)
            .execute(&pool)
            .await
            .unwrap();
        assert!(matches!(
            verify_schema(&fixture.path).await,
            Err(SchemaAdmissionError::LedgerMismatch)
        ));
        pool.close().await;
    }

    #[tokio::test]
    async fn the_executable_root_mounts_real_human_products_and_auth_precedes_product_work() {
        let fixture = fixture(true).await;
        seed_human(&fixture.path).await;
        let app = prepare(&config(fixture.path.clone())).await.unwrap();

        let before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM messages")
            .fetch_one(
                &SqlitePoolOptions::new()
                    .connect(fixture.path.to_str().unwrap())
                    .await
                    .unwrap(),
            )
            .await
            .unwrap();
        let refused_human =
            request(&app.router, "POST", "/api/channels/missing/messages", None).await;
        assert_eq!(refused_human.0, StatusCode::UNAUTHORIZED);
        assert_eq!(refused_human.1, r#"{"error":"unauthorized"}"#);
        let refused_agent = request(
            &app.router,
            "POST",
            "/internal/agents/agent-1/send-message",
            Some("Bearer unknown-runtime-token"),
        )
        .await;
        assert_eq!(refused_agent.0, StatusCode::UNAUTHORIZED);
        let after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM messages")
            .fetch_one(
                &SqlitePoolOptions::new()
                    .connect(fixture.path.to_str().unwrap())
                    .await
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!((before, after), (0, 0));

        let direct_pairs = request(
            &app.router,
            "GET",
            "/api/direct-pairs",
            Some(&format!("Bearer {TOKEN}")),
        )
        .await;
        assert_eq!(direct_pairs.0, StatusCode::OK);
        assert_eq!(direct_pairs.1, r#"{"direct_pairs":[]}"#);

        let host = request(
            &app.router,
            "POST",
            "/api/hosts",
            Some(&format!("Bearer {TOKEN}")),
        )
        .await;
        assert_eq!(host.0, StatusCode::OK, "{}", host.1);
        assert!(
            host.1
                .contains(r#""daemon_npm_spec":"@silverhand-ai/daemon@test""#)
        );
        app.close_connections().await;
    }

    #[tokio::test]
    async fn both_auth_boundaries_precede_body_fences_and_broken_product_authorities() {
        let fixture = fixture(true).await;
        let app = prepare(&config(fixture.path.clone())).await.unwrap();
        let oversized = vec![b'x'; MESSAGE_SEND_MAX_BODY_BYTES + 1];

        let human_oversized = request_with_body(
            &app.router,
            "POST",
            &format!("/api/channels/{CONVERSATION_ID}/messages"),
            None,
            Body::from(oversized.clone()),
        )
        .await;
        assert_eq!(human_oversized.0, StatusCode::UNAUTHORIZED);
        let agent_oversized = request_with_body(
            &app.router,
            "POST",
            "/internal/agents/agent-1/send-message",
            Some("Bearer unknown-runtime-token"),
            Body::from(oversized),
        )
        .await;
        assert_eq!(agent_oversized.0, StatusCode::UNAUTHORIZED);

        let pool = SqlitePoolOptions::new()
            .connect(fixture.path.to_str().unwrap())
            .await
            .unwrap();
        sqlx::query("DROP TABLE conversations")
            .execute(&pool)
            .await
            .unwrap();
        let messages_before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM messages")
            .fetch_one(&pool)
            .await
            .unwrap();

        let human_broken_authority = request_with_body(
            &app.router,
            "POST",
            &format!("/api/channels/{CONVERSATION_ID}/messages"),
            Some("Bearer unknown-human-token"),
            Body::from(r#"{"content":"hello"}"#),
        )
        .await;
        assert_eq!(human_broken_authority.0, StatusCode::UNAUTHORIZED);
        let agent_broken_authority = request_with_body(
            &app.router,
            "POST",
            "/internal/agents/agent-1/send-message",
            Some("Bearer unknown-runtime-token"),
            Body::from(format!(
                r##"{{"content":"hello","target":"#conv:{CONVERSATION_ID}"}}"##
            )),
        )
        .await;
        assert_eq!(agent_broken_authority.0, StatusCode::UNAUTHORIZED);
        let messages_after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM messages")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!((messages_before, messages_after), (0, 0));
        pool.close().await;
        app.close_connections().await;
    }

    #[tokio::test]
    async fn a_composed_human_send_commits_and_reaches_the_same_production_event_hub() {
        let fixture = fixture(true).await;
        seed_human(&fixture.path).await;
        seed_workspace_conversation(&fixture.path).await;
        let app = prepare(&config(fixture.path.clone())).await.unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let running = tokio::spawn(serve(listener, app, async move {
            let _ = shutdown_rx.await;
            Ok::<(), std::io::Error>(())
        }));

        let mut websocket_request = format!("ws://{address}{EVENT_WEBSOCKET_PATH}")
            .into_client_request()
            .unwrap();
        websocket_request
            .headers_mut()
            .insert(ORIGIN, "http://localhost:5173".parse().unwrap());
        websocket_request.headers_mut().insert(
            COOKIE,
            format!("{EVENT_WS_SESSION_COOKIE}={TOKEN}")
                .parse()
                .unwrap(),
        );
        websocket_request
            .headers_mut()
            .insert(DESKTOP_API_EPOCH_HEADER, MINIMUM_CLIENT_API_EPOCH.into());
        let (mut socket, _) = connect_async(websocket_request).await.unwrap();
        let authenticated = socket.next().await.unwrap().unwrap();
        let ClientMessage::Text(authenticated) = authenticated else {
            panic!("authenticated frame must be text");
        };
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&authenticated).unwrap()["type"],
            "authenticated"
        );
        socket
            .send(ClientMessage::Text(
                serde_json::json!({
                    "type": "subscribe",
                    "scope": format!("conversation:{CONVERSATION_ID}"),
                })
                .to_string()
                .into(),
            ))
            .await
            .unwrap();
        let subscribed = socket.next().await.unwrap().unwrap();
        let ClientMessage::Text(subscribed) = subscribed else {
            panic!("subscribed frame must be text");
        };
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&subscribed).unwrap()["type"],
            "subscribed"
        );

        let response = http_over_tcp(
            address,
            "POST",
            &format!("/api/channels/{CONVERSATION_ID}/messages"),
            Some(&format!("Bearer {TOKEN}")),
            r#"{"content":"composed hello"}"#,
        )
        .await;
        assert!(
            response.starts_with("HTTP/1.1 201 Created\r\n"),
            "{response}"
        );

        let event = socket.next().await.unwrap().unwrap();
        let ClientMessage::Text(event) = event else {
            panic!("message event must be text");
        };
        let event: serde_json::Value = serde_json::from_str(&event).unwrap();
        assert_eq!(event["scope"], format!("conversation:{CONVERSATION_ID}"));
        assert_eq!(event["kind"], "message");
        assert_eq!(event["payload"]["message"]["content"], "composed hello");

        let pool = SqlitePoolOptions::new()
            .connect(fixture.path.to_str().unwrap())
            .await
            .unwrap();
        let committed: (String, String) =
            sqlx::query_as("SELECT id, content FROM messages WHERE conversation_id = ?")
                .bind(CONVERSATION_ID)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(committed.1, "composed hello");
        assert_eq!(event["payload"]["message"]["id"], committed.0);
        pool.close().await;

        socket.close(None).await.unwrap();
        shutdown_tx.send(()).unwrap();
        running.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn the_real_listener_serves_the_composed_router_then_shuts_down_cleanly() {
        let fixture = fixture(true).await;
        let app = prepare(&config(fixture.path)).await.unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let running = tokio::spawn(serve(listener, app, async move {
            let _ = shutdown_rx.await;
            Ok::<(), std::io::Error>(())
        }));

        let mut client = tokio::net::TcpStream::connect(address).await.unwrap();
        client
            .write_all(
                b"GET /api/direct-pairs HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
            )
            .await
            .unwrap();
        let mut response = Vec::new();
        client.read_to_end(&mut response).await.unwrap();
        let response = String::from_utf8(response).unwrap();
        assert!(response.starts_with("HTTP/1.1 401 Unauthorized\r\n"));
        assert!(response.ends_with(r#"{"error":"unauthorized"}"#));

        shutdown_tx.send(()).unwrap();
        running.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn shutdown_signal_failure_is_a_sourced_nonzero_run_failure() {
        let fixture = fixture(true).await;
        let app = prepare(&config(fixture.path)).await.unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let failure = std::io::Error::other("signal authority unavailable");
        let error = serve(listener, app, async move { Err(failure) })
            .await
            .unwrap_err();
        assert!(matches!(error, StartupError::ShutdownSignal(_)));
        assert_eq!(
            describe(&error),
            "shutdown signal authority failed: signal authority unavailable"
        );
    }
}
