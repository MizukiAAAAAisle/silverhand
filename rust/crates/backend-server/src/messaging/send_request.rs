//! The shape door for a create-message request: what a body must be before any
//! product rule looks at it, and how a refusal is reported.
//!
//! ITS OWN ERROR SHAPE, deliberately (@Cindy's ruling). The foundation proving
//! surface answers with a camelCase envelope carrying a wire-contract version; the
//! product create-message routes answer with a flat snake_case body. They are two
//! public contracts, and reusing one type for both would turn the proving surface's
//! vocabulary into a product-facing shape — so nothing here touches `crate::wire`.
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

/// One thing wrong with the request's shape, in the privacy-safe form the reference
/// reports: what kind of problem, and where — never the value that caused it.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ShapeIssue {
    pub code: String,
    pub path: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct InvalidInput {
    pub error: String,
    pub issues: Vec<ShapeIssue>,
}

pub fn invalid_input(issues: Vec<ShapeIssue>) -> impl IntoResponse {
    (
        StatusCode::BAD_REQUEST,
        Json(InvalidInput {
            error: "invalid input".to_owned(),
            issues,
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

/// The fields the shape door reads. Extra members are accepted and ignored here —
/// the reference's schemas admit the fields of later gates, and refusing them would
/// make this door stricter than the contract.
#[derive(Clone, Debug, Deserialize)]
pub struct SendMessageBody {
    pub content: Option<serde_json::Value>,
}

/// A request whose shape is settled: the content is a string, and it is within the
/// UTF-8 cap. Nothing about the product has been decided.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedShape {
    content: String,
}

impl AcceptedShape {
    pub fn content(&self) -> &str {
        &self.content
    }
}

/// Why a body's shape was refused, kept apart from its rendering so the two doors
/// can word the size refusal differently while agreeing about what went wrong.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ShapeRefusal {
    Invalid(Vec<ShapeIssue>),
    ContentTooLarge { actual_bytes: usize },
}

/// The shape gate, in the reference's order: what the body IS, and only then how big
/// its content is.
///
/// The order is observable and therefore a contract: a request that is both
/// malformed and oversized is answered as malformed, because "this is not a send"
/// precedes "this send is too big".
pub fn accept_shape(body: Option<SendMessageBody>) -> Result<AcceptedShape, ShapeRefusal> {
    let Some(body) = body else {
        // An unparseable body is the same answer as a body missing everything: the
        // reference substitutes an empty object and lets the schema speak.
        return Err(ShapeRefusal::Invalid(vec![ShapeIssue {
            code: "invalid_type".to_owned(),
            path: vec!["content".to_owned()],
        }]));
    };

    let content = match body.content {
        Some(serde_json::Value::String(content)) => content,
        Some(_) | None => {
            return Err(ShapeRefusal::Invalid(vec![ShapeIssue {
                code: "invalid_type".to_owned(),
                path: vec!["content".to_owned()],
            }]));
        }
    };

    // UTF-8 bytes, which is what `str::len` already counts — the "bytes, not UTF-16
    // code units" distinction cannot be lost here the way it can in a language whose
    // strings are counted in code units.
    let actual_bytes = content.len();
    if actual_bytes > MAX_MESSAGE_CONTENT_BYTES {
        return Err(ShapeRefusal::ContentTooLarge { actual_bytes });
    }

    Ok(AcceptedShape { content })
}
