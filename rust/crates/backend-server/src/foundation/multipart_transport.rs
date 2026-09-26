//! Route-neutral multipart STREAM primitives shared by the avatar/profile upload faces.
//!
//! These are transport mechanics only — bounded accumulation, field draining, and the
//! "declared content type or the octet-stream default" read. They hold NO route policy:
//! which field names a route accepts, first-slot vs last-wins, unknown/duplicate handling,
//! whether an over-cap SELECTED part is drained or left for the next `next_field()`, and
//! the refusal/status ladder all stay in each route, made explicit at the call site.
//!
//! They also hold NO MIME allowlist or case-folding. The sole MIME authority is
//! [`AvatarContentType::parse`] (backend-core), which lowercases and matches the closed
//! allowlist itself; this layer only supplies the raw declared type (or the default) for
//! it to judge, so there is never a second, drift-prone normalizer here.
//!
//! [`AvatarContentType::parse`]: silverhand_backend_core::identity_access::avatar::AvatarContentType::parse

use axum::extract::multipart::{Field, MultipartError};

/// The content type assumed when a part declares none — the product's
/// `file.type || 'application/octet-stream'`. It is deliberately NOT one of the allowed
/// avatar types, so an absent declared type flows through to the domain validator's `415`.
const DEFAULT_UPLOAD_CONTENT_TYPE: &str = "application/octet-stream";

/// The part's declared content type, or [`DEFAULT_UPLOAD_CONTENT_TYPE`] when it is absent
/// or empty.
///
/// Deliberately NOT lowercased and NOT `;param`-stripped: the domain's
/// `AvatarContentType::parse` owns ASCII case-folding and the exact-match allowlist, so
/// folding here would be a second copy of that authority. Passing the raw declared string
/// through keeps this a pure transport read (a cased or parameterized type reaches the one
/// validator unchanged and is judged there).
pub(crate) fn declared_content_type(field: &Field<'_>) -> String {
    field
        .content_type()
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_UPLOAD_CONTENT_TYPE)
        .to_owned()
}

