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
    assert!(
        path.starts_with('/'),
        "daemon WebSocket path must be absolute"
    );
    let rendered = format!(
        "pub const HOST_PROTOCOL_VERSION: u32 = {host_protocol};\n\
         pub const OUTBOUND_PROTOCOL_VERSION: u32 = {outbound_protocol};\n\
         pub const HOST_WEBSOCKET_PATH: &str = {path};\n\
         pub const UPDATE_REQUIRED_CLOSE_REASON: &str = {update_required};\n",
        path = serde_json::to_string(path).expect("quote daemon WebSocket path"),
        update_required =
            serde_json::to_string(update_required).expect("quote daemon update-required reason"),
    );
    let output = PathBuf::from(env::var_os("OUT_DIR").expect("build output directory"))
        .join("daemon_admission.rs");
    fs::write(output, rendered).expect("write generated daemon admission constants");
}
