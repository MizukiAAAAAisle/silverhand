use super::*;
use axum::{
    body::{Body, to_bytes},
    http::{Method, Request},
};
use std::{
    convert::Infallible,
    io,
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
        Ok(CommittedNotificationClear::committed(
            viewer,
            1,
            vec![WorkspaceId::parse("w").unwrap()],
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
    async fn badge_changed(
        &self,
        _: &CommittedNotificationClear,
        w: &WorkspaceId,
    ) -> Result<(), NotificationClearFailure> {
        self.0.lock().unwrap().push(format!("badge:{}", w.as_str()));
        Ok(())
    }
}
async fn call(
    app: Router,
    method: Method,
    path: &str,
    body: Value,
    auth: bool,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
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
        assert_eq!(effects.0.lock().unwrap().as_slice(), ["unread", "badge:w"]);
    }
}

#[tokio::test]
async fn a_wrong_typed_higher_priority_selector_never_falls_through_to_all() {
    let ports = Ports::default();
    let effects = Effects::default();
    let (status, body) = call(
        router(ports.clone(), ports.clone(), effects.clone()),
        Method::POST,
        READ_PATH,
        json!({"id":7,"all":true}),
        true,
    )
    .await;
    assert_eq!(
        (status, body),
        (StatusCode::BAD_REQUEST, json!({"error":"invalid input"}))
    );
    assert!(ports.calls.lock().unwrap().is_empty());
    assert!(effects.0.lock().unwrap().is_empty());
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
