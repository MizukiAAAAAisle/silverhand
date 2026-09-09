//! Isolated executable evidence: real sockets, real database and real exporter.
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};
use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest};

struct Process(Child);

impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn address() -> SocketAddr {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
}

fn command(root: &std::path::Path, api: SocketAddr, metrics: &str) -> Command {
    std::fs::create_dir_all(root.join("silverhand")).unwrap();
    std::fs::create_dir_all(root.join("tmp")).unwrap();

    let mut c = Command::new(env!("CARGO_BIN_EXE_silverhand-backend"));
    c.env_clear()
        .env("SILVERHAND_DIR", root.join("silverhand"))
        .env("TMPDIR", root.join("tmp"))
        .env("SILVERHAND_DATABASE_PATH", root.join("data/silverhand.db"))
        .env("SILVERHAND_BLOBS_ROOT", root.join("data/blobs"))
        .env("SILVERHAND_LOG_DIR", root.join("logs"))
        .env("SILVERHAND_LISTEN_ADDR", api.to_string())
        .env("SILVERHAND_ALLOWED_ORIGINS", "http://localhost")
        .env("SILVERHAND_DEPLOYMENT_PROFILE", "remote-only")
        .env("SILVERHAND_METRICS_LISTEN", metrics)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    c
}

fn console_command(root: &std::path::Path, api: SocketAddr, metrics: SocketAddr) -> Command {
    let mut process = command(root, api, &metrics.to_string());
    process.env(
        "SILVERHAND_CONSOLE_TOKEN",
        "01234567890123456789012345678901",
    );
    process
}

fn request(
    address: SocketAddr,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: &str,
) -> (u16, String) {
    let mut socket = TcpStream::connect_timeout(&address, Duration::from_secs(1)).unwrap();
    socket
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let auth = token
        .map(|token| format!("Authorization: Bearer {token}\r\n"))
        .unwrap_or_default();

    write!(
        socket,
        "{method} {path} HTTP/1.0\r\n\
         Host: localhost\r\nConnection: close\r\n\
         Content-Type: application/json\r\nContent-Length: {}\r\n{auth}\r\n{body}",
        body.len(),
    )
    .unwrap();

    let mut response = String::new();
    socket.read_to_string(&mut response).unwrap();
    let (head, body) = response.split_once("\r\n\r\n").expect("HTTP response");
    (
        head.split_whitespace().nth(1).unwrap().parse().unwrap(),
        body.into(),
    )
}

fn wait_ready(process: &mut Process, api: SocketAddr) {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        assert!(
            process.0.try_wait().unwrap().is_none(),
            "server exited during startup"
        );
        if TcpStream::connect(api).is_ok() && request(api, "GET", "/readyz", None, "").0 == 200 {
            return;
        }
        assert!(Instant::now() < deadline, "startup deadline");
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn metric_line<'a>(text: &'a str, name: &str, labels: &[&str]) -> &'a str {
    text.lines()
        .find(|line| line.starts_with(name) && labels.iter().all(|label| line.contains(label)))
        .unwrap_or_else(|| panic!("missing {name} {labels:?} in {text}"))
}

fn sample(text: &str, name: &str, labels: &[&str]) -> f64 {
    metric_line(text, name, labels)
        .split_whitespace()
        .last()
        .unwrap()
        .parse()
        .unwrap()
}

