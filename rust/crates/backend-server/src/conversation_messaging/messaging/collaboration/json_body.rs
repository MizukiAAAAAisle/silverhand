//! One bounded JSON-body reader shared by collaboration mutation routes.
//!
//! Routes call this only after their authentication and pre-body product gates.
//! The local fence mirrors the ratified app/proxy 128 MiB perimeter so a missing
//! outer layer cannot turn a chunked body into unbounded aggregation.

use axum::{
    Json,
    body::Bytes,
    extract::{
        DefaultBodyLimit, FromRequest, Request,
        rejection::{BytesRejection, FailedToBufferBody},
    },
    http::{StatusCode, header::CONTENT_LENGTH},
    response::{IntoResponse, Response},
};
use serde_json::json;

pub(crate) const JSON_BODY_MAX_BYTES: usize = 128 * 1024 * 1024;

pub(crate) enum BodyRead {
    Within(Bytes),
    OverLimit,
    Unreadable,
}

pub(crate) async fn read_body(request: Request) -> BodyRead {
    if request
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .is_some_and(|declared| declared > JSON_BODY_MAX_BYTES as u64)
    {
        return BodyRead::OverLimit;
    }

    let mut request = request;
    DefaultBodyLimit::max(JSON_BODY_MAX_BYTES).apply(&mut request);
    match Bytes::from_request(request, &()).await {
        Ok(body) => BodyRead::Within(body),
        Err(BytesRejection::FailedToBufferBody(FailedToBufferBody::LengthLimitError(_))) => {
            BodyRead::OverLimit
        }
        Err(BytesRejection::FailedToBufferBody(FailedToBufferBody::UnknownBodyError(_))) => {
            BodyRead::Unreadable
        }
        Err(_) => BodyRead::Unreadable,
    }
}

pub(crate) fn payload_too_large() -> Response {
    (
        StatusCode::PAYLOAD_TOO_LARGE,
        Json(json!({"error":"payload too large"})),
    )
        .into_response()
}
