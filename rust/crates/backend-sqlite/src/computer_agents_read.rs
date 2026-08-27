//! SQLite adapter for
//! [`ComputerAgentsReadPort`](silverhand_backend_core::host_runtime::agent_roster::ComputerAgentsReadPort):
//! the agents filed under one computer, read for the post-commit availability
//! fan-out.
//!
//! A flat projection of `agents.id` for one `host_id`. It is viewer-BLIND on
//! purpose — every agent bound to the computer, no ACL — because per-agent
//! visibility is a separate step the fan-out applies afterwards; filtering here
//! would silently drop agents from the announcement. A computer with no agents —
//! or one that no longer exists — is an empty set, the true "nothing to announce"
//! answer, never a refusal. Ids come back ordered by `id` so the fan-out adapter's
//! own tests observe a deterministic sequence, though no reader depends on it.

use std::{path::Path, time::Duration};

use silverhand_backend_core::{
    host_runtime::agent_roster::ComputerAgentsReadPort,
    identity::{AgentId, HostId},
    persistence::PersistenceFailure,
};
use sqlx::{
    Row, SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
};
use thiserror::Error;

const POOL_CONNECTIONS: u32 = 4;
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

const SELECT_AGENTS_ON_COMPUTER: &str = "\
SELECT a.id \
  FROM agents a \
 WHERE a.host_id = ? \
 ORDER BY a.id";

#[derive(Clone)]
pub struct SqliteComputerAgentsRead {
    pool: SqlitePool,
}

/// Read failures surfaced only as the source of a [`PersistenceFailure`]. A
/// malformed stored `id` is corruption of a committed agent row, never a product
/// refusal.
#[derive(Debug, Error)]
pub enum ComputerAgentsReadError {
    #[error("database operation failed")]
    Sql(#[from] sqlx::Error),
    #[error("stored column {field} does not name a usable identity")]
    MalformedIdentity { field: &'static str },
}

impl SqliteComputerAgentsRead {
    pub async fn open(path: impl AsRef<Path>) -> Result<Self, ComputerAgentsReadError> {
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

impl ComputerAgentsReadPort for SqliteComputerAgentsRead {
    async fn agent_ids_on_computer(
        &self,
        computer: &HostId,
    ) -> Result<Vec<AgentId>, PersistenceFailure> {
        let rows = sqlx::query(SELECT_AGENTS_ON_COMPUTER)
            .bind(computer.as_str())
            .fetch_all(&self.pool)
            .await
            .map_err(|error| {
                PersistenceFailure::from_source(ComputerAgentsReadError::Sql(error))
            })?;
        rows.into_iter()
            .map(|row| {
                let raw: String = row.try_get("id").map_err(|error| {
                    PersistenceFailure::from_source(ComputerAgentsReadError::Sql(error))
                })?;
                AgentId::parse(raw).map_err(|_| {
                    PersistenceFailure::from_source(ComputerAgentsReadError::MalformedIdentity {
                        field: "agents.id",
                    })
                })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::{Connection, Executor, SqliteConnection};

    const CURRENT_SCHEMA: &str =
        include_str!("../../../../packages/backend/tests/migration-baseline/schema-current.sql");
    const SEED_SQL: &str = "\
INSERT INTO users (id, name, display_name, created_at, updated_at) \
  VALUES ('user-1', 'one', 'One', 1, 1); \
INSERT INTO hosts (id, name, kind, created_at) VALUES ('host-1', 'One', 'local', 1); \
INSERT INTO hosts (id, name, kind, created_at) VALUES ('host-2', 'Two', 'local', 1); \
INSERT INTO hosts (id, name, kind, created_at) VALUES ('host-empty', 'Empty', 'local', 1); \
INSERT INTO agents (id, name, display_name, runtime, host_id, created_by_user_id, created_at, updated_at) \
  VALUES ('agent-b', 'b', 'B', 'claude', 'host-1', 'user-1', 2, 2); \
INSERT INTO agents (id, name, display_name, runtime, host_id, created_by_user_id, created_at, updated_at) \
  VALUES ('agent-a', 'a', 'A', 'claude', 'host-1', 'user-1', 1, 1); \
INSERT INTO agents (id, name, display_name, runtime, host_id, created_by_user_id, created_at, updated_at) \
  VALUES ('agent-c', 'c', 'C', 'claude', 'host-2', 'user-1', 3, 3);";

    async fn open_seeded() -> (tempfile::TempDir, SqliteComputerAgentsRead) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("computer-agents.sqlite");
        let options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true)
            .foreign_keys(true);
        let mut db = SqliteConnection::connect_with(&options).await.unwrap();
        db.execute(sqlx::raw_sql(CURRENT_SCHEMA)).await.unwrap();
        db.execute(sqlx::raw_sql(SEED_SQL)).await.unwrap();
        db.close().await.unwrap();
        let adapter = SqliteComputerAgentsRead::open(&path).await.unwrap();
        (directory, adapter)
    }

    #[tokio::test]
    async fn enumerates_only_the_computers_own_agents_ordered_by_id() {
        let (_dir, adapter) = open_seeded().await;
        let agents = adapter
            .agent_ids_on_computer(&HostId::parse("host-1").unwrap())
            .await
            .unwrap();
        // Only host-1's two agents, ordered by id; host-2's agent-c is excluded.
        assert_eq!(
            agents,
            vec![
                AgentId::parse("agent-a").unwrap(),
                AgentId::parse("agent-b").unwrap(),
            ]
        );
    }

    #[tokio::test]
    async fn a_computer_with_no_agents_is_an_empty_roster() {
        let (_dir, adapter) = open_seeded().await;
        let agents = adapter
            .agent_ids_on_computer(&HostId::parse("host-empty").unwrap())
            .await
            .unwrap();
        assert!(agents.is_empty());
    }

    #[tokio::test]
    async fn an_absent_computer_is_an_empty_roster_not_an_error() {
        let (_dir, adapter) = open_seeded().await;
        let agents = adapter
            .agent_ids_on_computer(&HostId::parse("host-missing").unwrap())
            .await
            .unwrap();
        assert!(agents.is_empty());
    }
}
