use std::{
    convert::Infallible,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};

use axum::{
    body::{Body, Bytes, to_bytes},
    http::{Request, StatusCode, header::CONTENT_LENGTH},
};
use futures_util::stream;
use silverhand_backend_core::{
    foundation::identity::{AgentId, ConversationId, DaemonInstanceId},
    host_runtime::runtime_credential::{RuntimeCustody, RuntimeGeneration, RuntimePrincipal},
    messaging::{
        CapabilityDenied, SendCapability,
        collaboration::stale_message_resolution::StaleMessageResolutionAdmissionFact,
    },
};
use silverhand_backend_sqlite::messaging::MessagingStore;
use sqlx::{Connection, Executor, SqliteConnection, sqlite::SqliteConnectOptions};
use tower::ServiceExt;

use super::*;

#[derive(Clone, Copy)]
enum AdmissionMode {
    Matching,
    Forbidden,
    ForeignAgent,
    ForeignConversation,
}

#[derive(Clone)]
struct Admission {
    mode: AdmissionMode,
    calls: Arc<AtomicUsize>,
    order: Arc<Mutex<Vec<&'static str>>>,
}

impl StaleMessageResolutionAdmissionPort for Admission {
    type Error = Infallible;

    async fn admit(
        &self,
        agent: &AgentId,
        conversation: &ConversationId,
    ) -> Result<
        Result<StaleMessageResolutionAdmissionFact, StaleMessageResolutionAdmissionRefusal>,
        Self::Error,
    > {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.order.lock().unwrap().push("admission");
        Ok(match self.mode {
            AdmissionMode::Matching => Ok(StaleMessageResolutionAdmissionFact::selected(
                agent.clone(),
                conversation.clone(),
            )),
            AdmissionMode::Forbidden => Err(StaleMessageResolutionAdmissionRefusal::Forbidden),
            AdmissionMode::ForeignAgent => Ok(StaleMessageResolutionAdmissionFact::selected(
                AgentId::parse("foreign-agent").unwrap(),
                conversation.clone(),
            )),
            AdmissionMode::ForeignConversation => {
                Ok(StaleMessageResolutionAdmissionFact::selected(
                    agent.clone(),
                    ConversationId::parse("foreign-conversation").unwrap(),
                ))
            }
        })
    }
}

#[derive(Clone)]
struct Capability {
    granted: bool,
    calls: Arc<AtomicUsize>,
    order: Arc<Mutex<Vec<&'static str>>>,
}

impl SendCapability for Capability {
    type Error = Infallible;

    async fn may_send_messages(
        &self,
        _: &AgentId,
        _: &ConversationId,
    ) -> Result<Result<(), CapabilityDenied>, Self::Error> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.order.lock().unwrap().push("capability");
        Ok(if self.granted {
            Ok(())
        } else {
            Err(CapabilityDenied)
        })
    }
}

#[derive(Clone, Default)]
struct Observer {
    observed: Arc<Mutex<Vec<StaleMessageResolutionObservation>>>,
    order: Arc<Mutex<Vec<&'static str>>>,
}

impl StaleMessageResolutionObserver for Observer {
    fn stale_message_resolved(&self, observation: &StaleMessageResolutionObservation) {
        self.order.lock().unwrap().push("observer");
        self.observed.lock().unwrap().push(observation.clone());
    }
}

struct Fixture {
    app: Router,
    admission_calls: Arc<AtomicUsize>,
    capability_calls: Arc<AtomicUsize>,
    observer: Observer,
    order: Arc<Mutex<Vec<&'static str>>>,
}

fn fixture(mode: AdmissionMode, capability: bool) -> Fixture {
    let admission_calls = Arc::new(AtomicUsize::new(0));
    let capability_calls = Arc::new(AtomicUsize::new(0));
    let order = Arc::new(Mutex::new(Vec::new()));
    let observer = Observer {
        observed: Arc::new(Mutex::new(Vec::new())),
        order: order.clone(),
    };
    let app = router(
        Admission {
            mode,
            calls: admission_calls.clone(),
            order: order.clone(),
        },
        Capability {
            granted: capability,
            calls: capability_calls.clone(),
            order: order.clone(),
        },
        observer.clone(),
    );
    Fixture {
        app,
        admission_calls,
        capability_calls,
        observer,
        order,
    }
}

fn principal(source: Option<&str>) -> RuntimePrincipal {
    let custody = RuntimeCustody::new(
        RuntimeGeneration::new(1).unwrap(),
        DaemonInstanceId::parse("daemon-1").unwrap(),
    );
    match source {
        Some(source) => RuntimePrincipal::ConversationSlot {
            agent: AgentId::parse("agent-1").unwrap(),
            source: ConversationId::parse(source).unwrap(),
            custody,
        },
        None => RuntimePrincipal::AgentSlot {
            agent: AgentId::parse("agent-1").unwrap(),
            custody,
        },
    }
}

