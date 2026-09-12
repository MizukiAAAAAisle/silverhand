use super::*;
use serde_json::{Value, json};
use axum::{
    body::{Body, Bytes, to_bytes},
    http::{Method, Request},
};
use futures_util::stream;
use silverhand_backend_core::conversation_messaging::messaging::collaboration::attention_preference::{
    AttentionPreferenceEffectFailure, WorkspaceAttentionPreference,
};
use std::{
    convert::Infallible,
    io,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tower::ServiceExt;

struct ChannelTarget {
    viewer: UserId,
    conversation: ConversationId,
}
struct WorkspaceTarget {
    viewer: UserId,
    workspace: WorkspaceId,
}
struct ChannelFact {
    viewer: UserId,
    workspace: WorkspaceId,
    conversation: ConversationId,
    mode: ChannelAttentionMode,
}
impl ChannelAttentionCommit for ChannelFact {
    fn viewer(&self) -> &UserId {
        &self.viewer
    }
    fn workspace(&self) -> &WorkspaceId {
        &self.workspace
    }
    fn conversation(&self) -> &ConversationId {
        &self.conversation
    }
    fn mode(&self) -> ChannelAttentionMode {
        self.mode
    }
}
struct WorkspaceFact {
    viewer: UserId,
    workspace: WorkspaceId,
    muted: bool,
}
impl WorkspaceAttentionCommit for WorkspaceFact {
    fn viewer(&self) -> &UserId {
        &self.viewer
    }
    fn workspace(&self) -> &WorkspaceId {
        &self.workspace
    }
    fn muted(&self) -> bool {
        self.muted
    }
}
#[derive(Clone, Default)]
struct Ports {
    calls: Arc<Mutex<Vec<String>>>,
    body_polled: Arc<AtomicBool>,
}
impl AttentionPreferencePort for Ports {
    type Error = Infallible;
    type ChannelTarget = ChannelTarget;
    type WorkspaceTarget = WorkspaceTarget;
    type ChannelCommit = ChannelFact;
    type WorkspaceCommit = WorkspaceFact;
    async fn admit_channel(
        &self,
        viewer: &UserId,
        conversation: &ConversationId,
    ) -> Result<Result<Self::ChannelTarget, ChannelAttentionAdmissionRefusal>, Self::Error> {
        assert!(
            !self.body_polled.load(Ordering::SeqCst),
            "body was polled before admission"
        );
        self.calls
            .lock()
            .unwrap()
            .push(format!("admit-channel:{}", conversation.as_str()));
        match conversation.as_str() {
            "missing" => Ok(Err(ChannelAttentionAdmissionRefusal::ChannelNotFound)),
            "forbidden" => Ok(Err(ChannelAttentionAdmissionRefusal::Forbidden)),
            _ => Ok(Ok(ChannelTarget {
                viewer: viewer.clone(),
                conversation: conversation.clone(),
            })),
        }
    }
    async fn commit_channel(
        &self,
        target: Self::ChannelTarget,
        mode: ChannelAttentionMode,
    ) -> Result<Result<Self::ChannelCommit, ChannelAttentionWriteRefusal>, Self::Error> {
        self.calls
            .lock()
            .unwrap()
            .push(format!("commit-channel:{}", mode.as_str()));
        Ok(Ok(ChannelFact {
            viewer: target.viewer,
            workspace: WorkspaceId::parse("w").unwrap(),
            conversation: target.conversation,
            mode,
        }))
    }
    async fn get_workspace(
        &self,
        _: &UserId,
        workspace: WorkspaceId,
    ) -> Result<Result<WorkspaceAttentionPreference, WorkspaceAttentionReadRefusal>, Self::Error>
    {
        self.calls.lock().unwrap().push("workspace:get".into());
        match workspace.as_str() {
            "forbidden" | "missing" => Ok(Err(WorkspaceAttentionReadRefusal::Forbidden)),
            "home" => Ok(Err(WorkspaceAttentionReadRefusal::WorkspaceNotFound)),
            _ => Ok(Ok(WorkspaceAttentionPreference::projected(
                workspace, false,
            ))),
        }
    }
    async fn admit_workspace_write(
        &self,
        viewer: &UserId,
        workspace: &WorkspaceId,
    ) -> Result<Result<Self::WorkspaceTarget, WorkspaceAttentionAdmissionRefusal>, Self::Error>
    {
        assert!(
            !self.body_polled.load(Ordering::SeqCst),
            "body was polled before admission"
        );
        self.calls
            .lock()
            .unwrap()
            .push(format!("admit-workspace:{}", workspace.as_str()));
        match workspace.as_str() {
            "forbidden" | "missing" => Ok(Err(WorkspaceAttentionAdmissionRefusal::Forbidden)),
            "home" => Ok(Err(WorkspaceAttentionAdmissionRefusal::WorkspaceNotFound)),
            _ => Ok(Ok(WorkspaceTarget {
                viewer: viewer.clone(),
                workspace: workspace.clone(),
            })),
        }
    }
    async fn commit_workspace(
        &self,
        target: Self::WorkspaceTarget,
        muted: bool,
    ) -> Result<Result<Self::WorkspaceCommit, WorkspaceAttentionWriteRefusal>, Self::Error> {
        self.calls
            .lock()
            .unwrap()
            .push(format!("commit-workspace:{muted}"));
        Ok(Ok(WorkspaceFact {
            viewer: target.viewer,
            workspace: target.workspace,
            muted,
        }))
    }
}

#[derive(Clone, Default)]
struct Effects(Arc<Mutex<Vec<String>>>);
impl AttentionPreferenceAftermath for Effects {
    async fn channel_preference_changed(
        &self,
        fact: &impl ChannelAttentionCommit,
    ) -> Result<(), AttentionPreferenceEffectFailure> {
        self.0.lock().unwrap().push(format!(
            "pref:{}:{}",
            fact.viewer().as_str(),
            fact.conversation().as_str()
        ));
        Err(AttentionPreferenceEffectFailure::from_source(
            io::Error::other("hub"),
        ))
    }
    async fn channel_badge_changed(
        &self,
        fact: &impl ChannelAttentionCommit,
    ) -> Result<(), AttentionPreferenceEffectFailure> {
        self.0
            .lock()
            .unwrap()
            .push(format!("badge:{}", fact.workspace().as_str()));
        Ok(())
    }
    async fn workspace_preference_changed(
        &self,
        fact: &impl WorkspaceAttentionCommit,
    ) -> Result<(), AttentionPreferenceEffectFailure> {
        self.0
            .lock()
            .unwrap()
            .push(format!("pref:{}:null", fact.viewer().as_str()));
        Err(AttentionPreferenceEffectFailure::from_source(
            io::Error::other("hub"),
        ))
    }
    async fn workspace_badge_changed(
        &self,
        fact: &impl WorkspaceAttentionCommit,
    ) -> Result<(), AttentionPreferenceEffectFailure> {
        self.0
            .lock()
            .unwrap()
            .push(format!("badge:{}", fact.workspace().as_str()));
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
    call_body(app, method, path, Body::from(raw.to_owned()), auth).await
}
async fn call_body(
    app: Router,
    method: Method,
    path: &str,
    body: Body,
    auth: bool,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json")
        .body(body)
        .unwrap();
    if auth {
        request.extensions_mut().insert(UserId::parse("u").unwrap());
    }
    let response = app.oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    // A native axum structural rejection (415/400/422) carries a plain-text body pinned on
    // status only; a JSON body (success or minimal semantic 422) parses.
    let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, body)
}

#[tokio::test]
async fn three_routes_render_only_their_operation_specific_success() {
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
async fn admission_precedes_body_and_oversized_invalid_body_never_reaches_writer() {
    let ports = Ports::default();
    let flag = ports.body_polled.clone();
    let raw = format!(r#"{{"mode":"{}"}}"#, "x".repeat(1024 * 1024));
    let body = Body::from_stream(stream::once(async move {
        flag.store(true, Ordering::SeqCst);
        Ok::<Bytes, Infallible>(Bytes::from(raw))
    }));
    let (status, _) = call_body(
        router(ports.clone(), Effects::default()),
        Method::PUT,
        "/api/conversations/c/attention-preference",
        body,
        true,
    )
    .await;
    // A large but well-formed-shape body with an invalid enum value is a native data-shape
    // 422 (native body text not pinned); it is polled only after admit and never reaches
    // the writer.
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(ports.body_polled.load(Ordering::SeqCst));
    assert_eq!(*ports.calls.lock().unwrap(), ["admit-channel:c"]);
}

#[tokio::test]
async fn non_admissible_channel_and_workspace_bodies_keep_the_native_structural_axis_after_admit() {
    // The closed body crosses the shared `ValidatedJson` extractor AFTER admit. These are
    // all data-shape faults (missing/wrong-typed key, unknown enum value, a value-shaped
    // ARRAY the object-only floor refuses, null) → native 422. There is no stateless garde
    // rule, so nothing re-renders an issue schema. The writer is never reached beyond the
    // pre-body admit (authority zero-reach). Native body text is NOT pinned.
    for (path, admit_call, raw) in [
        (
            "/api/conversations/c/attention-preference",
            "admit-channel:c",
            "{}",
        ),
        (
            "/api/conversations/c/attention-preference",
            "admit-channel:c",
            r#"{"mode":"loud"}"#,
        ),
        (
            "/api/conversations/c/attention-preference",
            "admit-channel:c",
            r#"{"mode":true}"#,
        ),
        (
            "/api/conversations/c/attention-preference",
            "admit-channel:c",
            r#"{"mode":null}"#,
        ),
        (
            "/api/conversations/c/attention-preference",
            "admit-channel:c",
            r#"["all"]"#,
        ),
        (
            "/api/conversations/c/attention-preference",
            "admit-channel:c",
            "null",
        ),
        (
            "/api/workspaces/w/attention-preference",
            "admit-workspace:w",
            "{}",
        ),
        (
            "/api/workspaces/w/attention-preference",
            "admit-workspace:w",
            r#"{"muted":"yes"}"#,
        ),
        (
            "/api/workspaces/w/attention-preference",
            "admit-workspace:w",
            r#"{"muted":null}"#,
        ),
        (
            "/api/workspaces/w/attention-preference",
            "admit-workspace:w",
            "[true]",
        ),
    ] {
        let ports = Ports::default();
        let (status, _) = call(
            router(ports.clone(), Effects::default()),
            Method::PUT,
            path,
            raw,
            true,
        )
        .await;
        // Exact native status by input class (native body text not pinned; writer
        // zero-reach): a non-string primitive supplied to the string-enum `mode` field
        // (`{"mode":true}`, `{"mode":null}`) is the native axum `400`; every other data-shape
        // fault (missing/unknown-enum/wrong-typed `muted`/null-in-`muted`, and the object-only
        // floor refusing an array or non-object) is `422`.
        let expected = if raw == r#"{"mode":true}"# || raw == r#"{"mode":null}"# {
            StatusCode::BAD_REQUEST
        } else {
            StatusCode::UNPROCESSABLE_ENTITY
        };
        assert_eq!(status, expected, "{path} {raw}");
        assert_eq!(*ports.calls.lock().unwrap(), [admit_call], "{path} {raw}");
    }
    // A JSON syntax error keeps the native 400 (distinct from the 422 data-shape axis),
    // still after admit, still writer zero-reach.
    let ports = Ports::default();
    let (status, _) = call(
        router(ports.clone(), Effects::default()),
        Method::PUT,
        "/api/conversations/c/attention-preference",
        "not-json",
        true,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(*ports.calls.lock().unwrap(), ["admit-channel:c"]);
    // A missing content-type is the native 415 from the extractor, after admit.
    let ports = Ports::default();
    let request = Request::builder()
        .method(Method::PUT)
        .uri("/api/conversations/c/attention-preference")
        .extension(UserId::parse("u").unwrap())
        .body(Body::from(r#"{"mode":"all"}"#))
        .unwrap();
    let response = router(ports.clone(), Effects::default())
        .oneshot(request)
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
    assert_eq!(*ports.calls.lock().unwrap(), ["admit-channel:c"]);
}

#[tokio::test]
async fn target_and_access_refusals_do_not_poll_the_body() {
    for (path, expected) in [
        (
            "/api/conversations/missing/attention-preference",
            StatusCode::NOT_FOUND,
        ),
        (
            "/api/conversations/forbidden/attention-preference",
            StatusCode::FORBIDDEN,
        ),
        (
            "/api/workspaces/missing/attention-preference",
            StatusCode::FORBIDDEN,
        ),
        (
            "/api/workspaces/home/attention-preference",
            StatusCode::NOT_FOUND,
        ),
    ] {
        let ports = Ports::default();
        let flag = ports.body_polled.clone();
        let body = Body::from_stream(stream::once(async move {
            flag.store(true, Ordering::SeqCst);
            Ok::<Bytes, Infallible>(Bytes::from_static(br#"{"mode":"loud","muted":"yes"}"#))
        }));
        let (status, _) = call_body(
            router(ports.clone(), Effects::default()),
            Method::PUT,
            path,
            body,
            true,
        )
        .await;
        assert_eq!(status, expected, "{path}");
        assert!(!ports.body_polled.load(Ordering::SeqCst), "{path}");
    }
}

#[tokio::test]
async fn authentication_refusal_reaches_no_port_and_does_not_poll_body() {
    let ports = Ports::default();
    let flag = ports.body_polled.clone();
    let body = Body::from_stream(stream::once(async move {
        flag.store(true, Ordering::SeqCst);
        Ok::<Bytes, Infallible>(Bytes::from_static(br#"{"muted":true}"#))
    }));
    let (status, _) = call_body(
        router(ports.clone(), Effects::default()),
        Method::PUT,
        "/api/workspaces/w/attention-preference",
        body,
        false,
    )
    .await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert!(ports.calls.lock().unwrap().is_empty());
    assert!(!ports.body_polled.load(Ordering::SeqCst));
}

#[tokio::test]
async fn production_router_consumes_the_ts_signed_shared_cells() {
    // Denominator: the shared `attention-preference-wire.json` has 8 cells; this Rust
    // replay consumes the **6/8** that are genuinely dual-signed cross-language contracts —
    // the success/read/strip cells plus the two authority-BEFORE-body ORDER discriminators
    // (`channel_missing_precedes_invalid` 404, `workspace_missing_precedes_invalid` 403,
    // where a missing target refuses before the body is even examined). The remaining
    // **2/8** are pure body-invalid cells (`channel_invalid_enum`, `workspace_missing_boolean`)
    // whose TS signer still emits the legacy `400 {error, issues}`; the Rust terminal
    // admission is the shared native structural axis (422), so those are NOT dual-signed
    // here — they are covered by the focused local structural-axis test above. The TS
    // parity test continues to sign its own full 8/8 legacy behavior.
    const BODY_INVALID_SKIPPED: [&str; 2] = ["channel_invalid_enum", "workspace_missing_boolean"];
    let fixture: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../rust/test-fixtures/fixtures/attention-preference-wire.json"
    )))
    .unwrap();
    let mut surfaces = std::collections::BTreeSet::new();
    let mut consumed = 0;
    for entry in fixture.as_array().unwrap() {
        let name = entry["name"].as_str().unwrap();
        surfaces.insert(entry["surface"].as_str().unwrap());
        if BODY_INVALID_SKIPPED.contains(&name) {
            continue;
        }
        consumed += 1;
        let method = match entry["method"].as_str().unwrap() {
            "GET" => Method::GET,
            "PUT" => Method::PUT,
            other => panic!("unknown {other}"),
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
    assert_eq!(consumed, 6, "shared cross-language denominator is 6/8");
}
