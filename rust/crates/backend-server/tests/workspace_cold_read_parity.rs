//! Rust half of the cross-language GET /api/workspaces cold-read parity gate
//! (#task:2190).
//!
//! The SAME checked-in fixture the TypeScript oracle replays
//! (packages/backend/tests/workspace-cold-read-parity.test.ts) is replayed here:
//! one `seed.sql` executed verbatim against a fresh current-schema database, and
//! one `expected-envelope.json` the projector's serialized wire body must equal.
//! Here the value is produced by the REAL production stack — the SQLite
//! `SqliteWorkspaceColdRead` adapter over one `BEGIN DEFERRED` snapshot, driven
//! through the real `workspaces::router` so the actual `WorkspaceColdReadResponse`
//! wire projector (snake_case, null-verbatim, `dm_channel_ids` array, two-key
//! order, visible-and-non-archived sort filter) is what gets compared.
//!
//! The TS side runs first as the oracle: the expected JSON is hand-authored but
//! signed by the real TS authority before the Rust side is asked to match it, so
//! this test is a pure differential against that ratified artifact — the two
//! implementations cannot drift on any facet of the envelope.

use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::Value;
use silverhand_backend_core::identity::UserId;
use silverhand_backend_server::workspaces::{self, WORKSPACES_PATH};
use silverhand_backend_sqlite::workspace_cold_read::SqliteWorkspaceColdRead;
use sqlx::{Connection, Executor};
use tower::ServiceExt;

#[path = "../../backend-sqlite/tests/support/current_schema_snapshot.rs"]
mod current_schema;

/// The shared seed both languages replay byte-identically.
const SEED_SQL: &str =
    include_str!("../../../../packages/backend/tests/fixtures/workspace-cold-read/seed.sql");

/// The one expected envelope both projectors are held to.
const EXPECTED_ENVELOPE: &str = include_str!(
    "../../../../packages/backend/tests/fixtures/workspace-cold-read/expected-envelope.json"
);

async fn seed(path: &std::path::Path) {
    let mut db = current_schema::create_current_schema(path).await;
    db.execute(sqlx::raw_sql(SEED_SQL))
        .await
        .expect("shared cold-read seed must load against the current schema");
    db.close().await.unwrap();
}

#[tokio::test]
async fn the_real_wire_projector_produces_the_shared_expected_envelope() {
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
