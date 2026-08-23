//! The ingress fence for message-send requests.
//!
//! A pre-parse bound on the whole HTTP body, applied BEFORE anything else about
//! the request is considered. A non-compliant client must not be able to feed a
//! multi-megabyte body into the JSON parser, and the precise UTF-8 content cap is a
//! later, narrower gate ([`super::send_request`]).
//!
//! **It consumes the body itself rather than limiting an extractor.** An extractor
//! only runs when the handler reaches for the body, so a handler that answers early
//! — a missing path parameter, say — would never trip a limit at all, and an
//! oversized chunked request would be answered by the LATER gate instead of this one
//! (@Cindy, review of the first plan). Mapping a rejection after the fact cannot
//! recover a rejection that never happened. So the fence reads the body to its cap
//! up front and rebuilds the request from the bytes it collected; that is what makes
//! "envelope first" true for every request rather than only for the ones that get
//! far enough to be parsed.
//!
//! Reading to the cap is this layer's own job, not a duplicated parse: the bound
//! exists to fence ingress memory, so the bytes have to be counted somewhere, and
//! counting them here is what lets every later gate work on a value already known to
//! be within bounds.

use axum::{
    body::{Body, Bytes},
    extract::Request,
    http::{StatusCode, header::CONTENT_LENGTH},
    middleware::Next,
    response::{IntoResponse, Response},
};

use super::send_request::{MESSAGE_SEND_MAX_BODY_BYTES, envelope_too_large};

/// Rejects an oversized body, then hands the request on with its bytes intact.
///
/// Two cells, one answer. A DECLARED overflow is refused from the header without
/// reading anything; an undeclared one — a chunked body — is refused while being
/// read, because its size is not knowable in advance. The reference implementation
/// has the same pair, and a client that lies about `Content-Length` is covered by
/// the second.
pub async fn fence_message_send_body(request: Request, next: Next) -> Response {
    let (parts, body) = request.into_parts();

    if let Some(declared) = parts
        .headers
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        && declared > MESSAGE_SEND_MAX_BODY_BYTES as u64
    {
        return envelope_too_large().into_response();
    }

    // Undeclared, or declared within bounds and therefore still to be trusted only
    // as far as the cap. `to_bytes` fails once the body exceeds it, so a body of
    // exactly the bound is admitted and one byte more is not.
    let collected: Bytes = match axum::body::to_bytes(body, MESSAGE_SEND_MAX_BODY_BYTES).await {
        Ok(bytes) => bytes,
        Err(_) => return envelope_too_large().into_response(),
    };

    next.run(Request::from_parts(parts, Body::from(collected)))
        .await
}

/// The status this fence answers with, named so a test asserts the contract rather
/// than a number spelled twice.
pub const ENVELOPE_REFUSAL_STATUS: StatusCode = StatusCode::PAYLOAD_TOO_LARGE;
