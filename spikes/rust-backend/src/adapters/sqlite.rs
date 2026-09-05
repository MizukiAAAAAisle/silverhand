use std::{path::Path, time::Duration};

use sqlx::{
    Row, Sqlite, SqlitePool, Transaction,
    migrate::MigrateError,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
};
use thiserror::Error;

use crate::application::{
    Message, MessageCreatedFact, MessagePageFact, MessageReadUnitOfWork, MessageUnitOfWork,
    PersistenceFailure,
};

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");
const ROOT_WRITE_BEGIN: &str = "BEGIN IMMEDIATE";
const DEFERRED_READ_BEGIN: &str = "BEGIN DEFERRED";

/// Which transaction capability an operation needs. A private adapter concern:
/// it is derived from the operation's own semantics and never appears in an
/// application port, use case, or repository signature.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TxMode {
    /// Multi-statement write invariant: reserve the single writer before the
    /// first statement so contention surfaces before any work is done.
    RootWrite,
    /// Read-only unit needing one snapshot across several statements. It must
    /// not take a writer reservation it never uses.
    DeferredRead,
}

#[derive(Clone)]
pub struct SqliteDatabase {
    pool: SqlitePool,
}

#[derive(Debug, Error)]
pub enum SqliteAdapterError {
    #[error("database operation failed")]
    Sql(#[from] sqlx::Error),
    #[error("database migration failed")]
    Migration(#[from] MigrateError),
    #[error("system time is outside the supported Unix-millisecond range")]
    Clock,
    #[error("event serialization failed")]
    Serialization(#[from] serde_json::Error),
}

impl SqliteDatabase {
    pub async fn open(path: impl AsRef<Path>) -> Result<Self, SqliteAdapterError> {
        Self::open_with_busy_timeout(path, Duration::from_secs(5)).await
    }

    async fn open_with_busy_timeout(
        path: impl AsRef<Path>,
        busy_timeout: Duration,
    ) -> Result<Self, SqliteAdapterError> {
        let options = SqliteConnectOptions::new()
            .filename(path.as_ref())
            .create_if_missing(true)
            .foreign_keys(true)
            .journal_mode(SqliteJournalMode::Wal)
            // An acknowledged write must survive power loss, so WAL runs with
            // FULL. NORMAL would skip the commit fsync and let a recently
            // acknowledged transaction roll back.
            .synchronous(SqliteSynchronous::Full)
            .busy_timeout(busy_timeout);

        let pool = SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(options)
            .await?;

        MIGRATOR.run(&pool).await?;
        Ok(Self { pool })
    }

    /// The single place that turns a required capability into a begin statement.
    async fn begin(&self, mode: TxMode) -> Result<Transaction<'_, Sqlite>, sqlx::Error> {
        match mode {
            TxMode::RootWrite => self.pool.begin_with(ROOT_WRITE_BEGIN).await,
            TxMode::DeferredRead => self.pool.begin_with(DEFERRED_READ_BEGIN).await,
        }
    }

    #[tracing::instrument(skip(self))]
    async fn latest_page_transaction(&self) -> Result<MessagePageFact, SqliteAdapterError> {
        let mut tx = self.begin(TxMode::DeferredRead).await?;
        let total: i64 = sqlx::query_scalar("SELECT count(*) FROM messages")
            .fetch_one(&mut *tx)
            .await?;
        let row =
            sqlx::query("SELECT id, body, created_at_ms FROM messages ORDER BY id DESC LIMIT 1")
                .fetch_optional(&mut *tx)
                .await?;
        let latest = match row {
            Some(row) => Some(Message {
                id: row.try_get("id")?,
                body: row.try_get("body")?,
                created_at_ms: row.try_get("created_at_ms")?,
            }),
            None => None,
        };
        tx.commit().await?;
        Ok(MessagePageFact { total, latest })
    }

    #[tracing::instrument(skip(self, body), fields(body_len = body.len()))]
    async fn create_message_transaction(
        &self,
        body: String,
    ) -> Result<MessageCreatedFact, SqliteAdapterError> {
        let created_at_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| SqliteAdapterError::Clock)?
            .as_millis();
        let created_at_ms = i64::try_from(created_at_ms).map_err(|_| SqliteAdapterError::Clock)?;

        // A root-only write unit of work: reserve SQLite's single writer before
        // any reads or business work, rather than deferring contention until the
        // first INSERT. The mode follows from this operation's semantics.
        let mut tx = self.begin(TxMode::RootWrite).await?;
        let result = sqlx::query("INSERT INTO messages (body, created_at_ms) VALUES (?, ?)")
            .bind(&body)
            .bind(created_at_ms)
            .execute(&mut *tx)
            .await?;

        let message = Message {
            id: result.last_insert_rowid(),
            body,
            created_at_ms,
        };
        let fact = MessageCreatedFact {
            message: message.clone(),
        };
        let payload_json = serde_json::to_string(&StoredMessageCreatedV1::from(&fact))?;

        sqlx::query("INSERT INTO message_events (message_id, kind, payload_json) VALUES (?, ?, ?)")
            .bind(fact.message.id)
            .bind("message_created")
            .bind(payload_json)
            .execute(&mut *tx)
            .await?;

        tx.commit().await?;
        tracing::info!(message_id = %message.id, "message transaction committed");
        Ok(fact)
    }
}

/// SQLite's durable payload schema is versioned independently from HTTP/WS
/// wire DTOs. Replaying it must go through an explicit projection adapter.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredMessageCreatedV1<'a> {
    version: u8,
    message_id: i64,
    body: &'a str,
    created_at_ms: i64,
}

