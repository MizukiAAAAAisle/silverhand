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
//! recover a rejection that never happened. So the fence reads the body up front and
//! rebuilds the request from the bytes it collected.
//!
//! **And it counts the frames itself rather than asking for the whole body.** A
//! collect helper reports ONE error type for two unrelated events: a body that was
//! too long, and a body that could not be read. Answering `413 content_too_large` for
//! the second dresses a transport or infrastructure failure up as the caller's
//! mistake, when their request may have been perfectly legal (@Cindy, review of
//! `119729c3`). Counting data frames here keeps the two apart at the only point where
//! the difference is still visible: an accumulated size over the cap belongs to the
//! caller, and a frame error belongs to us and keeps its cause.
//!
//! A DELIBERATE DIVERGENCE from the reference implementation, recorded rather than
//! smoothed over (R7): there, a read failure that is not the body-limit error falls
//! into the same `catch` as malformed JSON and is answered `400 invalid input`. That
//! conflates a peer disconnect with "the caller sent something unparseable". This
//! lane keeps the classification instead — the caller never submitted a legal
//! envelope that a schema then rejected — so it answers a safe `500` with the cause
//! logged once. Parity is not claimed for that cell.

use std::{future::poll_fn, pin::Pin};

use axum::{
    body::{Body, Bytes, HttpBody},
    extract::Request,
    http::{StatusCode, header::CONTENT_LENGTH, header::CONTENT_TYPE},
    middleware::Next,
    response::{IntoResponse, Response},
};

use super::send_request::{MESSAGE_SEND_MAX_BODY_BYTES, envelope_too_large};
use crate::foundation::error;

/// What reading a request body can come to. Three outcomes, because two of the
/// refusals belong to different parties.
pub(crate) enum BodyRead {
    /// Within the cap, and here are its bytes.
    Within(Bytes),
    /// The data frames accumulated past the cap. The caller's, and the only thing
    /// this fence answers `413` for.
    OverCap,
    /// The body could not be read. Ours: the cause travels so the single log at the
    /// boundary can say what actually happened.
    Unreadable(axum::Error),
}

/// Accumulates a body's DATA frames, stopping the moment they exceed `cap`.
///
/// Trailers are skipped rather than counted: they are metadata after the body, and a
/// bound on request payload that counted them would refuse a legal request for
/// carrying a checksum. A frame error ends the read immediately and UNCHANGED — no
/// classification is attempted, because the only honest thing to say about it here is
/// that it is not a size problem.
async fn read_within_cap(mut body: Body, cap: usize) -> BodyRead {
    let mut collected: Vec<u8> = Vec::new();
    loop {
        match poll_fn(|cx| Pin::new(&mut body).poll_frame(cx)).await {
            None => return BodyRead::Within(Bytes::from(collected)),
            Some(Err(cause)) => return BodyRead::Unreadable(cause),
            Some(Ok(frame)) => {
                if let Ok(data) = frame.into_data() {
                    // Checked BEFORE extending, so a body far over the cap is refused
                    // without ever being held whole in memory.
                    if collected.len() + data.len() > cap {
                        return BodyRead::OverCap;
                    }
                    collected.extend_from_slice(&data);
                }
            }
        }
    }
}

/// Reads one message-send body after a route has completed any authority gates
/// that must precede body polling.
///
/// The ordinary send routes install [`fence_message_send_body`] as outer
/// middleware because their contract fences ingress first. Direct-pair
/// initiation intentionally asks its anti-enumeration/initiation authority
/// first, then calls this helper. Both paths still consume the same size and
/// frame-counting authority.
pub(crate) async fn read_message_send_body(request: Request) -> BodyRead {
    let declared_over_cap = request
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .is_some_and(|declared| declared > MESSAGE_SEND_MAX_BODY_BYTES as u64);
    if declared_over_cap {
        return BodyRead::OverCap;
    }
    read_within_cap(request.into_body(), MESSAGE_SEND_MAX_BODY_BYTES).await
}

