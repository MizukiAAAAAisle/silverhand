use std::{path::Path, time::Duration};

use silverhand_backend_core::{
    host_runtime::{
        CredentialAuthState, Host, HostCredentialKind, HostCredentialLookup, HostInviteUnitOfWork,
        HostInviteWriteError, HostKind, HostProvisioningSource, NewHostCredential,
    },
    persistence::PersistenceFailure,
};
use sqlx::{
    Row, SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
};
use thiserror::Error;

const ROOT_WRITE_BEGIN: &str = "BEGIN IMMEDIATE";

#[derive(Clone)]
pub struct SqliteHostRuntimeStore {
    pool: SqlitePool,
}

#[derive(Debug, Error)]
pub enum SqliteHostRuntimeStoreError {
    #[error("database operation failed")]
    Sql(#[from] sqlx::Error),
}

impl SqliteHostRuntimeStore {
    pub async fn open(path: impl AsRef<Path>) -> Result<Self, SqliteHostRuntimeStoreError> {
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

    async fn create_transaction(
        &self,
        host: Host,
        credential: NewHostCredential,
    ) -> Result<Host, HostInviteWriteError> {
        let mut tx = self
            .pool
            .begin_with(ROOT_WRITE_BEGIN)
            .await
            .map_err(persistence)?;
        let name_exists: i64 =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM hosts WHERE name = ?)")
                .bind(&host.name)
                .fetch_one(&mut *tx)
                .await
                .map_err(persistence)?;
        if name_exists != 0 {
            return Err(HostInviteWriteError::DuplicateHostName);
        }

        sqlx::query(
            "INSERT INTO hosts
                (id, name, kind, user_id, installation_id, last_seen_at, revoked_at,
                 created_at, display_label, activated_at, finalized_at, provisioning_source)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&host.id)
        .bind(&host.name)
        .bind(host_kind(host.kind))
        .bind(&host.user_id)
        .bind(&host.installation_id)
        .bind(host.last_seen_at)
        .bind(host.revoked_at)
        .bind(host.created_at)
        .bind(&host.display_label)
        .bind(host.activated_at)
        .bind(host.finalized_at)
        .bind(provisioning_source(host.provisioning_source))
        .execute(&mut *tx)
        .await
        .map_err(persistence)?;

        sqlx::query(
            "INSERT INTO host_credentials
                (id, host_id, token_hash, kind, expires_at, consumed_at, revoked_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&credential.id)
        .bind(&credential.host_id)
        .bind(&credential.token_hash)
        .bind(credential_kind(credential.kind))
        .bind(credential.expires_at)
        .bind(credential.consumed_at)
        .bind(credential.revoked_at)
        .execute(&mut *tx)
        .await
        .map_err(persistence)?;

        tx.commit().await.map_err(persistence)?;
        Ok(host)
    }
}

impl HostInviteUnitOfWork for SqliteHostRuntimeStore {
    async fn create_host_and_credential(
        &self,
        host: Host,
        credential: NewHostCredential,
    ) -> Result<Host, HostInviteWriteError> {
        self.create_transaction(host, credential).await
    }
}

impl HostCredentialLookup for SqliteHostRuntimeStore {
    async fn lookup_by_token_hash(
        &self,
        token_hash: String,
    ) -> Result<Option<CredentialAuthState>, PersistenceFailure> {
        let row = sqlx::query(
            "SELECT c.id AS credential_id, c.host_id, c.kind, c.expires_at,
                    c.consumed_at, c.revoked_at AS credential_revoked_at,
                    h.user_id AS host_user_id, h.revoked_at AS host_revoked_at
               FROM host_credentials c
               JOIN hosts h ON h.id = c.host_id
              WHERE c.token_hash = ?",
        )
        .bind(token_hash)
        .fetch_optional(&self.pool)
        .await
        .map_err(PersistenceFailure::from_source)?;
        row.map(|row| -> Result<CredentialAuthState, sqlx::Error> {
            Ok(CredentialAuthState {
                credential_id: row.try_get("credential_id")?,
                host_id: row.try_get("host_id")?,
                host_user_id: row.try_get("host_user_id")?,
                kind: row.try_get("kind")?,
                expires_at: row.try_get("expires_at")?,
                consumed_at: row.try_get("consumed_at")?,
                credential_revoked_at: row.try_get("credential_revoked_at")?,
                host_revoked_at: row.try_get("host_revoked_at")?,
            })
        })
        .transpose()
        .map_err(PersistenceFailure::from_source)
    }
}

fn persistence(error: sqlx::Error) -> HostInviteWriteError {
    HostInviteWriteError::Persistence(PersistenceFailure::from_source(error))
}

fn host_kind(kind: HostKind) -> &'static str {
    match kind {
        HostKind::Remote => "remote",
    }
}

fn provisioning_source(source: HostProvisioningSource) -> &'static str {
    match source {
        HostProvisioningSource::UserInvite => "user_invite",
    }
}

