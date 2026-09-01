//! Production SQLite workspace-scope reader against the real, checked-in current
//! schema (#task:2252).
//!
//! The agent-pane data plane resolves a `?workspace_id=…` scoped read through
//! [`AgentWorkspaceScopeRead`]: existence, the human's `workspace_users` edge, and
//! the agent's `workspace_members` edge, read under ONE transaction and judged by
//! the pure [`resolve_agent_workspace_scope`]. These tests pin the five-way branch
//! against real rows, and in particular the load-bearing discriminator: an agent's
//! private HOME container (whose schema forbids a `workspace_members` row) admits
//! the agent by OWNER IDENTITY, while every regular workspace goes by the explicit
//! member edge.

use silverhand_backend_core::{
    foundation::identity::{AgentId, UserId, WorkspaceId},
    workspace_data_plane::{
        AgentWorkspaceScopeRead, AgentWorkspaceScopeRefusal, AgentWorkspaceScopeResolution,
        resolve_agent_workspace_scope,
    },
};
use silverhand_backend_sqlite::workspace_data_plane::SqliteWorkspaceScopeStore;
use sqlx::Connection;
use tempfile::TempDir;

#[path = "support/current_schema_snapshot.rs"]
mod current_schema;

const VIEWER: &str = "user-viewer";
const AGENT: &str = "agent-a1";
const OTHER_AGENT: &str = "agent-a2";

fn workspace(id: &str) -> WorkspaceId {
    WorkspaceId::parse(id).expect("workspace id")
}

fn agent(id: &str) -> AgentId {
    AgentId::parse(id).expect("agent id")
}

fn viewer() -> UserId {
    UserId::parse(VIEWER).expect("user id")
}

/// Materialize the real schema and seed the scope-read fixtures:
///  * viewer human + host + two agents (`a1` is the pane agent, `a2` is other),
///  * `ws-regular`: regular, viewer on the roster, `a1` a `workspace_members` member,
///  * `ws-regular-nomember`: regular, viewer on the roster, `a1` NOT a member,
///  * `ws-forbidden`: regular, `a1` a member, viewer NOT on the roster,
///  * `ws-home-a1`: `a1`'s private home, viewer on the roster,
///  * `ws-home-a2`: `a2`'s private home, viewer on the roster.
async fn seeded() -> (TempDir, SqliteWorkspaceScopeStore) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("workspace-scope.db");
    let mut db = current_schema::create_current_schema(&path).await;

    for statement in [
        "INSERT INTO users (id, name, display_name, created_at, updated_at) \
         VALUES ('user-viewer', 'viewer', 'Viewer', 1, 1)",
        "INSERT INTO hosts (id, name, kind, created_at) VALUES ('host-1', 'host-1', 'desktop', 1)",
        "INSERT INTO agents (id, name, runtime, host_id, created_at, updated_at, created_by_user_id) \
         VALUES ('agent-a1', 'a1', 'claude', 'host-1', 1, 1, 'user-viewer')",
        "INSERT INTO agents (id, name, runtime, host_id, created_at, updated_at, created_by_user_id) \
         VALUES ('agent-a2', 'a2', 'claude', 'host-1', 1, 1, 'user-viewer')",
        // Regular workspaces carry a name_key and a NULL owner_agent_id.
        "INSERT INTO workspaces (id, name, name_key, created_at, updated_at) \
         VALUES ('ws-regular', 'Regular', 'ws-regular', 1, 1)",
        "INSERT INTO workspaces (id, name, name_key, created_at, updated_at) \
         VALUES ('ws-regular-nomember', 'RegularNoMember', 'ws-regular-nomember', 1, 1)",
        "INSERT INTO workspaces (id, name, name_key, created_at, updated_at) \
         VALUES ('ws-forbidden', 'Forbidden', 'ws-forbidden', 1, 1)",
        // Private homes carry an owner_agent_id and a NULL name_key.
        "INSERT INTO workspaces (id, name, owner_agent_id, created_at, updated_at) \
         VALUES ('ws-home-a1', 'HomeA1', 'agent-a1', 1, 1)",
        "INSERT INTO workspaces (id, name, owner_agent_id, created_at, updated_at) \
         VALUES ('ws-home-a2', 'HomeA2', 'agent-a2', 1, 1)",
        // Human roster edges.
        "INSERT INTO workspace_users (workspace_id, user_id, joined_at, role) \
         VALUES ('ws-regular', 'user-viewer', 1, 'owner')",
        "INSERT INTO workspace_users (workspace_id, user_id, joined_at, role) \
         VALUES ('ws-regular-nomember', 'user-viewer', 1, 'owner')",
        "INSERT INTO workspace_users (workspace_id, user_id, joined_at, role) \
         VALUES ('ws-home-a1', 'user-viewer', 1, 'owner')",
        "INSERT INTO workspace_users (workspace_id, user_id, joined_at, role) \
         VALUES ('ws-home-a2', 'user-viewer', 1, 'owner')",
        // Agent member edges (regular workspaces only; the schema forbids one on a home).
        "INSERT INTO workspace_members (workspace_id, agent_id, joined_at) \
         VALUES ('ws-regular', 'agent-a1', 1)",
        "INSERT INTO workspace_members (workspace_id, agent_id, joined_at) \
         VALUES ('ws-forbidden', 'agent-a1', 1)",
    ] {
        sqlx::query(statement).execute(&mut db).await.unwrap();
    }

    db.close().await.unwrap();
    let store = SqliteWorkspaceScopeStore::open(&path).await.unwrap();
    (directory, store)
}

