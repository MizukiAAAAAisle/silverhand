//! Real remote-only composition: boot readiness is installation, not daemon attachment.
use super::*;
use futures_util::FutureExt;

#[tokio::test]
async fn remote_ready_without_daemon_and_real_runtime_event_reaches_authenticated_viewer() {
    let fixture = fixture(true).await;
    seed_human(&fixture.path).await;
    seed_workspace_conversation(&fixture.path).await;
    seed_runtime_agent(&fixture.path, "agent-1").await;
    let pool = SqlitePoolOptions::new()
        .connect(fixture.path.to_str().unwrap())
        .await
        .unwrap();
    sqlx::query("UPDATE hosts SET activated_at=1,finalized_at=1 WHERE id='h-registry-probe'")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO conversation_agents(conversation_id,agent_id,joined_at) VALUES(?,'agent-1',1)",
    )
    .bind(CONVERSATION_ID)
    .execute(&pool)
    .await
    .unwrap();
    let app = prepare(&remote_config(fixture.path.clone())).await.unwrap();
    let router = app.router.clone();
    let (before_status, before_body) = request(&router, "GET", "/readyz", None).await;
    assert_eq!(before_status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&before_body).unwrap()["checks"]["listen_ready"],
        false
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    let running = tokio::spawn(serve(listener, app, shutdown_rx));
    // Always reclaim the served app and pool, even if a wire assertion fails.
    let outcome = std::panic::AssertUnwindSafe(async {
        tokio::time::timeout(std::time::Duration::from_secs(15), async {
            let no_daemon_ready = http_over_tcp(address, "GET", "/readyz", None, "").await;
            let mut viewer_request = format!("ws://{address}{EVENT_WEBSOCKET_PATH}").into_client_request().unwrap();
            viewer_request.headers_mut().insert(ORIGIN, "http://localhost:5173".parse().unwrap());
            viewer_request.headers_mut().insert(COOKIE, format!("{EVENT_WS_SESSION_COOKIE}={TOKEN}").parse().unwrap());
            viewer_request.headers_mut().insert(DESKTOP_API_EPOCH_HEADER, MINIMUM_CLIENT_API_EPOCH.into());
            let (mut viewer, _) = connect_async(viewer_request).await.unwrap();
            assert_eq!(next_socket_json(&mut viewer).await["type"], "authenticated");
            viewer.send(ClientMessage::Text(serde_json::json!({
                "type":"subscribe", "scope":format!("conversation-side:{CONVERSATION_ID}")
            }).to_string().into())).await.unwrap();
            assert_eq!(next_socket_json(&mut viewer).await["type"], "subscribed");

            let mut daemon_request = format!("ws://{address}{HOST_WEBSOCKET_PATH}").into_client_request().unwrap();
            daemon_request.headers_mut().insert(tokio_tungstenite::tungstenite::http::header::AUTHORIZATION,
                format!("Bearer {HOST_TOKEN}").parse().unwrap());
            let (mut daemon, _) = connect_async(daemon_request).await.unwrap();
            daemon.send(ClientMessage::Text(serde_json::json!({
                "direction":"daemon_to_server", "type":"event", "kind":"ready",
                "protocol_version":OUTBOUND_PROTOCOL_VERSION, "daemon_version":"test",
                "daemon_id":"daemon-remote-fanout", "instance_id":"instance-remote-fanout",
                "host_descriptor":{"name":"Remote fanout test", "kind":"remote"},
                "capabilities":[], "daemon_pid":7, "started_at":100
            }).to_string().into())).await.unwrap();
            // Fully answer attachment/hydration before asking the public start route.
            for expected in ["runtime_status", "host_status"] {
                let command = next_daemon_json(&mut daemon).await;
                assert_eq!(command["kind"], expected);
                let result = if expected == "runtime_status" { serde_json::json!({"runtimes":[]}) }
                    else { serde_json::json!({"os":"linux", "daemon_pid":7, "daemon_version":"test", "started_at":100, "uptime_ms":0, "active_agent_ids":[]}) };
                daemon.send(ClientMessage::Text(serde_json::json!({
                    "direction":"daemon_to_server", "type":"command_response", "id":command["id"], "kind":command["kind"], "result":result
                }).to_string().into())).await.unwrap();
            }
            let start_path = format!("/api/channels/{CONVERSATION_ID}/agents/agent-1/start");
            let authorization = format!("Bearer {TOKEN}");
            let start = http_over_tcp(address, "POST", &start_path, Some(&authorization), "");
            let answer = async {
                loop {
                    let command = next_daemon_json(&mut daemon).await;
                    let kind = command["kind"].as_str().unwrap();
                    let result = match kind {
                        "host_runtime_catalog" => serde_json::json!({"runtimes":[],"detected_at":100}),
                        "runtime_start" => serde_json::json!({"started":true,"pid":7,"started_at":100}),
                        _ => panic!("unexpected command: {command}"),
                    };
                    daemon.send(ClientMessage::Text(serde_json::json!({
                        "direction":"daemon_to_server", "type":"command_response", "id":command["id"], "kind":command["kind"], "result":result
                    }).to_string().into())).await.unwrap();
                    if kind == "runtime_start" { break command["params"]["runtime_generation"].as_i64().unwrap(); }
                }
            };
            let (start_response, generation) = tokio::join!(start, answer);
            assert!(start_response.starts_with("HTTP/1.1 200"), "{start_response}");
            assert_eq!(serde_json::from_str::<serde_json::Value>(start_response.split("\r\n\r\n").nth(1).unwrap()).unwrap(), serde_json::json!({"ok":true}));
            assert!(generation > 0, "use the generation assigned by the real start command");
            daemon.send(ClientMessage::Text(serde_json::json!({
                "direction":"daemon_to_server", "type":"event", "kind":"runtime_parsed_event",
                "runtime_scope":{"kind":"agent","agent_id":"agent-1"},
                "conversation_id":CONVERSATION_ID, "agent_id":"agent-1", "runtime_generation":generation,
                "parsed":{"kind":"thinking","text":"remote fanout proof"}, "ts":101
            }).to_string().into())).await.unwrap();
            let projected = loop {
                let frame = next_socket_json(&mut viewer).await;
                if frame["kind"] == "conversation_activity" { break frame; }
            };
            assert_eq!(projected["scope"], format!("conversation-side:{CONVERSATION_ID}"));
            let durable: String = sqlx::query_scalar("SELECT payload FROM conversation_events WHERE conversation_id=? AND agent_id='agent-1' AND kind='thinking'")
                .bind(CONVERSATION_ID).fetch_one(&pool).await.unwrap();
            let durable_payload: serde_json::Value = serde_json::from_str(&durable).unwrap();
            assert_eq!(durable_payload, serde_json::json!({"text":"remote fanout proof"}));
            assert_eq!(projected["type"], "event");
            assert_eq!(projected["payload"]["agent_id"], "agent-1");
            assert_eq!(projected["payload"]["conversation_id"], CONVERSATION_ID);
            assert_eq!(projected["payload"]["kind"], "thinking");
            assert_eq!(projected["payload"]["created_at"], 101);
            assert_eq!(projected["payload"]["payload"], durable_payload);
            println!("remote production daemon→durable→authenticated event WS PASS; generation={generation}, durable={durable}, projected={projected}; pre-attachment readiness: {no_daemon_ready}");
            viewer.close(None).await.unwrap();
            daemon.close(None).await.unwrap();
            assert!(no_daemon_ready.starts_with("HTTP/1.1 200"), "{no_daemon_ready}");
            assert!(no_daemon_ready.contains("\"outbound_event_fanout_installed\":true"));
        }).await.expect("remote production composition must complete within deadline");
    }).catch_unwind().await;
    let _ = shutdown_tx.send(());
    tokio::time::timeout(std::time::Duration::from_secs(5), running)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    pool.close().await;
    if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
    }
}