/// Read a part into memory, retaining at most `retain_limit` bytes.
///
/// `retain_limit` is the RETENTION ceiling, and a route that gates on a product maximum
/// passes `product_max + 1`, never the bare maximum: the domain size check runs on the
/// buffered length, so retaining one byte past the limit is exactly what lets the validator
/// tell `product_max` (accept) from `product_max + 1` (reject). Passing the bare maximum
/// would truncate a `product_max + 1` body down to `product_max` and make the validator
/// wrongly ACCEPT it. The buffer therefore never exceeds `retain_limit`.
///
/// This is a pure bounded ACCUMULATE: it never drains past `retain_limit`. Whether an
/// over-limit SELECTED part is then consumed to surface a trailing parse fault is the
/// caller's choice — it calls [`drain`] on the same field afterwards, or relies on the next
/// `next_field()` to drive the remainder. The drain policy is never baked in here.
pub(crate) async fn accumulate_capped(
    field: &mut Field<'_>,
    retain_limit: usize,
) -> Result<Vec<u8>, MultipartError> {
    let mut bytes = Vec::new();
    while let Some(chunk) = field.chunk().await? {
        let room = retain_limit - bytes.len();
        if chunk.len() >= room {
            bytes.extend_from_slice(&chunk[..room]);
            break;
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

/// Advance a part to its end, discarding every chunk with ZERO accumulation, so an
/// ignored/duplicate/unknown/over-cap part can never charge the request ceiling into
/// memory. A stream/parse fault surfaces as the raw [`MultipartError`]; the caller maps it
/// to its own terminal refusal.
pub(crate) async fn drain(field: &mut Field<'_>) -> Result<(), MultipartError> {
    while field.chunk().await?.is_some() {}
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Router,
        body::Body,
        extract::{Multipart, Request, State},
        http::header,
        routing::post,
    };
    use tower::ServiceExt;

    const BOUNDARY: &str = "X-TEST-BOUNDARY";

    /// One multipart part: `(name, filename, content_type, bytes)`. A `None` filename
    /// makes a plain value part; a `None` content_type omits the per-part header.
    type Part<'a> = (&'a str, Option<&'a str>, Option<&'a str>, &'a [u8]);

    /// Build a `multipart/form-data` body from the given parts. Returns
    /// `(content_type_header, body_bytes)`.
    fn multipart_body(parts: &[Part<'_>]) -> (String, Vec<u8>) {
        let mut body = Vec::new();
        for (name, filename, content_type, bytes) in parts {
            body.extend_from_slice(format!("--{BOUNDARY}\r\n").as_bytes());
            let disposition = match filename {
                Some(filename) => format!(
                    "Content-Disposition: form-data; name=\"{name}\"; filename=\"{filename}\"\r\n"
                ),
                None => format!("Content-Disposition: form-data; name=\"{name}\"\r\n"),
            };
            body.extend_from_slice(disposition.as_bytes());
            if let Some(content_type) = content_type {
                body.extend_from_slice(format!("Content-Type: {content_type}\r\n").as_bytes());
            }
            body.extend_from_slice(b"\r\n");
            body.extend_from_slice(bytes);
            body.extend_from_slice(b"\r\n");
        }
        body.extend_from_slice(format!("--{BOUNDARY}--\r\n").as_bytes());
        (format!("multipart/form-data; boundary={BOUNDARY}"), body)
    }

    fn request_for(content_type: String, body: Vec<u8>) -> Request {
        Request::builder()
            .method("POST")
            .uri("/")
            .header(header::CONTENT_TYPE, content_type)
            .body(Body::from(body))
            .unwrap()
    }

    async fn text_response(response: axum::response::Response) -> String {
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        String::from_utf8(bytes.to_vec()).unwrap()
    }

    /// Run `accumulate_capped(retain_limit)` over a single file part of `body_size` bytes
    /// and return the retained length.
    async fn retained_len(retain_limit: usize, body_size: usize) -> usize {
        async fn handler(State(limit): State<usize>, mut multipart: Multipart) -> String {
            let mut field = multipart.next_field().await.unwrap().unwrap();
            accumulate_capped(&mut field, limit)
                .await
                .unwrap()
                .len()
                .to_string()
        }
        let payload = vec![b'a'; body_size];
        let (content_type, body) =
            multipart_body(&[("file", Some("a.bin"), Some("image/png"), &payload)]);
        let app = Router::new()
            .route("/", post(handler))
            .with_state(retain_limit);
        let response = app.oneshot(request_for(content_type, body)).await.unwrap();
        text_response(response).await.parse().unwrap()
    }

    #[tokio::test]
    async fn retention_holds_at_and_past_the_limit() {
        // With `retain_limit = product_max + 1`, stand `product_max` in as `limit - 1`:
        //   * a `product_max` body is retained whole (accepted downstream);
        //   * a `product_max + 1` body is retained whole at exactly the limit (rejected);
        //   * a body far past the limit is truncated to the limit — the buffer NEVER exceeds
        //     `retain_limit`, whatever the input size.
        let limit = 8; // = product_max + 1
        assert_eq!(
            retained_len(limit, limit - 1).await,
            limit - 1,
            "product_max"
        );
        assert_eq!(retained_len(limit, limit).await, limit, "product_max + 1");
        assert_eq!(
            retained_len(limit, limit + 4096).await,
            limit,
            "far over cap"
        );
        assert_eq!(retained_len(limit, 0).await, 0, "empty part");
    }

    #[tokio::test]
    async fn capped_accumulation_and_explicit_drain_allow_the_next_part() {
        // Retain the prefix, call drain, then read another part from the same stream.
        // This roundtrip does not prove drain is necessary: multer can consume the
        // whole field in one chunk or drain it when advancing to the next field.
        async fn handler(mut multipart: Multipart) -> String {
            let mut field = multipart.next_field().await.unwrap().unwrap();
            let ct = declared_content_type(&field);
            let bytes = accumulate_capped(&mut field, 4).await.unwrap();
            drain(&mut field).await.unwrap();
            drop(field); // release the field guard before pulling the next part
            let second = multipart.next_field().await.unwrap();
            format!(
                "{ct}|{}|{}",
                String::from_utf8_lossy(&bytes),
                second.is_some()
            )
        }
        let (content_type, body) = multipart_body(&[
            ("file", Some("a.png"), Some("image/png"), b"0123456789"),
            ("other", None, None, b"x"),
        ]);
        let app = Router::new().route("/", post(handler));
        let response = app.oneshot(request_for(content_type, body)).await.unwrap();
        assert_eq!(text_response(response).await, "image/png|0123|true");
    }

    #[tokio::test]
    async fn declared_content_type_passes_multers_essence_through_and_defaults_when_absent() {
        async fn handler(mut multipart: Multipart) -> String {
            let with_type = multipart.next_field().await.unwrap().unwrap();
            let cased = declared_content_type(&with_type);
            drop(with_type); // release the field guard before pulling the next part
            let without = multipart.next_field().await.unwrap().unwrap();
            let defaulted = declared_content_type(&without);
            format!("{cased}|{defaulted}")
        }
        // First part declares a MIXED-CASE type: multer's mime parse already lowercases the
        // essence, so the helper hands back `image/png` WITHOUT adding a normalizer of its
        // own (the redundant explicit lowercase the pre-migration faces carried). Second part
        // omits the header entirely and must fall back to the octet-stream default.
        let (content_type, body) = multipart_body(&[
            ("file", Some("a.png"), Some("IMAGE/PNG"), b"x"),
            ("file", Some("b.png"), None, b"y"),
        ]);
        let app = Router::new().route("/", post(handler));
        let response = app.oneshot(request_for(content_type, body)).await.unwrap();
        assert_eq!(
            text_response(response).await,
            "image/png|application/octet-stream"
        );
    }
}
