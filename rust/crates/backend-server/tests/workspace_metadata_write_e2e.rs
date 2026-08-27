//! Full-route behaviour for the workspace metadata-write surface (#task:2193):
//! `PATCH /api/workspaces/{id}` and `PATCH /api/workspaces/{id}/archive`, driven
//! through the REAL Axum router with the REAL SQLite governance-read and
//! write-unit-of-work adapters. Only the three effects this task does not own a
//! production adapter for yet — the `metadata_changed` viewer hint, the
//! per-channel rename author, and the channel population read (their real
//! adapters land with the #2215 composition) — plus the clock are fakes, and they
//! are recording/failing spies so the route's obligations are observable.
//!
//! This is the Rust-self-guarded half of the slice's evidence: the refusal
//! ORDERING (404 → 403 → 400 → 409 → 200), the committed `200` body, and the P0
//! best-effort INDEPENDENCE of the two post-commit rename effects. It is NOT a
//! cross-language gate — those rungs are structural, readable straight from the
//! TS route, not byte-drift-prone. The one drift-prone boundary (the `400`
//! Zod-issue bytes) is pinned separately by the shared admission fixture and its
//! TS oracle.
//!
//! ## The P0 (Cindy, verbatim)
//!
//! > committed rename 后的 viewer hint 与逐-channel rename message 必须彼此独立、
//! > 都要尝试；任一失败不能把已提交的 200 变成 500，也不能阻止另一个 effect。
//!
//! The viewer hint fires inside the domain and its fate returns as a value; the
//! per-channel author loop runs in the route. `a_committed_rename_survives_*`
//! prove a failing sink, a failing author, and a failing channel read each leave
//! the committed `200` and its body intact, and that a sink failure does not stop
//! the author loop (nor the reverse).

use std::sync::{Arc, Mutex};

use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use silverhand_backend_core::{
    identity::{ConversationId, UserId, WorkspaceId},
    messaging::collaboration::workspace_rename_messaging::{
        CommittedWorkspaceRenameMessage, WorkspaceRenameChannel, WorkspaceRenameChannels,
        WorkspaceRenameChannelsReadPort, WorkspaceRenameMessageAuthorPort,
        WorkspaceRenameMessageCreatedAt, WorkspaceRenameMessageDraft,
    },
    messaging::{MessageId, MessageSeq},
    workspace_metadata_write::{WorkspaceMetadataAnnounceFailure, WorkspaceMetadataChangedSink},
};
use silverhand_backend_server::workspace_metadata_write::{self, WorkspaceMetadataClock};
use silverhand_backend_sqlite::{
    access::SqliteAccessStore, workspace_metadata_write::SqliteWorkspaceMetadataWrite,
};
use sqlx::{Connection, Executor, SqliteConnection};
use tower::ServiceExt;

const CURRENT_SCHEMA: &str =
    include_str!("../../../../packages/backend/tests/migration-baseline/schema-current.sql");

