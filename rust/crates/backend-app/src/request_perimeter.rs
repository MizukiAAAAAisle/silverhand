//! The single app/proxy request-body perimeter.
//!
//! One ratified ceiling — 128 MiB per request — applied to every route at the
//! composition root, ahead of authentication and every domain check. It is a
//! deployment/packaging policy (a fronting proxy would enforce the same envelope),
//! NOT a domain rule, so it lives in this executable composition crate and no
//! endpoint copies the constant. Product routes still impose their own tighter caps
//! INSIDE the stream (avatar upload 5 MiB, message send ~512 KiB); this ceiling only
//! bounds the outer envelope so those in-stream caps are never truncated from below
//! and an oversized body cannot aggregate without limit.
//!
//! `axum::extract::DefaultBodyLimit` on its own is insufficient here: it is consulted
//! only by body extractors (`Bytes`/`Json`), so a multipart field reader or a raw
//! `to_bytes(request.into_body(), usize::MAX)` drain (e.g. `workspace_metadata_write`)
//! bypasses it and can turn a chunked body into unbounded aggregation. So the perimeter
//! WRAPS the byte stream in a bounded reader: every downstream read — an extractor, a
//! multipart field reader, or a raw drain — is hard-capped at the ceiling, and a body
//! past it errors the read rather than aggregating without limit. A declared oversize
//! `Content-Length` is refused earlier still, with the perimeter's own `413` before a
//! byte is read.
//!
//! This is a RESOURCE ceiling, not a uniform response contract. shiki ratified only the
//! resource cap: for an undeclared (chunked) oversize body the ceiling guarantees ONLY
//! that no unbounded read occurs — the resulting wire error is whatever the actual
//! extractor/handler makes of the bounded read (a raw drain that swallows to empty
//! answers its own `200`, a `Bytes`/`Json` extractor answers its own error). The
//! perimeter deliberately does NOT pre-buffer the whole body, translate the bounded-read
//! error per endpoint, or run a body state machine to force one uniform status. Product
//! routes keep their tighter in-stream caps and their exact domain `413` (e.g. the
//! avatar leaf's `avatar_too_large`); the perimeter neither replaces nor unifies those.

use axum::{
    body::Body,
    extract::{DefaultBodyLimit, Request},
    http::{
        StatusCode,
        header::{CONTENT_LENGTH, CONTENT_TYPE},
    },
    middleware::Next,
    response::{IntoResponse, Response},
};
use http_body_util::Limited;

/// The one ratified request-body ceiling: 128 MiB per request. A JSON-representable
/// magnitude, and the sole envelope authority for every mounted route.
pub const MAX_REQUEST_BODY_BYTES: usize = 128 * 1024 * 1024;

/// The perimeter's own refusal body, `{"error":"payload too large"}` — mirroring the
/// collaboration fence's wording and distinct from any domain-specific `413`. It is the
/// answer for a declared oversize `Content-Length`; an undeclared oversize body is
/// bounded by the stream wrap and its wire error is the downstream reader's.
fn payload_too_large() -> Response {
    (
        StatusCode::PAYLOAD_TOO_LARGE,
        [(CONTENT_TYPE, "application/json")],
        r#"{"error":"payload too large"}"#,
    )
        .into_response()
}

/// Enforce the one 128 MiB request-body ceiling, ahead of auth and every domain check.
pub async fn enforce_request_body_ceiling(request: Request, next: Next) -> Response {
    enforce_with_ceiling(request, next, MAX_REQUEST_BODY_BYTES).await
}

