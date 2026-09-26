use super::*;
use std::{
    convert::Infallible,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};

use axum::{
    body::{Body, to_bytes},
    http::Request,
};
use silverhand_backend_core::conversation_messaging::messaging::collaboration::conversation_message_window::{
    ConversationMessageWindow, MessageWindowAudienceFact, MessageWindowHead,
    ResolvedMessageWindowStream, WindowBoundaryDirection, WindowBoundaryFact,
};
use tower::ServiceExt;

#[test]
fn query_is_one_closed_stream_and_anchor_selector() {
    let latest = request(&MessageWindowQueryWire::default()).unwrap();
    assert_eq!(latest.query().limit(), 200);
    assert_eq!(latest.query().anchor(), &MessageWindowAnchor::Latest);
    assert_eq!(latest.stream(), &MessageWindowStreamRequest::Mainline);

    let thread = request(&MessageWindowQueryWire {
        limit: Some("999".to_owned()),
        around_message_id: Some("reply-1".to_owned()),
        thread_root_id: Some("reply-2".to_owned()),
        ..MessageWindowQueryWire::default()
    })
    .unwrap();
    assert_eq!(thread.query().limit(), 500);
    assert_eq!(
        thread.query().anchor(),
        &MessageWindowAnchor::Around(MessageId::parse("reply-1").unwrap())
    );
    assert_eq!(
        thread.stream(),
        &MessageWindowStreamRequest::Thread(MessageId::parse("reply-2").unwrap())
    );

    assert_eq!(
        request(&MessageWindowQueryWire {
            before_seq: Some("1".to_owned()),
            after_seq: Some("2".to_owned()),
            ..MessageWindowQueryWire::default()
        }),
        Err(QueryRefusal::MultipleAnchors)
    );
    assert_eq!(
        request(&MessageWindowQueryWire {
            before_seq: Some("-1".to_owned()),
            ..MessageWindowQueryWire::default()
        }),
        Err(QueryRefusal::Before)
    );
    assert_eq!(
        request(&MessageWindowQueryWire {
            thread_root_id: Some(String::new()),
            ..MessageWindowQueryWire::default()
        }),
        Err(QueryRefusal::ThreadRoot)
    );
    assert_eq!(
        request(&MessageWindowQueryWire {
            limit: Some("1.5".to_owned()),
            ..MessageWindowQueryWire::default()
        }),
        Err(QueryRefusal::Limit)
    );
    assert_eq!(
        request(&MessageWindowQueryWire {
            limit: Some("Infinity".to_owned()),
            ..MessageWindowQueryWire::default()
        })
        .unwrap()
        .query()
        .limit(),
        200
    );
}

#[derive(Clone)]
struct SplicedRead {
    source_viewer: UserId,
    source_conversation: ConversationId,
    source_request: ConversationMessageWindowRequest,
}

impl ConversationMessageWindowReadPort for SplicedRead {
    type Error = Infallible;

    async fn read(
        &self,
        _viewer: &UserId,
        _conversation: &ConversationId,
        _request: ConversationMessageWindowRequest,
    ) -> Result<Result<ConversationMessageWindow, MessageWindowRefusal>, Self::Error> {
        Ok(Ok(empty_window(
            self.source_viewer.clone(),
            self.source_conversation.clone(),
            self.source_request.clone(),
        )))
    }
}

fn empty_window(
    viewer: UserId,
    conversation: ConversationId,
    request: ConversationMessageWindowRequest,
) -> ConversationMessageWindow {
    let stream = ResolvedMessageWindowStream::mainline(conversation.clone());
    let head =
        MessageWindowHead::projected(conversation.clone(), None, MessageSeq::try_from(0).unwrap())
            .unwrap();
    let audience =
        MessageWindowAudienceFact::admitted(viewer, conversation.clone(), true, false).unwrap();
    ConversationMessageWindow::sealed(
        audience,
        request,
        stream,
        head,
        Vec::new(),
        Vec::new(),
        WindowBoundaryFact::empty(conversation.clone(), None, WindowBoundaryDirection::Before),
        WindowBoundaryFact::empty(conversation, None, WindowBoundaryDirection::After),
    )
    .unwrap()
}

fn user(id: &str) -> UserId {
    UserId::parse(id).unwrap()
}

fn conversation(id: &str) -> ConversationId {
    ConversationId::parse(id).unwrap()
}