// user-1 owns ws-1, user-2 is its admin, user-3 a member, user-9 a stranger. ws-2
// holds the fold key `taken` for the collision case; ws-home is an agent-home
// workspace that must read as NoSuchWorkspace through the regular door.
const SEED_SQL: &str = "\
INSERT INTO users (id, name, display_name, created_at, updated_at) VALUES ('user-1', 'owner', 'Owner', 1, 1); \
INSERT INTO users (id, name, display_name, created_at, updated_at) VALUES ('user-2', 'admin', 'Admin', 1, 1); \
INSERT INTO users (id, name, display_name, created_at, updated_at) VALUES ('user-3', 'member', 'Member', 1, 1); \
INSERT INTO users (id, name, display_name, created_at, updated_at) VALUES ('user-9', 'stranger', 'Stranger', 1, 1); \
INSERT INTO hosts (id, name, kind, created_at) VALUES ('host-1', 'Host', 'local', 1); \
INSERT INTO agents (id, name, display_name, runtime, host_id, created_by_user_id, created_at, updated_at) \
  VALUES ('agent-1', 'alice', 'Alice', 'claude', 'host-1', 'user-1', 1, 1); \
INSERT INTO workspaces (id, name, name_key, description, owner_agent_id, owner_user_id, archived_at, created_at, updated_at) \
  VALUES ('ws-1', 'Original', 'original', 'first', NULL, 'user-1', NULL, 10, 100); \
INSERT INTO workspaces (id, name, name_key, description, owner_agent_id, owner_user_id, archived_at, created_at, updated_at) \
  VALUES ('ws-2', 'Taken', 'taken', NULL, NULL, 'user-1', NULL, 10, 100); \
INSERT INTO workspaces (id, name, name_key, description, owner_agent_id, owner_user_id, archived_at, created_at, updated_at) \
  VALUES ('ws-home', 'Agent Home', NULL, NULL, 'agent-1', NULL, NULL, 10, 100); \
INSERT INTO workspace_users (workspace_id, user_id, joined_at, role) VALUES ('ws-1', 'user-1', 1, 'owner'); \
INSERT INTO workspace_users (workspace_id, user_id, joined_at, role) VALUES ('ws-1', 'user-2', 1, 'admin'); \
INSERT INTO workspace_users (workspace_id, user_id, joined_at, role) VALUES ('ws-1', 'user-3', 1, 'member');";

