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
    let mut c = Command::new(env!("CARGO_BIN_EXE_silverhand-backend"));
    c.env_clear()
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

    let mut valid_request = format!("ws://{api}{path}").into_client_request().unwrap();
    valid_request
        .headers_mut()
        .insert("authorization", format!("Bearer {secret}").parse().unwrap());
    let (mut valid_ws, _) = tokio_tungstenite::connect_async(valid_request)
        .await
        .unwrap();
    valid_ws.send(Message::Text(json!({
        "direction":"daemon_to_server", "type":"event", "kind":"ready", "protocol_version":version,
        "daemon_version":"metrics-test", "daemon_id":"private-daemon", "instance_id":"metrics-instance",
        "host_descriptor":{"name":"Private host","kind":"remote"}, "capabilities":[], "daemon_pid":42, "started_at":100
    }).to_string().into())).await.unwrap();
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
