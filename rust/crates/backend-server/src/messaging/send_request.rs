//! The shape door for a create-message request: what a body must be before any
//! product rule looks at it, and how a refusal is reported.
//!
//! ITS OWN ERROR SHAPE, deliberately (@Cindy's ruling). The foundation proving
//! surface answers with a camelCase envelope carrying a wire-contract version; the
//! product create-message routes answer with a flat snake_case body. They are two
//! public contracts, and reusing one type for both would turn the proving surface's
//! vocabulary into a product-facing shape — so nothing here touches `crate::wire`.
//!
//!
//! WHAT IT NO LONGER OWNS: the shape itself, NOR its refusal. Deciding what a
//! request IS belongs to [`super::admission`], the one authority for it; rendering a
//! shape/semantic refusal belongs to [`crate::wire_admission::invalid_input`], the one
//! `422 {"error":"invalid input"}` every mounted write face shares. This module renders
//! only the two answers that are THIS door's own: the ingress fence's envelope bound and
//! the content cap, whose two wordings are a contract the shared refusal cannot express.
//!
//! The two doors differ in wording where the reference implementation differs, and
//! that is a contract rather than an accident: the agent door tells a runtime what to
//! do instead (send an attachment), because a runtime can act on that; the human door
//! does not, because a person's client already converts oversized paste content.
//! There is deliberately NO shared renderer for the two messages — one would make the
//! difference a parameter, and a parameter is something a future edit can flatten.

use axum::{Json, http::StatusCode, response::IntoResponse};
use serde::{Deserialize, Serialize};

use silverhand_backend_core::messaging::MAX_MESSAGE_CONTENT_BYTES;

/// The content cap as a reader sees it named. The bytes are the authority; this is
/// the label the two refusals quote.
pub const MAX_MESSAGE_CONTENT_LABEL: &str = "64KiB";

/// The pre-parse HTTP body bound, DERIVED from the content cap rather than written
/// out: a legal body at exactly the cap can expand sixfold under JSON string
/// escaping (`\u0001` is six bytes for one), and the remainder is envelope headroom
/// for target, attachment ids and freshness fields. Spelling the total as a literal
/// would let the two drift.
pub const MESSAGE_SEND_MAX_BODY_BYTES: usize = 6 * MAX_MESSAGE_CONTENT_BYTES + 128 * 1024;

/// The code both size refusals carry. One code for two bounds, as the reference has
/// it: a client that hit either sent something too big.
const CONTENT_TOO_LARGE: &str = "content_too_large";

/// The body of a refusal from the ingress fence. Reports the bound it broke and
/// nothing about the content, because at this point nothing has been parsed.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EnvelopeTooLarge {
    pub error: String,
    pub code: String,
    pub max_body_bytes: usize,
}

pub fn envelope_too_large() -> impl IntoResponse {
    (
        StatusCode::PAYLOAD_TOO_LARGE,
        Json(EnvelopeTooLarge {
            error: "request body exceeds message-send bound".to_owned(),
            code: CONTENT_TOO_LARGE.to_owned(),
            max_body_bytes: MESSAGE_SEND_MAX_BODY_BYTES,
        }),
    )
}

/// The body of a content-cap refusal. Reports both bounds, so a client can tell how
/// far over it went without guessing at the limit.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ContentTooLarge {
    pub error: String,
    pub code: String,
    pub max_bytes: usize,
    pub actual_bytes: usize,
}

/// The AGENT door's content-cap refusal, which names the alternative.
pub fn agent_content_too_large(actual_bytes: usize) -> impl IntoResponse {
    (
        StatusCode::PAYLOAD_TOO_LARGE,
        Json(ContentTooLarge {
            error: format!(
                "message content exceeds {MAX_MESSAGE_CONTENT_LABEL} limit; send it as an \
                 attachment instead"
            ),
            code: CONTENT_TOO_LARGE.to_owned(),
            max_bytes: MAX_MESSAGE_CONTENT_BYTES,
            actual_bytes,
        }),
    )
}

/// The HUMAN door's content-cap refusal, which does not.
pub fn human_content_too_large(actual_bytes: usize) -> impl IntoResponse {
    (
        StatusCode::PAYLOAD_TOO_LARGE,
        Json(ContentTooLarge {
            error: format!("message content exceeds {MAX_MESSAGE_CONTENT_LABEL} limit"),
            code: CONTENT_TOO_LARGE.to_owned(),
            max_bytes: MAX_MESSAGE_CONTENT_BYTES,
            actual_bytes,
        }),
    )
}

/// A missing path parameter. Answered before the body is looked at, because a
/// request that names no target is not a send at all.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct MissingIdentifier {
    pub error: String,
}

pub fn missing_identifier(message: &str) -> impl IntoResponse {
    (
        StatusCode::BAD_REQUEST,
        Json(MissingIdentifier {
            error: message.to_owned(),
        }),
    )
}
