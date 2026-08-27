//! SQLite adapter for the human user-identity context's `users` authority.
//!
//! [`SqliteUserStore`] offers the three `users`-authority ports this vertical
//! needs: the self-profile read behind `GET /api/me` ([`UserProfileRead`]), the
//! email→user existence read signup consults ([`UserEmailLookup`]), and the
//! `display_name` write behind `PATCH /api/me` ([`UserProfileWriteUnitOfWork`]).
//!
//! The write mirrors the product's `updateProfile`: it re-reads the row under one
//! `BEGIN IMMEDIATE` lock and writes ONLY when the requested display differs from
//! the stored one — a no-op patch returns the existing row WITHOUT bumping
//! `updated_at`. The adapter decides that skip under its own lock and reports the
//! committed row plus the display it read BEFORE writing; the core seal
//! (`seal_profile_write_fact`) derives whether the display actually moved. The
//! clock stays in the application: `now_ms` is the value a real write stamps into
//! `updated_at`.

use std::{path::Path, time::Duration};

use silverhand_backend_core::{
    identity::UserId,
    messaging::AvatarRevision,
    persistence::PersistenceFailure,
    user_identity::{
        DisplayName, UserEmailLookup, UserProfileRead, UserProfileWrite,
        UserProfileWriteUnitOfWork, UserRecord,
    },
};
use sqlx::{
    Row, SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
};
use thiserror::Error;

const ROOT_WRITE_BEGIN: &str = "BEGIN IMMEDIATE";
const POOL_CONNECTIONS: u32 = 4;
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

const SELECT_PROFILE: &str = "\
SELECT id, name, display_name, email, avatar_storage_key, created_at, updated_at FROM users WHERE id = ?";
const SELECT_ID_BY_EMAIL: &str = "SELECT id FROM users WHERE email = ? COLLATE NOCASE";
const UPDATE_DISPLAY_NAME: &str = "\
UPDATE users SET display_name = ?, updated_at = ? \
 WHERE id = ? \
 RETURNING id, name, display_name, email, avatar_storage_key, created_at, updated_at";

/// A pooled connection to an existing product database offering the
/// user-identity reads and the self-profile write. Holds no clock; `now_ms` is
/// passed into the write by the application, which owns the time source.
#[derive(Clone)]
pub struct SqliteUserStore {
    pool: SqlitePool,
}