impl<'a> From<&'a MessageCreatedFact> for StoredMessageCreatedV1<'a> {
    fn from(fact: &'a MessageCreatedFact) -> Self {
        Self {
            version: 1,
            message_id: fact.message.id,
            body: &fact.message.body,
            created_at_ms: fact.message.created_at_ms,
        }
    }
}

impl MessageUnitOfWork for SqliteDatabase {
    async fn create_message_with_event(
        &self,
        body: String,
    ) -> Result<MessageCreatedFact, PersistenceFailure> {
        // The driver error becomes the source, not a log line. Exactly one place
        // renders this failure, and it renders the whole chain.
        self.create_message_transaction(body)
            .await
            .map_err(PersistenceFailure::from_source)
    }
}

impl MessageReadUnitOfWork for SqliteDatabase {
    async fn latest_page(&self) -> Result<MessagePageFact, PersistenceFailure> {
        self.latest_page_transaction()
            .await
            .map_err(PersistenceFailure::from_source)
    }
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use serde_json::json;
    use tempfile::tempdir;

    use super::*;

    #[tokio::test]
    async fn rolls_back_message_when_event_insert_fails() {
        let dir = tempdir().unwrap();
        let db = SqliteDatabase::open(dir.path().join("rollback.db"))
            .await
            .unwrap();
        sqlx::query(
            "CREATE TRIGGER reject_test_event BEFORE INSERT ON message_events \
             BEGIN SELECT RAISE(ABORT, 'forced event failure'); END",
        )
        .execute(&db.pool)
        .await
        .unwrap();

        let error = db
            .create_message_transaction("must roll back".into())
            .await
            .unwrap_err();
        assert!(matches!(error, SqliteAdapterError::Sql(_)));

        let message_count: i64 = sqlx::query_scalar("SELECT count(*) FROM messages")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(message_count, 0);
    }

    #[tokio::test]
    async fn applies_required_configuration_to_every_pool_connection() {
        let dir = tempdir().unwrap();
        let db = SqliteDatabase::open(dir.path().join("configuration.db"))
            .await
            .unwrap();
        let mut connections = Vec::new();
        for _ in 0..4 {
            connections.push(db.pool.acquire().await.unwrap());
        }

        for connection in &mut connections {
            let foreign_keys: i64 = sqlx::query_scalar("PRAGMA foreign_keys")
                .fetch_one(&mut **connection)
                .await
                .unwrap();
            let journal_mode: String = sqlx::query_scalar("PRAGMA journal_mode")
                .fetch_one(&mut **connection)
                .await
                .unwrap();
            let synchronous: i64 = sqlx::query_scalar("PRAGMA synchronous")
                .fetch_one(&mut **connection)
                .await
                .unwrap();
            let busy_timeout_ms: i64 = sqlx::query_scalar("PRAGMA busy_timeout")
                .fetch_one(&mut **connection)
                .await
                .unwrap();

            assert_eq!(foreign_keys, 1);
            assert_eq!(journal_mode, "wal");
            assert_eq!(synchronous, 2); // FULL
            assert_eq!(busy_timeout_ms, 5_000);
        }
        drop(connections);

        let sqlite_version: String = sqlx::query_scalar("SELECT sqlite_version()")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        let version = sqlite_version
            .split('.')
            .map(|part| part.parse::<u32>().unwrap())
            .collect::<Vec<_>>();
        assert!(version.as_slice() >= &[3, 51, 3]);
    }