fn latest(limit: u16) -> ConversationMessageWindowRequest {
    ConversationMessageWindowRequest::new(
        MessageWindowStreamRequest::Mainline,
        limit,
        MessageWindowAnchor::Latest,
    )
    .unwrap()
}

async fn call(port: SplicedRead) -> (StatusCode, Value) {
    let app = router(port);
    let mut request = Request::builder()
        .uri("/api/channels/a/messages?limit=1")
        .body(Body::empty())
        .unwrap();
    request.extensions_mut().insert(user("viewer-a"));
    let response = app.oneshot(request).await.unwrap();
    let status = response.status();
    let body =
        serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap();
    (status, body)
}

#[tokio::test]
async fn viewer_conversation_and_query_are_each_bound_before_success_projection() {
    for (name, port) in [
        (
            "viewer",
            SplicedRead {
                source_viewer: user("viewer-b"),
                source_conversation: conversation("a"),
                source_request: latest(1),
            },
        ),
        (
            "conversation",
            SplicedRead {
                source_viewer: user("viewer-a"),
                source_conversation: conversation("b"),
                source_request: latest(1),
            },
        ),
        (
            "query",
            SplicedRead {
                source_viewer: user("viewer-a"),
                source_conversation: conversation("a"),
                source_request: latest(2),
            },
        ),
    ] {
        let (status, body) = call(port).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{name}");
        assert_eq!(body, json!({"error":"internal error"}), "{name}");
    }

    let (status, body) = call(SplicedRead {
        source_viewer: user("viewer-a"),
        source_conversation: conversation("a"),
        source_request: latest(1),
    })
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body,
        json!({
            "messages": [],
            "reply_counts_by_root": {},
            "reply_summaries_by_root": {},
            "reply_previews_by_root": {},
            "has_more_before": false,
            "stream_head_seq": 0,
            "has_more_after": false,
        })
    );
}

#[derive(Clone)]
struct OrderingRead {
    admission: Result<(), MessageWindowRefusal>,
    reads: Arc<AtomicUsize>,
}

impl ConversationMessageWindowReadPort for OrderingRead {
    type Error = Infallible;

    async fn read(
        &self,
        _viewer: &UserId,
        _conversation: &ConversationId,
        _request: ConversationMessageWindowRequest,
    ) -> Result<Result<ConversationMessageWindow, MessageWindowRefusal>, Self::Error> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        Ok(Err(self
            .admission
            .expect_err("test expects denied snapshot")))
    }
}

async fn ordered_call(port: OrderingRead, uri: &str) -> (StatusCode, Value) {
    let app = router(port);
    let mut request = Request::builder().uri(uri).body(Body::empty()).unwrap();
    request.extensions_mut().insert(user("viewer"));
    let response = app.oneshot(request).await.unwrap();
    let status = response.status();
    let body =
        serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap();
    (status, body)
}

#[tokio::test]
async fn invalid_coordinates_are_rejected_before_the_snapshot_read() {
    let reads = Arc::new(AtomicUsize::new(0));
    let (status, body) = ordered_call(
        OrderingRead {
            admission: Ok(()),
            reads: reads.clone(),
        },
        "/api/channels/c/messages?before_seq=bad&after_seq=also-bad",
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        body,
        json!({
            "error":"before_seq must be a non-negative integer",
            "code":"invalid_cursor"
        })
    );
    assert_eq!(reads.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn a_valid_request_calls_the_authoritative_read_exactly_once() {
    let reads = Arc::new(AtomicUsize::new(0));
    let (status, body) = ordered_call(
        OrderingRead {
            admission: Err(MessageWindowRefusal::Forbidden),
            reads: reads.clone(),
        },
        "/api/channels/c/messages?limit=50",
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"], "forbidden");
    assert_eq!(reads.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn unsafe_but_persistable_cursors_keep_their_actual_anchor_in_the_wire_refusal() {
    for (anchor, message) in [
        ("before_seq", "before_seq must be a non-negative integer"),
        ("after_seq", "after_seq must be a non-negative integer"),
    ] {
        let reads = Arc::new(AtomicUsize::new(0));
        let uri = format!("/api/channels/c/messages?{anchor}=9007199254740992");
        let (status, body) = ordered_call(
            OrderingRead {
                admission: Ok(()),
                reads: reads.clone(),
            },
            &uri,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{anchor}");
        assert_eq!(
            body,
            json!({"error":message,"code":"invalid_cursor"}),
            "{anchor}"
        );
        assert_eq!(reads.load(Ordering::SeqCst), 0, "{anchor}");
    }
}
