//! The connection the host-agent ports share, and the one place a required
//! transaction capability becomes a begin statement.
//!
//! This store opens a database it does NOT own: the product database whose schema
//! and migration ledger are created elsewhere. It therefore creates no table and
//! records no version, and `create_if_missing(false)` turns opening an
//! unprovisioned database into a startup failure rather than a silent empty one.

use std::{path::Path, time::Duration};

use sqlx::{
    Sqlite, SqlitePool, Transaction,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
};
use thiserror::Error;

pub(crate) mod decode;

pub(crate) const ROOT_WRITE_BEGIN: &str = "BEGIN IMMEDIATE";
const POOL_CONNECTIONS: u32 = 4;
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone)]
pub struct SqliteHostAgentStore {
    pool: SqlitePool,
}

/// Startup and driver failures, surfaced only to the composition root that opens
/// the store. The ports never expose it.
#[derive(Debug, Error)]
pub enum SqliteHostAgentStoreError {
    #[error("database operation failed")]
    Sql(#[from] sqlx::Error),
}

impl SqliteHostAgentStore {
    pub async fn open(path: impl AsRef<Path>) -> Result<Self, SqliteHostAgentStoreError> {
        Self::open_with_busy_timeout(path, BUSY_TIMEOUT).await
    }

    pub(crate) async fn open_with_busy_timeout(
        path: impl AsRef<Path>,
        busy_timeout: Duration,
    ) -> Result<Self, SqliteHostAgentStoreError> {
        let options = SqliteConnectOptions::new()
            .filename(path.as_ref())
            .create_if_missing(false)
            .foreign_keys(true)
            .journal_mode(SqliteJournalMode::Wal)
            // An acknowledged write must survive power loss, so WAL runs with
            // FULL rather than NORMAL.
            .synchronous(SqliteSynchronous::Full)
            .busy_timeout(busy_timeout);
        let pool = SqlitePoolOptions::new()
            .max_connections(POOL_CONNECTIONS)
            .connect_with(options)
            .await?;
        Ok(Self { pool })
    }

    /// The connection for single-statement reads that need no multi-statement
    /// snapshot.
    pub(crate) fn pool(&self) -> &SqlitePool {
        &self.pool
    }

    /// The single place that reserves the one writer before the first statement of
    /// a write axis.
    pub(crate) async fn begin_root_write(&self) -> Result<Transaction<'_, Sqlite>, sqlx::Error> {
        self.pool.begin_with(ROOT_WRITE_BEGIN).await
    }
}