async fn call(
    app: Router,
    path_agent: &str,
    body: Body,
    principal: Option<RuntimePrincipal>,
    declared: Option<usize>,
) -> (StatusCode, Vec<u8>) {
    let mut builder = Request::builder().method("POST").uri(format!(
        "/internal/agents/{path_agent}/stale-message-resolution"
    ));
    if let Some(length) = declared {
        builder = builder.header(CONTENT_LENGTH, length);
    }
    let mut request = builder.body(body).unwrap();
    if let Some(principal) = principal {
        request.extensions_mut().insert(principal);
    }
    let response = app.oneshot(request).await.unwrap();
    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap()
        .to_vec();
    (status, body)
}

fn request_body(extra: &str) -> Body {
    Body::from(format!(
        r#"{{"conversation_id":"conversation-1","stale_event_id":"evt-1","resolution_reason":"obsolete"{extra}}}"#
    ))
}

#[tokio::test]
async fn both_runtime_scopes_use_the_body_conversation_and_observe_once_in_order() {
    for source in [None, Some("ambient-other")] {
        let fixture = fixture(AdmissionMode::Matching, true);
        let (status, body) = call(
            fixture.app,
            "agent-1",
            request_body(r#", "unknown":"stripped""#),
            Some(principal(source)),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap(),
            json!({"ok":true})
        );
        assert_eq!(fixture.admission_calls.load(Ordering::SeqCst), 1);
        assert_eq!(fixture.capability_calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            *fixture.order.lock().unwrap(),
            ["admission", "capability", "observer"]
        );
        let observed = fixture.observer.observed.lock().unwrap();
        assert_eq!(observed.len(), 1);
        assert_eq!(observed[0].agent().as_str(), "agent-1");
        assert_eq!(observed[0].source_conversation().as_str(), "conversation-1");
        assert_eq!(observed[0].target_conversation().as_str(), "conversation-1");
        assert_eq!(observed[0].stale_event_id(), "evt-1");
        assert_eq!(observed[0].resolution_reason(), "obsolete");
        assert_eq!(observed[0].outcome(), "obsolete");
    }
}

#[tokio::test]
async fn runtime_and_path_identity_fail_before_the_body_is_polled() {
    for (principal, path, expected) in [
        (None, "agent-1", StatusCode::INTERNAL_SERVER_ERROR),
        (Some(principal(None)), "other-agent", StatusCode::NOT_FOUND),
    ] {
        let polled = Arc::new(AtomicBool::new(false));
        let flag = polled.clone();
        let body = Body::from_stream(stream::once(async move {
            flag.store(true, Ordering::SeqCst);
            Ok::<Bytes, Infallible>(Bytes::from_static(b"{}"))
        }));
        let fixture = fixture(AdmissionMode::Matching, true);
        let (status, _) = call(fixture.app, path, body, principal, None).await;
        assert_eq!(status, expected);
        assert!(!polled.load(Ordering::SeqCst));
        assert_eq!(fixture.admission_calls.load(Ordering::SeqCst), 0);
        assert_eq!(fixture.capability_calls.load(Ordering::SeqCst), 0);
        assert!(fixture.observer.observed.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn bounded_body_and_typed_shape_precede_product_authority() {
    let invalid_case = fixture(AdmissionMode::Matching, true);
    let (status, body) = call(
        invalid_case.app,
        "agent-1",
        Body::from("{}"),
        Some(principal(None)),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap(),
        json!({"error": "invalid input"})
    );
    assert_eq!(invalid_case.admission_calls.load(Ordering::SeqCst), 0);

    let oversized = fixture(AdmissionMode::Matching, true);
    let polled = Arc::new(AtomicBool::new(false));
    let flag = polled.clone();
    let stream = Body::from_stream(stream::once(async move {
        flag.store(true, Ordering::SeqCst);
        Ok::<Bytes, Infallible>(Bytes::from_static(b"{}"))
    }));
    let (status, body) = call(
        oversized.app,
        "agent-1",
        stream,
        Some(principal(None)),
        Some(super::super::json_body::JSON_BODY_MAX_BYTES + 1),
    )
    .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap(),
        json!({"error":"payload too large"})
    );
    assert!(!polled.load(Ordering::SeqCst));
    assert_eq!(oversized.admission_calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn a_value_shaped_positional_array_is_refused_before_product_authority() {
    // Serde's derived struct would bind `["conversation-1","evt-1","obsolete"]` to
    // `StaleResolutionBody`'s three fields positionally — a fully valid-looking request that,
    // without the shared `ObjectOnly` floor, would decode and reach the post authority. It is
    // the same minimal `422 {"error":"invalid input"}` and the admission is never consulted.
    let fixture = fixture(AdmissionMode::Matching, true);
    let (status, body) = call(
        fixture.app,
        "agent-1",
        Body::from(r#"["conversation-1","evt-1","obsolete"]"#),
        Some(principal(None)),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap(),
        json!({"error": "invalid input"})
    );
    assert_eq!(fixture.admission_calls.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.capability_calls.load(Ordering::SeqCst), 0);
    assert!(fixture.observer.observed.lock().unwrap().is_empty());
}

#[tokio::test]
async fn source_splices_and_both_authority_refusals_never_reach_the_observer() {
    for (mode, capability, expected) in [
        (AdmissionMode::Forbidden, true, StatusCode::FORBIDDEN),
        (
            AdmissionMode::ForeignAgent,
            true,
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
        (
            AdmissionMode::ForeignConversation,
            true,
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
        (AdmissionMode::Matching, false, StatusCode::FORBIDDEN),
    ] {
        let fixture = fixture(mode, capability);
        let (status, body) = call(
            fixture.app,
            "agent-1",
            request_body(""),
            Some(principal(None)),
            None,
        )
        .await;
        assert_eq!(status, expected);
        assert!(fixture.observer.observed.lock().unwrap().is_empty());
        if !capability && matches!(mode, AdmissionMode::Matching) {
            assert_eq!(
                serde_json::from_slice::<Value>(&body).unwrap(),
                json!({
                    "code":"capability_denied","capability":"send_messages",
                    "message":"missing 'send_messages' capability in this workspace",
                    "details":{"capability":"send_messages"}
                })
            );
        }
        let expected_capability_calls = usize::from(matches!(mode, AdmissionMode::Matching));
        assert_eq!(
            fixture.capability_calls.load(Ordering::SeqCst),
            expected_capability_calls
        );
    }
}

#[tokio::test]
async fn production_sqlite_admission_and_capability_drive_the_route() {
    const SCHEMA: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../packages/backend/tests/migration-baseline/schema-current.sql"
    ));
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("stale-resolution-route.sqlite");
    let options = SqliteConnectOptions::new()
        .filename(&path)
        .create_if_missing(true)
        .foreign_keys(true);
    let mut db = SqliteConnection::connect_with(&options).await.unwrap();
    db.execute(sqlx::raw_sql(SCHEMA)).await.unwrap();
    db.execute("INSERT INTO hosts(id,name,kind,created_at) VALUES('host','Host','local',1)")
        .await
        .unwrap();
    db.execute("INSERT INTO users(id,name,display_name,created_at,updated_at) VALUES('owner','stale-owner','Owner',1,1)")
        .await
        .unwrap();
    db.execute("INSERT INTO agents(id,name,runtime,host_id,created_at,updated_at,display_name,created_by_user_id,materialization_status,session_scope) VALUES('agent-1','stale-route-agent','codex','host',1,1,'Agent','owner','active','agent')")
        .await
        .unwrap();
    db.execute("INSERT INTO workspaces(id,name,name_key,created_at,updated_at) VALUES('workspace','Workspace','stale route workspace',1,1)")
        .await
        .unwrap();
    db.execute("INSERT INTO conversations(id,workspace_id,placement_kind,roster_policy,title,title_key,status,visibility,created_at,updated_at) VALUES('conversation-1','workspace','workspace','open','Channel','stale route channel','idle','private',1,1)")
        .await
        .unwrap();
    db.execute("INSERT INTO conversation_agents(conversation_id,agent_id,joined_at) VALUES('conversation-1','agent-1',1)")
        .await
        .unwrap();
    db.execute("INSERT INTO workspace_members(workspace_id,agent_id,joined_at) VALUES('workspace','agent-1',1)")
        .await
        .unwrap();
    db.execute("INSERT INTO workspace_agent_capabilities(workspace_id,agent_id,capability) VALUES('workspace','agent-1','send_messages')")
        .await
        .unwrap();

    let store = MessagingStore::open(&path).await.unwrap();
    let observer = Observer::default();
    let app = router(
        store.stale_message_resolution_admission(),
        store.clone(),
        observer.clone(),
    );
    let (status, body) = call(
        app,
        "agent-1",
        request_body(""),
        Some(principal(None)),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap(),
        json!({"ok":true})
    );
    assert_eq!(observer.observed.lock().unwrap().len(), 1);
}
