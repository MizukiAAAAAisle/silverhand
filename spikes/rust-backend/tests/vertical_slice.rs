use std::time::Duration;

use futures_util::StreamExt;
use silverhand_rust_backend_spike::{
    adapters::sqlite::SqliteDatabase,
    composition,
    contracts::{CreateMessageResponse, ServerEvent},
};
use tempfile::tempdir;
use tokio::{net::TcpListener, sync::oneshot};
use tokio_tungstenite::{connect_async, tungstenite::Message};

#[tokio::test]
async fn committed_http_write_is_delivered_over_websocket() {
    let dir = tempdir().unwrap();
    let db = SqliteDatabase::open(dir.path().join("vertical-slice.db"))
        .await
        .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let server = tokio::spawn(async move {
        axum::serve(listener, composition::sqlite_router(db))
            .with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
            })
            .await
            .unwrap();
    });

    let (mut websocket, _) = connect_async(format!("ws://{address}/api/ws/events"))
        .await
        .unwrap();
    let response = reqwest::Client::new()
        .post(format!("http://{address}/api/messages"))
        .json(&serde_json::json!({"body": "hello from the vertical slice"}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json::<CreateMessageResponse>()
        .await
        .unwrap();

    let frame = tokio::time::timeout(Duration::from_secs(2), websocket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let Message::Text(json) = frame else {
        panic!("expected a text frame");
    };
    let event: ServerEvent = serde_json::from_str(&json).unwrap();
    assert_eq!(
        event,
        ServerEvent::MessageCreated {
            message: response.message,
        }
    );

    websocket.close(None).await.unwrap();
    let _ = shutdown_tx.send(());
    server.await.unwrap();
}
