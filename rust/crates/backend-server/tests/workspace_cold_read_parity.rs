//! Current Rust GET /api/workspaces envelope over the real SQLite adapter and router.
//! Reuses the historical seed, with a Rust-owned expected envelope: workspace
//! identity no longer includes retired sort preferences. The TS backend is not
//! updated because it is scheduled for removal.

use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::Value;
use silverhand_backend_core::foundation::identity::UserId;
use silverhand_backend_server::identity_access::workspaces::{self, WORKSPACES_PATH};
use silverhand_backend_sqlite::identity_access::workspace_cold_read::SqliteWorkspaceColdRead;
use sqlx::{Connection, Executor};
use tower::ServiceExt;

#[path = "../../backend-sqlite/tests/support/current_schema_snapshot.rs"]
mod current_schema;

/// The shared seed both languages replay byte-identically.
const SEED_SQL: &str =
    include_str!("../../../../packages/backend/tests/fixtures/workspace-cold-read/seed.sql");

/// Current Rust envelope; the retired TS backend is intentionally not updated.
const EXPECTED_ENVELOPE: &str = include_str!("fixtures/workspace-cold-read-envelope.json");

async fn seed(path: &std::path::Path) {
    let mut db = current_schema::create_current_schema(path).await;
    db.execute(sqlx::raw_sql(SEED_SQL))
        .await
        .expect("shared cold-read seed must load against the current schema");
    db.close().await.unwrap();
}

#[tokio::test]
async fn the_real_wire_projector_publishes_workspace_identity_without_legacy_sort() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("cold-read.sqlite");
    seed(&path).await;

    let cold_read = SqliteWorkspaceColdRead::open(&path).await.unwrap();
    let app: Router = workspaces::router(cold_read);

    // The authenticated principal is the composition root's contribution; this
    // test isolates the production projector, so it injects the viewer fact the
    // auth layer would otherwise attach. Auth composition is covered separately.
    let request = Request::builder()
        .uri(WORKSPACES_PATH)
        .extension(UserId::parse("user-1").unwrap())
        .body(Body::empty())
        .unwrap();
    let response = app.oneshot(request).await.unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok()),
        Some("application/json"),
    );

    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let actual: Value = serde_json::from_slice(&body).unwrap();
    let expected: Value = serde_json::from_str(EXPECTED_ENVELOPE).unwrap();
    assert_eq!(actual, expected);
}
