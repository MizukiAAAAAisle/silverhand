use std::{
    io::{self, Write},
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};

use axum::{
    body::{Body, to_bytes},
    extract::Extension,
    http::{Method, Request, StatusCode},
};
use serde_json::{Value, json};
use silverhand_backend_core::{
    identity::UserId,
    messaging::collaboration::saved::{SavedAftermath, SavedChangeFact, SavedPublicationFailure},
};
use silverhand_backend_sqlite::messaging::MessagingStore;
use sqlx::{Connection, Executor, SqliteConnection};
use tower::ServiceExt;
use tracing_subscriber::fmt::MakeWriter;

use super::{changed_event, router};

fn fixture_case(name: &str) -> Value {
    let fixture: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../packages/backend/tests/fixtures/saved-wire.json"
    )))
    .unwrap();
    fixture
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["name"] == name)
        .unwrap()
        .clone()
}

fn fixture_body(name: &str) -> Value {
    let case = fixture_case(name);
    if let Some(body_case) = case.get("body_case").and_then(Value::as_str) {
        return fixture_body(body_case);
    }
    if let Some(saved_case) = case
        .get("body")
        .and_then(|body| body.get("saved_case"))
        .and_then(Value::as_str)
    {
        return json!({"saved":[fixture_body(saved_case)["saved"].clone()]});
    }
    case["body"].clone()
}

fn normalized_saved(mut body: Value) -> Value {
    let entries = if body["saved"].is_array() {
        body["saved"].as_array_mut().unwrap()
    } else {
        std::slice::from_mut(body.get_mut("saved").unwrap())
    };
    for entry in entries {
        entry["id"] = json!("saved-1");
        entry["saved_at"] = json!(1000);
    }
    body
}

#[derive(Clone, Default)]
struct Events(Arc<Mutex<Vec<SavedChangeFact>>>);

impl SavedAftermath for Events {
    async fn announce(&self, fact: &SavedChangeFact) -> Result<(), SavedPublicationFailure> {
        self.0.lock().unwrap().push(fact.clone());
        Ok(())
    }
}

#[derive(Clone, Default)]
struct FailingEvents(Arc<AtomicUsize>);

impl SavedAftermath for FailingEvents {
    async fn announce(&self, _fact: &SavedChangeFact) -> Result<(), SavedPublicationFailure> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Err(SavedPublicationFailure::from_source(io::Error::other(
            "viewer event transport failed",
        )))
    }
}

#[derive(Clone, Default)]
struct LogBuffer(Arc<Mutex<Vec<u8>>>);

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