    #[tokio::test]
    async fn durable_payload_is_a_versioned_projection_of_the_application_fact() {
        let dir = tempdir().unwrap();
        let db = SqliteDatabase::open(dir.path().join("payload.db"))
            .await
            .unwrap();
        let fact = db
            .create_message_transaction("stored fact".into())
            .await
            .unwrap();
        let payload: String = sqlx::query_scalar("SELECT payload_json FROM message_events")
            .fetch_one(&db.pool)
            .await
            .unwrap();

        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&payload).unwrap(),
            json!({
                "version": 1,
                "messageId": fact.message.id,
                "body": fact.message.body,
                "createdAtMs": fact.message.created_at_ms,
            })
        );
    }

    #[tokio::test]
    async fn root_write_reserves_the_writer_before_its_first_insert() {
        let dir = tempdir().unwrap();
        let db = SqliteDatabase::open_with_busy_timeout(
            dir.path().join("writer-reservation.db"),
            Duration::from_millis(25),
        )
        .await
        .unwrap();

        let first = db.pool.begin_with(ROOT_WRITE_BEGIN).await.unwrap();
        let started = Instant::now();
        let error = db.pool.begin_with(ROOT_WRITE_BEGIN).await.unwrap_err();

        assert!(
            started.elapsed() < Duration::from_secs(1),
            "writer contention exceeded the controlled short timeout"
        );
        let database_error = error.as_database_error().unwrap();
        assert_eq!(database_error.code().as_deref(), Some("5")); // SQLITE_BUSY
        first.rollback().await.unwrap();
    }

    #[tokio::test]
    async fn nested_root_immediate_is_rejected_instead_of_becoming_a_savepoint() {
        let dir = tempdir().unwrap();
        let db = SqliteDatabase::open(dir.path().join("nested-root.db"))
            .await
            .unwrap();
        let mut root = db.pool.begin_with(ROOT_WRITE_BEGIN).await.unwrap();
        let connection = sqlx::Acquire::acquire(&mut root).await.unwrap();

        let error = sqlx::Connection::begin_with(connection, ROOT_WRITE_BEGIN)
            .await
            .unwrap_err();
        assert!(matches!(error, sqlx::Error::InvalidSavePointStatement));
        root.rollback().await.unwrap();
    }

    #[test]
    fn the_two_modes_are_distinct_capabilities() {
        assert_ne!(TxMode::RootWrite, TxMode::DeferredRead);
        assert_ne!(ROOT_WRITE_BEGIN, DEFERRED_READ_BEGIN);
    }

    /// The discriminator for the deferred mode: a read unit must not queue behind
    /// a writer reservation it never uses. With a 25ms busy timeout, a read that
    /// wrongly asked for the writer would fail instead of returning a snapshot.
    #[tokio::test]
    async fn deferred_read_reads_a_snapshot_while_a_writer_is_held() {
        let dir = tempdir().unwrap();
        let db = SqliteDatabase::open_with_busy_timeout(
            dir.path().join("deferred-read.db"),
            Duration::from_millis(25),
        )
        .await
        .unwrap();
        db.create_message_transaction("committed before".into())
            .await
            .unwrap();

        let held_writer = db.begin(TxMode::RootWrite).await.unwrap();
        let started = Instant::now();
        let page = db.latest_page_transaction().await.unwrap();

        assert!(
            started.elapsed() < Duration::from_secs(1),
            "the deferred read waited on the writer reservation"
        );
        assert_eq!(page.total, 1);
        assert_eq!(page.latest.unwrap().body, "committed before");

        // A root write asked for while the writer is held does fail, which is what
        // keeps the assertion above from being vacuous.
        let contended = db.begin(TxMode::RootWrite).await.unwrap_err();
        assert_eq!(
            contended.as_database_error().unwrap().code().as_deref(),
            Some("5") // SQLITE_BUSY
        );

        held_writer.rollback().await.unwrap();
    }

    /// A read unit reads one snapshot. Statements inside a deferred read see the
    /// database as of that unit's first read, so a commit landing between them is
    /// invisible until a new transaction begins — which is what lets a total and
    /// a latest row be reported together without disagreeing.
    #[tokio::test]
    async fn deferred_read_holds_one_snapshot_across_statements() {
        let dir = tempdir().unwrap();
        let db = SqliteDatabase::open(dir.path().join("snapshot.db"))
            .await
            .unwrap();
        db.create_message_transaction("first".into()).await.unwrap();

        let mut read_tx = db.begin(TxMode::DeferredRead).await.unwrap();
        // The first statement is what establishes the snapshot for this tx.
        let total_before: i64 = sqlx::query_scalar("SELECT count(*) FROM messages")
            .fetch_one(&mut *read_tx)
            .await
            .unwrap();
        assert_eq!(total_before, 1);

        // A different pooled connection commits while the read tx is open.
        db.create_message_transaction("committed mid-read".into())
            .await
            .unwrap();

        let total_after: i64 = sqlx::query_scalar("SELECT count(*) FROM messages")
            .fetch_one(&mut *read_tx)
            .await
            .unwrap();
        let latest_body: Option<String> =
            sqlx::query_scalar("SELECT body FROM messages ORDER BY id DESC LIMIT 1")
                .fetch_optional(&mut *read_tx)
                .await
                .unwrap();

        assert_eq!(
            total_after, 1,
            "the second statement left the transaction's snapshot"
        );
        assert_eq!(
            latest_body.as_deref(),
            Some("first"),
            "count and latest disagreed inside one read unit"
        );
        read_tx.rollback().await.unwrap();

        // The commit was real: a fresh read unit sees it.
        let page = db.latest_page_transaction().await.unwrap();
        assert_eq!(page.total, 2);
        assert_eq!(page.latest.unwrap().body, "committed mid-read");
    }
}
