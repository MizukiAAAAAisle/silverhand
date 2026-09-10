//! Whole-envelope parity and corruption tests for the SQLite cold-read adapter,
//! exercised against the checked-in executable current schema.

use std::error::Error;

use silverhand_backend_core::{
    foundation::identity::UserId, foundation::persistence::PersistenceFailure,
    identity_access::workspace_cold_read::WorkspaceColdReadUnitOfWork,
};
use silverhand_backend_sqlite::identity_access::workspace_cold_read::{
    SqliteWorkspaceColdRead, WorkspaceColdReadError,
};
use sqlx::{Connection, Executor};

#[path = "support/current_schema_snapshot.rs"]
mod current_schema;

/// The one shared cross-language seed, replayed byte-identically by the TS oracle
/// (packages/backend/tests/workspace-cold-read-parity.test.ts) and the wire-level
/// Rust parity test (backend-server/tests/workspace_cold_read_parity.rs). It seeds
/// a viewer who is a member of a regular, an agent-home, and an archived workspace,
/// plus a workspace they cannot see; timestamps are mutually unequal so the
/// published two-key order is unambiguous without an id tie-break.
const SEED_SQL: &str =
    include_str!("../../../../packages/backend/tests/fixtures/workspace-cold-read/seed.sql");

fn viewer() -> UserId {
    UserId::parse("user-1").unwrap()
}

async fn seed_parity_fixture(path: &std::path::Path) {
    let mut db = current_schema::create_current_schema(path).await;
    db.execute(sqlx::raw_sql(SEED_SQL))
        .await
        .expect("shared cold-read seed must load against the current schema");
    db.close().await.unwrap();
}

#[tokio::test]
async fn workspace_envelope_is_membership_scoped_and_ordered() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("cold-read.sqlite");
    seed_parity_fixture(&path).await;

    let read = SqliteWorkspaceColdRead::open(&path)
        .await
        .unwrap()
        .load_workspace_cold_read(&viewer())
        .await
        .unwrap();

    // Regular workspaces first (updated_at DESC among them), then the agent-home
    // one; the foreign workspace is absent. Archived stays in the list.
    assert_eq!(
        read.workspaces
            .iter()
            .map(|workspace| workspace.id.as_str())
            .collect::<Vec<_>>(),
        ["ws-archived", "ws-regular", "ws-agent"]
    );

    let regular = &read.workspaces[1];
    assert_eq!(regular.name, "Regular");
    assert_eq!(regular.owner_agent_id, None);
    assert_eq!(
        regular.owner_user_id.as_ref().map(|id| id.as_str()),
        Some("user-1")
    );
    assert_eq!(regular.dm_channel_id, None);
    assert!(regular.dm_channel_ids.is_empty());
    assert_eq!(regular.archived_at, None);

    let archived = &read.workspaces[0];
    assert_eq!(archived.archived_at, Some(999));

    // The agent-home face carries the full published DM contract in priority order.
    let agent = &read.workspaces[2];
    assert_eq!(
        agent.owner_agent_id.as_ref().map(|id| id.as_str()),
        Some("agent-1")
    );
    assert_eq!(agent.owner_user_id, None);
    assert_eq!(
        agent.dm_channel_id.as_ref().map(|id| id.as_str()),
        Some("conv-onboarding")
    );
    assert_eq!(
        agent
            .dm_channel_ids
            .iter()
            .map(|id| id.as_str())
            .collect::<Vec<_>>(),
        ["conv-onboarding", "conv-dm"]
    );
}

/// Opens a fresh schema database with check constraints disabled, so a corruption
/// fixture can persist a value the write path could never produce.
async fn corrupt_schema(path: &std::path::Path) -> sqlx::SqliteConnection {
    let mut db = current_schema::create_current_schema(path).await;
    sqlx::query("PRAGMA ignore_check_constraints = ON")
        .execute(&mut db)
        .await
        .unwrap();
    db
}

async fn cold_read_failure(path: &std::path::Path) -> PersistenceFailure {
    SqliteWorkspaceColdRead::open(path)
        .await
        .unwrap()
        .load_workspace_cold_read(&viewer())
        .await
        .unwrap_err()
}

/// Downcasts the safe-500 failure to its typed corruption source. Every corruption
/// case must surface this way rather than as a product refusal.
fn corruption_source(failure: &PersistenceFailure) -> &WorkspaceColdReadError {
    Error::source(failure)
        .and_then(|source| source.downcast_ref::<WorkspaceColdReadError>())
        .expect("the cold-read failure must carry its typed source")
}

