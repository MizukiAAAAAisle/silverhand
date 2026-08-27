//! SQLite adapter for the regular-workspace name namespace behind
//! `GET /api/workspaces/name-availability`.
//!
//! The namespace is REGULAR workspaces only: an agent-home workspace stores a
//! `NULL` `name_key` (`owner_agent_id IS NOT NULL`), and the schema's
//! `CHECK ((owner_agent_id IS NULL) = (name_key IS NOT NULL))` guarantees the two
//! are never both set. The lookup therefore scopes to `owner_agent_id IS NULL`
//! and compares the pinned fold key the domain already produced — the SAME key
//! the create path stores and the partial unique index
//! `idx_workspaces_name_key ... WHERE owner_agent_id IS NULL` enforces. The
//! adapter returns the row's OWN stored key rather than a boolean, so the
//! driver-free [`probe_workspace_name`](silverhand_backend_core::workspace_name_availability::probe_workspace_name)
//! can bind a positive answer against the key it asked about.

use std::path::Path;

use silverhand_backend_core::{
    persistence::PersistenceFailure,
    workspace_name::CanonicalWorkspaceName,
    workspace_name_availability::{HeldName, RegularWorkspaceNamespace},
};
use sqlx::{
    Row, SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
};
use std::time::Duration;
use thiserror::Error;

const POOL_CONNECTIONS: u32 = 4;
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

/// The holder-of-a-key lookup. `name_key = ?` alone already excludes agent-home
/// rows (their key is `NULL` and `NULL = ?` is never true), but the namespace is
/// spelled out with `owner_agent_id IS NULL` so the SQL states the definition
/// rather than leaning on that coincidence — and matches the partial unique index
/// the create path collides against. At most one row can match (the index is
/// unique over regular workspaces), so `LIMIT 1` is a statement of that fact.
const SELECT_HOLDER_OF_NAME_KEY: &str = "\
SELECT name_key FROM workspaces \
 WHERE name_key = ? AND owner_agent_id IS NULL \
 LIMIT 1";

#[derive(Clone)]
pub struct SqliteRegularWorkspaceNamespace {
    pool: SqlitePool,
}

/// Read failures surfaced only as the source of a [`PersistenceFailure`]. The one
/// variant is a driver fault; there is no committed-row corruption arm because the
/// query projects a single already-validated `name_key` string.
#[derive(Debug, Error)]
pub enum WorkspaceNameNamespaceError {
    #[error("database operation failed")]
    Sql(#[from] sqlx::Error),
}

impl SqliteRegularWorkspaceNamespace {
    pub async fn open(path: impl AsRef<Path>) -> Result<Self, WorkspaceNameNamespaceError> {
        let options = SqliteConnectOptions::new()
            .filename(path.as_ref())
            .create_if_missing(false)
            .foreign_keys(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Full)
            .busy_timeout(BUSY_TIMEOUT);
        let pool = SqlitePoolOptions::new()
            .max_connections(POOL_CONNECTIONS)
            .connect_with(options)
            .await?;
        Ok(Self { pool })
    }