/// The ceiling logic, parameterised for tests so both the declared-length short-circuit
/// and the stream-wrap resource bound can be exercised without allocating 128 MiB.
async fn enforce_with_ceiling(request: Request, next: Next, ceiling: usize) -> Response {
    // Declared oversize: reject WITHOUT reading the body, so a client announcing a
    // too-large payload never gets a single byte aggregated, and gets the perimeter's
    // own `413`.
    let declared_over = request
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .is_some_and(|declared| declared > ceiling as u64);
    if declared_over {
        return payload_too_large();
    }

    // Bound the byte STREAM so every downstream read — a `Bytes`/`Json` extractor, a
    // multipart field reader, or a raw `to_bytes(into_body(), usize::MAX)` drain — is
    // hard-capped at the ceiling even when no `Content-Length` was declared (a chunked
    // body). This is a RESOURCE bound, not a uniform response: a body past the ceiling
    // errors the downstream read rather than aggregating without limit, and the actual
    // extractor/handler decides the resulting wire error. Disable axum's 2 MiB extractor
    // default so this single wrap is the sole envelope authority and never truncates an
    // extractor route below the ceiling; product routes still cap tighter in-stream.
    let (parts, body) = request.into_parts();
    let bounded = Body::new(Limited::new(body, ceiling));
    let mut request = Request::from_parts(parts, bounded);
    DefaultBodyLimit::disable().apply(&mut request);
    next.run(request).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Router,
        body::{Body, to_bytes},
        http::{Request as HttpRequest, StatusCode},
        middleware::from_fn,
        routing::post,
    };
    use tower::ServiceExt;

    /// A raw-drain handler mirroring `workspace_metadata_write::read_body`: it drains the
    /// body with `to_bytes(into_body(), usize::MAX)` and folds a read failure to empty.
    /// It echoes whatever bytes survive, so a test can observe what the perimeter admitted.
    async fn echo_raw_drain(request: HttpRequest<Body>) -> Response {
        let body = to_bytes(request.into_body(), usize::MAX)
            .await
            .unwrap_or_default();
        (StatusCode::OK, body).into_response()
    }

    fn router_with_ceiling(ceiling: usize) -> Router {
        Router::new()
            .route("/drain", post(echo_raw_drain))
            .layer(from_fn(move |request, next| {
                enforce_with_ceiling(request, next, ceiling)
            }))
    }

    #[tokio::test]
    async fn a_declared_content_length_over_the_ceiling_is_refused_by_the_perimeter() {
        // Nine declared bytes against an eight-byte ceiling: rejected without reaching the
        // raw-drain handler, which would otherwise echo the bytes back, and with the
        // perimeter's own `413` body. A real client/proxy sends `Content-Length`; the test
        // builder does not derive it, so it is set here.
        let response = router_with_ceiling(8)
            .oneshot(
                HttpRequest::post("/drain")
                    .header(CONTENT_LENGTH, "9")
                    .body(Body::from("123456789"))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert_eq!(&body[..], br#"{"error":"payload too large"}"#);
    }

    #[tokio::test]
    async fn an_in_limit_body_reaches_a_raw_drain_handler_with_its_bytes_intact() {
        // Five bytes under an eight-byte ceiling: the wrap is transparent and the raw
        // drain receives the full payload.
        let response = router_with_ceiling(8)
            .oneshot(
                HttpRequest::post("/drain")
                    .body(Body::from("hello"))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert_eq!(&body[..], b"hello");
    }

    #[tokio::test]
    async fn an_undeclared_oversize_body_is_bounded_not_aggregated() {
        // The resource-bound evidence: a chunked body (no `Content-Length`, so the
        // declared-length short-circuit cannot fire) that exceeds the ceiling. The stream
        // wrap hard-caps the read, so the raw drain — which uses `usize::MAX` and would
        // otherwise aggregate the WHOLE body without limit — errors past the ceiling and
        // its swallow-to-empty contract admits NOTHING. That is the ratified guarantee: no
        // unbounded aggregation on an undeclared oversize body. The ceiling makes NO claim
        // about the resulting wire status — the handler owns that (here a `200` with an
        // empty body), and product routes impose their own tighter caps and exact `413`.
        let oversize = futures_util::stream::iter(vec![Ok::<_, std::io::Error>(
            axum::body::Bytes::from_static(b"123456789"),
        )]);
        let response = router_with_ceiling(8)
            .oneshot(
                HttpRequest::post("/drain")
                    .body(Body::from_stream(oversize))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert!(
            body.is_empty(),
            "an undeclared body past the ceiling must be bounded, not aggregated; got {} bytes",
            body.len()
        );
    }
}
