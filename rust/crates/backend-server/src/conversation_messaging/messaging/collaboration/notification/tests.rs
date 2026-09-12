use super::*;
use axum::{
    body::{Body, to_bytes},
    http::{Method, Request, StatusCode},
};
use serde_json::{Value, json};
use std::{
    convert::Infallible,
    io,
    num::NonZeroU64,
    sync::{Arc, Mutex},
};
use tower::ServiceExt;

#[derive(Clone, Default)]
struct Ports {
    calls: Arc<Mutex<Vec<String>>>,
}
impl NotificationReadPort for Ports {
    type Error = Infallible;
    async fn list(
        &self,
        _: &UserId,
        q: NotificationListQuery,
    ) -> Result<Vec<Notification>, Self::Error> {
        self.calls
            .lock()
            .unwrap()
            .push(format!("list:{}:{}", q.unread_only, q.limit));
        Ok(vec![])
    }
    async fn unread_summary(&self, _: &UserId) -> Result<NotificationSummary, Self::Error> {
        self.calls.lock().unwrap().push("summary".into());
        Ok(NotificationSummary {
            total: 0,
            by_workspace: vec![],
            latest_by_workspace: vec![],
        })
    }
}
impl NotificationClearPort for Ports {
    type Error = Infallible;
    async fn clear(
        &self,
        viewer: UserId,
        s: NotificationClearSelector,
    ) -> Result<CommittedNotificationClear, Self::Error> {
        self.calls.lock().unwrap().push(
            match s {
                NotificationClearSelector::Id(_) => "id",
                NotificationClearSelector::Workspace(_) => "workspace",
                NotificationClearSelector::Conversation(_) => "conversation",
                NotificationClearSelector::All => "all",
            }
            .into(),
        );
        Ok(CommittedNotificationClear::changed(
            viewer,
            NonZeroU64::new(1).unwrap(),
        ))
    }
}
#[derive(Clone, Default)]
struct Effects(Arc<Mutex<Vec<String>>>);
impl NotificationAftermath for Effects {
    async fn unread_changed(
        &self,
        _: &CommittedNotificationClear,
    ) -> Result<(), NotificationClearFailure> {
        self.0.lock().unwrap().push("unread".into());
        Err(NotificationClearFailure::from_source(io::Error::other(
            "hub",
        )))
    }
}
async fn call(
    app: Router,
    method: Method,
    path: &str,
    body: Value,
    auth: bool,
) -> (StatusCode, Value) {
    call_raw(app, method, path, body.to_string(), auth).await
}

async fn call_raw(
    app: Router,
    method: Method,
    path: &str,
    body: String,
    auth: bool,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json")
        .body(Body::from(body))
        .unwrap();
    if auth {
        request.extensions_mut().insert(UserId::parse("u").unwrap());
    }
    let response = app.oneshot(request).await.unwrap();
    let status = response.status();
    let body =
        serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap();
    (status, body)
}

/// Like [`call_raw`] but returns only the status and never parses the body, for the
/// native structural rejections (400/415/422) whose bodies are axum's own plaintext,
/// not JSON.
async fn status_of(
    app: Router,
    method: Method,
    path: &str,
    body: String,
    auth: bool,
) -> StatusCode {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json")
        .body(Body::from(body))
        .unwrap();
    if auth {
        request.extensions_mut().insert(UserId::parse("u").unwrap());
    }
    app.oneshot(request).await.unwrap().status()
}

#[tokio::test]
async fn auth_refusal_reaches_no_product_port() {
    let ports = Ports::default();
    let effects = Effects::default();
    let (status, _) = call(
        router(ports.clone(), ports.clone(), effects.clone()),
        Method::POST,
        READ_PATH,
        json!({"all":true}),
        false,
    )
    .await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert!(ports.calls.lock().unwrap().is_empty());
    assert!(effects.0.lock().unwrap().is_empty());
}

#[tokio::test]
async fn four_selectors_map_exactly_and_effect_failure_keeps_committed_200() {
    for (body, expected) in [
        (json!({"id":"n"}), "id"),
        (json!({"workspace_id":"w"}), "workspace"),
        (json!({"conversation_id":"c"}), "conversation"),
        (json!({"all":true}), "all"),
    ] {
        let ports = Ports::default();
        let effects = Effects::default();
        let (status, body) = call(
            router(ports.clone(), ports.clone(), effects.clone()),
            Method::POST,
            READ_PATH,
            body,
            true,
        )
        .await;
        assert_eq!((status, body), (StatusCode::OK, json!({"marked":1})));
        assert_eq!(ports.calls.lock().unwrap().as_slice(), [expected]);
        assert_eq!(effects.0.lock().unwrap().as_slice(), ["unread"]);
    }
}