/// Rejects an oversized body, then hands the request on with its bytes intact.
///
/// Two cells answer `413`, and both are genuinely about size. A DECLARED overflow is
/// refused from the header without reading anything; an undeclared one — a chunked
/// body, or a header that lied — is refused while being read, because its size is not
/// knowable in advance.
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

    match read_within_cap(body, MESSAGE_SEND_MAX_BODY_BYTES).await {
        BodyRead::Within(collected) => {
            next.run(Request::from_parts(parts, Body::from(collected)))
                .await
        }
        BodyRead::OverCap => envelope_too_large().into_response(),
        BodyRead::Unreadable(cause) => unreadable_body(&cause),
    }
}

/// The one place a body that could not be read is reported, and it is this lane's own
/// top-level failure rather than anything the later gates get to see.
///
/// The cause is logged ONCE with its whole chain and never sent: a client learns that
/// the request failed on our side and nothing about our internals, while an operator
/// gets the named reason. The request is NOT forwarded with an empty body — doing so
/// would hand a transport failure to the shape gate and have it answered as invalid
/// input, which is the very conflation this lane exists to avoid.
fn unreadable_body(cause: &axum::Error) -> Response {
    tracing::error!(
        error_chain = crate::foundation::safe_log_field::safe_display(&(error::describe(cause))),
        "message-send request body could not be read"
    );
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        [(CONTENT_TYPE, "text/plain; charset=utf-8")],
        "Internal Server Error",
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use futures_util::stream;

    use super::*;

    #[derive(Debug, thiserror::Error)]
    #[error("upstream frame source vanished")]
    struct FrameSourceGone;

    /// A body that delivers real bytes and then fails, with no declared length. The
    /// prefix matters: the read had already succeeded in part, so the failure cannot
    /// be mistaken for "there was nothing to read".
    fn breaks_after_one_frame() -> Body {
        Body::from_stream(stream::iter(vec![
            Ok::<Bytes, FrameSourceGone>(Bytes::from_static(b"{\"content\":\"hi\"}")),
            Err(FrameSourceGone),
        ]))
    }

    #[tokio::test]
    async fn a_body_that_cannot_be_read_is_not_a_size_outcome_and_keeps_its_cause() {
        let outcome = read_within_cap(breaks_after_one_frame(), MESSAGE_SEND_MAX_BODY_BYTES).await;

        let BodyRead::Unreadable(cause) = outcome else {
            panic!("a frame failure was classified as a size outcome");
        };
        // The named cause survives to the single log point, which is the whole reason
        // it is carried rather than replaced.
        assert!(
            error::describe(&cause).contains("upstream frame source vanished"),
            "{}",
            error::describe(&cause)
        );
    }

    /// Only accumulated DATA decides the size refusal, and it is exact.
    #[tokio::test]
    async fn the_cap_counts_accumulated_data_and_admits_its_own_size() {
        let at_cap = Body::from("a".repeat(MESSAGE_SEND_MAX_BODY_BYTES));
        let over_cap = Body::from("a".repeat(MESSAGE_SEND_MAX_BODY_BYTES + 1));

        assert!(matches!(
            read_within_cap(at_cap, MESSAGE_SEND_MAX_BODY_BYTES).await,
            BodyRead::Within(bytes) if bytes.len() == MESSAGE_SEND_MAX_BODY_BYTES
        ));
        assert!(matches!(
            read_within_cap(over_cap, MESSAGE_SEND_MAX_BODY_BYTES).await,
            BodyRead::OverCap
        ));
    }

    /// Split across frames the cap is still on the TOTAL, which a per-frame check
    /// would get wrong.
    #[tokio::test]
    async fn frames_are_counted_together() {
        let half = MESSAGE_SEND_MAX_BODY_BYTES / 2;
        let frames = Body::from_stream(stream::iter(vec![
            Ok::<Bytes, FrameSourceGone>(Bytes::from("a".repeat(half))),
            Ok(Bytes::from("b".repeat(half + 1))),
        ]));

        assert!(matches!(
            read_within_cap(frames, MESSAGE_SEND_MAX_BODY_BYTES).await,
            BodyRead::OverCap
        ));
    }
}
