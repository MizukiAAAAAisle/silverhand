//! Item 2 of the infra prototype: one representative error path from the
//! application layer out to the HTTP adapter.
//!
//! Two halves, and both have to hold at once:
//!
//! * **Status stays out of the inner layers.** The application error carries no
//!   code; the boundary chooses 500. Proved by the fact that this test can
//!   construct the inner error without naming a status at all.
//! * **The infra cause is not lost.** The driver-level message survives as a
//!   source all the way to the boundary that renders it — while never appearing
//!   in the response body.
//!
//! Before this prototype the crate did the opposite: it logged the driver error
//! inside the adapter and then discarded it, so the boundary had a status but no
//! cause. That is the shape the review gate forbids.

use std::time::Duration;

use silverhand_rust_backend_spike::{
    application::{CreateMessageError, MessageCreatedFact, MessageUnitOfWork, PersistenceFailure},
    http,
    infra::error,
};
use tokio::{net::TcpListener, sync::oneshot};

const DRIVER_DETAIL: &str = "no such table: messages (driver detail)";

#[derive(Debug, thiserror::Error)]
#[error("{DRIVER_DETAIL}")]
struct FakeDriverError;

/// Fails the way a real adapter fails: hand the cause over instead of logging it
/// and dropping it.
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

#[test]
fn infra_cause_survives_every_inner_layer() {
    let inner: CreateMessageError = PersistenceFailure::from_source(FakeDriverError).into();

    assert_eq!(
        error::chain(&inner),
        vec![
            "persistence operation failed".to_owned(),
            DRIVER_DETAIL.to_owned(),
        ]
    );
    assert_eq!(error::root_cause(&inner), DRIVER_DETAIL);
    assert!(error::describe(&inner).contains(DRIVER_DETAIL));
}

#[tokio::test]
async fn boundary_renders_a_status_without_leaking_the_cause() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let server = tokio::spawn(async move {
        axum::serve(listener, http::router(FailingStore))
            .with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
            })
            .await
            .unwrap();
    });

    let response = tokio::time::timeout(
        Duration::from_secs(5),
        reqwest::Client::new()
            .post(format!("http://{address}/api/messages"))
            .json(&serde_json::json!({"body": "will fail in persistence"}))
            .send(),
    )
    .await
    .unwrap()
    .unwrap();

    assert_eq!(response.status().as_u16(), 500);
    let body = response.text().await.unwrap();
    assert_eq!(body, r#"{"error":"internal server error"}"#);
    assert!(
        !body.contains("driver detail") && !body.contains("no such table"),
        "the response body leaked an infra cause: {body}"
    );

    let _ = shutdown_tx.send(());
    server.await.unwrap();
}

#[tokio::test]
async fn validation_refusal_uses_its_own_status_and_says_why() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let server = tokio::spawn(async move {
        axum::serve(listener, http::router(FailingStore))
            .with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
            })
            .await
            .unwrap();
    });

    let response = tokio::time::timeout(
        Duration::from_secs(5),
        reqwest::Client::new()
            .post(format!("http://{address}/api/messages"))
            .json(&serde_json::json!({"body": "   "}))
            .send(),
    )
    .await
    .unwrap()
    .unwrap();

    assert_eq!(response.status().as_u16(), 422);

    let _ = shutdown_tx.send(());
    server.await.unwrap();
}

/// The inner layers must not name a status code at all — that is what makes the
/// mapping single-directional.
#[test]
fn inner_layers_name_no_status_code() {
    use std::{fs, path::Path};

    let crate_root = Path::new(env!("CARGO_MANIFEST_DIR"));
    for relative in ["src/application.rs", "src/infra/error.rs"] {
        let source = fs::read_to_string(crate_root.join(relative)).unwrap();
        let normalized = source.to_ascii_lowercase();
        for marker in ["statuscode", "status_code", "http", "into_response", "500"] {
            assert!(
                !normalized.contains(marker),
                "{relative} names transport concern {marker:?}"
            );
        }
    }
}
