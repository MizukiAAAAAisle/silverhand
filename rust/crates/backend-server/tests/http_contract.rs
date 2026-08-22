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
use serde_json::{Value, json};
use silverhand_backend_core::foundation_message::{
    Message, MessageCreatedFact, MessagePageFact, MessageReadUnitOfWork, MessageUnitOfWork,
};
use silverhand_backend_core::persistence::PersistenceFailure;
use silverhand_backend_server::{
    http,
    wire::{FOUNDATION_EVENT_WEBSOCKET_PATH, FOUNDATION_MESSAGE_PATH, HEALTH_PATH},
};
use tokio::sync::oneshot;
use tokio_tungstenite::{connect_async, tungstenite::Message as WebSocketMessage};
use tower::ServiceExt;
use tracing_subscriber::fmt::MakeWriter;

#[derive(Clone, Default)]
struct InMemoryStore {
    rows: Arc<Mutex<Vec<Message>>>,
    create_calls: Arc<Mutex<usize>>,
}

impl MessageUnitOfWork for InMemoryStore {
    async fn create_message_with_event(
        &self,
        body: String,
    ) -> Result<MessageCreatedFact, PersistenceFailure> {
        *self.create_calls.lock().unwrap() += 1;
        let mut rows = self.rows.lock().unwrap();
        let id = rows.len() as i64 + 1;
        let message = Message {
            id,
            body,
            created_at_ms: id * 1_000,
        };
        rows.push(message.clone());
        Ok(MessageCreatedFact { message })
    }
}

impl MessageReadUnitOfWork for InMemoryStore {
    async fn latest_page(&self) -> Result<MessagePageFact, PersistenceFailure> {
        let rows = self.rows.lock().unwrap();
        Ok(MessagePageFact {
            total: rows.len() as i64,
            latest: rows.last().cloned(),
        })
    }
}

#[tokio::test]
async fn http_contract_covers_health_create_and_snapshot_read() {
    let app = http::router(InMemoryStore::default());

    let (status, health) = request_json(&app, request("GET", HEALTH_PATH, None)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(health, json!({"status": "ok", "wireContractVersion": 1}));

    let (status, created) = request_json(
        &app,
        request(
            "POST",
            FOUNDATION_MESSAGE_PATH,
            Some(json!({"body": "  public behavior  "})),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(
        created,
        json!({
            "wireContractVersion": 1,
            "message": {
                "id": "1",
                "body": "public behavior",
                "createdAtMs": "1000"
            }
        })
    );

    let (status, page) = request_json(&app, request("GET", FOUNDATION_MESSAGE_PATH, None)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        page,
        json!({
            "wireContractVersion": 1,
            "total": "1",
            "latest": created["message"]
        })
    );
}

#[tokio::test]
async fn validation_rejects_semantic_and_wire_shape_errors_before_the_port() {
    let store = InMemoryStore::default();
    let app = http::router(store.clone());

    let (status, body) = request_json(
        &app,
        request(
            "POST",
            FOUNDATION_MESSAGE_PATH,
            Some(json!({"body": "   "})),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        body,
        json!({
            "wireContractVersion": 1,
            "error": {
                "code": "invalid_request",
                "message": "body must contain 1..=10000 characters"
            }
        })
    );

    let (status, body) = request_json(
        &app,
        request(
            "POST",
            FOUNDATION_MESSAGE_PATH,
            Some(json!({"body": "valid", "unexpected": true})),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        body,
        json!({
            "wireContractVersion": 1,
            "error": {
                "code": "invalid_request",
                "message": "request body must match the wire contract"
            }
        })
    );
    assert_eq!(*store.create_calls.lock().unwrap(), 0);

    let accepted = "界".repeat(10_000);
    let (status, _) = request_json(
        &app,
        request(
            "POST",
            FOUNDATION_MESSAGE_PATH,
            Some(json!({"body": accepted})),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(*store.create_calls.lock().unwrap(), 1);

    let rejected = "界".repeat(10_001);
    let (status, body) = request_json(
        &app,
        request(
            "POST",
            FOUNDATION_MESSAGE_PATH,
            Some(json!({"body": rejected})),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        body,
        json!({
            "wireContractVersion": 1,
            "error": {
                "code": "invalid_request",
                "message": "body must contain 1..=10000 characters"
            }
        })
    );
    assert_eq!(*store.create_calls.lock().unwrap(), 1);
}

const DRIVER_DETAIL: &str = "fake driver detail must stay private";

#[derive(Debug, thiserror::Error)]
#[error("{DRIVER_DETAIL}")]
struct FakeDriverError;

#[derive(Clone)]
struct FailingStore;

impl MessageUnitOfWork for FailingStore {
    async fn create_message_with_event(
        &self,
        _body: String,
    ) -> Result<MessageCreatedFact, PersistenceFailure> {
        Err(PersistenceFailure::from_source(FakeDriverError))
    }
}

impl MessageReadUnitOfWork for FailingStore {
    async fn latest_page(&self) -> Result<MessagePageFact, PersistenceFailure> {
        Err(PersistenceFailure::from_source(FakeDriverError))
    }
}

#[tokio::test(flavor = "current_thread")]
async fn persistence_refusal_logs_one_complete_chain_and_returns_a_safe_500() {
    let logs = LogBuffer::default();
    let subscriber = tracing_subscriber::fmt()
        .json()
        .without_time()
        .with_target(false)
        .with_writer(logs.clone())
        .finish();
    let _guard = tracing::subscriber::set_default(subscriber);

    let app = http::router(FailingStore);
    let (status, body) = request_json(
        &app,
        request(
            "POST",
            FOUNDATION_MESSAGE_PATH,
            Some(json!({"body": "persist me"})),
        ),
    )
    .await;

    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(
        body,
        json!({
            "wireContractVersion": 1,
            "error": {"code": "internal", "message": "internal server error"}
        })
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
    assert_eq!(
        errors[0]["fields"]["error_chain"],
        format!("persistence operation failed: {DRIVER_DETAIL}")
    );
    assert!(!body.to_string().contains(DRIVER_DETAIL));
}

#[tokio::test]
async fn committed_fact_projects_to_the_exact_websocket_event() {
    let app = http::router(InMemoryStore::default());
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
    let (status, created) = request_json(
        &app,
        request(
            "POST",
            FOUNDATION_MESSAGE_PATH,
            Some(json!({"body": "websocket"})),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);

    let frame = tokio::time::timeout(std::time::Duration::from_secs(2), websocket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let WebSocketMessage::Text(payload) = frame else {
        panic!("expected a websocket text frame");
    };
    assert_eq!(
        serde_json::from_str::<Value>(&payload).unwrap(),
        json!({
            "type": "message_created",
            "wireContractVersion": 1,
            "message": created["message"]
        })
    );

    websocket.close(None).await.unwrap();
    let _ = shutdown_tx.send(());
    server.await.unwrap();
}

fn request(method: &str, path: &str, body: Option<Value>) -> Request<Body> {
    let mut builder = Request::builder().method(method).uri(path);
    let bytes = match body {
        Some(body) => {
            builder = builder.header("content-type", "application/json");
            serde_json::to_vec(&body).unwrap()
        }
        None => Vec::new(),
    };
    builder.body(Body::from(bytes)).unwrap()
}

async fn request_json(app: &Router, request: Request<Body>) -> (StatusCode, Value) {
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, serde_json::from_slice(&body).unwrap())
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
