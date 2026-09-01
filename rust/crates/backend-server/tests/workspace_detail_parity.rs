//! Rust half of the cross-language GET /api/workspaces/:id detail parity gate
//! (#task:2193).
//!
//! The SAME checked-in fixture the TypeScript oracle replays
//! (packages/backend/tests/workspace-detail-parity.test.ts) is replayed here: one
//! `seed.sql` executed verbatim against a fresh current-schema database, and one
//! `cases.json` of (id → {status, body}) pairs. Here each response is produced by
//! the REAL production stack — the SQLite `SqliteWorkspaceDetailRead` adapter
//! driven through the real `workspace_detail::router`, so the actual admission
//! ladder (existence before visibility, the classifier's identity-sealed 200 face,
//! the 403/404 refusal bodies) is what gets compared.
//!
//! The TS side runs first as the oracle: the expected status+body are hand-authored
//! but signed by the real TS authority (`workspaces.get` + `canViewWorkspace` +
//! `toViewerWorkspace`) before the Rust side is asked to match them, so the two
//! implementations cannot drift on existence/visibility ordering, the DM
//! derivation, or the published face shape.

use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::Value;
use silverhand_backend_core::foundation::identity::UserId;
use silverhand_backend_server::identity_access::workspace_detail::{self, WORKSPACE_DETAIL_PATH};
use silverhand_backend_sqlite::identity_access::workspace_detail_read::SqliteWorkspaceDetailRead;
use sqlx::{Connection, Executor};
use tower::ServiceExt;

#[path = "../../backend-sqlite/tests/support/current_schema_snapshot.rs"]
mod current_schema;

const SEED_SQL: &str =
    include_str!("../../../../packages/backend/tests/fixtures/workspace-detail/seed.sql");
const CASES_JSON: &str =
    include_str!("../../../../packages/backend/tests/fixtures/workspace-detail/cases.json");

async fn seed(path: &std::path::Path) {
    let mut db = current_schema::create_current_schema(path).await;
    db.execute(sqlx::raw_sql(SEED_SQL))
        .await
        .expect("shared workspace-detail seed must load against the current schema");
    db.close().await.unwrap();
}

#[tokio::test]
async fn the_real_detail_route_produces_the_shared_expected_responses() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("workspace-detail.sqlite");
    seed(&path).await;

    let read = SqliteWorkspaceDetailRead::open(&path).await.unwrap();
    let app: Router = workspace_detail::router(read);

    let fixture: Value = serde_json::from_str(CASES_JSON).unwrap();
    let cases = fixture["cases"].as_array().unwrap();
    assert!(!cases.is_empty(), "the fixture must carry cases");

    // The route template is `/api/workspaces/{id}`; the served path substitutes the
    // fixture id into that one capture segment.
    let path_prefix = WORKSPACE_DETAIL_PATH.strip_suffix("{id}").unwrap();

    for case in cases {
        let name = case["name"].as_str().unwrap();
        let id = case["id"].as_str().unwrap();
        let expected_status = case["expected"]["status"].as_u64().unwrap() as u16;
        let expected_body = &case["expected"]["body"];

        let request = Request::builder()
            .uri(format!("{path_prefix}{id}"))
            .extension(UserId::parse("user-1").unwrap())
            .body(Body::empty())
            .unwrap();
        let response = app.clone().oneshot(request).await.unwrap();

        assert_eq!(
            response.status(),
            StatusCode::from_u16(expected_status).unwrap(),
            "{name}"
        );
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let actual: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(&actual, expected_body, "{name}");
    }
}
