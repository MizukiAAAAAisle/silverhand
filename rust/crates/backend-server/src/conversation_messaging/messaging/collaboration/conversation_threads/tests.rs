use std::{
    convert::Infallible,
    sync::{Arc, Mutex},
};

use axum::{
    body::{Body, to_bytes},
    http::Request,
};
use serde_json::{Value, json};
use silverhand_backend_core::{
    conversation_messaging::messaging::{
        MessageAuthor, MessageId, MessageSeq, ThreadRootId,
        collaboration::conversation_threads::{
            ConversationThreadsPage, ConversationThreadsReadPort, ConversationThreadsRefusal,
            SelectedConversationThread, ThreadListQuery,
        },
    },
    foundation::identity::{ConversationId, UserId},
};
use tower::ServiceExt;

use super::*;

#[derive(Clone)]
struct ProjectedPage {
    page_viewer: &'static str,
    page_conversation: &'static str,
    page_query: Option<ThreadListQuery>,
    calls: Arc<Mutex<Vec<&'static str>>>,
}

impl ConversationThreadsReadPort for ProjectedPage {
    type Error = Infallible;

    async fn admit(
        &self,
        _: &UserId,
        _: &ConversationId,
    ) -> Result<Result<(), ConversationThreadsRefusal>, Self::Error> {
        self.calls.lock().unwrap().push("admit");
        Ok(Ok(()))
    }

    async fn read(
        &self,
        _: &UserId,
        _: &ConversationId,
        query: ThreadListQuery,
    ) -> Result<Result<ConversationThreadsPage, ConversationThreadsRefusal>, Self::Error> {
        self.calls.lock().unwrap().push("read");
        Ok(Ok(page(
            self.page_viewer,
            self.page_conversation,
            self.page_query.unwrap_or(query),
        )))
    }
}

fn page(viewer: &str, conversation: &str, query: ThreadListQuery) -> ConversationThreadsPage {
    let conversation_id = ConversationId::parse(conversation).unwrap();
    let thread = SelectedConversationThread::seal(
        conversation_id.clone(),
        conversation_id.clone(),
        ThreadRootId::parse("root").unwrap(),
        Some(MessageAuthor::active_human(
            UserId::parse("root-author").unwrap(),
            "root-author".to_owned(),
            "Root Author".to_owned(),
            None,
        )),
        "root body",
        10,
        MessageSeq::try_from(1).unwrap(),
        1,
        20,
        MessageSeq::try_from(2).unwrap(),
        conversation_id.clone(),
        ThreadRootId::parse("root").unwrap(),
        MessageId::parse("reply").unwrap(),
        vec![MessageAuthor::active_human(
            UserId::parse("replier").unwrap(),
            "replier".to_owned(),
            "Replier".to_owned(),
            None,
        )],
        1,
        true,
    )
    .unwrap();
    ConversationThreadsPage::sealed(
        UserId::parse(viewer).unwrap(),
        conversation_id,
        query,
        vec![thread],
        false,
    )
    .unwrap()
}

async fn call(port: ProjectedPage, uri: &str, authenticated: bool) -> (StatusCode, Value) {
    let mut request = Request::builder().uri(uri).body(Body::empty()).unwrap();
    if authenticated {
        request
            .extensions_mut()
            .insert(UserId::parse("viewer-a").unwrap());
    }
    let response = router(port).oneshot(request).await.unwrap();
    let status = response.status();
    let body =
        serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap();
    (status, body)
}

fn fixture_port(viewer: &'static str, conversation: &'static str) -> ProjectedPage {
    ProjectedPage {
        page_viewer: viewer,
        page_conversation: conversation,
        page_query: None,
        calls: Arc::new(Mutex::new(Vec::new())),
    }
}

#[tokio::test]
async fn auth_and_admission_precede_query_and_read() {
    let port = fixture_port("viewer-a", "conversation-a");
    let calls = Arc::clone(&port.calls);
    let (status, _) = call(port, "/api/conversations/conversation-a/threads", false).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert!(calls.lock().unwrap().is_empty());

    for (query, expected) in [
        (
            "limit=0",
            json!({"error":"invalid limit","code":"invalid_limit"}),
        ),
        (
            "cursor=broken",
            json!({"error":"invalid cursor","code":"invalid_cursor"}),
        ),
        (
            "filter=unknown",
            json!({"error":"invalid filter","code":"invalid_filter"}),
        ),
    ] {
        let port = fixture_port("viewer-a", "conversation-a");
        let calls = Arc::clone(&port.calls);
        let (status, body) = call(
            port,
            &format!("/api/conversations/conversation-a/threads?{query}"),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body, expected);
        assert_eq!(&*calls.lock().unwrap(), &["admit"]);
    }
}

#[tokio::test]
async fn returned_viewer_conversation_and_query_bind_before_wire() {
    for (viewer, conversation, forced_query, expected) in [
        (
            "viewer-b",
            "conversation-a",
            None,
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
        (
            "viewer-a",
            "conversation-b",
            None,
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
        (
            "viewer-a",
            "conversation-a",
            Some(ThreadListQuery::new(1, None, ThreadListFilter::FollowedUnread).unwrap()),
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
        ("viewer-a", "conversation-a", None, StatusCode::OK),
    ] {
        let mut port = fixture_port(viewer, conversation);
        port.page_query = forced_query;
        let (status, body) = call(
            port,
            "/api/conversations/conversation-a/threads?limit=1&filter=all",
            true,
        )
        .await;
        assert_eq!(status, expected);
        if expected == StatusCode::OK {
            assert_eq!(
                body,
                json!({
                    "threads":[{
                        "root_message_id":"root",
                        "root_author":{
                            "status":"active","kind":"user","id":"root-author",
                            "name":"root-author","display_name":"Root Author",
                            "avatar_url":null,"runtime":null
                        },
                        "root_preview":"root body","root_created_at":10,"root_seq":1,
                        "reply_count":1,"last_reply_at":20,"last_reply_message_id":"reply",
                        "repliers":[{
                            "status":"active","kind":"user","id":"replier",
                            "name":"replier","display_name":"Replier",
                            "avatar_url":null,"runtime":null
                        }],
                        "replier_total":1,"viewer_following":true
                    }],
                    "next_cursor":null
                })
            );
        } else {
            assert_eq!(body, json!({"error":"internal error"}));
        }
    }
}

#[test]
fn query_and_cursor_are_the_single_wire_admission_boundary() {
    assert_eq!(page_query(&ThreadsQuery::default()).unwrap().limit(), 30);
    assert_eq!(
        page_query(&ThreadsQuery {
            limit: Some("1e20".to_owned()),
            cursor: None,
            filter: None,
        })
        .unwrap()
        .limit(),
        50
    );
    assert_eq!(
        page_query(&ThreadsQuery {
            limit: Some("0".to_owned()),
            cursor: None,
            filter: None,
        }),
        Err(QueryRefusal::Limit)
    );
    let cursor = ThreadListCursor::new(20, MessageSeq::try_from(3).unwrap()).unwrap();
    let wire = encode_cursor(cursor);
    assert_eq!(wire, "WzIwLDNd");
    assert_eq!(decode_cursor(&wire), Ok(cursor));
    assert_eq!(decode_cursor("broken"), Err(QueryRefusal::Cursor));
    assert_eq!(
        page_query(&ThreadsQuery {
            limit: None,
            cursor: None,
            filter: Some("unknown".to_owned()),
        }),
        Err(QueryRefusal::Filter)
    );
}
