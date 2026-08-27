use std::{
    collections::VecDeque,
    convert::Infallible,
    io::{self, Write},
    sync::{Arc, Mutex},
};

use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::Value;
use silverhand_backend_core::{
    host_runtime::{
        environment::{EntropySource, SystemClock},
        invite::CreateHostInvite,
    },
    identity::UserId,
};
use silverhand_backend_server::host_runtime::{self, HOSTS_PATH};
use silverhand_backend_sqlite::host_runtime::SqliteHostRuntimeStore;
use sqlx::{Connection, SqliteConnection, sqlite::SqliteConnectOptions};
use tempfile::TempDir;
use tower::ServiceExt;
use tracing_subscriber::fmt::MakeWriter;

#[path = "../../backend-sqlite/tests/support/current_schema_snapshot.rs"]
mod current_schema;

#[derive(Clone)]
struct FixedEntropy(Arc<Mutex<VecDeque<u8>>>);

impl FixedEntropy {
    fn sequence() -> Self {
        Self(Arc::new(Mutex::new((0_u8..=u8::MAX).collect())))
    }
}

impl EntropySource for FixedEntropy {
    type Error = Infallible;

    fn fill(&self, destination: &mut [u8]) -> Result<(), Self::Error> {
        let mut source = self.0.lock().unwrap();
        for byte in destination {
            *byte = source.pop_front().unwrap();
        }
        Ok(())
    }
}

async fn fixture(name: &str) -> (TempDir, std::path::PathBuf, SqliteHostRuntimeStore) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join(name);
    let mut connection = current_schema::create_current_schema(&path).await;
    sqlx::query(
        "INSERT INTO users (id, name, display_name, created_at, updated_at)
         VALUES ('user-1', 'user-1', 'User One', 1, 1)",
    )
    .execute(&mut connection)
    .await
    .unwrap();
    connection.close().await.unwrap();
    let store = SqliteHostRuntimeStore::open(&path).await.unwrap();
    (directory, path, store)
}

fn app(store: SqliteHostRuntimeStore) -> Router {
    host_runtime::router(
        CreateHostInvite::new(store, FixedEntropy::sequence(), SystemClock),
        None,
    )
}

#[tokio::test]
async fn real_sqlite_store_drives_the_public_host_create_wire() {
    let (_directory, path, store) = fixture("success.sqlite").await;
    let (status, body) = request(&app(store), "{}").await;
    assert_eq!(status, StatusCode::OK);
    let body: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(body["host_id"], body["host"]["id"]);
    assert_eq!(body["host"]["kind"], "remote");
    assert_eq!(body["host"]["provisioning_source"], "user_invite");
    assert_eq!(body["host"]["status"], "pending");
    assert_eq!(body["host"]["placeable"], false);
    assert_eq!(body["daemon_npm_spec"], "@silverhand-ai/daemon@latest");
    assert_eq!(body["connect_token"].as_str().unwrap().len(), 43);

    let options = SqliteConnectOptions::new()
        .filename(path)
        .foreign_keys(true);
    let mut connection = SqliteConnection::connect_with(&options).await.unwrap();
    let stored_hash: String = sqlx::query_scalar("SELECT token_hash FROM host_credentials")
        .fetch_one(&mut connection)
        .await
        .unwrap();
    assert_ne!(stored_hash, body["connect_token"]);
    let counts: (i64, i64) = (
        sqlx::query_scalar("SELECT count(*) FROM hosts")
            .fetch_one(&mut connection)
            .await
            .unwrap(),
        sqlx::query_scalar("SELECT count(*) FROM host_credentials")
            .fetch_one(&mut connection)
            .await
            .unwrap(),
    );
    assert_eq!(counts, (1, 1));
}

#[tokio::test(flavor = "current_thread")]
async fn real_credential_failure_rolls_back_and_logs_once_without_the_secret() {
    let (_directory, path, store) = fixture("failure.sqlite").await;
    let options = SqliteConnectOptions::new()
        .filename(&path)
        .foreign_keys(true);
    let mut independent = SqliteConnection::connect_with(&options).await.unwrap();
    sqlx::query(
        "CREATE TRIGGER reject_host_credential BEFORE INSERT ON host_credentials
         BEGIN SELECT RAISE(ABORT, 'forced host credential failure'); END",
    )
    .execute(&mut independent)
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
    let (status, body) = request(&app(store), "{}").await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(body, "Internal Server Error");
    let known_generated_token = "HB0eHyAhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5Ojs";
    assert!(!body.contains(known_generated_token));

    let host_count: i64 = sqlx::query_scalar("SELECT count(*) FROM hosts")
        .fetch_one(&mut independent)
        .await
        .unwrap();
    let credential_count: i64 = sqlx::query_scalar("SELECT count(*) FROM host_credentials")
        .fetch_one(&mut independent)
        .await
        .unwrap();
    assert_eq!((host_count, credential_count), (0, 0));

    let events = logs.events();
    let errors = events
        .iter()
        .filter(|event| event["level"] == "ERROR")
        .collect::<Vec<_>>();
    assert_eq!(errors.len(), 1);
    assert_eq!(errors[0]["fields"]["message"], "create host invite failed");
    let chain = errors[0]["fields"]["error_chain"].as_str().unwrap();
    assert!(chain.contains("forced host credential failure"));
    assert!(!chain.contains(known_generated_token));
}

async fn request(app: &Router, body: &'static str) -> (StatusCode, String) {
    let mut request = Request::post(HOSTS_PATH)
        .header("content-type", "application/json")
        .body(Body::from(body))
        .unwrap();
    request
        .extensions_mut()
        .insert(UserId::parse("user-1").unwrap());
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, String::from_utf8(body.to_vec()).unwrap())
}

#[derive(Clone, Default)]
struct LogBuffer(Arc<Mutex<Vec<u8>>>);

impl LogBuffer {
    fn events(&self) -> Vec<Value> {
        let bytes = self.0.lock().unwrap().clone();
        String::from_utf8(bytes)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
}

struct LogWriter(LogBuffer);

impl Write for LogWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl<'a> MakeWriter<'a> for LogBuffer {
    type Writer = LogWriter;

    fn make_writer(&'a self) -> Self::Writer {
        LogWriter(self.clone())
    }
}