    /// Construct over an already-open pool, so a composition root that shares one
    /// pool across adapters need not reopen the file.
    pub fn from_pool(pool: SqlitePool) -> Self {
        Self { pool }
    }
}

impl RegularWorkspaceNamespace for SqliteRegularWorkspaceNamespace {
    async fn holder_of_name(
        &self,
        name: &CanonicalWorkspaceName,
    ) -> Result<Option<HeldName>, PersistenceFailure> {
        let row = sqlx::query(SELECT_HOLDER_OF_NAME_KEY)
            .bind(name.key())
            .fetch_optional(&self.pool)
            .await
            .map_err(|error| {
                PersistenceFailure::from_source(WorkspaceNameNamespaceError::Sql(error))
            })?;
        // The projected column is the row's OWN key. It is returned verbatim; the
        // driver-free probe binds it against the key it asked for, so a widened
        // query that ever answered with a different key would be caught there.
        Ok(row.map(|row| HeldName {
            name_key: row.get::<String, _>("name_key"),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use silverhand_backend_core::workspace_name_availability::{
        WorkspaceNameAvailability, probe_workspace_name,
    };
    use sqlx::{Connection, Executor, SqliteConnection};

    const CURRENT_SCHEMA: &str =
        include_str!("../../../../packages/backend/tests/migration-baseline/schema-current.sql");
    const SEED_SQL: &str = "\
INSERT INTO users (id, name, display_name, created_at, updated_at) \
  VALUES ('user-1', 'viewer', 'Viewer', 1, 1); \
INSERT INTO hosts (id, name, kind, created_at) VALUES ('host-1', 'Host', 'local', 1); \
INSERT INTO agents (id, name, display_name, runtime, host_id, created_by_user_id, created_at, updated_at) \
  VALUES ('agent-1', 'alice', 'Alice', 'claude', 'host-1', 'user-1', 1, 1); \
INSERT INTO workspaces (id, name, name_key, description, owner_agent_id, owner_user_id, archived_at, created_at, updated_at) \
  VALUES ('ws-regular', 'Design Team', 'design team', NULL, NULL, 'user-1', NULL, 1, 300); \
INSERT INTO workspaces (id, name, name_key, description, owner_agent_id, owner_user_id, archived_at, created_at, updated_at) \
  VALUES ('ws-home', 'Agent Home', NULL, NULL, 'agent-1', NULL, NULL, 1, 200);";

    async fn open_seeded() -> (tempfile::TempDir, SqliteRegularWorkspaceNamespace) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("name-availability.sqlite");
        let options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true)
            .foreign_keys(true);
        let mut db = SqliteConnection::connect_with(&options).await.unwrap();
        db.execute(sqlx::raw_sql(CURRENT_SCHEMA)).await.unwrap();
        db.execute(sqlx::raw_sql(SEED_SQL)).await.unwrap();
        db.close().await.unwrap();
        let namespace = SqliteRegularWorkspaceNamespace::open(&path).await.unwrap();
        (directory, namespace)
    }

    #[tokio::test]
    async fn a_held_regular_name_is_taken_however_it_is_spelled() {
        let (_dir, namespace) = open_seeded().await;
        // Every spelling folds to the stored `design team` key.
        for raw in ["Design Team", "design team", "  DESIGN TEAM  "] {
            let verdict = probe_workspace_name(&namespace, raw).await.unwrap();
            assert_eq!(
                verdict,
                WorkspaceNameAvailability::Taken,
                "{raw:?} must collide with the stored key"
            );
        }
    }

    #[tokio::test]
    async fn a_free_name_is_available() {
        let (_dir, namespace) = open_seeded().await;
        let verdict = probe_workspace_name(&namespace, "Marketing").await.unwrap();
        assert_eq!(verdict, WorkspaceNameAvailability::Available);
    }

    #[tokio::test]
    async fn an_agent_home_name_never_occupies_the_regular_namespace() {
        // The home workspace is literally named "Agent Home" but stores a NULL
        // name_key, so the regular namespace does not hold it — "Agent Home" is
        // available for a REGULAR workspace.
        let (_dir, namespace) = open_seeded().await;
        let verdict = probe_workspace_name(&namespace, "Agent Home")
            .await
            .unwrap();
        assert_eq!(verdict, WorkspaceNameAvailability::Available);
    }

    #[tokio::test]
    async fn a_malformed_name_is_invalid_without_touching_the_database() {
        // A closed database would fault any query; the probe short-circuits on the
        // parse, so a malformed name is Invalid without a lookup ever running.
        let (_dir, namespace) = open_seeded().await;
        for raw in ["", "   ", &"a".repeat(65), "a\u{200d}b"] {
            let verdict = probe_workspace_name(&namespace, raw).await.unwrap();
            assert_eq!(
                verdict,
                WorkspaceNameAvailability::Invalid,
                "{raw:?} must be invalid"
            );
        }
    }
}
