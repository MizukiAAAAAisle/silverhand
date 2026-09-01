//! Composed proof for the Rust `GET /api/agents/{id}/presence` vertical
//! (#task:2195, batch 4).
//!
//! The per-branch matrix — every ACL arm, hidden vs. active stage, the never-active
//! null deadline, the source-bind and missing-principal faults, the injected
//! `server_now` — is already pinned by the unit tests of the three layers this
//! composes: `capability::agent_view`, `agent_presence_read`, and the route's own
//! `tests` module against a fake read model and a fixed clock. What no unit test can
//! show is that those layers WIRE UP end to end: that the real SQLite
//! `SqliteAgentPresenceColdRead` adapter — its `last_activity_at` and its two
//! set-shaped ACL arms on one deferred snapshot, its strict decode — feeds the real
//! `host_agent::agent_presence::router` and yields the exact wire bytes.
//!
//! So this is a single LOAD-BEARING composition proof, not a differential and not a
//! matrix: two vectors driven through the real stack against a fresh current-schema
//! database — one admitted creator whose stored `last_activity_at` must project to the
//! shared away deadline alongside a live `server_now`, and one registered stranger whom
//! the anti-enumeration ACL must collapse to `404 {"error":"agent not found"}`. The
//! expected `away_at` is the shared TTL policy applied to the seeded stamp; the Rust
//! vertical is now that policy's sole wire consumer here.
//!
//! `server_now` is asserted only to be a live positive stamp from the injected
//! production clock — its exact value is the wall clock, deliberately not pinned; the
//! route's unit test pins the injected-clock contract with a frozen fixture.
//!
//! The route is authenticated, so each request injects the `UserId` extension the
//! composition perimeter (#task:2197) would attach; the auth-refusal body is that
//! perimeter's, not this test's.

use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use silverhand_backend_core::{foundation::identity::UserId, policy::agent_presence};
use silverhand_backend_server::{clock::SystemProcessClock, host_agent::agent_presence::router};
use silverhand_backend_sqlite::host_runtime::agent_presence_read::SqliteAgentPresenceColdRead;
use sqlx::{Connection, Executor};
use tower::ServiceExt;

#[path = "../../backend-sqlite/tests/support/current_schema_snapshot.rs"]
mod current_schema;

/// Materialize a fresh current-schema database, run `seed_sql` verbatim against it,
/// then drive the real adapter and router for `viewer` asking about `agent_id`.
/// Returns the wire status and parsed JSON body; the `application/json` envelope is
/// asserted here because both the admit and the refuse paths must carry it.
async fn run(seed_sql: &'static str, viewer: &str, agent_id: &str) -> (StatusCode, Value) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("agent-presence-contract.sqlite");
    let mut db = current_schema::create_current_schema(&path).await;
    db.execute(sqlx::raw_sql(seed_sql))
        .await
        .expect("agent-presence seed must load against the current schema");
    db.close().await.unwrap();

    let cold_read = SqliteAgentPresenceColdRead::open(&path).await.unwrap();
    // The production wall clock: `server_now` is a live emit-only stamp, so the composed
    // proof wires the real clock rather than a fixture. `away_at` stays deterministic
    // because it is clock-free.
    let app: Router = router(cold_read, SystemProcessClock);

    // The authenticated principal is the composition perimeter's contribution; this
    // test isolates the production projector, so it injects the viewer fact the auth
    // layer would otherwise attach.
    let request = Request::builder()
        .uri(format!("/api/agents/{agent_id}/presence"))
        .extension(UserId::parse(viewer).unwrap())
        .body(Body::empty())
        .unwrap();
    let response = app.oneshot(request).await.unwrap();

    let status = response.status();
    assert_eq!(
        response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok()),
        Some("application/json"),
    );
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let value: Value = serde_json::from_slice(&body).unwrap();
    (status, value)
}

#[tokio::test]
async fn an_admitted_creator_reads_the_away_deadline_through_the_real_stack() {
    // The agent was last active at 1000; the away deadline is the shared TTL policy
    // applied to that stored stamp, resolved through the real adapter — not a hand-set
    // literal.
    let seed = "\
        INSERT INTO users (id, name, display_name, created_at, updated_at) \
        VALUES ('u-creator', 'creator', 'Creator', 1000, 1000); \
        INSERT INTO hosts (id, name, kind, created_at) \
        VALUES ('h1', 'host-one', 'desktop', 1000); \
        INSERT INTO agents (id, name, runtime, host_id, created_at, updated_at, \
          created_by_user_id, materialization_status, last_activity_at) \
        VALUES ('a1', 'agent-one', 'qoder', 'h1', 1000, 2000, 'u-creator', 'active', 1000);";

    let (status, body) = run(seed, "u-creator", "a1").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body["away_at"],
        json!(1_000 + agent_presence::AWAY_TTL_MS),
        "away_at must be the shared policy applied to the stored stamp"
    );
    let server_now = body["server_now"]
        .as_i64()
        .expect("server_now must be an integer stamp from the injected clock");
    assert!(
        server_now > 0,
        "server_now must be a live positive stamp, got {server_now}"
    );
}

#[tokio::test]
async fn a_registered_stranger_is_the_anti_enumeration_404() {
    // A human in NO arm — not the creator, not a direct-pair endpoint, not a member of
    // any workspace the agent reaches — must be indistinguishable from an absent row:
    // the same byte-identical 404, so the surface is never an existence oracle.
    let seed = "\
        INSERT INTO users (id, name, display_name, created_at, updated_at) \
        VALUES ('u-creator', 'creator', 'Creator', 1000, 1000); \
        INSERT INTO users (id, name, display_name, created_at, updated_at) \
        VALUES ('u-stranger', 'stranger', 'Stranger', 1000, 1000); \
        INSERT INTO hosts (id, name, kind, created_at) \
        VALUES ('h1', 'host-one', 'desktop', 1000); \
        INSERT INTO agents (id, name, runtime, host_id, created_at, updated_at, \
          created_by_user_id, materialization_status, last_activity_at) \
        VALUES ('a1', 'agent-one', 'qoder', 'h1', 1000, 1000, 'u-creator', 'active', 1000);";

    let (status, body) = run(seed, "u-stranger", "a1").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body, json!({ "error": "agent not found" }));
}
