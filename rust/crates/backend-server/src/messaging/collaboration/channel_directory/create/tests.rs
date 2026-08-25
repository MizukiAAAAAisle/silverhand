use std::{
    convert::Infallible,
    io,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

use axum::{
    body::{Body, Bytes, to_bytes},
    extract::Extension,
    http::{Request, StatusCode, header::CONTENT_LENGTH},
};
use futures_util::stream;
use serde_json::{Value, json};
use silverhand_backend_core::{
    identity::{ConversationId, UserId, WorkspaceId},
    messaging::{
        SendClock, SendEntropy,
        collaboration::channel_directory::{
            ChannelCreationPublicationFailure, ChannelDirectoryRow, ChannelStatus,
            ChannelVisibility, CommittedHumanChannelCreation, DirectoryRoster,
            HumanChannelCreateAftermath, HumanChannelCreatePort, HumanChannelCreateRefusal,
            HumanChannelCreateRequest,
        },
        conversation_title::CanonicalConversationTitle,
        environment::EnvironmentUnavailable,
    },
};
use silverhand_backend_sqlite::messaging::MessagingStore;
use sqlx::{Connection, Executor};
use tower::ServiceExt;
use tracing_subscriber::fmt::MakeWriter;

use super::create_router;

fn user(raw: &str) -> UserId {
    UserId::parse(raw).unwrap()
}

fn workspace(raw: &str) -> WorkspaceId {
    WorkspaceId::parse(raw).unwrap()
}

fn committed() -> CommittedHumanChannelCreation {
    let viewer = user("local");
    let workspace = workspace("workspace-1");
    let title = CanonicalConversationTitle::parse("General").unwrap();
    let row = ChannelDirectoryRow::projected(
        viewer.clone(),
        workspace.clone(),
        ConversationId::parse("created").unwrap(),
        DirectoryRoster::Open,
        "General".into(),
        ChannelStatus::Idle,
        None,
        None,
        None,
        None,
        0,
        77,
        77,
        ChannelVisibility::Private,
        true,
    )
    .unwrap();
    CommittedHumanChannelCreation::regular(viewer, workspace, title, row).unwrap()
}

#[derive(Clone)]
enum Outcome {
    Commit(Box<CommittedHumanChannelCreation>),
    Refuse(HumanChannelCreateRefusal),
}

#[derive(Clone)]
struct Port {
    outcome: Outcome,
    requests: Arc<Mutex<Vec<HumanChannelCreateRequest>>>,
}

impl HumanChannelCreatePort for Port {
    type Error = Infallible;

    async fn create_human_channel(
        &self,
        _: UserId,
        _: WorkspaceId,
        request: HumanChannelCreateRequest,
    ) -> Result<Result<CommittedHumanChannelCreation, HumanChannelCreateRefusal>, Self::Error> {
        self.requests.lock().unwrap().push(request);
        Ok(match &self.outcome {
            Outcome::Commit(value) => Ok(value.as_ref().clone()),
            Outcome::Refuse(value) => Err(value.clone()),
        })
    }
}

#[derive(Clone, Default)]
struct Effects {
    events: Arc<Mutex<Vec<&'static str>>>,
    fail: bool,
}

#[derive(Debug, thiserror::Error)]
#[error("publish-driver-detail")]
struct PublishDriver;

impl HumanChannelCreateAftermath for Effects {
    async fn workspace_channels_changed(
        &self,
        _: &silverhand_backend_core::messaging::collaboration::channel_directory::BoundHumanChannelCreation,
    ) -> Result<(), ChannelCreationPublicationFailure> {
        self.events.lock().unwrap().push("publish");
        if self.fail {
            Err(ChannelCreationPublicationFailure::from_source(
                PublishDriver,
            ))
        } else {
            Ok(())
        }
    }

    fn title_address_taken(
        &self,
        _: &silverhand_backend_core::messaging::collaboration::channel_directory::BoundHumanChannelCreation,
    ) {
        self.events.lock().unwrap().push("audit");
    }
}

async fn call(
    app: axum::Router,
    path: &str,
    body: &str,
    authenticated: bool,
) -> (StatusCode, Value) {
    call_body(app, path, Body::from(body.to_owned()), authenticated, None).await
}

async fn call_body(
    app: axum::Router,
    path: &str,
    body: Body,
    authenticated: bool,
    content_length: Option<usize>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method("POST")
        .uri(path)
        .header("content-type", "application/json");
    if let Some(length) = content_length {
        builder = builder.header(CONTENT_LENGTH, length);
    }
    let mut request = builder.body(body).unwrap();
    if authenticated {
        request.extensions_mut().insert(user("local"));
    }
    let response = app.oneshot(request).await.unwrap();
    let status = response.status();
    let body =
        serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap();
    (status, body)
}

fn fixture_app(
    outcome: Outcome,
    effects: Effects,
) -> (axum::Router, Arc<Mutex<Vec<HumanChannelCreateRequest>>>) {
    let requests = Arc::new(Mutex::new(vec![]));
    (
        create_router(
            Port {
                outcome,
                requests: requests.clone(),
            },
            effects,
        )
        .layer(Extension(user("local"))),
        requests,
    )
}

#[tokio::test]
async fn production_admission_matches_zod_issue_shapes_and_drops_raw_before_port() {
    let cases = [
        (
            "{}",
            json!({"error":"invalid input","issues":[{
                "code":"invalid_type","expected":"string","received":"undefined",
                "path":["title"],"message":"Required"
            }]}),
        ),
        (
            r#"{"title":""}"#,
            json!({"error":"invalid input","issues":[{
                "code":"too_small","minimum":1,"type":"string","inclusive":true,
                "message":"title must not be empty","path":["title"]
            }]}),
        ),
        (
            r#"{"title":"X","member_agent_ids":[1],"visibility":"loud"}"#,
            json!({"error":"invalid input","issues":[
                {"code":"invalid_type","expected":"string","received":"number","path":["member_agent_ids",0],"message":"Expected string, received number"},
                {"received":"loud","code":"invalid_enum_value","options":["private","public"],"path":["visibility"],"message":"Invalid enum value. Expected 'private' | 'public', received 'loud'"}
            ]}),
        ),
        (
            "[1]",
            json!({"error":"invalid input","issues":[{
                "code":"invalid_type","expected":"object","received":"array","path":[],
                "message":"Expected object, received array"
            }]}),
        ),
    ];

    for (raw, expected) in cases {
        let (app, requests) = fixture_app(
            Outcome::Refuse(HumanChannelCreateRefusal::WorkspaceNotFound),
            Effects::default(),
        );
        let (status, body) = call(app, "/api/workspaces/workspace-1/channels", raw, false).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{raw}");
        assert_eq!(body, expected, "{raw}");
        assert!(requests.lock().unwrap().is_empty(), "{raw}");
    }

    let (app, requests) = fixture_app(
        Outcome::Refuse(HumanChannelCreateRefusal::WorkspaceNotFound),
        Effects::default(),
    );
    let (status, _) = call(
        app,
        "/api/workspaces/workspace-1/channels",
        r#"{"title":"  General  ","member_agent_ids":["a","a"],"visibility":"public","ignored":"raw"}"#,
        false,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let request = requests.lock().unwrap().pop().unwrap();
    assert_eq!(request.title().title(), "General");
    assert_eq!(request.member_agent_ids(), ["a"]);
    assert_eq!(request.visibility(), ChannelVisibility::Public);
}

#[tokio::test]
async fn refusal_closed_set_renders_the_typescript_route_contract() {
    let cases = [
        (
            HumanChannelCreateRefusal::WorkspaceNotFound,
            StatusCode::NOT_FOUND,
            json!({"error":"workspace not found"}),
        ),
        (
            HumanChannelCreateRefusal::Forbidden,
            StatusCode::FORBIDDEN,
            json!({"error":"forbidden"}),
        ),
        (
            HumanChannelCreateRefusal::AgentHomePublic,
            StatusCode::BAD_REQUEST,
            json!({"error":"agent_home DM channels cannot be public"}),
        ),
        (
            HumanChannelCreateRefusal::AgentHomeExplicitMembers,
            StatusCode::BAD_REQUEST,
            json!({"error":"agent_home channels always use the home owner/current user as members"}),
        ),
        (
            HumanChannelCreateRefusal::AgentHomeOwnerNotFound,
            StatusCode::NOT_FOUND,
            json!({"error":"agent_home owner not found"}),
        ),
        (
            HumanChannelCreateRefusal::AgentNotFound("a".into()),
            StatusCode::BAD_REQUEST,
            json!({"error":"agent a not found","code":"agent_not_found"}),
        ),
        (
            HumanChannelCreateRefusal::AgentNotWorkspaceMember("a".into()),
            StatusCode::BAD_REQUEST,
            json!({"error":"agent a is not a member of this workspace","code":"agent_not_workspace_member"}),
        ),
        (
            HumanChannelCreateRefusal::UserNotWorkspaceMember("u".into()),
            StatusCode::BAD_REQUEST,
            json!({"error":"user u is not a human member of this workspace","code":"user_not_workspace_member"}),
        ),
        (
            HumanChannelCreateRefusal::TitleTaken,
            StatusCode::CONFLICT,
            json!({"error":"a channel titled General already exists in this workspace","code":"conversation_title_taken"}),
        ),
    ];
    for (reason, expected_status, expected_body) in cases {
        let (app, _) = fixture_app(Outcome::Refuse(reason), Effects::default());
        let (status, body) = call(
            app,
            "/api/workspaces/workspace-1/channels",
            r#"{"title":"General"}"#,
            false,
        )
        .await;
        assert_eq!(status, expected_status);
        assert_eq!(body, expected_body);
    }
}

#[tokio::test]
async fn success_is_201_and_publication_failure_never_skips_audit_or_changes_wire() {
    for fail in [false, true] {
        let effects = Effects {
            events: Arc::new(Mutex::new(vec![])),
            fail,
        };
        let (app, _) = fixture_app(Outcome::Commit(Box::new(committed())), effects.clone());
        let (status, body) = call(
            app,
            "/api/workspaces/workspace-1/channels",
            r#"{"title":"General"}"#,
            false,
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(body["channel"]["id"], "created");
        assert_eq!(body["channel"]["title"], "General");
        assert_eq!(body["channel"]["visibility"], "private");
        assert_eq!(*effects.events.lock().unwrap(), ["publish", "audit"]);
        assert!(!body.to_string().contains("publish-driver-detail"));
    }
}

#[tokio::test]
async fn authentication_precedes_body_and_product_work() {
    let requests = Arc::new(Mutex::new(vec![]));
    let app = create_router(
        Port {
            outcome: Outcome::Commit(Box::new(committed())),
            requests: requests.clone(),
        },
        Effects::default(),
    );
    let polled = Arc::new(AtomicBool::new(false));
    let stream_flag = polled.clone();
    let body = Body::from_stream(stream::once(async move {
        stream_flag.store(true, Ordering::SeqCst);
        Ok::<Bytes, Infallible>(Bytes::from_static(b"not-json"))
    }));
    let request = Request::builder()
        .method("POST")
        .uri("/api/workspaces/workspace-1/channels")
        .body(body)
        .unwrap();
    let response = app.oneshot(request).await.unwrap();
    let status = response.status();
    let body: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(body, json!({"error":"internal error"}));
    assert!(!polled.load(Ordering::SeqCst));
    assert!(requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn declared_and_chunked_overflow_are_413_and_the_exact_limit_is_admitted() {
    const LIMIT: usize = 128 * 1024 * 1024;

    let declared_polled = Arc::new(AtomicBool::new(false));
    let flag = declared_polled.clone();
    let declared = Body::from_stream(stream::once(async move {
        flag.store(true, Ordering::SeqCst);
        Ok::<Bytes, Infallible>(Bytes::from_static(b"{}"))
    }));
    let (app, requests) = fixture_app(
        Outcome::Refuse(HumanChannelCreateRefusal::WorkspaceNotFound),
        Effects::default(),
    );
    let (status, body) = call_body(
        app,
        "/api/workspaces/workspace-1/channels",
        declared,
        false,
        Some(LIMIT + 1),
    )
    .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(body, json!({"error":"payload too large"}));
    assert!(!declared_polled.load(Ordering::SeqCst));
    assert!(requests.lock().unwrap().is_empty());

    let chunk = Bytes::from(vec![b' '; 1024 * 1024]);
    let chunked = Body::from_stream(stream::iter(
        (0..129).map(move |_| Ok::<Bytes, Infallible>(chunk.clone())),
    ));
    let (app, requests) = fixture_app(
        Outcome::Refuse(HumanChannelCreateRefusal::WorkspaceNotFound),
        Effects::default(),
    );
    let (status, body) = call_body(
        app,
        "/api/workspaces/workspace-1/channels",
        chunked,
        false,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(body, json!({"error":"payload too large"}));
    assert!(requests.lock().unwrap().is_empty());

    let prefix = br#"{"title":"At Limit","padding":""#;
    let suffix = br#""}"#;
    let mut exact = Vec::with_capacity(LIMIT);
    exact.extend_from_slice(prefix);
    exact.resize(LIMIT - suffix.len(), b' ');
    exact.extend_from_slice(suffix);
    assert_eq!(exact.len(), LIMIT);
    let (app, requests) = fixture_app(
        Outcome::Refuse(HumanChannelCreateRefusal::WorkspaceNotFound),
        Effects::default(),
    );
    let (status, body) = call_body(
        app,
        "/api/workspaces/workspace-1/channels",
        Body::from(exact),
        false,
        Some(LIMIT),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body, json!({"error":"workspace not found"}));
    assert_eq!(requests.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn ordinary_body_read_failure_uses_the_typescript_empty_object_catch() {
    let body = Body::from_stream(stream::once(async {
        Err::<Bytes, _>(std::io::Error::other("body driver failed"))
    }));
    let (app, requests) = fixture_app(
        Outcome::Refuse(HumanChannelCreateRefusal::WorkspaceNotFound),
        Effects::default(),
    );
    let (status, body) = call_body(
        app,
        "/api/workspaces/workspace-1/channels",
        body,
        false,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["issues"][0]["path"], json!(["title"]));
    assert!(requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn all_body_limit_shapes_remain_unpolled_without_authentication() {
    const LIMIT: usize = 128 * 1024 * 1024;
    for declared in [None, Some(LIMIT), Some(LIMIT + 1)] {
        let polled = Arc::new(AtomicBool::new(false));
        let flag = polled.clone();
        let body = Body::from_stream(stream::once(async move {
            flag.store(true, Ordering::SeqCst);
            Ok::<Bytes, Infallible>(Bytes::from_static(b"{}"))
        }));
        let app = create_router(
            Port {
                outcome: Outcome::Commit(Box::new(committed())),
                requests: Arc::new(Mutex::new(vec![])),
            },
            Effects::default(),
        );
        let (status, _) = call_body(
            app,
            "/api/workspaces/workspace-1/channels",
            body,
            false,
            declared,
        )
        .await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert!(!polled.load(Ordering::SeqCst), "declared={declared:?}");
    }
}

#[derive(Clone)]
struct FixedEnvironment;

impl SendClock for FixedEnvironment {
    fn now_unix_ms(&self) -> Result<i64, EnvironmentUnavailable> {
        Ok(77)
    }
}

impl SendEntropy for FixedEnvironment {
    fn fill(&self, bytes: &mut [u8]) -> Result<(), EnvironmentUnavailable> {
        bytes.fill(1);
        Ok(())
    }
}

fn fixture() -> Vec<Value> {
    serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../packages/backend/tests/fixtures/channel-directory-create-wire.json"
    )))
    .unwrap()
}

fn fixture_request(entry: &Value) -> Value {
    match entry.get("request_case").and_then(Value::as_str) {
        None => entry["request"].clone(),
        Some("title_129") => json!({"title":"x".repeat(129)}),
        Some("malformed_json") => json!({}),
        Some(other) => panic!("unknown create request case {other}"),
    }
}

fn fixture_raw(entry: &Value) -> String {
    match entry.get("request_case").and_then(Value::as_str) {
        Some("malformed_json") => "{".into(),
        _ => serde_json::to_string(&fixture_request(entry)).unwrap(),
    }
}

fn fixture_body(entry: &Value, fixture: &[Value]) -> Value {
    let Some(name) = entry.get("body_case").and_then(Value::as_str) else {
        return entry["body"].clone();
    };
    fixture_body(
        fixture
            .iter()
            .find(|candidate| candidate["name"] == name)
            .unwrap(),
        fixture,
    )
}

async fn seeded_store() -> (tempfile::TempDir, MessagingStore<FixedEnvironment>) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory
        .path()
        .join("channel-directory-create-wire.sqlite");
    let mut db = crate::current_schema::create_current_schema(&path).await;
    db.execute(sqlx::raw_sql(
        "INSERT INTO users(id,name,display_name,created_at,updated_at) VALUES \
           ('local','wire-local','Local',1,1),('user-member','wire-user-member','Member',1,1), \
           ('user-outsider','wire-user-outsider','Outsider',1,1); \
         INSERT INTO hosts(id,name,kind,created_at) VALUES \
           ('wire-create-host','Wire Create Host','local',1); \
         INSERT INTO agents(id,name,runtime,host_id,created_at,updated_at,created_by_user_id) VALUES \
           ('agent-member','agent-member','claude','wire-create-host',1,1,'local'), \
           ('agent-outsider','agent-outsider','claude','wire-create-host',1,1,'local'); \
         INSERT INTO workspaces(id,name,name_key,owner_agent_id,created_at,updated_at) VALUES \
           ('workspace-1','Workspace','channel-create-wire',NULL,1,1), \
           ('workspace-2','Forbidden','channel-create-forbidden',NULL,1,1), \
           ('workspace-home','agent-member',NULL,'agent-member',1,1); \
         INSERT INTO workspace_users(workspace_id,user_id,joined_at,role) VALUES \
           ('workspace-1','local',1,'admin'),('workspace-1','user-member',1,'member'), \
           ('workspace-home','local',1,'admin'); \
         INSERT INTO workspace_members(workspace_id,agent_id,joined_at) VALUES \
           ('workspace-1','agent-member',1); \
         INSERT INTO conversations(id,workspace_id,placement_kind,roster_policy,title,title_key,status, \
           visibility,created_at,updated_at) VALUES \
           ('taken','workspace-1','workspace','open','Taken','taken','idle','private',1,1);",
    ))
    .await
    .unwrap();
    db.close().await.unwrap();
    let store = MessagingStore::open_with(path, FixedEnvironment)
        .await
        .unwrap();
    (directory, store)
}

fn normalize_success(mut body: Value) -> Value {
    let Some(channel) = body.get_mut("channel").and_then(Value::as_object_mut) else {
        return body;
    };
    channel.insert("id".into(), json!("created"));
    channel.insert("created_at".into(), json!(77));
    channel.insert("updated_at".into(), json!(77));
    body
}

#[tokio::test]
async fn production_sqlite_router_consumes_every_typescript_signed_create_cell() {
    let fixture = fixture();
    for entry in &fixture {
        let (_directory, store) = seeded_store().await;
        let effects = Effects::default();
        let app = create_router(store.channel_directory_create(), effects.clone())
            .layer(Extension(user("local")));
        let raw = fixture_raw(entry);
        let (status, body) = call(app, entry["path"].as_str().unwrap(), &raw, false).await;
        assert_eq!(
            status.as_u16(),
            entry["status"].as_u64().unwrap() as u16,
            "{}",
            entry["name"]
        );
        assert_eq!(
            normalize_success(body),
            fixture_body(entry, &fixture),
            "{}",
            entry["name"]
        );
        let expected_events: &[&str] = if status == StatusCode::CREATED {
            &["publish", "audit"]
        } else {
            &[]
        };
        assert_eq!(
            &*effects.events.lock().unwrap(),
            expected_events,
            "{}",
            entry["name"]
        );
    }
}

#[derive(Clone, Default)]
struct LogBuffer(Arc<Mutex<Vec<u8>>>);

struct LogWriter(Arc<Mutex<Vec<u8>>>);

impl io::Write for LogWriter {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buffer);
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl<'a> MakeWriter<'a> for LogBuffer {
    type Writer = LogWriter;

    fn make_writer(&'a self) -> Self::Writer {
        LogWriter(self.0.clone())
    }
}

impl LogBuffer {
    fn events(&self) -> Vec<Value> {
        String::from_utf8(self.0.lock().unwrap().clone())
            .unwrap()
            .lines()
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
}

#[tokio::test(flavor = "current_thread")]
async fn committed_publication_failure_is_logged_once_with_its_source_and_still_returns_201() {
    let effects = Effects {
        events: Arc::new(Mutex::new(vec![])),
        fail: true,
    };
    let (app, _) = fixture_app(Outcome::Commit(Box::new(committed())), effects.clone());
    let logs = LogBuffer::default();
    let subscriber = tracing_subscriber::fmt()
        .json()
        .with_max_level(tracing::Level::ERROR)
        .with_writer(logs.clone())
        .finish();
    let _guard = tracing::subscriber::set_default(subscriber);

    let (status, body) = call(
        app,
        "/api/workspaces/workspace-1/channels",
        r#"{"title":"General"}"#,
        false,
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert!(!body.to_string().contains("publish-driver-detail"));
    assert_eq!(*effects.events.lock().unwrap(), ["publish", "audit"]);
    let events = logs.events();
    assert_eq!(events.len(), 1);
    assert_eq!(
        events[0]["fields"]["message"],
        "committed channel creation publication failed"
    );
    let chain = events[0]["fields"]["error_chain"].as_str().unwrap();
    assert!(chain.contains("the committed channel creation could not be published"));
    assert!(chain.contains("publish-driver-detail"));
}
