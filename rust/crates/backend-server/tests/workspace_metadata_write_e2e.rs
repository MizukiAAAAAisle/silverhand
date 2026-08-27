//! Full-route behaviour for the workspace metadata-write surface (#task:2193):
//! `PATCH /api/workspaces/{id}` and `PATCH /api/workspaces/{id}/archive`, driven
//! through the REAL Axum router with the REAL SQLite governance-read and
//! write-unit-of-work adapters. Only the two effects this task does not own a
//! production adapter for yet — the `metadata_changed` viewer hint and the clock —
//! are fakes; the sink is a recording/failing spy so the route's viewer-hint
//! obligation is observable.
//!
//! This is the Rust-self-guarded half of the slice's evidence: the refusal
//! ORDERING (404 → 403 → 400 → 409 → 200) and the committed `200` body. It is NOT
//! a cross-language gate — those rungs are structural, readable straight from the
//! TS route, not byte-drift-prone. The one drift-prone boundary (the `400`
//! Zod-issue bytes) is pinned separately by the shared admission fixture and its
//! TS oracle.
//!
//! ## The per-channel rename message is NOT exercised here
//!
//! A committed rename owes TWO production effects: the `viewer_workspaces_changed`
//! cache-invalidation hint (a pure id-only signal, fired inside the domain and
//! complete on its own) and the per-channel workspace-rename SYSTEM MESSAGE. The
//! latter — authoring PLUS delivery PLUS publication — is a composition-root
//! concern deferred WHOLE to the [#task:2215] mount seam (see the module doc of
//! `workspace_metadata_write`), driven off the same committed `WorkspaceNameChange`
//! this surface seals. This suite therefore asserts only the viewer hint: that a
//! rename fires it for exactly the renamed workspace, that a description-only edit
//! owes none, and that a FAILING hint never downgrades the committed `200`.

use std::sync::{Arc, Mutex};

use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use silverhand_backend_core::{
    identity::{UserId, WorkspaceId},
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

/// A seeded database plus the clock/sink fakes that make the route's effects
/// observable.
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
    async fn router(&self, clock: FixedClock, sink: RecordingSink) -> Router {
        let governance = SqliteAccessStore::open(&self.path).await.unwrap();
        let writes = SqliteWorkspaceMetadataWrite::open(&self.path).await.unwrap();
        workspace_metadata_write::router(governance, writes, sink, clock)
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
async fn a_rename_by_the_owner_commits_and_fires_the_viewer_hint() {
    let harness = Harness::seeded().await;
    let sink = RecordingSink::new(false);
    let app = harness.router(FixedClock(777), sink.clone()).await;

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
}

#[tokio::test]
async fn a_non_admin_is_forbidden_before_the_body_is_parsed() {
    let harness = Harness::seeded().await;
    let sink = RecordingSink::new(false);
    let app = harness.router(FixedClock(777), sink.clone()).await;

    // A member sends a MALFORMED body. If the body were parsed first this would be
    // a 400; the 403 proves the governance floor is resolved before the body.
    let response = app
        .oneshot(metadata_request("ws-1", "user-3", "not even json"))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_eq!(json_body(response).await, json!({ "error": "forbidden" }));
    // No name moved, so the viewer hint never fired.
    assert!(sink.ids().is_empty());
    assert_eq!(harness.stored("ws-1").await.0, "Original");
}

#[tokio::test]
async fn an_unknown_workspace_is_not_found() {
    let harness = Harness::seeded().await;
    let app = harness.router(FixedClock(777), RecordingSink::new(false)).await;

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
    let app = harness.router(FixedClock(777), RecordingSink::new(false)).await;

    let response = app
        .oneshot(metadata_request("ws-home", "user-1", r#"{"name":"X"}"#))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_malformed_body_from_an_admin_is_invalid_input() {
    let harness = Harness::seeded().await;
    let app = harness.router(FixedClock(777), RecordingSink::new(false)).await;

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
    let app = harness.router(FixedClock(777), RecordingSink::new(false)).await;

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
async fn a_description_only_edit_owes_no_viewer_hint() {
    let harness = Harness::seeded().await;
    let sink = RecordingSink::new(false);
    let app = harness.router(FixedClock(500), sink.clone()).await;

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
    // No display name moved: no viewer hint.
    assert!(sink.ids().is_empty());
}

#[tokio::test]
async fn a_committed_rename_survives_a_failing_viewer_hint() {
    let harness = Harness::seeded().await;
    // The viewer hint is broken. The commit must still stand as 200, the body must
    // be the committed face, and the hint must still have been ATTEMPTED.
    let sink = RecordingSink::new(true);
    let app = harness.router(FixedClock(777), sink.clone()).await;

    let response = app
        .oneshot(metadata_request("ws-1", "user-1", r#"{"name":"Design Team"}"#))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(json_body(response).await["workspace"]["name"], json!("Design Team"));
    // The rename is durably committed regardless of the hint failure.
    assert_eq!(harness.stored("ws-1").await.0, "Design Team");
    // The sink WAS attempted; its failure did not downgrade the 200.
    assert_eq!(sink.ids(), vec!["ws-1".to_owned()]);
}

#[tokio::test]
async fn archive_requires_the_owner_floor() {
    let harness = Harness::seeded().await;
    let app = harness.router(FixedClock(777), RecordingSink::new(false)).await;

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
    let archive_app = harness.router(FixedClock(900), RecordingSink::new(false)).await;

    let response = archive_app
        .oneshot(archive_request("ws-1", "user-1", r#"{"archived":true}"#))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = json_body(response).await;
    assert_eq!(body["workspace"]["archived_at"], json!(900));
    assert_eq!(harness.stored("ws-1").await.2, Some(900));

    // A fresh router (a new pool) clears it again.
    let unarchive_app = harness.router(FixedClock(950), RecordingSink::new(false)).await;
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
    let app = harness.router(FixedClock(777), RecordingSink::new(false)).await;

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
async fn a_large_body_with_unknown_keys_is_accepted_no_size_cap() {
    let harness = Harness::seeded().await;
    let sink = RecordingSink::new(false);
    let app = harness.router(FixedClock(777), sink.clone()).await;

    // A syntactically valid rename body with a huge UNKNOWN key. The leaf imposes
    // no size cap (a body-size perimeter is a mount-seam concern), and `z.object`
    // strips unknown keys — so this parses to `{name:"Design"}` and renames, it is
    // NOT a 413. This is the regression guard for the removed 16 KiB→413 cap: the
    // product route has no such limit, so a large legitimate body must succeed.
    let large = format!(r#"{{"name":"Design","pad":"{}"}}"#, "a".repeat(20_000));
    let response = app
        .oneshot(metadata_request("ws-1", "user-1", &large))
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(harness.stored("ws-1").await.0, "Design");
}

#[tokio::test]
async fn a_large_body_from_a_non_governor_is_403_before_the_body_is_read() {
    let harness = Harness::seeded().await;
    let app = harness.router(FixedClock(777), RecordingSink::new(false)).await;

    // user-3 is a plain member: the floor refuses BEFORE the body is read, so the
    // body's size is irrelevant — the deferred read proves the floor gates it.
    let large = format!(r#"{{"name":"Design","pad":"{}"}}"#, "a".repeat(20_000));
    let response = app
        .oneshot(metadata_request("ws-1", "user-3", &large))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}