/// Startup/driver failures surfaced only to the composition root that opens the
/// store; the port methods hand the driver error over as a `PersistenceFailure`.
#[derive(Debug, Error)]
pub enum SqliteUserStoreError {
    #[error("database operation failed")]
    Sql(#[from] sqlx::Error),
}

/// A committed identity column that decodes to a value the domain refuses (the
/// empty string). The product schema's ids are non-empty by construction, so this
/// is a persistence-integrity fault, never coerced to a sentinel.
#[derive(Debug, Error)]
#[error("users.id holds an unusable identifier")]
struct CorruptStoredUserId;

/// A write that failed in the driver or on a row that cannot be decoded into the
/// domain. Both reach the caller as the source of one `PersistenceFailure`.
#[derive(Debug, Error)]
enum ProfileWriteFailure {
    #[error(transparent)]
    Sql(#[from] sqlx::Error),
    #[error(transparent)]
    Integrity(#[from] CorruptStoredUserId),
}

impl SqliteUserStore {
    pub async fn open(path: impl AsRef<Path>) -> Result<Self, SqliteUserStoreError> {
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

    /// Construct over an already-open pool so a composition root that shares one
    /// pool across adapters need not reopen the file.
    pub fn from_pool(pool: SqlitePool) -> Self {
        Self { pool }
    }

    async fn write_display_name(
        &self,
        user_id: &UserId,
        display_name: &DisplayName,
        now_ms: i64,
    ) -> Result<UserProfileWrite, ProfileWriteFailure> {
        let mut tx = self.pool.begin_with(ROOT_WRITE_BEGIN).await?;

        // The before-image, read under the write lock: the whole current row, so a
        // no-op can be answered without a second read and a real write can report
        // the display it is about to replace.
        let current = sqlx::query(SELECT_PROFILE)
            .bind(user_id.as_str())
            .fetch_optional(&mut *tx)
            .await?;
        let Some(current) = current else {
            tx.commit().await?;
            return Ok(UserProfileWrite::NoSuchUser);
        };
        let prior = decode_user(&current)?;

        // A no-op resolves to no write: the row keeps its `updated_at`, and the
        // committed display already equals the requested one. The core seal reads
        // `prior == committed` as "the display did not move".
        if prior.display_name == display_name.as_str() {
            tx.commit().await?;
            let prior_display_name = prior.display_name.clone();
            return Ok(UserProfileWrite::Committed {
                user: prior,
                prior_display_name,
            });
        }

        let prior_display_name = prior.display_name;
        let committed = sqlx::query(UPDATE_DISPLAY_NAME)
            .bind(display_name.as_str())
            .bind(now_ms)
            .bind(user_id.as_str())
            .fetch_one(&mut *tx)
            .await?;
        let user = decode_user(&committed)?;
        tx.commit().await?;
        Ok(UserProfileWrite::Committed {
            user,
            prior_display_name,
        })
    }
}

/// Decode a `users` row into the projected [`UserRecord`]. Every identity
/// coordinate is parsed through the domain's fallible parser, so a malformed
/// committed id is corruption, never a product answer.
fn decode_user(row: &sqlx::sqlite::SqliteRow) -> Result<UserRecord, CorruptStoredUserId> {
    let id = UserId::parse(row.try_get::<String, _>("id").map_err(|_| CorruptStoredUserId)?)
        .map_err(|_| CorruptStoredUserId)?;
    let updated_at: i64 = row.try_get("updated_at").map_err(|_| CorruptStoredUserId)?;
    // The avatar URL is cache-busted by `updated_at`; an absent or empty storage
    // key means "no avatar", exactly as the messaging author projection folds it.
    let avatar_storage_key: Option<String> =
        row.try_get("avatar_storage_key").map_err(|_| CorruptStoredUserId)?;
    let avatar = match avatar_storage_key.as_deref() {
        None | Some("") => None,
        Some(_) => Some(AvatarRevision::at(updated_at)),
    };
    Ok(UserRecord {
        id,
        handle: row.try_get("name").map_err(|_| CorruptStoredUserId)?,
        display_name: row.try_get("display_name").map_err(|_| CorruptStoredUserId)?,
        email: row.try_get("email").map_err(|_| CorruptStoredUserId)?,
        avatar,
        created_at: row.try_get("created_at").map_err(|_| CorruptStoredUserId)?,
        updated_at,
    })
}

impl UserProfileRead for SqliteUserStore {
    async fn get(&self, user_id: &UserId) -> Result<Option<UserRecord>, PersistenceFailure> {
        let row = sqlx::query(SELECT_PROFILE)
            .bind(user_id.as_str())
            .fetch_optional(&self.pool)
            .await
            .map_err(PersistenceFailure::from_source)?;
        match row {
            Some(row) => Ok(Some(decode_user(&row).map_err(PersistenceFailure::from_source)?)),
            None => Ok(None),
        }
    }
}

impl UserEmailLookup for SqliteUserStore {
    async fn find_by_email(&self, email: &str) -> Result<Option<UserId>, PersistenceFailure> {
        let row = sqlx::query(SELECT_ID_BY_EMAIL)
            .bind(email)
            .fetch_optional(&self.pool)
            .await
            .map_err(PersistenceFailure::from_source)?;
        let Some(row) = row else {
            return Ok(None);
        };
        let raw: String = row.try_get("id").map_err(PersistenceFailure::from_source)?;
        let user_id =
            UserId::parse(raw).map_err(|_| PersistenceFailure::from_source(CorruptStoredUserId))?;
        Ok(Some(user_id))
    }
}

impl UserProfileWriteUnitOfWork for SqliteUserStore {
    async fn update_display_name(
        &self,
        user_id: &UserId,
        display_name: &DisplayName,
        now_ms: i64,
    ) -> Result<UserProfileWrite, PersistenceFailure> {
        self.write_display_name(user_id, display_name, now_ms)
            .await
            .map_err(PersistenceFailure::from_source)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::{Connection, Executor, SqliteConnection};

    const CURRENT_SCHEMA: &str =
        include_str!("../../../../packages/backend/tests/migration-baseline/schema-current.sql");

    const SEED_SQL: &str = "\
INSERT INTO users (id, name, display_name, email, created_at, updated_at) \
  VALUES ('user-1', 'alice', 'Alice', 'alice@example.com', 10, 100); \
INSERT INTO users (id, name, display_name, email, created_at, updated_at) \
  VALUES ('user-2', 'bob', 'Bob', NULL, 10, 100); \
INSERT INTO users (id, name, display_name, email, avatar_storage_key, avatar_content_type, created_at, updated_at) \
  VALUES ('user-3', 'carol', 'Carol', 'carol@example.com', 'avatars/carol.png', 'image/png', 10, 250);";

    async fn open_seeded() -> (tempfile::TempDir, SqliteUserStore) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("user.sqlite");
        let options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true)
            .foreign_keys(true);
        let mut db = SqliteConnection::connect_with(&options).await.unwrap();
        db.execute(sqlx::raw_sql(CURRENT_SCHEMA)).await.unwrap();
        db.execute(sqlx::raw_sql(SEED_SQL)).await.unwrap();
        db.close().await.unwrap();
        let store = SqliteUserStore::open(&path).await.unwrap();
        (directory, store)
    }

    fn uid(raw: &str) -> UserId {
        UserId::parse(raw).unwrap()
    }

    #[tokio::test]
    async fn get_projects_the_profile_row() {
        let (_dir, store) = open_seeded().await;
        let record = store.get(&uid("user-1")).await.unwrap().expect("a row");
        assert_eq!(record.id.as_str(), "user-1");
        assert_eq!(record.handle, "alice");
        assert_eq!(record.display_name, "Alice");
        assert_eq!(record.email.as_deref(), Some("alice@example.com"));
        assert_eq!(record.avatar, None, "no stored avatar key projects no revision");
        assert_eq!(record.created_at, 10);
        assert_eq!(record.updated_at, 100);
    }

    #[tokio::test]
    async fn get_folds_a_stored_avatar_key_into_a_cache_busted_revision() {
        let (_dir, store) = open_seeded().await;
        let record = store.get(&uid("user-3")).await.unwrap().expect("a row");
        // A non-empty storage key yields a revision cache-busted by updated_at.
        assert_eq!(record.avatar, Some(AvatarRevision::at(250)));
        assert_eq!(record.avatar.unwrap().cache_buster(), 250);
    }

    #[tokio::test]
    async fn get_a_profile_only_user_has_a_null_email() {
        let (_dir, store) = open_seeded().await;
        let record = store.get(&uid("user-2")).await.unwrap().unwrap();
        assert_eq!(record.email, None);
    }

    #[tokio::test]
    async fn get_an_unknown_user_is_none() {
        let (_dir, store) = open_seeded().await;
        assert!(store.get(&uid("ghost")).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn find_by_email_is_case_insensitive_and_none_for_unknown() {
        let (_dir, store) = open_seeded().await;
        assert_eq!(
            store.find_by_email("ALICE@example.com").await.unwrap().unwrap().as_str(),
            "user-1"
        );
        assert!(store.find_by_email("nobody@example.com").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn a_real_change_bumps_updated_at_and_witnesses_the_before_image() {
        let (_dir, store) = open_seeded().await;
        let outcome = store
            .update_display_name(&uid("user-1"), &DisplayName::parse("Alice Cooper").unwrap(), 777)
            .await
            .unwrap();
        let UserProfileWrite::Committed { user, prior_display_name } = outcome else {
            panic!("expected Committed");
        };
        assert_eq!(user.display_name, "Alice Cooper");
        assert_eq!(user.updated_at, 777);
        assert_eq!(prior_display_name, "Alice");
        // The row on disk carries the new display and bumped updated_at.
        let reread = store.get(&uid("user-1")).await.unwrap().unwrap();
        assert_eq!(reread.display_name, "Alice Cooper");
        assert_eq!(reread.updated_at, 777);
    }

    #[tokio::test]
    async fn a_no_op_skips_the_write_and_leaves_updated_at_untouched() {
        let (_dir, store) = open_seeded().await;
        let outcome = store
            .update_display_name(&uid("user-1"), &DisplayName::parse("Alice").unwrap(), 999)
            .await
            .unwrap();
        let UserProfileWrite::Committed { user, prior_display_name } = outcome else {
            panic!("expected Committed");
        };
        // No write happened: updated_at is still the seeded 100, and the before-image
        // equals the committed display (the core seal reads that as "no move").
        assert_eq!(user.updated_at, 100);
        assert_eq!(prior_display_name, "Alice");
        assert_eq!(store.get(&uid("user-1")).await.unwrap().unwrap().updated_at, 100);
    }

    #[tokio::test]
    async fn an_unknown_user_is_no_such_user() {
        let (_dir, store) = open_seeded().await;
        let outcome = store
            .update_display_name(&uid("ghost"), &DisplayName::parse("X").unwrap(), 100)
            .await
            .unwrap();
        assert!(matches!(outcome, UserProfileWrite::NoSuchUser));
    }
}
