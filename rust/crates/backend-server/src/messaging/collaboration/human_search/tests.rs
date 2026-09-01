use std::{convert::Infallible, sync::Arc};

use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde::Deserialize;
use serde_json::{Value, json};
use silverhand_backend_core::{
    foundation::identity::UserId,
    messaging::collaboration::human_search::{
        HumanSearchMessageCountFact, HumanSearchOrder, HumanSearchPage, HumanSearchQuery,
        HumanSearchReadPort, HumanSearchRefusal, HumanSearchStream, HumanSearchText,
        ResolvedHumanSearchQuery, SelectedHumanSearchThreadAnchor,
    },
};
use tower::ServiceExt;

use super::*;

#[derive(Clone, Copy)]
enum Mode {
    Happy,
    ForeignViewer,
    ForeignQuery,
    ThreadNotFound,
}

#[derive(Clone)]
struct FakePort {
    mode: Mode,
    calls: Arc<std::sync::atomic::AtomicUsize>,
}

impl HumanSearchReadPort for FakePort {
    type Error = Infallible;

    async fn search(
        &self,
        viewer: &UserId,
        query: HumanSearchQuery,
    ) -> Result<Result<HumanSearchPage, HumanSearchRefusal>, Self::Error> {
        self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if matches!(self.mode, Mode::ThreadNotFound) {
            return Ok(Err(HumanSearchRefusal::ThreadRootNotFound));
        }
        let source = if matches!(self.mode, Mode::ForeignViewer) {
            UserId::parse("other").unwrap()
        } else {
            viewer.clone()
        };
        let query = if matches!(self.mode, Mode::ForeignQuery) {
            HumanSearchQuery::admitted(
                HumanSearchText::parse("other").unwrap(),
                HumanSearchStream::All,
                None,
                None,
                None,
                None,
                None,
                None,
                HumanSearchOrder::RecencyDesc,
                80,
            )
            .unwrap()
        } else {
            query
        };
        let resolved = if matches!(query.stream(), HumanSearchStream::Thread) {
            let root = query.thread_root().unwrap().clone();
            let conversation = query.conversation().unwrap().clone();
            ResolvedHumanSearchQuery::thread_resolved(
                source.clone(),
                query.clone(),
                SelectedHumanSearchThreadAnchor::from_rows(root, conversation, None, None).unwrap(),
            )
            .unwrap()
        } else {
            ResolvedHumanSearchQuery::direct(query.clone()).unwrap()
        };
        let count = if query.has_search_intent() {
            HumanSearchMessageCountFact::counted(source.clone(), query, 0).unwrap()
        } else {
            HumanSearchMessageCountFact::skipped()
        };
        Ok(Ok(HumanSearchPage::sealed(
            source,
            resolved,
            Vec::new(),
            Vec::new(),
            Vec::new(),
            count,
        )
        .unwrap()))
    }
}

fn app(mode: Mode) -> (Router, Arc<std::sync::atomic::AtomicUsize>) {
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    (
        router(FakePort {
            mode,
            calls: Arc::clone(&calls),
        }),
        calls,
    )
}

async fn call(app: Router, uri: &str, authenticated: bool) -> (StatusCode, Value) {
    let mut request = Request::builder().uri(uri).body(Body::empty()).unwrap();
    if authenticated {
        request
            .extensions_mut()
            .insert(UserId::parse("local").unwrap());
    }
    let response = app.oneshot(request).await.unwrap();
    let status = response.status();
    let body =
        serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap();
    (status, body)
}

#[tokio::test]
async fn defaults_and_refinements_are_admitted_before_the_read() {
    let (app, calls) = app(Mode::Happy);
    let (status, body) = call(app.clone(), "/api/search?q=%20needle%20", true).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body,
        json!({
            "query": {"q":"needle","stream":"all","order":"recency_desc","limit":80},
            "results": [],
            "total": 0,
            "truncated": false,
        })
    );

    for (uri, path) in [
        ("/api/search?q=x&stream=mainline", "stream"),
        (
            "/api/search?q=x&conversation_id=c&stream=thread",
            "thread_root_id",
        ),
        ("/api/search?q=x&order=seq_asc", "order"),
        ("/api/search?q=x&user_id=u&agent_id=a", "user_id"),
    ] {
        let (status, body) = call(app.clone(), uri, true).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{uri}");
        assert!(body["error"]["fieldErrors"][path].is_array(), "{uri}");
    }
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
}

#[tokio::test]
async fn authentication_and_bound_page_are_hard_wire_gates() {
    let (happy, calls) = app(Mode::Happy);
    let (status, body) = call(happy, "/api/search?q=needle", false).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(body, json!({"error":"internal error"}));
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 0);

    let (foreign, calls) = app(Mode::ForeignViewer);
    let (status, body) = call(foreign, "/api/search?q=needle", true).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(body, json!({"error":"internal error"}));
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);

    let (foreign, calls) = app(Mode::ForeignQuery);
    let (status, body) = call(foreign, "/api/search?q=needle", true).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(body, json!({"error":"internal error"}));
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
}

#[tokio::test]
async fn thread_root_refusal_keeps_the_typescript_wire() {
    let (app, calls) = app(Mode::ThreadNotFound);
    let (status, body) = call(
        app,
        "/api/search?q=x&conversation_id=c&stream=thread&thread_root_id=root",
        true,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(
        body,
        json!({
            "error":"thread root message not found in this conversation",
            "code":"thread_root_not_found"
        })
    );
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
}

#[derive(Deserialize)]
struct AdmissionCell {
    name: String,
    query: String,
    schema_accepted: bool,
    parsed: Option<Value>,
    body: Option<Value>,
}

#[tokio::test]
async fn production_router_consumes_the_typescript_signed_admission_fixture() {
    let fixture: Vec<AdmissionCell> = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../packages/backend/tests/fixtures/human-search-admission.json"
    )))
    .unwrap();
    for cell in fixture {
        let (app, calls) = app(Mode::Happy);
        let (status, body) = call(app, &format!("/api/search{}", cell.query), true).await;
        if cell.schema_accepted {
            assert_eq!(status, StatusCode::OK, "{}", cell.name);
            assert_eq!(body["query"], cell.parsed.unwrap(), "{}", cell.name);
            assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        } else {
            assert_eq!(status, StatusCode::BAD_REQUEST, "{}", cell.name);
            assert_eq!(body, cell.body.unwrap(), "{}", cell.name);
            assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 0);
        }
    }
}
