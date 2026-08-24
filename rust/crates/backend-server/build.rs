use std::{env, fs, path::PathBuf};

use serde_json::{Map, Value};

fn required_u32(record: &Map<String, Value>, authority: &str, field: &str) -> u32 {
    record
        .get(field)
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .filter(|value| *value > 0)
        .unwrap_or_else(|| panic!("{authority} field {field} must be a positive u32"))
}

fn required_string<'a>(record: &'a Map<String, Value>, authority: &str, field: &str) -> &'a str {
    record
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| panic!("{authority} field {field} must be a non-empty string"))
}

fn required_event_kinds(record: &Map<String, Value>) -> Vec<&str> {
    let kinds = record
        .get("daemonEventKinds")
        .and_then(Value::as_object)
        .expect("daemon admission field daemonEventKinds must be an object");
    assert_eq!(
        kinds.len(),
        18,
        "daemon event catalogue must contain 18 arms"
    );
    let mut values = kinds
        .values()
        .map(|value| {
            value
                .as_str()
                .filter(|value| !value.is_empty())
                .expect("daemon event kind must be a non-empty string")
        })
        .collect::<Vec<_>>();
    values.sort_unstable();
    values.dedup();
    assert_eq!(values.len(), 18, "daemon event kinds must be unique");
    values
}

fn main() {
    let manifest = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("manifest directory"));
    let contract = manifest.join("../../../packages/shared/src/backend-admission.json");
    println!("cargo:rerun-if-changed={}", contract.display());
    let source = fs::read_to_string(&contract).expect("read backend admission contract");
    let record = serde_json::from_str::<Value>(&source)
        .expect("parse backend admission contract")
        .as_object()
        .cloned()
        .expect("backend admission contract must be an object");

    let current = required_u32(&record, "backend admission", "desktopApi");
    let minimum_client = required_u32(&record, "backend admission", "desktopMinClient");
    let minimum_server = required_u32(&record, "backend admission", "desktopMinServer");
    assert!(
        minimum_client <= current && minimum_server <= current,
        "desktop admission minima must not exceed the current epoch"
    );
    let path = required_string(&record, "backend admission", "eventWebSocketPath");
    assert!(
        path.starts_with('/'),
        "event WebSocket path must be absolute"
    );
    let cookie = required_string(&record, "backend admission", "eventWebSocketSessionCookie");
    let header = required_string(&record, "backend admission", "desktopApiEpochHeader");
    let rendered = format!(
        "pub const EVENT_WEBSOCKET_PATH: &str = {path};\n\
         pub const EVENT_WS_SESSION_COOKIE: &str = {cookie};\n\
         pub const DESKTOP_API_EPOCH_HEADER: &str = {header};\n\
         pub const DESKTOP_SERVER_API_EPOCH: u32 = {current};\n\
         pub const MINIMUM_CLIENT_API_EPOCH: u32 = {minimum_client};\n",
        path = serde_json::to_string(path).expect("quote WebSocket path"),
        cookie = serde_json::to_string(cookie).expect("quote session cookie"),
        header = serde_json::to_string(header).expect("quote epoch header"),
    );
    let output = PathBuf::from(env::var_os("OUT_DIR").expect("build output directory"))
        .join("backend_admission.rs");
    fs::write(output, rendered).expect("write generated backend admission constants");

    let daemon_contract = manifest.join("../../../packages/shared/src/daemon-admission.json");
    println!("cargo:rerun-if-changed={}", daemon_contract.display());
    let source = fs::read_to_string(&daemon_contract).expect("read daemon admission contract");
    let record = serde_json::from_str::<Value>(&source)
        .expect("parse daemon admission contract")
        .as_object()
        .cloned()
        .expect("daemon admission contract must be an object");
    let host_protocol = required_u32(&record, "daemon admission", "hostProtocolVersion");
    let outbound_protocol = required_u32(&record, "daemon admission", "outboundProtocolVersion");
    let path = required_string(&record, "daemon admission", "hostWebSocketPath");
    let update_required = required_string(&record, "daemon admission", "updateRequiredCloseReason");
    let event_kinds = required_event_kinds(&record);
    assert!(
        path.starts_with('/'),
        "daemon WebSocket path must be absolute"
    );
    let rendered_kinds = event_kinds
        .iter()
        .map(|kind| serde_json::to_string(kind).expect("quote daemon event kind"))
        .collect::<Vec<_>>()
        .join(", ");
    let rendered = format!(
        "pub const HOST_PROTOCOL_VERSION: u32 = {host_protocol};\n\
         pub const OUTBOUND_PROTOCOL_VERSION: u32 = {outbound_protocol};\n\
         pub const HOST_WEBSOCKET_PATH: &str = {path};\n\
         pub const UPDATE_REQUIRED_CLOSE_REASON: &str = {update_required};\n\
         pub const OUTBOUND_DAEMON_EVENT_KINDS: [&str; 18] = [{rendered_kinds}];\n",
        path = serde_json::to_string(path).expect("quote daemon WebSocket path"),
        update_required =
            serde_json::to_string(update_required).expect("quote daemon update-required reason"),
    );
    let output = PathBuf::from(env::var_os("OUT_DIR").expect("build output directory"))
        .join("daemon_admission.rs");
    fs::write(output, rendered).expect("write generated daemon admission constants");
}
