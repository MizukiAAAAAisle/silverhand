use std::{path::Path, time::Duration};

use sqlx::{
    SqlitePool,
    migrate::MigrateError,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
};
use thiserror::Error;

use crate::application::{Message, MessageCreatedFact, MessageUnitOfWork, PersistenceFailure};

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");
const ROOT_WRITE_BEGIN: &str = "BEGIN IMMEDIATE";

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
            .synchronous(SqliteSynchronous::Normal)
            .busy_timeout(busy_timeout);

        let pool = SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(options)
            .await?;

        MIGRATOR.run(&pool).await?;
        Ok(Self { pool })
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

        // This use case is a root-only write unit of work. Reserve SQLite's
        // single writer before any reads/business work, rather than deferring
        // contention until the first INSERT.
        let mut tx = self.pool.begin_with(ROOT_WRITE_BEGIN).await?;
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
        self.create_message_transaction(body)
            .await
            .map_err(|error| {
                tracing::error!(error = ?error, "SQLite unit of work failed");
                PersistenceFailure
            })
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
            assert_eq!(synchronous, 1); // NORMAL
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
}