#[tokio::test]
async fn executable_metrics_preserve_wire_boundaries_and_track_real_work() {
    let root = tempfile::tempdir().unwrap();
    let api = address();
    let metrics = address();
    let mut process = Process(
        command(root.path(), api, &metrics.to_string())
            .spawn()
            .unwrap(),
    );
    wait_ready(&mut process, api);
    assert_eq!(request(api, "GET", "/metrics", None, "").0, 403);
    assert_eq!(request(api, "POST", "/metrics", None, "").0, 403);
    assert_eq!(request(metrics, "GET", "/readyz", None, "").0, 404);
    assert_eq!(request(metrics, "POST", "/metrics", None, "").0, 405);

    let signup_body = json!({
        "email": "metrics@example.com",
        "name": "metricsuser",
        "password": "test-metrics-password",
    });
    let (status, signup) = request(api, "POST", "/auth/signup", None, &signup_body.to_string());
    assert_eq!(status, 200, "{signup}");
    let user: Value = serde_json::from_str(&signup).unwrap();
    let token = user["user_token"].as_str().unwrap();
    assert_eq!(request(api, "GET", "/api/hosts", Some(token), "").0, 200);
    let (status, invite) = request(api, "POST", "/api/hosts", Some(token), "{}");
    assert_eq!(status, 200, "{invite}");
    let invite: Value = serde_json::from_str(&invite).unwrap();
    let host = invite["host_id"].as_str().unwrap();
    let secret = invite["connect_token"].as_str().unwrap();
    assert_eq!(
        request(api, "GET", &format!("/api/hosts/{host}"), Some(token), "").0,
        200
    );
    request(
        api,
        "GET",
        "/api/not-a-route/private-id-and-query?secret=never-metric",
        None,
        "",
    );

    let contract: Value = serde_json::from_str(include_str!(
        "../../../../packages/shared/src/daemon-admission.json"
    ))
    .unwrap();
    let version = contract["outboundProtocolVersion"].as_u64().unwrap();
    let path = contract["hostWebSocketPath"].as_str().unwrap();

    let mut ws_request = format!("ws://{api}{path}").into_client_request().unwrap();
    ws_request
        .headers_mut()
        .insert("authorization", format!("Bearer {secret}").parse().unwrap());
    let (mut ws, _) = tokio_tungstenite::connect_async(ws_request).await.unwrap();
    let incompatible_ready = json!({
        "direction": "daemon_to_server",
        "type": "event",
        "kind": "ready",
        "protocol_version": version - 1,
    });
    ws.send(Message::Text(incompatible_ready.to_string().into()))
        .await
        .unwrap();
    let close = tokio::time::timeout(Duration::from_secs(3), ws.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(matches!(close, Message::Close(_)));
    drop(ws);

    let mut text = String::new();
    for _ in 0..100 {
        text = request(metrics, "GET", "/metrics", None, "").1;
        if text.contains("silverhand_host_ws_closes_total{") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(text.contains("# TYPE silverhand_http_request_duration_seconds histogram"));
    assert!(text.contains("deployment_mode=\"standalone\""));
    assert_eq!(
        sample(
            &text,
            "silverhand_host_ws_protocol_mismatch_total{",
            &[&format!("actual_version=\"{}\"", version - 1)]
        ),
        1.
    );
    assert_eq!(
        sample(
            &text,
            "silverhand_host_ws_connections_current{",
            &["state=\"websocket_open\""]
        ),
        0.
    );
    assert_eq!(
        sample(
            &text,
            "silverhand_host_ws_closes_total{",
            &["reason=\"update_required\"", "code=\"1002\""]
        ),
        1.
    );
    assert!(
        sample(
            &text,
            "silverhand_db_statement_duration_seconds_count{",
            &[
                "query_name=\"hosts.list_for_user\"",
                "operation=\"all\"",
                "outcome=\"ok\""
            ]
        ) >= 1.
    );
    assert!(
        sample(
            &text,
            "silverhand_db_readiness_probe_duration_seconds_count{",
            &["outcome=\"ok\""]
        ) >= 1.
    );
    assert!(text.contains("route=\"unmatched\""));
    for secret_value in [
        host,
        secret,
        token,
        "private-id-and-query",
        "never-metric",
        "SELECT ",
        "nodejs_",
    ] {
        assert!(!text.contains(secret_value), "metric leaked {secret_value}");
    }
    assert!(text.contains("process_resident_memory_bytes"));
    assert!(text.contains("silverhand_tokio_scheduling_delay_seconds"));

    // Malformed ready versions share one bounded bucket and never create a
    // per-host admission failure. Unrelated frames must not enter that bucket.
    let versions = [
        Some(json!(-1)),
        Some(json!(10.5)),
        None,
        Some(json!(101)),
        Some(json!("unbounded-private-version")),
        Some(json!(null)),
    ];
    let mut expected_invalid = 0.;
    for (index, offered) in versions.into_iter().chain([Some(json!(7))]).enumerate() {
        let (status, invitation) = request(api, "POST", "/api/hosts", Some(token), "{}");
        assert_eq!(status, 200);
        let invitation: Value = serde_json::from_str(&invitation).unwrap();
        let case_host = invitation["host_id"].as_str().unwrap();
        let case_secret = invitation["connect_token"].as_str().unwrap();

        let mut frame = json!({
            "direction": "daemon_to_server",
            "type": "event",
            "kind": if index == 6 { "unknown_event" } else { "ready" },
        });
        if let Some(offered) = offered {
            frame["protocol_version"] = offered;
        }
        let mut upgrade = format!("ws://{api}{path}").into_client_request().unwrap();
        upgrade.headers_mut().insert(
            "authorization",
            format!("Bearer {case_secret}").parse().unwrap(),
        );
        let (mut socket, _) = tokio_tungstenite::connect_async(upgrade).await.unwrap();
        socket
            .send(Message::Text(frame.to_string().into()))
            .await
            .unwrap();

        let close = tokio::time::timeout(Duration::from_secs(3), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(
            matches!(close, Message::Close(_)),
            "case {index}: {close:?}"
        );
        drop(socket);

        if index < 6 {
            expected_invalid += 1.;
        }
        let scrape = request(metrics, "GET", "/metrics", None, "").1;
        assert_eq!(
            sample(
                &scrape,
                "silverhand_host_ws_protocol_mismatch_total{",
                &["actual_version=\"invalid\""]
            ),
            expected_invalid,
            "case {index}"
        );
        let mismatch_total: f64 = scrape
            .lines()
            .filter(|line| line.starts_with("silverhand_host_ws_protocol_mismatch_total{"))
            .map(|line| {
                line.split_whitespace()
                    .last()
                    .unwrap()
                    .parse::<f64>()
                    .unwrap()
            })
            .sum();
        assert_eq!(mismatch_total, expected_invalid + 1., "case {index}");
        assert!(!scrape.contains("unbounded-private-version"));

        let (status, state) = request(
            api,
            "GET",
            &format!("/api/hosts/{case_host}/status"),
            Some(token),
            "",
        );
        assert_eq!(status, 200, "{state}");
        let state: Value = serde_json::from_str(&state).unwrap();
        assert!(
            state.get("admission_failure").is_none(),
            "case {index}: {state}"
        );
    }

    let mut valid_request = format!("ws://{api}{path}").into_client_request().unwrap();
    valid_request
        .headers_mut()
        .insert("authorization", format!("Bearer {secret}").parse().unwrap());
    let (mut valid_ws, _) = tokio_tungstenite::connect_async(valid_request)
        .await
        .unwrap();
    let valid_ready = json!({
        "direction": "daemon_to_server",
        "type": "event",
        "kind": "ready",
        "protocol_version": version,
        "daemon_version": "metrics-test",
        "daemon_id": "private-daemon",
        "instance_id": "metrics-instance",
        "host_descriptor": {"name": "Private host", "kind": "remote"},
        "capabilities": [],
        "daemon_pid": 42,
        "started_at": 100,
    });
    valid_ws
        .send(Message::Text(valid_ready.to_string().into()))
        .await
        .unwrap();

    for attempt in 0..100 {
        text = request(metrics, "GET", "/metrics", None, "").1;
        if sample(
            &text,
            "silverhand_host_ws_ready_connections_current{",
            &[&format!("protocol_version=\"{version}\"")],
        ) == 1.
        {
            break;
        }
        assert!(attempt < 99, "ready gauge did not increment");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    valid_ws.close(None).await.unwrap();
    drop(valid_ws);
    for attempt in 0..100 {
        text = request(metrics, "GET", "/metrics", None, "").1;
        if sample(
            &text,
            "silverhand_host_ws_connections_current{",
            &["state=\"websocket_open\""],
        ) == 0.
        {
            break;
        }
        assert!(attempt < 99, "socket gauge did not decrement");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(
        sample(
            &text,
            "silverhand_host_ws_ready_connections_current{",
            &[&format!("protocol_version=\"{version}\"")]
        ),
        0.
    );

    #[cfg(unix)]
    {
        assert!(
            Command::new("kill")
                .args(["-TERM", &process.0.id().to_string()])
                .status()
                .unwrap()
                .success()
        );
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(status) = process.0.try_wait().unwrap() {
                assert!(status.success());
                break;
            }
            assert!(Instant::now() < deadline, "SIGTERM did not stop process");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(TcpListener::bind(api).is_ok());
        assert!(TcpListener::bind(metrics).is_ok());
    }
}

#[test]
fn invalid_or_occupied_metrics_listener_refuses_before_database_creation() {
    for invalid in [
        "0.0.0.0:9464",
        "[::]:9464",
        "localhost:9464",
        "not-an-address",
    ] {
        let root = tempfile::tempdir().unwrap();
        let status = command(root.path(), address(), invalid).status().unwrap();
        assert!(!status.success());
        assert!(!root.path().join("data/silverhand.db").exists());
    }
    let root = tempfile::tempdir().unwrap();
    let occupied = TcpListener::bind("127.0.0.1:0").unwrap();
    assert!(
        !command(
            root.path(),
            address(),
            &occupied.local_addr().unwrap().to_string()
        )
        .status()
        .unwrap()
        .success()
    );
    assert!(!root.path().join("data/silverhand.db").exists());
}

#[test]
fn disabled_metrics_still_refuses_public_metrics() {
    let root = tempfile::tempdir().unwrap();
    let api = address();
    let mut process = Process(command(root.path(), api, "").spawn().unwrap());
    wait_ready(&mut process, api);
    assert_eq!(request(api, "GET", "/metrics", None, "").0, 403);
}

#[test]
fn executable_console_uses_product_listener_with_its_own_token_gate() {
    let root = tempfile::tempdir().unwrap();
    let api = address();
    let metrics = address();
    let token = "01234567890123456789012345678901";
    let mut process = Process(console_command(root.path(), api, metrics).spawn().unwrap());
    wait_ready(&mut process, api);

    assert_eq!(request(api, "GET", "/console", None, "").0, 200);
    assert_eq!(request(metrics, "GET", "/console", None, "").0, 404);
    assert_eq!(
        request(api, "GET", "/console/api/overview", None, "").0,
        401
    );
    assert_eq!(
        request(api, "GET", "/console/api/overview", Some("wrong-token"), "").0,
        401
    );

    let email = "console-source@example.com";
    let signup_body = json!({
        "email": email,
        "name": "consoleuser",
        "password": "test-console-password",
    });
    assert_eq!(
        request(api, "POST", "/auth/signup", None, &signup_body.to_string()).0,
        200
    );

    let (status, body) = request(api, "GET", "/console/api/overview", Some(token), "");
    assert_eq!(status, 200, "{body}");
    let overview: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(overview["totals"]["users"], 1);
    assert_eq!(overview["time_zone"], "Asia/Shanghai");
    assert_eq!(overview["daily_activity"].as_array().unwrap().len(), 30);
    assert!(overview.get("release_telemetry").is_none());

    for source in [email, "consoleuser", "test-console-password", token] {
        assert!(!body.contains(source), "console response leaked {source}");
    }
    assert_eq!(request(metrics, "GET", "/metrics", None, "").0, 200);
    assert_eq!(request(api, "GET", "/metrics", Some(token), "").0, 403);
    for path in ["/console/api/users", "/console/api/users/unknown"] {
        assert_eq!(request(api, "GET", path, None, "").0, 401);
        assert_eq!(request(metrics, "GET", path, Some(token), "").0, 404);
    }
    assert_eq!(
        request(api, "GET", "/console/api/users", Some(token), "").0,
        200
    );
    assert_eq!(
        request(api, "GET", "/console/api/users/unknown", Some(token), "").0,
        404
    );
}

#[test]
fn invalid_console_configuration_refuses_before_database_creation() {
    for (metrics, token) in [
        (String::new(), "too-short"),
        (address().to_string(), "too-short"),
    ] {
        let root = tempfile::tempdir().unwrap();
        let status = command(root.path(), address(), &metrics)
            .env("SILVERHAND_CONSOLE_TOKEN", token)
            .status()
            .unwrap();

        assert!(!status.success());
        assert!(!root.path().join("data/silverhand.db").exists());
    }
}

#[test]
fn console_is_opt_in_and_independent_of_metrics() {
    let root = tempfile::tempdir().unwrap();
    let api = address();
    let token = "01234567890123456789012345678901";
    let mut process = Process(
        command(root.path(), api, "")
            .env("SILVERHAND_CONSOLE_TOKEN", token)
            .spawn()
            .unwrap(),
    );
    wait_ready(&mut process, api);
    assert_eq!(request(api, "GET", "/console", None, "").0, 200);
    assert_eq!(
        request(api, "GET", "/console/api/overview", Some(token), "").0,
        200
    );
    assert_eq!(request(api, "GET", "/metrics", None, "").0, 403);

    let disabled = tempfile::tempdir().unwrap();
    let disabled_api = address();
    let mut disabled_process = Process(command(disabled.path(), disabled_api, "").spawn().unwrap());
    wait_ready(&mut disabled_process, disabled_api);
    for path in [
        "/console",
        "/console/api/overview",
        "/console/api/users",
        "/console/api/users/any",
    ] {
        assert_eq!(request(disabled_api, "GET", path, Some(token), "").0, 404);
    }
}

#[test]
fn console_refuses_embedded_profile_even_with_a_valid_token() {
    let root = tempfile::tempdir().unwrap();
    let status = command(root.path(), address(), "")
        .env("SILVERHAND_DEPLOYMENT_PROFILE", "embedded")
        .env(
            "SILVERHAND_CONSOLE_TOKEN",
            "01234567890123456789012345678901",
        )
        .status()
        .unwrap();
    assert!(!status.success());
    assert!(!root.path().join("data/silverhand.db").exists());
}
