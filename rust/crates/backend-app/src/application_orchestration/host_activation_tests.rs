//! Real invite/daemon/detail/finalize path, including durable failure and cancellation.
use super::*;
use futures_util::{FutureExt, SinkExt, StreamExt};

type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn ready_socket(address: std::net::SocketAddr, token: &str, version: u32) -> Socket {
    let mut request = format!("ws://{address}{HOST_WEBSOCKET_PATH}")
        .into_client_request()
        .unwrap();
    request.headers_mut().insert(
        tokio_tungstenite::tungstenite::http::header::AUTHORIZATION,
        format!("Bearer {token}").parse().unwrap(),
    );
    let (mut socket, _) = connect_async(request).await.unwrap();
    socket
        .send(ClientMessage::Text(
            serde_json::json!({
                "direction":"daemon_to_server", "type":"event", "kind":"ready",
                "protocol_version":version, "daemon_version":"test",
                "daemon_id":"activation-test", "instance_id":"activation-instance",
                "host_descriptor":{"name":"Test computer", "kind":"remote"},
                "capabilities":[], "daemon_pid":7, "started_at":100
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();
    socket
}

async fn reply_empty_runtimes(socket: &mut Socket) {
    let command = next_daemon_json(socket).await;
    assert_eq!(command["kind"], "runtime_status");
    socket
        .send(ClientMessage::Text(
            serde_json::json!({
                "direction":"daemon_to_server", "type":"command_response", "id":command["id"],
                "kind":"runtime_status", "result":{"runtimes":[]}
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();
}

async fn reply_host_status(socket: &mut Socket) {
    let command = next_daemon_json(socket).await;
    assert_eq!(command["kind"], "host_status");
    socket
        .send(ClientMessage::Text(
            serde_json::json!({
                "direction":"daemon_to_server", "type":"command_response", "id":command["id"],
                "kind":"host_status", "result":{"os":"linux", "daemon_pid":7,
                "daemon_version":"test", "started_at":100,"uptime_ms":0,"active_agent_ids":[]}
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();
}

async fn detail(router: &Router, bearer: &str, host: &str) -> serde_json::Value {
    let (status, body) = request(router, "GET", &format!("/api/hosts/{host}"), Some(bearer)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    serde_json::from_str::<serde_json::Value>(&body).unwrap()["host"].clone()
}

async fn exercise_invite(mode: &str) {
    let fixture = fixture(true).await;
    seed_human(&fixture.path).await;
    let app = prepare(&remote_config(fixture.path.clone())).await.unwrap();
    let router = app.router.clone();
    let bearer = format!("Bearer {TOKEN}");
    let (status, body) = json_request_with_body(
        &router,
        "POST",
        "/api/hosts",
        Some(&bearer),
        Body::from("{}"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let invite: serde_json::Value = serde_json::from_str(&body).unwrap();
    let host = invite["host_id"].as_str().unwrap();
    let token = invite["connect_token"].as_str().unwrap();
    assert_eq!(detail(&router, &bearer, host).await["status"], "pending");
    let pool = SqlitePoolOptions::new()
        .connect(fixture.path.to_str().unwrap())
        .await
        .unwrap();
    if mode == "failure" {
        sqlx::raw_sql("CREATE TRIGGER reject_activation BEFORE UPDATE OF activated_at ON hosts BEGIN SELECT RAISE(ABORT, 'isolated activation fault'); END;")
            .execute(&pool).await.unwrap();
    }
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    let running = tokio::spawn(serve(listener, app, shutdown_rx));

    let outcome = std::panic::AssertUnwindSafe(async {
        tokio::time::timeout(std::time::Duration::from_secs(15), async {
            let version = if mode == "incompatible" {
                OUTBOUND_PROTOCOL_VERSION - 1
            } else {
                OUTBOUND_PROTOCOL_VERSION
            };
            let mut socket = ready_socket(address, token, version).await;
            if mode == "incompatible" {
                let frame = socket.next().await.unwrap().unwrap();
                assert!(matches!(frame, ClientMessage::Close(_)));
                let state = detail(&router, &bearer, host).await;
                assert_eq!(state["status"], "pending");
                assert!(state["activated_at"].is_null());
                return;
            }
            if mode == "cancel" {
                // Revoke while hydration is outstanding: no activation can follow.
                let (status, body) = request(
                    &router,
                    "DELETE",
                    &format!("/api/hosts/{host}"),
                    Some(&bearer),
                )
                .await;
                assert_eq!(status, StatusCode::OK, "{body}");
                let (status, _) = request(
                    &router,
                    "GET",
                    "/api/hosts/connect-token/resolve",
                    Some(&format!("Bearer {token}")),
                )
                .await;
                assert_eq!(status, StatusCode::UNAUTHORIZED);
                while let Some(frame) = socket.next().await {
                    if let ClientMessage::Close(Some(close)) = frame.unwrap() {
                        assert_eq!(close.reason, "host_revoked");
                        break;
                    }
                }
                let activated: Option<i64> =
                    sqlx::query_scalar("SELECT activated_at FROM hosts WHERE id=?")
                        .bind(host)
                        .fetch_optional(&pool)
                        .await
                        .unwrap()
                        .flatten();
                assert_eq!(activated, None);
                return;
            }
            reply_empty_runtimes(&mut socket).await;
            if mode == "failure" {
                let frame = socket.next().await.unwrap().unwrap();
                let ClientMessage::Close(Some(close)) = frame else {
                    panic!("{frame:?}")
                };
                assert_eq!(close.reason, "host_activation_failed");
                let state = detail(&router, &bearer, host).await;
                assert_eq!(state["status"], "pending");
                assert!(state["connected_host_name"].is_null());
                return;
            }
            reply_host_status(&mut socket).await;
            let attached = detail(&router, &bearer, host).await;
            assert_eq!(attached["status"], "attached");
            assert!(attached["activated_at"].is_number());
            assert!(attached["finalized_at"].is_null());
            let (status, body) = json_request_with_body(
                &router,
                "PATCH",
                &format!("/api/hosts/{host}"),
                Some(&bearer),
                Body::from(r#"{"display_label":"My remote"}"#),
            )
            .await;
            assert_eq!(status, StatusCode::OK, "{body}");
            let active = detail(&router, &bearer, host).await;
            assert_eq!(active["status"], "active");
            let (_, listed) = request(&router, "GET", "/api/hosts", Some(&bearer)).await;
            assert!(
                serde_json::from_str::<serde_json::Value>(&listed).unwrap()["hosts"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|h| h["id"] == host && h["status"] == "active")
            );

            socket.close(None).await.unwrap();
            // Wait for registry cleanup, not an arbitrary delay, before redialing.
            loop {
                if detail(&router, &bearer, host).await["connected_host_name"].is_null() {
                    break;
                }
                tokio::task::yield_now().await;
            }
            let mut replacement = ready_socket(address, token, OUTBOUND_PROTOCOL_VERSION).await;
            reply_empty_runtimes(&mut replacement).await;
            reply_host_status(&mut replacement).await;
            let reconnected = detail(&router, &bearer, host).await;
            assert_eq!(reconnected["status"], "active");
            assert_eq!(reconnected["activated_at"], active["activated_at"]);
            assert_eq!(reconnected["finalized_at"], active["finalized_at"]);
            replacement.close(None).await.unwrap();
        })
        .await
        .expect("isolated activation flow timed out");
    })
    .catch_unwind()
    .await;

    let _ = shutdown_tx.send(());
    let _ = tokio::time::timeout(std::time::Duration::from_secs(5), running)
        .await
        .unwrap();
    pool.close().await;
    if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
    }
}

#[tokio::test]
async fn invite_attaches_then_finalizes_and_reconnect_preserves_lifecycle() {
    exercise_invite("success").await;
}
#[tokio::test]
async fn activation_persistence_failure_never_announces_attachment() {
    exercise_invite("failure").await;
}
#[tokio::test]
async fn cancelling_pending_invite_revokes_socket_and_cannot_activate() {
    exercise_invite("cancel").await;
}

#[tokio::test]
async fn incompatible_ready_cannot_activate_invite() {
    exercise_invite("incompatible").await;
}
