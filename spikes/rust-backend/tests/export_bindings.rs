use silverhand_rust_backend_spike::contracts::{
    CREATE_MESSAGE_PATH, CreateMessageRequest, CreateMessageResponse, EVENT_WEBSOCKET_PATH,
    MessageDto, ServerEvent, WIRE_CONTRACT_VERSION,
};
use std::{fs, path::Path};
use ts_rs::{Config, TS};

/// This is the complete export manifest. A Rust type is not a frontend wire
/// contract merely because it derives `TS`; it must be named here as well.
#[test]
fn export_wire_contract_manifest() {
    let output = concat!(env!("CARGO_MANIFEST_DIR"), "/bindings");
    let config = Config::default().with_out_dir(output);

    CreateMessageRequest::export_all(&config).unwrap();
    CreateMessageResponse::export_all(&config).unwrap();
    MessageDto::export_all(&config).unwrap();
    ServerEvent::export_all(&config).unwrap();

    let descriptor = serde_json::json!({
        "version": WIRE_CONTRACT_VERSION,
        "http": { "createMessage": CREATE_MESSAGE_PATH },
        "webSocket": { "events": EVENT_WEBSOCKET_PATH },
    });
    fs::write(
        Path::new(output).join("contract.json"),
        format!("{}\n", serde_json::to_string_pretty(&descriptor).unwrap()),
    )
    .unwrap();
}
