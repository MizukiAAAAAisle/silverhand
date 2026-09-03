//! Canonical internal-agent capability-denial response used by route-level gates.

use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::json;

pub(crate) fn capability_denied(capability: &'static str) -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(json!({
            "code": "capability_denied",
            "capability": capability,
            "message": format!("missing '{capability}' capability in this workspace"),
            "details": { "capability": capability },
        })),
    )
        .into_response()
}
