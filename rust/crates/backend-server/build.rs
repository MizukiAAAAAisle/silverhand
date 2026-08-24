use std::{env, fs, path::PathBuf};

use serde_json::{Map, Value};

fn required_u32(record: &Map<String, Value>, field: &str) -> u32 {
    record
        .get(field)
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .filter(|value| *value > 0)
        .unwrap_or_else(|| panic!("backend admission field {field} must be a positive u32"))
}

fn required_string<'a>(record: &'a Map<String, Value>, field: &str) -> &'a str {
    record
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| panic!("backend admission field {field} must be a non-empty string"))
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

    let current = required_u32(&record, "desktopApi");
    let minimum_client = required_u32(&record, "desktopMinClient");
    let minimum_server = required_u32(&record, "desktopMinServer");
    assert!(
        minimum_client <= current && minimum_server <= current,
        "desktop admission minima must not exceed the current epoch"
    );
    let path = required_string(&record, "eventWebSocketPath");
    assert!(
        path.starts_with('/'),
        "event WebSocket path must be absolute"
    );
    let cookie = required_string(&record, "eventWebSocketSessionCookie");
    let header = required_string(&record, "desktopApiEpochHeader");
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
}
