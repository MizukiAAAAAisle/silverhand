//! Authenticated composition e2e for GET /internal/agents/{aid}/tasks (#task:2196).
//!
//! Drives the REAL mounted composition — `task_list_router` over the production
//! `MessagingStore` board/participation authorities and the `SqliteTaskStore`
//! candidate fetch — to prove the three properties the driver-free unit tests and
//! the sqlite adapter tests cannot, because they exercise the layers in isolation:
//!
//!   * the whole vertical composes: an authenticated agent's request parses,
//!     resolves its board scope, fetches, trims to what it participates in, and
//!     projects the EXACT wire envelope the summary projector ratifies — over a
//!     real database, not a fake;
//!   * caller-shaped refusals carry the reason the resolver knows: a selector
//!     naming a workspace that does not exist is a `404` (`unknown_workspace`), a
//!     workspace that exists but the agent is not a member of is a `403`
//!     (`workspace_membership_required`), and a workspace the agent is a member of
//!     but lacks `read_tasks` on is a `403` (`capability_denied`);
//!   * a query naming a value outside its schema is a `400`
//!     decided before any authority is touched.
//!
//! The board-resolution ARMS themselves (union / selected / frame, capability and
//! participation folds) are proven against the real adapter in the sqlite crate's
//! `messaging_authorities` suite; this test proves the HTTP mount that composes
//! them, so it seeds one representative happy path plus the refusal shapes.

use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use silverhand_backend_core::foundation::identity::{AgentId, DaemonInstanceId};
use silverhand_backend_core::host_runtime::runtime_credential::{
    RuntimeCustody, RuntimeGeneration, RuntimePrincipal,
};
use silverhand_backend_server::messaging::task::{TaskListState, task_list_router};
use silverhand_backend_sqlite::messaging::{MessagingStore, task::SqliteTaskStore};
use sqlx::Connection;
use tempfile::TempDir;
use tower::ServiceExt;

#[path = "../../backend-sqlite/tests/support/current_schema_snapshot.rs"]
mod current_schema;

const AGENT: &str = "agent-1";
const NON_MEMBER_WORKSPACE: &str = "workspace-2";
const NO_CAPABILITY_WORKSPACE: &str = "workspace-3";
const ABSENT_WORKSPACE: &str = "workspace-absent";

/// A schema-current database seeded with one readable board and one visible task.
///
/// `agent-1` is a member of `workspace-1`, holds its `read_tasks` capability, and is
/// on the `conv-1` roster — so the union arm resolves that one board and the per-row
/// participation gate keeps its task. `workspace-2` exists but `agent-1` is not a
/// member (the membership refusal), and `workspace-3` exists with `agent-1` a member
/// but WITHOUT `read_tasks` (the capability refusal); a selector at neither's id nor
/// any absent id resolves.
async fn seed(directory: &TempDir) -> std::path::PathBuf {
    let path = directory.path().join("task-list-e2e.sqlite");
    let mut db = current_schema::create_current_schema(&path).await;
    for statement in [
        "INSERT INTO hosts (id, name, kind, created_at) VALUES ('host-1', 'host', 'local', 0)",
        "INSERT INTO users (id, name, display_name, created_at, updated_at) \
         VALUES ('user-1', 'user-1', 'User One', 0, 0)",
        "INSERT INTO agents (id, name, runtime, host_id, created_at, updated_at, display_name, \
         created_by_user_id, materialization_status, session_scope) \
         VALUES ('agent-1', 'lio', 'claude', 'host-1', 0, 0, 'Lio', 'user-1', 'active', 'agent')",
        "INSERT INTO workspaces (id, name, name_key, owner_user_id, created_at, updated_at) \
         VALUES ('workspace-1', 'Product Space', 'product space', 'user-1', 0, 0)",
        "INSERT INTO workspaces (id, name, name_key, owner_user_id, created_at, updated_at) \
         VALUES ('workspace-2', 'Other Space', 'other space', 'user-1', 0, 0)",
        "INSERT INTO workspaces (id, name, name_key, owner_user_id, created_at, updated_at) \
         VALUES ('workspace-3', 'Third Space', 'third space', 'user-1', 0, 0)",
        "INSERT INTO workspace_members (workspace_id, agent_id, joined_at) \
         VALUES ('workspace-1', 'agent-1', 0)",
        "INSERT INTO workspace_members (workspace_id, agent_id, joined_at) \
         VALUES ('workspace-3', 'agent-1', 0)",
        "INSERT INTO workspace_agent_capabilities (workspace_id, agent_id, capability) \
         VALUES ('workspace-1', 'agent-1', 'read_tasks')",
        "INSERT INTO conversations (id, workspace_id, placement_kind, roster_policy, title, \
         title_key, status, visibility, created_at, updated_at, latest_message_seq) \
         VALUES ('conv000000000001', 'workspace-1', 'workspace', 'open', 'General Chat', \
         'general chat', 'open', 'private', 0, 0, 0)",
        "INSERT INTO conversation_agents (conversation_id, agent_id, joined_at) \
         VALUES ('conv000000000001', 'agent-1', 0)",
        "INSERT INTO tasks (id, workspace_id, task_number, conversation_id, title, status, \
         creator_kind, created_at, board_key) \
         VALUES ('task-1', 'workspace-1', 1, 'conv000000000001', 'first', 'todo', 'system', 100, \
         'ws:workspace-1')",
    ] {
        sqlx::query(statement).execute(&mut db).await.unwrap();
    }
    db.close().await.unwrap();
    path
}