async fn seeded() -> (
    tempfile::TempDir,
    std::path::PathBuf,
    MessagingStore,
    Events,
) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("saved.sqlite");
    let mut db = crate::current_schema::create_current_schema(&path).await;
    db.execute(sqlx::raw_sql(
        "INSERT INTO users (id, name, display_name, created_at, updated_at) VALUES \
           ('user-1', 'local-test', 'Local Test User', 0, 0), ('user-2', 'peer', 'Peer', 0, 0), \
           ('user-3', 'stale', 'Stale', 0, 0); \
         INSERT INTO workspaces (id, name, name_key, owner_user_id, created_at, updated_at) \
           VALUES ('workspace-1', 'Space', 'space', 'user-1', 0, 0); \
         INSERT INTO workspace_users (workspace_id, user_id, joined_at, role) VALUES \
           ('workspace-1', 'user-1', 0, 'owner'), ('workspace-1', 'user-2', 0, 'member'); \
         INSERT INTO conversations (id, workspace_id, placement_kind, roster_policy, title, \
           title_key, status, visibility, created_at, updated_at, latest_message_seq) VALUES \
           ('conversation-1', 'workspace-1', 'workspace', 'open', 'saved-main', 'saved-main', \
            'open', 'private', 0, 0, 2), \
           ('conversation-public', 'workspace-1', 'workspace', 'open', 'Public', 'public', \
            'open', 'public', 0, 0, 1); \
         INSERT INTO conversations (id, workspace_id, placement_kind, roster_policy, title, \
           title_key, status, visibility, endpoint_a_kind, endpoint_a_id, endpoint_b_kind, endpoint_b_id, \
           created_at, updated_at, latest_message_seq) VALUES \
           ('pair-1', NULL, 'direct_pair', 'fixed', 'Pair', NULL, 'idle', 'private', \
            'human', 'user-1', 'human', 'user-2', 0, 0, 1); \
         INSERT INTO conversation_users (conversation_id, user_id, joined_at) VALUES \
           ('conversation-1', 'user-1', 0), ('conversation-1', 'user-2', 0), \
           ('conversation-1', 'user-3', 0); \
         INSERT INTO messages (id, conversation_id, from_kind, from_user_id, author_id, author_name, \
           author_display_name, content, metadata, seq, created_at, thread_root_id) VALUES \
           ('message-1', 'conversation-1', 'user', 'user-1', 'user-1', 'owner', 'Owner', \
            'saved parity', NULL, 1, 100, NULL), \
           ('reply-1', 'conversation-1', 'user', 'user-2', 'user-2', 'peer', 'Peer', \
            'reply', NULL, 2, 200, 'message-1'), \
           ('pair-message', 'pair-1', 'user', 'user-2', 'user-2', 'peer', 'Peer', \
            'dm', NULL, 1, 300, NULL), \
           ('public-message', 'conversation-public', 'user', 'user-1', 'user-1', 'local-test', \
            'Local Test User', 'public', NULL, 1, 400, NULL);",
    ))
    .await
    .unwrap();
    db.close().await.unwrap();
    let store = MessagingStore::open(&path).await.unwrap();
    (directory, path, store, Events::default())
}

async fn call(app: axum::Router, method: Method, uri: &str) -> (StatusCode, Value) {
    let response = app
        .oneshot(
            Request::builder()
                .method(method)
                .uri(uri)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let body = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into()))
    };
    (status, body)
}

