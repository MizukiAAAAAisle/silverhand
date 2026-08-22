use std::{
    io::{self, Write},
    sync::{Arc, Mutex},
};

use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use futures_util::StreamExt;
use serde_json::Value;
use silverhand_backend_server::{
    http,
    wire::{FOUNDATION_EVENT_WEBSOCKET_PATH, FOUNDATION_MESSAGE_PATH},
};
use silverhand_backend_sqlite::FoundationMessageStore;
use sqlx::{Connection, SqliteConnection, sqlite::SqliteConnectOptions};
use tempfile::tempdir;
use tokio::sync::oneshot;
use tokio_tungstenite::{connect_async, tungstenite::Message as WebSocketMessage};
use tower::ServiceExt;
use tracing_subscriber::fmt::MakeWriter;

#[tokio::test]
async fn sqlite_store_drives_exact_http_and_websocket_bytes() {
    let dir = tempdir().unwrap();
    let store = FoundationMessageStore::open(dir.path().join("success.db"))
        .await
        .unwrap();
    let app = http::router(store);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let serving_app = app.clone();
    let server = tokio::spawn(async move {
        axum::serve(listener, serving_app)
            .with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
            })
            .await
            .unwrap();
    });

    let (mut websocket, _) =
        connect_async(format!("ws://{address}{FOUNDATION_EVENT_WEBSOCKET_PATH}"))
            .await
            .unwrap();
    let (status, created_bytes) = request_bytes(
        &app,
        request(
            "POST",
            FOUNDATION_MESSAGE_PATH,
            Some(r#"{"body":"sqlite e2e"}"#),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let created: Value = serde_json::from_str(&created_bytes).unwrap();
    let created_at_ms = created["message"]["createdAtMs"].as_str().unwrap();
    created_at_ms.parse::<i64>().unwrap();
    let exact_message =
        format!(r#"{{"id":"1","body":"sqlite e2e","createdAtMs":"{created_at_ms}"}}"#);
    assert_eq!(
        created_bytes,
        format!(r#"{{"wireContractVersion":1,"message":{exact_message}}}"#)
    );

    let (status, page_bytes) =
        request_bytes(&app, request("GET", FOUNDATION_MESSAGE_PATH, None)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        page_bytes,
        format!(r#"{{"wireContractVersion":1,"total":"1","latest":{exact_message}}}"#)
    );

    let frame = tokio::time::timeout(std::time::Duration::from_secs(2), websocket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let WebSocketMessage::Text(event_bytes) = frame else {
        panic!("expected websocket text");
    };
    assert_eq!(
        event_bytes,
        format!(
            r#"{{"type":"message_created","wireContractVersion":1,"message":{exact_message}}}"#
        )
    );

    websocket.close(None).await.unwrap();
    let _ = shutdown_tx.send(());
    server.await.unwrap();
}

const FORCED_DRIVER_CAUSE: &str = "forced integration event failure";
const REJECT_EVENT_INSERT: &str = "CREATE TRIGGER reject_integration_event BEFORE INSERT ON \
    foundation_message_events BEGIN SELECT RAISE(ABORT, 'forced integration event failure'); END";

#[tokio::test(flavor = "current_thread")]
async fn sqlite_failure_rolls_back_and_reaches_one_safe_boundary_record() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("failure.db");
    let store = FoundationMessageStore::open(&path).await.unwrap();
    let options = SqliteConnectOptions::new()
        .filename(&path)
        .foreign_keys(true);
    let mut independent = SqliteConnection::connect_with(&options).await.unwrap();
    sqlx::query(REJECT_EVENT_INSERT)
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
    let app = http::router(store);

    let (status, failure_bytes) = request_bytes(
        &app,
        request(
            "POST",
            FOUNDATION_MESSAGE_PATH,
            Some(r#"{"body":"must roll back"}"#),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(
        failure_bytes,
        r#"{"wireContractVersion":1,"error":{"code":"internal","message":"internal server error"}}"#
    );
    assert!(!failure_bytes.contains(FORCED_DRIVER_CAUSE));

    let message_count: i64 = sqlx::query_scalar("SELECT count(*) FROM foundation_messages")
        .fetch_one(&mut independent)
        .await
        .unwrap();
    assert_eq!(message_count, 0);
    let (status, page_bytes) =
        request_bytes(&app, request("GET", FOUNDATION_MESSAGE_PATH, None)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        page_bytes,
        r#"{"wireContractVersion":1,"total":"0","latest":null}"#
    );

    let events = logs.events();
    let errors = events
        .iter()
        .filter(|event| event["level"] == "ERROR")
        .collect::<Vec<_>>();
    assert_eq!(errors.len(), 1);
    assert_eq!(
        errors[0]["fields"]["message"],
        "request failed at the persistence boundary"
    );
    let chain = errors[0]["fields"]["error_chain"].as_str().unwrap();
    assert!(chain.starts_with("persistence operation failed: database operation failed:"));
    assert!(chain.contains(FORCED_DRIVER_CAUSE));
}

fn request(method: &str, path: &str, json: Option<&str>) -> Request<Body> {
    let mut builder = Request::builder().method(method).uri(path);
    let body = match json {
        Some(json) => {
            builder = builder.header("content-type", "application/json");
            Body::from(json.to_owned())
        }
        None => Body::empty(),
    };
    builder.body(body).unwrap()
}

async fn request_bytes(app: &Router, request: Request<Body>) -> (StatusCode, String) {
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