/// The real mounted router over both production adapters against the seeded database.
async fn app(path: &std::path::Path) -> Router {
    let boards = MessagingStore::open(path).await.unwrap();
    let fetch = SqliteTaskStore::open(path).await.unwrap();
    task_list_router(TaskListState { boards, fetch })
}

/// A request carrying the authenticated agent principal the runtime-credential middleware
/// would inject in production — an unanchored agent slot, so reach is the resolver's union.
fn request(query: &str) -> Request<Body> {
    let uri = format!("/internal/agents/{AGENT}/tasks{query}");
    let mut request = Request::get(uri).body(Body::empty()).unwrap();
    request
        .extensions_mut()
        .insert(RuntimePrincipal::AgentSlot {
            agent: AgentId::parse(AGENT).unwrap(),
            custody: RuntimeCustody::new(
                RuntimeGeneration::new(1).unwrap(),
                DaemonInstanceId::parse("daemon-1").unwrap(),
            ),
        });
    request
}

async fn answered(router: Router, request: Request<Body>) -> (StatusCode, Value) {
    let response = router.oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let value = serde_json::from_slice(&bytes).unwrap();
    (status, value)
}

/// The union happy path: the mounted vertical answers the agent's own boards with the
/// exact wire envelope — one system-created, unassigned, workspace-placed card.
#[tokio::test]
async fn a_mounted_agent_list_projects_its_visible_board() {
    let directory = tempfile::tempdir().unwrap();
    let path = seed(&directory).await;

    let (status, body) = answered(app(&path).await, request("")).await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body,
        json!({
            "tasks": [{
                "id": "task-1",
                "task_number": 1,
                "place": {
                    "kind": "workspace",
                    "conversation_id": "conv000000000001",
                    "workspace_id": "workspace-1",
                    "channel_name": "General Chat",
                },
                "thread_root_id": null,
                "status": "todo",
                "title": "first",
                "assignee": null,
                "creator": { "type": "system", "id": null, "name": "system" },
                "created_at": 100,
                "closed_at": null,
            }]
        })
    );
}

/// A selector naming a workspace that does not exist is a `404` that says so — `context
/// over control`: the caller learns the real reason rather than an undistinguished refusal.
#[tokio::test]
async fn a_selector_for_an_absent_workspace_is_not_found() {
    let directory = tempfile::tempdir().unwrap();
    let path = seed(&directory).await;

    let (status, body) = answered(
        app(&path).await,
        request(&format!("?workspace_id={ABSENT_WORKSPACE}")),
    )
    .await;

    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(
        body,
        json!({
            "error": format!("workspace {ABSENT_WORKSPACE} not found"),
            "code": "unknown_workspace",
        })
    );
}

/// A selector aimed at a workspace that exists but the agent is not a member of is a `403`
/// naming the membership gate, distinct from the absent-workspace `404`.
#[tokio::test]
async fn a_selector_for_a_non_member_workspace_is_membership_forbidden() {
    let directory = tempfile::tempdir().unwrap();
    let path = seed(&directory).await;

    let (status, body) = answered(
        app(&path).await,
        request(&format!("?workspace_id={NON_MEMBER_WORKSPACE}")),
    )
    .await;

    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(
        body,
        json!({
            "error": format!("agent is not a member of workspace {NON_MEMBER_WORKSPACE}"),
            "code": "workspace_membership_required",
        })
    );
}

/// A selector aimed at a workspace the agent is a member of but lacks `read_tasks` on is a
/// `403` naming the capability, the parity of `requireAgentCapability`'s refusal.
#[tokio::test]
async fn a_selector_without_read_tasks_is_capability_forbidden() {
    let directory = tempfile::tempdir().unwrap();
    let path = seed(&directory).await;

    let (status, body) = answered(
        app(&path).await,
        request(&format!("?workspace_id={NO_CAPABILITY_WORKSPACE}")),
    )
    .await;

    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(
        body,
        json!({
            "code": "capability_denied",
            "capability": "read_tasks",
            "message": "missing 'read_tasks' capability in this workspace",
            "details": { "capability": "read_tasks" },
        })
    );
}

/// A query naming a status outside the schema is a `400` decided before any authority is
/// consulted — a stable `invalid_query` code plus a message naming the field and its rule.
#[tokio::test]
async fn a_query_outside_its_schema_is_a_specific_bad_request() {
    let directory = tempfile::tempdir().unwrap();
    let path = seed(&directory).await;

    let (status, body) = answered(app(&path).await, request("?status=nonsense")).await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        body,
        json!({
            "code": "invalid_query",
            "message": "query field 'status' must be one of: todo, in_progress, in_review, done, closed",
        })
    );
}
