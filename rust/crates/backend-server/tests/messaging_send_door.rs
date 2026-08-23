//! The message-send ingress fence, observed the way an operator would.
//!
//! The unit tests beside the fence prove the classification and the safe response.
//! What they cannot see is how MANY times a failure was reported: a future edit that
//! logged the cause in the middleware and again in a renderer would leave every one
//! of them green while doubling the noise an operator has to read. That count is the
//! contract this file locks (@Cindy, review of `2bb73d7c`).

use std::{
    io::{self, Write},
    sync::{Arc, Mutex},
};

use axum::{
    Router,
    body::{Body, Bytes},
    http::{Request, StatusCode},
    middleware,
    routing::post,
};
use futures_util::stream;
use serde_json::Value;
use silverhand_backend_server::messaging::envelope::fence_message_send_body;
use tower::ServiceExt;
use tracing_subscriber::fmt::MakeWriter;

const FRAME_CAUSE: &str = "upstream frame source vanished";

#[derive(Debug, thiserror::Error)]
#[error("upstream frame source vanished")]
struct FrameSourceGone;

/// A body that delivers real bytes and then fails, with no declared length. The
/// prefix matters: part of the read had already succeeded, so the failure cannot be
/// mistaken for an empty body.
fn breaks_after_one_frame() -> Body {
    Body::from_stream(stream::iter(vec![
        Ok::<Bytes, FrameSourceGone>(Bytes::from_static(b"{\"content\":\"hi\"}")),
        Err(FrameSourceGone),
    ]))
}

fn fenced() -> Router {
    Router::new()
        .route(
            "/internal/agents/{aid}/send-message",
            post(|| async { "sent" }),
        )
        .layer(middleware::from_fn(fence_message_send_body))
}

#[tokio::test(flavor = "current_thread")]
async fn an_unreadable_body_is_reported_exactly_once_and_never_to_the_caller() {
    let logs = LogBuffer::default();
    let subscriber = tracing_subscriber::fmt()
        .json()
        .without_time()
        .with_target(false)
        .with_writer(logs.clone())
        .finish();
    let _guard = tracing::subscriber::set_default(subscriber);

    let response = fenced()
        .oneshot(
            Request::post("/internal/agents/agent-1/send-message")
                .body(breaks_after_one_frame())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let body = String::from_utf8(
        axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap();

    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);

    let events = logs.events();
    let errors = events
        .iter()
        .filter(|event| event["level"] == "ERROR")
        .collect::<Vec<_>>();
    // ONE report. Not "at least one": a second would mean an operator reads the same
    // failure twice and cannot tell one broken request from two.
    assert_eq!(errors.len(), 1, "{events:?}");
    assert_eq!(
        errors[0]["fields"]["message"],
        "message-send request body could not be read"
    );
    assert!(
        errors[0]["fields"]["error_chain"]
            .as_str()
            .is_some_and(|chain| chain.contains(FRAME_CAUSE)),
        "{:?}",
        errors[0]["fields"]["error_chain"]
    );

    // The operator has the cause; the caller has none of it.
    assert!(!body.contains(FRAME_CAUSE), "{body}");
    assert!(!body.contains("content"), "{body}");
}

#[derive(Clone, Default)]
struct LogBuffer(Arc<Mutex<Vec<u8>>>);

impl LogBuffer {
    fn events(&self) -> Vec<Value> {
        let bytes = self.0.lock().unwrap().clone();
        String::from_utf8(bytes)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
}

struct LogWriter(LogBuffer);

impl Write for LogWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl<'a> MakeWriter<'a> for LogBuffer {
    type Writer = LogWriter;

    fn make_writer(&'a self) -> Self::Writer {
        LogWriter(self.clone())
    }
}