#[tokio::test]
async fn save_and_unsave_publish_only_the_viewers_committed_changes() {
    let (_directory, path, store, events) = seeded().await;
    let app = router(store.saved(), store.saved(), events.clone())
        .layer(Extension(UserId::parse("user-1").unwrap()));

    let (status, first) = call(app.clone(), Method::POST, "/api/messages/message-1/save").await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(first["saved"]["message"]["id"], "message-1");
    assert_eq!(first["saved"]["place"]["kind"], "workspace_channel");
    assert_eq!(
        normalized_saved(first.clone()),
        fixture_body("save_changed")
    );
    let first_id = first["saved"]["id"].clone();

    let (status, duplicate) = call(app.clone(), Method::POST, "/api/messages/message-1/save").await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(duplicate["saved"]["id"], first_id);
    assert_eq!(normalized_saved(duplicate), fixture_body("save_duplicate"));
    assert_eq!(events.0.lock().unwrap().len(), 1);

    let (status, listed) = call(
        app.clone(),
        Method::GET,
        "/api/saved?workspace_id=workspace-1&user_id=user-1",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(normalized_saved(listed), fixture_body("list"));

    let (status, _) = call(app.clone(), Method::DELETE, "/api/messages/message-1/save").await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _) = call(app, Method::DELETE, "/api/messages/message-1/save").await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    {
        let facts = events.0.lock().unwrap();
        assert_eq!(facts.len(), 2);
        assert_eq!(facts[0].viewer().as_str(), "user-1");
        assert_eq!(facts[1].viewer().as_str(), "user-1");
        assert_eq!(
            changed_event(&facts[0]),
            json!({"message_id":"message-1","action":"save"})
        );
        assert_eq!(
            changed_event(&facts[1]),
            json!({"message_id":"message-1","action":"unsave"})
        );
        assert_eq!(
            changed_event(&facts[0]),
            fixture_case("save_changed")["event"]
        );
        assert_eq!(
            changed_event(&facts[1]),
            fixture_case("unsave_changed")["event"]
        );
    }

    let mut db = SqliteConnection::connect(&format!("sqlite:{}", path.display()))
        .await
        .unwrap();
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM saved_messages")
        .fetch_one(&mut db)
        .await
        .unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
async fn cold_list_rederives_workspace_and_direct_pair_participation() {
    let (_directory, path, store, events) = seeded().await;
    let owner = router(store.saved(), store.saved(), events.clone())
        .layer(Extension(UserId::parse("user-1").unwrap()));
    for message in ["message-1", "pair-message"] {
        assert_eq!(
            call(
                owner.clone(),
                Method::POST,
                &format!("/api/messages/{message}/save"),
            )
            .await
            .0,
            StatusCode::CREATED
        );
    }
    let (status, body) = call(owner.clone(), Method::GET, "/api/saved").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["saved"].as_array().unwrap().len(), 2);
    assert_eq!(body["saved"][0]["place"]["kind"], "direct_pair");
    assert_eq!(body["saved"][1]["place"]["kind"], "workspace_channel");

    let mut db = SqliteConnection::connect(&format!("sqlite:{}", path.display()))
        .await
        .unwrap();
    sqlx::query(
        "DELETE FROM workspace_users WHERE workspace_id='workspace-1' AND user_id='user-1'",
    )
    .execute(&mut db)
    .await
    .unwrap();
    let (status, body) = call(owner, Method::GET, "/api/saved").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["saved"].as_array().unwrap().len(), 1);
    assert_eq!(body["saved"][0]["place"]["kind"], "direct_pair");

    let stale = router(store.saved(), store.saved(), events)
        .layer(Extension(UserId::parse("user-3").unwrap()));
    let (status, _) = call(stale, Method::POST, "/api/messages/message-1/save").await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let public_nonseat = router(store.saved(), store.saved(), Events::default())
        .layer(Extension(UserId::parse("user-2").unwrap()));
    let (status, body) = call(
        public_nonseat,
        Method::POST,
        "/api/messages/public-message/save",
    )
    .await;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "public read authority does not widen the saved participation axis"
    );
    assert_eq!(body, fixture_body("save_public_unseated"));
}

#[tokio::test]
async fn filters_apply_before_the_cap_and_preserve_exact_message_projection() {
    let (_directory, _path, store, events) = seeded().await;
    let app = router(store.saved(), store.saved(), events)
        .layer(Extension(UserId::parse("user-1").unwrap()));
    for message in ["message-1", "reply-1", "pair-message"] {
        assert_eq!(
            call(
                app.clone(),
                Method::POST,
                &format!("/api/messages/{message}/save"),
            )
            .await
            .0,
            StatusCode::CREATED
        );
    }

    let (status, body) = call(
        app.clone(),
        Method::GET,
        "/api/saved?workspace_id=workspace-1&user_id=user-2",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["saved"].as_array().unwrap().len(), 1);
    assert_eq!(
        body["saved"][0]["message"],
        json!({
            "id":"reply-1",
            "conversation_id":"conversation-1",
            "from_kind":"user",
            "from_agent_id":null,
            "from_user_id":"user-2",
            "author":{
                "status":"active","kind":"user","id":"user-2","name":"peer",
                "display_name":"Peer","avatar_url":null,"runtime":null
            },
            "content":"reply",
            "metadata":null,
            "attachments":null,
            "reactions":null,
            "seq":2,
            "created_at":200,
            "thread_root_id":"message-1",
            "linked_task":null
        })
    );

    let (status, body) = call(
        app.clone(),
        Method::GET,
        "/api/saved?user_id=user-1&agent_id=agent-1",
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body, fixture_body("list_both_senders"));
    let (status, body) = call(app, Method::GET, "/api/saved?since=-1").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body, fixture_body("list_negative_since"));
}