/// Read facts for `workspace_id` and judge them for the pane agent + viewer.
async fn resolve(
    store: &SqliteWorkspaceScopeStore,
    workspace_id: &str,
) -> AgentWorkspaceScopeResolution {
    let facts = store
        .read_agent_workspace_scope(&workspace(workspace_id), &viewer(), &agent(AGENT))
        .await
        .expect("scope read");
    // The facts are source-bound to the FULL triple they were read for: the route
    // rejects a drift on any of the three as a resolver defect, so the reader must
    // always stamp the exact workspace/viewer/agent it answered for.
    assert_eq!(facts.requested().as_str(), workspace_id);
    assert_eq!(facts.viewer().as_str(), VIEWER);
    assert_eq!(facts.subject_agent().as_str(), AGENT);
    resolve_agent_workspace_scope(&facts)
}

#[tokio::test]
async fn a_regular_workspace_with_both_edges_is_authorized() {
    let (_dir, store) = seeded().await;
    assert_eq!(
        resolve(&store, "ws-regular").await,
        AgentWorkspaceScopeResolution::Authorized
    );
}

#[tokio::test]
async fn an_absent_workspace_is_not_found() {
    let (_dir, store) = seeded().await;
    assert_eq!(
        resolve(&store, "ws-missing").await,
        AgentWorkspaceScopeResolution::Refused(AgentWorkspaceScopeRefusal::WorkspaceNotFound)
    );
}

#[tokio::test]
async fn a_viewer_off_the_roster_is_forbidden() {
    let (_dir, store) = seeded().await;
    assert_eq!(
        resolve(&store, "ws-forbidden").await,
        AgentWorkspaceScopeResolution::Refused(AgentWorkspaceScopeRefusal::ViewerForbidden)
    );
}

#[tokio::test]
async fn a_regular_workspace_without_the_agent_edge_is_not_a_member() {
    let (_dir, store) = seeded().await;
    assert_eq!(
        resolve(&store, "ws-regular-nomember").await,
        AgentWorkspaceScopeResolution::Refused(AgentWorkspaceScopeRefusal::AgentNotAMember)
    );
}

#[tokio::test]
async fn an_agent_home_admits_its_owner_with_no_member_edge() {
    // `ws-home-a1` has NO `workspace_members` row (the schema forbids one), yet
    // the owner agent is a member by identity.
    let (_dir, store) = seeded().await;
    assert_eq!(
        resolve(&store, "ws-home-a1").await,
        AgentWorkspaceScopeResolution::Authorized
    );
}

#[tokio::test]
async fn another_agents_home_is_not_a_member() {
    // The viewer is on `ws-home-a2`'s roster, but the pane agent `a1` does not own
    // that home, so it is not a member of it.
    let (_dir, store) = seeded().await;
    assert_eq!(
        resolve(&store, "ws-home-a2").await,
        AgentWorkspaceScopeResolution::Refused(AgentWorkspaceScopeRefusal::AgentNotAMember)
    );
}

#[tokio::test]
async fn a_read_stamps_the_requested_triple_even_when_no_edge_matches() {
    // Behavioral evidence that the request coordinates are always available to stamp:
    // a read whose viewer and agent match NOTHING still returns exactly the requested
    // workspace/viewer/agent with both edges false. (This alone does NOT prove the
    // coordinates come from the CTE rather than the method params — a param-clone would
    // pass it too; the SQL SHAPE guard in `reader.rs` pins that. Here we only pin the
    // no-match behavior the resolver relies on.)
    let (_dir, store) = seeded().await;
    let stranger = UserId::parse("user-stranger").expect("user id");
    let outsider = agent("agent-outsider");
    let facts = store
        .read_agent_workspace_scope(&workspace("ws-regular"), &stranger, &outsider)
        .await
        .expect("scope read");
    assert_eq!(facts.requested().as_str(), "ws-regular");
    assert_eq!(facts.viewer().as_str(), "user-stranger");
    assert_eq!(facts.subject_agent().as_str(), "agent-outsider");
    // The stranger is not on the roster, so the human-view edge is the first refusal.
    assert_eq!(
        resolve_agent_workspace_scope(&facts),
        AgentWorkspaceScopeResolution::Refused(AgentWorkspaceScopeRefusal::ViewerForbidden)
    );
}

#[tokio::test]
async fn the_pane_agent_home_ownership_ignores_a_foreign_member_edge() {
    // A defensive cross-check that the owner branch, not the member edge, decides a
    // home: `a2`'s home has no member edge for `a1`, and even the viewer roster is
    // present, so only the owner-identity rule can produce the not-a-member answer.
    let (_dir, store) = seeded().await;
    let facts = store
        .read_agent_workspace_scope(&workspace("ws-home-a2"), &viewer(), &agent(OTHER_AGENT))
        .await
        .expect("scope read");
    // `a2` DOES own `ws-home-a2`, so for `a2` it authorizes — proving the branch
    // keys on owner identity, not on any `workspace_members` row.
    assert_eq!(facts.subject_agent().as_str(), OTHER_AGENT);
    assert_eq!(
        resolve_agent_workspace_scope(&facts),
        AgentWorkspaceScopeResolution::Authorized
    );
}
