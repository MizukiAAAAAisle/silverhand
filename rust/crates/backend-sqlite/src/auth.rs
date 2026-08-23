use std::{path::Path, time::Duration};

use silverhand_backend_core::{
    auth::{SessionTokenHash, SessionValidation, SessionValidationPort},
    identity::UserId,
    persistence::PersistenceFailure,
};
use sqlx::{
    Row, SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
};
use thiserror::Error;

const VERIFY_AND_TOUCH: &str = "UPDATE auth_sessions
    SET last_used_at = ?
  WHERE token_hash = ?
    AND revoked_at IS NULL
    AND last_used_at + ? >= ?
  RETURNING user_id";

#[derive(Clone)]
pub struct SqliteSessionStore {
    pool: SqlitePool,
}

#[derive(Debug, Error)]
pub enum SqliteSessionStoreError {
    #[error("database operation failed")]
    Sql(#[from] sqlx::Error),
}

impl SqliteSessionStore {
    pub async fn open(path: impl AsRef<Path>) -> Result<Self, SqliteSessionStoreError> {
        let options = SqliteConnectOptions::new()
            .filename(path.as_ref())
            .create_if_missing(false)
            .foreign_keys(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Full)
            .busy_timeout(Duration::from_secs(5));
        let pool = SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(options)
            .await?;
        Ok(Self { pool })
    }

    async fn verify_and_touch_transaction(
        &self,
        token_hash: SessionTokenHash,
        validation: SessionValidation,
    ) -> Result<Option<UserId>, PersistenceFailure> {
        let mut transaction = self.pool.begin().await.map_err(persistence)?;
        let row = sqlx::query(VERIFY_AND_TOUCH)
            .bind(validation.now_ms())
            .bind(token_hash.as_str())
            .bind(validation.ttl_ms())
            .bind(validation.now_ms())
            .fetch_optional(&mut *transaction)
            .await
            .map_err(persistence)?;

        let Some(row) = row else {
            transaction.commit().await.map_err(persistence)?;
            return Ok(None);
        };

        let raw_user_id: String = row.try_get("user_id").map_err(persistence)?;
        let user_id = UserId::parse(raw_user_id)
            .map_err(|error| PersistenceFailure::from_source(InvalidPersistedUserId(error)))?;
        let user_exists: i64 =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE id = ?)")
                .bind(user_id.as_str())
                .fetch_one(&mut *transaction)
                .await
                .map_err(persistence)?;
        if user_exists == 0 {
            return Err(PersistenceFailure::from_source(DanglingSessionUser));
        }

        transaction.commit().await.map_err(persistence)?;
        Ok(Some(user_id))
    }
}

impl SessionValidationPort for SqliteSessionStore {
    async fn verify_and_touch(
        &self,
        token_hash: SessionTokenHash,
        validation: SessionValidation,
    ) -> Result<Option<UserId>, PersistenceFailure> {
        self.verify_and_touch_transaction(token_hash, validation)
            .await
    }
}

fn persistence(error: sqlx::Error) -> PersistenceFailure {
    PersistenceFailure::from_source(error)
}

#[derive(Debug, Error)]
#[error("persisted session user id is invalid")]
struct InvalidPersistedUserId(#[source] silverhand_backend_core::identity::EmptyUserId);

#[derive(Debug, Error)]
#[error("authenticated session references a missing user")]
struct DanglingSessionUser;
