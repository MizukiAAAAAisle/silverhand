//! SQLite adapter for the persistence write probe.
//!
//! ## `BEGIN IMMEDIATE` is the question; anything deferred is a different one
//!
//! The port asks whether this process can still write. `BEGIN IMMEDIATE` takes the
//! write lock at BEGIN, so a database that cannot be written refuses HERE — which is
//! the whole point. A deferred transaction, or an empty `db.transaction(|| {})`,
//! would acquire nothing and answer `Ok` on a database whose very next write fails.
//!
//! The rollback is part of the probe, not cleanup after it: the probe must leave the
//! store exactly as it found it, so it writes no row and commits nothing. A rollback
//! that itself fails is a probe failure — the process just failed to release a write
//! lock it took, which is not a writable store.
//!
//! ## One connection, because the product has one writer
//!
//! The pool is deliberately a single connection. The product's probe runs on the
//! process's one synchronous handle, so two probes can never contend with each other
//! there; a wider pool here would invent write-lock contention between two
//! concurrent readiness probes and report a busy database that only this adapter's
//! own shape created.
//!
//! The busy timeout matches the product handle's (5s), so a probe waits out the same
//! transient contention before it calls a database unwritable.

use std::{path::Path, time::Duration};

use silverhand_backend_core::persistence::{PersistenceFailure, WriteProbe};
use sqlx::{
    SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
};
use thiserror::Error;

/// One connection — see the module note. Not a tuning parameter.
const POOL_CONNECTIONS: u32 = 1;
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);
const IMMEDIATE_WRITE_BEGIN: &str = "BEGIN IMMEDIATE";

/// Takes and releases the write lock on the process's database.
#[derive(Clone)]
pub struct SqliteWriteProbe {
    pool: SqlitePool,
}

/// The only way this adapter can fail: the driver refused. There is no corruption
/// arm, because the probe decodes nothing — it reads no row and renders no column.
#[derive(Debug, Error)]
pub enum SqliteWriteProbeError {
    #[error("database operation failed")]
    Sql(#[from] sqlx::Error),
}

impl SqliteWriteProbe {
    /// `create_if_missing(false)`: a probe must never bring the database it is
    /// checking into existence — an absent file is a fault to report, not one to fix.
    pub async fn open(path: impl AsRef<Path>) -> Result<Self, SqliteWriteProbeError> {
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

    async fn take_and_release_write_lock(&self) -> Result<(), SqliteWriteProbeError> {
        let transaction = self.pool.begin_with(IMMEDIATE_WRITE_BEGIN).await?;
        transaction.rollback().await?;
        Ok(())
    }
}

impl WriteProbe for SqliteWriteProbe {
    async fn probe_write(&self) -> Result<(), PersistenceFailure> {
        self.take_and_release_write_lock()
            .await
            .map_err(PersistenceFailure::from_source)
    }
}

#[cfg(test)]
mod tests {
    use sqlx::Executor;
    use tempfile::TempDir;

    use super::*;

    /// A database file the product could have written: WAL, and existing, since the
    /// probe refuses to create one.
    async fn database(dir: &TempDir) -> std::path::PathBuf {
        let path = dir.path().join("silverhand.db");
        let options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("create the database");
        pool.execute("CREATE TABLE probe_target (id INTEGER PRIMARY KEY)")
            .await
            .expect("give the database a page to lock");
        pool.close().await;
        path
    }

    /// A probe that refuses instantly instead of waiting out the product's 5s busy
    /// timeout. Only the wait is different: the statement, the lock it takes and the
    /// rollback are the production ones.
    async fn impatient_probe(path: &std::path::Path) -> SqliteWriteProbe {
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(false)
            .journal_mode(SqliteJournalMode::Wal)
            .busy_timeout(Duration::ZERO);
        let pool = SqlitePoolOptions::new()
            .max_connections(POOL_CONNECTIONS)
            .connect_with(options)
            .await
            .expect("open the probe pool");
        SqliteWriteProbe { pool }
    }

    /// Hold the write lock from a connection this adapter does not own — what a
    /// concurrent writer in the same process, or another process, looks like.
    async fn writer_holding_the_lock(path: &std::path::Path) -> SqlitePool {
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(false)
            .journal_mode(SqliteJournalMode::Wal);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("open the competing writer");
        pool.execute("BEGIN IMMEDIATE")
            .await
            .expect("take the write lock");
        pool
    }

    #[tokio::test]
    async fn a_writable_database_answers_ok_and_stays_probeable() {
        let dir = TempDir::new().expect("temp dir");
        let path = database(&dir).await;
        let probe = SqliteWriteProbe::open(&path).await.expect("open");

        // Twice, on one connection: the second probe can only succeed if the first
        // left no transaction open.
        probe.probe_write().await.expect("first probe");
        probe.probe_write().await.expect("second probe");
    }

    /// The failure the probe exists to catch: the lock is held elsewhere, so the
    /// process cannot write right now. And the refusal must not poison the
    /// connection — once the lock is free, the same probe answers `Ok` again, which
    /// is what proves the failed attempt left nothing open either.
    #[tokio::test]
    async fn a_held_write_lock_is_a_refusal_the_probe_recovers_from() {
        let dir = TempDir::new().expect("temp dir");
        let path = database(&dir).await;
        let probe = impatient_probe(&path).await;
        let competitor = writer_holding_the_lock(&path).await;

        let refused = probe.probe_write().await.expect_err("the lock is taken");
        // The engine's own words stay reachable through the failure's source chain —
        // an operational surface has something to say beyond "not writable".
        let cause = std::error::Error::source(&refused).expect("the driver cause");
        assert!(
            cause.to_string().to_lowercase().contains("database"),
            "unexpected cause: {cause}"
        );

        competitor
            .execute("ROLLBACK")
            .await
            .expect("release the write lock");
        probe
            .probe_write()
            .await
            .expect("probe after the lock frees");
    }

    /// A probe never creates the database it is asked about: an absent file is a
    /// fault to report at construction, not one to paper over with an empty store
    /// that would then answer `Ok`.
    #[tokio::test]
    async fn an_absent_database_is_not_created_by_opening_a_probe_on_it() {
        let dir = TempDir::new().expect("temp dir");
        let missing = dir.path().join("absent.db");
        assert!(SqliteWriteProbe::open(&missing).await.is_err());
        assert!(!missing.exists());
    }
}
