//! The product create-message boundary: the shape door both send routes pass
//! through before any product rule is consulted.
//!
//! - [`envelope`] — the ingress fence, applied to the whole body before anything
//!   else about the request is considered.
//! - [`send_request`] — what a body must be, how big its content may be, and the
//!   flat snake_case refusals the product routes answer with.
//!
//! WHAT IS NOT HERE YET, and may not be claimed: the product paths are not mounted.
//! The human door's pre-parse authorization (404 then 403) and the agent door's
//! post-parse target resolution and capability gate are the NEXT checkpoint, and
//! until they exist neither route is a route — only the shape door is real. The
//! ordering this checkpoint proves is exercised over real HTTP in the tests, against
//! the two paths the reference uses, so the wiring fact is asserted rather than
//! assumed.

pub mod envelope;
pub mod send_request;

#[cfg(test)]
mod ordering_tests {
    use axum::{
        Router,
        body::Body,
        extract::Path,
        http::{Request, StatusCode, header::CONTENT_LENGTH},
        middleware,
        response::{IntoResponse, Response},
        routing::post,
    };
    use tower::ServiceExt;

    use super::{
        envelope::fence_message_send_body,
        send_request::{
            MESSAGE_SEND_MAX_BODY_BYTES, SendMessageBody, ShapeRefusal, accept_shape,
            agent_content_too_large, human_content_too_large, invalid_input, missing_identifier,
        },
    };

    /// The two doors, wired in the reference's order: the fence is a layer, so it runs
    /// before the handler; the handler checks its path parameter before touching the
    /// body; the shape gate answers before the size of the content is considered.
    ///
    /// The terminal answer is `200 reached` and nothing more. This checkpoint owns the
    /// shape door only, so a body that passes it has reached the NEXT gate rather than
    /// been sent — pretending otherwise is what "not mountable yet" forbids.
    fn doors() -> Router {
        Router::new()
            .route("/api/channels/{id}/messages", post(human_door))
            .route("/internal/agents/{aid}/send-message", post(agent_door))
            .fallback(|| async { (StatusCode::NOT_FOUND, "no such route") })
            .layer(middleware::from_fn(fence_message_send_body))
    }

    async fn human_door(Path(id): Path<String>, body: String) -> Response {
        if id.is_empty() {
            return missing_identifier("channel id required").into_response();
        }
        match accept_shape(parse(body)) {
            Ok(_) => (StatusCode::OK, "reached").into_response(),
            Err(ShapeRefusal::Invalid(issues)) => invalid_input(issues).into_response(),
            Err(ShapeRefusal::ContentTooLarge { actual_bytes }) => {
                human_content_too_large(actual_bytes).into_response()
            }
        }
    }

    async fn agent_door(Path(aid): Path<String>, body: String) -> Response {
        if aid.is_empty() {
            return missing_identifier("agent id required").into_response();
        }
        match accept_shape(parse(body)) {
            Ok(_) => (StatusCode::OK, "reached").into_response(),
            Err(ShapeRefusal::Invalid(issues)) => invalid_input(issues).into_response(),
            Err(ShapeRefusal::ContentTooLarge { actual_bytes }) => {
                agent_content_too_large(actual_bytes).into_response()
            }
        }
    }

    /// An unparseable body becomes "nothing", which the shape gate answers for. The
    /// reference substitutes `{}` and lets its schema speak; this is the same step.
    fn parse(body: String) -> Option<SendMessageBody> {
        serde_json::from_str(body.as_str()).ok()
    }

    async fn send(request: Request<Body>) -> (StatusCode, String) {
        let response = doors().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        (status, String::from_utf8(bytes.to_vec()).unwrap())
    }