fn credential_kind(kind: HostCredentialKind) -> &'static str {
    match kind {
        HostCredentialKind::LongLived => "long_lived",
    }
}

#[cfg(test)]
mod tests {
    use silverhand_backend_core::host_runtime::{
        CreateHostInvite, HostTokenRejection, OsEntropy, SystemClock, VerifyHostTokenFact,
        verify_host_token,
    };
    use tempfile::TempDir;

    use super::*;

    const TEST_SCHEMA: &str = "
        CREATE TABLE users (id TEXT PRIMARY KEY);
        CREATE TABLE hosts (
            id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
            user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
            installation_id TEXT, last_seen_at INTEGER, revoked_at INTEGER,
            created_at INTEGER NOT NULL, display_label TEXT, activated_at INTEGER,
            finalized_at INTEGER, provisioning_source TEXT NOT NULL DEFAULT 'system'
        );
        CREATE TABLE host_credentials (
            id TEXT PRIMARY KEY,
            host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
            token_hash TEXT NOT NULL UNIQUE,
            kind TEXT NOT NULL CHECK (kind IN ('long_lived', 'bootstrap')),
            expires_at INTEGER, consumed_at INTEGER, revoked_at INTEGER
        );";

    async fn fixture() -> (TempDir, SqliteHostRuntimeStore) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("host.sqlite");
        let options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true)
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();
        for statement in TEST_SCHEMA
            .split(';')
            .map(str::trim)
            .filter(|sql| !sql.is_empty())
        {
            sqlx::query(statement).execute(&pool).await.unwrap();
        }
        sqlx::query("INSERT INTO users (id) VALUES ('user-1')")
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;
        let store = SqliteHostRuntimeStore::open(&path).await.unwrap();
        (directory, store)
    }

    #[tokio::test]
    async fn persists_only_the_hash_and_verifies_after_reopening() {
        let (directory, store) = fixture().await;
        let service = CreateHostInvite::new(store.clone(), OsEntropy, SystemClock);
        let fact = service.execute("user-1".into()).await.unwrap();
        let host_id = fact.host.id.clone();
        let redacted = format!("{:?}", fact.connect_token);
        let raw_token = fact.connect_token.reveal_once();
        drop(service);
        drop(store);

        let reopened = SqliteHostRuntimeStore::open(directory.path().join("host.sqlite"))
            .await
            .unwrap();
        let verified = verify_host_token(&reopened, format!("  {raw_token}  "), i64::MAX / 2)
            .await
            .unwrap();
        assert!(
            matches!(verified, VerifyHostTokenFact::Accepted { host_id: ref verified_id, ref user_id, .. } if verified_id == &host_id && user_id == "user-1")
        );

        let row = sqlx::query("SELECT token_hash FROM host_credentials WHERE host_id = ?")
            .bind(&host_id)
            .fetch_one(&reopened.pool)
            .await
            .unwrap();
        let stored: String = row.try_get("token_hash").unwrap();
        assert_ne!(stored, raw_token);
        assert_eq!(redacted, "ConnectToken([REDACTED])");
        assert!(!redacted.contains(&raw_token));
    }

    #[tokio::test]
    async fn credential_failure_rolls_back_the_host_row() {
        let (_directory, store) = fixture().await;
        sqlx::query("CREATE TRIGGER refuse_credential BEFORE INSERT ON host_credentials BEGIN SELECT RAISE(ABORT, 'credential refused'); END")
            .execute(&store.pool)
            .await
            .unwrap();
        let service = CreateHostInvite::new(store.clone(), OsEntropy, SystemClock);

        assert!(service.execute("user-1".into()).await.is_err());
        let host_count: i64 = sqlx::query_scalar("SELECT count(*) FROM hosts")
            .fetch_one(&store.pool)
            .await
            .unwrap();
        let credential_count: i64 = sqlx::query_scalar("SELECT count(*) FROM host_credentials")
            .fetch_one(&store.pool)
            .await
            .unwrap();
        assert_eq!((host_count, credential_count), (0, 0));
    }

    #[tokio::test]
    async fn unknown_and_blank_tokens_are_rejected_without_plaintext_comparison() {
        let (_directory, store) = fixture().await;
        assert_eq!(
            verify_host_token(&store, "   ".into(), 0).await.unwrap(),
            VerifyHostTokenFact::Rejected(HostTokenRejection::Missing)
        );
        assert_eq!(
            verify_host_token(&store, "unknown".into(), 0)
                .await
                .unwrap(),
            VerifyHostTokenFact::Rejected(HostTokenRejection::Missing)
        );
    }
}
