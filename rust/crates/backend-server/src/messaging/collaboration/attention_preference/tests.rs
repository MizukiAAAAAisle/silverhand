use super::*;
use axum::{
    body::{Body, to_bytes},
    http::{Method, Request},
};
use silverhand_backend_core::messaging::collaboration::attention_preference::{
    AttentionPreferenceEffectFailure, WorkspaceAttentionPreference,
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
impl AttentionPreferencePort for Ports {
    type Error = Infallible;
    async fn set_channel(
        &self,
        viewer: UserId,
        conversation: ConversationId,
        mode: Option<ChannelAttentionMode>,
    ) -> Result<Result<CommittedAttentionPreference, AttentionPreferenceRefusal>, Self::Error> {
        self.calls.lock().unwrap().push(format!(
            "channel:{}",
            mode.map(ChannelAttentionMode::as_str).unwrap_or("invalid")
        ));
        if conversation.as_str() == "missing" {
            return Ok(Err(AttentionPreferenceRefusal::ChannelNotFound));
        }
        if conversation.as_str() == "forbidden" {
            return Ok(Err(AttentionPreferenceRefusal::Forbidden));
        }
        let Some(mode) = mode else {
            return Ok(Err(AttentionPreferenceRefusal::InvalidInput));
        };
        Ok(Ok(CommittedAttentionPreference::channel(
            viewer,
            WorkspaceId::parse("w").unwrap(),
            conversation,
            mode,
        )))
    }
    async fn get_workspace(
        &self,
        _: &UserId,
        workspace: WorkspaceId,
    ) -> Result<Result<WorkspaceAttentionPreference, AttentionPreferenceRefusal>, Self::Error> {
        self.calls.lock().unwrap().push("workspace:get".into());
        match workspace.as_str() {
            "forbidden" => Ok(Err(AttentionPreferenceRefusal::Forbidden)),
            "home" => Ok(Err(AttentionPreferenceRefusal::WorkspaceNotFound)),
            _ => Ok(Ok(WorkspaceAttentionPreference::projected(
                workspace, false,
            ))),
        }
    }
    async fn set_workspace(
        &self,
        viewer: UserId,
        workspace: WorkspaceId,
        muted: Option<bool>,
    ) -> Result<Result<CommittedAttentionPreference, AttentionPreferenceRefusal>, Self::Error> {
        self.calls.lock().unwrap().push(format!(
            "workspace:{}",
            muted
                .map(|v| if v { "true" } else { "false" })
                .unwrap_or("invalid")
        ));
        if matches!(workspace.as_str(), "forbidden" | "missing") {
            return Ok(Err(AttentionPreferenceRefusal::Forbidden));
        }
        if workspace.as_str() == "home" {
            return Ok(Err(AttentionPreferenceRefusal::WorkspaceNotFound));
        }
        let Some(muted) = muted else {
            return Ok(Err(AttentionPreferenceRefusal::InvalidInput));
        };
        Ok(Ok(CommittedAttentionPreference::workspace(
            viewer, workspace, muted,
        )))
    }
}

#[derive(Clone, Default)]
struct Effects(Arc<Mutex<Vec<String>>>);
impl AttentionPreferenceAftermath for Effects {
    async fn preference_changed(
        &self,
        fact: &CommittedAttentionPreference,
    ) -> Result<(), AttentionPreferenceEffectFailure> {
        self.0.lock().unwrap().push(format!(
            "pref:{}:{}",
            fact.viewer().as_str(),
            fact.conversation_id()
                .map_or("null", ConversationId::as_str)
        ));
        Err(AttentionPreferenceEffectFailure::from_source(
            io::Error::other("hub"),
        ))
    }
    async fn badge_changed(
        &self,
        fact: &CommittedAttentionPreference,
    ) -> Result<(), AttentionPreferenceEffectFailure> {
        self.0
            .lock()
            .unwrap()
            .push(format!("badge:{}", fact.workspace_id().as_str()));
        Ok(())
    }
}

async fn call(
    app: Router,
    method: Method,
    path: &str,
    raw: &str,
    auth: bool,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json")
        .body(Body::from(raw.to_owned()))
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
async fn three_routes_return_exact_success_and_both_effects_are_attempted() {
    let ports = Ports::default();
    let effects = Effects::default();
    let (status, body) = call(
        router(ports.clone(), effects.clone()),
        Method::PUT,
        "/api/conversations/c/attention-preference",
        r#"{"mode":"mentions"}"#,
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({"conversation_id":"c","mode":"mentions"}));
    assert_eq!(*effects.0.lock().unwrap(), ["pref:u:c", "badge:w"]);

    let (status, body) = call(
        router(ports.clone(), effects.clone()),
        Method::GET,
        "/api/workspaces/w/attention-preference",
        "",
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({"workspace_id":"w","muted":false}));
    let (status, body) = call(
        router(ports, effects),
        Method::PUT,
        "/api/workspaces/w/attention-preference",
        r#"{"muted":true}"#,
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({"workspace_id":"w","muted":true}));
}

#[tokio::test]
async fn target_and_access_refusals_precede_invalid_body() {
    let ports = Ports::default();
    let effects = Effects::default();
    for (path, expected) in [
        (
            "/api/conversations/missing/attention-preference",
            StatusCode::NOT_FOUND,
        ),
        (
            "/api/conversations/forbidden/attention-preference",
            StatusCode::FORBIDDEN,
        ),
    ] {
        let (status, _) = call(
            router(ports.clone(), effects.clone()),
            Method::PUT,
            path,
            r#"{"mode":"loud"}"#,
            true,
        )
        .await;
        assert_eq!(status, expected, "{path}");
    }
    let (status, body) = call(
        router(ports, effects),
        Method::PUT,
        "/api/conversations/c/attention-preference",
        r#"{"mode":"loud"}"#,
        true,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "invalid input");
}

#[tokio::test]
async fn workspace_visibility_and_kind_precede_body_and_map_exactly() {
    for (path, expected, error_body) in [
        (
            "/api/workspaces/forbidden/attention-preference",
            StatusCode::FORBIDDEN,
            "forbidden",
        ),
        (
            "/api/workspaces/home/attention-preference",
            StatusCode::NOT_FOUND,
            "workspace not found",
        ),
    ] {
        let (status, body) = call(
            router(Ports::default(), Effects::default()),
            Method::PUT,
            path,
            r#"{"muted":"yes"}"#,
            true,
        )
        .await;
        assert_eq!(status, expected);
        assert_eq!(body, json!({"error":error_body}));
    }
}

#[tokio::test]
async fn authentication_refusal_reaches_no_product_or_effect_port() {
    let ports = Ports::default();
    let effects = Effects::default();
    let (status, _) = call(
        router(ports.clone(), effects.clone()),
        Method::PUT,
        "/api/workspaces/w/attention-preference",
        r#"{"muted":true}"#,
        false,
    )
    .await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert!(ports.calls.lock().unwrap().is_empty());
    assert!(effects.0.lock().unwrap().is_empty());
}

#[tokio::test]
async fn production_router_consumes_the_ts_signed_three_route_closed_set() {
    let fixture: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../packages/backend/tests/fixtures/attention-preference-wire.json"
    )))
    .unwrap();
    let mut surfaces = std::collections::BTreeSet::new();
    for entry in fixture.as_array().unwrap() {
        surfaces.insert(entry["surface"].as_str().unwrap());
        let method = match entry["method"].as_str().unwrap() {
            "GET" => Method::GET,
            "PUT" => Method::PUT,
            other => panic!("unknown fixture method {other}"),
        };
        let raw = entry.get("request").unwrap_or(&Value::Null).to_string();
        let (status, body) = call(
            router(Ports::default(), Effects::default()),
            method,
            entry["path"].as_str().unwrap(),
            &raw,
            true,
        )
        .await;
        assert_eq!(
            status.as_u16(),
            entry["status"].as_u64().unwrap() as u16,
            "{}",
            entry["name"]
        );
        assert_eq!(body, entry["body"], "{}", entry["name"]);
    }
    assert_eq!(
        surfaces,
        std::collections::BTreeSet::from(["channel_put", "workspace_get", "workspace_put"])
    );
    assert_eq!(fixture.as_array().unwrap().len(), 8);
}
