use std::{env, fs, path::PathBuf};

use serde_json::json;
use silverhand_backend_server::wire::{
    EVENT_LAG_CLOSE_CODE, EVENT_LAG_CLOSE_REASON, FOUNDATION_EVENT_WEBSOCKET_PATH,
    FOUNDATION_MESSAGE_PATH, HEALTH_PATH, WIRE_CONTRACT_VERSION, aggregate_typescript_manifest,
};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let output = env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .ok_or("usage: cargo run -p silverhand-backend-server --example export_wire -- <output>")?;
    fs::create_dir_all(&output)?;
    fs::write(output.join("wire.ts"), aggregate_typescript_manifest())?;
    fs::write(
        output.join("contract.json"),
        format!(
            "{}\n",
            serde_json::to_string_pretty(&json!({
                "version": WIRE_CONTRACT_VERSION,
                "http": {
                    "health": HEALTH_PATH,
                    "createFoundationMessage": FOUNDATION_MESSAGE_PATH,
                    "readFoundationMessagePage": FOUNDATION_MESSAGE_PATH,
                },
                "webSocket": {
                    "foundationEvents": {
                        "path": FOUNDATION_EVENT_WEBSOCKET_PATH,
                        "delivery": "live_bounded",
                        "lagCloseCode": EVENT_LAG_CLOSE_CODE,
                        "lagRecovery": EVENT_LAG_CLOSE_REASON,
                    }
                },
            }))?
        ),
    )?;
    Ok(())
}