/// A stand-in adapter error, opaque like the production ones.
#[derive(Debug)]
struct FakeError(&'static str);
impl std::fmt::Display for FakeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for FakeError {}

/// The clock the route samples; a fixed instant makes `updated_at`/`archived_at`
/// deterministic.
#[derive(Clone)]
struct FixedClock(i64);
impl WorkspaceMetadataClock for FixedClock {
    fn now_unix_millis(&self) -> i64 {
        self.0
    }
}

/// The viewer-hint sink, recording every id it was asked to announce and,
/// optionally, refusing — so a lost hint can be observed to NOT affect the 200.
#[derive(Clone)]
struct RecordingSink {
    announced: Arc<Mutex<Vec<String>>>,
    fail: bool,
}
impl RecordingSink {
    fn new(fail: bool) -> Self {
        Self {
            announced: Arc::new(Mutex::new(Vec::new())),
            fail,
        }
    }
    fn ids(&self) -> Vec<String> {
        self.announced.lock().unwrap().clone()
    }
}
impl WorkspaceMetadataChangedSink for RecordingSink {
    async fn workspace_metadata_changed(
        &self,
        workspace_id: &WorkspaceId,
    ) -> Result<(), WorkspaceMetadataAnnounceFailure> {
        self.announced
            .lock()
            .unwrap()
            .push(workspace_id.as_str().to_owned());
        if self.fail {
            return Err(WorkspaceMetadataAnnounceFailure::from_source(FakeError(
                "viewer hint transport down",
            )));
        }
        Ok(())
    }
}

/// The channel-population read, returning a configured set of conversations for
/// the renamed workspace or, optionally, failing outright.
#[derive(Clone)]
struct FakeChannels {
    conversations: Vec<String>,
    fail: bool,
}
impl FakeChannels {
    fn of(conversations: &[&str]) -> Self {
        Self {
            conversations: conversations.iter().map(|c| (*c).to_owned()).collect(),
            fail: false,
        }
    }
    fn failing() -> Self {
        Self {
            conversations: Vec::new(),
            fail: true,
        }
    }
}
impl WorkspaceRenameChannelsReadPort for FakeChannels {
    type Error = FakeError;
    async fn list_non_closed(
        &self,
        workspace: &WorkspaceId,
    ) -> Result<WorkspaceRenameChannels, Self::Error> {
        if self.fail {
            return Err(FakeError("channel population read down"));
        }
        let rows = self
            .conversations
            .iter()
            .map(|c| {
                WorkspaceRenameChannel::selected(
                    workspace.clone(),
                    ConversationId::parse(c.as_str()).unwrap(),
                )
            })
            .collect();
        Ok(WorkspaceRenameChannels::selected(workspace.clone(), rows).unwrap())
    }
}

/// The rename-message author, recording each `(conversation, content)` it commits
/// and, optionally, failing for ONE named conversation so the loop's per-channel
/// independence is observable.
#[derive(Clone)]
struct RecordingAuthor {
    authored: Arc<Mutex<Vec<(String, String)>>>,
    fail_on: Option<String>,
}
impl RecordingAuthor {
    fn new() -> Self {
        Self {
            authored: Arc::new(Mutex::new(Vec::new())),
            fail_on: None,
        }
    }
    fn failing_on(conversation: &str) -> Self {
        Self {
            authored: Arc::new(Mutex::new(Vec::new())),
            fail_on: Some(conversation.to_owned()),
        }
    }
    fn commits(&self) -> Vec<(String, String)> {
        self.authored.lock().unwrap().clone()
    }
}
impl WorkspaceRenameMessageAuthorPort for RecordingAuthor {
    type Error = FakeError;
    async fn author(
        &self,
        draft: WorkspaceRenameMessageDraft,
    ) -> Result<CommittedWorkspaceRenameMessage, Self::Error> {
        let conversation = draft.conversation().as_str().to_owned();
        if self.fail_on.as_deref() == Some(conversation.as_str()) {
            return Err(FakeError("rename author down for this channel"));
        }
        self.authored
            .lock()
            .unwrap()
            .push((conversation.clone(), draft.content().to_owned()));
        let message = MessageId::parse(format!("msg-{conversation}")).unwrap();
        let seq = MessageSeq::try_from(1_i64).unwrap();
        let created_at = WorkspaceRenameMessageCreatedAt::new(1).unwrap();
        Ok(CommittedWorkspaceRenameMessage::committed(
            draft, message, seq, created_at,
        ))
    }
}

/// A seeded database plus the fakes that make the route's effects observable.
struct Harness {
    _dir: tempfile::TempDir,
    path: std::path::PathBuf,
}

impl Harness {
    async fn seeded() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace-metadata-write-e2e.sqlite");
        let options = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true)
            .foreign_keys(true);
        let mut db = SqliteConnection::connect_with(&options).await.unwrap();
        db.execute(sqlx::raw_sql(CURRENT_SCHEMA)).await.unwrap();
        db.execute(sqlx::raw_sql(SEED_SQL)).await.unwrap();
        db.close().await.unwrap();
        Self { _dir: dir, path }
    }

    /// Build the real router over the real stores and the given fakes.
    async fn router(
        &self,
        clock: FixedClock,
        sink: RecordingSink,
        channels: FakeChannels,
        author: RecordingAuthor,
    ) -> Router {
        let governance = SqliteAccessStore::open(&self.path).await.unwrap();
        let writes = SqliteWorkspaceMetadataWrite::open(&self.path).await.unwrap();
        workspace_metadata_write::router(governance, writes, sink, clock, channels, author)
    }

    /// The stored `(name, name_key, archived_at)` — the durable truth a committed
    /// or refused write leaves behind.
    async fn stored(&self, id: &str) -> (String, Option<String>, Option<i64>) {
        let mut db = SqliteConnection::connect(&format!("sqlite://{}", self.path.display()))
            .await
            .unwrap();
        let row = sqlx::query_as::<_, (String, Option<String>, Option<i64>)>(
            "SELECT name, name_key, archived_at FROM workspaces WHERE id = ?",
        )
        .bind(id)
        .fetch_one(&mut db)
        .await
        .unwrap();
        db.close().await.unwrap();
        row
    }
}

fn metadata_request(id: &str, user: &str, body: &str) -> Request<Body> {
    Request::builder()
        .method("PATCH")
        .uri(format!("/api/workspaces/{id}"))
        .extension(UserId::parse(user).unwrap())
        .body(Body::from(body.to_owned()))
        .unwrap()
}