#[tokio::test]
async fn a_wrong_typed_higher_priority_selector_is_native_422_with_zero_reach() {
    // `{"id":7,"all":true}` — `id` is a wrong field type. Under `ValidatedJson`'s
    // object-only path this is axum's native `JsonDataError` → 422 with the native
    // body (NOT the old Zod 400 + issues array, and NOT a fall-through to `all`).
    // No selector is derived, so neither the clear port nor the aftermath is reached.
    let ports = Ports::default();
    let effects = Effects::default();
    let status = status_of(
        router(ports.clone(), ports.clone(), effects.clone()),
        Method::POST,
        READ_PATH,
        json!({"id":7,"all":true}).to_string(),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(ports.calls.lock().unwrap().is_empty());
    assert!(effects.0.lock().unwrap().is_empty());
}

// ===================== admission falsifiers (refusal plane) =====================
//
// The shared `notification-wire.json` oracle carries only the ACCEPTED plane (the
// drift-prone parity boundary). The refusal plane is the Rust migration's sanctioned
// divergence from the TS Zod path (native structural 400/415/422 + a minimal
// semantic 422, no issue array), so it is pinned here, per-implementation. Every
// refusal reaches neither the clear port nor the aftermath.

#[tokio::test]
async fn a_value_shaped_positional_array_never_reaches_the_authority() {
    // The sharp bypass: a JSON array whose first element is a valid selector string
    // would positionally bind to `id` on a naive `#[derive(Deserialize)]` struct.
    // `ObjectOnly<T>` rejects the non-object shape structurally (native 422) before
    // any bind, so the value-shaped array can NEVER reach the clear authority. This
    // falsifier fails the instant object-only admission regresses.
    let ports = Ports::default();
    let effects = Effects::default();
    let status = status_of(
        router(ports.clone(), ports.clone(), effects.clone()),
        Method::POST,
        READ_PATH,
        r#"["notification-1"]"#.to_owned(),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(ports.calls.lock().unwrap().is_empty());
    assert!(effects.0.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_scalar_body_is_native_422_with_zero_reach() {
    let ports = Ports::default();
    let effects = Effects::default();
    let status = status_of(
        router(ports.clone(), ports.clone(), effects.clone()),
        Method::POST,
        READ_PATH,
        "true".to_owned(),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(ports.calls.lock().unwrap().is_empty());
    assert!(effects.0.lock().unwrap().is_empty());
}

#[tokio::test]
async fn malformed_json_is_native_400_with_zero_reach() {
    let ports = Ports::default();
    let effects = Effects::default();
    let status = status_of(
        router(ports.clone(), ports.clone(), effects.clone()),
        Method::POST,
        READ_PATH,
        "{".to_owned(),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(ports.calls.lock().unwrap().is_empty());
    assert!(effects.0.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_missing_content_type_is_native_415_with_zero_reach() {
    let ports = Ports::default();
    let effects = Effects::default();
    let request = Request::builder()
        .method(Method::POST)
        .uri(READ_PATH)
        .body(Body::from(r#"{"all":true}"#.to_owned()))
        .unwrap();
    let mut request = request;
    request.extensions_mut().insert(UserId::parse("u").unwrap());
    let response = router(ports.clone(), ports.clone(), effects.clone())
        .oneshot(request)
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
    assert!(ports.calls.lock().unwrap().is_empty());
    assert!(effects.0.lock().unwrap().is_empty());
}

#[tokio::test]
async fn the_empty_and_all_false_bodies_are_minimal_semantic_422_with_zero_reach() {
    // The schema `.refine` (at least one selector): a blank body, an all-empty body,
    // and `{"all":false}` each fail the ONE container rule → the minimal semantic
    // `422 {"error":"invalid input"}` (no issues array). Unknown keys are stripped,
    // so `{"unknown":"x"}` is still selector-less. None reach the authority.
    for body in [
        json!({}),
        json!({"id":"","workspace_id":"","conversation_id":""}),
        json!({"all":false}),
        json!({"unknown":"x"}),
    ] {
        let ports = Ports::default();
        let effects = Effects::default();
        let (status, response) = call(
            router(ports.clone(), ports.clone(), effects.clone()),
            Method::POST,
            READ_PATH,
            body.clone(),
            true,
        )
        .await;
        assert_eq!(
            (status, response),
            (
                StatusCode::UNPROCESSABLE_ENTITY,
                json!({"error":"invalid input"})
            ),
            "{body}"
        );
        assert!(ports.calls.lock().unwrap().is_empty(), "{body}");
        assert!(effects.0.lock().unwrap().is_empty(), "{body}");
    }
}

#[tokio::test]
async fn list_limit_matches_parse_int_clamp_contract() {
    let ports = Ports::default();
    let (status, body) = call(
        router(ports.clone(), ports.clone(), Effects::default()),
        Method::GET,
        "/api/notifications?unread=1&limit=501garbage",
        Value::Null,
        true,
    )
    .await;
    assert_eq!(
        (status, body),
        (StatusCode::OK, json!({"notifications":[]}))
    );
    assert_eq!(ports.calls.lock().unwrap().as_slice(), ["list:true:500"]);
}

#[derive(Clone, Default)]
struct FixturePorts {
    calls: Arc<Mutex<Vec<String>>>,
}

impl NotificationReadPort for FixturePorts {
    type Error = Infallible;

    async fn list(
        &self,
        _: &UserId,
        query: NotificationListQuery,
    ) -> Result<Vec<Notification>, Self::Error> {
        self.calls
            .lock()
            .unwrap()
            .push(format!("list:{}:{}", query.unread_only, query.limit));
        Ok(vec![Notification {
            id: NotificationId::parse("notification-1").unwrap(),
            kind: NotificationKind::AgentStartFailed,
            user: Some(UserId::parse("user-1").unwrap()),
            agent: None,
            workspace: None,
            conversation: None,
            message: None,
            thread_root: None,
            source_workspace: None,
            source_conversation: None,
            source_message: None,
            payload_json: Some(r#"{"code":"missing-runtime"}"#.into()),
            read_at: None,
            created_at: NotificationTimestamp::new(100).unwrap(),
        }])
    }

    async fn unread_summary(&self, _: &UserId) -> Result<NotificationSummary, Self::Error> {
        self.calls.lock().unwrap().push("summary".into());
        Ok(NotificationSummary {
            total: 3,
            by_workspace: vec![(WorkspaceId::parse("workspace-1").unwrap(), 2)],
            latest_by_workspace: vec![(
                WorkspaceId::parse("workspace-1").unwrap(),
                UnreadAnchor {
                    conversation: ConversationId::parse("conversation-1").unwrap(),
                    message: silverhand_backend_core::conversation_messaging::messaging::MessageId::parse("message-1")
                        .unwrap(),
                    thread_root: None,
                },
            )],
        })
    }
}

impl NotificationClearPort for FixturePorts {
    type Error = Infallible;

    async fn clear(
        &self,
        viewer: UserId,
        selector: NotificationClearSelector,
    ) -> Result<CommittedNotificationClear, Self::Error> {
        let (call, marked) = match selector {
            NotificationClearSelector::Id(_) => ("id", 1),
            NotificationClearSelector::Workspace(_) => ("workspace", 2),
            NotificationClearSelector::Conversation(_) => ("conversation", 3),
            NotificationClearSelector::All => ("all", 4),
        };
        self.calls.lock().unwrap().push(call.into());
        Ok(CommittedNotificationClear::changed(
            viewer,
            NonZeroU64::new(marked).unwrap(),
        ))
    }
}

fn fixture_body<'a>(fixture: &'a Value, entry: &'a Value) -> &'a Value {
    if let Some(name) = entry.get("body_case").and_then(Value::as_str) {
        let source = fixture
            .as_array()
            .unwrap()
            .iter()
            .find(|candidate| candidate["name"] == name)
            .unwrap();
        fixture_body(fixture, source)
    } else {
        &entry["body"]
    }
}

#[tokio::test]
async fn production_router_consumes_the_ts_signed_notification_wire_closed_set() {
    let fixture: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../rust/test-fixtures/fixtures/notification-wire.json"
    )))
    .unwrap();
    let mut surfaces = std::collections::BTreeSet::new();
    for entry in fixture.as_array().unwrap() {
        surfaces.insert(entry["surface"].as_str().unwrap());
        let ports = FixturePorts::default();
        let method = match entry["method"].as_str().unwrap() {
            "GET" => Method::GET,
            "POST" => Method::POST,
            other => panic!("unknown fixture method {other}"),
        };
        let raw = entry
            .get("raw_request")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| entry.get("request").unwrap_or(&Value::Null).to_string());
        let (status, body) = call_raw(
            router(ports.clone(), ports.clone(), Effects::default()),
            method,
            entry["path"].as_str().unwrap(),
            raw,
            true,
        )
        .await;
        assert_eq!(
            status.as_u16(),
            entry["status"].as_u64().unwrap() as u16,
            "{}",
            entry["name"]
        );
        assert_eq!(&body, fixture_body(&fixture, entry), "{}", entry["name"]);
        let expected_calls = entry
            .get("call")
            .and_then(Value::as_str)
            .map(|call| vec![call.to_owned()])
            .unwrap_or_default();
        assert_eq!(
            *ports.calls.lock().unwrap(),
            expected_calls,
            "{} owner",
            entry["name"]
        );
    }
    assert_eq!(
        surfaces,
        std::collections::BTreeSet::from(["clear", "list", "unread"])
    );
    assert_eq!(fixture.as_array().unwrap().len(), 13);
}