    fn body_of(content_bytes: usize) -> String {
        format!(r#"{{"content":"{}"}}"#, "a".repeat(content_bytes))
    }

    /// A body over the bound, DECLARED, on a request that also names no target.
    ///
    /// The cross is the point: the handler would answer `400` for the missing id, so
    /// this can only be a `413` if the fence ran first. It pins "envelope before
    /// everything" rather than "envelope before parsing".
    #[tokio::test]
    async fn a_declared_oversize_body_is_refused_even_with_no_identifier() {
        for path in ["/api/channels//messages", "/internal/agents//send-message"] {
            let oversized = "a".repeat(MESSAGE_SEND_MAX_BODY_BYTES + 1);
            let request = Request::post(path)
                .header(CONTENT_LENGTH, oversized.len())
                .body(Body::from(oversized))
                .unwrap();

            let (status, body) = send(request).await;

            assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE, "{path}");
            assert!(
                body.contains("request body exceeds message-send bound"),
                "{path}"
            );
            assert!(body.contains(r#""code":"content_too_large""#), "{path}");
            assert!(body.contains(r#""max_body_bytes":524288"#), "{path}");
        }
    }

    /// The same cross with the size UNDECLARED, which is the cell that kills a
    /// limited-extractor design: nothing about this request would ever have reached
    /// for the body, so a limit that only applies to extraction never fires and the
    /// answer degrades to the missing-identifier `400`.
    #[tokio::test]
    async fn a_chunked_oversize_body_is_refused_even_with_no_identifier() {
        for path in ["/api/channels//messages", "/internal/agents//send-message"] {
            let request = Request::post(path)
                .body(Body::from("a".repeat(MESSAGE_SEND_MAX_BODY_BYTES + 1)))
                .unwrap();

            let (status, body) = send(request).await;

            assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE, "{path}");
            assert!(
                body.contains("request body exceeds message-send bound"),
                "{path}"
            );
        }
    }

    /// The bound is exact, and it is the bound on the ENVELOPE rather than on the
    /// content: a body of precisely the bound reaches the next gate, and one byte more
    /// does not get that far.
    #[tokio::test]
    async fn the_envelope_bound_admits_its_own_size_and_nothing_over() {
        let envelope = r#"{"content":""}"#.len();
        let at_bound = body_of(MESSAGE_SEND_MAX_BODY_BYTES - envelope);
        assert_eq!(at_bound.len(), MESSAGE_SEND_MAX_BODY_BYTES);

        // At the bound the fence passes it on, and the CONTENT cap is what answers —
        // which is the later gate, so the fence is not the thing refusing it.
        let (status, body) = send(
            Request::post("/internal/agents/agent-1/send-message")
                .body(Body::from(at_bound))
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
        assert!(body.contains("message content exceeds"), "{body}");
        assert!(!body.contains("max_body_bytes"), "{body}");

        let over = body_of(MESSAGE_SEND_MAX_BODY_BYTES - envelope + 1);
        assert_eq!(over.len(), MESSAGE_SEND_MAX_BODY_BYTES + 1);
        let (status, body) = send(
            Request::post("/internal/agents/agent-1/send-message")
                .body(Body::from(over))
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
        assert!(
            body.contains("request body exceeds message-send bound"),
            "{body}"
        );
    }

    /// Once the envelope is admitted, a missing path parameter is answered before the
    /// body is read at all — and each door names its own coordinate.
    #[tokio::test]
    async fn a_missing_identifier_answers_before_the_body_is_parsed() {
        // The body is malformed too. If parsing came first this would be `invalid
        // input`; the identifier wins.
        for (path, expected) in [
            ("/api/channels//messages", "channel id required"),
            ("/internal/agents//send-message", "agent id required"),
        ] {
            let (status, body) = send(
                Request::post(path)
                    .body(Body::from("not json at all"))
                    .unwrap(),
            )
            .await;

            assert_eq!(status, StatusCode::BAD_REQUEST, "{path}");
            assert!(body.contains(expected), "{path}: {body}");
        }
    }

    /// Shape before size: a body that is both the wrong shape AND oversized is
    /// answered as the wrong shape, with privacy-safe issues and no echo of what was
    /// sent.
    #[tokio::test]
    async fn an_invalid_shape_answers_before_the_content_cap() {
        let oversized_but_not_a_string = format!(r#"{{"content":{}}}"#, "1".repeat(70_000));

        let (status, body) = send(
            Request::post("/internal/agents/agent-1/send-message")
                .body(Body::from(oversized_but_not_a_string))
                .unwrap(),
        )
        .await;

        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body.contains(r#""error":"invalid input""#), "{body}");
        assert!(body.contains(r#""code":"invalid_type""#), "{body}");
        assert!(body.contains(r#""path":["content"]"#), "{body}");
        assert!(
            !body.contains("111"),
            "the refusal echoed the value: {body}"
        );
    }

    /// The two doors word the same bound differently, and the difference is the
    /// contract: a runtime is told what to do instead, a person is not.
    #[tokio::test]
    async fn each_door_words_the_content_cap_for_its_own_caller() {
        let over_content = body_of(65_537);

        let (agent_status, agent_body) = send(
            Request::post("/internal/agents/agent-1/send-message")
                .body(Body::from(over_content.clone()))
                .unwrap(),
        )
        .await;
        let (human_status, human_body) = send(
            Request::post("/api/channels/conv-1/messages")
                .body(Body::from(over_content))
                .unwrap(),
        )
        .await;

        assert_eq!(agent_status, StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(human_status, StatusCode::PAYLOAD_TOO_LARGE);
        assert!(
            agent_body
                .contains("message content exceeds 64KiB limit; send it as an attachment instead"),
            "{agent_body}"
        );
        assert!(
            human_body.contains(r#""error":"message content exceeds 64KiB limit""#),
            "{human_body}"
        );
        // The human door must not acquire the agent's instruction.
        assert!(!human_body.contains("attachment"), "{human_body}");
        // Both report the same two bounds.
        for body in [&agent_body, &human_body] {
            assert!(body.contains(r#""max_bytes":65536"#), "{body}");
            assert!(body.contains(r#""actual_bytes":65537"#), "{body}");
        }
    }

    /// A body within both bounds reaches the next gate. Without this the refusals
    /// above could all be an accident of something else failing.
    #[tokio::test]
    async fn a_well_shaped_body_reaches_the_next_gate() {
        for path in [
            "/api/channels/conv-1/messages",
            "/internal/agents/agent-1/send-message",
        ] {
            let (status, body) = send(
                Request::post(path)
                    .body(Body::from(body_of(65_536)))
                    .unwrap(),
            )
            .await;

            assert_eq!(status, StatusCode::OK, "{path}: {body}");
            assert_eq!(body, "reached", "{path}");
        }
    }
}