fn archive_request(id: &str, user: &str, body: &str) -> Request<Body> {
    Request::builder()
        .method("PATCH")
        .uri(format!("/api/workspaces/{id}/archive"))
        .extension(UserId::parse(user).unwrap())
        .body(Body::from(body.to_owned()))
        .unwrap()
}

async fn json_body(response: axum::response::Response) -> Value {
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    serde_json::from_slice(&body).unwrap()
}

#[tokio::test]
async fn a_rename_by_the_owner_commits_and_authors_every_channel_message() {
    let harness = Harness::seeded().await;
    let sink = RecordingSink::new(false);
    let author = RecordingAuthor::new();
    let app = harness
        .router(
            FixedClock(777),
            sink.clone(),
            FakeChannels::of(&["conv-a", "conv-b"]),
            author.clone(),
        )
        .await;

    let response = app
        .oneshot(metadata_request("ws-1", "user-1", r#"{"name":"Design Team"}"#))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = json_body(response).await;
    assert_eq!(
        body,
        json!({
            "workspace": {
                "id": "ws-1",
                "name": "Design Team",
                "description": "first",
                "owner_agent_id": null,
                "owner_user_id": "user-1",
                "dm_channel_id": null,
                "dm_channel_ids": [],
                "archived_at": null,
                "created_at": 10,
                "updated_at": 777
            }
        })
    );
    // The rename is durably committed with the folded key.
    assert_eq!(
        harness.stored("ws-1").await,
        ("Design Team".to_owned(), Some("design team".to_owned()), None)
    );
    // The viewer hint fired for exactly this workspace.
    assert_eq!(sink.ids(), vec!["ws-1".to_owned()]);
    // Every non-closed channel got the rename message with the old→new content.
    let commits = author.commits();
    let expected = "This workspace was renamed from `Original` to `Design Team`. \
                    Update any references in your MEMORY.md when you next edit it.";
    assert_eq!(
        commits,
        vec![
            ("conv-a".to_owned(), expected.to_owned()),
            ("conv-b".to_owned(), expected.to_owned()),
        ]
    );
}

#[tokio::test]
async fn a_non_admin_is_forbidden_before_the_body_is_parsed() {
    let harness = Harness::seeded().await;
    let sink = RecordingSink::new(false);
    let author = RecordingAuthor::new();
    let app = harness
        .router(
            FixedClock(777),
            sink.clone(),
            FakeChannels::of(&["conv-a"]),
            author.clone(),
        )
        .await;

    // A member sends a MALFORMED body. If the body were parsed first this would be
    // a 400; the 403 proves the governance floor is resolved before the body.
    let response = app
        .oneshot(metadata_request("ws-1", "user-3", "not even json"))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_eq!(json_body(response).await, json!({ "error": "forbidden" }));
    // No name moved, so neither post-commit effect ran.
    assert!(sink.ids().is_empty());
    assert!(author.commits().is_empty());
    assert_eq!(harness.stored("ws-1").await.0, "Original");
}

#[tokio::test]
async fn an_unknown_workspace_is_not_found() {
    let harness = Harness::seeded().await;
    let app = harness
        .router(
            FixedClock(777),
            RecordingSink::new(false),
            FakeChannels::of(&[]),
            RecordingAuthor::new(),
        )
        .await;

    let response = app
        .oneshot(metadata_request("ws-missing", "user-1", r#"{"name":"X"}"#))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert_eq!(
        json_body(response).await,
        json!({ "error": "workspace not found" })
    );
}

#[tokio::test]
async fn an_agent_home_workspace_is_not_found_through_the_regular_door() {
    let harness = Harness::seeded().await;
    let app = harness
        .router(
            FixedClock(777),
            RecordingSink::new(false),
            FakeChannels::of(&[]),
            RecordingAuthor::new(),
        )
        .await;

    let response = app
        .oneshot(metadata_request("ws-home", "user-1", r#"{"name":"X"}"#))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_malformed_body_from_an_admin_is_invalid_input() {
    let harness = Harness::seeded().await;
    let app = harness
        .router(
            FixedClock(777),
            RecordingSink::new(false),
            FakeChannels::of(&[]),
            RecordingAuthor::new(),
        )
        .await;

    // user-2 is an admin, so it clears the rename floor and the body IS parsed.
    let response = app
        .oneshot(metadata_request("ws-1", "user-2", "{}"))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        json_body(response).await,
        json!({
            "error": "invalid input",
            "issues": [{ "code": "custom", "message": "no fields to update", "path": [] }]
        })
    );
}

#[tokio::test]
async fn a_name_held_by_another_workspace_is_conflict() {
    let harness = Harness::seeded().await;
    let app = harness
        .router(
            FixedClock(777),
            RecordingSink::new(false),
            FakeChannels::of(&["conv-a"]),
            RecordingAuthor::new(),
        )
        .await;

    let response = app
        .oneshot(metadata_request("ws-1", "user-1", r#"{"name":"Taken"}"#))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    assert_eq!(
        json_body(response).await,
        json!({ "error": "workspace name already exists" })
    );
    // Nothing moved.
    assert_eq!(harness.stored("ws-1").await.0, "Original");
}

#[tokio::test]
async fn a_description_only_edit_owes_no_rename_effects() {
    let harness = Harness::seeded().await;
    let sink = RecordingSink::new(false);
    let author = RecordingAuthor::new();
    let app = harness
        .router(
            FixedClock(500),
            sink.clone(),
            FakeChannels::of(&["conv-a"]),
            author.clone(),
        )
        .await;

    let response = app
        .oneshot(metadata_request(
            "ws-1",
            "user-1",
            r#"{"description":"second"}"#,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = json_body(response).await;
    assert_eq!(body["workspace"]["description"], json!("second"));
    assert_eq!(body["workspace"]["name"], json!("Original"));
    assert_eq!(body["workspace"]["updated_at"], json!(500));
    // No display name moved: no viewer hint, no channel messages.
    assert!(sink.ids().is_empty());
    assert!(author.commits().is_empty());
}

#[tokio::test]
async fn a_committed_rename_survives_a_failing_sink_and_a_failing_author() {
    let harness = Harness::seeded().await;
    // Both post-commit effects are broken. The commit must still stand as 200, the
    // body must be the committed face, and each effect must still be ATTEMPTED
    // (independent, no first-error short-circuit).
    let sink = RecordingSink::new(true);
    let author = RecordingAuthor::failing_on("conv-a");
    let app = harness
        .router(
            FixedClock(777),
            sink.clone(),
            FakeChannels::of(&["conv-a", "conv-b"]),
            author.clone(),
        )
        .await;

    let response = app
        .oneshot(metadata_request("ws-1", "user-1", r#"{"name":"Design Team"}"#))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(json_body(response).await["workspace"]["name"], json!("Design Team"));
    // The rename is durably committed regardless of the two failures.
    assert_eq!(harness.stored("ws-1").await.0, "Design Team");
    // The sink WAS attempted (its failure did not stop the author loop).
    assert_eq!(sink.ids(), vec!["ws-1".to_owned()]);
    // conv-a failed but conv-b was still authored: one channel's failure does not
    // block the others.
    assert_eq!(author.commits().len(), 1);
    assert_eq!(author.commits()[0].0, "conv-b");
}

#[tokio::test]
async fn a_committed_rename_survives_a_failing_channel_population_read() {
    let harness = Harness::seeded().await;
    let sink = RecordingSink::new(false);
    let app = harness
        .router(
            FixedClock(777),
            sink.clone(),
            FakeChannels::failing(),
            RecordingAuthor::new(),
        )
        .await;

    let response = app
        .oneshot(metadata_request("ws-1", "user-1", r#"{"name":"Design Team"}"#))
        .await
        .unwrap();
    // The channel read failed, but the rename is committed and the viewer hint —
    // fired inside the domain before the route touches channels — still ran.
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(harness.stored("ws-1").await.0, "Design Team");
    assert_eq!(sink.ids(), vec!["ws-1".to_owned()]);
}

#[tokio::test]
async fn archive_requires_the_owner_floor() {
    let harness = Harness::seeded().await;
    let app = harness
        .router(
            FixedClock(777),
            RecordingSink::new(false),
            FakeChannels::of(&[]),
            RecordingAuthor::new(),
        )
        .await;

    // An admin clears the rename floor but NOT the archive floor.
    let response = app
        .oneshot(archive_request("ws-1", "user-2", r#"{"archived":true}"#))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_eq!(harness.stored("ws-1").await.2, None);
}

#[tokio::test]
async fn the_owner_archives_and_unarchives() {
    let harness = Harness::seeded().await;
    let archive_app = harness
        .router(
            FixedClock(900),
            RecordingSink::new(false),
            FakeChannels::of(&[]),
            RecordingAuthor::new(),
        )
        .await;

    let response = archive_app
        .oneshot(archive_request("ws-1", "user-1", r#"{"archived":true}"#))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = json_body(response).await;
    assert_eq!(body["workspace"]["archived_at"], json!(900));
    assert_eq!(harness.stored("ws-1").await.2, Some(900));

    // A fresh router (a new pool) clears it again.
    let unarchive_app = harness
        .router(
            FixedClock(950),
            RecordingSink::new(false),
            FakeChannels::of(&[]),
            RecordingAuthor::new(),
        )
        .await;
    let response = unarchive_app
        .oneshot(archive_request("ws-1", "user-1", r#"{"archived":false}"#))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(json_body(response).await["workspace"]["archived_at"], Value::Null);
    assert_eq!(harness.stored("ws-1").await.2, None);
}

#[tokio::test]
async fn a_missing_archived_flag_is_invalid_input() {
    let harness = Harness::seeded().await;
    let app = harness
        .router(
            FixedClock(777),
            RecordingSink::new(false),
            FakeChannels::of(&[]),
            RecordingAuthor::new(),
        )
        .await;

    let response = app
        .oneshot(archive_request("ws-1", "user-1", "{}"))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        json_body(response).await,
        json!({
            "error": "invalid input",
            "issues": [{
                "code": "invalid_type", "expected": "boolean", "received": "undefined",
                "path": ["archived"], "message": "Required"
            }]
        })
    );
}

#[tokio::test]
async fn a_body_over_the_16_kib_cap_from_a_governor_is_413() {
    let harness = Harness::seeded().await;
    let sink = RecordingSink::new(false);
    let author = RecordingAuthor::new();
    let app = harness
        .router(
            FixedClock(777),
            sink.clone(),
            FakeChannels::of(&["conv-a"]),
            author.clone(),
        )
        .await;

    // A syntactically valid rename body padded past 16 KiB with a huge unknown key.
    let oversized = format!(r#"{{"name":"Design","pad":"{}"}}"#, "a".repeat(20_000));
    let response = app
        .oneshot(metadata_request("ws-1", "user-1", &oversized))
        .await
        .unwrap();

    // The transport cap fires before the body is parsed: 413, no rename effect.
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(harness.stored("ws-1").await.0, "Original");
    assert!(sink.ids().is_empty());
    assert!(author.commits().is_empty());
}

#[tokio::test]
async fn an_oversized_body_from_a_non_governor_is_403_not_413() {
    let harness = Harness::seeded().await;
    let app = harness
        .router(
            FixedClock(777),
            RecordingSink::new(false),
            FakeChannels::of(&[]),
            RecordingAuthor::new(),
        )
        .await;

    // user-3 is a plain member: the floor refuses BEFORE the body is read, so the
    // 16 KiB cap never applies — the deferred read proves the floor gates it.
    let oversized = format!(r#"{{"name":"Design","pad":"{}"}}"#, "a".repeat(20_000));
    let response = app
        .oneshot(metadata_request("ws-1", "user-3", &oversized))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}