#[tokio::test]
async fn workspace_filter_keeps_missing_and_forbidden_distinct() {
    let (_directory, _path, store, events) = seeded().await;
    let owner = router(store.saved(), store.saved(), events.clone())
        .layer(Extension(UserId::parse("user-1").unwrap()));
    assert_eq!(
        call(owner, Method::GET, "/api/saved?workspace_id=missing").await,
        (
            StatusCode::NOT_FOUND,
            json!({"error":"workspace not found"})
        )
    );

    let outsider = router(store.saved(), store.saved(), events)
        .layer(Extension(UserId::parse("user-3").unwrap()));
    assert_eq!(
        call(outsider, Method::GET, "/api/saved?workspace_id=workspace-1",).await,
        (StatusCode::FORBIDDEN, json!({"error":"forbidden"}))
    );
}

#[tokio::test]
async fn the_shared_fixture_is_a_closed_set_of_all_three_saved_surfaces() {
    let (_directory, _path, store, events) = seeded().await;
    let app = router(store.saved(), store.saved(), events)
        .layer(Extension(UserId::parse("user-1").unwrap()));
    for (name, method) in [
        ("save_missing", Method::POST),
        ("unsave_missing", Method::DELETE),
    ] {
        let (status, body) = call(app.clone(), method, "/api/messages/missing/save").await;
        assert_eq!(
            status.as_u16(),
            fixture_case(name)["status"].as_u64().unwrap() as u16
        );
        assert_eq!(body, fixture_body(name));
    }
    let fixture: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../packages/backend/tests/fixtures/saved-wire.json"
    )))
    .unwrap();
    let mut surfaces = fixture
        .as_array()
        .unwrap()
        .iter()
        .map(|case| case["surface"].as_str().unwrap())
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(surfaces.pop_first(), Some("human_delete"));
    assert_eq!(surfaces.pop_first(), Some("human_get"));
    assert_eq!(surfaces.pop_first(), Some("human_post"));
    assert!(surfaces.is_empty());
    assert_eq!(fixture.as_array().unwrap().len(), 10);
}

#[tokio::test]
async fn publication_failure_is_audited_once_without_compensating_the_save() {
    let (_directory, path, store, _events) = seeded().await;
    let failures = FailingEvents::default();
    let app = router(store.saved(), store.saved(), failures.clone())
        .layer(Extension(UserId::parse("user-1").unwrap()));
    let logs = LogBuffer::default();
    let subscriber = tracing_subscriber::fmt()
        .json()
        .with_writer(logs.clone())
        .finish();
    let _guard = tracing::subscriber::set_default(subscriber);
    let (status, _) = call(app, Method::POST, "/api/messages/message-1/save").await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(failures.0.load(Ordering::SeqCst), 1);

    let mut db = SqliteConnection::connect(&format!("sqlite:{}", path.display()))
        .await
        .unwrap();
    let saved: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM saved_messages WHERE user_id='user-1' AND message_id='message-1'",
    )
    .fetch_one(&mut db)
    .await
    .unwrap();
    assert_eq!(saved, 1);
    let output = String::from_utf8(logs.0.lock().unwrap().clone()).unwrap();
    let lines = output
        .lines()
        .filter(|line| line.contains("saved-message publication failed"))
        .collect::<Vec<_>>();
    assert_eq!(lines.len(), 1);
    assert!(lines[0].contains("viewer event transport failed"));
}

#[tokio::test]
async fn malformed_persisted_metadata_fails_closed_instead_of_emitting_an_invalid_dto() {
    let (_directory, path, store, events) = seeded().await;
    let app = router(store.saved(), store.saved(), events.clone())
        .layer(Extension(UserId::parse("user-1").unwrap()));
    assert_eq!(
        call(app.clone(), Method::POST, "/api/messages/message-1/save",)
            .await
            .0,
        StatusCode::CREATED
    );
    let mut db = SqliteConnection::connect(&format!("sqlite:{}", path.display()))
        .await
        .unwrap();
    sqlx::query("UPDATE messages SET metadata='[]' WHERE id='message-1'")
        .execute(&mut db)
        .await
        .unwrap();
    let (status, body) = call(app, Method::GET, "/api/saved").await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(body, Value::String("Internal Server Error".to_owned()));
    assert_eq!(events.0.lock().unwrap().len(), 1);
}