#[tokio::test]
async fn an_empty_committed_workspace_id_is_corruption_not_an_empty_wire_id() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("corrupt-id.sqlite");
    let mut db = corrupt_schema(&path).await;
    for statement in [
        "INSERT INTO users (id, name, display_name, created_at, updated_at) \
         VALUES ('user-1', 'viewer', 'Viewer', 1, 1)",
        "INSERT INTO workspaces (id, name, name_key, owner_agent_id, owner_user_id, created_at, \
         updated_at) VALUES ('', 'Blank Id', 'blank', NULL, 'user-1', 1, 1)",
        "INSERT INTO workspace_users (workspace_id, user_id, joined_at, role) \
         VALUES ('', 'user-1', 1, 'owner')",
    ] {
        sqlx::query(statement).execute(&mut db).await.unwrap();
    }
    db.close().await.unwrap();

    assert!(matches!(
        corruption_source(&cold_read_failure(&path).await),
        WorkspaceColdReadError::MalformedIdentity { field } if *field == "workspaces.id"
    ));
}

#[tokio::test]
async fn retired_sort_entity_ids_are_not_read() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("corrupt-entity.sqlite");
    let mut db = corrupt_schema(&path).await;
    for statement in [
        "INSERT INTO users (id, name, display_name, created_at, updated_at) \
         VALUES ('user-1', 'viewer', 'Viewer', 1, 1)",
        "INSERT INTO workspaces (id, name, name_key, owner_agent_id, owner_user_id, created_at, \
         updated_at) VALUES ('ws-1', 'Regular', 'regular', NULL, 'user-1', 1, 1)",
        "INSERT INTO workspace_users (workspace_id, user_id, joined_at, role) \
         VALUES ('ws-1', 'user-1', 1, 'owner')",
        // Retired malformed sort entries must not affect workspace identity reads.
        "INSERT INTO user_sort_entry (user_id, list_key, entity_id, rank) \
         VALUES ('user-1', 'workspaces', '', 0)",
    ] {
        sqlx::query(statement).execute(&mut db).await.unwrap();
    }
    db.close().await.unwrap();

    let read = SqliteWorkspaceColdRead::open(&path)
        .await
        .unwrap()
        .load_workspace_cold_read(&UserId::parse("user-1").unwrap())
        .await
        .unwrap();
    assert_eq!(read.workspaces.len(), 1);
    assert_eq!(read.workspaces[0].id.as_str(), "ws-1");
}

#[tokio::test]
async fn retired_sort_scopes_are_not_read() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("corrupt-scope.sqlite");
    let mut db = corrupt_schema(&path).await;
    for statement in [
        "INSERT INTO users (id, name, display_name, created_at, updated_at) \
         VALUES ('user-1', 'viewer', 'Viewer', 1, 1)",
        "INSERT INTO workspaces (id, name, name_key, owner_agent_id, owner_user_id, created_at, \
         updated_at) VALUES ('ws-1', 'Regular', 'regular', NULL, 'user-1', 1, 1)",
        "INSERT INTO workspace_users (workspace_id, user_id, joined_at, role) \
         VALUES ('ws-1', 'user-1', 1, 'owner')",
        // Historical grouping state has no current reader.
        "INSERT INTO user_list_sort_mode (user_id, list_key, scope, mode, updated_at) \
         VALUES ('user-1', 'workspaces', '', 'manual', 1)",
    ] {
        sqlx::query(statement).execute(&mut db).await.unwrap();
    }
    db.close().await.unwrap();

    let read = SqliteWorkspaceColdRead::open(&path)
        .await
        .unwrap()
        .load_workspace_cold_read(&UserId::parse("user-1").unwrap())
        .await
        .unwrap();
    assert_eq!(read.workspaces.len(), 1);
    assert_eq!(read.workspaces[0].id.as_str(), "ws-1");
}

#[tokio::test]
async fn retired_sort_modes_are_not_read() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("corrupt-mode.sqlite");
    let mut db = corrupt_schema(&path).await;
    for statement in [
        "INSERT INTO users (id, name, display_name, created_at, updated_at) \
         VALUES ('user-1', 'viewer', 'Viewer', 1, 1)",
        "INSERT INTO workspaces (id, name, name_key, owner_agent_id, owner_user_id, created_at, \
         updated_at) VALUES ('ws-1', 'Regular', 'regular', NULL, 'user-1', 1, 1)",
        "INSERT INTO workspace_users (workspace_id, user_id, joined_at, role) \
         VALUES ('ws-1', 'user-1', 1, 'owner')",
        "INSERT INTO user_list_sort_mode (user_id, list_key, scope, mode, updated_at) \
         VALUES ('user-1', 'workspaces', 'regular', 'chronological', 1)",
    ] {
        sqlx::query(statement).execute(&mut db).await.unwrap();
    }
    db.close().await.unwrap();

    let read = SqliteWorkspaceColdRead::open(&path)
        .await
        .unwrap()
        .load_workspace_cold_read(&UserId::parse("user-1").unwrap())
        .await
        .unwrap();
    assert_eq!(read.workspaces.len(), 1);
    assert_eq!(read.workspaces[0].id.as_str(), "ws-1");
}
